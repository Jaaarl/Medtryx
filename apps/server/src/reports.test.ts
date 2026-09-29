import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { openDatabase } from "./db.js";
import { safeCsvCell } from "./reports.js";
import { clearLotLedgerForTest } from "./test-ledger.js";

process.env.APP_ENV = "test";
process.env.COOKIE_SECURE = "false";
process.env.CUSTOMER_ID_ENCRYPTION_KEY = "d4".repeat(32);

const ownerPassword = "SyntheticReportOwner-67!";
const cashierPassword = "SyntheticReportCashier-78!";
let dataDirectory: string;
let db: ReturnType<typeof openDatabase>;
let app: ReturnType<typeof createApp>;
let ownerHash: string;
let cashierHash: string;
let ownerId: string;

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

async function postWithCsrf(
  agent: Agent,
  path: string,
  body: Record<string, unknown>,
) {
  const csrf = (await agent.get("/api/auth/csrf")).body.token as string;
  return agent.post(`/api${path}`).set("x-csrf-token", csrf).send(body);
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
  dataDirectory = mkdtempSync(join(tmpdir(), "medtryx-reports-test-"));
  db = openDatabase("test", dataDirectory);
  app = createApp(db);
  ownerHash = await argon2.hash(ownerPassword, { type: argon2.argon2id });
  cashierHash = await argon2.hash(cashierPassword, { type: argon2.argon2id });
});

beforeEach(() => {
  clearLotLedgerForTest(db);
  db.exec(
    `DELETE FROM sale_reversal_lines;
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
    "owner.reports@example.test",
    ownerHash,
    now,
    now,
    randomUUID(),
    "cashier.reports@example.test",
    cashierHash,
    now,
    now,
  );
});

afterAll(() => {
  db.close();
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("daily owner reports and CSV export", () => {
  it("escapes formula-leading CSV cells and quotes embedded delimiters", () => {
    expect(safeCsvCell("=1+1")).toBe('"\'=1+1"');
    expect(safeCsvCell(" \t@SUM(A1:A2)")).toBe('"\' \t@SUM(A1:A2)"');
    expect(safeCsvCell('Name, "pack"')).toBe('"Name, ""pack"""');
  });

  it("reconciles to saved sale and stock snapshots, enforces owner access, and omits customer details", async () => {
    const owner = await signIn("owner.reports@example.test", ownerPassword);
    const cashier = await signIn(
      "cashier.reports@example.test",
      cashierPassword,
    );
    expect((await request(app).get("/api/reports/daily")).status).toBe(401);
    expect((await cashier.get("/api/reports/daily")).status).toBe(403);
    expect((await cashier.get("/api/reports/daily.csv")).status).toBe(403);
    expect(
      (
        await cashier.get(
          "/api/reports/range?startDate=2026-01-01&endDate=2026-01-31",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await cashier.get(
          "/api/reports/range.csv?startDate=2026-01-01&endDate=2026-01-31",
        )
      ).status,
    ).toBe(403);

    const configured = await postWithCsrf(owner, "/settings/tax-policy", {
      confirmApproved: true,
      version: "SYNTHETIC-REPORT-TAX",
      vatRateBasisPoints: 1_200,
      seniorDiscountBasisPoints: 2_000,
      pwdDiscountBasisPoints: 2_000,
      vatInclusivePrices: true,
      allowZeroRated: false,
      roundingMode: "HALF_UP",
      approvalReference: "Synthetic report test policy only",
      costBasisDescription: "Synthetic weighted-average acquisition cost",
    });
    expect(configured.status).toBe(200);
    const productResponse = await postWithCsrf(owner, "/products", {
      sku: "SYN-REPORT-001",
      name: "Synthetic report medicine",
      unit: "piece",
      sellingPrice: "112.00",
      taxClass: "VATABLE",
      productType: "BRANDED",
      isScEligible: true,
      isPwdEligible: true,
      openingQuantity: 5,
      openingUnitCost: "40.00",
      reorderLevel: 5,
    });
    expect(productResponse.status).toBe(201);
    const productId = productResponse.body.product.id as string;
    const shiftResponse = await postWithCsrf(cashier, "/shifts", {
      openingCash: "100.00",
    });
    expect(shiftResponse.status).toBe(201);

    const saleResponse = await postWithCsrf(cashier, "/sales", {
      benefitType: "SENIOR_CITIZEN",
      items: [{ productId, quantity: 1, benefitApplied: true }],
      paymentMethod: "QR",
      requestKey: randomUUID(),
      customerName: "SYNTHETIC REPORT CUSTOMER",
      customerIdType: "Synthetic ID",
      customerIdNumber: "SYN-PRIVATE-ID-9876",
      customerIdChecked: true,
    });
    expect(saleResponse.status, JSON.stringify(saleResponse.body)).toBe(201);
    const sale = saleResponse.body.sale as {
      transactionId: string;
      businessDate: string;
    };

    const reportResponse = await owner.get(
      `/api/reports/daily?date=${sale.businessDate}`,
    );
    expect(reportResponse.status).toBe(200);
    expect(reportResponse.body.report).toMatchObject({
      businessDate: sale.businessDate,
      timeZone: "Asia/Manila",
      reversalCount: 0,
      inventory: {
        activeProductCount: 1,
        lowStockCount: 1,
        inventoryValue: "160.00",
        lowStock: [
          {
            sku: "SYN-REPORT-001",
            quantityOnHand: 4,
            reorderLevel: 5,
            inventoryValue: "160.00",
          },
        ],
      },
    });
    const sameDayRange = await owner.get(
      `/api/reports/range?startDate=${sale.businessDate}&endDate=${sale.businessDate}`,
    );
    expect(sameDayRange.status).toBe(200);
    expect(sameDayRange.body.report.metrics).toEqual(
      reportResponse.body.report.metrics,
    );
    const line = db
      .prepare(
        `SELECT quantity, unit_price_centavos, tax_basis_centavos, vat_centavos,
                vat_removed_centavos, discount_centavos, amount_due_centavos,
                allocated_cogs_centavos
         FROM sale_lines WHERE sale_id = (SELECT id FROM sales WHERE transaction_id = ?)`,
      )
      .get(sale.transactionId) as {
      quantity: number;
      unit_price_centavos: number;
      tax_basis_centavos: number;
      vat_centavos: number;
      vat_removed_centavos: number;
      discount_centavos: number;
      amount_due_centavos: number;
      allocated_cogs_centavos: number;
    };
    const metrics = reportResponse.body.report.metrics as Record<
      string,
      string
    >;
    expect(metrics.grossSales).toBe("112.00");
    expect(metrics.netSalesExcludingVat).toBe(
      ((line.amount_due_centavos - line.vat_centavos) / 100).toFixed(2),
    );
    expect(metrics.vatableSalesBase).toBe(
      (line.tax_basis_centavos / 100).toFixed(2),
    );
    expect(metrics.vatOutput).toBe((line.vat_centavos / 100).toFixed(2));
    expect(metrics.vatRemoved).toBe(
      (line.vat_removed_centavos / 100).toFixed(2),
    );
    expect(metrics.seniorDiscounts).toBe(
      (line.discount_centavos / 100).toFixed(2),
    );
    expect(metrics.cogs).toBe((line.allocated_cogs_centavos / 100).toFixed(2));
    expect(metrics.estimatedGrossProfit).toBe(
      (
        (line.amount_due_centavos -
          line.vat_centavos -
          line.allocated_cogs_centavos) /
        100
      ).toFixed(2),
    );
    expect(metrics.qrSales).toBe((line.amount_due_centavos / 100).toFixed(2));

    const csv = await owner.get(
      `/api/reports/daily.csv?date=${sale.businessDate}`,
    );
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text).toContain('"Sales","Gross sales","112.00"');
    expect(csv.text).toContain(
      '"Inventory","Current inventory value","160.00"',
    );
    expect(csv.text).not.toContain("SYNTHETIC REPORT CUSTOMER");
    expect(csv.text).not.toContain("SYN-PRIVATE-ID-9876");

    const saleDetails = await owner.get(`/api/sales/${sale.transactionId}`);
    const reversal = await postWithCsrf(
      owner,
      `/sales/${sale.transactionId}/reversals`,
      {
        ownerPassword,
        reason: "Synthetic report write-off reversal",
        refundMethod: "QR",
        lines: [
          {
            saleLineId: saleDetails.body.sale.lines[0].saleLineId,
            restock: false,
          },
        ],
      },
    );
    expect(reversal.status, JSON.stringify(reversal.body)).toBe(201);
    const afterReversal = await owner.get(
      `/api/reports/daily?date=${sale.businessDate}`,
    );
    expect(afterReversal.body.report).toMatchObject({
      reversalCount: 1,
      metrics: {
        grossSales: "0.00",
        netSalesExcludingVat: "0.00",
        cogs: "0.00",
        writeOffValue: (line.allocated_cogs_centavos / 100).toFixed(2),
        qrRefunds: (line.amount_due_centavos / 100).toFixed(2),
      },
      inventory: { inventoryValue: "160.00" },
    });
  });

  it("includes current lot alerts and unallocated tracked units in owner reports and CSV", async () => {
    const owner = await signIn("owner.reports@example.test", ownerPassword);
    const created = await postWithCsrf(owner, "/products", {
      sku: "SYN-REPORT-LOT-001",
      name: "Synthetic report lot item",
      unit: "piece",
      sellingPrice: "20.00",
      taxClass: "VAT_EXEMPT",
      productType: "GENERIC",
      isScEligible: false,
      isPwdEligible: false,
      tracksLots: true,
      openingQuantity: 2,
      openingUnitCost: "5.00",
      openingLotCode: "SYN-REPORT-NEAR-EXPIRY",
      openingExpiryDate: manilaDayAfter(5),
    });
    expect(created.status).toBe(201);
    const today = manilaDayAfter(0);
    const report = await owner.get(`/api/reports/daily?date=${today}`);
    expect(report.status).toBe(200);
    expect(report.body.report.inventory).toMatchObject({
      expiryWarningDays: 30,
      nearExpiryLotCount: 1,
      trackedLots: [
        expect.objectContaining({
          lotCode: "SYN-REPORT-NEAR-EXPIRY",
          physicalQuantity: 2,
          saleableQuantity: 2,
          alert: "NEAR_EXPIRY",
        }),
      ],
    });
    const csv = await owner.get(`/api/reports/daily.csv?date=${today}`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('"Lot balance"');
    expect(csv.text).toContain("SYN-REPORT-NEAR-EXPIRY");
  });

  it("reports cash rounding separately from line revenue and offsets it on reversal", async () => {
    const owner = await signIn("owner.reports@example.test", ownerPassword);
    const cashier = await signIn(
      "cashier.reports@example.test",
      cashierPassword,
    );
    const configured = await postWithCsrf(owner, "/settings/tax-policy", {
      confirmApproved: true,
      version: "SYNTHETIC-REPORT-CASH-ROUNDING",
      vatRateBasisPoints: 1_200,
      seniorDiscountBasisPoints: 2_000,
      pwdDiscountBasisPoints: 2_000,
      vatInclusivePrices: true,
      allowZeroRated: false,
      roundingMode: "HALF_UP",
      cashRoundingMode: "NEAREST_25_CENTAVOS",
      approvalReference: "Synthetic report cash rounding policy",
      costBasisDescription: "Synthetic weighted-average acquisition cost",
    });
    expect(configured.status).toBe(200);
    const productResponse = await postWithCsrf(owner, "/products", {
      sku: "SYN-REPORT-ROUND-001",
      name: "Synthetic rounding report medicine",
      unit: "piece",
      sellingPrice: "112.13",
      taxClass: "VATABLE",
      productType: "BRANDED",
      isScEligible: true,
      isPwdEligible: true,
      openingQuantity: 2,
      openingUnitCost: "40.00",
      reorderLevel: 0,
    });
    expect(productResponse.status).toBe(201);
    const productId = productResponse.body.product.id as string;
    const shiftResponse = await postWithCsrf(cashier, "/shifts", {
      openingCash: "100.00",
    });
    expect(shiftResponse.status).toBe(201);
    const saleResponse = await postWithCsrf(cashier, "/sales", {
      benefitType: "REGULAR",
      items: [{ productId, quantity: 1 }],
      paymentMethod: "CASH",
      requestKey: randomUUID(),
    });
    expect(saleResponse.status, JSON.stringify(saleResponse.body)).toBe(201);
    const sale = saleResponse.body.sale as {
      transactionId: string;
      businessDate: string;
      amountDue: string;
      lines: Array<{ saleLineId: string; amountDue: string }>;
    };
    expect(sale).toMatchObject({
      amountDue: "112.25",
      lines: [{ amountDue: "112.13" }],
    });
    const range = `/api/reports/daily?date=${sale.businessDate}`;
    const beforeReversal = await owner.get(range);
    expect(beforeReversal.body.report.metrics).toMatchObject({
      cashSales: "112.25",
      cashRoundingAdjustments: "0.12",
      netSalesExcludingVat: "100.12",
      estimatedGrossProfit: "60.12",
    });

    const reversal = await postWithCsrf(
      owner,
      `/sales/${sale.transactionId}/reversals`,
      {
        ownerPassword,
        reason: "Synthetic cash-rounding report reversal",
        refundMethod: "CASH",
        refundShiftId: shiftResponse.body.shift.id,
        lines: [{ saleLineId: sale.lines[0]!.saleLineId, restock: true }],
      },
    );
    expect(reversal.status, JSON.stringify(reversal.body)).toBe(201);
    const afterReversal = await owner.get(range);
    expect(afterReversal.body.report.metrics).toMatchObject({
      cashSales: "112.25",
      cashRefunds: "112.25",
      cashRoundingAdjustments: "0.00",
      netCashImpact: "0.00",
      netSalesExcludingVat: "0.00",
      estimatedGrossProfit: "0.00",
    });
    const csv = await owner.get(
      `/api/reports/daily.csv?date=${sale.businessDate}`,
    );
    expect(csv.text).toContain(
      '"Payments","Cash rounding adjustments (net of reversals)","0.00"',
    );
  });

  it("aggregates inclusive Manila date ranges and exports the same period", async () => {
    const owner = await signIn("owner.reports@example.test", ownerPassword);
    const cashier = await signIn(
      "cashier.reports@example.test",
      cashierPassword,
    );
    const configured = await postWithCsrf(owner, "/settings/tax-policy", {
      confirmApproved: true,
      version: "SYNTHETIC-RANGE-REPORT-TAX",
      vatRateBasisPoints: 1_200,
      seniorDiscountBasisPoints: 2_000,
      pwdDiscountBasisPoints: 2_000,
      vatInclusivePrices: true,
      allowZeroRated: false,
      roundingMode: "HALF_UP",
      approvalReference: "Synthetic date-range report test policy",
      costBasisDescription: "Synthetic weighted-average acquisition cost",
    });
    expect(configured.status).toBe(200);
    const productResponse = await postWithCsrf(owner, "/products", {
      sku: "SYN-RANGE-001",
      name: "Synthetic range report product",
      unit: "piece",
      sellingPrice: "112.00",
      taxClass: "VATABLE",
      productType: "BRANDED",
      isScEligible: true,
      isPwdEligible: true,
      openingQuantity: 5,
      openingUnitCost: "40.00",
    });
    expect(productResponse.status).toBe(201);
    const productId = productResponse.body.product.id as string;
    expect(
      (await postWithCsrf(cashier, "/shifts", { openingCash: "100.00" }))
        .status,
    ).toBe(201);

    async function createSale(paymentMethod: "CASH" | "QR") {
      const response = await postWithCsrf(cashier, "/sales", {
        benefitType: "REGULAR",
        items: [{ productId, quantity: 1 }],
        paymentMethod,
        requestKey: randomUUID(),
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      return response.body.sale as { transactionId: string };
    }

    const outsideBefore = await createSale("CASH");
    const startSale = await createSale("QR");
    const endSale = await createSale("CASH");
    const outsideAfter = await createSale("QR");
    const setBusinessDate = db.prepare(
      "UPDATE sales SET business_date = ? WHERE transaction_id = ?",
    );
    setBusinessDate.run("2026-04-29", outsideBefore.transactionId);
    setBusinessDate.run("2026-04-30", startSale.transactionId);
    setBusinessDate.run("2026-05-01", endSale.transactionId);
    setBusinessDate.run("2026-05-02", outsideAfter.transactionId);

    const saleDetails = await owner.get(
      `/api/sales/${startSale.transactionId}`,
    );
    const reversal = await postWithCsrf(
      owner,
      `/sales/${startSale.transactionId}/reversals`,
      {
        ownerPassword,
        reason: "Synthetic cross-day report reversal",
        refundMethod: "QR",
        lines: [
          {
            saleLineId: saleDetails.body.sale.lines[0].saleLineId,
            restock: true,
          },
        ],
      },
    );
    expect(reversal.status, JSON.stringify(reversal.body)).toBe(201);
    db.prepare("UPDATE sale_reversals SET created_at = ? WHERE id = ?").run(
      "2026-05-01T04:00:00.000Z",
      reversal.body.reversal.id,
    );

    const rangePath =
      "/api/reports/range?startDate=2026-04-30&endDate=2026-05-01";
    const rangeResponse = await owner.get(rangePath);
    expect(rangeResponse.status).toBe(200);
    expect(rangeResponse.body.report).toMatchObject({
      businessDate: "2026-04-30 to 2026-05-01",
      startDate: "2026-04-30",
      endDate: "2026-05-01",
      reversalCount: 1,
      metrics: {
        grossSales: "112.00",
        cashSales: "112.00",
        qrSales: "112.00",
        qrRefunds: "112.00",
        netCashImpact: "112.00",
        estimatedGrossProfit: "60.00",
      },
    });
    const firstDay = await owner.get("/api/reports/daily?date=2026-04-30");
    const lastDay = await owner.get("/api/reports/daily?date=2026-05-01");
    expect(firstDay.body.report.metrics.grossSales).toBe("112.00");
    expect(lastDay.body.report.metrics.grossSales).toBe("0.00");
    expect(
      Number(firstDay.body.report.metrics.grossSales) +
        Number(lastDay.body.report.metrics.grossSales),
    ).toBe(Number(rangeResponse.body.report.metrics.grossSales));

    const csv = await owner.get(
      "/api/reports/range.csv?startDate=2026-04-30&endDate=2026-05-01",
    );
    expect(csv.status).toBe(200);
    expect(csv.headers["content-disposition"]).toContain(
      "medtryx-report-2026-04-30-to-2026-05-01.csv",
    );
    expect(csv.text).toContain(
      '"Report","Manila business dates","2026-04-30 to 2026-05-01"',
    );
    expect(csv.text).toContain('"Payments","Cash declared sales","112.00"');
    expect(csv.text).toContain('"Payments","QR refunds","112.00"');
  });

  it("rejects invalid business dates and report ranges", async () => {
    const owner = await signIn("owner.reports@example.test", ownerPassword);
    expect((await owner.get("/api/reports/daily?date=2026-02-30")).status).toBe(
      400,
    );
    expect(
      (
        await owner.get(
          "/api/reports/range?startDate=2026-04-31&endDate=2026-05-01",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await owner.get(
          "/api/reports/range?startDate=2026-05-02&endDate=2026-05-01",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await owner.get(
          "/api/reports/range.csv?startDate=2026-05-01&endDate=2026-05-01",
        )
      ).status,
    ).toBe(200);
  });
});
