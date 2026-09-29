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
  clearBundleLedgerForTest,
  clearLotLedgerForTest,
} from "./test-ledger.js";

process.env.APP_ENV = "test";
process.env.COOKIE_SECURE = "false";
process.env.CUSTOMER_ID_ENCRYPTION_KEY = "a7".repeat(32);

const ownerPassword = "SyntheticBundleOwner-42!";
const cashierPassword = "SyntheticBundleCashier-71!";
let dataDirectory: string;
let db: ReturnType<typeof openDatabase>;
let app: ReturnType<typeof createApp>;
let ownerId: string;
let cashierId: string;
let ownerHash: string;
let cashierHash: string;

type Agent = ReturnType<typeof request.agent>;

async function seed(): Promise<void> {
  clearBundleLedgerForTest(db);
  clearLotLedgerForTest(db);
  db.transaction(() => {
    db.exec(`DELETE FROM sale_reversal_lines;
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
      DELETE FROM users;`);
    const now = new Date().toISOString();
    ownerId = randomUUID();
    cashierId = randomUUID();
    db.prepare(
      "INSERT INTO users (id, email, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, 'owner', 1, ?, ?)",
    ).run(ownerId, "owner.bundles@example.test", ownerHash, now, now);
    db.prepare(
      "INSERT INTO users (id, email, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, 'cashier', 1, ?, ?)",
    ).run(cashierId, "cashier.bundles@example.test", cashierHash, now, now);
  })();
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

function todayInManila(): string {
  const fields = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    fields.map((field) => [field.type, field.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function manilaDayAfter(days: number): string {
  const date = new Date(`${todayInManila()}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function createProduct(
  owner: Agent,
  options: {
    sku: string;
    name: string;
    sellingPrice: string;
    taxClass?: "VATABLE" | "VAT_EXEMPT";
    isScEligible?: boolean;
    tracksLots?: boolean;
  },
) {
  const csrf = await csrfFor(owner);
  const response = await owner
    .post("/api/products")
    .set("x-csrf-token", csrf)
    .send({
      sku: options.sku,
      name: options.name,
      unit: "piece",
      sellingPrice: options.sellingPrice,
      taxClass: options.taxClass ?? "VATABLE",
      productType: "GENERIC",
      isScEligible: options.isScEligible ?? false,
      isPwdEligible: false,
      tracksLots: options.tracksLots ?? false,
      openingQuantity: 5,
      openingUnitCost: "3.00",
      ...(options.tracksLots
        ? {
            openingLotCode: `${options.sku}-LOT`,
            openingExpiryDate: `${todayInManila().slice(0, 4)}-12-31`,
          }
        : {}),
    });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.product as { id: string; quantityOnHand: number };
}

async function approveTax(owner: Agent) {
  const csrf = await csrfFor(owner);
  const response = await owner
    .post("/api/settings/tax-policy")
    .set("x-csrf-token", csrf)
    .send({
      confirmApproved: true,
      version: "SYNTHETIC-BUNDLE-TAX-V1",
      vatRateBasisPoints: 1_200,
      seniorDiscountBasisPoints: 2_000,
      pwdDiscountBasisPoints: 2_000,
      vatInclusivePrices: true,
      allowZeroRated: false,
      roundingMode: "HALF_UP",
      cashRoundingMode: "NONE",
      approvalReference: "Synthetic test-only approval record",
      costBasisDescription: "Synthetic weighted-average unit costs only",
    });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

async function createBundle(
  owner: Agent,
  productIds: string[],
  overrides: Record<string, unknown> = {},
) {
  const csrf = await csrfFor(owner);
  const response = await owner
    .post("/api/bundles")
    .set("x-csrf-token", csrf)
    .send({
      code: "SYN-RAIN",
      name: "Synthetic Rainy Season Bundle",
      activeFrom: todayInManila(),
      activeUntil: null,
      maxQuantityPerSale: 2,
      reductionType: "AMOUNT",
      reductionValue: 100,
      promotionalPrice: "29.02",
      confirmFinalPrice: true,
      components: productIds.map((productId) => ({ productId, quantity: 1 })),
      ...overrides,
    });
  return response;
}

async function openShift(cashier: Agent) {
  const csrf = await csrfFor(cashier);
  return cashier
    .post("/api/shifts")
    .set("x-csrf-token", csrf)
    .send({ openingCash: "100.00" });
}

beforeAll(async () => {
  dataDirectory = mkdtempSync(join(tmpdir(), "medtryx-bundles-test-"));
  db = openDatabase("test", dataDirectory);
  app = createApp(db);
  ownerHash = await argon2.hash(ownerPassword, { type: argon2.argon2id });
  cashierHash = await argon2.hash(cashierPassword, { type: argon2.argon2id });
});

beforeEach(async () => {
  await seed();
});
afterAll(() => {
  db.close();
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("virtual bundle offers", () => {
  it("creates owner-approved immutable versions and expands bundles with exact centavo allocation and non-stacked benefits", async () => {
    const owner = await signIn("owner.bundles@example.test", ownerPassword);
    await approveTax(owner);
    const seniorEligible = await createProduct(owner, {
      sku: "SYN-BND-001",
      name: "Synthetic tablet",
      sellingPrice: "10.01",
      taxClass: "VAT_EXEMPT",
      isScEligible: true,
    });
    const regularComponent = await createProduct(owner, {
      sku: "SYN-BND-002",
      name: "Synthetic umbrella",
      sellingPrice: "20.01",
      taxClass: "VATABLE",
    });
    const created = await createBundle(
      owner,
      [seniorEligible.id, regularComponent.id],
      { reductionValue: 100, promotionalPrice: "29.02" },
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.pricing).toEqual({
      regularTotal: "30.02",
      suggestedPromotionalPrice: "29.02",
      approvedPromotionalPrice: "29.02",
    });
    const bundle = created.body.bundle as {
      id: string;
      versionId: string;
      version: number;
    };
    expect(
      db
        .prepare(
          "SELECT action FROM audit_events WHERE entity_type = 'sales_bundle' AND entity_id = ?",
        )
        .all(bundle.id),
    ).toEqual([{ action: "sales_bundle.created" }]);
    const cashier = await signIn(
      "cashier.bundles@example.test",
      cashierPassword,
    );
    const shift = await openShift(cashier);
    expect(shift.status, JSON.stringify(shift.body)).toBe(201);
    const readOnlyOffer = await cashier.get("/api/bundles/active");
    expect(readOnlyOffer.status).toBe(200);
    expect(JSON.stringify(readOnlyOffer.body)).not.toMatch(
      /cogs|profit|acquisitioncost/i,
    );
    const cashierCsrf = await csrfFor(cashier);
    expect(
      (
        await cashier
          .post("/api/bundles")
          .set("x-csrf-token", cashierCsrf)
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (
        await cashier
          .patch(`/api/bundles/${bundle.id}`)
          .set("x-csrf-token", cashierCsrf)
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (
        await cashier
          .post(`/api/bundles/${bundle.id}/active`)
          .set("x-csrf-token", cashierCsrf)
          .send({ active: false })
      ).status,
    ).toBe(403);
    expect((await cashier.get("/api/bundles/manage")).status).toBe(403);

    const offer = {
      offerKey: randomUUID(),
      bundleVersionId: bundle.versionId,
      quantity: 2,
      components: [
        { productId: seniorEligible.id, benefitApplied: true },
        { productId: regularComponent.id, benefitApplied: false },
      ],
    };
    const previewCsrf = await csrfFor(cashier);
    const preview = await cashier
      .post("/api/sales/preview")
      .set("x-csrf-token", previewCsrf)
      .send({
        benefitType: "SENIOR_CITIZEN",
        paymentMethod: "QR",
        items: [],
        bundleOffers: [offer],
      });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(
      preview.body.lines.map(
        (line: { taxClass: string; vat: string; vatRemoved: string }) => ({
          taxClass: line.taxClass,
          vat: line.vat,
          vatRemoved: line.vatRemoved,
        }),
      ),
    ).toEqual([
      { taxClass: "VAT_EXEMPT", vat: "0.00", vatRemoved: "0.00" },
      { taxClass: "VATABLE", vat: "4.14", vatRemoved: "0.00" },
    ]);
    expect(preview.body.bundles[0]).toMatchObject({
      quantity: 2,
      regularTotal: "60.04",
      promotionalPricePerBundle: "29.02",
      promotionalDiscountOffered: "2.00",
      promotionalDiscountApplied: "1.34",
    });
    expect(
      preview.body.lines.map(
        (line: {
          bundle: {
            selectedStatutoryTreatment: string;
            allocatedPromotionDiscount: string;
            appliedPromotionDiscount: string;
          };
        }) => line.bundle,
      ),
    ).toEqual([
      expect.objectContaining({
        selectedStatutoryTreatment: "SENIOR_CITIZEN",
        allocatedPromotionDiscount: "0.66",
        appliedPromotionDiscount: "0.00",
      }),
      expect.objectContaining({
        selectedStatutoryTreatment: "REGULAR",
        allocatedPromotionDiscount: "1.34",
        appliedPromotionDiscount: "1.34",
      }),
    ]);

    const limitedCsrf = await csrfFor(cashier);
    const limited = await cashier
      .post("/api/sales/preview")
      .set("x-csrf-token", limitedCsrf)
      .send({
        benefitType: "REGULAR",
        items: [],
        bundleOffers: [
          {
            ...offer,
            quantity: 3,
            components: offer.components.map((component) => ({
              ...component,
              benefitApplied: false,
            })),
          },
        ],
      });
    expect(limited.status).toBe(409);
    expect(limited.body.error).toBe("bundle_sale_limit_exceeded");

    const crossCartLimitCsrf = await csrfFor(cashier);
    const crossCartLimit = await cashier
      .post("/api/sales/preview")
      .set("x-csrf-token", crossCartLimitCsrf)
      .send({
        benefitType: "REGULAR",
        items: [{ productId: seniorEligible.id, quantity: 4 }],
        bundleOffers: [
          {
            ...offer,
            components: offer.components.map((component) => ({
              ...component,
              benefitApplied: false,
            })),
          },
        ],
      });
    expect(crossCartLimit.status).toBe(409);
    expect(crossCartLimit.body.error).toBe("insufficient_stock");

    const saleCsrf = await csrfFor(cashier);
    const saleResponse = await cashier
      .post("/api/sales")
      .set("x-csrf-token", saleCsrf)
      .send({
        benefitType: "SENIOR_CITIZEN",
        paymentMethod: "QR",
        requestKey: randomUUID(),
        customerName: "Synthetic Customer",
        customerIdType: "Synthetic ID",
        customerIdNumber: "SYNTHETIC-ID-ONLY",
        customerIdChecked: true,
        items: [],
        bundleOffers: [offer],
      });
    expect(saleResponse.status, JSON.stringify(saleResponse.body)).toBe(201);
    expect(saleResponse.body.sale.lines).toHaveLength(2);
    expect(saleResponse.body.sale.lines[0]).toMatchObject({
      bundlePromotionDiscount: "0.00",
      bundle: {
        selectedStatutoryTreatment: "SENIOR_CITIZEN",
        allocatedPromotionDiscount: "0.66",
        appliedPromotionDiscount: "0.00",
      },
    });
    expect(saleResponse.body.sale.lines[1]).toMatchObject({
      bundlePromotionDiscount: "1.34",
      bundle: { selectedStatutoryTreatment: "REGULAR" },
    });
    expect(saleResponse.body.sale.lines[0]).not.toHaveProperty("cogs");
    const savedParent = db
      .prepare(
        "SELECT promotional_discount_offered_centavos, promotional_discount_applied_centavos FROM sale_bundle_snapshots",
      )
      .get() as {
      promotional_discount_offered_centavos: number;
      promotional_discount_applied_centavos: number;
    };
    expect(savedParent).toEqual({
      promotional_discount_offered_centavos: 200,
      promotional_discount_applied_centavos: 134,
    });
    const allocations = db
      .prepare(
        "SELECT product_id, promotional_discount_allocated_centavos, promotional_discount_applied_centavos, selected_statutory_treatment FROM sale_bundle_component_snapshots ORDER BY rowid",
      )
      .all();
    expect(allocations).toEqual([
      {
        product_id: seniorEligible.id,
        promotional_discount_allocated_centavos: 66,
        promotional_discount_applied_centavos: 0,
        selected_statutory_treatment: "SENIOR_CITIZEN",
      },
      {
        product_id: regularComponent.id,
        promotional_discount_allocated_centavos: 134,
        promotional_discount_applied_centavos: 134,
        selected_statutory_treatment: "REGULAR",
      },
    ]);

    const date = todayInManila();
    const report = await owner.get(
      `/api/reports/range?startDate=${date}&endDate=${date}`,
    );
    expect(report.status).toBe(200);
    expect(report.body.report.metrics.bundlePromotionalDiscounts).toBe("1.34");
    expect(report.body.report.metrics.seniorDiscounts).toBe("4.00");
    expect(report.body.report.bundlePromotions).toMatchObject([
      {
        code: "SYN-RAIN",
        version: 1,
        quantity: 2,
        promotionalDiscountOffered: "2.00",
        promotionalDiscountApplied: "1.34",
      },
    ]);
    const reportCsv = await owner.get(
      `/api/reports/range.csv?startDate=${date}&endDate=${date}`,
    );
    expect(reportCsv.status).toBe(200);
    expect(reportCsv.text).toContain(
      '"Discounts","Bundle promotional discounts (net of reversals)","1.34"',
    );
    expect(reportCsv.text).toContain('"Bundle offer","SYN-RAIN');

    const saleLines = saleResponse.body.sale.lines as Array<{
      saleLineId: string;
    }>;
    const reversalCsrf = await csrfFor(owner);
    const reversal = await owner
      .post(`/api/sales/${saleResponse.body.sale.transactionId}/reversals`)
      .set("x-csrf-token", reversalCsrf)
      .send({
        ownerPassword,
        reason: "Synthetic bundle sale reversal",
        refundMethod: "QR",
        lines: saleLines.map((line) => ({
          saleLineId: line.saleLineId,
          restock: true,
        })),
      });
    expect(reversal.status, JSON.stringify(reversal.body)).toBe(201);
    const reversedReport = await owner.get(
      `/api/reports/range?startDate=${date}&endDate=${date}`,
    );
    expect(reversedReport.body.report.metrics.bundlePromotionalDiscounts).toBe(
      "0.00",
    );

    const editCsrf = await csrfFor(owner);
    const nextVersion = await owner
      .patch(`/api/bundles/${bundle.id}`)
      .set("x-csrf-token", editCsrf)
      .send({
        code: "SYN-RAIN",
        name: "Synthetic Rainy Season Bundle Revised",
        activeFrom: todayInManila(),
        activeUntil: null,
        maxQuantityPerSale: 2,
        reductionType: "AMOUNT",
        reductionValue: 200,
        promotionalPrice: "28.02",
        confirmFinalPrice: true,
        components: [
          { productId: seniorEligible.id, quantity: 1 },
          { productId: regularComponent.id, quantity: 1 },
        ],
      });
    expect(nextVersion.status, JSON.stringify(nextVersion.body)).toBe(200);
    expect(nextVersion.body.bundle.version).toBe(2);
    const historical = await owner.get(
      `/api/sales/${saleResponse.body.sale.transactionId}`,
    );
    expect(historical.body.sale.lines[0].bundle).toMatchObject({
      name: "Synthetic Rainy Season Bundle",
      version: 1,
    });
    const staleCsrf = await csrfFor(cashier);
    const stale = await cashier
      .post("/api/sales/preview")
      .set("x-csrf-token", staleCsrf)
      .send({
        benefitType: "REGULAR",
        items: [],
        bundleOffers: [offer],
      });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("bundle_offer_unavailable");
  });

  it("rejects stale, inactive, expired, or tampered offers and reserves tracked component lots", async () => {
    const owner = await signIn("owner.bundles@example.test", ownerPassword);
    await approveTax(owner);
    const tracked = await createProduct(owner, {
      sku: "SYN-BND-LOT",
      name: "Synthetic tracked tablet",
      sellingPrice: "5.00",
      tracksLots: true,
    });
    const other = await createProduct(owner, {
      sku: "SYN-BND-REG",
      name: "Synthetic untracked item",
      sellingPrice: "5.00",
    });
    const created = await createBundle(owner, [tracked.id, other.id], {
      promotionalPrice: "9.00",
      maxQuantityPerSale: null,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const versionId = created.body.bundle.versionId as string;
    const expiredOffer = await createBundle(owner, [tracked.id, other.id], {
      code: "SYN-EXPIRED",
      activeFrom: manilaDayAfter(-3),
      activeUntil: manilaDayAfter(-1),
      promotionalPrice: "9.00",
      maxQuantityPerSale: null,
    });
    expect(expiredOffer.status).toBe(201);
    const futureOffer = await createBundle(owner, [tracked.id, other.id], {
      code: "SYN-FUTURE",
      activeFrom: manilaDayAfter(1),
      activeUntil: null,
      promotionalPrice: "9.00",
      maxQuantityPerSale: null,
    });
    expect(futureOffer.status).toBe(201);
    const cashier = await signIn(
      "cashier.bundles@example.test",
      cashierPassword,
    );
    const openedShift = await openShift(cashier);
    expect(openedShift.status, JSON.stringify(openedShift.body)).toBe(201);
    const key = randomUUID();
    const requestBody = {
      benefitType: "REGULAR",
      paymentMethod: "QR",
      requestKey: key,
      items: [],
      bundleOffers: [
        {
          offerKey: randomUUID(),
          bundleVersionId: versionId,
          quantity: 1,
          components: [{ productId: tracked.id }, { productId: other.id }],
        },
      ],
    };
    const previewCsrf = await csrfFor(cashier);
    const preview = await cashier
      .post("/api/sales/preview")
      .set("x-csrf-token", previewCsrf)
      .send({ ...requestBody, requestKey: undefined });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.lines[0].assignedLots[0].lotCode).toBe(
      "SYN-BND-LOT-LOT",
    );
    for (const outOfPeriod of [expiredOffer, futureOffer]) {
      const dateCsrf = await csrfFor(cashier);
      const dateRejected = await cashier
        .post("/api/sales/preview")
        .set("x-csrf-token", dateCsrf)
        .send({
          benefitType: "REGULAR",
          items: [],
          bundleOffers: [
            {
              ...requestBody.bundleOffers[0],
              bundleVersionId: outOfPeriod.body.bundle.versionId,
            },
          ],
        });
      expect(dateRejected.status).toBe(409);
      expect(dateRejected.body.error).toBe(
        "bundle_offer_outside_active_period",
      );
    }
    const shortageCsrf = await csrfFor(cashier);
    const shortage = await cashier
      .post("/api/sales/preview")
      .set("x-csrf-token", shortageCsrf)
      .send({
        benefitType: "REGULAR",
        items: [],
        bundleOffers: [{ ...requestBody.bundleOffers[0], quantity: 6 }],
      });
    expect(shortage.status).toBe(409);
    expect(shortage.body.error).toBe("insufficient_saleable_lot_stock");
    const wrongMappingCsrf = await csrfFor(cashier);
    const wrongMapping = await cashier
      .post("/api/sales/preview")
      .set("x-csrf-token", wrongMappingCsrf)
      .send({
        benefitType: "REGULAR",
        items: [],
        bundleOffers: [
          {
            ...requestBody.bundleOffers[0],
            components: [
              { productId: tracked.id },
              { productId: randomUUID() },
            ],
          },
        ],
      });
    expect(wrongMapping.status).toBe(400);
    expect(wrongMapping.body.error).toBe("bundle_component_mapping_changed");
    const pickedLots = preview.body.lines[0].assignedLots.map(
      (lot: { lotId: string; quantity: number }) => ({
        lotId: lot.lotId,
        quantity: lot.quantity,
      }),
    );
    const noPickCsrf = await csrfFor(cashier);
    const noPick = await cashier
      .post("/api/sales")
      .set("x-csrf-token", noPickCsrf)
      .send({
        ...requestBody,
        bundleOffers: [
          {
            ...requestBody.bundleOffers[0],
            components: [
              {
                productId: tracked.id,
                lotAllocations: pickedLots,
                lotPickConfirmed: false,
              },
              { productId: other.id },
            ],
          },
        ],
      });
    expect(noPick.status).toBe(409);
    expect(noPick.body.error).toBe("lot_pick_confirmation_required");
    const saleCsrf = await csrfFor(cashier);
    const sale = await cashier
      .post("/api/sales")
      .set("x-csrf-token", saleCsrf)
      .send({
        ...requestBody,
        bundleOffers: [
          {
            ...requestBody.bundleOffers[0],
            components: [
              {
                productId: tracked.id,
                lotAllocations: pickedLots,
                lotPickConfirmed: true,
              },
              { productId: other.id },
            ],
          },
        ],
      });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(
      sale.body.sale.lines.find(
        (line: { productId: string }) => line.productId === tracked.id,
      ).lotAllocations,
    ).toHaveLength(1);

    const reversalCsrf = await csrfFor(owner);
    const reversal = await owner
      .post(`/api/sales/${sale.body.sale.transactionId}/reversals`)
      .set("x-csrf-token", reversalCsrf)
      .send({
        ownerPassword,
        reason: "Synthetic tracked bundle component restock",
        refundMethod: "QR",
        lines: sale.body.sale.lines.map((line: { saleLineId: string }) => ({
          saleLineId: line.saleLineId,
          restock: true,
          lotPickVerified: true,
        })),
      });
    expect(reversal.status, JSON.stringify(reversal.body)).toBe(201);
    const lotBalance = db
      .prepare(
        `SELECT sum(m.quantity_delta) AS quantity
         FROM lot_stock_movements m
         JOIN inventory_lots l ON l.id = m.lot_id
         WHERE l.product_id = ?`,
      )
      .get(tracked.id) as { quantity: number };
    expect(lotBalance.quantity).toBe(5);

    const ownerCsrf = await csrfFor(owner);
    const inactive = await owner
      .post(`/api/bundles/${created.body.bundle.id}/active`)
      .set("x-csrf-token", ownerCsrf)
      .send({ active: false });
    expect(inactive.status).toBe(200);
    const staleCsrf = await csrfFor(cashier);
    const stale = await cashier
      .post("/api/sales/preview")
      .set("x-csrf-token", staleCsrf)
      .send({
        benefitType: "REGULAR",
        items: [],
        bundleOffers: requestBody.bundleOffers,
      });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("bundle_offer_unavailable");
  });
});
