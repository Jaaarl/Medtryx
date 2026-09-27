import argon2 from "argon2";
import cookieParser from "cookie-parser";
import type { ErrorRequestHandler, Express, Request, Response } from "express";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createUserSchema, userRoleSchema } from "@medtryx/shared";
import {
  clearAuthCookies,
  hashSecret,
  issueCsrfToken,
  requireAuthentication,
  requireCsrf,
  requireDoubleSubmitCsrf,
  requireRole,
  SESSION_COOKIE,
  SESSION_MAX_MS,
  setCsrfCookie,
  setSessionCookie,
  type AuthenticatedUser,
} from "./auth.js";
import { selectedEnvironment, writeAuditEvent } from "./db.js";
import { registerInventoryRoutes } from "./inventory.js";
import { registerBackupRoutes } from "./backups.js";
import { registerReversalRoutes } from "./reversals.js";
import { registerReportRoutes } from "./reports.js";
import { registerSalesRoutes } from "./sales.js";
import { apiMaintenance } from "./maintenance.js";

const loginSchema = z
  .object({ email: z.email().max(254), password: z.string().min(1).max(128) })
  .strict();
const activeSchema = z.object({ active: z.boolean() }).strict();
const passwordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(12).max(128),
  })
  .strict();
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,p=4,t=3$S/tixhg7xO+M8zRn7x31fA$8WRmIwOLwbJREWVlMvhXaMqoLLFmLRcANkp7DCCEl44";

type UserRow = {
  id: string;
  email: string;
  role: "owner" | "cashier";
  is_active: number;
  created_at: string;
};

function presentUser(row: UserRow): {
  id: string;
  email: string;
  role: "owner" | "cashier";
  isActive: boolean;
  createdAt: string;
} {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
  };
}

function sendBadRequest(res: Response): void {
  res.status(400).json({ error: "invalid_request" });
}

function readCurrentUser(
  db: Database.Database,
  id: string,
): AuthenticatedUser | undefined {
  const row = db
    .prepare("SELECT id, email, role FROM users WHERE id = ? AND is_active = 1")
    .get(id) as AuthenticatedUser | undefined;
  return row;
}

function registerAuthRoutes(app: Express, db: Database.Database): void {
  const requireAuth = requireAuthentication(db);
  const requireOwner = requireRole("owner");
  const csrf = (req: Request, res: Response, next: () => void) =>
    requireCsrf(db, req, res, next);

  app.get("/api/auth/csrf", (req, res) => {
    const token = issueCsrfToken();
    const sessionToken = req.cookies?.[SESSION_COOKIE];
    if (typeof sessionToken === "string") {
      db.prepare("UPDATE sessions SET csrf_hash = ? WHERE token_hash = ?").run(
        hashSecret(token),
        hashSecret(sessionToken),
      );
    }
    setCsrfCookie(res, token);
    res.json({ token });
  });

  app.post(
    "/api/auth/login",
    requireDoubleSubmitCsrf,
    async (req: Request, res: Response): Promise<void> => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) return sendBadRequest(res);

      const email = parsed.data.email.trim().toLowerCase();
      const row = db
        .prepare(
          "SELECT id, email, password_hash, role, is_active, created_at FROM users WHERE email = ? COLLATE NOCASE",
        )
        .get(email) as (UserRow & { password_hash: string }) | undefined;

      let verified = false;
      try {
        verified = await argon2.verify(
          row?.password_hash ?? DUMMY_PASSWORD_HASH,
          parsed.data.password,
        );
      } catch {
        verified = false;
      }
      if (!row || row.is_active !== 1 || !verified) {
        res.status(401).json({ error: "invalid_credentials" });
        return;
      }

      const oldSession = req.cookies?.[SESSION_COOKIE];
      if (typeof oldSession === "string") {
        db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(
          hashSecret(oldSession),
        );
      }
      const token = randomBytes(32).toString("base64url");
      const csrfToken = issueCsrfToken();
      const now = new Date();
      const expires = new Date(now.getTime() + SESSION_MAX_MS);
      db.prepare(
        `INSERT INTO sessions (token_hash, csrf_hash, user_id, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        hashSecret(token),
        hashSecret(csrfToken),
        row.id,
        now.toISOString(),
        now.toISOString(),
        expires.toISOString(),
      );
      writeAuditEvent(db, {
        actorUserId: row.id,
        action: "auth.login",
        entityType: "user",
        entityId: row.id,
      });
      setSessionCookie(res, token);
      setCsrfCookie(res, csrfToken);
      res.json({ user: presentUser(row), csrfToken });
    },
  );

  app.get("/api/auth/me", requireAuth, (req, res) => {
    const user = req.user && readCurrentUser(db, req.user.id);
    if (!user) {
      clearAuthCookies(res);
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    res.json({ user });
  });

  app.post("/api/auth/logout", requireAuth, csrf, (req, res) => {
    if (!req.user || !req.sessionTokenHash) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(
      req.sessionTokenHash,
    );
    writeAuditEvent(db, {
      actorUserId: req.user.id,
      action: "auth.logout",
      entityType: "user",
      entityId: req.user.id,
    });
    clearAuthCookies(res);
    res.status(204).end();
  });

  app.post(
    "/api/auth/password",
    requireAuth,
    csrf,
    async (req, res): Promise<void> => {
      if (!req.user) {
        res.status(401).json({ error: "authentication_required" });
        return;
      }
      const parsed = passwordSchema.safeParse(req.body);
      if (!parsed.success) return sendBadRequest(res);
      const row = db
        .prepare("SELECT password_hash FROM users WHERE id = ?")
        .get(req.user.id) as { password_hash: string } | undefined;
      if (
        !row ||
        !(await argon2.verify(row.password_hash, parsed.data.currentPassword))
      ) {
        res.status(403).json({ error: "current_password_incorrect" });
        return;
      }
      const now = new Date().toISOString();
      const passwordHash = await argon2.hash(parsed.data.newPassword, {
        type: argon2.argon2id,
      });
      const updatePassword = db.transaction(() => {
        db.prepare(
          "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
        ).run(passwordHash, now, req.user?.id);
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(req.user?.id);
        writeAuditEvent(db, {
          actorUserId: req.user?.id ?? null,
          action: "user.password_changed",
          entityType: "user",
          entityId: req.user?.id ?? "",
        });
      });
      updatePassword();
      clearAuthCookies(res);
      res.status(204).end();
    },
  );

  app.get("/api/users", requireAuth, requireOwner, (_req, res) => {
    const rows = db
      .prepare(
        "SELECT id, email, role, is_active, created_at FROM users ORDER BY created_at, email",
      )
      .all() as UserRow[];
    res.json({ users: rows.map(presentUser) });
  });

  app.post(
    "/api/users",
    requireAuth,
    requireOwner,
    csrf,
    async (req, res): Promise<void> => {
      const parsed = createUserSchema.safeParse(req.body);
      if (!parsed.success) return sendBadRequest(res);
      if (!userRoleSchema.safeParse(parsed.data.role).success || !req.user)
        return sendBadRequest(res);

      const id = randomUUID();
      const now = new Date().toISOString();
      const email = parsed.data.email.trim().toLowerCase();
      const passwordHash = await argon2.hash(parsed.data.password, {
        type: argon2.argon2id,
      });
      try {
        db.transaction(() => {
          db.prepare(
            "INSERT INTO users (id, email, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
          ).run(id, email, passwordHash, parsed.data.role, now, now);
          writeAuditEvent(db, {
            actorUserId: req.user?.id ?? null,
            action: "user.created",
            entityType: "user",
            entityId: id,
            details: { role: parsed.data.role },
          });
        })();
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("UNIQUE constraint failed: users.email")
        ) {
          res.status(409).json({ error: "email_already_exists" });
          return;
        }
        throw error;
      }
      res.status(201).json({
        user: presentUser({
          id,
          email,
          role: parsed.data.role,
          is_active: 1,
          created_at: now,
        }),
      });
    },
  );

  app.post(
    "/api/users/:id/active",
    requireAuth,
    requireOwner,
    csrf,
    (req, res) => {
      const idParsed = z.uuid().safeParse(req.params.id);
      const bodyParsed = activeSchema.safeParse(req.body);
      if (!idParsed.success || !bodyParsed.success || !req.user)
        return sendBadRequest(res);
      const target = db
        .prepare("SELECT id, role, is_active FROM users WHERE id = ?")
        .get(idParsed.data) as
        | { id: string; role: "owner" | "cashier"; is_active: number }
        | undefined;
      if (!target) {
        res.status(404).json({ error: "user_not_found" });
        return;
      }
      if (target.id === req.user.id && !bodyParsed.data.active) {
        res.status(409).json({ error: "cannot_deactivate_self" });
        return;
      }
      const now = new Date().toISOString();
      const updateAccount = db.transaction(() => {
        db.prepare(
          "UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?",
        ).run(bodyParsed.data.active ? 1 : 0, now, target.id);
        if (!bodyParsed.data.active)
          db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);
        writeAuditEvent(db, {
          actorUserId: req.user?.id ?? null,
          action: bodyParsed.data.active
            ? "user.activated"
            : "user.deactivated",
          entityType: "user",
          entityId: target.id,
          details: { role: target.role },
        });
      });
      updateAccount();
      res.json({ ok: true });
    },
  );

  app.get("/api/audit", requireAuth, requireOwner, (req, res) => {
    const limitParsed = z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .safeParse(req.query.limit ?? "100");
    if (!limitParsed.success) return sendBadRequest(res);
    const rows = db
      .prepare(
        `SELECT a.id, a.action, a.entity_type AS entityType, a.entity_id AS entityId,
                a.details_json AS detailsJson, a.created_at AS createdAt, u.email AS actorEmail
         FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
         ORDER BY a.created_at DESC LIMIT ?`,
      )
      .all(limitParsed.data) as {
      id: string;
      action: string;
      entityType: string;
      entityId: string;
      detailsJson: string;
      createdAt: string;
      actorEmail: string | null;
    }[];
    res.json({
      events: rows.map(({ detailsJson, ...row }) => ({
        ...row,
        details: JSON.parse(detailsJson) as unknown,
      })),
    });
  });
}

export function createApp(
  db: Database.Database,
  options: { serveWeb?: boolean } = {},
): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(
    helmet({
      ...(selectedEnvironment() === "live"
        ? {}
        : { contentSecurityPolicy: false }),
      crossOriginResourcePolicy: { policy: "same-origin" },
    }),
  );
  app.use(express.json({ limit: "20kb", strict: true }));
  app.use(cookieParser());
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", environment: selectedEnvironment() });
  });
  app.use(
    "/api/auth/login",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: selectedEnvironment() === "test" ? 100 : 10,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "too_many_login_attempts" },
    }),
  );
  app.use("/api", apiMaintenance);
  registerAuthRoutes(app, db);
  const inventoryRouter = express.Router();
  registerInventoryRoutes(inventoryRouter, db);
  registerBackupRoutes(inventoryRouter, db);
  app.use("/api", inventoryRouter);
  const salesRouter = express.Router();
  registerSalesRoutes(salesRouter, db);
  registerReversalRoutes(salesRouter, db);
  registerReportRoutes(salesRouter, db);
  app.use("/api", salesRouter);

  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "api_route_not_found" }),
  );
  if (options.serveWeb) {
    const webDirectory = resolve(
      fileURLToPath(new URL("../../web/dist/", import.meta.url)),
    );
    if (existsSync(webDirectory)) {
      app.use(express.static(webDirectory, { index: false, maxAge: "1h" }));
      app.get(/^(?!\/api).*/, (_req, res) =>
        res.sendFile(resolve(webDirectory, "index.html")),
      );
    }
  }
  const errorHandler: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(500).json({ error: "internal_server_error" });
  };
  app.use(errorHandler);
  return app;
}
