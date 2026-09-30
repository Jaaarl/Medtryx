import "../config.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { openDatabase, repositoryRoot, selectedEnvironment } from "../db.js";

const moneyPattern = /^\d{1,7}(?:\.\d{1,2})?$/;
const productSeedSchema = z
  .object({
    sourceFile: z.string(),
    scope: z.literal("products-only"),
    status: z.literal("review-required"),
    notes: z.array(z.string()),
    products: z.array(
      z
        .object({
          sku: z.string().min(1).max(48),
          name: z.string().min(1).max(160),
          unit: z.string().min(1).max(32),
          sourceUnitCost: z.string().regex(moneyPattern),
          priceMultiplier: z.union([z.literal(2), z.literal(3)]),
          sellingPrice: z.string().regex(moneyPattern),
          taxClass: z.null(),
          productType: z.null(),
          isScEligible: z.boolean(),
          isPwdEligible: z.boolean(),
          bnpcEligible: z.boolean(),
          tracksLots: z.boolean(),
          openingQuantity: z.literal(0),
          active: z.literal(false),
        })
        .strict(),
    ),
  })
  .strict();

function toCentavos(value: string): number {
  const [whole, fractional = ""] = value.split(".");
  return Number(whole) * 100 + Number(fractional.padEnd(2, "0"));
}

const seedPath = resolve(
  repositoryRoot,
  "database/seeds/pharma-products.seed.json",
);
const seed = productSeedSchema.parse(
  JSON.parse(readFileSync(seedPath, "utf8")),
);

for (const product of seed.products) {
  if (
    toCentavos(product.sourceUnitCost) * product.priceMultiplier !==
    toCentavos(product.sellingPrice)
  ) {
    throw new Error(
      `Selling price does not match multiplier for ${product.sku}.`,
    );
  }
}

const db = openDatabase();
try {
  const insertProduct = db.prepare(
    `INSERT OR IGNORE INTO products
      (id, sku, name, barcode, unit, selling_price_centavos, tax_class,
       sc_pwd_eligible, sc_eligible, pwd_eligible, product_type,
       product_type_applicable, bnpc_eligible, bnpc_category,
       bnpc_source, bnpc_review_reference, bnpc_reviewed_at,
       bnpc_reviewed_by_user_id, bnpc_prescription_required, tracks_lots,
       quantity_on_hand, inventory_value_centavos, reorder_level, is_active,
       created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, 'VATABLE', 0, 0, 0, NULL, 1, 0, NULL,
       NULL, NULL, NULL, NULL, 0, ?, 0, 0, NULL, 0, ?, ?)`,
  );
  const now = new Date().toISOString();
  let inserted = 0;
  let skipped = 0;

  db.transaction(() => {
    for (const product of seed.products) {
      const result = insertProduct.run(
        randomUUID(),
        product.sku,
        product.name,
        product.unit,
        toCentavos(product.sellingPrice),
        product.tracksLots ? 1 : 0,
        now,
        now,
      );
      if (result.changes === 1) inserted += 1;
      else skipped += 1;
    }
  })();

  process.stdout.write(
    `Product seed complete (${selectedEnvironment()}): ${inserted} inserted, ${skipped} skipped. All seeded products are inactive pending review.\n`,
  );
} finally {
  db.close();
}
