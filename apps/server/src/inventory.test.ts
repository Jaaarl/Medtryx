import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { openDatabase } from "./db.js";
import { clearLotLedgerForTest } from "./test-ledger.js";

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
  clearLotLedgerForTest(db);
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
      productType: "BRANDED",
      isScEligible: true,
      isPwdEligible: true,
      openingQuantity: 10,
      openingUnitCost: "40.00",
      reorderLevel: 3,
      ...values,
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
  it("imports new products with opening lot stock and validates the full CSV before saving", async () => {
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const headers =
      "sku,name,unit,sellingPrice,taxClass,productType,tracksLots,openingQuantity,openingUnitCost,openingLotCode,openingExpiryDate,bnpcEligible,bnpcCategory";
    const validRow = `SYN-CSV-NEW-001,\"Synthetic, CSV medicine\",tablet,70.00,VATABLE,BRANDED,TRUE,12,40.00,SYN-CSV-LOT-01,${manilaDayAfter(30)},TRUE,`;
    const importToken = await csrfFor(owner);
    const imported = await owner
      .post("/api/products/import-csv")
      .set("Content-Type", "text/csv")
      .set("x-csrf-token", importToken)
      .send(`${headers}\n${validRow}\n`);
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    expect(imported.body).toMatchObject({
      createdCount: 1,
      products: [{ sku: "SYN-CSV-NEW-001" }],
    });

    const products = await owner.get("/api/products?q=SYN-CSV-NEW-001");
    expect(products.body.products[0]).toMatchObject({
      sku: "SYN-CSV-NEW-001",
      name: "Synthetic, CSV medicine",
      tracksLots: true,
      isBnpcEligible: true,
      bnpcCategory: null,
      quantityOnHand: 12,
      saleableQuantity: 12,
      weightedAverageUnitCost: "40.00",
    });
    const lots = await owner.get("/api/stock/lots");
    expect(lots.body.lots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sku: "SYN-CSV-NEW-001",
          lotCode: "SYN-CSV-LOT-01",
          expiryDate: manilaDayAfter(30),
          quantity: 12,
        }),
      ]),
    );

    const invalidToken = await csrfFor(owner);
    const invalidBatch = await owner
      .post("/api/products/import-csv")
      .set("Content-Type", "text/csv")
      .set("x-csrf-token", invalidToken)
      .send(
        `${headers}\n${`SYN-CSV-NEW-002,Valid row,tablet,50.00,VATABLE,GENERIC,TRUE,3,20.00,SYN-CSV-LOT-02,${manilaDayAfter(30)},FALSE,`}\n${`SYN-CSV-NEW-003,Expired row,tablet,50.00,VATABLE,GENERIC,TRUE,3,20.00,SYN-CSV-LOT-03,${manilaDayAfter(-1)},FALSE,`}`,
      );
    expect(invalidBatch.status).toBe(400);
    expect(invalidBatch.body.error).toBe("csv_import_invalid");
    expect(invalidBatch.body.rowErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ row: 3 })]),
    );

    const missingPriceToken = await csrfFor(owner);
    const missingPriceBatch = await owner
      .post("/api/products/import-csv")
      .set("Content-Type", "text/csv")
      .set("x-csrf-token", missingPriceToken)
      .send(
        `${headers}\nSYN-CSV-NEW-004,Missing price,tablet,,VATABLE,GENERIC,TRUE,3,20.00,SYN-CSV-LOT-04,${manilaDayAfter(30)},FALSE,`,
      );
    expect(
      missingPriceBatch.status,
      JSON.stringify(missingPriceBatch.body),
    ).toBe(400);
    expect(missingPriceBatch.body.error).toBe("csv_import_invalid");
    expect(missingPriceBatch.body.rowErrors).toEqual([
      expect.objectContaining({
        row: 2,
        message: expect.stringContaining("sellingPrice:"),
      }),
    ]);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM products WHERE sku LIKE 'SYN-CSV-NEW-%'",
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it("allows an eligible product to have a null BNPC category", async () => {
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const created = await createOpeningProduct(owner, {
      sku: "SYN-BNPC-NULL-CATEGORY",
      bnpcEligible: true,
      bnpcCategory: null,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.product).toMatchObject({
      isBnpcEligible: true,
      bnpcCategory: null,
    });

    const classifyToken = await csrfFor(owner);
    const classified = await owner
      .patch(`/api/products/${created.body.product.id as string}`)
      .set("x-csrf-token", classifyToken)
      .send({ bnpcEligible: true, bnpcCategory: "BASIC_NECESSITY" });
    expect(classified.status, JSON.stringify(classified.body)).toBe(200);
    expect(classified.body.product.bnpcCategory).toBe("BASIC_NECESSITY");

    const clearToken = await csrfFor(owner);
    const cleared = await owner
      .patch(`/api/products/${created.body.product.id as string}`)
      .set("x-csrf-token", clearToken)
      .send({ bnpcEligible: true, bnpcCategory: null });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.product).toMatchObject({
      isBnpcEligible: true,
      bnpcCategory: null,
    });
    expect(
      db
        .prepare(
          "SELECT bnpc_eligible, bnpc_category FROM products WHERE id = ?",
        )
        .get(created.body.product.id as string),
    ).toEqual({ bnpc_eligible: 1, bnpc_category: null });
  });

  it("exports a formula-safe CSV for editing existing product records", async () => {
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const created = await createOpeningProduct(owner, {
      sku: "SYN-CSV-EXPORT",
      name: "=Synthetic Formula Product",
    });
    expect(created.status).toBe(201);

    const exported = await owner.get("/api/products/export-csv");
    expect(exported.status).toBe(200);
    expect(exported.headers["content-type"]).toContain("text/csv");
    expect(exported.headers["content-disposition"]).toContain(
      'filename="products.csv"',
    );
    expect(exported.text).toContain("quantityonhand");
    expect(exported.text).toContain("weightedaverageunitcost");
    expect(exported.text).toContain("estimatedunitgrossprofit");
    expect(exported.text).toContain("'=Synthetic Formula Product");

    const token = await csrfFor(owner);
    const roundTrip = await owner
      .post("/api/products/update-csv")
      .set("Content-Type", "text/csv")
      .set("x-csrf-token", token)
      .send(exported.text);
    expect(roundTrip.status, JSON.stringify(roundTrip.body)).toBe(200);
    const product = await owner.get("/api/products?q=SYN-CSV-EXPORT");
    expect(product.body.products[0].name).toBe("=Synthetic Formula Product");

    const cashier = await signIn(
      "cashier.inventory@example.test",
      cashierPassword,
    );
    expect((await cashier.get("/api/products/export-csv")).status).toBe(403);
  });

  it("updates existing products from the exported CSV without changing stock history", async () => {
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const created = await createOpeningProduct(owner, {
      sku: "SYN-CSV-UPDATE",
    });
    expect(created.status).toBe(201);

    const exported = await owner.get("/api/products/export-csv");
    const csvLines = exported.text.trim().split(/\r?\n/u);
    const productLine = csvLines.find((line) =>
      line.startsWith('"SYN-CSV-UPDATE"'),
    );
    expect(productLine).toBeDefined();
    if (!productLine) throw new Error("Exported product row was not found.");
    const editedProductLine = productLine
      .replace(
        '"Synthetic Paracetamol Tablet"',
        '"Updated, ""Synthetic"" Product"',
      )
      .replace('"70.00"', '"75.50"')
      .replace('"BRANDED"', '"GENERIC"')
      .replace(',"true","true","false",', ',"false","true","false",');
    const token = await csrfFor(owner);
    const updated = await owner
      .post("/api/products/update-csv")
      .set("Content-Type", "text/csv")
      .set("x-csrf-token", token)
      .send(`${csvLines[0]}\r\n${editedProductLine}`);
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toMatchObject({
      updatedCount: 1,
      products: [{ sku: "SYN-CSV-UPDATE" }],
    });

    const product = await owner.get("/api/products?q=SYN-CSV-UPDATE");
    expect(product.body.products[0]).toMatchObject({
      name: 'Updated, "Synthetic" Product',
      sellingPrice: "75.50",
      productType: "GENERIC",
      isScEligible: false,
      isPwdEligible: true,
      quantityOnHand: 10,
      saleableQuantity: 10,
      latestAcquisitionCost: "40.00",
      inventoryValue: "400.00",
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM stock_events").get(),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          "SELECT action FROM audit_events WHERE entity_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(created.body.product.id as string),
    ).toEqual({ action: "product.updated" });
  });

  it("updates only the fields present in a partial product CSV", async () => {
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const created = await createOpeningProduct(owner, {
      sku: "SYN-CSV-PARTIAL",
    });
    expect(created.status).toBe(201);

    const token = await csrfFor(owner);
    const updated = await owner
      .post("/api/products/update-csv")
      .set("Content-Type", "text/csv")
      .set("x-csrf-token", token)
      .send("sku,description\nSYN-CSV-PARTIAL,Updated from a partial CSV");
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.updatedCount).toBe(1);

    const product = await owner.get("/api/products?q=SYN-CSV-PARTIAL");
    expect(product.body.products[0]).toMatchObject({
      name: "Updated from a partial CSV",
      sellingPrice: "70.00",
      productType: "BRANDED",
      quantityOnHand: 10,
      latestAcquisitionCost: "40.00",
      inventoryValue: "400.00",
    });
  });

  it("accepts a product CSV with only the SKU column", async () => {
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const created = await createOpeningProduct(owner, {
      sku: "SYN-CSV-SKU-ONLY",
    });
    expect(created.status).toBe(201);

    const token = await csrfFor(owner);
    const updated = await owner
      .post("/api/products/update-csv")
      .set("Content-Type", "text/csv")
      .set("x-csrf-token", token)
      .send("sku\nSYN-CSV-SKU-ONLY");
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.updatedCount).toBe(1);

    const product = await owner.get("/api/products?q=SYN-CSV-SKU-ONLY");
    expect(product.body.products[0].name).toBe("Synthetic Paracetamol Tablet");
  });

  it("validates every product update row before saving any changes", async () => {
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const created = await createOpeningProduct(owner, {
      sku: "SYN-CSV-ATOMIC",
    });
    expect(created.status).toBe(201);
    const exported = await owner.get("/api/products/export-csv");
    const csvLines = exported.text.trim().split(/\r?\n/u);
    const productLine = csvLines.find((line) =>
      line.startsWith('"SYN-CSV-ATOMIC"'),
    );
    expect(productLine).toBeDefined();
    if (!productLine) throw new Error("Exported product row was not found.");
    const wouldUpdate = productLine.replace(
      '"Synthetic Paracetamol Tablet"',
      '"Should Not Be Saved"',
    );
    const missingSku = productLine.replace(
      '"SYN-CSV-ATOMIC"',
      '"SYN-CSV-MISSING"',
    );
    const token = await csrfFor(owner);
    const rejected = await owner
      .post("/api/products/update-csv")
      .set("Content-Type", "text/csv")
      .set("x-csrf-token", token)
      .send(`${csvLines[0]}\r\n${wouldUpdate}\r\n${missingSku}`);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe("csv_import_invalid");
    expect(rejected.body.rowErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "SKU does not exist." }),
      ]),
    );
    const product = await owner.get("/api/products?q=SYN-CSV-ATOMIC");
    expect(product.body.products[0].name).toBe("Synthetic Paracetamol Tablet");
    expect(product.body.products[0].sellingPrice).toBe("70.00");
  });

  it("imports receipts for existing products and preserves lot, cost, and atomicity", async () => {
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const tracked = await createOpeningProduct(owner, {
      sku: "SYN-CSV-RECEIPT-LOT",
      barcode: "SYN-CSV-RECEIPT-LOT-BC",
      tracksLots: true,
      openingLotCode: "SYN-CSV-OPENING-LOT",
      openingExpiryDate: manilaDayAfter(60),
    });
    const regular = await createOpeningProduct(owner, {
      sku: "SYN-CSV-RECEIPT-REGULAR",
      barcode: "SYN-CSV-RECEIPT-REG-BC",
      tracksLots: false,
    });
    expect(tracked.status).toBe(201);
    expect(regular.status).toBe(201);

    const headers =
      "sku,quantity,unitCost,reference,supplier,lotCode,expiryDate,zeroCostReason";
    const csv = [
      headers,
      `SYN-CSV-RECEIPT-LOT,4,45.00,SYN-CSV-PO-01,Synthetic supplier,SYN-CSV-LOT-A,${manilaDayAfter(90)},`,
      "SYN-CSV-RECEIPT-REGULAR,2,12.00,SYN-CSV-PO-02,Synthetic supplier,,,",
    ].join("\n");
    const token = await csrfFor(owner);
    const imported = await owner
      .post("/api/stock/receipts/import-csv")
      .set("Content-Type", "text/csv")
      .set("x-csrf-token", token)
      .send(csv);
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    expect(imported.body).toEqual({ importedCount: 2, productsAffected: 2 });

    const trackedProduct = await owner.get(
      `/api/products?q=SYN-CSV-RECEIPT-LOT`,
    );
    expect(trackedProduct.body.products[0]).toMatchObject({
      quantityOnHand: 14,
      inventoryValue: "580.00",
    });
    const regularProduct = await owner.get(
      `/api/products?q=SYN-CSV-RECEIPT-REGULAR`,
    );
    expect(regularProduct.body.products[0].quantityOnHand).toBe(12);
    const lots = await owner.get("/api/stock/lots");
    expect(lots.body.lots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sku: "SYN-CSV-RECEIPT-LOT",
          lotCode: "SYN-CSV-LOT-A",
          expiryDate: manilaDayAfter(90),
          quantity: 4,
        }),
      ]),
    );

    const invalidToken = await csrfFor(owner);
    const invalid = await owner
      .post("/api/stock/receipts/import-csv")
      .set("Content-Type", "text/csv")
      .set("x-csrf-token", invalidToken)
      .send(
        `${headers}\nSYN-CSV-RECEIPT-REGULAR,1,10.00,,,,,\nSYN-CSV-RECEIPT-LOT,1,10.00,,,SYN-CSV-EXPIRED,${manilaDayAfter(-1)},`,
      );
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("csv_import_invalid");
    const afterInvalid = await owner.get(
      "/api/products?q=SYN-CSV-RECEIPT-REGULAR",
    );
    expect(afterInvalid.body.products[0].quantityOnHand).toBe(12);
  });

  it("requires real lot identifiers for tracked opening stock and preserves receipt snapshots", async () => {
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const missing = await createOpeningProduct(owner, {
      tracksLots: true,
      openingLotCode: undefined,
      openingExpiryDate: undefined,
    });
    expect(missing.status).toBe(400);

    const created = await createOpeningProduct(owner, {
      tracksLots: true,
      openingLotCode: "SYN-BATCH-01",
      openingExpiryDate: manilaDayAfter(30),
      openingSupplier: "Synthetic distributor",
      openingReference: "SYN-OPENING-PO-01",
    });
    expect(created.status).toBe(201);
    expect(created.body.product).toMatchObject({
      tracksLots: true,
      quantityOnHand: 10,
      saleableQuantity: 10,
      unallocatedQuantity: 0,
    });
    activeProductId = created.body.product.id as string;
    expect(
      db
        .prepare(
          `SELECT reference, supplier FROM stock_events
           WHERE product_id = ? AND event_type = 'OPENING'`,
        )
        .get(activeProductId),
    ).toEqual({
      reference: "SYN-OPENING-PO-01",
      supplier: "Synthetic distributor",
    });

    const token = await csrfFor(owner);
    const expired = await owner
      .post("/api/stock/receipts")
      .set("x-csrf-token", token)
      .send({
        productId: activeProductId,
        quantity: 2,
        unitCost: "45.00",
        lotCode: "SYN-EXPIRED",
        expiryDate: manilaDayAfter(-1),
      });
    expect(expired.status).toBe(409);
    expect(expired.body.error).toBe("expired_lot_not_allowed");

    const receiptToken = await csrfFor(owner);
    const receipt = await owner
      .post("/api/stock/receipts")
      .set("x-csrf-token", receiptToken)
      .send({
        productId: activeProductId,
        quantity: 3,
        unitCost: "45.00",
        lotCode: "SYN-BATCH-02",
        expiryDate: manilaDayAfter(15),
        supplier: "Synthetic distributor two",
        reference: "SYN-PO-REFERENCE",
      });
    expect(receipt.status).toBe(201);
    expect(receipt.body.product).toMatchObject({
      quantityOnHand: 13,
      saleableQuantity: 13,
      inventoryValue: "535.00",
    });
    const event = db
      .prepare(
        "SELECT unit_cost_centavos, reference, supplier FROM stock_events WHERE event_type = 'RECEIPT'",
      )
      .get();
    expect(event).toEqual({
      unit_cost_centavos: 4_500,
      reference: "SYN-PO-REFERENCE",
      supplier: "Synthetic distributor two",
    });
  });

  it("keeps legacy inventory unallocated until owner physical reconciliation without changing value", async () => {
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const created = await createOpeningProduct(owner);
    activeProductId = created.body.product.id as string;
    const ownerToken = await csrfFor(owner);
    const tracked = await owner
      .patch(`/api/products/${activeProductId}`)
      .set("x-csrf-token", ownerToken)
      .send({ tracksLots: true });
    expect(tracked.status).toBe(200);
    expect(tracked.body.product).toMatchObject({
      quantityOnHand: 10,
      inventoryValue: "400.00",
      saleableQuantity: 0,
      unallocatedQuantity: 10,
    });
    const disableToken = await csrfFor(owner);
    const disableTracking = await owner
      .patch(`/api/products/${activeProductId}`)
      .set("x-csrf-token", disableToken)
      .send({ tracksLots: false });
    expect(disableTracking.status).toBe(409);
    expect(disableTracking.body.error).toBe("active_lots_require_tracking");

    const cashier = await signIn(
      "cashier.inventory@example.test",
      cashierPassword,
    );
    expect((await cashier.get("/api/stock/lots")).status).toBe(403);
    const cashierToken = await csrfFor(cashier);
    expect(
      await cashier
        .post("/api/stock/lots/reconcile")
        .set("x-csrf-token", cashierToken)
        .send({
          productId: activeProductId,
          reason: "Synthetic unauthorized reconciliation",
          physicalCountConfirmed: true,
          allocations: [],
        })
        .then((response) => response.status),
    ).toBe(403);
    expect(
      (
        await cashier
          .patch("/api/stock/lots/not-a-lot/quarantine")
          .set("x-csrf-token", cashierToken)
          .send({ quarantined: true, reason: "Synthetic denied action" })
      ).status,
    ).toBe(403);
    expect(
      (
        await cashier
          .put("/api/settings/expiry-warning")
          .set("x-csrf-token", cashierToken)
          .send({ warningDays: 14 })
      ).status,
    ).toBe(403);

    const reconcileToken = await csrfFor(owner);
    const reconciliation = await owner
      .post("/api/stock/lots/reconcile")
      .set("x-csrf-token", reconcileToken)
      .send({
        productId: activeProductId,
        reason: "Synthetic physical shelf verification",
        physicalCountConfirmed: true,
        allocations: [
          {
            lotCode: "SYN-VERIFIED-BATCH",
            expiryDate: manilaDayAfter(60),
            quantity: 4,
          },
        ],
      });
    expect(reconciliation.status, JSON.stringify(reconciliation.body)).toBe(
      201,
    );
    const after = await owner.get("/api/products");
    expect(after.body.products[0]).toMatchObject({
      quantityOnHand: 10,
      inventoryValue: "400.00",
      saleableQuantity: 4,
      unallocatedQuantity: 6,
    });
    expect(
      db
        .prepare(
          `SELECT sum(quantity_delta) AS quantity,
                  sum(inventory_value_delta_centavos) AS value
           FROM lot_stock_movements WHERE product_id = ?`,
        )
        .get(activeProductId),
    ).toEqual({ quantity: 10, value: 40_000 });
    expect(
      db
        .prepare(
          `SELECT lot_id, sum(quantity_delta) AS quantity,
                  sum(inventory_value_delta_centavos) AS value
           FROM lot_stock_movements WHERE product_id = ?
           GROUP BY lot_id ORDER BY lot_id IS NOT NULL`,
        )
        .all(activeProductId),
    ).toEqual([
      { lot_id: null, quantity: 6, value: 24_000 },
      { lot_id: expect.any(String), quantity: 4, value: 16_000 },
    ]);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM stock_events WHERE product_id = ?",
        )
        .get(activeProductId),
    ).toEqual({ count: 1 });
  });

  it("requires exact lot identity for tracked adjustments and never allows a negative lot balance", async () => {
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const created = await createOpeningProduct(owner, {
      tracksLots: true,
      openingLotCode: "SYN-DISPOSAL-BATCH",
      openingExpiryDate: manilaDayAfter(3),
    });
    expect(created.status).toBe(201);
    activeProductId = created.body.product.id as string;
    const lot = (await owner.get("/api/stock/lots")).body.lots[0] as {
      id: string;
      quantity: number;
    };
    const excessiveToken = await csrfFor(owner);
    const excessive = await owner
      .post("/api/stock/adjustments")
      .set("x-csrf-token", excessiveToken)
      .send({
        productId: activeProductId,
        quantityDelta: -11,
        lotId: lot.id,
        reasonType: "EXPIRY",
        reason: "Synthetic exact lot expiry write-off",
      });
    expect(excessive.status).toBe(409);
    expect(excessive.body.error).toBe("insufficient_lot_stock");

    const disposalToken = await csrfFor(owner);
    const disposal = await owner
      .post("/api/stock/adjustments")
      .set("x-csrf-token", disposalToken)
      .send({
        productId: activeProductId,
        quantityDelta: -2,
        lotId: lot.id,
        reasonType: "EXPIRY",
        reason: "Synthetic exact lot expiry write-off",
      });
    expect(disposal.status).toBe(201);
    const updatedLot = (await owner.get("/api/stock/lots")).body.lots[0];
    expect(updatedLot).toMatchObject({ id: lot.id, quantity: 8 });
    const movement = db
      .prepare(
        `SELECT lot_id, movement_type, quantity_delta, reason
         FROM lot_stock_movements WHERE product_id = ?
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(activeProductId);
    expect(movement).toMatchObject({
      lot_id: lot.id,
      movement_type: "WRITE_OFF",
      quantity_delta: -2,
      reason: "EXPIRY: Synthetic exact lot expiry write-off",
    });
    expect(() =>
      db
        .prepare(
          `INSERT INTO lot_stock_movements
          (id, product_id, lot_id, movement_type, quantity_delta,
           inventory_value_delta_centavos, reason, created_at)
         VALUES (?, ?, ?, 'ADJUSTMENT', -9, 0, ?, ?)`,
        )
        .run(
          randomUUID(),
          activeProductId,
          lot.id,
          "Synthetic direct negative-balance attempt",
          new Date().toISOString(),
        ),
    ).toThrow(/lot_stock_balance_cannot_be_negative/u);
  });

  it("lets owners correct a lot expiry with a reason and audits the old and new dates", async () => {
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const initialExpiry = manilaDayAfter(30);
    const created = await createOpeningProduct(owner, {
      sku: "SYN-EXPIRY-EDIT",
      tracksLots: true,
      openingLotCode: "SYN-EXPIRY-EDIT-BATCH",
      openingExpiryDate: initialExpiry,
    });
    expect(created.status).toBe(201);
    activeProductId = created.body.product.id as string;
    const lot = (await owner.get("/api/stock/lots")).body.lots[0] as {
      id: string;
      expiryDate: string;
    };
    const cashier = await signIn(
      "cashier.inventory@example.test",
      cashierPassword,
    );
    const cashierToken = await csrfFor(cashier);
    expect(
      (
        await cashier
          .patch(`/api/stock/lots/${lot.id}/expiry`)
          .set("x-csrf-token", cashierToken)
          .send({
            expiryDate: manilaDayAfter(45),
            reason: "Synthetic unauthorized edit",
          })
      ).status,
    ).toBe(403);

    const updatedExpiry = manilaDayAfter(45);
    const ownerToken = await csrfFor(owner);
    const updated = await owner
      .patch(`/api/stock/lots/${lot.id}/expiry`)
      .set("x-csrf-token", ownerToken)
      .send({
        expiryDate: updatedExpiry,
        reason: "Corrected transcription from package label",
      });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toEqual({ lotId: lot.id, expiryDate: updatedExpiry });
    expect((await owner.get("/api/stock/lots")).body.lots[0]).toMatchObject({
      id: lot.id,
      expiryDate: updatedExpiry,
    });
    const audit = await owner.get("/api/audit?limit=20");
    expect(audit.body.events[0]).toMatchObject({
      action: "stock.lot_expiry_updated",
      entityId: lot.id,
      details: {
        oldExpiryDate: initialExpiry,
        expiryDate: updatedExpiry,
        reason: "Corrected transcription from package label",
      },
    });
  });

  it("lets owners edit a lot quantity and product selling price with ledger and audit records", async () => {
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const initialExpiry = manilaDayAfter(30);
    const updatedExpiry = manilaDayAfter(45);
    const created = await createOpeningProduct(owner, {
      sku: "SYN-LOT-DETAIL-EDIT",
      tracksLots: true,
      openingLotCode: "SYN-LOT-DETAIL-BATCH",
      openingExpiryDate: initialExpiry,
    });
    expect(created.status).toBe(201);
    activeProductId = created.body.product.id as string;
    const lot = (await owner.get("/api/stock/lots")).body.lots[0] as {
      id: string;
      quantity: number;
      sellingPrice: string;
    };
    expect(lot).toMatchObject({ quantity: 10, sellingPrice: "70.00" });

    const cashier = await signIn(
      "cashier.inventory@example.test",
      cashierPassword,
    );
    const cashierToken = await csrfFor(cashier);
    const denied = await cashier
      .patch(`/api/stock/lots/${lot.id}`)
      .set("x-csrf-token", cashierToken)
      .send({
        quantity: 7,
        sellingPrice: "75.00",
        expiryDate: updatedExpiry,
        reason: "Synthetic unauthorized lot edit",
      });
    expect(denied.status).toBe(403);

    const ownerToken = await csrfFor(owner);
    const reduced = await owner
      .patch(`/api/stock/lots/${lot.id}`)
      .set("x-csrf-token", ownerToken)
      .send({
        quantity: 7,
        sellingPrice: "75.00",
        expiryDate: updatedExpiry,
        reason: "Corrected physical batch count and shelf price",
      });
    expect(reduced.status, JSON.stringify(reduced.body)).toBe(200);
    expect(reduced.body).toEqual({
      lotId: lot.id,
      expiryDate: updatedExpiry,
      quantity: 7,
      sellingPrice: "75.00",
    });
    expect((await owner.get("/api/products")).body.products[0]).toMatchObject({
      id: activeProductId,
      quantityOnHand: 7,
      inventoryValue: "280.00",
      sellingPrice: "75.00",
    });

    const increased = await owner
      .patch(`/api/stock/lots/${lot.id}`)
      .set("x-csrf-token", ownerToken)
      .send({
        quantity: 9,
        sellingPrice: "75.00",
        expiryDate: updatedExpiry,
        reason: "Verified two additional units on the shelf",
      });
    expect(increased.status, JSON.stringify(increased.body)).toBe(200);
    expect((await owner.get("/api/products")).body.products[0]).toMatchObject({
      id: activeProductId,
      quantityOnHand: 9,
      inventoryValue: "360.00",
      sellingPrice: "75.00",
    });
    expect((await owner.get("/api/stock/lots")).body.lots[0]).toMatchObject({
      id: lot.id,
      quantity: 9,
      expiryDate: updatedExpiry,
      sellingPrice: "75.00",
    });
    expect(
      db
        .prepare(
          `SELECT sum(quantity_delta) AS quantity,
                  sum(inventory_value_delta_centavos) AS value
           FROM lot_stock_movements WHERE product_id = ? AND lot_id = ?`,
        )
        .get(activeProductId, lot.id),
    ).toEqual({ quantity: 9, value: 36_000 });
    expect(
      (await owner.get(`/api/stock/events?productId=${activeProductId}`)).body
        .events[0],
    ).toMatchObject({
      type: "ADJUSTMENT",
      quantityDelta: 2,
      inventoryValueDelta: "80.00",
      reason: "COUNT_CORRECTION: Verified two additional units on the shelf",
    });
    expect(
      (await owner.get("/api/audit?limit=20")).body.events[0],
    ).toMatchObject({
      action: "stock.lot_details_updated",
      entityId: lot.id,
      details: {
        reason: "Verified two additional units on the shelf",
        old: expect.objectContaining({ quantity: 7, sellingPrice: "75.00" }),
        new: expect.objectContaining({ quantity: 9, sellingPrice: "75.00" }),
      },
    });
  });

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
    expect(created.body.product).toMatchObject({
      productType: "BRANDED",
      isScEligible: true,
      isPwdEligible: true,
    });
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

  it("requires a product type and preserves independent SC/PWD eligibility on edits", async () => {
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const missingType = await createOpeningProduct(owner, {
      sku: "SYN-NO-TYPE",
      productType: undefined,
    });
    expect(missingType.status).toBe(400);

    const created = await createOpeningProduct(owner, {
      sku: "SYN-SC-ONLY",
      productType: "GENERIC",
      isScEligible: true,
      isPwdEligible: false,
    });
    expect(created.status).toBe(201);
    expect(created.body.product).toMatchObject({
      productType: "GENERIC",
      isScEligible: true,
      isPwdEligible: false,
    });

    const token = await csrfFor(owner);
    const updated = await owner
      .patch(`/api/products/${created.body.product.id as string}`)
      .set("x-csrf-token", token)
      .send({
        productType: "BRANDED",
        isScEligible: false,
        isPwdEligible: true,
      });
    expect(updated.status).toBe(200);
    expect(updated.body.product).toMatchObject({
      productType: "BRANDED",
      isScEligible: false,
      isPwdEligible: true,
    });
    expect(
      db
        .prepare(
          "SELECT sc_pwd_eligible, sc_eligible, pwd_eligible, product_type FROM products WHERE id = ?",
        )
        .get(created.body.product.id as string),
    ).toEqual({
      sc_pwd_eligible: 1,
      sc_eligible: 0,
      pwd_eligible: 1,
      product_type: "BRANDED",
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
    expect(created.body.product.grossProfitEstimateNote).toBeUndefined();
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

  it("allows unit edits after stock history, blocks unapproved zero-rated items, and lists low stock", async () => {
    const owner = await signIn("owner.inventory@example.test", ownerPassword);
    const created = await createOpeningProduct(owner);
    activeProductId = created.body.product.id as string;
    const token = await csrfFor(owner);
    const unitChange = await owner
      .patch(`/api/products/${activeProductId}`)
      .set("x-csrf-token", token)
      .send({ unit: "box" });
    expect(unitChange.status).toBe(200);
    expect(unitChange.body.product.unit).toBe("box");
    expect(unitChange.body.product.quantityOnHand).toBe(
      created.body.product.quantityOnHand,
    );

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
