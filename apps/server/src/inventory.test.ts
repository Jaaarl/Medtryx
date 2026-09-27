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

const ownerPassword = "SyntheticInventoryOwner-45!";
const cashierPassword = "SyntheticInventoryCashier-78!";
let dataDirectory: string;
let db: ReturnType<typeof openDatabase>;
let app: ReturnType<typeof createApp>;
let ownerId: string;
let cashierId: string;
let ownerHash: string;
let cashierHash: string;
let activeProductId: string;

async function seedUsers(): Promise<void> {
  db.exec(
    "DELETE FROM audit_events; DELETE FROM stock_events; DELETE FROM sessions; DELETE FROM products; DELETE FROM product_sku_sequence; DELETE FROM users;",
  );
  const now = new Date().toISOString();
  ownerId = randomUUID();
  cashierId = randomUUID();
  db.prepare(
    "INSERT INTO users (id, email, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, 'owner', 1, ?, ?)",
  ).run(ownerId, "owner.inventory@example.test", ownerHash, now, now);
  db.prepare(
    "INSERT INTO users (id, email, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, 'cashier', 1, ?, ?)",
  ).run(cashierId, "cashier.inventory@example.test", cashierHash, now, now);
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

async function csrfFor(
  agent: ReturnType<typeof request.agent>,
): Promise<string> {
  return (await agent.get("/api/auth/csrf")).body.token as string;
}

async function createOpeningProduct(
  owner: ReturnType<typeof request.agent>,
  values: Record<string, unknown> = {},
) {
  const token = await csrfFor(owner);
  return owner
    .post("/api/products")
    .set("x-csrf-token", token)
    .send({
      sku: "SYN-PARA-001",
      name: "Synthetic Paracetamol Tablet",
      barcode: "SYN-BC-001",
      unit: "tablet",
      sellingPrice: "70.00",
      taxClass: "VATABLE",
      scPwdEligible: true,
      openingQuantity: 10,
      openingUnitCost: "40.00",
      reorderLevel: 3,
      ...values,
    });
}

beforeAll(async () => {
  dataDirectory = mkdtempSync(join(tmpdir(), "medtryx-stock-test-"));
  db = openDatabase("test", dataDirectory);
  app = createApp(db);
  ownerHash = await argon2.hash(ownerPassword, { type: argon2.argon2id });
  cashierHash = await argon2.hash(cashierPassword, { type: argon2.argon2id });
});

beforeEach(async () => {
  await seedUsers();
  activeProductId = "";
});

afterAll(() => {
  db.close();
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("owner catalog and stock operations", () => {
  it("creates opening inventory with a unique SKU and records exact centavo value", async () => {
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const created = await createOpeningProduct(owner);
    expect(created.status).toBe(201);
    expect(created.body.product.sku).toBe("SYN-PARA-001");
    expect(created.body.product.sellingPrice).toBe("70.00");
    expect(created.body.product.quantityOnHand).toBe(10);
    expect(created.body.product.latestAcquisitionCost).toBe("40.00");
    expect(created.body.product.weightedAverageUnitCost).toBe("40.00");
    expect(created.body.product.inventoryValue).toBe("400.00");
    expect(created.body.product.estimatedUnitGrossProfit).toBe("22.50");
    expect(created.body.product.grossProfitEstimateApproved).toBe(false);
    expect(
      db
        .prepare(
          "SELECT event_type, quantity_delta, unit_cost_centavos, inventory_value_delta_centavos FROM stock_events",
        )
        .get() as {
        event_type: string;
        quantity_delta: number;
        unit_cost_centavos: number;
        inventory_value_delta_centavos: number;
      },
    ).toEqual({
      event_type: "OPENING",
      quantity_delta: 10,
      unit_cost_centavos: 4_000,
      inventory_value_delta_centavos: 40_000,
    });
  });

  it("uses an approved tax and acquisition-cost policy for owner gross-profit estimates", async () => {
    db.prepare(
      "INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES ('tax', ?, ?, ?)",
    ).run(
      JSON.stringify({
        approved: true,
        version: "SYNTHETIC-GROSS-PROFIT-POLICY",
        vatRateBasisPoints: 1_200,
        seniorDiscountBasisPoints: 2_000,
        pwdDiscountBasisPoints: 2_000,
        vatInclusivePrices: true,
        allowZeroRated: false,
        roundingMode: "HALF_UP",
        approvalReference: "Synthetic test policy only",
        costBasisDescription:
          "Synthetic moving weighted-average acquisition cost",
        approvedAt: new Date().toISOString(),
        approvedBy: ownerId,
      }),
      new Date().toISOString(),
      ownerId,
    );
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const created = await createOpeningProduct(owner, {
      sellingPrice: "112.00",
      openingUnitCost: "40.00",
    });

    expect(created.status).toBe(201);
    expect(created.body.product.estimatedUnitGrossProfit).toBe("60.00");
    expect(created.body.product.grossProfitEstimateApproved).toBe(true);
    expect(created.body.product.grossProfitEstimateNote).toContain(
      "SYNTHETIC-GROSS-PROFIT-POLICY",
    );
  });

  it("rejects a zero selling price before it reaches the database constraint", async () => {
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const response = await createOpeningProduct(owner, {
      sellingPrice: "0.00",
      openingQuantity: 0,
      openingUnitCost: undefined,
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_request");
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM products").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
  });

  it("moves weighted-average acquisition cost on receipts without changing the SKU selling price", async () => {
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const created = await createOpeningProduct(owner);
    activeProductId = created.body.product.id as string;
    const token = await csrfFor(owner);
    const receipt = await owner
      .post("/api/stock/receipts")
      .set("x-csrf-token", token)
      .send({
        productId: activeProductId,
        quantity: 10,
        unitCost: "50.00",
        reference: "SYN-DELIVERY-01",
      });
    expect(receipt.status).toBe(201);
    expect(receipt.body.product.sellingPrice).toBe("70.00");
    expect(receipt.body.product.quantityOnHand).toBe(20);
    expect(receipt.body.product.latestAcquisitionCost).toBe("50.00");
    expect(receipt.body.product.weightedAverageUnitCost).toBe("45.00");
    expect(receipt.body.product.unitPriceSpread).toBe("25.00");
    expect(receipt.body.product.inventoryValue).toBe("900.00");

    const secondRead = await owner.get("/api/products");
    expect(secondRead.body.products[0].sellingPrice).toBe("70.00");
    const events = await owner.get(
      `/api/stock/events?productId=${activeProductId}`,
    );
    expect(
      events.body.events.map((event: { type: string }) => event.type),
    ).toEqual(["RECEIPT", "OPENING"]);
    expect(events.body.events[0].unitCost).toBe("50.00");
  });

  it("rejects zero-cost stock without a reason, and permits it when a reason is recorded", async () => {
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const created = await createOpeningProduct(owner, {
      openingQuantity: 0,
      openingUnitCost: undefined,
    });
    activeProductId = created.body.product.id as string;
    const token = await csrfFor(owner);
    const rejected = await owner
      .post("/api/stock/receipts")
      .set("x-csrf-token", token)
      .send({ productId: activeProductId, quantity: 1, unitCost: "0.00" });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe("invalid_request");
    expect(
      (await owner.get("/api/products")).body.products[0].quantityOnHand,
    ).toBe(0);

    const newToken = await csrfFor(owner);
    const accepted = await owner
      .post("/api/stock/receipts")
      .set("x-csrf-token", newToken)
      .send({
        productId: activeProductId,
        quantity: 1,
        unitCost: "0.00",
        zeroCostReason: "Synthetic supplier replacement at no charge",
      });
    expect(accepted.status).toBe(201);
    expect(accepted.body.product.quantityOnHand).toBe(1);
    expect(accepted.body.product.inventoryValue).toBe("0.00");
  });

  it("records count adjustments and damage/expiry write-offs at the current moving average", async () => {
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const created = await createOpeningProduct(owner);
    activeProductId = created.body.product.id as string;
    const receiptToken = await csrfFor(owner);
    await owner
      .post("/api/stock/receipts")
      .set("x-csrf-token", receiptToken)
      .send({ productId: activeProductId, quantity: 10, unitCost: "50.00" });

    const correctionToken = await csrfFor(owner);
    const correction = await owner
      .post("/api/stock/adjustments")
      .set("x-csrf-token", correctionToken)
      .send({
        productId: activeProductId,
        quantityDelta: -2,
        reasonType: "COUNT_CORRECTION",
        reason: "Physical count found two fewer units",
      });
    expect(correction.status).toBe(201);
    expect(correction.body.product.quantityOnHand).toBe(18);
    expect(correction.body.product.inventoryValue).toBe("810.00");

    const writeOffToken = await csrfFor(owner);
    const writeOff = await owner
      .post("/api/stock/adjustments")
      .set("x-csrf-token", writeOffToken)
      .send({
        productId: activeProductId,
        quantityDelta: -1,
        reasonType: "EXPIRY",
        reason: "Synthetic damaged unit removed from the shelf",
      });
    expect(writeOff.status).toBe(201);
    expect(writeOff.body.product.quantityOnHand).toBe(17);
    expect(writeOff.body.product.inventoryValue).toBe("765.00");
    const events = await owner.get(
      `/api/stock/events?productId=${activeProductId}`,
    );
    expect(events.body.events[0].type).toBe("WRITE_OFF");
    expect(events.body.events[0].inventoryValueDelta).toBe("-45.00");
    expect(events.body.events[1].type).toBe("ADJUSTMENT");
    expect(events.body.events[1].inventoryValueDelta).toBe("-90.00");
  });

  it("blocks negative stock and keeps quantity and value unchanged after a rejected adjustment", async () => {
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const created = await createOpeningProduct(owner);
    activeProductId = created.body.product.id as string;
    const token = await csrfFor(owner);
    const response = await owner
      .post("/api/stock/adjustments")
      .set("x-csrf-token", token)
      .send({
        productId: activeProductId,
        quantityDelta: -11,
        reasonType: "COUNT_CORRECTION",
        reason: "Synthetic over-count correction attempt",
      });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("insufficient_stock");
    expect((await owner.get("/api/products")).body.products[0]).toMatchObject({
      quantityOnHand: 10,
      inventoryValue: "400.00",
    });
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM stock_events").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
  });

  it("keeps cost and profit fields out of cashier product search and rejects owner writes", async () => {
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const created = await createOpeningProduct(owner);
    activeProductId = created.body.product.id as string;
    const ownerToken = await csrfFor(owner);
    await owner
      .patch(`/api/products/${activeProductId}`)
      .set("x-csrf-token", ownerToken)
      .send({ active: false });

    const cashier = await signIn(
      "cashier.inventory@example.test",
      cashierPassword,
    );
    expect((await cashier.get("/api/products")).status).toBe(403);
    expect((await cashier.get("/api/stock")).status).toBe(403);
    const deniedWrite = await cashier
      .post("/api/products")
      .send({ name: "Synthetic prohibited product" });
    expect(deniedWrite.status).toBe(403);
    const activeCatalog = await cashier.get("/api/catalog");
    expect(activeCatalog.status).toBe(200);
    expect(activeCatalog.body.products).toEqual([]);

    const reactivationToken = await csrfFor(owner);
    await owner
      .patch(`/api/products/${activeProductId}`)
      .set("x-csrf-token", reactivationToken)
      .send({ active: true });
    const result = await cashier.get("/api/catalog?q=SYN-PARA");
    expect(result.body.products).toHaveLength(1);
    expect(result.body.products[0]).toMatchObject({
      id: activeProductId,
      sellingPrice: "70.00",
      quantityAvailable: 10,
    });
    expect(result.body.products[0]).not.toHaveProperty(
      "weightedAverageUnitCost",
    );
    expect(result.body.products[0]).not.toHaveProperty("latestAcquisitionCost");
    expect(result.body.products[0]).not.toHaveProperty("inventoryValue");
  });

  it("keeps units fixed after stock history, blocks unapproved zero-rated items, and lists low stock", async () => {
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const created = await createOpeningProduct(owner);
    activeProductId = created.body.product.id as string;
    const token = await csrfFor(owner);
    const unitChange = await owner
      .patch(`/api/products/${activeProductId}`)
      .set("x-csrf-token", token)
      .send({ unit: "box" });
    expect(unitChange.status).toBe(409);
    expect(unitChange.body.error).toBe("unit_locked_after_stock_history");

    const zeroRated = await createOpeningProduct(owner, {
      sku: "SYN-ZERO-001",
      barcode: "SYN-BC-002",
      taxClass: "ZERO_RATED",
    });
    expect(zeroRated.status).toBe(400);
    expect(zeroRated.body.error).toBe("zero_rated_not_approved");

    const newLowStock = await createOpeningProduct(owner, {
      sku: "SYN-LOW-001",
      barcode: "SYN-BC-003",
      openingQuantity: 1,
      reorderLevel: 2,
    });
    expect(newLowStock.status).toBe(201);
    const lowStock = await owner.get("/api/stock?lowStock=true");
    expect(lowStock.body.lowStockCount).toBe(1);
    expect(lowStock.body.products[0].sku).toBe("SYN-LOW-001");
  });

  it("generates non-reused SKU values and rejects duplicate SKU and barcode values", async () => {
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const generated = await createOpeningProduct(owner, {
      sku: undefined,
      barcode: "SYN-AUTO-001",
      openingQuantity: 0,
      openingUnitCost: undefined,
    });
    expect(generated.status).toBe(201);
    expect(generated.body.generatedSku).toBe(true);
    expect(generated.body.sku).toMatch(/^MTX-\d{6}$/);
    const duplicateSku = await createOpeningProduct(owner, {
      sku: generated.body.sku as string,
      name: "Another synthetic product",
      barcode: "SYN-AUTO-002",
      openingQuantity: 0,
      openingUnitCost: undefined,
    });
    expect(duplicateSku.status).toBe(409);
    expect(duplicateSku.body.error).toBe("sku_already_exists");
    const duplicateBarcode = await createOpeningProduct(owner, {
      sku: "SYN-PARA-002",
      name: "Another synthetic product",
      barcode: "SYN-AUTO-001",
      openingQuantity: 0,
      openingUnitCost: undefined,
    });
    expect(duplicateBarcode.status).toBe(409);
    expect(duplicateBarcode.body.error).toBe("barcode_already_exists");
  });
});
