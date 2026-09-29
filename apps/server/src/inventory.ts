import { Decimal } from "decimal.js";
import type { NextFunction, Request, Response } from "express";
import type Database from "better-sqlite3";
import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuthentication, requireCsrf, requireRole } from "./auth.js";
import { writeAuditEvent } from "./db.js";

const MAX_QUANTITY = 1_000_000;
const PROVISIONAL_VAT_RATE_BASIS_POINTS = 1_200;
const policyRoundingSchema = z.enum(["HALF_UP", "HALF_EVEN", "DOWN"]);
const moneySchema = z
  .string()
  .trim()
  .regex(/^\d{1,7}(?:\.\d{1,2})?$/);
const taxClassSchema = z.enum(["VATABLE", "VAT_EXEMPT", "ZERO_RATED"]);
const productTypeSchema = z.enum(["GENERIC", "BRANDED"]);
const skuSchema = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i);
const unitSchema = z.string().trim().min(1).max(32);
const optionalNoteSchema = z.string().trim().max(200).optional();
const reasonSchema = z.string().trim().min(3).max(500);

const createProductSchema = z
  .object({
    sku: skuSchema.optional(),
    name: z.string().trim().min(1).max(160),
    barcode: z.string().trim().max(80).nullable().optional(),
    unit: unitSchema,
    sellingPrice: moneySchema,
    taxClass: taxClassSchema,
    productType: productTypeSchema,
    isScEligible: z.boolean(),
    isPwdEligible: z.boolean(),
    openingQuantity: z.number().int().min(0).max(MAX_QUANTITY).default(0),
    openingUnitCost: moneySchema.optional(),
    reorderLevel: z
      .number()
      .int()
      .min(0)
      .max(MAX_QUANTITY)
      .nullable()
      .optional(),
    zeroCostReason: reasonSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (parseMoney(value.sellingPrice) <= 0) {
      context.addIssue({
        code: "custom",
        path: ["sellingPrice"],
        message: "selling_price_must_be_positive",
      });
    }
    if (value.openingQuantity > 0 && value.openingUnitCost === undefined) {
      context.addIssue({
        code: "custom",
        path: ["openingUnitCost"],
        message: "opening_cost_required",
      });
    }
    if (
      value.openingQuantity > 0 &&
      value.openingUnitCost !== undefined &&
      parseMoney(value.openingUnitCost) === 0 &&
      !value.zeroCostReason
    ) {
      context.addIssue({
        code: "custom",
        path: ["zeroCostReason"],
        message: "zero_cost_requires_reason",
      });
    }
  });

const updateProductSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    barcode: z.string().trim().max(80).nullable().optional(),
    unit: unitSchema.optional(),
    sellingPrice: moneySchema.optional(),
    taxClass: taxClassSchema.optional(),
    productType: productTypeSchema.optional(),
    isScEligible: z.boolean().optional(),
    isPwdEligible: z.boolean().optional(),
    reorderLevel: z
      .number()
      .int()
      .min(0)
      .max(MAX_QUANTITY)
      .nullable()
      .optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "empty_update");

const receiptSchema = z
  .object({
    productId: z.uuid(),
    quantity: z.number().int().min(1).max(MAX_QUANTITY),
    unitCost: moneySchema,
    reference: optionalNoteSchema,
    zeroCostReason: reasonSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (parseMoney(value.unitCost) === 0 && !value.zeroCostReason) {
      context.addIssue({
        code: "custom",
        path: ["zeroCostReason"],
        message: "zero_cost_requires_reason",
      });
    }
  });

const adjustmentSchema = z
  .object({
    productId: z.uuid(),
    quantityDelta: z
      .number()
      .int()
      .min(-MAX_QUANTITY)
      .max(MAX_QUANTITY)
      .refine((value) => value !== 0),
    unitCost: moneySchema.optional(),
    reasonType: z.enum(["COUNT_CORRECTION", "DAMAGE", "EXPIRY", "DISPOSAL"]),
    reason: reasonSchema,
    reference: optionalNoteSchema,
    zeroCostReason: reasonSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.quantityDelta > 0 && value.unitCost === undefined) {
      context.addIssue({
        code: "custom",
        path: ["unitCost"],
        message: "increase_cost_required",
      });
    }
    if (value.quantityDelta > 0 && value.unitCost !== undefined) {
      if (parseMoney(value.unitCost) === 0 && !value.zeroCostReason) {
        context.addIssue({
          code: "custom",
          path: ["zeroCostReason"],
          message: "zero_cost_requires_reason",
        });
      }
    } else if (value.quantityDelta < 0 && value.unitCost !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["unitCost"],
        message: "decrease_uses_weighted_average_cost",
      });
    }
  });

type TaxClass = z.infer<typeof taxClassSchema>;
type ProductRow = {
  id: string;
  sku: string;
  name: string;
  barcode: string | null;
  unit: string;
  selling_price_centavos: number;
  tax_class: TaxClass;
  sc_pwd_eligible: number;
  sc_eligible: number;
  pwd_eligible: number;
  product_type: "GENERIC" | "BRANDED" | null;
  quantity_on_hand: number;
  inventory_value_centavos: number;
  reorder_level: number | null;
  is_active: number;
  created_at: string;
  updated_at: string;
  latest_unit_cost_centavos: number | null;
  latest_acquisition_at: string | null;
};

type StockEventRow = {
  id: string;
  event_type: string;
  quantity_delta: number;
  unit_cost_centavos: number | null;
  inventory_value_delta_centavos: number;
  reference: string | null;
  reason: string | null;
  created_at: string;
  product_id: string;
  sku: string;
  product_name: string;
  actor_email: string | null;
};

class InventoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function parseMoney(value: string): number {
  const cents = new Decimal(value).mul(100);
  const result = cents.toNumber();
  if (!cents.isInteger() || !Number.isSafeInteger(result)) {
    throw new InventoryError(400, "invalid_money_amount");
  }
  return result;
}

function money(cents: number | Decimal): string {
  return new Decimal(cents)
    .div(100)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
}

function roundedInteger(value: Decimal): number {
  const result = value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
  if (!Number.isSafeInteger(result))
    throw new InventoryError(400, "inventory_value_overflow");
  return result;
}

type GrossProfitPolicy = {
  approved: boolean;
  version: string | null;
  vatRateBasisPoints: number;
  vatInclusivePrices: boolean;
  roundingMode: z.infer<typeof policyRoundingSchema>;
  costBasisDescription: string | null;
};

function grossProfitPolicy(db: Database.Database): GrossProfitPolicy {
  const row = db
    .prepare("SELECT value_json FROM settings WHERE key = 'tax'")
    .get() as { value_json: string } | undefined;
  if (row) {
    try {
      const parsed = z
        .object({
          approved: z.literal(true),
          version: z.string().min(3).max(64),
          vatRateBasisPoints: z.number().int().min(0).max(5_000),
          seniorDiscountBasisPoints: z.number().int().min(0).max(10_000),
          pwdDiscountBasisPoints: z.number().int().min(0).max(10_000),
          vatInclusivePrices: z.boolean(),
          allowZeroRated: z.boolean(),
          roundingMode: policyRoundingSchema,
          approvalReference: z.string().min(3).max(160),
          costBasisDescription: z.string().min(3).max(500),
          approvedAt: z.string().min(1),
          approvedBy: z.string().min(1),
        })
        .safeParse(JSON.parse(row.value_json));
      if (parsed.success) {
        return {
          approved: true,
          version: parsed.data.version,
          vatRateBasisPoints: parsed.data.vatRateBasisPoints,
          vatInclusivePrices: parsed.data.vatInclusivePrices,
          roundingMode: parsed.data.roundingMode,
          costBasisDescription: parsed.data.costBasisDescription,
        };
      }
    } catch {
      // Malformed or incomplete settings cannot approve accounting estimates.
    }
  }
  return {
    approved: false,
    version: null,
    vatRateBasisPoints: PROVISIONAL_VAT_RATE_BASIS_POINTS,
    vatInclusivePrices: true,
    roundingMode: "HALF_UP",
    costBasisDescription: null,
  };
}

function withBaseCost(row: ProductRow, policy: GrossProfitPolicy) {
  const roundingMode =
    policy.roundingMode === "HALF_EVEN"
      ? Decimal.ROUND_HALF_EVEN
      : policy.roundingMode === "DOWN"
        ? Decimal.ROUND_DOWN
        : Decimal.ROUND_HALF_UP;
  const averageCostCents =
    row.quantity_on_hand === 0
      ? new Decimal(0)
      : new Decimal(row.inventory_value_centavos).div(row.quantity_on_hand);
  const netRegularRevenueCents =
    row.tax_class === "VATABLE" && policy.vatInclusivePrices
      ? new Decimal(row.selling_price_centavos)
          .mul(10_000)
          .div(10_000 + policy.vatRateBasisPoints)
          .toDecimalPlaces(0, roundingMode)
      : new Decimal(row.selling_price_centavos);
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    barcode: row.barcode,
    unit: row.unit,
    sellingPrice: money(row.selling_price_centavos),
    taxClass: row.tax_class,
    scPwdEligible: row.sc_pwd_eligible === 1,
    isScEligible: row.sc_eligible === 1,
    isPwdEligible: row.pwd_eligible === 1,
    productType: row.product_type,
    quantityOnHand: row.quantity_on_hand,
    reorderLevel: row.reorder_level,
    active: row.is_active === 1,
    latestAcquisitionCost:
      row.latest_unit_cost_centavos === null
        ? null
        : money(row.latest_unit_cost_centavos),
    latestAcquisitionAt: row.latest_acquisition_at,
    weightedAverageUnitCost: money(averageCostCents),
    inventoryValue: money(row.inventory_value_centavos),
    unitPriceSpread: money(
      new Decimal(row.selling_price_centavos).minus(averageCostCents),
    ),
    estimatedUnitGrossProfit: money(
      netRegularRevenueCents.minus(averageCostCents),
    ),
    grossProfitEstimateApproved: policy.approved,
    grossProfitEstimateNote: policy.approved
      ? `Regular-sale estimate uses approved ${policy.version} tax settings and the configured acquisition-cost basis (${policy.costBasisDescription}); benefit discounts and operating expenses are excluded.`
      : "Provisional 12% VAT-inclusive estimate; tax rate and acquisition-cost basis require approval.",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function presentProduct(db: Database.Database, row: ProductRow) {
  return withBaseCost(row, grossProfitPolicy(db));
}

function baseProductSelect(): string {
  return `SELECT p.*,
    (SELECT e.unit_cost_centavos FROM stock_events e
      WHERE e.product_id = p.id AND e.quantity_delta > 0 AND e.unit_cost_centavos IS NOT NULL
      ORDER BY e.sequence DESC LIMIT 1) AS latest_unit_cost_centavos,
    (SELECT e.created_at FROM stock_events e
      WHERE e.product_id = p.id AND e.quantity_delta > 0 AND e.unit_cost_centavos IS NOT NULL
      ORDER BY e.sequence DESC LIMIT 1) AS latest_acquisition_at
    FROM products p`;
}

function findProduct(
  db: Database.Database,
  id: string,
): ProductRow | undefined {
  return db.prepare(`${baseProductSelect()} WHERE p.id = ?`).get(id) as
    | ProductRow
    | undefined;
}

function listProducts(
  db: Database.Database,
  query: string,
  activeOnly = false,
): ProductRow[] {
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  if (activeOnly) conditions.push("p.is_active = 1");
  if (query) {
    conditions.push(
      "(instr(lower(p.name), lower(?)) > 0 OR instr(lower(p.sku), lower(?)) > 0 OR instr(lower(coalesce(p.barcode, '')), lower(?)) > 0)",
    );
    values.push(query, query, query);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(
      `${baseProductSelect()} ${where} ORDER BY p.name COLLATE NOCASE LIMIT 500`,
    )
    .all(...values) as ProductRow[];
}

function productFromBody(
  db: Database.Database,
  body: {
    taxClass?: TaxClass | undefined;
  },
): void {
  if (body.taxClass !== "ZERO_RATED") return;
  const setting = db
    .prepare("SELECT value_json FROM settings WHERE key = 'tax'")
    .get() as { value_json: string } | undefined;
  let allowZeroRated = false;
  if (setting) {
    try {
      const parsed = z
        .object({
          approved: z.boolean().optional(),
          allowZeroRated: z.boolean().optional(),
          version: z.string().min(3).optional(),
          vatRateBasisPoints: z.number().int().nonnegative().optional(),
          seniorDiscountBasisPoints: z.number().int().nonnegative().optional(),
          pwdDiscountBasisPoints: z.number().int().nonnegative().optional(),
          vatInclusivePrices: z.boolean().optional(),
          roundingMode: z.enum(["HALF_UP", "HALF_EVEN", "DOWN"]).optional(),
          approvalReference: z.string().min(3).optional(),
          costBasisDescription: z.string().min(3).optional(),
          approvedAt: z.string().min(1).optional(),
        })
        .passthrough()
        .safeParse(JSON.parse(setting.value_json));
      allowZeroRated =
        parsed.success &&
        parsed.data.approved === true &&
        parsed.data.allowZeroRated === true &&
        parsed.data.version !== undefined &&
        parsed.data.vatRateBasisPoints !== undefined &&
        parsed.data.seniorDiscountBasisPoints !== undefined &&
        parsed.data.pwdDiscountBasisPoints !== undefined &&
        parsed.data.vatInclusivePrices !== undefined &&
        parsed.data.roundingMode !== undefined &&
        parsed.data.approvalReference !== undefined &&
        parsed.data.costBasisDescription !== undefined &&
        parsed.data.approvedAt !== undefined;
    } catch {
      allowZeroRated = false;
    }
  }
  if (!allowZeroRated) throw new InventoryError(400, "zero_rated_not_approved");
}

function bodyValidation(res: Response): void {
  res.status(400).json({ error: "invalid_request" });
}

function handleInventoryError(error: unknown, res: Response): boolean {
  if (error instanceof InventoryError) {
    res.status(error.status).json({ error: error.code });
    return true;
  }
  if (
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed: products.sku")
  ) {
    res.status(409).json({ error: "sku_already_exists" });
    return true;
  }
  if (error instanceof Error && error.message.includes("products.barcode")) {
    res.status(409).json({ error: "barcode_already_exists" });
    return true;
  }
  return false;
}

function writeStockEvent(
  db: Database.Database,
  event: {
    id?: string;
    productId: string;
    type: "OPENING" | "RECEIPT" | "ADJUSTMENT" | "WRITE_OFF";
    quantityDelta: number;
    unitCostCents: number | null;
    inventoryValueDeltaCents: number;
    reference: string | null;
    reason: string | null;
    actorUserId: string;
    createdAt: string;
  },
): string {
  const id = event.id ?? randomUUID();
  db.prepare(
    `INSERT INTO stock_events
      (id, product_id, event_type, quantity_delta, unit_cost_centavos,
       inventory_value_delta_centavos, reference, reason, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    event.productId,
    event.type,
    event.quantityDelta,
    event.unitCostCents,
    event.inventoryValueDeltaCents,
    event.reference,
    event.reason,
    event.actorUserId,
    event.createdAt,
  );
  return id;
}

function getStockEvents(
  db: Database.Database,
  productId?: string,
  limit = 100,
): StockEventRow[] {
  const filter = productId ? "WHERE e.product_id = ?" : "";
  const args = productId ? [productId, limit] : [limit];
  return db
    .prepare(
      `SELECT e.id, e.event_type, e.quantity_delta, e.unit_cost_centavos,
              e.inventory_value_delta_centavos, e.reference, e.reason, e.created_at,
              p.id AS product_id, p.sku, p.name AS product_name, u.email AS actor_email
       FROM stock_events e JOIN products p ON p.id = e.product_id
       LEFT JOIN users u ON u.id = e.actor_user_id
       ${filter} ORDER BY e.sequence DESC LIMIT ?`,
    )
    .all(...args) as StockEventRow[];
}

function presentStockEvent(event: StockEventRow) {
  return {
    id: event.id,
    productId: event.product_id,
    sku: event.sku,
    productName: event.product_name,
    type: event.event_type,
    quantityDelta: event.quantity_delta,
    unitCost:
      event.unit_cost_centavos === null
        ? null
        : money(event.unit_cost_centavos),
    inventoryValueDelta: money(event.inventory_value_delta_centavos),
    reference: event.reference,
    reason: event.reason,
    actorEmail: event.actor_email,
    createdAt: event.created_at,
  };
}

export function registerInventoryRoutes(
  router: express.Router,
  db: Database.Database,
): void {
  const requireAuth = requireAuthentication(db);
  const requireOwner = requireRole("owner");
  const csrf = (req: Request, res: Response, next: NextFunction) =>
    requireCsrf(db, req, res, next);

  router.get("/catalog", requireAuth, (req, res) => {
    const parsed = z
      .string()
      .trim()
      .max(120)
      .safeParse(req.query.q ?? "");
    if (!parsed.success) return bodyValidation(res);
    const products = listProducts(db, parsed.data, true).map((row) => ({
      id: row.id,
      sku: row.sku,
      name: row.name,
      barcode: row.barcode,
      unit: row.unit,
      sellingPrice: money(row.selling_price_centavos),
      taxClass: row.tax_class,
      isScEligible: row.sc_eligible === 1,
      isPwdEligible: row.pwd_eligible === 1,
      productType: row.product_type,
      quantityAvailable: row.quantity_on_hand,
    }));
    res.json({ products });
  });

  router.get("/products", requireAuth, requireOwner, (req, res) => {
    const parsed = z
      .string()
      .trim()
      .max(120)
      .safeParse(req.query.q ?? "");
    if (!parsed.success) return bodyValidation(res);
    const policy = grossProfitPolicy(db);
    res.json({
      products: listProducts(db, parsed.data).map((product) =>
        withBaseCost(product, policy),
      ),
    });
  });

  router.post("/products", requireAuth, requireOwner, csrf, (req, res) => {
    const parsed = createProductSchema.safeParse(req.body);
    if (!parsed.success) return bodyValidation(res);
    if (!req.user)
      return res.status(401).json({ error: "authentication_required" });
    try {
      productFromBody(db, parsed.data);
      const sellingPriceCents = parseMoney(parsed.data.sellingPrice);
      const openingCostCents =
        parsed.data.openingUnitCost === undefined
          ? null
          : parseMoney(parsed.data.openingUnitCost);
      const inventoryValueCents =
        parsed.data.openingQuantity > 0 && openingCostCents !== null
          ? roundedInteger(
              new Decimal(parsed.data.openingQuantity).mul(openingCostCents),
            )
          : 0;
      const safeValue = Number.isSafeInteger(inventoryValueCents);
      if (!safeValue) throw new InventoryError(400, "inventory_value_overflow");

      const id = randomUUID();
      const now = new Date().toISOString();
      const sku = db.transaction(() => {
        let generatedSku = parsed.data.sku?.toUpperCase();
        if (!generatedSku) {
          do {
            const sequence = db
              .prepare("INSERT INTO product_sku_sequence DEFAULT VALUES")
              .run();
            generatedSku = `MTX-${String(sequence.lastInsertRowid).padStart(6, "0")}`;
          } while (
            db
              .prepare("SELECT 1 FROM products WHERE sku = ? COLLATE NOCASE")
              .get(generatedSku)
          );
        }
        db.prepare(
          `INSERT INTO products
            (id, sku, name, barcode, unit, selling_price_centavos, tax_class,
             sc_pwd_eligible, sc_eligible, pwd_eligible, product_type,
             quantity_on_hand, inventory_value_centavos,
             reorder_level, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        ).run(
          id,
          generatedSku,
          parsed.data.name,
          parsed.data.barcode?.trim() || null,
          parsed.data.unit,
          sellingPriceCents,
          parsed.data.taxClass,
          parsed.data.isScEligible || parsed.data.isPwdEligible ? 1 : 0,
          parsed.data.isScEligible ? 1 : 0,
          parsed.data.isPwdEligible ? 1 : 0,
          parsed.data.productType,
          parsed.data.openingQuantity,
          inventoryValueCents,
          parsed.data.reorderLevel ?? null,
          now,
          now,
        );
        if (parsed.data.openingQuantity > 0 && openingCostCents !== null) {
          writeStockEvent(db, {
            productId: id,
            type: "OPENING",
            quantityDelta: parsed.data.openingQuantity,
            unitCostCents: openingCostCents,
            inventoryValueDeltaCents: inventoryValueCents,
            reference: null,
            reason:
              openingCostCents === 0
                ? (parsed.data.zeroCostReason ?? null)
                : null,
            actorUserId: req.user!.id,
            createdAt: now,
          });
        }
        writeAuditEvent(db, {
          actorUserId: req.user!.id,
          action: "product.created",
          entityType: "product",
          entityId: id,
          details: {
            sku: generatedSku,
            name: parsed.data.name,
            productType: parsed.data.productType,
            isScEligible: parsed.data.isScEligible,
            isPwdEligible: parsed.data.isPwdEligible,
            openingQuantity: parsed.data.openingQuantity,
            taxClass: parsed.data.taxClass,
          },
        });
        return generatedSku;
      })();
      const product = findProduct(db, id);
      if (!product) throw new InventoryError(500, "product_create_failed");
      res.status(201).json({
        product: presentProduct(db, product),
        generatedSku: !parsed.data.sku,
        sku,
      });
    } catch (error) {
      if (!handleInventoryError(error, res)) throw error;
    }
  });

  router.patch("/products/:id", requireAuth, requireOwner, csrf, (req, res) => {
    const id = z.uuid().safeParse(req.params.id);
    const parsed = updateProductSchema.safeParse(req.body);
    if (!id.success || !parsed.success || !req.user) return bodyValidation(res);
    const current = findProduct(db, id.data);
    if (!current) return res.status(404).json({ error: "product_not_found" });
    try {
      productFromBody(db, parsed.data);
      if (parsed.data.unit && parsed.data.unit !== current.unit) {
        const history = db
          .prepare("SELECT 1 FROM stock_events WHERE product_id = ? LIMIT 1")
          .get(current.id);
        if (current.quantity_on_hand > 0 || history) {
          throw new InventoryError(409, "unit_locked_after_stock_history");
        }
      }
      const changes: Record<string, string | number | boolean | null> = {};
      if (parsed.data.name !== undefined && parsed.data.name !== current.name) {
        changes.name = parsed.data.name;
      }
      if (parsed.data.barcode !== undefined) {
        const barcode = parsed.data.barcode?.trim() || null;
        if (barcode !== current.barcode) changes.barcode = barcode;
      }
      if (parsed.data.unit !== undefined && parsed.data.unit !== current.unit) {
        changes.unit = parsed.data.unit;
      }
      if (parsed.data.sellingPrice !== undefined) {
        const amount = parseMoney(parsed.data.sellingPrice);
        if (amount <= 0)
          throw new InventoryError(400, "selling_price_must_be_positive");
        if (amount !== current.selling_price_centavos)
          changes.sellingPriceCentavos = amount;
      }
      if (
        parsed.data.taxClass !== undefined &&
        parsed.data.taxClass !== current.tax_class
      ) {
        changes.taxClass = parsed.data.taxClass;
      }
      const nextScEligible =
        parsed.data.isScEligible ?? current.sc_eligible === 1;
      const nextPwdEligible =
        parsed.data.isPwdEligible ?? current.pwd_eligible === 1;
      if (
        parsed.data.isScEligible !== undefined &&
        parsed.data.isScEligible !== (current.sc_eligible === 1)
      ) {
        changes.isScEligible = parsed.data.isScEligible;
      }
      if (
        parsed.data.isPwdEligible !== undefined &&
        parsed.data.isPwdEligible !== (current.pwd_eligible === 1)
      ) {
        changes.isPwdEligible = parsed.data.isPwdEligible;
      }
      if (
        parsed.data.productType !== undefined &&
        parsed.data.productType !== current.product_type
      ) {
        changes.productType = parsed.data.productType;
      }
      if (
        nextScEligible !== (current.sc_eligible === 1) ||
        nextPwdEligible !== (current.pwd_eligible === 1)
      ) {
        changes.scPwdEligible = nextScEligible || nextPwdEligible;
      }
      if (
        parsed.data.reorderLevel !== undefined &&
        parsed.data.reorderLevel !== current.reorder_level
      ) {
        changes.reorderLevel = parsed.data.reorderLevel;
      }
      if (
        parsed.data.active !== undefined &&
        parsed.data.active !== (current.is_active === 1)
      ) {
        changes.active = parsed.data.active;
      }
      if (Object.keys(changes).length === 0) {
        res.json({ product: presentProduct(db, current) });
        return;
      }
      const assignments: string[] = [];
      const values: (string | number | null)[] = [];
      const map: Record<string, [string, string | number | null]> = {
        name: ["name", parsed.data.name ?? current.name],
        barcode: ["barcode", parsed.data.barcode?.trim() || null],
        unit: ["unit", parsed.data.unit ?? current.unit],
        sellingPriceCentavos: [
          "selling_price_centavos",
          Number(changes.sellingPriceCentavos),
        ],
        taxClass: ["tax_class", String(changes.taxClass)],
        isScEligible: ["sc_eligible", changes.isScEligible ? 1 : 0],
        isPwdEligible: ["pwd_eligible", changes.isPwdEligible ? 1 : 0],
        productType: ["product_type", String(changes.productType)],
        scPwdEligible: ["sc_pwd_eligible", changes.scPwdEligible ? 1 : 0],
        reorderLevel: ["reorder_level", parsed.data.reorderLevel ?? null],
        active: ["is_active", changes.active ? 1 : 0],
      };
      for (const key of Object.keys(changes)) {
        const [column, value] = map[key]!;
        assignments.push(`${column} = ?`);
        values.push(value);
      }
      const now = new Date().toISOString();
      assignments.push("updated_at = ?");
      values.push(now, current.id);
      db.transaction(() => {
        db.prepare(
          `UPDATE products SET ${assignments.join(", ")} WHERE id = ?`,
        ).run(...values);
        writeAuditEvent(db, {
          actorUserId: req.user!.id,
          action:
            parsed.data.active === false
              ? "product.deactivated"
              : "product.updated",
          entityType: "product",
          entityId: current.id,
          details: { old: currentValues(current, changes), new: changes },
        });
      })();
      const updated = findProduct(db, current.id);
      res.json({ product: updated ? presentProduct(db, updated) : null });
    } catch (error) {
      if (!handleInventoryError(error, res)) throw error;
    }
  });

  router.get("/stock", requireAuth, requireOwner, (req, res) => {
    const lowStock = z
      .enum(["true", "false"])
      .optional()
      .safeParse(req.query.lowStock);
    if (!lowStock.success) return bodyValidation(res);
    const products = listProducts(db, "").filter(
      (row) =>
        lowStock.data !== "true" ||
        (row.reorder_level !== null &&
          row.quantity_on_hand <= row.reorder_level),
    );
    const policy = grossProfitPolicy(db);
    res.json({
      products: products.map((product) => withBaseCost(product, policy)),
      lowStockCount: products.filter(isLowStock).length,
    });
  });

  router.get("/stock/events", requireAuth, requireOwner, (req, res) => {
    const productId = req.query.productId;
    const limitParsed = z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .safeParse(req.query.limit ?? "100");
    if (!limitParsed.success) return bodyValidation(res);
    if (productId !== undefined && !z.uuid().safeParse(productId).success)
      return bodyValidation(res);
    const events = getStockEvents(
      db,
      productId as string | undefined,
      limitParsed.data,
    );
    res.json({ events: events.map(presentStockEvent) });
  });

  router.post(
    "/stock/receipts",
    requireAuth,
    requireOwner,
    csrf,
    (req, res) => {
      const parsed = receiptSchema.safeParse(req.body);
      if (!parsed.success) return bodyValidation(res);
      if (!req.user)
        return res.status(401).json({ error: "authentication_required" });
      try {
        const costCents = parseMoney(parsed.data.unitCost);
        const valueDelta = roundedInteger(
          new Decimal(costCents).mul(parsed.data.quantity),
        );
        const now = new Date().toISOString();
        const receipt = db.transaction(() => {
          const product = db
            .prepare(
              "SELECT id, sku, name, quantity_on_hand, inventory_value_centavos FROM products WHERE id = ?",
            )
            .get(parsed.data.productId) as
            | {
                id: string;
                sku: string;
                name: string;
                quantity_on_hand: number;
                inventory_value_centavos: number;
              }
            | undefined;
          if (!product) throw new InventoryError(404, "product_not_found");
          const quantity = product.quantity_on_hand + parsed.data.quantity;
          const inventoryValue = product.inventory_value_centavos + valueDelta;
          if (
            quantity > MAX_QUANTITY ||
            !Number.isSafeInteger(inventoryValue)
          ) {
            throw new InventoryError(400, "inventory_value_overflow");
          }
          db.prepare(
            "UPDATE products SET quantity_on_hand = ?, inventory_value_centavos = ?, updated_at = ? WHERE id = ?",
          ).run(quantity, inventoryValue, now, product.id);
          writeStockEvent(db, {
            productId: product.id,
            type: "RECEIPT",
            quantityDelta: parsed.data.quantity,
            unitCostCents: costCents,
            inventoryValueDeltaCents: valueDelta,
            reference: parsed.data.reference || null,
            reason:
              costCents === 0 ? (parsed.data.zeroCostReason ?? null) : null,
            actorUserId: req.user!.id,
            createdAt: now,
          });
          writeAuditEvent(db, {
            actorUserId: req.user!.id,
            action: "stock.received",
            entityType: "product",
            entityId: product.id,
            details: {
              sku: product.sku,
              quantity: parsed.data.quantity,
              unitCostCentavos: costCents,
              reference: parsed.data.reference ?? null,
            },
          });
          return product.id;
        })();
        const product = findProduct(db, receipt);
        res
          .status(201)
          .json({ product: product ? presentProduct(db, product) : null });
      } catch (error) {
        if (!handleInventoryError(error, res)) throw error;
      }
    },
  );

  router.post(
    "/stock/adjustments",
    requireAuth,
    requireOwner,
    csrf,
    (req, res) => {
      const parsed = adjustmentSchema.safeParse(req.body);
      if (!parsed.success) return bodyValidation(res);
      if (!req.user)
        return res.status(401).json({ error: "authentication_required" });
      try {
        const adjustment = db.transaction(() => {
          const product = db
            .prepare(
              "SELECT id, sku, quantity_on_hand, inventory_value_centavos FROM products WHERE id = ?",
            )
            .get(parsed.data.productId) as
            | {
                id: string;
                sku: string;
                quantity_on_hand: number;
                inventory_value_centavos: number;
              }
            | undefined;
          if (!product) throw new InventoryError(404, "product_not_found");
          const now = new Date().toISOString();
          const increasing = parsed.data.quantityDelta > 0;
          const absoluteDelta = Math.abs(parsed.data.quantityDelta);
          let valueDelta: number;
          let unitCost: number;
          if (increasing) {
            unitCost = parseMoney(parsed.data.unitCost!);
            valueDelta = roundedInteger(
              new Decimal(unitCost).mul(absoluteDelta),
            );
            if (
              !Number.isSafeInteger(
                product.inventory_value_centavos + valueDelta,
              )
            ) {
              throw new InventoryError(400, "inventory_value_overflow");
            }
          } else {
            if (absoluteDelta > product.quantity_on_hand) {
              throw new InventoryError(409, "insufficient_stock");
            }
            valueDelta = roundedInteger(
              absoluteDelta === product.quantity_on_hand
                ? new Decimal(product.inventory_value_centavos)
                : new Decimal(product.inventory_value_centavos)
                    .mul(absoluteDelta)
                    .div(product.quantity_on_hand),
            );
            unitCost = roundedInteger(
              new Decimal(valueDelta).div(absoluteDelta),
            );
            valueDelta = -valueDelta;
          }
          const nextQuantity =
            product.quantity_on_hand + parsed.data.quantityDelta;
          const nextValue = product.inventory_value_centavos + valueDelta;
          if (
            nextQuantity < 0 ||
            nextValue < 0 ||
            !Number.isSafeInteger(nextValue)
          ) {
            throw new InventoryError(409, "invalid_inventory_adjustment");
          }
          db.prepare(
            "UPDATE products SET quantity_on_hand = ?, inventory_value_centavos = ?, updated_at = ? WHERE id = ?",
          ).run(nextQuantity, nextValue, now, product.id);
          const isWriteOff = ["DAMAGE", "EXPIRY", "DISPOSAL"].includes(
            parsed.data.reasonType,
          );
          const reason = `${parsed.data.reasonType}: ${parsed.data.reason}`;
          writeStockEvent(db, {
            productId: product.id,
            type: isWriteOff ? "WRITE_OFF" : "ADJUSTMENT",
            quantityDelta: parsed.data.quantityDelta,
            unitCostCents: unitCost,
            inventoryValueDeltaCents: valueDelta,
            reference: parsed.data.reference || null,
            reason,
            actorUserId: req.user!.id,
            createdAt: now,
          });
          writeAuditEvent(db, {
            actorUserId: req.user!.id,
            action: isWriteOff ? "stock.written_off" : "stock.adjusted",
            entityType: "product",
            entityId: product.id,
            details: {
              sku: product.sku,
              quantityDelta: parsed.data.quantityDelta,
              inventoryValueDeltaCentavos: valueDelta,
              reason,
              reference: parsed.data.reference ?? null,
            },
          });
          return product.id;
        })();
        const product = findProduct(db, adjustment);
        res
          .status(201)
          .json({ product: product ? presentProduct(db, product) : null });
      } catch (error) {
        if (!handleInventoryError(error, res)) throw error;
      }
    },
  );
}

function isLowStock(row: ProductRow): boolean {
  return (
    row.reorder_level !== null && row.quantity_on_hand <= row.reorder_level
  );
}

function currentValues(
  row: ProductRow,
  changes: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  const output: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(changes)) {
    const values: Record<string, string | number | boolean | null> = {
      name: row.name,
      barcode: row.barcode,
      unit: row.unit,
      sellingPriceCentavos: row.selling_price_centavos,
      taxClass: row.tax_class,
      scPwdEligible: row.sc_pwd_eligible === 1,
      isScEligible: row.sc_eligible === 1,
      isPwdEligible: row.pwd_eligible === 1,
      productType: row.product_type,
      reorderLevel: row.reorder_level,
      active: row.is_active === 1,
    };
    output[key] = values[key] ?? null;
  }
  return output;
}
