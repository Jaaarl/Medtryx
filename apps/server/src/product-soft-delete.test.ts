import argon2 from "argon2";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { createApp } from "./app.js";
import { migrateDatabase } from "./db.js";
import {
  getLotBalances,
  lotLedgerIssues,
  manilaCalendarDate,
} from "./lot-stock.js";
import {
  applyMigrationsThrough,
  insertMigrationFixture,
  seedProductionMigrationRecords,
} from "./test-migrations.js";

process.env.APP_ENV = "test";
process.env.COOKIE_SECURE = "false";
const password = "SyntheticSoftDeleteOwner-45!";
let directory: string;
let hash: string;
let db: Database.Database;
let app: ReturnType<typeof createApp>;
let owner: ReturnType<typeof request.agent>;
let token: string;
type Product = {
  id: string;
  sku: string;
  name: string;
  barcode: string;
  quantityOnHand: number;
  inventoryValue: string;
};

async function signIn(role: "owner" | "cashier") {
  const agent = request.agent(app);
  const csrf = await agent.get("/api/auth/csrf");
  expect(
    (
      await agent
        .post("/api/auth/login")
        .set("x-csrf-token", csrf.body.token)
        .send({ email: `upgrade-${role}@example.test`, password })
    ).status,
  ).toBe(200);
  return {
    agent,
    csrf: (await agent.get("/api/auth/csrf")).body.token as string,
  };
}

async function createProduct(
  values: Record<string, unknown> = {},
): Promise<Product> {
  const result = await owner
    .post("/api/products")
    .set("x-csrf-token", token)
    .send({
      name: `Synthetic mistake ${randomUUID()}`,
      unit: "tablet",
      barcode: `BC-${randomUUID()}`,
      sellingPrice: "10.00",
      taxClass: "VATABLE",
      productType: "BRANDED",
      isScEligible: false,
      isPwdEligible: false,
      openingQuantity: 10,
      openingUnitCost: "7.00",
      ...values,
    });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body.product as Product;
}

function remove(product: Product) {
  return owner
    .delete(`/api/products/${product.id}`)
    .set("x-csrf-token", token)
    .send({
      expectedQuantityOnHand: product.quantityOnHand,
      expectedInventoryValue: product.inventoryValue,
    });
}

function snapshot() {
  return Object.fromEntries(
    [
      "products",
      "stock_events",
      "lot_stock_movements",
      "audit_events",
      "expenses",
      "stock_receipts",
      "stock_receipt_lines",
    ].map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]),
  );
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "medtryx-soft-delete-test-"));
  hash = await argon2.hash(password, { type: argon2.argon2id });
});
beforeEach(async () => {
  db = new Database(":memory:");
  applyMigrationsThrough(db, 27);
  seedProductionMigrationRecords(db, 10000, hash);
  migrateDatabase(db);
  app = createApp(db);
  const login = await signIn("owner");
  owner = login.agent;
  token = login.csrf;
});
afterEach(() => db.close());
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("owner product soft deletion", () => {
  it("supports zero-cost stock and an inactive product that was never sold", async () => {
    const product = await createProduct({
      openingUnitCost: "0.00",
      zeroCostReason: "Synthetic free stock",
    });
    expect(
      (
        await owner
          .patch(`/api/products/${product.id}`)
          .set("x-csrf-token", token)
          .send({ active: false })
      ).status,
    ).toBe(200);
    expect((await remove(product)).status).toBe(204);
    expect(lotLedgerIssues(db)).toEqual([]);
  });

  it("preserves cost corrections and removes their exact remaining value", async () => {
    const product = await createProduct();
    const correction = await owner
      .post("/api/stock/cost-corrections")
      .set("x-csrf-token", token)
      .send({
        productId: product.id,
        unitCost: "8.00",
        reason: "Synthetic cost correction",
      });
    expect(correction.status).toBe(201);
    const corrected = (await owner.get("/api/products")).body.products.find(
      (row: Product) => row.id === product.id,
    ) as Product;
    const history = db.prepare("SELECT * FROM stock_cost_corrections").all();
    expect((await remove(corrected)).status).toBe(204);
    expect(db.prepare("SELECT * FROM stock_cost_corrections").all()).toEqual(
      history,
    );
    expect(lotLedgerIssues(db)).toEqual([]);
  });

  it("clears both allocated lots and legacy unallocated stock", async () => {
    const product = await createProduct();
    expect(
      (
        await owner
          .patch(`/api/products/${product.id}`)
          .set("x-csrf-token", token)
          .send({ tracksLots: true })
      ).status,
    ).toBe(200);
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 60);
    const reconciled = await owner
      .post("/api/stock/lots/reconcile")
      .set("x-csrf-token", token)
      .send({
        productId: product.id,
        physicalCountConfirmed: true,
        reason: "Synthetic partial lot allocation",
        allocations: [
          {
            lotCode: "PARTIAL",
            expiryDate: date.toISOString().slice(0, 10),
            quantity: 3,
          },
        ],
      });
    expect(reconciled.status, JSON.stringify(reconciled.body)).toBe(201);
    expect((await remove(product)).status).toBe(204);
    expect(
      getLotBalances(db, product.id).every(
        (lot) => lot.quantity === 0 && lot.inventoryValueCentavos === 0,
      ),
    ).toBe(true);
    expect(lotLedgerIssues(db)).toEqual([]);
  });

  it("rejects a stale sale-line insert after a product has been deleted", async () => {
    const product = await createProduct();
    expect((await remove(product)).status).toBe(204);
    const line = db.prepare("SELECT * FROM sale_lines LIMIT 1").get() as Record<
      string,
      string | number | null
    >;
    expect(() =>
      insertMigrationFixture(db, "sale_lines", {
        ...line,
        id: randomUUID(),
        product_id: product.id,
        line_number: 99,
      }),
    ).toThrow("product_is_deleted");
    expect(lotLedgerIssues(db)).toEqual([]);
  });

  it("hides an empty product, retains its row and audit identity, and prevents reactivation", async () => {
    const product = await createProduct({ openingQuantity: 0 });
    expect((await remove(product)).status).toBe(204);
    expect(
      db
        .prepare("SELECT deleted_at, is_active FROM products WHERE id = ?")
        .get(product.id),
    ).toEqual({ deleted_at: expect.any(String), is_active: 0 });
    for (const path of ["/api/products", "/api/catalog", "/api/stock"]) {
      const response = await owner.get(path);
      expect(response.status).toBe(200);
      expect(
        response.body.products.some(
          (row: { id: string }) => row.id === product.id,
        ),
      ).toBe(false);
    }
    const audit = db
      .prepare(
        "SELECT actor_user_id, details_json FROM audit_events WHERE action = 'product.soft_deleted' AND entity_id = ?",
      )
      .get(product.id) as { actor_user_id: string; details_json: string };
    expect(audit.actor_user_id).toBe("upgrade-owner");
    expect(JSON.parse(audit.details_json)).toMatchObject({
      sku: product.sku,
      name: product.name,
      removedQuantity: 0,
    });
    expect(
      (
        await owner
          .patch(`/api/products/${product.id}`)
          .set("x-csrf-token", token)
          .send({ active: true })
      ).status,
    ).toBe(404);
    expect((await remove(product)).status).toBe(404);
    expect(() =>
      db
        .prepare("UPDATE products SET is_active = 1 WHERE id = ?")
        .run(product.id),
    ).toThrow("product_is_deleted");
    expect(lotLedgerIssues(db)).toEqual([]);
  });

  it("records removal of mistaken opening stock without rewriting its original ledger", async () => {
    const product = await createProduct();
    const opening = db
      .prepare("SELECT * FROM stock_events WHERE product_id = ?")
      .all(product.id);
    expect((await remove(product)).status).toBe(204);
    expect(
      db
        .prepare(
          "SELECT quantity_on_hand, inventory_value_centavos FROM products WHERE id = ?",
        )
        .get(product.id),
    ).toEqual({ quantity_on_hand: 0, inventory_value_centavos: 0 });
    expect(
      db
        .prepare(
          "SELECT * FROM stock_events WHERE product_id = ? AND event_type = 'OPENING'",
        )
        .all(product.id),
    ).toEqual(opening);
    expect(
      db
        .prepare(
          "SELECT event_type, quantity_delta, inventory_value_delta_centavos FROM stock_events WHERE product_id = ? AND event_type <> 'OPENING'",
        )
        .all(product.id),
    ).toEqual([
      {
        event_type: "ADJUSTMENT",
        quantity_delta: -10,
        inventory_value_delta_centavos: -7000,
      },
    ]);
    expect(
      (await owner.get(`/api/stock/events?productId=${product.id}`)).status,
    ).toBe(200);
    expect(lotLedgerIssues(db)).toEqual([]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("preserves receipts and supplier payments while clearing every tracked lot", async () => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 60);
    const expiryDate = date.toISOString().slice(0, 10);
    const product = await createProduct({
      tracksLots: true,
      openingLotCode: "SYN-OPEN",
      openingExpiryDate: expiryDate,
    });
    const receipt = await owner
      .post("/api/stock/receipts")
      .set("x-csrf-token", token)
      .send({
        productId: product.id,
        quantity: 3,
        unitCost: "2.00",
        lotCode: "SYN-SECOND",
        expiryDate,
        reference: "SYN-SUPPLIER",
      });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    insertMigrationFixture(db, "expenses", {
      id: randomUUID(),
      request_id: randomUUID(),
      business_date: manilaCalendarDate(),
      category: "STOCK_PURCHASE",
      amount_centavos: 600,
      product_amount_centavos: 600,
      delivery_fee_centavos: 0,
      description: "Synthetic supplier payment",
      payment_source: "OWNER",
      included_in_unit_cost: 0,
      recorded_by_user_id: "upgrade-owner",
      created_at: new Date().toISOString(),
    });
    const updated = (await owner.get("/api/products")).body.products.find(
      (row: Product) => row.id === product.id,
    ) as Product;
    const receipts = db.prepare("SELECT * FROM stock_receipts").all();
    const lines = db.prepare("SELECT * FROM stock_receipt_lines").all();
    const payments = db.prepare("SELECT * FROM expenses").all();
    const reportBefore = await owner.get(
      `/api/reports/daily?date=${manilaCalendarDate()}`,
    );
    expect(reportBefore.status).toBe(200);
    expect((await remove(updated)).status).toBe(204);
    expect(db.prepare("SELECT * FROM stock_receipts").all()).toEqual(receipts);
    expect(db.prepare("SELECT * FROM stock_receipt_lines").all()).toEqual(
      lines,
    );
    expect(db.prepare("SELECT * FROM expenses").all()).toEqual(payments);
    expect(getLotBalances(db, product.id)).toHaveLength(2);
    expect(
      getLotBalances(db, product.id).every(
        (lot) => lot.quantity === 0 && lot.inventoryValueCentavos === 0,
      ),
    ).toBe(true);
    const reportAfter = await owner.get(
      `/api/reports/daily?date=${manilaCalendarDate()}`,
    );
    expect(reportAfter.status).toBe(200);
    expect(reportAfter.body.metrics).toEqual(reportBefore.body.metrics);
    expect(lotLedgerIssues(db)).toEqual([]);
  });

  it("blocks any customer sales history, including historical or returned sales", async () => {
    const product = await createProduct();
    const line = db.prepare("SELECT * FROM sale_lines LIMIT 1").get() as Record<
      string,
      string | number | null
    >;
    insertMigrationFixture(db, "sale_lines", {
      ...line,
      id: randomUUID(),
      product_id: product.id,
      line_number: 99,
    });
    const before = snapshot();
    const result = await remove(product);
    expect(result.status).toBe(409);
    expect(result.body.error).toBe("product_has_sales_history");
    expect(snapshot()).toEqual(before);
    const listed = (await owner.get("/api/products")).body.products.find(
      (row: Product) => row.id === product.id,
    );
    expect(listed.deletionBlockedReason).toBe("product_has_sales_history");
    expect(() =>
      db
        .prepare(
          "UPDATE products SET deleted_at = ?, is_active = 0, quantity_on_hand = 0, inventory_value_centavos = 0 WHERE id = ?",
        )
        .run(new Date().toISOString(), product.id),
    ).toThrow("product_has_sales_history");
  });

  it("rejects a stale confirmation before writing any inventory changes", async () => {
    const product = await createProduct();
    const receipt = await owner
      .post("/api/stock/receipts")
      .set("x-csrf-token", token)
      .send({ productId: product.id, quantity: 1, unitCost: "7.00" });
    expect(receipt.status).toBe(201);
    const before = snapshot();
    expect((await remove(product)).body.error).toBe(
      "product_inventory_changed",
    );
    expect(snapshot()).toEqual(before);
  });

  it("requires owner authorization and CSRF protection", async () => {
    const product = await createProduct();
    expect(
      (await request(app).delete(`/api/products/${product.id}`)).status,
    ).toBe(401);
    expect(
      (await owner.delete(`/api/products/${product.id}`).send({})).status,
    ).toBe(403);
    const cashier = await signIn("cashier");
    expect(
      (
        await cashier.agent
          .delete(`/api/products/${product.id}`)
          .set("x-csrf-token", cashier.csrf)
          .send({})
      ).status,
    ).toBe(403);
    expect(
      db
        .prepare("SELECT deleted_at FROM products WHERE id = ?")
        .get(product.id),
    ).toEqual({ deleted_at: null });
  });

  it("rolls back stock removal and deletion if audit insertion fails", async () => {
    const product = await createProduct();
    db.exec(`CREATE TRIGGER synthetic_delete_failure BEFORE INSERT ON audit_events
      WHEN NEW.action = 'product.soft_deleted' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;`);
    const before = snapshot();
    expect((await remove(product)).status).toBe(500);
    expect(snapshot()).toEqual(before);
    expect(lotLedgerIssues(db)).toEqual([]);
  });

  it("refuses to remove inconsistent inventory and leaves it unchanged", async () => {
    const product = await createProduct();
    db.prepare("UPDATE products SET quantity_on_hand = 9 WHERE id = ?").run(
      product.id,
    );
    const before = snapshot();
    expect((await remove({ ...product, quantityOnHand: 9 })).body.error).toBe(
      "product_inventory_inconsistent",
    );
    expect(snapshot()).toEqual(before);
  });

  it("permits a replacement with the same name and barcode while retaining the old SKU", async () => {
    const product = await createProduct();
    expect((await remove(product)).status).toBe(204);
    const replacement = await createProduct({
      name: product.name,
      barcode: product.barcode,
    });
    expect(replacement.id).not.toBe(product.id);
    expect(replacement.sku).not.toBe(product.sku);
    expect(
      db.prepare("SELECT barcode FROM products WHERE id = ?").get(product.id),
    ).toEqual({ barcode: product.barcode });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    const conflict = await owner
      .post("/api/products")
      .set("x-csrf-token", token)
      .send({
        name: "Another synthetic product",
        barcode: product.barcode,
        unit: "tablet",
        sellingPrice: "10.00",
        taxClass: "VATABLE",
        productType: "BRANDED",
        isScEligible: false,
        isPwdEligible: false,
      });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("barcode_already_exists");
  });

  it("rejects all new stock mutations for a deleted product", async () => {
    const product = await createProduct();
    expect((await remove(product)).status).toBe(204);
    const before = snapshot();
    for (const [path, body] of [
      [
        "/api/stock/receipts",
        { productId: product.id, quantity: 1, unitCost: "1.00" },
      ],
      [
        "/api/stock/adjustments",
        {
          productId: product.id,
          quantityDelta: 1,
          unitCost: "1.00",
          reasonType: "COUNT_CORRECTION",
          reason: "Synthetic adjustment",
        },
      ],
      [
        "/api/stock/cost-corrections",
        {
          productId: product.id,
          unitCost: "1.00",
          reason: "Synthetic correction",
        },
      ],
    ] as const) {
      const response = await owner
        .post(path)
        .set("x-csrf-token", token)
        .send(body);
      expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(
        404,
      );
    }
    expect(snapshot()).toEqual(before);
  });
});
