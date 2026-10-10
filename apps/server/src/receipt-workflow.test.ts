import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { openDatabase } from "./db.js";
import { beginRestore, finishRestore } from "./maintenance.js";

process.env.APP_ENV = "test";
process.env.COOKIE_SECURE = "false";

const ownerPassword = "SyntheticReceiptOwner-45!";
const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ItEAAAAASUVORK5CYII=";
const pdfBase64 = Buffer.from("%PDF-1.7\nSynthetic receipt").toString("base64");
const description = "Prednisone 10mg tablet PREDOQUE-10 (Amb) 100's 200C";

let app: ReturnType<typeof createApp>;
let db: ReturnType<typeof openDatabase>;
let dataDirectory: string;
let ownerHash: string;
let owner: ReturnType<typeof request.agent>;
let csrfToken: string;
let originalFetch: typeof globalThis.fetch;
let originalMixRouteKey: string | undefined;

function parseCsvRow(line: string): string[] {
  const cells: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quoted && character === '"' && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === ",") {
      cells.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  cells.push(value);
  return cells;
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function editDraftCsv(csv: string, fields: Record<string, string>): string {
  const records = csv.split(/\r?\n/u).map(parseCsvRow);
  const headers = records[0]!;
  for (const [key, value] of Object.entries(fields)) {
    const index = headers.indexOf(key);
    expect(index).toBeGreaterThanOrEqual(0);
    records[1]![index] = value;
  }
  return records.map((record) => record.map(csvCell).join(",")).join("\r\n");
}

function firstDraftRow(csv: string): Record<string, string> {
  const records = csv.split(/\r?\n/u).map(parseCsvRow);
  return Object.fromEntries(
    records[0]!.map((header, index) => [header, records[1]![index] ?? ""]),
  );
}

async function signIn(): Promise<void> {
  owner = request.agent(app);
  const csrf = await owner.get("/api/auth/csrf");
  const login = await owner
    .post("/api/auth/login")
    .set("x-csrf-token", csrf.body.token as string)
    .send({ email: "receipt-owner@example.test", password: ownerPassword });
  expect(login.status).toBe(200);
  csrfToken = login.body.csrfToken as string;
}

async function createProduct(
  values: Record<string, unknown> = {},
): Promise<{ id: string; sku: string }> {
  const response = await owner
    .post("/api/products")
    .set("x-csrf-token", csrfToken)
    .send({
      sku: "SYN-RECEIPT-001",
      name: "Synthetic PREDOQUE-10 Prednisone tablet",
      unit: "tablet",
      sellingPrice: "70.00",
      taxClass: "VATABLE",
      productType: "BRANDED",
      isScEligible: false,
      isPwdEligible: false,
      tracksLots: true,
      openingQuantity: 0,
      ...values,
    });
  expect(response.status).toBe(201);
  return response.body.product as { id: string; sku: string };
}

function mockMixRoute(
  options: {
    status?: "EXACT_MATCH" | "POSSIBLE_MATCH" | "NEW_PRODUCT";
    description?: string;
    unitCost?: string;
    quantity?: string;
    lineTotal?: string;
    unitsPerPackage?: number | null;
    productId?: string;
  } = {},
): void {
  const rowDescription = options.description ?? description;
  const status = options.status ?? "EXACT_MATCH";
  const productId = options.productId ?? "current-product-id";
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      contents?: Array<{
        parts?: Array<{ inlineData?: { mimeType: string } }>;
      }>;
      messages?: Array<{ content?: string }>;
    };
    if (url.includes(":generateContent")) {
      const isExtraction = (body.contents?.[0]?.parts?.length ?? 0) > 1;
      const suggestedFactor =
        options.unitsPerPackage === undefined ? 10 : options.unitsPerPackage;
      const text = isExtraction
        ? {
            supplier: "Synthetic Pharma Supplier",
            reference: "SYN-REC-01",
            items: [
              {
                description: rowDescription,
                quantity: options.quantity ?? "2",
                unitCost: options.unitCost ?? "100.00",
                lineTotal: options.lineTotal ?? "200.00",
                lot: "B-1",
                expiry: "12/2030",
              },
            ],
          }
        : {
            items: [
              {
                row: 1,
                quantity: options.quantity ?? "2",
                unitCost: options.unitCost ?? "100.00",
                lotCode: "B-1",
                expiryDate: "2030-12-31",
                unitsPerPackage: suggestedFactor,
                conversionRecommended: suggestedFactor !== null,
                conversionConfidence: "HIGH",
                conversionReason: "Clearly labeled tablet count.",
              },
            ],
          };
      return Response.json({
        candidates: [{ content: { parts: [{ text: JSON.stringify(text) }] } }],
      });
    }
    const userPrompt = body.messages?.[1]?.content ?? "";
    const response = userPrompt.startsWith("Rearrange each")
      ? {
          items: [
            {
              row: 1,
              name: "PREDOQUE-10 Prednisone 10mg tablet (Amb) 100's 200C",
            },
          ],
        }
      : {
          items: [
            {
              row: 1,
              status,
              suggestedProductId: status === "NEW_PRODUCT" ? null : productId,
            },
          ],
        };
    return Response.json({
      choices: [{ message: { content: JSON.stringify(response) } }],
    });
  }) as typeof globalThis.fetch;
  originalFetch = oldFetch;
}

beforeAll(async () => {
  ownerHash = await argon2.hash(ownerPassword, { type: argon2.argon2id });
});

beforeEach(async () => {
  dataDirectory = mkdtempSync(join(tmpdir(), "medtryx-receipt-workflow-"));
  db = openDatabase("test", dataDirectory);
  app = createApp(db);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, password_hash, role, is_active, created_at, updated_at)
     VALUES (?, 'receipt-owner@example.test', ?, 'owner', 1, ?, ?)`,
  ).run(randomUUID(), ownerHash, now, now);
  await signIn();
  originalFetch = globalThis.fetch;
  originalMixRouteKey = process.env.MIXROUTE_API_KEY;
  process.env.MIXROUTE_API_KEY = "synthetic-mixroute-key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalMixRouteKey === undefined) delete process.env.MIXROUTE_API_KEY;
  else process.env.MIXROUTE_API_KEY = originalMixRouteKey;
  db.close();
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("AI-assisted receipt receiving", () => {
  it("identifies when AI receipt extraction returns an invalid response", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    supplier: "",
                    reference: "",
                    items: [],
                  }),
                },
              ],
            },
          },
        ],
      })) as typeof globalThis.fetch;

    const response = await owner
      .post("/api/stock/receipts/ai-draft")
      .set("x-csrf-token", csrfToken)
      .send({
        files: [
          {
            name: "receipt.pdf",
            mimeType: "application/pdf",
            dataBase64: pdfBase64,
          },
        ],
      });

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: "receipt_extraction_invalid" });
  });

  it("preselects an exact match and receives approved per-tablet stock with immutable receipt evidence", async () => {
    const product = await createProduct();
    mockMixRoute({ productId: product.id });
    const draft = await owner
      .post("/api/stock/receipts/ai-draft")
      .set("x-csrf-token", csrfToken)
      .send({
        files: [
          {
            name: "receipt.pdf",
            mimeType: "application/pdf",
            dataBase64: pdfBase64,
          },
        ],
      });

    expect(draft.status).toBe(200);
    expect(draft.body.lineCount).toBe(1);
    expect(draft.body.csv).toContain("PREDOQUE-10 Prednisone 10mg tablet");
    expect(firstDraftRow(draft.body.csv as string)).toMatchObject({
      matchstatus: "EXACT_MATCH",
      suggestedproductid: product.id,
      suggestedproductname: "Synthetic PREDOQUE-10 Prednisone tablet",
      suggestedproductsku: product.sku,
      selectedproductid: product.id,
      sku: product.sku,
      unit: "tablet",
      trackslots: "TRUE",
      conversionapproved: "FALSE",
    });

    const reviewedCsv = editDraftCsv(draft.body.csv as string, {
      conversionapproved: "TRUE",
    });
    const reviewed = await owner
      .post("/api/stock/receipts/ai-review")
      .set("x-csrf-token", csrfToken)
      .set("content-type", "text/csv")
      .send(reviewedCsv);
    expect(reviewed.status).toBe(200);
    expect(reviewed.body).toMatchObject({
      lineCount: 1,
      existingProducts: 1,
      conversions: 1,
    });
    expect(reviewed.body.lines[0]).toMatchObject({
      quantity: 20,
      unitCost: "10.00",
      conversionFactor: 10,
    });

    const imported = await owner
      .post("/api/stock/receipts/ai-import")
      .set("x-csrf-token", csrfToken)
      .set("content-type", "text/csv")
      .send(reviewedCsv);
    expect(imported.status).toBe(201);
    expect(imported.body).toMatchObject({
      importedCount: 1,
      productsAffected: 1,
    });
    expect(
      db
        .prepare(
          "SELECT quantity_on_hand, inventory_value_centavos FROM products WHERE id = ?",
        )
        .get(product.id),
    ).toEqual({ quantity_on_hand: 20, inventory_value_centavos: 20_000 });
    expect(
      db
        .prepare(
          "SELECT quantity_delta, unit_cost_centavos FROM stock_events WHERE product_id = ?",
        )
        .get(product.id),
    ).toEqual({ quantity_delta: 20, unit_cost_centavos: 1_000 });
    expect(
      db
        .prepare(
          "SELECT source, reference, supplier FROM stock_receipts WHERE id = ?",
        )
        .get(imported.body.receiptId),
    ).toEqual({
      source: "AI_RECEIPT_IMPORT",
      reference: "SYN-REC-01",
      supplier: "Synthetic Pharma Supplier",
    });
    expect(
      db
        .prepare(
          "SELECT original_description, source_quantity, source_unit_cost, source_line_total, source_lot, source_expiry, received_quantity, received_unit_cost_centavos, conversion_factor FROM stock_receipt_lines WHERE receipt_id = ?",
        )
        .get(imported.body.receiptId),
    ).toEqual({
      original_description: description,
      source_quantity: "2",
      source_unit_cost: "100.00",
      source_line_total: "200.00",
      source_lot: "B-1",
      source_expiry: "12/2030",
      received_quantity: 20,
      received_unit_cost_centavos: 1_000,
      conversion_factor: 10,
    });
    const duplicateImport = await owner
      .post("/api/stock/receipts/ai-import")
      .set("x-csrf-token", csrfToken)
      .set("content-type", "text/csv")
      .send(reviewedCsv);
    expect(duplicateImport.status).toBe(409);
    expect(duplicateImport.body).toEqual({ error: "receipt_already_imported" });
    expect(
      db
        .prepare("SELECT quantity_on_hand FROM products WHERE id = ?")
        .get(product.id),
    ).toEqual({ quantity_on_hand: 20 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM stock_receipts").get(),
    ).toEqual({ count: 1 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("preserves exact receipt totals when a package conversion has fractional-cent unit cost", async () => {
    const product = await createProduct({ unit: "capsule" });
    mockMixRoute({
      productId: product.id,
      quantity: "5",
      unitCost: "71.50",
      lineTotal: "357.50",
      unitsPerPackage: 100,
    });
    const draft = await owner
      .post("/api/stock/receipts/ai-draft")
      .set("x-csrf-token", csrfToken)
      .send({
        files: [
          {
            name: "receipt.pdf",
            mimeType: "application/pdf",
            dataBase64: pdfBase64,
          },
        ],
      });

    expect(draft.status).toBe(200);
    const reviewedCsv = editDraftCsv(draft.body.csv as string, {
      conversionapproved: "TRUE",
    });
    const reviewed = await owner
      .post("/api/stock/receipts/ai-review")
      .set("x-csrf-token", csrfToken)
      .set("content-type", "text/csv")
      .send(reviewedCsv);

    expect(reviewed.status).toBe(200);
    expect(reviewed.body.lines[0]).toMatchObject({
      quantity: 500,
      unitCost: "0.72",
      unitCostRounded: true,
      lineTotal: "357.50",
      conversionFactor: 100,
    });

    const imported = await owner
      .post("/api/stock/receipts/ai-import")
      .set("x-csrf-token", csrfToken)
      .set("content-type", "text/csv")
      .send(reviewedCsv);

    expect(imported.status).toBe(201);
    expect(
      db
        .prepare(
          "SELECT quantity_on_hand, inventory_value_centavos FROM products WHERE id = ?",
        )
        .get(product.id),
    ).toEqual({ quantity_on_hand: 500, inventory_value_centavos: 35_750 });
    expect(
      db
        .prepare(
          "SELECT quantity_delta, unit_cost_centavos, inventory_value_delta_centavos FROM stock_events WHERE product_id = ? AND event_type = 'RECEIPT'",
        )
        .get(product.id),
    ).toEqual({
      quantity_delta: 500,
      unit_cost_centavos: 72,
      inventory_value_delta_centavos: 35_750,
    });
    expect(
      db
        .prepare(
          "SELECT quantity_delta, unit_cost_centavos, inventory_value_delta_centavos FROM lot_stock_movements WHERE product_id = ? AND movement_type = 'RECEIPT'",
        )
        .get(product.id),
    ).toEqual({
      quantity_delta: 500,
      unit_cost_centavos: 72,
      inventory_value_delta_centavos: 35_750,
    });
  });

  it("accepts PCS conversions and avoids calling malformed expiry dates expired", async () => {
    const product = await createProduct({ unit: "PCS" });
    mockMixRoute({ productId: product.id });
    const draft = await owner
      .post("/api/stock/receipts/ai-draft")
      .set("x-csrf-token", csrfToken)
      .send({
        files: [
          {
            name: "receipt.pdf",
            mimeType: "application/pdf",
            dataBase64: pdfBase64,
          },
        ],
      });

    expect(draft.status).toBe(200);
    const invalidExpiryCsv = editDraftCsv(draft.body.csv as string, {
      conversionapproved: "TRUE",
      expirydate: "12/31/2030",
    });
    const invalidExpiry = await owner
      .post("/api/stock/receipts/ai-review")
      .set("x-csrf-token", csrfToken)
      .set("content-type", "text/csv")
      .send(invalidExpiryCsv);

    expect(invalidExpiry.status).toBe(400);
    expect(invalidExpiry.body.rowErrors).toContainEqual({
      row: 2,
      message: "Expiry date must use YYYY-MM-DD.",
    });
    expect(invalidExpiry.body.rowErrors).not.toContainEqual({
      row: 2,
      message: "Expired stock cannot be received.",
    });
    expect(invalidExpiry.body.rowErrors).not.toContainEqual({
      row: 2,
      message:
        "Conversions require a separable POS unit and are blocked for birth-control products.",
    });

    const validCsv = editDraftCsv(draft.body.csv as string, {
      conversionapproved: "TRUE",
      expirydate: "2030-12-31",
    });
    const reviewed = await owner
      .post("/api/stock/receipts/ai-review")
      .set("x-csrf-token", csrfToken)
      .set("content-type", "text/csv")
      .send(validCsv);

    expect(reviewed.status).toBe(200);
    expect(reviewed.body).toMatchObject({
      conversions: 1,
      lines: [{ quantity: 20, unitCost: "10.00", conversionFactor: 10 }],
    });
  });

  it("shows a possible match SKU without preselecting it until the owner confirms", async () => {
    const product = await createProduct();
    mockMixRoute({ status: "POSSIBLE_MATCH", productId: product.id });
    const draft = await owner
      .post("/api/stock/receipts/ai-draft")
      .set("x-csrf-token", csrfToken)
      .send({
        files: [
          {
            name: "receipt.pdf",
            mimeType: "application/pdf",
            dataBase64: pdfBase64,
          },
        ],
      });

    expect(draft.status).toBe(200);
    expect(firstDraftRow(draft.body.csv as string)).toMatchObject({
      matchstatus: "POSSIBLE_MATCH",
      suggestedproductid: product.id,
      suggestedproductsku: product.sku,
      selectedproductid: "",
      sku: "",
    });

    const unconfirmed = await owner
      .post("/api/stock/receipts/ai-review")
      .set("x-csrf-token", csrfToken)
      .set("content-type", "text/csv")
      .send(draft.body.csv as string);
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.rowErrors[0].message).toContain(
      "Confirm a product",
    );

    const confirmedCsv = editDraftCsv(draft.body.csv as string, {
      selectedproductid: product.id,
    });
    const confirmed = await owner
      .post("/api/stock/receipts/ai-review")
      .set("x-csrf-token", csrfToken)
      .set("content-type", "text/csv")
      .send(confirmedCsv);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.existingProducts).toBe(1);
  });

  it("blocks a package conversion for a birth-control product and leaves the stock ledger unchanged", async () => {
    const product = await createProduct({
      sku: "SYN-BC-PACK",
      name: "Synthetic Levonorgestrel Birth Control Pack",
      unit: "tablet",
      tracksLots: false,
    });
    mockMixRoute({
      description: "Levonorgestrel birth control pills pack",
      unitsPerPackage: 21,
      productId: product.id,
    });
    const draft = await owner
      .post("/api/stock/receipts/ai-draft")
      .set("x-csrf-token", csrfToken)
      .send({
        files: [
          { name: "receipt.png", mimeType: "image/png", dataBase64: pngBase64 },
        ],
      });
    expect(draft.status).toBe(200);
    const reviewedCsv = editDraftCsv(draft.body.csv as string, {
      selectedproductid: product.id,
      conversionapproved: "TRUE",
    });
    const reviewed = await owner
      .post("/api/stock/receipts/ai-review")
      .set("x-csrf-token", csrfToken)
      .set("content-type", "text/csv")
      .send(reviewedCsv);
    expect(reviewed.status).toBe(400);
    expect(
      reviewed.body.rowErrors.some((issue: { message: string }) =>
        issue.message.includes("blocked for birth-control"),
      ),
    ).toBe(true);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM stock_events").get(),
    ).toEqual({ count: 0 });
  });

  it("creates a new product only after its POS fields are completed in the reviewed CSV", async () => {
    mockMixRoute({
      status: "NEW_PRODUCT",
      description: "Synthetic new medicine 250mg tablet",
      unitsPerPackage: null,
    });
    const draft = await owner
      .post("/api/stock/receipts/ai-draft")
      .set("x-csrf-token", csrfToken)
      .send({
        files: [
          {
            name: "receipt.pdf",
            mimeType: "application/pdf",
            dataBase64: pdfBase64,
          },
        ],
      });
    expect(draft.status).toBe(200);
    const fields = {
      sku: "SYN-NEW-MED-001",
      unit: "tablet",
      sellingprice: "50.00",
      taxclass: "VATABLE",
      producttype: "GENERIC",
      issceligible: "FALSE",
      ispwdeligible: "FALSE",
      bnpceligible: "FALSE",
      trackslots: "FALSE",
    };
    const reviewedCsv = editDraftCsv(draft.body.csv as string, fields);
    const imported = await owner
      .post("/api/stock/receipts/ai-import")
      .set("x-csrf-token", csrfToken)
      .set("content-type", "text/csv")
      .send(reviewedCsv);
    expect(imported.status).toBe(201);
    expect(imported.body.createdProducts).toEqual([
      {
        id: expect.any(String),
        sku: "SYN-NEW-MED-001",
        name: "PREDOQUE-10 Prednisone 10mg tablet (Amb) 100's 200C",
      },
    ]);
    expect(
      db
        .prepare(
          "SELECT sku, name, unit, quantity_on_hand FROM products WHERE sku = 'SYN-NEW-MED-001'",
        )
        .get(),
    ).toEqual({
      sku: "SYN-NEW-MED-001",
      name: "PREDOQUE-10 Prednisone 10mg tablet (Amb) 100's 200C",
      unit: "tablet",
      quantity_on_hand: 2,
    });
  });

  it("reports a missing MixRoute key without sending receipt data", async () => {
    delete process.env.MIXROUTE_API_KEY;
    const response = await owner
      .post("/api/stock/receipts/ai-draft")
      .set("x-csrf-token", csrfToken)
      .send({
        files: [
          { name: "receipt.png", mimeType: "image/png", dataBase64: pngBase64 },
        ],
      });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "mixroute_api_key_not_configured" });
  });

  it("honors the database restore maintenance gate before receipt processing", async () => {
    expect(beginRestore()).toBe(true);
    try {
      const response = await owner
        .post("/api/stock/receipts/ai-draft")
        .set("x-csrf-token", csrfToken)
        .send({
          files: [
            {
              name: "receipt.png",
              mimeType: "image/png",
              dataBase64: pngBase64,
            },
          ],
        });
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: "database_restore_in_progress" });
    } finally {
      finishRestore();
    }
  });
});
