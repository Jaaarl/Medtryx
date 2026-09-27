import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { SESSION_IDLE_MS } from "./auth.js";
import { openDatabase } from "./db.js";

process.env.APP_ENV = "test";
process.env.COOKIE_SECURE = "false";

const ownerPassword = "SyntheticOwnerPassword-48!";
const cashierPassword = "SyntheticCashierPassword-72!";
let dataDirectory: string;
let db: ReturnType<typeof openDatabase>;
let app: ReturnType<typeof createApp>;
let ownerId: string;
let cashierId: string;
let ownerHash: string;
let cashierHash: string;

async function resetUsers(): Promise<void> {
  db.exec("DELETE FROM audit_events; DELETE FROM sessions; DELETE FROM users;");
  const now = new Date().toISOString();
  ownerId = randomUUID();
  cashierId = randomUUID();
  db.prepare(
    "INSERT INTO users (id, email, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
  ).run(ownerId, "owner@example.test", ownerHash, "owner", now, now);
  db.prepare(
    "INSERT INTO users (id, email, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
  ).run(cashierId, "cashier@example.test", cashierHash, "cashier", now, now);
}

async function signIn(
  agent: ReturnType<typeof request.agent>,
  email: string,
  password: string,
) {
  const csrf = await agent.get("/api/auth/csrf");
  return agent
    .post("/api/auth/login")
    .set("x-csrf-token", csrf.body.token as string)
    .send({ email, password });
}

async function ownerAgent() {
  const agent = request.agent(app);
  const response = await signIn(agent, "owner@example.test", ownerPassword);
  expect(response.status).toBe(200);
  return agent;
}

async function cashierAgent() {
  const agent = request.agent(app);
  const response = await signIn(agent, "cashier@example.test", cashierPassword);
  expect(response.status).toBe(200);
  return agent;
}

beforeAll(async () => {
  dataDirectory = mkdtempSync(join(tmpdir(), "medtryx-auth-test-"));
  db = openDatabase("test", dataDirectory);
  app = createApp(db);
  ownerHash = await argon2.hash(ownerPassword, { type: argon2.argon2id });
  cashierHash = await argon2.hash(cashierPassword, { type: argon2.argon2id });
});

beforeEach(async () => {
  await resetUsers();
});

afterAll(() => {
  db.close();
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("account foundation", () => {
  it("keeps environment databases in separate files and applies migrations", () => {
    const development = openDatabase("development", dataDirectory);
    const live = openDatabase("live", dataDirectory);
    expect(readdirSync(dataDirectory)).toEqual(
      expect.arrayContaining([
        "development.sqlite",
        "live.sqlite",
        "test.sqlite",
      ]),
    );
    expect(new Set([db.name, development.name, live.name]).size).toBe(3);
    expect(
      (
        development.prepare("SELECT name FROM schema_migrations").all() as {
          name: string;
        }[]
      ).map((row) => row.name),
    ).toContain("0001_accounts.sql");
    development.close();
    live.close();
  });

  it("requires a CSRF token, authenticates users, and stores only a hash of each opaque session", async () => {
    const agent = request.agent(app);
    expect((await agent.get("/api/auth/me")).status).toBe(401);
    expect(
      (
        await agent
          .post("/api/auth/login")
          .send({ email: "owner@example.test", password: ownerPassword })
      ).status,
    ).toBe(403);

    const csrf = await agent.get("/api/auth/csrf");
    const invalid = await agent
      .post("/api/auth/login")
      .set("x-csrf-token", csrf.body.token as string)
      .send({ email: "owner@example.test", password: "incorrect" });
    expect(invalid.status).toBe(401);

    const response = await signIn(agent, "owner@example.test", ownerPassword);
    expect(response.status).toBe(200);
    expect(response.body.user.role).toBe("owner");
    expect(response.body.csrfToken).toEqual(expect.any(String));
    expect(String(response.headers["set-cookie"])).toContain("HttpOnly");
    expect(String(response.headers["set-cookie"])).toContain("SameSite=Strict");
    const stored = db
      .prepare("SELECT token_hash, csrf_hash FROM sessions")
      .get() as {
      token_hash: string;
      csrf_hash: string;
    };
    expect(stored.token_hash).not.toContain(".");
    expect(stored.token_hash).toHaveLength(64);
    expect(stored.csrf_hash).not.toBe(response.body.csrfToken);
    expect((await agent.get("/api/auth/me")).body.user.id).toBe(ownerId);
  });

  it("marks session cookies Secure by default", async () => {
    const previousValue = process.env.COOKIE_SECURE;
    process.env.COOKIE_SECURE = "true";
    try {
      const response = await request(app).get("/api/auth/csrf");
      expect(String(response.headers["set-cookie"])).toContain("Secure");
      expect(String(response.headers["set-cookie"])).toContain(
        "SameSite=Strict",
      );
    } finally {
      if (previousValue === undefined) delete process.env.COOKIE_SECURE;
      else process.env.COOKIE_SECURE = previousValue;
    }
  });

  it("logs out and revokes an opaque server-side session", async () => {
    const agent = await ownerAgent();
    const token = (await agent.get("/api/auth/csrf")).body.token as string;
    const response = await agent
      .post("/api/auth/logout")
      .set("x-csrf-token", token);
    expect(response.status).toBe(204);
    expect((await agent.get("/api/auth/me")).status).toBe(401);
    expect(db.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({
      count: 0,
    });
  });

  it("expires a session after the configured idle period", async () => {
    const agent = await ownerAgent();
    const staleLastSeen = new Date(
      Date.now() - SESSION_IDLE_MS - 1_000,
    ).toISOString();
    db.prepare("UPDATE sessions SET last_seen_at = ?").run(staleLastSeen);
    expect((await agent.get("/api/auth/me")).status).toBe(401);
    expect(db.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({
      count: 0,
    });
  });

  it("enforces owner-only staff and audit access through the API and writes safe audit records", async () => {
    const owner = await ownerAgent();
    const csrfToken = (await owner.get("/api/auth/csrf")).body.token as string;
    const created = await owner
      .post("/api/users")
      .set("x-csrf-token", csrfToken)
      .send({
        email: "new.cashier@example.test",
        password: "SyntheticNewCashier-91!",
        role: "cashier",
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.user.role).toBe("cashier");

    const cashier = await cashierAgent();
    expect((await cashier.get("/api/users")).status).toBe(403);
    expect((await cashier.get("/api/audit")).status).toBe(403);
    expect(
      (
        await cashier
          .post("/api/products")
          .send({ name: "Synthetic unimplemented product" })
      ).status,
    ).toBe(403);
    expect(
      (
        await cashier.post("/api/users").send({
          email: "attacker@example.test",
          password: "SyntheticAttackPassword-14!",
          role: "owner",
        })
      ).status,
    ).toBe(403);
    const events = db
      .prepare("SELECT action, details_json FROM audit_events")
      .all() as {
      action: string;
      details_json: string;
    }[];
    expect(events.some((event) => event.action === "user.created")).toBe(true);
    expect(events.map((event) => event.details_json).join(" ")).not.toContain(
      "SyntheticNewCashier-91!",
    );
  });

  it("rejects missing or stale CSRF tokens on authenticated writes", async () => {
    const owner = await ownerAgent();
    expect(
      (
        await owner.post("/api/users").send({
          email: "blocked@example.test",
          password: "SyntheticBlockedPassword-19!",
          role: "cashier",
        })
      ).status,
    ).toBe(403);

    const freshToken = (await owner.get("/api/auth/csrf")).body.token as string;
    expect(
      (
        await owner.post("/api/users").set("x-csrf-token", freshToken).send({
          email: "allowed@example.test",
          password: "SyntheticAllowedPassword-19!",
          role: "cashier",
        })
      ).status,
    ).toBe(201);
  });

  it("revokes a deactivated staff member's active session and prevents owner lockout", async () => {
    const owner = await ownerAgent();
    const cashier = await cashierAgent();
    const token = (await owner.get("/api/auth/csrf")).body.token as string;
    expect(
      (
        await owner
          .post(`/api/users/${cashierId}/active`)
          .set("x-csrf-token", token)
          .send({ active: false })
      ).status,
    ).toBe(200);
    expect((await cashier.get("/api/auth/me")).status).toBe(401);

    const ownerToken = (await owner.get("/api/auth/csrf")).body.token as string;
    const selfDeactivate = await owner
      .post(`/api/users/${ownerId}/active`)
      .set("x-csrf-token", ownerToken)
      .send({ active: false });
    expect(selfDeactivate.status).toBe(409);
    expect(selfDeactivate.body.error).toBe("cannot_deactivate_self");
  });

  it("changes passwords and revokes every active session for that account", async () => {
    const firstSession = await ownerAgent();
    const secondSession = await ownerAgent();
    const token = (await firstSession.get("/api/auth/csrf")).body
      .token as string;
    const changed = await firstSession
      .post("/api/auth/password")
      .set("x-csrf-token", token)
      .send({
        currentPassword: ownerPassword,
        newPassword: "SyntheticOwnerPassword-99!",
      });
    expect(changed.status).toBe(204);
    expect((await secondSession.get("/api/auth/me")).status).toBe(401);

    const newLogin = request.agent(app);
    expect(
      (
        await signIn(
          newLogin,
          "owner@example.test",
          "SyntheticOwnerPassword-99!",
        )
      ).status,
    ).toBe(200);
  });
});
