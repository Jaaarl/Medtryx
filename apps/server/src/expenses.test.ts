import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { openDatabase } from "./db.js";
import { manilaCalendarDate } from "./lot-stock.js";

process.env.APP_ENV = "test";
process.env.COOKIE_SECURE = "false";
const password = "SyntheticExpensePassword-123!";
let hash: string;
let directory: string;
let db: ReturnType<typeof openDatabase>;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;

beforeAll(async () => {
  hash = await argon2.hash(password);
});
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "medtryx-expenses-"));
  db = openDatabase("test", directory);
  app = createApp(db);
  const now = new Date().toISOString();
  for (const [email, role] of [
    ["owner@expense.test", "owner"],
    ["cashier@expense.test", "cashier"],
    ["second@expense.test", "cashier"],
  ]) {
    db.prepare(
      `INSERT INTO users (id, email, password_hash, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).run(randomUUID(), email, hash, role, now, now);
  }
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

async function signIn(email = "cashier@expense.test") {
  const agent = request.agent(app);
  const token = (await agent.get("/api/auth/csrf")).body.token as string;
  expect(
    (
      await agent
        .post("/api/auth/login")
        .set("x-csrf-token", token)
        .send({ email, password })
    ).status,
  ).toBe(200);
  return agent;
}
async function post(agent: Agent, path: string, body: Record<string, unknown>) {
  const token = (await agent.get("/api/auth/csrf")).body.token as string;
  return agent.post(`/api${path}`).set("x-csrf-token", token).send(body);
}
async function openShift(agent: Agent, amount = "1000.00") {
  const result = await post(agent, "/shifts", { openingCash: amount });
  expect(result.status).toBe(201);
  return result.body.shift.id as string;
}
function expense(overrides: Record<string, unknown> = {}) {
  return {
    requestKey: randomUUID(),
    category: "LUNCH",
    amount: "120.00",
    description: "Staff lunch",
    paymentSource: "CASHIER",
    includedInUnitCost: false,
    ...overrides,
  };
}
function count(table: "expenses" | "cash_movements") {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    }
  ).count;
}

describe("expense payments and reports", () => {
  it.each(["CASHIER", "OWNER"] as const)(
    "records a COD invoice paid by %s without deducting inventory costs from profit again",
    async (paymentSource) => {
      const cashier = await signIn();
      await openShift(cashier, "0.00");
      const stockBefore = db.prepare("SELECT * FROM products").all();
      const eventsBefore = db.prepare("SELECT * FROM stock_events").all();
      const input = expense({
        category: "STOCK_PURCHASE",
        amount: "15200.00",
        productAmount: "15000.00",
        deliveryFee: "200.00",
        supplier: "Synthetic COD supplier",
        invoiceReference: "SYN-COD-001",
        paymentSource,
      });
      const saved = await post(cashier, "/expenses", input);
      expect(saved.status, JSON.stringify(saved.body)).toBe(201);
      expect(saved.body.expense).toMatchObject({
        category: "STOCK_PURCHASE",
        amount: "15200.00",
        productAmount: "15000.00",
        deliveryFee: "200.00",
        operatingExpense: "0.00",
        supplier: "Synthetic COD supplier",
        invoiceReference: "SYN-COD-001",
        paymentSource,
      });
      expect(saved.body.expectedCash).toBe(
        paymentSource === "CASHIER" ? "-15200.00" : null,
      );
      const retry = await post(cashier, "/expenses", input);
      expect(retry.status).toBe(200);
      expect(retry.body.expense.id).toBe(saved.body.expense.id);
      for (const changed of [
        { invoiceReference: "DIFFERENT-INVOICE" },
        { productAmount: "14900.00", deliveryFee: "300.00" },
        { supplier: "Different supplier" },
      ]) {
        const result = await post(cashier, "/expenses", {
          ...input,
          ...changed,
        });
        expect(result.status).toBe(409);
        expect(result.body.error).toBe("expense_request_key_reused");
      }
      expect(count("expenses")).toBe(1);
      expect(count("cash_movements")).toBe(paymentSource === "CASHIER" ? 1 : 0);
      expect(
        (await cashier.get("/api/shifts/current")).body.shift.expectedCash,
      ).toBe(paymentSource === "CASHIER" ? "-15200.00" : "0.00");
      expect(db.prepare("SELECT * FROM products").all()).toEqual(stockBefore);
      expect(db.prepare("SELECT * FROM stock_events").all()).toEqual(
        eventsBefore,
      );
      const daily = (await cashier.get("/api/shifts/daily-sales-summary")).body
        .summary;
      expect(daily.expenseTotals).toMatchObject({
        operatingExpenses: "0.00",
        stockPurchasePayments: "15200.00",
        stockProductPayments: "15000.00",
        stockDeliveryFees: "200.00",
        cashierPaidStockPurchases:
          paymentSource === "CASHIER" ? "15200.00" : "0.00",
        ownerPaidStockPurchases:
          paymentSource === "OWNER" ? "15200.00" : "0.00",
      });
      const owner = await signIn("owner@expense.test");
      const report = (await owner.get("/api/reports/daily")).body.report;
      expect(report.metrics).toMatchObject({
        operatingExpenses: "0.00",
        stockPurchasePayments: "15200.00",
        stockProductPayments: "15000.00",
        stockDeliveryFees: "200.00",
        cogs: "0.00",
        estimatedResultAfterExpenses: "0.00",
        cashOut: paymentSource === "CASHIER" ? "15200.00" : "0.00",
        netCashImpact: paymentSource === "CASHIER" ? "-15200.00" : "0.00",
      });
      const day = manilaCalendarDate();
      const range = await owner.get(
        `/api/shifts/daily-sales-summary/range?startDate=${day}&endDate=${day}`,
      );
      expect(range.body.entries).toHaveLength(1);
      expect(range.body.entries[0]).toMatchObject({
        stockPurchasePayments: "15200.00",
        stockProductPayments: "15000.00",
        stockDeliveryFees: "200.00",
        operatingExpenses: "0.00",
      });
      const csv = await owner.get(
        `/api/reports/range.csv?startDate=${day}&endDate=${day}`,
      );
      expect(csv.text).toContain(
        '"Total stock purchase / COD payments","15200.00"',
      );
      expect(csv.text).toContain("SYN-COD-001");
      expect(csv.text).toContain(
        "products 15000.00 / delivery fee 200.00 / supplier Synthetic COD supplier",
      );
      expect(db.pragma("foreign_key_check")).toEqual([]);
    },
  );

  it("allows owner-paid stock purchases without an open drawer or separate delivery fee", async () => {
    const cashier = await signIn();
    const result = await post(
      cashier,
      "/expenses",
      expense({
        category: "STOCK_PURCHASE",
        amount: "15000.00",
        productAmount: "15000.00",
        paymentSource: "OWNER",
      }),
    );
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(result.body.expectedCash).toBeNull();
    expect(result.body.expense).toMatchObject({
      deliveryFee: "0.00",
      shiftId: null,
      operatingExpense: "0.00",
    });
    expect(count("cash_movements")).toBe(0);
  });

  it("rejects malformed or inconsistent stock purchase breakdowns before changing the drawer", async () => {
    const cashier = await signIn();
    await openShift(cashier, "0.00");
    const input = expense({
      category: "STOCK_PURCHASE",
      amount: "15200.00",
      productAmount: "15000.00",
      deliveryFee: "200.00",
    });
    for (const changed of [
      { productAmount: "0" },
      { productAmount: "NaN" },
      { productAmount: "-1" },
      { productAmount: "15000.001" },
      { deliveryFee: "NaN" },
      { deliveryFee: "-1.00" },
      { amount: "15000.00" },
      { includedInUnitCost: true },
      { category: "LUNCH" },
      { category: "DELIVERY" },
    ]) {
      const result = await post(cashier, "/expenses", { ...input, ...changed });
      expect(result.status, JSON.stringify(changed)).toBe(400);
    }
    expect(count("expenses")).toBe(0);
    expect(count("cash_movements")).toBe(0);
    expect(
      (await cashier.get("/api/shifts/current")).body.shift.expectedCash,
    ).toBe("0.00");
  });

  it("uses opening cash for a nullable legacy drawer balance without losing the recorded payment", async () => {
    const cashier = await signIn();
    const shiftId = await openShift(cashier, "1000.00");
    db.prepare(
      "UPDATE shifts SET expected_cash_centavos = NULL WHERE id = ?",
    ).run(shiftId);
    expect(
      (await cashier.get("/api/expenses")).body.registerShift.expectedCash,
    ).toBe("1000.00");
    const saved = await post(cashier, "/expenses", expense());
    expect(saved.status).toBe(201);
    expect(saved.body.expectedCash).toBe("880.00");
    expect(count("cash_movements")).toBe(1);
  });

  it("requires authentication and CSRF", async () => {
    expect((await request(app).get("/api/expenses")).status).toBe(401);
    const cashier = await signIn();
    expect((await cashier.post("/api/expenses").send(expense())).status).toBe(
      403,
    );
    expect(count("expenses")).toBe(0);
  });

  it("charges lunch to the drawer once and includes it in Daily Sales, reports, and CSV", async () => {
    const cashier = await signIn();
    await openShift(cashier);
    const saved = await post(cashier, "/expenses", expense());
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body.expectedCash).toBe("880.00");
    expect(
      (await cashier.get("/api/shifts/current")).body.shift.expectedCash,
    ).toBe("880.00");
    expect(count("cash_movements")).toBe(1);
    const daily = (await cashier.get("/api/shifts/daily-sales-summary")).body
      .summary;
    expect(daily.totals.sales).toBe("0.00");
    expect(daily.expenseTotals).toMatchObject({
      operatingExpenses: "120.00",
      cashierPaid: "120.00",
      lunch: "120.00",
    });
    expect(daily.expenses).toHaveLength(1);
    const owner = await signIn("owner@expense.test");
    const day = manilaCalendarDate();
    const report = (
      await owner.get(`/api/reports/range?startDate=${day}&endDate=${day}`)
    ).body.report;
    expect(report.metrics).toMatchObject({
      operatingExpenses: "120.00",
      cashOut: "120.00",
      netCashImpact: "-120.00",
      estimatedResultAfterExpenses: "-120.00",
      grossSales: "0.00",
    });
    const range = (
      await owner.get(
        `/api/shifts/daily-sales-summary/range?startDate=${day}&endDate=${day}`,
      )
    ).body.entries;
    expect(range).toHaveLength(1);
    expect(range[0]).toMatchObject({
      operatingExpenses: "120.00",
      netSales: "0.00",
      invoiceNumberRange: "—",
    });
    const csv = await owner.get(
      `/api/reports/range.csv?startDate=${day}&endDate=${day}`,
    );
    expect(csv.text).toContain('"Operating expenses","120.00"');
    expect(csv.text).toContain("Staff lunch");
    const history = (await owner.get("/api/shifts/history")).body.shifts;
    expect(history[0]).toMatchObject({
      cashOut: "120.00",
      expectedCash: "880.00",
    });
  });

  it("allows the owner to charge the active cashier and scopes history to the charged cashier", async () => {
    const cashier = await signIn();
    await openShift(cashier);
    const owner = await signIn("owner@expense.test");
    const saved = await post(
      owner,
      "/expenses",
      expense({ category: "OTHER", description: "Cleaning supplies" }),
    );
    expect(saved.status).toBe(201);
    expect(saved.body.expense).toMatchObject({
      cashierEmail: "cashier@expense.test",
      recordedByEmail: "owner@expense.test",
    });
    expect((await cashier.get("/api/expenses")).body.expenses).toHaveLength(1);
    const second = await signIn("second@expense.test");
    expect((await second.get("/api/expenses")).body.expenses).toHaveLength(0);
    expect(
      (await second.get("/api/shifts/daily-sales-summary")).body.summary
        .expenses,
    ).toHaveLength(0);
    const forbidden = await post(second, "/expenses", expense());
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toBe("expense_requires_own_shift");
    expect(count("expenses")).toBe(1);
  });

  it.each([false, true])(
    "records owner-paid delivery without requiring or reducing drawer cash (in unit cost: %s)",
    async (includedInUnitCost) => {
      const cashier = await signIn();
      const saved = await post(
        cashier,
        "/expenses",
        expense({
          category: "DELIVERY",
          paymentSource: "OWNER",
          includedInUnitCost,
        }),
      );
      expect(saved.status).toBe(201);
      expect(saved.body.expectedCash).toBeNull();
      expect(saved.body.expense.shiftId).toBeNull();
      expect(count("cash_movements")).toBe(0);
      const summary = (await cashier.get("/api/expenses")).body.totals;
      expect(summary).toMatchObject({
        ownerPaid: "120.00",
        cashierPaid: "0.00",
        operatingExpenses: includedInUnitCost ? "0.00" : "120.00",
        includedInUnitCost: includedInUnitCost ? "120.00" : "0.00",
      });
    },
  );

  it("reduces drawer cash for delivery included in unit cost but excludes it from expense deductions", async () => {
    const cashier = await signIn();
    await openShift(cashier);
    const saved = await post(
      cashier,
      "/expenses",
      expense({ category: "DELIVERY", includedInUnitCost: true }),
    );
    expect(saved.body.expectedCash).toBe("880.00");
    const owner = await signIn("owner@expense.test");
    const day = manilaCalendarDate();
    const report = (await owner.get(`/api/reports/daily?date=${day}`)).body
      .report;
    expect(report.metrics).toMatchObject({
      deliveryExpenses: "0.00",
      operatingExpenses: "0.00",
      inventoryCostPayments: "120.00",
      cashierPaidExpenses: "120.00",
      netCashImpact: "-120.00",
      estimatedResultAfterExpenses: "0.00",
    });
    expect(report.expenses[0].operatingExpense).toBe("0.00");
  });

  it("prevents double payments on retries even after the shift is closed", async () => {
    const cashier = await signIn();
    const shiftId = await openShift(cashier);
    const input = expense();
    const saved = await post(cashier, "/expenses", input);
    expect(
      (
        await post(cashier, `/shifts/${shiftId}/close`, {
          actualCashCount: "880.00",
        })
      ).status,
    ).toBe(200);
    const retried = await post(cashier, "/expenses", input);
    expect(retried.status).toBe(200);
    expect(retried.body.expense.id).toBe(saved.body.expense.id);
    expect(retried.body.expectedCash).toBe("880.00");
    expect(count("expenses")).toBe(1);
    expect(count("cash_movements")).toBe(1);
    expect(
      (await post(cashier, "/expenses", { ...input, amount: "130.00" })).status,
    ).toBe(409);
  });

  it("requires an open shift but allows expenses above the recorded cash balance", async () => {
    const cashier = await signIn();
    expect((await post(cashier, "/expenses", expense())).body.error).toBe(
      "open_shift_required",
    );
    expect(count("expenses")).toBe(0);
    expect(count("cash_movements")).toBe(0);
    await openShift(cashier, "100.00");
    const saved = await post(cashier, "/expenses", expense());
    expect(saved.status).toBe(201);
    expect(saved.body.expectedCash).toBe("-20.00");
    expect(count("expenses")).toBe(1);
    expect(count("cash_movements")).toBe(1);
    expect(
      (await cashier.get("/api/shifts/current")).body.shift.expectedCash,
    ).toBe("-20.00");
  });

  it("records repeated expenses from zero cash, keeps retries idempotent, and reports the negative balance", async () => {
    const cashier = await signIn();
    await openShift(cashier, "0.00");
    const input = expense();
    const saved = await post(cashier, "/expenses", input);
    expect(saved.status).toBe(201);
    expect(saved.body.expectedCash).toBe("-120.00");
    const retried = await post(cashier, "/expenses", input);
    expect(retried.status).toBe(200);
    expect(retried.body.expectedCash).toBe("-120.00");
    const delivery = await post(
      cashier,
      "/expenses",
      expense({ category: "DELIVERY", amount: "20.00" }),
    );
    expect(delivery.status).toBe(201);
    expect(delivery.body.expectedCash).toBe("-140.00");
    expect(count("expenses")).toBe(2);
    expect(count("cash_movements")).toBe(2);
    const owner = await signIn("owner@expense.test");
    const history = (await owner.get("/api/shifts/history")).body.shifts;
    expect(history[0]).toMatchObject({
      cashOut: "140.00",
      expectedCash: "-140.00",
    });
    const daily = (await cashier.get("/api/shifts/daily-sales-summary")).body
      .summary;
    expect(daily.expenseTotals.operatingExpenses).toBe("140.00");
    expect(
      (await owner.get("/api/reports/daily")).body.report.metrics,
    ).toMatchObject({
      cashOut: "140.00",
      netCashImpact: "-140.00",
      operatingExpenses: "140.00",
    });
  });

  it("lets the owner add cash in stages while a balance is negative and reconciles the shift when closed", async () => {
    const cashier = await signIn();
    const shiftId = await openShift(cashier, "0.00");
    expect((await post(cashier, "/expenses", expense())).status).toBe(201);
    const owner = await signIn("owner@expense.test");
    const deposit = await post(owner, `/shifts/${shiftId}/cash-movements`, {
      movementType: "CASH_IN",
      amount: "50.00",
      reason: "Owner supplies cash",
    });
    expect(deposit.status).toBe(201);
    expect(deposit.body.expectedCash).toBe("-70.00");
    const closed = await post(cashier, `/shifts/${shiftId}/close`, {
      actualCashCount: "0.00",
      varianceReason: "No Fault",
    });
    expect(closed.status).toBe(200);
    expect(closed.body.shift).toMatchObject({
      expectedCash: "-70.00",
      actualCashCount: "0.00",
      variance: "70.00",
    });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("rejects invalid amounts, unsupported delivery options, and missing Other details", async () => {
    const cashier = await signIn();
    await openShift(cashier);
    for (const overrides of [
      { amount: "0" },
      { amount: "-1.00" },
      { amount: "NaN" },
      { amount: "2.001" },
      { amount: "10000000" },
      { category: "OTHER", description: "" },
      { paymentSource: "OWNER" },
      { includedInUnitCost: true },
    ]) {
      expect(
        (await post(cashier, "/expenses", expense(overrides))).status,
        JSON.stringify(overrides),
      ).toBe(400);
    }
    expect(count("expenses")).toBe(0);
    expect(count("cash_movements")).toBe(0);
  });

  it("rejects an expense aimed at a shift that was replaced after the form loaded", async () => {
    const cashier = await signIn();
    const shiftId = await openShift(cashier);
    expect(
      (
        await post(cashier, `/shifts/${shiftId}/close`, {
          actualCashCount: "1000.00",
        })
      ).status,
    ).toBe(200);
    await openShift(cashier);
    const owner = await signIn("owner@expense.test");
    const rejected = await post(owner, "/expenses", expense({ shiftId }));
    expect(rejected.status).toBe(409);
    expect(rejected.body.error).toBe("expense_shift_changed");
    expect(count("expenses")).toBe(0);
    expect(
      (await cashier.get("/api/shifts/current")).body.shift.expectedCash,
    ).toBe("1000.00");
  });

  it("uses recorded Manila dates for ranges and keeps saved entries immutable", async () => {
    const cashier = await signIn();
    const saved = await post(
      cashier,
      "/expenses",
      expense({ category: "DELIVERY", paymentSource: "OWNER" }),
    );
    expect(saved.body.expense.businessDate).toBe(manilaCalendarDate());
    expect(
      (
        await cashier.get(
          "/api/expenses?startDate=2020-01-01&endDate=2020-01-01",
        )
      ).body.totals.totalPayments,
    ).toBe("0.00");
    expect(
      (
        await cashier.get(
          "/api/expenses?startDate=2020-02-30&endDate=2020-03-01",
        )
      ).status,
    ).toBe(400);
    expect(() =>
      db
        .prepare("UPDATE expenses SET amount_centavos = 1 WHERE id = ?")
        .run(saved.body.expense.id),
    ).toThrow("expenses_are_append_only");
    expect(() =>
      db
        .prepare("DELETE FROM expenses WHERE id = ?")
        .run(saved.body.expense.id),
    ).toThrow("expenses_are_append_only");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
