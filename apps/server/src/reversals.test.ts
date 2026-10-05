import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { openDatabase } from "./db.js";
import {
  clearBnpcLedgerForTest,
  clearLotLedgerForTest,
} from "./test-ledger.js";

process.env.APP_ENV = "test";
process.env.COOKIE_SECURE = "false";
process.env.CUSTOMER_ID_ENCRYPTION_KEY = "c3".repeat(32);

const ownerPassword = "SyntheticReversalOwner-61!";
const cashierPassword = "SyntheticReversalCashier-72!";
let dataDirectory: string;
let db: ReturnType<typeof openDatabase>;
let app: ReturnType<typeof createApp>;
let ownerId: string;
let ownerHash: string;
let cashierHash: string;

type Agent = ReturnType<typeof request.agent>;

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

async function postWithCsrf(
  agent: Agent,
  path: string,
  body: Record<string, unknown>,
) {
  const csrf = await csrfFor(agent);
  return agent.post(path).set("x-csrf-token", csrf).send(body);
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
      version: "SYNTHETIC-REVERSAL-TAX",
      vatRateBasisPoints: 1_200,
      seniorDiscountBasisPoints: 2_000,
      pwdDiscountBasisPoints: 2_000,
      vatInclusivePrices: true,
      allowZeroRated: false,
      roundingMode: "HALF_UP",
      cashRoundingMode,
      approvalReference: "Synthetic reversal test policy only",
      costBasisDescription: "Synthetic weighted-average acquisition cost",
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
      sku: "SYN-REVERSAL-001",
      name: "Synthetic Reversal Product",
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
  return response.body.product as { id: string };
}

async function openShift(agent: Agent, openingCash = "100.00") {
  const csrf = await csrfFor(agent);
  return agent
    .post("/api/shifts")
    .set("x-csrf-token", csrf)
    .send({ openingCash });
}

async function closeShift(
  agent: Agent,
  shiftId: string,
  actualCashCount: string,
) {
  return postWithCsrf(agent, `/api/shifts/${shiftId}/close`, {
    actualCashCount,
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

async function sell(
  cashier: Agent,
  productId: string,
  paymentMethod: "CASH" | "QR" = "CASH",
) {
  const csrf = await csrfFor(cashier);
  const response = await cashier
    .post("/api/sales")
    .set("x-csrf-token", csrf)
    .send({
      benefitType: "REGULAR",
      items: [{ productId, quantity: 1 }],
      paymentMethod,
      requestKey: randomUUID(),
    });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.sale as {
    transactionId: string;
    amountDue: string;
    lines: Array<{ saleLineId: string; cogs?: string }>;
  };
}

async function reverse(
  owner: Agent,
  transactionId: string,
  saleLineId: string,
  options: {
    password?: string;
    method?: "CASH" | "QR";
    shiftId?: string;
    restock?: boolean;
  } = {},
) {
  const csrf = await csrfFor(owner);
  return owner
    .post(`/api/sales/${transactionId}/reversals`)
    .set("x-csrf-token", csrf)
    .send({
      ownerPassword: options.password ?? ownerPassword,
      reason: "Synthetic full reversal for test",
      refundMethod: options.method ?? "QR",
      ...(options.shiftId ? { refundShiftId: options.shiftId } : {}),
      lines: [
        {
          saleLineId,
          restock: options.restock ?? true,
        },
      ],
    });
}

async function quickCancel(
  cashier: Agent,
  transactionId: string,
  saleLineId: string,
  options: {
    method: "CASH" | "QR";
    shiftId?: string;
    restock: boolean;
    qrRefundConfirmed?: boolean;
    reason?: string;
  },
) {
  const csrf = await csrfFor(cashier);
  return cashier
    .post(`/api/sales/${transactionId}/reversals`)
    .set("x-csrf-token", csrf)
    .send({
      reason: options.reason ?? "Synthetic quick cancellation test",
      refundMethod: options.method,
      ...(options.shiftId ? { refundShiftId: options.shiftId } : {}),
      ...(options.qrRefundConfirmed !== undefined
        ? { qrRefundConfirmed: options.qrRefundConfirmed }
        : {}),
      lines: [{ saleLineId, restock: options.restock }],
    });
}

beforeAll(async () => {
  dataDirectory = mkdtempSync(join(tmpdir(), "medtryx-reversals-test-"));
  db = openDatabase("test", dataDirectory);
  app = createApp(db);
  ownerHash = await argon2.hash(ownerPassword, { type: argon2.argon2id });
  cashierHash = await argon2.hash(cashierPassword, { type: argon2.argon2id });
});

beforeEach(() => {
  clearBnpcLedgerForTest(db);
  clearLotLedgerForTest(db);
  db.exec(
    `DELETE FROM sale_reversal_lines;
     DELETE FROM sale_payment_switches;
     DELETE FROM cash_movements;
     DELETE FROM sale_reversals;
     DELETE FROM reversal_sequences;
     DELETE FROM sale_lines;
     DELETE FROM sales;
     DELETE FROM shifts;
     DELETE FROM stock_events;
     DELETE FROM products;
     DELETE FROM product_sku_sequence;
     DELETE FROM sale_sequences;
     DELETE FROM settings;
     DELETE FROM audit_events;
     DELETE FROM sessions;
     DELETE FROM users;`,
  );
  const now = new Date().toISOString();
  ownerId = randomUUID();
  db.prepare(
    `INSERT INTO users
       (id, email, password_hash, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 'owner', 1, ?, ?), (?, ?, ?, 'cashier', 1, ?, ?)`,
  ).run(
    ownerId,
    "owner.reversals@example.test",
    ownerHash,
    now,
    now,
    randomUUID(),
    "cashier.reversals@example.test",
    cashierHash,
    now,
    now,
  );
});

afterAll(() => {
  db.close();
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("owner-approved full-sale reversals and cash movements", () => {
  it("switches a cash sale to QR and reconciles cash, QR, report, and shift totals", async () => {
    const owner = await signIn("owner.reversals@example.test", ownerPassword);
    await configureApprovedPolicy(owner, "NEAREST_25_CENTAVOS");
    const product = await createProduct(owner, { sellingPrice: "112.13" });
    const cashier = await signIn(
      "cashier.reversals@example.test",
      cashierPassword,
    );
    const openedShift = await openShift(cashier, "200.00");
    expect(openedShift.status).toBe(201);
    const sale = await sell(cashier, product.id, "CASH");
    expect(sale.amountDue).toBe("112.25");

    const beforeSwitch = (await cashier.get("/api/shifts/current")).body
      .shift as { expectedCash: string; expectedQrSales: string };
    expect(beforeSwitch).toMatchObject({
      expectedCash: "312.25",
      expectedQrSales: "0.00",
    });

    const switched = await postWithCsrf(
      cashier,
      `/api/sales/${sale.transactionId}/payment-switches`,
      { reason: "Customer paid by QR after the cash sale was saved" },
    );
    expect(switched.status, JSON.stringify(switched.body)).toBe(201);
    expect(switched.body.paymentSwitch).toMatchObject({
      fromMethod: "CASH",
      toMethod: "QR",
      cashAmount: "112.25",
      qrAmount: "112.13",
      cashRoundingAdjustment: "0.12",
    });
    expect(switched.body.sale).toMatchObject({
      paymentMethod: "QR",
      amountDue: "112.13",
      cashRoundingAdjustment: "0.00",
    });

    const afterSwitch = (await cashier.get("/api/shifts/current")).body
      .shift as { expectedCash: string; expectedQrSales: string };
    expect(afterSwitch).toMatchObject({
      expectedCash: "200.00",
      expectedQrSales: "112.13",
    });
    const saleDetails = await owner.get(`/api/sales/${sale.transactionId}`);
    const report = await owner.get(
      `/api/reports/daily?date=${saleDetails.body.sale.businessDate}`,
    );
    expect(report.body.report.metrics).toMatchObject({
      cashSales: "0.00",
      qrSales: "112.13",
      cashRoundingAdjustments: "0.00",
    });
    expect(report.body.report.transactionChanges).toEqual([
      expect.objectContaining({
        transactionId: sale.transactionId,
        changedAt: switched.body.paymentSwitch.createdAt,
        changedByEmail: "cashier.reversals@example.test",
        changedByRole: "cashier",
        kind: "PAYMENT_SWITCH",
        reason: "Customer paid by QR after the cash sale was saved",
        payment: {
          fromMethod: "CASH",
          toMethod: "QR",
          cashAmount: "112.25",
          qrAmount: "112.13",
        },
        refund: null,
      }),
    ]);

    const shifts = await owner.get("/api/shifts/history");
    const savedShift = shifts.body.shifts.find(
      (shift: { id: string }) => shift.id === openedShift.body.shift.id,
    );
    expect(savedShift).toMatchObject({
      cashSales: "0.00",
      qrSales: "112.13",
      expectedCash: "200.00",
    });
    const paymentChange = db
      .prepare(
        `SELECT from_method, to_method, cash_amount_centavos,
                qr_amount_centavos, cash_rounding_adjustment_centavos,
                changed_by_user_id FROM sale_payment_switches`,
      )
      .get() as {
      from_method: string;
      to_method: string;
      cash_amount_centavos: number;
      qr_amount_centavos: number;
      cash_rounding_adjustment_centavos: number;
      changed_by_user_id: string;
    };
    expect(paymentChange).toMatchObject({
      from_method: "CASH",
      to_method: "QR",
      cash_amount_centavos: 11_225,
      qr_amount_centavos: 11_213,
      cash_rounding_adjustment_centavos: 12,
    });

    const detailsAfterSwitch = await owner.get(
      `/api/sales/${sale.transactionId}`,
    );
    expect(detailsAfterSwitch.body.sale.changes).toEqual([
      expect.objectContaining({
        kind: "PAYMENT_SWITCH",
        actorEmail: "cashier.reversals@example.test",
        reason: "Customer paid by QR after the cash sale was saved",
        products: [
          expect.objectContaining({
            name: "Synthetic Reversal Product",
            sku: "SYN-REVERSAL-001",
            quantity: 1,
          }),
        ],
        payment: {
          fromMethod: "CASH",
          toMethod: "QR",
          cashAmount: "112.25",
          qrAmount: "112.13",
          cashRoundingAdjustment: "0.12",
        },
        refund: null,
      }),
    ]);
  });

  it("cancels a cash sale within ten minutes, refunds the drawer, restocks, and logs who changed it", async () => {
    const owner = await signIn("owner.reversals@example.test", ownerPassword);
    await configureApprovedPolicy(owner, "NEAREST_25_CENTAVOS");
    const product = await createProduct(owner, { sellingPrice: "112.13" });
    const cashier = await signIn(
      "cashier.reversals@example.test",
      cashierPassword,
    );
    const shift = await openShift(cashier, "200.00");
    expect(shift.status).toBe(201);
    const sale = await sell(cashier, product.id, "CASH");
    expect(sale.amountDue).toBe("112.25");

    const recent = await cashier.get("/api/sales/recent");
    expect(recent.status).toBe(200);
    expect(recent.body.sales).toEqual([
      expect.objectContaining({
        transactionId: sale.transactionId,
        paymentMethod: "CASH",
        amountDue: "112.25",
        qrAmountIfSwitched: "112.13",
        status: "FINALIZED",
        lines: [
          expect.objectContaining({
            productName: "Synthetic Reversal Product",
            sku: "SYN-REVERSAL-001",
            quantity: 1,
          }),
        ],
      }),
    ]);

    const cancelled = await quickCancel(
      cashier,
      sale.transactionId,
      sale.lines[0]!.saleLineId,
      {
        method: "CASH",
        shiftId: shift.body.shift.id as string,
        restock: true,
        reason: "Customer changed their mind before leaving",
      },
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(201);
    expect(cancelled.body.reversal).toMatchObject({
      saleTransactionId: sale.transactionId,
      reason: "Customer changed their mind before leaving",
      refundMethod: "CASH",
      amount: "112.25",
      approvedBy: "cashier.reversals@example.test",
      lines: [
        expect.objectContaining({
          productName: "Synthetic Reversal Product",
          quantity: 1,
          stockTreatment: "RESTOCK",
        }),
      ],
    });
    expect(
      (await cashier.get("/api/shifts/current")).body.shift.expectedCash,
    ).toBe("200.00");
    expect(
      db
        .prepare("SELECT quantity_on_hand FROM products WHERE id = ?")
        .get(product.id),
    ).toEqual({ quantity_on_hand: 5 });
    expect(
      db
        .prepare(
          "SELECT movement_type, amount_delta_centavos FROM cash_movements",
        )
        .get(),
    ).toEqual({ movement_type: "CASH_REFUND", amount_delta_centavos: -11_225 });

    const saved = await owner.get(`/api/sales/${sale.transactionId}`);
    expect(saved.body.sale.changes).toEqual([
      expect.objectContaining({
        kind: "CANCELLATION",
        actorEmail: "cashier.reversals@example.test",
        reason: "Customer changed their mind before leaving",
        products: [
          {
            name: "Synthetic Reversal Product",
            sku: "SYN-REVERSAL-001",
            quantity: 1,
            stockTreatment: "RESTOCK",
          },
        ],
        payment: null,
        refund: expect.objectContaining({
          method: "CASH",
          amount: "112.25",
        }),
      }),
    ]);
    expect(
      (await cashier.get("/api/sales/recent")).body.sales[0],
    ).toMatchObject({
      transactionId: sale.transactionId,
      status: "REVERSED",
      reversalTransactionId: cancelled.body.reversal.transactionId,
    });
    const report = await owner.get(
      `/api/reports/daily?date=${saved.body.sale.businessDate}`,
    );
    expect(report.body.report.transactionChanges).toEqual([
      expect.objectContaining({
        transactionId: sale.transactionId,
        changedAt: cancelled.body.reversal.createdAt,
        changedByEmail: "cashier.reversals@example.test",
        changedByRole: "cashier",
        kind: "CANCELLATION",
        reason: "Customer changed their mind before leaving",
        refund: { method: "CASH", amount: "112.25" },
      }),
    ]);
  });

  it("requires QR refund confirmation before cancellation and records write-offs in history", async () => {
    const owner = await signIn("owner.reversals@example.test", ownerPassword);
    await configureApprovedPolicy(owner);
    const product = await createProduct(owner);
    const cashier = await signIn(
      "cashier.reversals@example.test",
      cashierPassword,
    );
    const shift = await openShift(cashier, "100.00");
    const sale = await sell(cashier, product.id, "QR");
    const saleLineId = sale.lines[0]!.saleLineId;

    const unconfirmed = await quickCancel(
      cashier,
      sale.transactionId,
      saleLineId,
      { method: "QR", restock: false },
    );
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.error).toBe("qr_refund_confirmation_required");
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM sale_reversals").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);

    const cancelled = await quickCancel(
      cashier,
      sale.transactionId,
      saleLineId,
      { method: "QR", restock: false, qrRefundConfirmed: true },
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(201);
    expect(cancelled.body.reversal).toMatchObject({
      refundMethod: "QR",
      amount: "112.00",
      lines: [expect.objectContaining({ stockTreatment: "WRITE_OFF" })],
    });
    expect(
      (await cashier.get("/api/shifts/current")).body.shift.expectedCash,
    ).toBe("100.00");
    expect(
      db
        .prepare("SELECT quantity_on_hand FROM products WHERE id = ?")
        .get(product.id),
    ).toEqual({ quantity_on_hand: 4 });
    const saved = await owner.get(`/api/sales/${sale.transactionId}`);
    expect(saved.body.sale.changes[0]).toMatchObject({
      kind: "CANCELLATION",
      products: [
        {
          name: "Synthetic Reversal Product",
          sku: "SYN-REVERSAL-001",
          quantity: 1,
          stockTreatment: "WRITE_OFF",
        },
      ],
      refund: { method: "QR", amount: "112.00" },
    });
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM cash_movements").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
  });

  it("hides and rejects cancellation and payment changes after the ten-minute window", async () => {
    const owner = await signIn("owner.reversals@example.test", ownerPassword);
    await configureApprovedPolicy(owner);
    const product = await createProduct(owner);
    const cashier = await signIn(
      "cashier.reversals@example.test",
      cashierPassword,
    );
    const shift = await openShift(cashier, "200.00");
    const sale = await sell(cashier, product.id, "CASH");
    db.prepare("UPDATE sales SET created_at = ? WHERE transaction_id = ?").run(
      new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      sale.transactionId,
    );

    expect((await cashier.get("/api/sales/recent")).body.sales).toEqual([]);
    const cancel = await quickCancel(
      cashier,
      sale.transactionId,
      sale.lines[0]!.saleLineId,
      {
        method: "CASH",
        shiftId: shift.body.shift.id as string,
        restock: true,
      },
    );
    expect(cancel.status).toBe(409);
    expect(cancel.body.error).toBe("quick_action_window_expired");

    const switched = await postWithCsrf(
      cashier,
      `/api/sales/${sale.transactionId}/payment-switches`,
      { reason: "Synthetic attempt after the correction window" },
    );
    expect(switched.status).toBe(409);
    expect(switched.body.error).toBe("quick_action_window_expired");
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM sale_reversals").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM sale_payment_switches")
          .get() as { count: number }
      ).count,
    ).toBe(0);
  });

  it("returns verified sellable stock to its original lots and writes off a quarantined lot", async () => {
    const owner = await signIn("owner.reversals@example.test", ownerPassword);
    await configureApprovedPolicy(owner);
    const firstProduct = await createProduct(owner, {
      sku: "SYN-LOT-RETURN-A",
      openingQuantity: 1,
    });
    const secondProduct = await createProduct(owner, {
      sku: "SYN-LOT-RETURN-B",
      openingQuantity: 1,
    });
    const firstTrackingToken = await csrfFor(owner);
    await owner
      .patch(`/api/products/${firstProduct.id}`)
      .set("x-csrf-token", firstTrackingToken)
      .send({ tracksLots: true });
    const secondTrackingToken = await csrfFor(owner);
    await owner
      .patch(`/api/products/${secondProduct.id}`)
      .set("x-csrf-token", secondTrackingToken)
      .send({ tracksLots: true });
    for (const [productId, lotCode] of [
      [firstProduct.id, "SYN-ORIGINAL-A"],
      [secondProduct.id, "SYN-ORIGINAL-B"],
    ] as const) {
      const token = await csrfFor(owner);
      const reconciled = await owner
        .post("/api/stock/lots/reconcile")
        .set("x-csrf-token", token)
        .send({
          productId,
          reason: "Synthetic original-lot verification",
          physicalCountConfirmed: true,
          allocations: [
            { lotCode, expiryDate: manilaDayAfter(30), quantity: 1 },
          ],
        });
      expect(reconciled.status).toBe(201);
    }
    const cashier = await signIn(
      "cashier.reversals@example.test",
      cashierPassword,
    );
    expect((await openShift(cashier)).status).toBe(201);
    const previewToken = await csrfFor(cashier);
    const preview = await cashier
      .post("/api/sales/preview")
      .set("x-csrf-token", previewToken)
      .send({
        benefitType: "REGULAR",
        paymentMethod: "QR",
        items: [
          { productId: firstProduct.id, quantity: 1 },
          { productId: secondProduct.id, quantity: 1 },
        ],
      });
    expect(preview.status).toBe(200);
    const saleToken = await csrfFor(cashier);
    const sale = await cashier
      .post("/api/sales")
      .set("x-csrf-token", saleToken)
      .send({
        benefitType: "REGULAR",
        paymentMethod: "QR",
        requestKey: randomUUID(),
        items: preview.body.lines.map(
          (line: {
            productId: string;
            quantity: number;
            assignedLots: Array<{ lotId: string; quantity: number }>;
          }) => ({
            productId: line.productId,
            quantity: line.quantity,
            lotAllocations: line.assignedLots.map((lot) => ({
              lotId: lot.lotId,
              quantity: lot.quantity,
            })),
            lotPickConfirmed: true,
          }),
        ),
      });
    expect(sale.status).toBe(201);
    const firstLine = sale.body.sale.lines.find(
      (line: { productId: string }) => line.productId === firstProduct.id,
    );
    const secondLine = sale.body.sale.lines.find(
      (line: { productId: string }) => line.productId === secondProduct.id,
    );
    const quarantineToken = await csrfFor(owner);
    const quarantine = await owner
      .patch(`/api/stock/lots/${secondLine.lotAllocations[0].lotId}/quarantine`)
      .set("x-csrf-token", quarantineToken)
      .send({ quarantined: true, reason: "Synthetic damaged package hold" });
    expect(quarantine.status).toBe(200);

    const incompleteVerificationToken = await csrfFor(owner);
    const incompleteVerification = await owner
      .post(`/api/sales/${sale.body.sale.transactionId}/reversals`)
      .set("x-csrf-token", incompleteVerificationToken)
      .send({
        ownerPassword,
        reason: "Synthetic mixed lot return",
        refundMethod: "QR",
        lines: [
          { saleLineId: firstLine.saleLineId, restock: true },
          { saleLineId: secondLine.saleLineId, restock: false },
        ],
      });
    expect(incompleteVerification.status).toBe(400);
    expect(incompleteVerification.body.error).toBe(
      "lot_return_verification_required",
    );

    const reversalToken = await csrfFor(owner);
    const reversal = await owner
      .post(`/api/sales/${sale.body.sale.transactionId}/reversals`)
      .set("x-csrf-token", reversalToken)
      .send({
        ownerPassword,
        reason: "Synthetic mixed lot return after physical check",
        refundMethod: "QR",
        lines: [
          {
            saleLineId: firstLine.saleLineId,
            restock: true,
            lotPickVerified: true,
          },
          { saleLineId: secondLine.saleLineId, restock: false },
        ],
      });
    expect(reversal.status).toBe(201);
    const lots = await owner.get("/api/stock/lots");
    expect(
      lots.body.lots.find(
        (lot: { id: string }) => lot.id === firstLine.lotAllocations[0].lotId,
      ),
    ).toMatchObject({ quantity: 1, saleableQuantity: 1 });
    expect(
      lots.body.lots.find(
        (lot: { id: string }) => lot.id === secondLine.lotAllocations[0].lotId,
      ),
    ).toMatchObject({ quantity: 0, quarantined: true });
  });

  it.each([
    ["112.13", "0.12", "112.25", 12],
    ["112.12", "-0.12", "112.00", -12],
  ])(
    "refunds the saved $1 cash rounding adjustment and restores the drawer total",
    async (sellingPrice, adjustment, saleTotal, adjustmentCentavos) => {
      const owner = await signIn("owner.reversals@example.test", ownerPassword);
      await configureApprovedPolicy(owner, "NEAREST_25_CENTAVOS");
      const product = await createProduct(owner, { sellingPrice });
      const cashier = await signIn(
        "cashier.reversals@example.test",
        cashierPassword,
      );
      const cashierShift = await openShift(cashier, "200.00");
      const sale = await sell(cashier, product.id, "CASH");
      expect(sale.amountDue).toBe(saleTotal);
      expect(
        (await owner.get(`/api/sales/${sale.transactionId}`)).body.sale
          .cashRoundingAdjustment,
      ).toBe(adjustment);

      const saleDetails = await owner.get(`/api/sales/${sale.transactionId}`);
      const reversal = await reverse(
        owner,
        sale.transactionId,
        saleDetails.body.sale.lines[0].saleLineId as string,
        { method: "CASH", shiftId: cashierShift.body.shift.id as string },
      );
      expect(reversal.status, JSON.stringify(reversal.body)).toBe(201);
      expect(reversal.body.reversal).toMatchObject({
        amount: saleTotal,
        cashRoundingAdjustment: adjustment,
        lines: [{ refundAmount: sellingPrice }],
      });
      expect(
        (await cashier.get("/api/shifts/current")).body.shift.expectedCash,
      ).toBe("200.00");
      expect(
        db
          .prepare(
            "SELECT amount_centavos, cash_rounding_adjustment_centavos FROM sale_reversals",
          )
          .get(),
      ).toEqual({
        amount_centavos: Number(saleTotal.replace(".", "")),
        cash_rounding_adjustment_centavos: adjustmentCentavos,
      });
    },
  );

  it("reauthenticates the owner, restores original stock cost, and records a cash refund once", async () => {
    const owner = await signIn("owner.reversals@example.test", ownerPassword);
    await configureApprovedPolicy(owner);
    const product = await createProduct(owner);
    const cashier = await signIn(
      "cashier.reversals@example.test",
      cashierPassword,
    );
    const cashierShift = await openShift(cashier, "200.00");
    expect(cashierShift.status).toBe(201);
    const sale = await sell(cashier, product.id);
    expect(
      (
        await closeShift(
          cashier,
          cashierShift.body.shift.id as string,
          "312.00",
        )
      ).status,
    ).toBe(200);
    const ownerShift = await openShift(owner, "300.00");
    expect(ownerShift.status).toBe(201);
    const shiftId = ownerShift.body.shift.id as string;

    const saleDetails = await owner.get(`/api/sales/${sale.transactionId}`);
    const saleLineId = saleDetails.body.sale.lines[0].saleLineId as string;
    const reversal = await reverse(owner, sale.transactionId, saleLineId, {
      method: "CASH",
      shiftId,
    });
    expect(reversal.status, JSON.stringify(reversal.body)).toBe(201);
    expect(reversal.body.reversal).toMatchObject({
      transactionId: expect.stringMatching(/^MTR-\d{8}-\d{6}$/),
      saleTransactionId: sale.transactionId,
      refundMethod: "CASH",
      amount: "112.00",
      lines: [
        {
          stockTreatment: "RESTOCK",
          originalCogs: "40.00",
          cogsRestored: "40.00",
          writeoff: "0.00",
        },
      ],
    });
    expect(reversal.body.sale.transactionId).toBe(sale.transactionId);

    const productState = db
      .prepare(
        "SELECT quantity_on_hand, inventory_value_centavos FROM products WHERE id = ?",
      )
      .get(product.id) as {
      quantity_on_hand: number;
      inventory_value_centavos: number;
    };
    expect(productState).toEqual({
      quantity_on_hand: 5,
      inventory_value_centavos: 20_000,
    });
    expect(
      (await owner.get("/api/shifts/open")).body.shifts.find(
        (shift: { id: string }) => shift.id === shiftId,
      ).expectedCash,
    ).toBe("188.00");
    expect(
      db
        .prepare(
          "SELECT movement_type, amount_delta_centavos FROM cash_movements",
        )
        .get() as { movement_type: string; amount_delta_centavos: number },
    ).toEqual({ movement_type: "CASH_REFUND", amount_delta_centavos: -11_200 });
    expect(
      db
        .prepare(
          "SELECT event_type, quantity_delta, inventory_value_delta_centavos FROM stock_events WHERE event_type = 'REVERSAL'",
        )
        .get() as {
        event_type: string;
        quantity_delta: number;
        inventory_value_delta_centavos: number;
      },
    ).toEqual({
      event_type: "REVERSAL",
      quantity_delta: 1,
      inventory_value_delta_centavos: 4_000,
    });
    const summary = await owner.get("/api/sales");
    expect(summary.body.sales[0]).toMatchObject({
      transactionId: sale.transactionId,
      amountDue: "112.00",
      status: "REVERSED",
      reversal: { amount: "112.00", refundMethod: "CASH" },
    });

    const replay = await reverse(owner, sale.transactionId, saleLineId, {
      method: "CASH",
      shiftId,
    });
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe("sale_already_reversed");
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM sale_reversals").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
    const original = db
      .prepare("SELECT amount_due_centavos FROM sales WHERE transaction_id = ?")
      .get(sale.transactionId) as { amount_due_centavos: number };
    expect(original.amount_due_centavos).toBe(11_200);
  });

  it("blocks cashiers and bad reauthentication; QR refunds do not move cash and non-sellable returns are write-offs", async () => {
    const owner = await signIn("owner.reversals@example.test", ownerPassword);
    await configureApprovedPolicy(owner);
    const product = await createProduct(owner);
    const cashier = await signIn(
      "cashier.reversals@example.test",
      cashierPassword,
    );
    await openShift(cashier, "100.00");
    const sale = await sell(cashier, product.id, "QR");
    const saleDetails = await owner.get(`/api/sales/${sale.transactionId}`);
    const payload = {
      ownerPassword,
      reason: "Synthetic full reversal of QR sale",
      refundMethod: "QR",
      lines: [
        {
          saleLineId: saleDetails.body.sale.lines[0].saleLineId,
          restock: false,
        },
      ],
    };
    expect((await cashier.get("/api/sales")).status).toBe(403);
    expect((await cashier.get("/api/shifts/open")).status).toBe(403);
    const cashierShift = (await cashier.get("/api/shifts/current")).body.shift;
    const cashierCashMovement = await postWithCsrf(
      cashier,
      `/api/shifts/${cashierShift.id}/cash-movements`,
      {
        movementType: "CASH_IN",
        amount: "10.00",
        reason: "Synthetic forbidden owner cash movement",
      },
    );
    expect(cashierCashMovement.status).toBe(403);
    const cashierDenied = await postWithCsrf(
      cashier,
      `/api/sales/${sale.transactionId}/reversals`,
      payload,
    );
    expect(cashierDenied.status).toBe(403);

    const wrongPassword = await postWithCsrf(
      owner,
      `/api/sales/${sale.transactionId}/reversals`,
      { ...payload, ownerPassword: "NotTheSyntheticOwnerPassword" },
    );
    expect(wrongPassword.status, JSON.stringify(wrongPassword.body)).toBe(403);
    expect(wrongPassword.body.error).toBe("reauthentication_failed");
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM sale_reversals").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);

    const reversal = await postWithCsrf(
      owner,
      `/api/sales/${sale.transactionId}/reversals`,
      payload,
    );
    expect(reversal.status, JSON.stringify(reversal.body)).toBe(201);
    expect(reversal.body.reversal.lines[0]).toMatchObject({
      stockTreatment: "WRITE_OFF",
      cogsRestored: "0.00",
      writeoff: "40.00",
    });
    expect(
      (await cashier.get("/api/shifts/current")).body.shift.expectedCash,
    ).toBe("100.00");
    const productState = db
      .prepare(
        "SELECT quantity_on_hand, inventory_value_centavos FROM products WHERE id = ?",
      )
      .get(product.id) as {
      quantity_on_hand: number;
      inventory_value_centavos: number;
    };
    expect(productState).toEqual({
      quantity_on_hand: 4,
      inventory_value_centavos: 16_000,
    });
    expect(
      db
        .prepare(
          `SELECT event_type, quantity_delta, inventory_value_delta_centavos
           FROM stock_events WHERE event_type IN ('REVERSAL', 'WRITE_OFF')
           ORDER BY sequence`,
        )
        .all(),
    ).toEqual([
      {
        event_type: "REVERSAL",
        quantity_delta: 1,
        inventory_value_delta_centavos: 4_000,
      },
      {
        event_type: "WRITE_OFF",
        quantity_delta: -1,
        inventory_value_delta_centavos: -4_000,
      },
    ]);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM cash_movements").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
  });

  it("requires an open funded drawer and updates reasoned cash-in/out and refund movements", async () => {
    const owner = await signIn("owner.reversals@example.test", ownerPassword);
    await configureApprovedPolicy(owner);
    const product = await createProduct(owner);
    const cashier = await signIn(
      "cashier.reversals@example.test",
      cashierPassword,
    );
    const cashierShift = await openShift(cashier, "200.00");
    expect(cashierShift.status).toBe(201);
    const sale = await sell(cashier, product.id);
    expect(
      (
        await closeShift(
          cashier,
          cashierShift.body.shift.id as string,
          "312.00",
        )
      ).status,
    ).toBe(200);
    const ownerDetails = await owner.get(`/api/sales/${sale.transactionId}`);
    const basePayload = {
      ownerPassword,
      reason: "Synthetic cash refund test",
      refundMethod: "CASH",
      lines: [
        {
          saleLineId: ownerDetails.body.sale.lines[0].saleLineId,
          restock: true,
        },
      ],
    };
    const noDrawer = await postWithCsrf(
      owner,
      `/api/sales/${sale.transactionId}/reversals`,
      { ...basePayload, refundShiftId: randomUUID() },
    );
    expect(noDrawer.status, JSON.stringify(noDrawer.body)).toBe(409);
    expect(noDrawer.body.error).toBe("cash_refund_requires_open_shift");

    const ownerShift = await openShift(owner, "50.00");
    const shiftId = ownerShift.body.shift.id as string;
    const insufficient = await postWithCsrf(
      owner,
      `/api/sales/${sale.transactionId}/reversals`,
      { ...basePayload, refundShiftId: shiftId },
    );
    expect(insufficient.status).toBe(409);
    expect(insufficient.body.error).toBe("insufficient_shift_cash");

    const cashIn = await postWithCsrf(
      owner,
      `/api/shifts/${shiftId}/cash-movements`,
      {
        movementType: "CASH_IN",
        amount: "100.00",
        reason: "Synthetic float added",
      },
    );
    expect(cashIn.status).toBe(201);
    expect(cashIn.body.expectedCash).toBe("150.00");
    const cashOut = await postWithCsrf(
      owner,
      `/api/shifts/${shiftId}/cash-movements`,
      {
        movementType: "CASH_OUT",
        amount: "10.00",
        reason: "Synthetic bank deposit",
      },
    );
    expect(cashOut.status).toBe(201);
    expect(cashOut.body.expectedCash).toBe("140.00");

    const reversal = await postWithCsrf(
      owner,
      `/api/sales/${sale.transactionId}/reversals`,
      { ...basePayload, refundShiftId: shiftId },
    );
    expect(reversal.status, JSON.stringify(reversal.body)).toBe(201);
    const movementList = await owner.get(
      `/api/shifts/${shiftId}/cash-movements`,
    );
    expect(movementList.body.movements).toHaveLength(3);
    expect(
      movementList.body.movements.map((item: { type: string }) => item.type),
    ).toEqual(["CASH_REFUND", "CASH_OUT", "CASH_IN"]);
    const openShifts = await owner.get("/api/shifts/open");
    expect(
      openShifts.body.shifts.find(
        (shift: { id: string }) => shift.id === shiftId,
      ).expectedCash,
    ).toBe("28.00");
  });

  it("serializes simultaneous owner reversal attempts so only one is saved", async () => {
    const owner = await signIn("owner.reversals@example.test", ownerPassword);
    await configureApprovedPolicy(owner);
    const product = await createProduct(owner);
    const cashier = await signIn(
      "cashier.reversals@example.test",
      cashierPassword,
    );
    await openShift(cashier);
    const sale = await sell(cashier, product.id, "QR");
    const saleLineId = sale.lines[0]!.saleLineId;
    const secondOwner = await signIn(
      "owner.reversals@example.test",
      ownerPassword,
    );
    const [first, second] = await Promise.all([
      reverse(owner, sale.transactionId, saleLineId, { method: "QR" }),
      reverse(secondOwner, sale.transactionId, saleLineId, { method: "QR" }),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM sale_reversals").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
  });
});
