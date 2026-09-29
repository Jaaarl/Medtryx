import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { decryptCustomerField } from "./customer-data.js";
import { openDatabase } from "./db.js";
import {
  clearBundleLedgerForTest,
  clearLotLedgerForTest,
} from "./test-ledger.js";

process.env.APP_ENV = "test";
process.env.COOKIE_SECURE = "false";
process.env.CUSTOMER_ID_ENCRYPTION_KEY = "b2".repeat(32);

const ownerPassword = "SyntheticSalesOwner-65!";
const cashierPassword = "SyntheticSalesCashier-83!";
const secondCashierPassword = "SyntheticSecondCashier-57!";
let dataDirectory: string;
let db: ReturnType<typeof openDatabase>;
let app: ReturnType<typeof createApp>;
let ownerId: string;
let cashierId: string;
let secondCashierId: string;
let ownerHash: string;
let cashierHash: string;
let secondCashierHash: string;

type Agent = ReturnType<typeof request.agent>;

async function seedUsers(): Promise<void> {
  clearBundleLedgerForTest(db);
  clearLotLedgerForTest(db);
  db.exec(
    "DELETE FROM sale_lines; DELETE FROM sales; DELETE FROM shifts; DELETE FROM stock_events; DELETE FROM products; DELETE FROM product_sku_sequence; DELETE FROM sale_sequences; DELETE FROM settings; DELETE FROM audit_events; DELETE FROM sessions; DELETE FROM users;",
  );
  const now = new Date().toISOString();
  ownerId = randomUUID();
  cashierId = randomUUID();
  secondCashierId = randomUUID();
  db.prepare(
    "INSERT INTO users (id, email, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, 'owner', 1, ?, ?)",
  ).run(ownerId, "owner.sales@example.test", ownerHash, now, now);
  db.prepare(
    "INSERT INTO users (id, email, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, 'cashier', 1, ?, ?)",
  ).run(cashierId, "cashier.sales@example.test", cashierHash, now, now);
  db.prepare(
    "INSERT INTO users (id, email, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, 'cashier', 1, ?, ?)",
  ).run(
    secondCashierId,
    "second.cashier.sales@example.test",
    secondCashierHash,
    now,
    now,
  );
}

async function signIn(email: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const csrf = await agent.get("/api/auth/csrf");
  const response = await agent
    .post("/api/auth/login")
    .set("x-csrf-token", csrf.body.token as string)
    .send({ email, password });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return agent;
}

async function csrfFor(agent: Agent): Promise<string> {
  return (await agent.get("/api/auth/csrf")).body.token as string;
}

async function configureApprovedPolicy(
  owner: Agent,
  cashRoundingMode: "NONE" | "NEAREST_25_CENTAVOS" = "NONE",
): Promise<void> {
  const csrf = await csrfFor(owner);
  const response = await owner
    .post("/api/settings/tax-policy")
    .set("x-csrf-token", csrf)
    .send({
      confirmApproved: true,
      version: "SYNTHETIC-ACCOUNTANT-12-UP-1",
      vatRateBasisPoints: 1_200,
      seniorDiscountBasisPoints: 2_000,
      pwdDiscountBasisPoints: 2_000,
      vatInclusivePrices: true,
      allowZeroRated: false,
      roundingMode: "HALF_UP",
      cashRoundingMode,
      approvalReference: "Synthetic test-only approval record",
      costBasisDescription:
        "Synthetic unit acquisition cost including all test inputs",
    });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

async function createProduct(
  owner: Agent,
  overrides: Record<string, unknown> = {},
) {
  const csrf = await csrfFor(owner);
  const response = await owner
    .post("/api/products")
    .set("x-csrf-token", csrf)
    .send({
      sku: "SYN-SALE-001",
      name: "Synthetic Sale Product",
      unit: "piece",
      sellingPrice: "112.00",
      taxClass: "VATABLE",
      productType: "BRANDED",
      isScEligible: true,
      isPwdEligible: true,
      openingQuantity: 5,
      openingUnitCost: "40.00",
      ...overrides,
    });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.product as {
    id: string;
    sku: string;
    quantityOnHand: number;
    inventoryValue: string;
    sellingPrice: string;
  };
}

async function openShift(agent: Agent, openingCash = "100.00") {
  const csrf = await csrfFor(agent);
  return agent
    .post("/api/shifts")
    .set("x-csrf-token", csrf)
    .send({ openingCash });
}

async function postSale(
  agent: Agent,
  input: {
    productId: string;
    quantity: number;
    requestKey?: string;
    paymentMethod?: "CASH" | "QR";
    benefitType?: "REGULAR" | "SENIOR_CITIZEN" | "PWD";
    benefitApplied?: boolean;
    customerName?: string;
    customerIdType?: string;
    customerIdNumber?: string;
    customerIdChecked?: boolean;
  },
) {
  const csrf = await csrfFor(agent);
  const { productId, quantity, benefitApplied, ...options } = input;
  return agent
    .post("/api/sales")
    .set("x-csrf-token", csrf)
    .send({
      benefitType: "REGULAR",
      paymentMethod: "CASH",
      requestKey: randomUUID(),
      ...options,
      items: [
        {
          productId,
          quantity,
          benefitApplied: benefitApplied ?? false,
        },
      ],
    });
}

function manilaDayAfter(days: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const today = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  const date = new Date(
    `${today.year}-${today.month}-${today.day}T00:00:00.000Z`,
  );
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

beforeAll(async () => {
  dataDirectory = mkdtempSync(join(tmpdir(), "medtryx-sales-test-"));
  db = openDatabase("test", dataDirectory);
  app = createApp(db);
  ownerHash = await argon2.hash(ownerPassword, { type: argon2.argon2id });
  cashierHash = await argon2.hash(cashierPassword, { type: argon2.argon2id });
  secondCashierHash = await argon2.hash(secondCashierPassword, {
    type: argon2.argon2id,
  });
});

beforeEach(async () => {
  await seedUsers();
});

afterAll(() => {
  db.close();
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("checkout, sales, and cashier shifts", () => {
  it("shows a labeled provisional preview and blocks sale writes until policy approval", async () => {
    const owner = await signIn("owner.sales@example.test", ownerPassword);
    const product = await createProduct(owner);
    const cashier = await signIn("cashier.sales@example.test", cashierPassword);
    const csrf = await csrfFor(cashier);
    const preview = await cashier
      .post("/api/sales/preview")
      .set("x-csrf-token", csrf)
      .send({
        benefitType: "REGULAR",
        items: [{ productId: product.id, quantity: 1, benefitApplied: false }],
      });
    expect(preview.status).toBe(200);
    expect(preview.body.policy.approved).toBe(false);
    expect(preview.body.policyNotice).toContain("Provisional estimate only");
    expect(preview.body.lines[0]).toMatchObject({
      gross: "112.00",
      taxBasis: "100.00",
      vat: "12.00",
      vatRemoved: "0.00",
      amountDue: "112.00",
    });

    const sale = await postSale(cashier, {
      productId: product.id,
      quantity: 1,
    });
    expect(sale.status).toBe(409);
    expect(sale.body.error).toBe("tax_policy_not_approved");
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM sales").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
    expect((await owner.get("/api/products")).body.products[0]).toMatchObject({
      quantityOnHand: 5,
      inventoryValue: "200.00",
    });
  });

  it("applies benefits only when the product is eligible for that selected benefit", async () => {
    const owner = await signIn("owner.sales@example.test", ownerPassword);
    const product = await createProduct(owner, {
      sku: "SYN-SC-ONLY",
      isScEligible: true,
      isPwdEligible: false,
    });
    const cashier = await signIn("cashier.sales@example.test", cashierPassword);
    const csrf = await csrfFor(cashier);

    const wrongBenefit = await cashier
      .post("/api/sales/preview")
      .set("x-csrf-token", csrf)
      .send({
        benefitType: "PWD",
        items: [{ productId: product.id, quantity: 1, benefitApplied: true }],
      });
    expect(wrongBenefit.status).toBe(400);
    expect(wrongBenefit.body.error).toBe("product_not_pwd_eligible");

    const refreshedCsrf = await csrfFor(cashier);
    const eligibleBenefit = await cashier
      .post("/api/sales/preview")
      .set("x-csrf-token", refreshedCsrf)
      .send({
        benefitType: "SENIOR_CITIZEN",
        items: [{ productId: product.id, quantity: 1, benefitApplied: true }],
      });
    expect(eligibleBenefit.status, JSON.stringify(eligibleBenefit.body)).toBe(
      200,
    );
    expect(eligibleBenefit.body.lines[0]).toMatchObject({
      isScEligible: true,
      isPwdEligible: false,
      benefitApplied: true,
    });
  });

  it("keeps policy approval owner-only and records its attestation in the audit log", async () => {
    const cashier = await signIn("cashier.sales@example.test", cashierPassword);
    const denied = await cashier.post("/api/settings/tax-policy").send({
      confirmApproved: true,
    });
    expect(denied.status).toBe(403);

    const owner = await signIn("owner.sales@example.test", ownerPassword);
    await configureApprovedPolicy(owner);
    const policy = await owner.get("/api/settings/tax-policy");
    expect(policy.body.policy).toMatchObject({
      approved: true,
      version: "SYNTHETIC-ACCOUNTANT-12-UP-1",
      approvalReference: "Synthetic test-only approval record",
    });
    const audit = await owner.get("/api/audit?limit=20");
    expect(
      audit.body.events.some(
        (event: { action: string }) =>
          event.action === "settings.tax_policy.approved",
      ),
    ).toBe(true);
  });

  it("opens one store-wide shift and requires a reason for a cash variance", async () => {
    const cashier = await signIn("cashier.sales@example.test", cashierPassword);
    const secondCashier = await signIn(
      "second.cashier.sales@example.test",
      secondCashierPassword,
    );
    const opened = await openShift(cashier, "100.00");
    expect(opened.status).toBe(201);
    expect(opened.body.shift.expectedCash).toBe("100.00");
    expect((await openShift(cashier)).body.error).toBe("shift_already_open");
    expect((await openShift(secondCashier)).status).toBe(409);

    const shiftId = opened.body.shift.id as string;
    const csrf = await csrfFor(cashier);
    const rejected = await cashier
      .post(`/api/shifts/${shiftId}/close`)
      .set("x-csrf-token", csrf)
      .send({ actualCashCount: "98.00" });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe("variance_reason_required");

    const nextCsrf = await csrfFor(cashier);
    const closed = await cashier
      .post(`/api/shifts/${shiftId}/close`)
      .set("x-csrf-token", nextCsrf)
      .send({
        actualCashCount: "98.00",
        varianceReason: "Synthetic count variance for test",
      });
    expect(closed.status).toBe(200);
    expect(closed.body.shift).toMatchObject({
      expectedCash: "100.00",
      actualCashCount: "98.00",
      variance: "-2.00",
      varianceApprovalStatus: "PENDING",
    });
    expect((await cashier.get("/api/shifts/current")).body.shift).toBeNull();
    expect((await openShift(secondCashier, "20.00")).status).toBe(201);

    const cashierCsrf = await csrfFor(cashier);
    const cashierApproval = await cashier
      .post(`/api/shifts/${shiftId}/variance-approval`)
      .set("x-csrf-token", cashierCsrf)
      .send({
        ownerPassword,
        decision: "APPROVE",
        note: "Synthetic unauthorized variance approval",
      });
    expect(cashierApproval.status).toBe(403);

    const owner = await signIn("owner.sales@example.test", ownerPassword);
    const pending = await owner.get("/api/shifts/variance-approvals");
    expect(pending.body.shifts).toMatchObject([
      {
        id: shiftId,
        expectedCash: "100.00",
        actualCashCount: "98.00",
        variance: "-2.00",
        cashierReason: "Synthetic count variance for test",
      },
    ]);
    const wrongOwnerCsrf = await csrfFor(owner);
    const wrongOwnerPassword = await owner
      .post(`/api/shifts/${shiftId}/variance-approval`)
      .set("x-csrf-token", wrongOwnerCsrf)
      .send({
        ownerPassword: "SyntheticWrongOwnerPassword-1!",
        decision: "APPROVE",
        note: "Reviewed synthetic count record",
      });
    expect(wrongOwnerPassword.status).toBe(403);
    expect(wrongOwnerPassword.body.error).toBe("reauthentication_failed");
    const ownerCsrf = await csrfFor(owner);
    const approval = await owner
      .post(`/api/shifts/${shiftId}/variance-approval`)
      .set("x-csrf-token", ownerCsrf)
      .send({
        ownerPassword,
        decision: "APPROVE",
        note: "Reviewed synthetic count record",
      });
    expect(approval.status).toBe(200);
    expect(approval.body.approvalStatus).toBe("APPROVED");
    expect(
      db
        .prepare(
          "SELECT variance_approval_status, variance_centavos FROM shifts WHERE id = ?",
        )
        .get(shiftId) as {
        variance_approval_status: string;
        variance_centavos: number;
      },
    ).toEqual({
      variance_approval_status: "APPROVED",
      variance_centavos: -200,
    });
  });

  it("allows only one of two simultaneous cashier shift opens", async () => {
    const cashier = await signIn("cashier.sales@example.test", cashierPassword);
    const secondCashier = await signIn(
      "second.cashier.sales@example.test",
      secondCashierPassword,
    );
    const opened = await Promise.all([
      openShift(cashier, "10.00"),
      openShift(secondCashier, "20.00"),
    ]);
    expect(opened.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM shifts WHERE closed_at IS NULL",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
  });

  it("shows owners shift accounts and money totals while denying cashiers", async () => {
    const owner = await signIn("owner.sales@example.test", ownerPassword);
    await configureApprovedPolicy(owner);
    const product = await createProduct(owner);
    const cashier = await signIn("cashier.sales@example.test", cashierPassword);
    const opened = await openShift(cashier, "50.00");
    expect(opened.status).toBe(201);

    expect(
      (
        await postSale(cashier, {
          productId: product.id,
          quantity: 1,
          paymentMethod: "CASH",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await postSale(cashier, {
          productId: product.id,
          quantity: 1,
          paymentMethod: "QR",
        })
      ).status,
    ).toBe(201);

    const cashierDenied = await cashier.get("/api/shifts/history");
    expect(cashierDenied.status).toBe(403);
    const openHistory = await owner.get("/api/shifts/history");
    expect(openHistory.status).toBe(200);
    expect(openHistory.body.shifts[0]).toMatchObject({
      id: opened.body.shift.id,
      status: "OPEN",
      openedByEmail: "cashier.sales@example.test",
      closedByEmail: null,
      openingCash: "50.00",
      cashSales: "112.00",
      qrSales: "112.00",
      cashRefunds: "0.00",
      cashIn: "0.00",
      cashOut: "0.00",
      expectedCash: "162.00",
      actualCashCount: null,
      variance: null,
    });

    const shiftId = opened.body.shift.id as string;
    const closeCsrf = await csrfFor(cashier);
    const closed = await cashier
      .post(`/api/shifts/${shiftId}/close`)
      .set("x-csrf-token", closeCsrf)
      .send({ actualCashCount: "162.00" });
    expect(closed.status).toBe(200);
    const closedHistory = await owner.get("/api/shifts/history");
    expect(closedHistory.body.shifts[0]).toMatchObject({
      status: "CLOSED",
      openedByEmail: "cashier.sales@example.test",
      closedByEmail: "cashier.sales@example.test",
      expectedCash: "162.00",
      actualCashCount: "162.00",
      variance: "0.00",
    });
  });

  it("paginates the complete owner shift history and validates cursors", async () => {
    const now = Date.now();
    const insertShift = db.prepare(
      `INSERT INTO shifts
        (id, cashier_user_id, opened_at, opening_cash_centavos, closed_at,
         expected_cash_centavos, actual_cash_count_centavos, variance_centavos,
         close_actor_user_id)
       VALUES (?, ?, ?, 0, ?, 0, 0, 0, ?)`,
    );
    for (let index = 0; index < 3; index += 1) {
      const openedAt = new Date(now - index * 1_000).toISOString();
      insertShift.run(
        `synthetic-history-${index}`,
        cashierId,
        openedAt,
        openedAt,
        ownerId,
      );
    }

    const owner = await signIn("owner.sales@example.test", ownerPassword);
    const firstPage = await owner.get("/api/shifts/history?limit=2");
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.shifts).toHaveLength(2);
    expect(firstPage.body.hasMore).toBe(true);
    const lastShift = firstPage.body.shifts.at(-1) as {
      id: string;
      openedAt: string;
    };
    const secondPage = await owner.get(
      `/api/shifts/history?limit=2&beforeOpenedAt=${encodeURIComponent(lastShift.openedAt)}&beforeId=${lastShift.id}`,
    );
    expect(secondPage.body.shifts).toHaveLength(1);
    expect(secondPage.body.hasMore).toBe(false);
    expect(secondPage.body.shifts[0].id).not.toBe(firstPage.body.shifts[0].id);
    expect(
      (await owner.get("/api/shifts/history?beforeOpenedAt=invalid")).status,
    ).toBe(400);
  });

  it("rounds cash totals to the nearest quarter, snapshots the adjustment, and leaves QR and line tax exact", async () => {
    const owner = await signIn("owner.sales@example.test", ownerPassword);
    await configureApprovedPolicy(owner, "NEAREST_25_CENTAVOS");
    const product = await createProduct(owner, { sellingPrice: "112.13" });
    const cashier = await signIn("cashier.sales@example.test", cashierPassword);
    await openShift(cashier, "100.00");
    const csrf = await csrfFor(cashier);

    const cashPreview = await cashier
      .post("/api/sales/preview")
      .set("x-csrf-token", csrf)
      .send({
        benefitType: "REGULAR",
        paymentMethod: "CASH",
        items: [{ productId: product.id, quantity: 1 }],
      });
    expect(cashPreview.status).toBe(200);
    expect(cashPreview.body.lines[0].amountDue).toBe("112.13");
    expect(cashPreview.body.totals).toMatchObject({
      amountBeforeCashRounding: "112.13",
      cashRoundingAdjustment: "0.12",
      amountDue: "112.25",
    });

    const qrCsrf = await csrfFor(cashier);
    const qrPreview = await cashier
      .post("/api/sales/preview")
      .set("x-csrf-token", qrCsrf)
      .send({
        benefitType: "REGULAR",
        paymentMethod: "QR",
        items: [{ productId: product.id, quantity: 1 }],
      });
    expect(qrPreview.status, JSON.stringify(qrPreview.body)).toBe(200);
    expect(qrPreview.body.totals).toMatchObject({
      amountBeforeCashRounding: "112.13",
      cashRoundingAdjustment: "0.00",
      amountDue: "112.13",
    });

    const sale = await postSale(cashier, {
      productId: product.id,
      quantity: 1,
      paymentMethod: "CASH",
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(sale.body.sale).toMatchObject({
      amountDue: "112.25",
      cashRoundingMode: "NEAREST_25_CENTAVOS",
      cashRoundingAdjustment: "0.12",
      lines: [{ amountDue: "112.13" }],
    });
    const qrSale = await postSale(cashier, {
      productId: product.id,
      quantity: 1,
      paymentMethod: "QR",
    });
    expect(qrSale.status, JSON.stringify(qrSale.body)).toBe(201);
    expect(qrSale.body.sale).toMatchObject({
      paymentMethod: "QR",
      amountDue: "112.13",
      cashRoundingMode: "NEAREST_25_CENTAVOS",
      cashRoundingAdjustment: "0.00",
      lines: [{ amountDue: "112.13" }],
    });
    expect(
      (await cashier.get("/api/shifts/current")).body.shift.expectedCash,
    ).toBe("212.25");
    expect(
      db
        .prepare(
          `SELECT cash_rounding_mode, cash_rounding_adjustment_centavos,
                amount_due_centavos FROM sales WHERE payment_method = 'CASH'`,
        )
        .get() as {
        cash_rounding_mode: string;
        cash_rounding_adjustment_centavos: number;
        amount_due_centavos: number;
      },
    ).toEqual({
      cash_rounding_mode: "NEAREST_25_CENTAVOS",
      cash_rounding_adjustment_centavos: 12,
      amount_due_centavos: 11_225,
    });
  });

  it("commits sale, snapshots, COGS, stock value, cash, and ID atomically and replays idempotently", async () => {
    const owner = await signIn("owner.sales@example.test", ownerPassword);
    await configureApprovedPolicy(owner);
    const product = await createProduct(owner);
    const cashier = await signIn("cashier.sales@example.test", cashierPassword);
    const shift = await openShift(cashier, "100.00");
    expect(shift.status).toBe(201);
    const requestKey = randomUUID();
    const first = await postSale(cashier, {
      productId: product.id,
      quantity: 2,
      requestKey,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.sale).toMatchObject({
      subtotal: "224.00",
      vat: "24.00",
      vatRemoved: "0.00",
      amountDue: "224.00",
      label: "INTERNAL SALES RECORD — NOT AN INVOICE",
    });
    expect(first.body.sale.transactionId).toMatch(/^MTX-\d{8}-\d{6}$/);
    expect(first.body.sale.lines[0]).toMatchObject({
      productName: "Synthetic Sale Product",
      sku: "SYN-SALE-001",
      quantity: 2,
      unitPrice: "112.00",
      productType: "BRANDED",
      isScEligible: true,
      isPwdEligible: true,
      taxPolicyVersion: "SYNTHETIC-ACCOUNTANT-12-UP-1",
    });
    expect(first.body.sale.lines[0].cogs).toBeUndefined();

    const replay = await postSale(cashier, {
      productId: product.id,
      quantity: 2,
      requestKey,
    });
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.sale.id).toBe(first.body.sale.id);
    const alteredReplay = await postSale(cashier, {
      productId: product.id,
      quantity: 1,
      requestKey,
    });
    expect(alteredReplay.status).toBe(409);
    expect(alteredReplay.body.error).toBe("idempotency_key_reused");

    const inventory = await owner.get("/api/products");
    expect(inventory.body.products[0]).toMatchObject({
      quantityOnHand: 3,
      inventoryValue: "120.00",
    });
    const stock = await owner.get(`/api/stock/events?productId=${product.id}`);
    expect(stock.body.events[0]).toMatchObject({
      type: "SALE",
      quantityDelta: -2,
      inventoryValueDelta: "-80.00",
    });
    expect(
      (await cashier.get("/api/shifts/current")).body.shift.expectedCash,
    ).toBe("324.00");
    const productChangeCsrf = await csrfFor(owner);
    const productChange = await owner
      .patch(`/api/products/${product.id}`)
      .set("x-csrf-token", productChangeCsrf)
      .send({
        sellingPrice: "150.00",
        taxClass: "VAT_EXEMPT",
        productType: "GENERIC",
        isScEligible: false,
        isPwdEligible: false,
      });
    expect(productChange.status).toBe(200);
    const savedSnapshot = await owner.get(
      `/api/sales/${first.body.sale.transactionId}`,
    );
    expect(savedSnapshot.body.sale.lines[0]).toMatchObject({
      unitPrice: "112.00",
      taxClass: "VATABLE",
      productType: "BRANDED",
      isScEligible: true,
      isPwdEligible: true,
      cogs: "80.00",
    });
    const cashierSnapshot = await cashier.get(
      `/api/sales/${first.body.sale.transactionId}`,
    );
    expect(cashierSnapshot.status).toBe(200);
    expect(cashierSnapshot.body.sale.lines[0].cogs).toBeUndefined();
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM sales").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
  });

  it("encrypts SC/PWD identity fields and excludes them from cashier sale responses", async () => {
    const owner = await signIn("owner.sales@example.test", ownerPassword);
    await configureApprovedPolicy(owner);
    const product = await createProduct(owner);
    const cashier = await signIn("cashier.sales@example.test", cashierPassword);
    await openShift(cashier);
    const response = await postSale(cashier, {
      productId: product.id,
      quantity: 1,
      benefitType: "SENIOR_CITIZEN",
      benefitApplied: true,
      customerName: "Synthetic Senior Person",
      customerIdType: "Synthetic Senior Card",
      customerIdNumber: "SYN-SC-9981",
      customerIdChecked: true,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.sale).toMatchObject({
      subtotal: "112.00",
      vat: "0.00",
      vatRemoved: "12.00",
      seniorDiscount: "20.00",
      amountDue: "80.00",
    });
    expect(JSON.stringify(response.body.sale)).not.toContain(
      "Synthetic Senior Person",
    );
    expect(JSON.stringify(response.body.sale)).not.toContain("SYN-SC-9981");
    const deniedCustomerDetails = await cashier.get(
      `/api/sales/${response.body.sale.transactionId}/customer`,
    );
    expect(deniedCustomerDetails.status).toBe(403);
    const ownerCustomerDetails = await owner.get(
      `/api/sales/${response.body.sale.transactionId}/customer`,
    );
    expect(ownerCustomerDetails.status).toBe(200);
    expect(ownerCustomerDetails.body.customer).toEqual({
      benefitType: "SENIOR_CITIZEN",
      name: "Synthetic Senior Person",
      idType: "Synthetic Senior Card",
      idNumber: "SYN-SC-9981",
      idChecked: true,
    });
    const encrypted = db
      .prepare(
        `SELECT id, customer_name_ciphertext, customer_id_type_ciphertext,
                customer_id_number_ciphertext FROM sales`,
      )
      .get() as {
      id: string;
      customer_name_ciphertext: string;
      customer_id_type_ciphertext: string;
      customer_id_number_ciphertext: string;
    };
    expect(encrypted.customer_name_ciphertext).not.toContain(
      "Synthetic Senior Person",
    );
    expect(
      decryptCustomerField(
        encrypted.customer_name_ciphertext,
        `${encrypted.id}/name`,
      ),
    ).toBe("Synthetic Senior Person");
    expect(
      decryptCustomerField(
        encrypted.customer_id_type_ciphertext,
        `${encrypted.id}/id-type`,
      ),
    ).toBe("Synthetic Senior Card");
    expect(
      decryptCustomerField(
        encrypted.customer_id_number_ciphertext,
        `${encrypted.id}/id-number`,
      ),
    ).toBe("SYN-SC-9981");
    const audit = await owner.get("/api/audit?limit=20");
    expect(
      audit.body.events.some(
        (event: { action: string }) =>
          event.action === "sale.customer_details_viewed",
      ),
    ).toBe(true);
  });

  it("excludes QR declarations from expected physical cash", async () => {
    const owner = await signIn("owner.sales@example.test", ownerPassword);
    await configureApprovedPolicy(owner);
    const product = await createProduct(owner);
    const cashier = await signIn("cashier.sales@example.test", cashierPassword);
    await openShift(cashier, "50.00");
    const response = await postSale(cashier, {
      productId: product.id,
      quantity: 1,
      paymentMethod: "QR",
    });
    expect(response.status).toBe(201);
    expect(
      (await cashier.get("/api/shifts/current")).body.shift.expectedCash,
    ).toBe("50.00");
  });

  it("allows only one simultaneous sale of the shared last unit on one shift", async () => {
    const owner = await signIn("owner.sales@example.test", ownerPassword);
    await configureApprovedPolicy(owner);
    const product = await createProduct(owner, {
      sku: "SYN-LAST-001",
      openingQuantity: 1,
    });
    const cashierA = await signIn(
      "cashier.sales@example.test",
      cashierPassword,
    );
    const cashierB = await signIn(
      "cashier.sales@example.test",
      cashierPassword,
    );
    expect((await openShift(cashierA)).status).toBe(201);
    const [first, second] = await Promise.all([
      postSale(cashierA, { productId: product.id, quantity: 1 }),
      postSale(cashierB, { productId: product.id, quantity: 1 }),
    ]);
    expect(
      [first.status, second.status].filter((status) => status === 201),
    ).toHaveLength(1);
    expect(
      [first.status, second.status].filter((status) => status === 409),
    ).toHaveLength(1);
    const persisted = db
      .prepare("SELECT quantity_on_hand FROM products WHERE id = ?")
      .get(product.id) as { quantity_on_hand: number };
    expect(persisted.quantity_on_hand).toBe(0);
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM stock_events WHERE event_type = 'SALE'",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
  });

  it("assigns tracked lines FEFO with a stable same-expiry tie-break and rechecks the lots atomically", async () => {
    const owner = await signIn("owner.sales@example.test", ownerPassword);
    await configureApprovedPolicy(owner);
    const product = await createProduct(owner, {
      sku: "SYN-FEFO-001",
      openingQuantity: 1,
      openingUnitCost: "10.00",
    });
    const trackingCsrf = await csrfFor(owner);
    const tracking = await owner
      .patch(`/api/products/${product.id}`)
      .set("x-csrf-token", trackingCsrf)
      .send({ tracksLots: true });
    expect(tracking.status).toBe(200);
    const ownerCsrf = await csrfFor(owner);
    const first = await owner
      .post("/api/stock/receipts")
      .set("x-csrf-token", ownerCsrf)
      .send({
        productId: product.id,
        quantity: 1,
        unitCost: "30.00",
        lotCode: "SYN-BATCH-B",
        expiryDate: manilaDayAfter(20),
      });
    expect(first.status).toBe(201);
    const secondCsrf = await csrfFor(owner);
    const second = await owner
      .post("/api/stock/receipts")
      .set("x-csrf-token", secondCsrf)
      .send({
        productId: product.id,
        quantity: 1,
        unitCost: "20.00",
        lotCode: "SYN-BATCH-A",
        expiryDate: manilaDayAfter(20),
      });
    expect(second.status).toBe(201);

    const cashier = await signIn("cashier.sales@example.test", cashierPassword);
    expect((await openShift(cashier)).status).toBe(201);
    const csrf = await csrfFor(cashier);
    const preview = await cashier
      .post("/api/sales/preview")
      .set("x-csrf-token", csrf)
      .send({
        benefitType: "REGULAR",
        paymentMethod: "QR",
        items: [{ productId: product.id, quantity: 2 }],
      });
    expect(preview.status).toBe(200);
    expect(preview.body.lines[0].assignedLots).toEqual([
      expect.objectContaining({ lotCode: "SYN-BATCH-A", quantity: 1 }),
      expect.objectContaining({ lotCode: "SYN-BATCH-B", quantity: 1 }),
    ]);

    const unconfirmedToken = await csrfFor(cashier);
    const unconfirmed = await cashier
      .post("/api/sales")
      .set("x-csrf-token", unconfirmedToken)
      .send({
        benefitType: "REGULAR",
        paymentMethod: "QR",
        requestKey: randomUUID(),
        items: [
          {
            productId: product.id,
            quantity: 2,
            lotAllocations: preview.body.lines[0].assignedLots.map(
              (lot: { lotId: string; quantity: number }) => ({
                lotId: lot.lotId,
                quantity: lot.quantity,
              }),
            ),
            lotPickConfirmed: false,
          },
        ],
      });
    expect(unconfirmed.status, JSON.stringify(unconfirmed.body)).toBe(409);
    expect(unconfirmed.body.error).toBe("lot_pick_confirmation_required");

    const saleToken = await csrfFor(cashier);
    const sale = await cashier
      .post("/api/sales")
      .set("x-csrf-token", saleToken)
      .send({
        benefitType: "REGULAR",
        paymentMethod: "QR",
        requestKey: randomUUID(),
        items: [
          {
            productId: product.id,
            quantity: 2,
            lotAllocations: preview.body.lines[0].assignedLots.map(
              (lot: { lotId: string; quantity: number }) => ({
                lotId: lot.lotId,
                quantity: lot.quantity,
              }),
            ),
            lotPickConfirmed: true,
          },
        ],
      });
    expect(sale.status).toBe(201);
    expect(sale.body.sale.lines[0].lotAllocations).toHaveLength(2);
    expect((await owner.get("/api/products")).body.products[0]).toMatchObject({
      quantityOnHand: 1,
      unallocatedQuantity: 1,
      saleableQuantity: 0,
      inventoryValue: "20.00",
    });
    expect(
      db
        .prepare(
          "SELECT sum(quantity_delta) AS quantity, sum(inventory_value_delta_centavos) AS value FROM lot_stock_movements WHERE product_id = ?",
        )
        .get(product.id),
    ).toEqual({ quantity: 1, value: 2_000 });
  });

  it("excludes both expired lots and unallocated tracked units from checkout availability", async () => {
    const owner = await signIn("owner.sales@example.test", ownerPassword);
    const product = await createProduct(owner, {
      sku: "SYN-EXPIRED-001",
      openingQuantity: 2,
    });
    const ownerCsrf = await csrfFor(owner);
    await owner
      .patch(`/api/products/${product.id}`)
      .set("x-csrf-token", ownerCsrf)
      .send({ tracksLots: true });
    const reconcileCsrf = await csrfFor(owner);
    const reconcile = await owner
      .post("/api/stock/lots/reconcile")
      .set("x-csrf-token", reconcileCsrf)
      .send({
        productId: product.id,
        reason: "Synthetic verified physical expiry test",
        physicalCountConfirmed: true,
        allocations: [
          {
            lotCode: "SYN-ALREADY-EXPIRED",
            expiryDate: manilaDayAfter(-1),
            quantity: 1,
          },
        ],
      });
    expect(reconcile.status).toBe(201);
    const reconcileTodayToken = await csrfFor(owner);
    const reconcileToday = await owner
      .post("/api/stock/lots/reconcile")
      .set("x-csrf-token", reconcileTodayToken)
      .send({
        productId: product.id,
        reason: "Synthetic printed expiry date is today",
        physicalCountConfirmed: true,
        allocations: [
          {
            lotCode: "SYN-EXPIRES-TODAY",
            expiryDate: manilaDayAfter(0),
            quantity: 1,
          },
        ],
      });
    expect(reconcileToday.status).toBe(201);
    const cashier = await signIn("cashier.sales@example.test", cashierPassword);
    const catalog = await cashier.get("/api/catalog");
    expect(catalog.body.products[0]).toMatchObject({
      physicalQuantity: 2,
      quantityAvailable: 1,
      assignedLots: [expect.objectContaining({ lotCode: "SYN-EXPIRES-TODAY" })],
    });
    const previewToken = await csrfFor(cashier);
    const preview = await cashier
      .post("/api/sales/preview")
      .set("x-csrf-token", previewToken)
      .send({
        benefitType: "REGULAR",
        items: [{ productId: product.id, quantity: 1 }],
      });
    expect(preview.status).toBe(200);
    expect(preview.body.lines[0].assignedLots).toEqual([
      expect.objectContaining({
        lotCode: "SYN-EXPIRES-TODAY",
        expiryDate: manilaDayAfter(0),
        quantity: 1,
      }),
    ]);
    const tooManyToken = await csrfFor(cashier);
    const tooMany = await cashier
      .post("/api/sales/preview")
      .set("x-csrf-token", tooManyToken)
      .send({
        benefitType: "REGULAR",
        items: [{ productId: product.id, quantity: 2 }],
      });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error).toBe("insufficient_saleable_lot_stock");
  });

  it("serializes two tracked sales competing for the same final lot unit", async () => {
    const owner = await signIn("owner.sales@example.test", ownerPassword);
    await configureApprovedPolicy(owner);
    const product = await createProduct(owner, {
      sku: "SYN-LOT-LAST-001",
      openingQuantity: 0,
      openingUnitCost: undefined,
      tracksLots: true,
    });
    const receiptToken = await csrfFor(owner);
    const receipt = await owner
      .post("/api/stock/receipts")
      .set("x-csrf-token", receiptToken)
      .send({
        productId: product.id,
        quantity: 1,
        unitCost: "40.00",
        lotCode: "SYN-LOT-LAST",
        expiryDate: manilaDayAfter(20),
      });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    const cashier = await signIn("cashier.sales@example.test", cashierPassword);
    expect((await openShift(cashier)).status).toBe(201);
    const previewToken = await csrfFor(cashier);
    const preview = await cashier
      .post("/api/sales/preview")
      .set("x-csrf-token", previewToken)
      .send({
        benefitType: "REGULAR",
        paymentMethod: "QR",
        items: [{ productId: product.id, quantity: 1 }],
      });
    expect(preview.status).toBe(200);
    const lots = preview.body.lines[0].assignedLots.map(
      (lot: { lotId: string; quantity: number }) => ({
        lotId: lot.lotId,
        quantity: lot.quantity,
      }),
    );
    const concurrentSaleToken = await csrfFor(cashier);
    const save = () =>
      cashier
        .post("/api/sales")
        .set("x-csrf-token", concurrentSaleToken)
        .send({
          benefitType: "REGULAR",
          paymentMethod: "QR",
          requestKey: randomUUID(),
          items: [
            {
              productId: product.id,
              quantity: 1,
              lotAllocations: lots,
              lotPickConfirmed: true,
            },
          ],
        });
    const [first, second] = await Promise.all([save(), save()]);
    expect(
      [first.status, second.status].filter((status) => status === 201),
    ).toHaveLength(1);
    expect(
      [first.status, second.status].filter((status) => status === 409),
    ).toHaveLength(1);
    expect(
      (await owner.get("/api/products")).body.products[0].saleableQuantity,
    ).toBe(0);
  });

  it("rolls sale, stock, value, and ID back together after a database failure", async () => {
    const owner = await signIn("owner.sales@example.test", ownerPassword);
    await configureApprovedPolicy(owner);
    const product = await createProduct(owner);
    const cashier = await signIn("cashier.sales@example.test", cashierPassword);
    await openShift(cashier);
    db.exec(
      "CREATE TRIGGER synthetic_abort_sale_line BEFORE INSERT ON sale_lines BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
    );
    const failed = await postSale(cashier, {
      productId: product.id,
      quantity: 1,
    });
    expect(failed.status).toBe(500);
    db.exec("DROP TRIGGER synthetic_abort_sale_line");
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM sales").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM sale_sequences").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
    expect((await owner.get("/api/products")).body.products[0]).toMatchObject({
      quantityOnHand: 5,
      inventoryValue: "200.00",
    });
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM stock_events WHERE event_type = 'SALE'",
          )
          .get() as { count: number }
      ).count,
    ).toBe(0);
  });
});
