import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { openDatabase } from "./db.js";

process.env.APP_ENV = "test";
process.env.COOKIE_SECURE = "false";

const ownerPassword = "MonthlyIncentiveOwner-72!";
const cashierPassword = "MonthlyIncentiveCashier-83!";
let dataDirectory: string;
let db: ReturnType<typeof openDatabase>;
let app: ReturnType<typeof createApp>;
let ownerId: string;
let cashierId: string;
let ownerHash: string;
let cashierHash: string;

function todayInManila(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftMonth(month: string, amount: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, monthNumber! - 1 + amount, 1))
    .toISOString()
    .slice(0, 7);
}

function postWithCsrf(
  agent: ReturnType<typeof request.agent>,
  method: "put" | "post",
  path: string,
  body: Record<string, unknown>,
) {
  return agent.get("/api/auth/csrf").then((csrf) =>
    agent[method](path)
      .set("x-csrf-token", csrf.body.token as string)
      .send(body),
  );
}

async function resetUsers(): Promise<void> {
  db.exec(
    `DELETE FROM audit_events;
     DELETE FROM sessions;
     DELETE FROM sale_reversals;
     DELETE FROM sales;
     DELETE FROM shifts;
     DELETE FROM monthly_incentive_months;
     DELETE FROM settings;
     DELETE FROM users;`,
  );
  const now = new Date().toISOString();
  ownerId = randomUUID();
  cashierId = randomUUID();
  const insertUser = db.prepare(
    "INSERT INTO users (id, email, username, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
  );
  insertUser.run(
    ownerId,
    "owner@monthly-incentive.test",
    "monthlyowner",
    ownerHash,
    "owner",
    now,
    now,
  );
  insertUser.run(
    cashierId,
    "cashier@monthly-incentive.test",
    "monthlycashier",
    cashierHash,
    "cashier",
    now,
    now,
  );
}

async function signIn(email: string, password: string) {
  const agent = request.agent(app);
  const csrf = await agent.get("/api/auth/csrf");
  const response = await agent
    .post("/api/auth/login")
    .set("x-csrf-token", csrf.body.token as string)
    .send({ email, password });
  expect(response.status).toBe(200);
  return agent;
}

function insertSale(input: {
  transactionId: string;
  businessDate: string;
  amountCentavos: number;
}): string {
  const existingShift = db
    .prepare("SELECT id FROM shifts WHERE closed_at IS NULL LIMIT 1")
    .get() as { id: string } | undefined;
  const shiftId = existingShift?.id ?? randomUUID();
  const saleId = randomUUID();
  const now = new Date().toISOString();
  if (!existingShift) {
    db.prepare(
      `INSERT INTO shifts (id, cashier_user_id, opened_at, opening_cash_centavos)
       VALUES (?, ?, ?, 0)`,
    ).run(shiftId, cashierId, now);
  }
  db.prepare(
    `INSERT INTO sales (
       id, transaction_id, business_date, request_key, request_hash,
       cashier_user_id, shift_id, benefit_type, customer_id_checked,
       payment_method, subtotal_centavos, vat_centavos, vat_removed_centavos,
       senior_discount_centavos, pwd_discount_centavos, amount_due_centavos,
       tax_policy_version, created_at
     ) VALUES (?, ?, ?, ?, 'test', ?, ?, 'REGULAR', 0, 'QR', ?, 0, 0, 0, 0, ?, 'test', ?)`,
  ).run(
    saleId,
    input.transactionId,
    input.businessDate,
    randomUUID(),
    cashierId,
    shiftId,
    input.amountCentavos,
    input.amountCentavos,
    now,
  );
  return saleId;
}

beforeAll(async () => {
  dataDirectory = mkdtempSync(join(tmpdir(), "medtryx-monthly-incentive-"));
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

describe("monthly sales incentive settings and progress", () => {
  it("lets the owner save ordered tiers and only shows dashboard progress when enabled", async () => {
    const owner = await signIn("owner@monthly-incentive.test", ownerPassword);
    const cashier = await signIn(
      "cashier@monthly-incentive.test",
      cashierPassword,
    );

    const initialSetting = await owner.get("/api/settings/monthly-incentive");
    expect(initialSetting.status).toBe(200);
    expect(initialSetting.body.enabled).toBe(false);
    expect(initialSetting.body.showOnCheckout).toBe(false);
    expect(initialSetting.body.showGoalAndIncentive).toBe(false);
    expect(initialSetting.body.tiers).toHaveLength(2);
    expect((await cashier.get("/api/settings/monthly-incentive")).status).toBe(
      403,
    );
    expect(
      (await cashier.get("/api/dashboard/monthly-incentive")).body.progress,
    ).toBeNull();

    const currentDate = todayInManila();
    const thisMonthSale = insertSale({
      transactionId: "MI-THIS-MONTH",
      businessDate: currentDate,
      amountCentavos: 120_000,
    });
    const previousMonth = new Date(
      Date.parse(`${currentDate.slice(0, 7)}-01T00:00:00.000Z`) -
        24 * 60 * 60 * 1000,
    )
      .toISOString()
      .slice(0, 10);
    const previousMonthKey = previousMonth.slice(0, 7);
    insertSale({
      transactionId: "MI-PRIOR-MONTH",
      businessDate: previousMonth,
      amountCentavos: 800_000,
    });
    db.prepare(
      `INSERT INTO sale_reversals (
         id, reversal_transaction_id, sale_id, approved_by_user_id, reason,
         refund_method, amount_centavos, cash_shift_id, created_at
       ) VALUES (?, ?, ?, ?, 'Test refund', 'QR', 20000, NULL, ?)`,
    ).run(
      randomUUID(),
      "MI-REFUND",
      thisMonthSale,
      ownerId,
      new Date().toISOString(),
    );

    const outOfOrder = await postWithCsrf(
      owner,
      "put",
      "/api/settings/monthly-incentive",
      {
        enabled: true,
        tiers: [
          {
            salesTargetCentavos: 500_000,
            incentiveCentavos: 10_000,
            color: "#2878B8",
          },
          {
            salesTargetCentavos: 250_000,
            incentiveCentavos: 5_000,
            color: "#25875A",
          },
        ],
      },
    );
    expect(outOfOrder.status).toBe(400);

    const decreasingIncentive = await postWithCsrf(
      owner,
      "put",
      "/api/settings/monthly-incentive",
      {
        enabled: true,
        tiers: [
          {
            salesTargetCentavos: 250_000,
            incentiveCentavos: 10_000,
            color: "#25875A",
          },
          {
            salesTargetCentavos: 500_000,
            incentiveCentavos: 5_000,
            color: "#2878B8",
          },
        ],
      },
    );
    expect(decreasingIncentive.status).toBe(400);

    const savedSetting = {
      enabled: true,
      showOnCheckout: false,
      showGoalAndIncentive: false,
      tiers: [
        {
          salesTargetCentavos: 250_000,
          incentiveCentavos: 5_000,
          color: "#25875A",
        },
        {
          salesTargetCentavos: 500_000,
          incentiveCentavos: 10_000,
          color: "#2878B8",
        },
      ],
    };
    const saved = await postWithCsrf(
      owner,
      "put",
      "/api/settings/monthly-incentive",
      savedSetting,
    );
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual(savedSetting);

    const previousMonthSetting = {
      ...savedSetting,
      tiers: [
        {
          salesTargetCentavos: 750_000,
          incentiveCentavos: 25_000,
          color: "#C68120",
        },
      ],
    };
    const savedPreviousMonth = await postWithCsrf(
      owner,
      "put",
      `/api/settings/monthly-incentive?month=${previousMonthKey}`,
      previousMonthSetting,
    );
    expect(savedPreviousMonth.status).toBe(200);

    const futureMonthKey = shiftMonth(currentDate.slice(0, 7), 1);
    expect(
      (
        await owner.get(
          `/api/settings/monthly-incentive?month=${futureMonthKey}`,
        )
      ).body.tiers,
    ).toEqual(savedSetting.tiers);

    const futureMonthSetting = {
      ...savedSetting,
      tiers: [
        {
          salesTargetCentavos: 1_000_000,
          incentiveCentavos: 50_000,
          color: "#7558B5",
        },
        {
          salesTargetCentavos: 2_000_000,
          incentiveCentavos: 100_000,
          color: "#C45252",
        },
      ],
    };
    const savedFutureMonth = await postWithCsrf(
      owner,
      "put",
      `/api/settings/monthly-incentive?month=${futureMonthKey}`,
      futureMonthSetting,
    );
    expect(savedFutureMonth.status).toBe(200);
    expect(
      (
        await owner.get(
          `/api/settings/monthly-incentive?month=${futureMonthKey}`,
        )
      ).body.tiers,
    ).toEqual(futureMonthSetting.tiers);
    expect(
      (
        await owner.get(
          `/api/settings/monthly-incentive?month=${currentDate.slice(0, 7)}`,
        )
      ).body.tiers,
    ).toEqual(savedSetting.tiers);
    expect(
      (
        await owner.get(
          `/api/settings/monthly-incentive?month=${previousMonthKey}`,
        )
      ).body.tiers,
    ).toEqual(previousMonthSetting.tiers);
    expect(
      (await owner.get("/api/settings/monthly-incentive?month=not-a-month"))
        .status,
    ).toBe(400);

    const cashierUpdate = await postWithCsrf(
      cashier,
      "put",
      "/api/settings/monthly-incentive",
      savedSetting,
    );
    expect(cashierUpdate.status).toBe(403);

    const progress = await cashier.get("/api/dashboard/monthly-incentive");
    expect(progress.status).toBe(200);
    expect(progress.body.progress).toMatchObject({
      month: currentDate.slice(0, 7),
      salesCentavos: 100_000,
      progressPercent: expect.any(Number),
      showOnCheckout: false,
      showGoalAndIncentive: false,
    });
    expect(progress.body.progress).not.toHaveProperty("tiers");
    const ownerProgress = await owner.get("/api/dashboard/monthly-incentive");
    expect(ownerProgress.body.progress.showGoalAndIncentive).toBe(false);
    expect(ownerProgress.body.progress.tiers).toEqual(savedSetting.tiers);

    const ownerPreviousMonth = await owner.get(
      `/api/dashboard/monthly-incentive?month=${previousMonthKey}`,
    );
    expect(ownerPreviousMonth.status).toBe(200);
    expect(ownerPreviousMonth.body.progress).toMatchObject({
      month: previousMonthKey,
      salesCentavos: 800_000,
      showGoalAndIncentive: false,
    });
    expect(ownerPreviousMonth.body.progress.tiers).toEqual(
      previousMonthSetting.tiers,
    );
    expect(
      (
        await cashier.get(
          `/api/dashboard/monthly-incentive?month=${previousMonthKey}`,
        )
      ).status,
    ).toBe(403);
    expect(
      (await owner.get("/api/dashboard/monthly-incentive?month=not-a-month"))
        .status,
    ).toBe(400);

    const checkoutEnabled = await postWithCsrf(
      owner,
      "put",
      "/api/settings/monthly-incentive",
      {
        ...savedSetting,
        showOnCheckout: true,
        showGoalAndIncentive: true,
      },
    );
    expect(checkoutEnabled.status).toBe(200);
    expect(checkoutEnabled.body.showOnCheckout).toBe(true);
    expect(checkoutEnabled.body.showGoalAndIncentive).toBe(true);
    expect(
      (await cashier.get("/api/dashboard/monthly-incentive")).body.progress
        .showOnCheckout,
    ).toBe(true);
    expect(
      (await cashier.get("/api/dashboard/monthly-incentive")).body.progress
        .showGoalAndIncentive,
    ).toBe(true);
    expect(
      (await cashier.get("/api/dashboard/monthly-incentive")).body.progress
        .tiers,
    ).toEqual(savedSetting.tiers);
  });

  it("defaults checkout visibility off for settings saved before the option existed", async () => {
    const owner = await signIn("owner@monthly-incentive.test", ownerPassword);
    db.prepare(
      `INSERT INTO settings (key, value_json, updated_at, updated_by)
       VALUES ('monthly_incentive', ?, ?, ?)`,
    ).run(
      JSON.stringify({
        enabled: true,
        tiers: [
          {
            salesTargetCentavos: 25_000_000,
            incentiveCentavos: 5_000,
            color: "#25875A",
          },
        ],
      }),
      new Date().toISOString(),
      ownerId,
    );

    const setting = await owner.get("/api/settings/monthly-incentive");
    expect(setting.status).toBe(200);
    expect(setting.body.enabled).toBe(true);
    expect(setting.body.showOnCheckout).toBe(false);
    expect(setting.body.showGoalAndIncentive).toBe(false);
  });
});
