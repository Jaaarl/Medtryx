import { Decimal } from "decimal.js";
import type { NextFunction, Request, Response } from "express";
import type Database from "better-sqlite3";
import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuthentication, requireCsrf, requireRole } from "./auth.js";
import { writeAuditEvent } from "./db.js";
import {
  getLotBalances,
  manilaCalendarDate,
  unallocatedBalance,
  validCalendarDate,
  writeLotMovement,
} from "./lot-stock.js";

const MAX_QUANTITY = 1_000_000;
const PROVISIONAL_VAT_RATE_BASIS_POINTS = 1_200;
const policyRoundingSchema = z.enum(["HALF_UP", "HALF_EVEN", "DOWN"]);
const moneySchema = z
  .string()
  .trim()
  .regex(/^\d{1,7}(?:\.\d{1,2})?$/);
const taxClassSchema = z.enum(["VATABLE", "VAT_EXEMPT", "ZERO_RATED"]);
const productTypeSchema = z.enum(["GENERIC", "BRANDED", "NOT_APPLICABLE"]);
const bnpcCategorySchema = z.enum(["BASIC_NECESSITY", "PRIME_COMMODITY"]);
const skuSchema = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i);
const unitSchema = z.string().trim().min(1).max(32);
const optionalNoteSchema = z.string().trim().max(200).optional();
const reasonSchema = z.string().trim().min(3).max(500);
const lotCodeSchema = z.string().trim().min(1).max(100);
const expiryDateSchema = z
  .string()
  .refine(validCalendarDate, "invalid_expiry_date");
const supplierSchema = z.string().trim().max(160).optional();

const createProductSchema = z
  .object({
    sku: skuSchema.optional(),
    name: z.string().trim().min(1).max(160),
    barcode: z.string().trim().max(80).nullable().optional(),
    unit: unitSchema,
    sellingPrice: moneySchema,
    taxClass: taxClassSchema,
    productType: productTypeSchema,
    tracksLots: z.boolean().default(false),
    isScEligible: z.boolean(),
    isPwdEligible: z.boolean(),
    bnpcEligible: z.boolean().default(false),
    bnpcCategory: bnpcCategorySchema.optional(),
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
    openingReference: optionalNoteSchema,
    openingLotCode: lotCodeSchema.optional(),
    openingExpiryDate: expiryDateSchema.optional(),
    openingSupplier: supplierSchema,
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
    if (value.tracksLots && value.openingQuantity > 0) {
      if (!value.openingLotCode || !value.openingExpiryDate) {
        context.addIssue({
          code: "custom",
          path: ["openingLotCode"],
          message: "opening_lot_required",
        });
      } else if (value.openingExpiryDate < manilaCalendarDate()) {
        context.addIssue({
          code: "custom",
          path: ["openingExpiryDate"],
          message: "expired_lot_not_allowed",
        });
      }
    }
    if (value.bnpcEligible && !value.bnpcCategory) {
      context.addIssue({
        code: "custom",
        path: ["bnpcCategory"],
        message: "bnpc_classification_review_required",
      });
    }
  });

type CreateProductInput = z.infer<typeof createProductSchema>;
type CsvRow = { row: number; values: Record<string, string> };
type CsvIssue = { row: number; message: string };
type CsvParseResult =
  | { rows: CsvRow[]; issues: [] }
  | { rows: []; issues: CsvIssue[] };

const MAX_CSV_CHARACTERS = 200_000;
const MAX_CSV_ROWS = 500;
const PRODUCT_CSV_HEADERS = [
  "sku",
  "name",
  "barcode",
  "unit",
  "sellingprice",
  "taxclass",
  "producttype",
  "issceligible",
  "ispwdeligible",
  "bnpceligible",
  "bnpccategory",
  "trackslots",
  "openingquantity",
  "openingunitcost",
  "reorderlevel",
  "openingreference",
  "openinglotcode",
  "openingexpirydate",
  "openingsupplier",
  "zerocostreason",
];
const PRODUCT_UPDATE_CSV_HEADERS = [
  "sku",
  "name",
  "barcode",
  "unit",
  "sellingprice",
  "taxclass",
  "producttype",
  "issceligible",
  "ispwdeligible",
  "bnpceligible",
  "bnpccategory",
  "trackslots",
  "reorderlevel",
  "active",
  "quantityonhand",
  "saleablequantity",
  "latestacquisitioncost",
  "weightedaverageunitcost",
  "inventoryvalue",
  "unitpricespread",
  "estimatedunitgrossprofit",
  "grossprofitestimateapproved",
];
const PRODUCT_UPDATE_CSV_REQUIRED_HEADERS = PRODUCT_UPDATE_CSV_HEADERS.slice(
  0,
  14,
);

function parseCsvRows(
  source: unknown,
  allowedHeaders: string[],
  requiredHeaders: string[],
): CsvParseResult {
  if (typeof source !== "string" || source.length > MAX_CSV_CHARACTERS) {
    return {
      rows: [],
      issues: [{ row: 1, message: "CSV must be smaller than 200 KB." }],
    };
  }
  const csv = source.replace(/^\uFEFF/u, "");
  const records: Array<{ row: number; cells: string[] }> = [];
  let cells: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  let line = 1;
  let recordLine = 1;
  let malformed = false;
  const finishField = () => {
    cells.push(field.trim());
    field = "";
    closedQuote = false;
  };
  const finishRecord = () => {
    finishField();
    if (cells.some((cell) => cell.length > 0)) {
      records.push({ row: recordLine, cells });
    }
    cells = [];
    recordLine = line;
  };

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index]!;
    if (quoted) {
      if (character === '"') {
        if (csv[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += character;
        if (character === "\n") line += 1;
      }
      continue;
    }
    if (character === '"') {
      if (field.length !== 0 || closedQuote) {
        malformed = true;
        break;
      }
      quoted = true;
    } else if (character === ",") {
      finishField();
    } else if (character === "\r" || character === "\n") {
      finishRecord();
      if (character === "\r" && csv[index + 1] === "\n") index += 1;
      line += 1;
      recordLine = line;
    } else if (closedQuote && !/\s/u.test(character)) {
      malformed = true;
      break;
    } else if (!closedQuote) {
      field += character;
    }
  }
  if (quoted) malformed = true;
  if (malformed) {
    return {
      rows: [],
      issues: [
        { row: line, message: "CSV contains invalid quote formatting." },
      ],
    };
  }
  if (field.length > 0 || cells.length > 0 || closedQuote) finishRecord();
  if (records.length < 2) {
    return {
      rows: [],
      issues: [{ row: 1, message: "CSV needs a header and at least one row." }],
    };
  }
  const headers = records[0]!.cells.map((header) => header.toLowerCase());
  const issues: CsvIssue[] = [];
  const headerSet = new Set<string>();
  headers.forEach((header, index) => {
    if (!header)
      issues.push({ row: 1, message: "Header cells cannot be blank." });
    else if (headerSet.has(header))
      issues.push({ row: 1, message: `Duplicate header: ${header}.` });
    else if (!allowedHeaders.includes(header))
      issues.push({
        row: 1,
        message: `Unknown header: ${records[0]!.cells[index]}.`,
      });
    headerSet.add(header);
  });
  for (const required of requiredHeaders) {
    if (!headerSet.has(required)) {
      issues.push({ row: 1, message: `Missing required header: ${required}.` });
    }
  }
  const dataRecords = records.slice(1);
  if (dataRecords.length > MAX_CSV_ROWS) {
    issues.push({
      row: 1,
      message: `CSV can contain at most ${MAX_CSV_ROWS} data rows.`,
    });
  }
  const rows: CsvRow[] = [];
  for (const record of dataRecords) {
    if (record.cells.length !== headers.length) {
      issues.push({
        row: record.row,
        message: `Expected ${headers.length} columns but found ${record.cells.length}.`,
      });
      continue;
    }
    rows.push({
      row: record.row,
      values: Object.fromEntries(
        headers.map((header, index) => [header, record.cells[index]!]),
      ),
    });
  }
  return issues.length ? { rows: [], issues } : { rows, issues: [] };
}

function csvBoolean(
  value: string | undefined,
  defaultValue: boolean,
  row: number,
  field: string,
  issues: CsvIssue[],
): boolean {
  if (!value) return defaultValue;
  switch (value.toLowerCase()) {
    case "true":
    case "yes":
    case "1":
      return true;
    case "false":
    case "no":
    case "0":
      return false;
    default:
      issues.push({ row, message: `${field} must be TRUE or FALSE.` });
      return defaultValue;
  }
}

function csvRequiredBoolean(
  value: string | undefined,
  row: number,
  field: string,
  issues: CsvIssue[],
): boolean {
  if (!value) {
    issues.push({
      row,
      message: `${field} is required and must be TRUE or FALSE.`,
    });
    return false;
  }
  return csvBoolean(value, false, row, field, issues);
}

function productCsvCell(value: string | number | boolean | null): string {
  let normalized = value === null ? "" : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(normalized)) {
    normalized = `'${normalized}`;
  }
  return `"${normalized.replaceAll('"', '""')}"`;
}

function productCsvValue(value: string): string {
  return /^'[\s\u0000-\u001f]*[=+\-@]/u.test(value) ? value.slice(1) : value;
}

const updateProductSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    barcode: z.string().trim().max(80).nullable().optional(),
    unit: unitSchema.optional(),
    sellingPrice: moneySchema.optional(),
    taxClass: taxClassSchema.optional(),
    productType: productTypeSchema.optional(),
    tracksLots: z.boolean().optional(),
    isScEligible: z.boolean().optional(),
    isPwdEligible: z.boolean().optional(),
    bnpcEligible: z.boolean().optional(),
    bnpcCategory: bnpcCategorySchema.nullable().optional(),
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
  .refine((value) => Object.keys(value).length > 0, "empty_update")
  .superRefine((value, context) => {
    if (value.bnpcEligible === true && !value.bnpcCategory) {
      context.addIssue({
        code: "custom",
        path: ["bnpcCategory"],
        message: "bnpc_classification_review_required",
      });
    }
  });

const receiptSchema = z
  .object({
    productId: z.uuid(),
    quantity: z.number().int().min(1).max(MAX_QUANTITY),
    unitCost: moneySchema,
    reference: optionalNoteSchema,
    supplier: supplierSchema,
    lotCode: lotCodeSchema.optional(),
    expiryDate: expiryDateSchema.optional(),
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
type ReceiptInput = z.infer<typeof receiptSchema>;

const STOCK_RECEIPT_CSV_HEADERS = [
  "sku",
  "quantity",
  "unitcost",
  "reference",
  "supplier",
  "lotcode",
  "expirydate",
  "zerocostreason",
];

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
    lotId: z.uuid().optional(),
    lotCode: lotCodeSchema.optional(),
    expiryDate: expiryDateSchema.optional(),
    supplier: supplierSchema,
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

const lotEditSchema = z
  .object({
    quantity: z.number().int().min(0).max(MAX_QUANTITY),
    sellingPrice: moneySchema,
    expiryDate: expiryDateSchema,
    reason: reasonSchema,
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
  });

const stockCostCorrectionSchema = z
  .object({
    productId: z.uuid(),
    unitCost: moneySchema,
    reason: reasonSchema,
  })
  .strict();

type TaxClass = z.infer<typeof taxClassSchema>;
type UpdateProductInput = z.infer<typeof updateProductSchema>;
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
  bnpc_eligible: number;
  bnpc_category: "BASIC_NECESSITY" | "PRIME_COMMODITY" | null;
  product_type: "GENERIC" | "BRANDED" | null;
  product_type_applicable: number;
  tracks_lots: number;
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
  supplier: string | null;
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
    isBnpcEligible: row.bnpc_eligible === 1,
    bnpcCategory: row.bnpc_category,
    productType:
      row.product_type_applicable === 0 ? "NOT_APPLICABLE" : row.product_type,
    tracksLots: row.tracks_lots === 1,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function presentProduct(db: Database.Database, row: ProductRow) {
  const unallocated = unallocatedBalance(db, row.id);
  const lots = row.tracks_lots === 1 ? getLotBalances(db, row.id) : [];
  return {
    ...withBaseCost(row, grossProfitPolicy(db)),
    unallocatedQuantity: unallocated.quantity,
    saleableQuantity:
      row.tracks_lots === 1
        ? lots.reduce((sum, lot) => sum + lot.saleableQuantity, 0)
        : row.quantity_on_hand,
  };
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
    supplier?: string | null;
    reason: string | null;
    actorUserId: string;
    createdAt: string;
  },
): string {
  const id = event.id ?? randomUUID();
  db.prepare(
    `INSERT INTO stock_events
      (id, product_id, event_type, quantity_delta, unit_cost_centavos,
       inventory_value_delta_centavos, reference, supplier, reason, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    event.productId,
    event.type,
    event.quantityDelta,
    event.unitCostCents,
    event.inventoryValueDeltaCents,
    event.reference,
    event.supplier ?? null,
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
  const stockEventFilter = productId ? "WHERE e.product_id = ?" : "";
  const costCorrectionFilter = productId ? "WHERE c.product_id = ?" : "";
  const args = productId ? [productId, productId, limit] : [limit];
  return db
    .prepare(
      `SELECT * FROM (
         SELECT e.id, e.event_type, e.quantity_delta, e.unit_cost_centavos,
                e.inventory_value_delta_centavos, e.reference, e.supplier, e.reason, e.created_at,
                p.id AS product_id, p.sku, p.name AS product_name, u.email AS actor_email
         FROM stock_events e JOIN products p ON p.id = e.product_id
         LEFT JOIN users u ON u.id = e.actor_user_id
         ${stockEventFilter}
         UNION ALL
         SELECT c.id, 'COST_CORRECTION' AS event_type, 0 AS quantity_delta,
                c.new_unit_cost_centavos AS unit_cost_centavos,
                c.inventory_value_delta_centavos, NULL AS reference, NULL AS supplier,
                'Average acquisition cost corrected: ' ||
                  printf('%.2f', c.old_unit_cost_centavos / 100.0) || ' to ' ||
                  printf('%.2f', c.new_unit_cost_centavos / 100.0) || '. ' || c.reason AS reason,
                c.created_at, p.id AS product_id, p.sku, p.name AS product_name,
                u.email AS actor_email
         FROM stock_cost_corrections c JOIN products p ON p.id = c.product_id
         LEFT JOIN users u ON u.id = c.actor_user_id
         ${costCorrectionFilter}
       ) ORDER BY created_at DESC, id DESC LIMIT ?`,
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
    supplier: event.supplier,
    reason: event.reason,
    actorEmail: event.actor_email,
    createdAt: event.created_at,
  };
}

function getOrCreateLot(
  db: Database.Database,
  input: {
    productId: string;
    lotCode: string;
    expiryDate: string;
    actorUserId: string;
    createdAt: string;
  },
): string {
  const existing = db
    .prepare(
      "SELECT id FROM inventory_lots WHERE product_id = ? AND lot_code = ? AND expiry_date = ?",
    )
    .get(input.productId, input.lotCode, input.expiryDate) as
    | { id: string }
    | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO inventory_lots
       (id, product_id, lot_code, expiry_date, created_at, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.productId,
    input.lotCode,
    input.expiryDate,
    input.createdAt,
    input.actorUserId,
  );
  return id;
}

function expiryWarningDays(db: Database.Database): number {
  const row = db
    .prepare("SELECT value_json FROM settings WHERE key = 'inventory_expiry'")
    .get() as { value_json: string } | undefined;
  if (!row) return 30;
  try {
    const parsed = z
      .object({ warningDays: z.number().int().min(0).max(365) })
      .safeParse(JSON.parse(row.value_json));
    return parsed.success ? parsed.data.warningDays : 30;
  } catch {
    return 30;
  }
}

function addManilaDays(day: string, count: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function createProductRecord(
  db: Database.Database,
  input: CreateProductInput,
  actorUserId: string,
  now: string,
): { id: string; sku: string; generatedSku: boolean } {
  productFromBody(db, input);
  const sellingPriceCents = parseMoney(input.sellingPrice);
  const openingCostCents =
    input.openingUnitCost === undefined
      ? null
      : parseMoney(input.openingUnitCost);
  const inventoryValueCents =
    input.openingQuantity > 0 && openingCostCents !== null
      ? roundedInteger(new Decimal(input.openingQuantity).mul(openingCostCents))
      : 0;
  if (!Number.isSafeInteger(inventoryValueCents))
    throw new InventoryError(400, "inventory_value_overflow");

  const id = randomUUID();
  let sku = input.sku?.toUpperCase();
  if (!sku) {
    do {
      const sequence = db
        .prepare("INSERT INTO product_sku_sequence DEFAULT VALUES")
        .run();
      sku = `MTX-${String(sequence.lastInsertRowid).padStart(6, "0")}`;
    } while (
      db.prepare("SELECT 1 FROM products WHERE sku = ? COLLATE NOCASE").get(sku)
    );
  }
  db.prepare(
    `INSERT INTO products
      (id, sku, name, barcode, unit, selling_price_centavos, tax_class,
       sc_pwd_eligible, sc_eligible, pwd_eligible, product_type,
       product_type_applicable, tracks_lots,
       quantity_on_hand, inventory_value_centavos,
       reorder_level, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    sku,
    input.name,
    input.barcode?.trim() || null,
    input.unit,
    sellingPriceCents,
    input.taxClass,
    input.isScEligible || input.isPwdEligible ? 1 : 0,
    input.isScEligible ? 1 : 0,
    input.isPwdEligible ? 1 : 0,
    input.productType === "NOT_APPLICABLE" ? null : input.productType,
    input.productType === "NOT_APPLICABLE" ? 0 : 1,
    input.tracksLots ? 1 : 0,
    input.openingQuantity,
    inventoryValueCents,
    input.reorderLevel ?? null,
    now,
    now,
  );
  if (input.bnpcEligible) {
    db.prepare(
      `UPDATE products SET bnpc_eligible = 1, bnpc_category = ?,
         bnpc_prescription_required = 0, bnpc_reviewed_at = ?,
         bnpc_reviewed_by_user_id = ? WHERE id = ?`,
    ).run(input.bnpcCategory!, now, actorUserId, id);
  }
  if (input.openingQuantity > 0 && openingCostCents !== null) {
    const stockEventId = writeStockEvent(db, {
      productId: id,
      type: "OPENING",
      quantityDelta: input.openingQuantity,
      unitCostCents: openingCostCents,
      inventoryValueDeltaCents: inventoryValueCents,
      reference: input.openingReference || null,
      supplier: input.openingSupplier ?? null,
      reason: openingCostCents === 0 ? (input.zeroCostReason ?? null) : null,
      actorUserId,
      createdAt: now,
    });
    const lotId = input.tracksLots
      ? getOrCreateLot(db, {
          productId: id,
          lotCode: input.openingLotCode!,
          expiryDate: input.openingExpiryDate!,
          actorUserId,
          createdAt: now,
        })
      : null;
    writeLotMovement(db, {
      productId: id,
      lotId,
      type: "OPENING",
      stockEventId,
      quantityDelta: input.openingQuantity,
      inventoryValueDeltaCentavos: inventoryValueCents,
      unitCostCentavos: openingCostCents,
      actorUserId,
      createdAt: now,
    });
  }
  writeAuditEvent(db, {
    actorUserId,
    action: "product.created",
    entityType: "product",
    entityId: id,
    details: {
      sku,
      name: input.name,
      productType: input.productType,
      tracksLots: input.tracksLots,
      isScEligible: input.isScEligible,
      isPwdEligible: input.isPwdEligible,
      isBnpcEligible: input.bnpcEligible,
      bnpcCategory: input.bnpcEligible ? input.bnpcCategory : null,
      openingQuantity: input.openingQuantity,
      openingReference: input.openingReference || null,
      taxClass: input.taxClass,
    },
  });
  return { id, sku, generatedSku: !input.sku };
}

function receiveStockRecord(
  db: Database.Database,
  input: ReceiptInput,
  actorUserId: string,
  now: string,
): string {
  const costCents = parseMoney(input.unitCost);
  const valueDelta = roundedInteger(new Decimal(costCents).mul(input.quantity));
  const product = db
    .prepare(
      "SELECT id, sku, name, tracks_lots, quantity_on_hand, inventory_value_centavos FROM products WHERE id = ?",
    )
    .get(input.productId) as
    | {
        id: string;
        sku: string;
        name: string;
        tracks_lots: number;
        quantity_on_hand: number;
        inventory_value_centavos: number;
      }
    | undefined;
  if (!product) throw new InventoryError(404, "product_not_found");
  if (product.tracks_lots === 1) {
    if (!input.lotCode || !input.expiryDate)
      throw new InventoryError(400, "receipt_lot_required");
    if (input.expiryDate < manilaCalendarDate())
      throw new InventoryError(409, "expired_lot_not_allowed");
  }
  const quantity = product.quantity_on_hand + input.quantity;
  const inventoryValue = product.inventory_value_centavos + valueDelta;
  if (quantity > MAX_QUANTITY || !Number.isSafeInteger(inventoryValue)) {
    throw new InventoryError(400, "inventory_value_overflow");
  }
  db.prepare(
    "UPDATE products SET quantity_on_hand = ?, inventory_value_centavos = ?, updated_at = ? WHERE id = ?",
  ).run(quantity, inventoryValue, now, product.id);
  const stockEventId = writeStockEvent(db, {
    productId: product.id,
    type: "RECEIPT",
    quantityDelta: input.quantity,
    unitCostCents: costCents,
    inventoryValueDeltaCents: valueDelta,
    reference: input.reference || null,
    supplier: input.supplier || null,
    reason: costCents === 0 ? (input.zeroCostReason ?? null) : null,
    actorUserId,
    createdAt: now,
  });
  const lotId =
    product.tracks_lots === 1
      ? getOrCreateLot(db, {
          productId: product.id,
          lotCode: input.lotCode!,
          expiryDate: input.expiryDate!,
          actorUserId,
          createdAt: now,
        })
      : null;
  writeLotMovement(db, {
    productId: product.id,
    lotId,
    type: "RECEIPT",
    stockEventId,
    quantityDelta: input.quantity,
    inventoryValueDeltaCentavos: valueDelta,
    unitCostCentavos: costCents,
    actorUserId,
    createdAt: now,
  });
  writeAuditEvent(db, {
    actorUserId,
    action: "stock.received",
    entityType: "product",
    entityId: product.id,
    details: {
      sku: product.sku,
      quantity: input.quantity,
      unitCostCentavos: costCents,
      reference: input.reference ?? null,
      supplier: input.supplier ?? null,
      lotCode: input.lotCode ?? null,
      expiryDate: input.expiryDate ?? null,
    },
  });
  return product.id;
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
    const today = manilaCalendarDate();
    const products = listProducts(db, parsed.data, true).map((row) => {
      const lots =
        row.tracks_lots === 1 ? getLotBalances(db, row.id, today) : [];
      const quantityAvailable =
        row.tracks_lots === 1
          ? lots.reduce((sum, lot) => sum + lot.saleableQuantity, 0)
          : row.quantity_on_hand;
      return {
        id: row.id,
        sku: row.sku,
        name: row.name,
        barcode: row.barcode,
        unit: row.unit,
        sellingPrice: money(row.selling_price_centavos),
        taxClass: row.tax_class,
        isScEligible: row.sc_eligible === 1,
        isPwdEligible: row.pwd_eligible === 1,
        isBnpcEligible: row.bnpc_eligible === 1,
        bnpcCategory: row.bnpc_category,
        productType:
          row.product_type_applicable === 0
            ? "NOT_APPLICABLE"
            : row.product_type,
        tracksLots: row.tracks_lots === 1,
        physicalQuantity: row.quantity_on_hand,
        quantityAvailable,
        assignedLots: lots
          .filter((lot) => lot.saleableQuantity > 0)
          .map((lot) => ({
            lotId: lot.id,
            lotCode: lot.lotCode,
            expiryDate: lot.expiryDate,
            quantityAvailable: lot.saleableQuantity,
          })),
      };
    });
    res.json({ products });
  });

  router.get("/products", requireAuth, requireOwner, (req, res) => {
    const parsed = z
      .string()
      .trim()
      .max(120)
      .safeParse(req.query.q ?? "");
    if (!parsed.success) return bodyValidation(res);
    res.json({
      products: listProducts(db, parsed.data).map((product) =>
        presentProduct(db, product),
      ),
    });
  });

  router.get("/products/export-csv", requireAuth, requireOwner, (_req, res) => {
    const products = db
      .prepare(`${baseProductSelect()} ORDER BY p.name COLLATE NOCASE, p.sku`)
      .all() as ProductRow[];
    const rows: Array<Array<string | number | boolean | null>> = [
      PRODUCT_UPDATE_CSV_HEADERS,
    ];
    for (const row of products) {
      const product = presentProduct(db, row);
      rows.push([
        product.sku,
        product.name,
        product.barcode,
        product.unit,
        product.sellingPrice,
        product.taxClass,
        product.productType,
        product.isScEligible,
        product.isPwdEligible,
        product.isBnpcEligible,
        product.bnpcCategory,
        product.tracksLots,
        product.reorderLevel,
        product.active,
        product.quantityOnHand,
        product.saleableQuantity,
        product.latestAcquisitionCost,
        product.weightedAverageUnitCost,
        product.inventoryValue,
        product.unitPriceSpread,
        product.estimatedUnitGrossProfit,
        product.grossProfitEstimateApproved,
      ]);
    }
    const csv = rows
      .map((row) => row.map(productCsvCell).join(","))
      .join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="products.csv"');
    res.send(csv);
  });

  router.post(
    "/products/update-csv",
    requireAuth,
    requireOwner,
    csrf,
    express.text({ type: "text/csv", limit: "256kb" }),
    (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: "authentication_required" });
        return;
      }
      const document = parseCsvRows(
        req.body,
        PRODUCT_UPDATE_CSV_HEADERS,
        PRODUCT_UPDATE_CSV_REQUIRED_HEADERS,
      );
      if (document.issues.length) {
        res.status(400).json({
          error: "csv_import_invalid",
          rowErrors: document.issues,
        });
        return;
      }

      const rowErrors: CsvIssue[] = [];
      const updates: Array<{
        row: number;
        sku: string;
        current: ProductRow;
        input: UpdateProductInput;
      }> = [];
      const seenSkus = new Set<string>();
      const seenBarcodes = new Set<string>();
      for (const row of document.rows) {
        const values = row.values;
        const sku = skuSchema.safeParse(values.sku);
        if (!sku.success) {
          rowErrors.push({ row: row.row, message: "SKU is invalid." });
          continue;
        }
        const normalizedSku = sku.data.toUpperCase();
        if (seenSkus.has(normalizedSku)) {
          rowErrors.push({
            row: row.row,
            message: "SKU repeats in this file.",
          });
          continue;
        }
        seenSkus.add(normalizedSku);
        const match = db
          .prepare("SELECT id FROM products WHERE sku = ? COLLATE NOCASE")
          .get(sku.data) as { id: string } | undefined;
        const current = match ? findProduct(db, match.id) : undefined;
        if (!current) {
          rowErrors.push({ row: row.row, message: "SKU does not exist." });
          continue;
        }

        const isScEligible = csvRequiredBoolean(
          values.issceligible,
          row.row,
          "isScEligible",
          rowErrors,
        );
        const isPwdEligible = csvRequiredBoolean(
          values.ispwdeligible,
          row.row,
          "isPwdEligible",
          rowErrors,
        );
        const bnpcEligible = csvRequiredBoolean(
          values.bnpceligible,
          row.row,
          "bnpcEligible",
          rowErrors,
        );
        const tracksLots = csvRequiredBoolean(
          values.trackslots,
          row.row,
          "tracksLots",
          rowErrors,
        );
        const active = csvRequiredBoolean(
          values.active,
          row.row,
          "active",
          rowErrors,
        );
        const candidate = {
          name: productCsvValue(values.name ?? ""),
          barcode: values.barcode ? productCsvValue(values.barcode) : null,
          unit: productCsvValue(values.unit ?? ""),
          sellingPrice: values.sellingprice ?? "",
          taxClass: values.taxclass?.toUpperCase(),
          ...(values.producttype
            ? { productType: values.producttype.toUpperCase() }
            : {}),
          isScEligible,
          isPwdEligible,
          bnpcEligible,
          bnpcCategory: values.bnpccategory
            ? values.bnpccategory.toUpperCase()
            : null,
          tracksLots,
          reorderLevel:
            values.reorderlevel === "" || values.reorderlevel === undefined
              ? null
              : Number(values.reorderlevel),
          active,
        };
        const parsed = updateProductSchema.safeParse(candidate);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            rowErrors.push({
              row: row.row,
              message: `${issue.path.join(".") || "row"}: ${issue.message}`,
            });
          }
          continue;
        }
        try {
          productFromBody(db, parsed.data);
          if (
            parsed.data.sellingPrice !== undefined &&
            parseMoney(parsed.data.sellingPrice) <= 0
          ) {
            throw new InventoryError(400, "selling_price_must_be_positive");
          }
        } catch (error) {
          if (error instanceof InventoryError) {
            rowErrors.push({ row: row.row, message: error.code });
          } else {
            throw error;
          }
        }
        if (parsed.data.unit && parsed.data.unit !== current.unit) {
          const history = db
            .prepare("SELECT 1 FROM stock_events WHERE product_id = ? LIMIT 1")
            .get(current.id);
          if (current.quantity_on_hand > 0 || history) {
            rowErrors.push({
              row: row.row,
              message: "unit_locked_after_stock_history",
            });
          }
        }
        if (parsed.data.tracksLots === false && current.tracks_lots === 1) {
          const activeLot = db
            .prepare(
              `SELECT 1 FROM inventory_lots l
               JOIN lot_stock_movements m ON m.lot_id = l.id
               WHERE l.product_id = ? GROUP BY l.id
               HAVING sum(m.quantity_delta) > 0 LIMIT 1`,
            )
            .get(current.id);
          if (current.quantity_on_hand > 0 || activeLot) {
            rowErrors.push({
              row: row.row,
              message: "active_lots_require_tracking",
            });
          }
        }
        if (parsed.data.barcode) {
          const barcode = parsed.data.barcode.toLowerCase();
          if (seenBarcodes.has(barcode)) {
            rowErrors.push({
              row: row.row,
              message: "Barcode repeats in this file.",
            });
          } else {
            const owner = db
              .prepare(
                "SELECT id FROM products WHERE barcode = ? COLLATE NOCASE",
              )
              .get(parsed.data.barcode) as { id: string } | undefined;
            if (owner && owner.id !== current.id) {
              rowErrors.push({
                row: row.row,
                message: "Barcode already exists.",
              });
            }
          }
          seenBarcodes.add(barcode);
        }
        updates.push({
          row: row.row,
          sku: current.sku,
          current,
          input: parsed.data,
        });
      }
      if (rowErrors.length) {
        res.status(400).json({ error: "csv_import_invalid", rowErrors });
        return;
      }

      try {
        const now = new Date().toISOString();
        const updated = db.transaction(() =>
          updates.map(({ current, input }) =>
            applyProductUpdate(db, current, input, req.user!.id, now),
          ),
        )();
        res.status(200).json({
          updatedCount: updated.length,
          products: updated.map((product) => ({
            id: product.id,
            sku: product.sku,
          })),
        });
      } catch (error) {
        if (!handleInventoryError(error, res)) throw error;
      }
    },
  );

  router.post(
    "/products/import-csv",
    requireAuth,
    requireOwner,
    csrf,
    express.text({ type: "text/csv", limit: "256kb" }),
    (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: "authentication_required" });
        return;
      }
      const document = parseCsvRows(req.body, PRODUCT_CSV_HEADERS, [
        "name",
        "unit",
        "sellingprice",
        "taxclass",
        "producttype",
        "openingquantity",
      ]);
      if (document.issues.length) {
        res.status(400).json({
          error: "csv_import_invalid",
          rowErrors: document.issues,
        });
        return;
      }

      const rowErrors: CsvIssue[] = [];
      const productRows: Array<{ row: number; input: CreateProductInput }> = [];
      const seenSkus = new Set<string>();
      const seenBarcodes = new Set<string>();
      for (const row of document.rows) {
        const values = row.values;
        const isScEligible = csvBoolean(
          values.issceligible,
          false,
          row.row,
          "isScEligible",
          rowErrors,
        );
        const isPwdEligible = csvBoolean(
          values.ispwdeligible,
          false,
          row.row,
          "isPwdEligible",
          rowErrors,
        );
        const bnpcEligible = csvBoolean(
          values.bnpceligible,
          false,
          row.row,
          "bnpcEligible",
          rowErrors,
        );
        const tracksLots = csvBoolean(
          values.trackslots,
          false,
          row.row,
          "tracksLots",
          rowErrors,
        );
        const openingQuantity =
          values.openingquantity === "" ? 0 : Number(values.openingquantity);
        const reorderLevel =
          values.reorderlevel === undefined || values.reorderlevel === ""
            ? null
            : Number(values.reorderlevel);
        const candidate = {
          ...(values.sku ? { sku: values.sku } : {}),
          name: values.name ?? "",
          ...(values.barcode ? { barcode: values.barcode } : {}),
          unit: values.unit ?? "",
          sellingPrice: values.sellingprice ?? "",
          taxClass: values.taxclass?.toUpperCase(),
          productType: values.producttype?.toUpperCase(),
          isScEligible,
          isPwdEligible,
          bnpcEligible,
          ...(values.bnpccategory
            ? { bnpcCategory: values.bnpccategory.toUpperCase() }
            : {}),
          tracksLots,
          openingQuantity,
          ...(values.openingunitcost
            ? { openingUnitCost: values.openingunitcost }
            : {}),
          reorderLevel,
          ...(values.openingreference
            ? { openingReference: values.openingreference }
            : {}),
          ...(values.openinglotcode
            ? { openingLotCode: values.openinglotcode }
            : {}),
          ...(values.openingexpirydate
            ? { openingExpiryDate: values.openingexpirydate }
            : {}),
          ...(values.openingsupplier
            ? { openingSupplier: values.openingsupplier }
            : {}),
          ...(values.zerocostreason
            ? { zeroCostReason: values.zerocostreason }
            : {}),
        };
        const parsed = createProductSchema.safeParse(candidate);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            rowErrors.push({
              row: row.row,
              message: `${issue.path.join(".") || "row"}: ${issue.message}`,
            });
          }
          continue;
        }
        try {
          productFromBody(db, parsed.data);
        } catch (error) {
          if (error instanceof InventoryError) {
            rowErrors.push({ row: row.row, message: error.code });
          } else {
            throw error;
          }
        }
        if (parsed.data.sku) {
          const sku = parsed.data.sku.toUpperCase();
          if (seenSkus.has(sku)) {
            rowErrors.push({
              row: row.row,
              message: "SKU repeats in this file.",
            });
          } else if (
            db
              .prepare("SELECT 1 FROM products WHERE sku = ? COLLATE NOCASE")
              .get(sku)
          ) {
            rowErrors.push({ row: row.row, message: "SKU already exists." });
          }
          seenSkus.add(sku);
        }
        if (parsed.data.barcode) {
          const barcode = parsed.data.barcode.toLowerCase();
          if (seenBarcodes.has(barcode)) {
            rowErrors.push({
              row: row.row,
              message: "Barcode repeats in this file.",
            });
          } else if (
            db
              .prepare(
                "SELECT 1 FROM products WHERE barcode = ? COLLATE NOCASE",
              )
              .get(parsed.data.barcode)
          ) {
            rowErrors.push({
              row: row.row,
              message: "Barcode already exists.",
            });
          }
          seenBarcodes.add(barcode);
        }
        productRows.push({ row: row.row, input: parsed.data });
      }
      if (rowErrors.length) {
        res.status(400).json({ error: "csv_import_invalid", rowErrors });
        return;
      }

      try {
        const now = new Date().toISOString();
        const created = db.transaction(() =>
          productRows.map(({ input }) =>
            createProductRecord(db, input, req.user!.id, now),
          ),
        )();
        res.status(201).json({
          createdCount: created.length,
          products: created.map(({ id, sku }) => ({ id, sku })),
        });
      } catch (error) {
        if (!handleInventoryError(error, res)) throw error;
      }
    },
  );

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
             product_type_applicable, tracks_lots,
             quantity_on_hand, inventory_value_centavos,
             reorder_level, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
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
          parsed.data.productType === "NOT_APPLICABLE"
            ? null
            : parsed.data.productType,
          parsed.data.productType === "NOT_APPLICABLE" ? 0 : 1,
          parsed.data.tracksLots ? 1 : 0,
          parsed.data.openingQuantity,
          inventoryValueCents,
          parsed.data.reorderLevel ?? null,
          now,
          now,
        );
        if (parsed.data.bnpcEligible) {
          db.prepare(
            `UPDATE products SET bnpc_eligible = 1, bnpc_category = ?,
               bnpc_prescription_required = 0, bnpc_reviewed_at = ?,
               bnpc_reviewed_by_user_id = ? WHERE id = ?`,
          ).run(parsed.data.bnpcCategory!, now, req.user!.id, id);
        }
        if (parsed.data.openingQuantity > 0 && openingCostCents !== null) {
          const stockEventId = writeStockEvent(db, {
            productId: id,
            type: "OPENING",
            quantityDelta: parsed.data.openingQuantity,
            unitCostCents: openingCostCents,
            inventoryValueDeltaCents: inventoryValueCents,
            reference: parsed.data.openingReference || null,
            supplier: parsed.data.openingSupplier ?? null,
            reason:
              openingCostCents === 0
                ? (parsed.data.zeroCostReason ?? null)
                : null,
            actorUserId: req.user!.id,
            createdAt: now,
          });
          const lotId = parsed.data.tracksLots
            ? getOrCreateLot(db, {
                productId: id,
                lotCode: parsed.data.openingLotCode!,
                expiryDate: parsed.data.openingExpiryDate!,
                actorUserId: req.user!.id,
                createdAt: now,
              })
            : null;
          writeLotMovement(db, {
            productId: id,
            lotId,
            type: "OPENING",
            stockEventId,
            quantityDelta: parsed.data.openingQuantity,
            inventoryValueDeltaCentavos: inventoryValueCents,
            unitCostCentavos: openingCostCents,
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
            tracksLots: parsed.data.tracksLots,
            isScEligible: parsed.data.isScEligible,
            isPwdEligible: parsed.data.isPwdEligible,
            isBnpcEligible: parsed.data.bnpcEligible,
            bnpcCategory: parsed.data.bnpcEligible
              ? parsed.data.bnpcCategory
              : null,
            openingQuantity: parsed.data.openingQuantity,
            openingReference: parsed.data.openingReference || null,
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
      const updated = applyProductUpdate(
        db,
        current,
        parsed.data,
        req.user.id,
        new Date().toISOString(),
      );
      res.json({ product: presentProduct(db, updated) });
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
    res.json({
      products: products.map((product) => presentProduct(db, product)),
      lowStockCount: products.filter(isLowStock).length,
    });
  });

  router.get("/stock/lots", requireAuth, requireOwner, (_req, res) => {
    const today = manilaCalendarDate();
    const warningDays = expiryWarningDays(db);
    const alertDate = addManilaDays(today, warningDays);
    const products = db
      .prepare(
        `SELECT id, sku, name, tracks_lots, quantity_on_hand,
                inventory_value_centavos, selling_price_centavos
         FROM products WHERE tracks_lots = 1
         ORDER BY name COLLATE NOCASE`,
      )
      .all() as Array<{
      id: string;
      sku: string;
      name: string;
      tracks_lots: number;
      quantity_on_hand: number;
      inventory_value_centavos: number;
      selling_price_centavos: number;
    }>;
    const lots = products.flatMap((product) =>
      getLotBalances(db, product.id, today).map((lot) => ({
        ...lot,
        sku: product.sku,
        productName: product.name,
        sellingPrice: money(product.selling_price_centavos),
        alert:
          lot.quantity <= 0
            ? null
            : lot.expiryDate < today
              ? "EXPIRED"
              : lot.expiryDate <= alertDate
                ? "NEAR_EXPIRY"
                : null,
      })),
    );
    res.json({
      asOf: today,
      warningDays,
      lots,
      unallocated: products.map((product) => ({
        productId: product.id,
        sku: product.sku,
        productName: product.name,
        quantity: unallocatedBalance(db, product.id).quantity,
      })),
      alertCount: lots.filter((lot) => lot.alert !== null).length,
    });
  });

  router.get(
    "/settings/expiry-warning",
    requireAuth,
    requireOwner,
    (_req, res) => {
      res.json({ warningDays: expiryWarningDays(db) });
    },
  );

  router.put(
    "/settings/expiry-warning",
    requireAuth,
    requireOwner,
    csrf,
    (req, res) => {
      const parsed = z
        .object({ warningDays: z.number().int().min(0).max(365) })
        .strict()
        .safeParse(req.body);
      if (!parsed.success || !req.user) return bodyValidation(res);
      const now = new Date().toISOString();
      db.transaction(() => {
        db.prepare(
          `INSERT INTO settings (key, value_json, updated_at, updated_by)
           VALUES ('inventory_expiry', ?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
             updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        ).run(JSON.stringify(parsed.data), now, req.user!.id);
        writeAuditEvent(db, {
          actorUserId: req.user!.id,
          action: "inventory.expiry_warning_updated",
          entityType: "setting",
          entityId: "inventory_expiry",
          details: parsed.data,
        });
      })();
      res.json(parsed.data);
    },
  );

  router.post(
    "/stock/lots/reconcile",
    requireAuth,
    requireOwner,
    csrf,
    (req, res) => {
      const parsed = z
        .object({
          productId: z.uuid(),
          reason: reasonSchema,
          physicalCountConfirmed: z.literal(true),
          allocations: z
            .array(
              z
                .object({
                  lotCode: lotCodeSchema,
                  expiryDate: expiryDateSchema,
                  quantity: z.number().int().min(1).max(MAX_QUANTITY),
                })
                .strict(),
            )
            .min(1)
            .max(100),
        })
        .strict()
        .safeParse(req.body);
      if (!parsed.success || !req.user) return bodyValidation(res);
      try {
        const reconciliationId = db.transaction(() => {
          const product = db
            .prepare("SELECT id, sku, tracks_lots FROM products WHERE id = ?")
            .get(parsed.data.productId) as
            | { id: string; sku: string; tracks_lots: number }
            | undefined;
          if (!product) throw new InventoryError(404, "product_not_found");
          if (product.tracks_lots !== 1)
            throw new InventoryError(409, "product_does_not_track_lots");
          const current = unallocatedBalance(db, product.id);
          const totalQuantity = parsed.data.allocations.reduce(
            (sum, allocation) => sum + allocation.quantity,
            0,
          );
          if (totalQuantity > current.quantity)
            throw new InventoryError(409, "insufficient_unallocated_stock");
          let remainingQuantity = totalQuantity;
          let remainingValue =
            totalQuantity === current.quantity
              ? current.valueCentavos
              : roundedInteger(
                  new Decimal(current.valueCentavos)
                    .mul(totalQuantity)
                    .div(current.quantity),
                );
          const valueAllocations = parsed.data.allocations.map((allocation) => {
            const valueCentavos =
              allocation.quantity === remainingQuantity
                ? remainingValue
                : roundedInteger(
                    new Decimal(remainingValue)
                      .mul(allocation.quantity)
                      .div(remainingQuantity),
                  );
            remainingQuantity -= allocation.quantity;
            remainingValue -= valueCentavos;
            return { ...allocation, valueCentavos };
          });
          const transferredValue = valueAllocations.reduce(
            (sum, allocation) => sum + allocation.valueCentavos,
            0,
          );
          const now = new Date().toISOString();
          const id = randomUUID();
          db.prepare(
            `INSERT INTO lot_reconciliations
              (id, product_id, reason, actor_user_id, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(id, product.id, parsed.data.reason, req.user!.id, now);
          writeLotMovement(db, {
            productId: product.id,
            lotId: null,
            type: "RECONCILIATION_OUT",
            reconciliationId: id,
            quantityDelta: -totalQuantity,
            inventoryValueDeltaCentavos: -transferredValue,
            unitCostCentavos:
              totalQuantity > 0
                ? roundedInteger(
                    new Decimal(transferredValue).div(totalQuantity),
                  )
                : null,
            reason: parsed.data.reason,
            actorUserId: req.user!.id,
            createdAt: now,
          });
          const insertLotIn = db.prepare(
            `INSERT INTO lot_stock_movements
              (id, product_id, lot_id, movement_type, reconciliation_id,
               quantity_delta, inventory_value_delta_centavos,
               unit_cost_centavos, reason,
               actor_user_id, created_at)
             VALUES (?, ?, ?, 'RECONCILIATION_IN', ?, ?, ?, ?, ?, ?, ?)`,
          );
          for (const allocation of valueAllocations) {
            const lotId = getOrCreateLot(db, {
              productId: product.id,
              lotCode: allocation.lotCode,
              expiryDate: allocation.expiryDate,
              actorUserId: req.user!.id,
              createdAt: now,
            });
            insertLotIn.run(
              randomUUID(),
              product.id,
              lotId,
              id,
              allocation.quantity,
              allocation.valueCentavos,
              roundedInteger(
                new Decimal(allocation.valueCentavos).div(allocation.quantity),
              ),
              parsed.data.reason,
              req.user!.id,
              now,
            );
          }
          writeAuditEvent(db, {
            actorUserId: req.user!.id,
            action: "stock.legacy_lots_reconciled",
            entityType: "lot_reconciliation",
            entityId: id,
            details: {
              sku: product.sku,
              physicalCountConfirmed: true,
              quantity: totalQuantity,
              reason: parsed.data.reason,
              allocations: valueAllocations,
            },
          });
          return id;
        })();
        res.status(201).json({ reconciliationId, reconciliation: "recorded" });
      } catch (error) {
        if (!handleInventoryError(error, res)) throw error;
      }
    },
  );

  router.patch(
    "/stock/lots/:id",
    requireAuth,
    requireOwner,
    csrf,
    (req, res) => {
      const lotId = z.uuid().safeParse(req.params.id);
      const parsed = lotEditSchema.safeParse(req.body);
      if (!lotId.success || !parsed.success || !req.user)
        return bodyValidation(res);
      try {
        const result = db.transaction(() => {
          const lot = db
            .prepare(
              `SELECT l.id, l.product_id, l.lot_code, l.expiry_date,
                      p.sku, p.tracks_lots, p.quantity_on_hand,
                      p.inventory_value_centavos, p.selling_price_centavos
               FROM inventory_lots l JOIN products p ON p.id = l.product_id
               WHERE l.id = ?`,
            )
            .get(lotId.data) as
            | {
                id: string;
                product_id: string;
                lot_code: string;
                expiry_date: string;
                sku: string;
                tracks_lots: number;
                quantity_on_hand: number;
                inventory_value_centavos: number;
                selling_price_centavos: number;
              }
            | undefined;
          if (!lot) throw new InventoryError(404, "lot_not_found");
          if (lot.tracks_lots !== 1)
            throw new InventoryError(409, "product_does_not_track_lots");
          const balance = getLotBalances(db, lot.product_id).find(
            (entry) => entry.id === lot.id,
          );
          if (!balance) throw new InventoryError(404, "lot_not_found");

          const priceCents = parseMoney(parsed.data.sellingPrice);
          const quantityDelta = parsed.data.quantity - balance.quantity;
          const nextQuantity = lot.quantity_on_hand + quantityDelta;
          if (nextQuantity < 0 || nextQuantity > MAX_QUANTITY)
            throw new InventoryError(409, "invalid_inventory_adjustment");
          if (
            quantityDelta > 0 &&
            parsed.data.expiryDate < manilaCalendarDate()
          ) {
            throw new InventoryError(409, "expired_lot_not_allowed");
          }

          const conflictingLot = db
            .prepare(
              `SELECT 1 FROM inventory_lots
               WHERE product_id = ? AND lot_code = ? AND expiry_date = ? AND id <> ?`,
            )
            .get(lot.product_id, lot.lot_code, parsed.data.expiryDate, lot.id);
          if (conflictingLot)
            throw new InventoryError(409, "lot_expiry_conflict");

          let valueDelta = 0;
          let unitCostCents: number | null = null;
          if (quantityDelta > 0) {
            unitCostCents =
              lot.quantity_on_hand === 0
                ? 0
                : roundedInteger(
                    new Decimal(lot.inventory_value_centavos).div(
                      lot.quantity_on_hand,
                    ),
                  );
            valueDelta = roundedInteger(
              new Decimal(unitCostCents).mul(quantityDelta),
            );
          } else if (quantityDelta < 0) {
            const removedQuantity = Math.abs(quantityDelta);
            if (removedQuantity > lot.quantity_on_hand)
              throw new InventoryError(409, "insufficient_stock");
            const removedValue = roundedInteger(
              removedQuantity === lot.quantity_on_hand
                ? new Decimal(lot.inventory_value_centavos)
                : new Decimal(lot.inventory_value_centavos)
                    .mul(removedQuantity)
                    .div(lot.quantity_on_hand),
            );
            unitCostCents = roundedInteger(
              new Decimal(removedValue).div(removedQuantity),
            );
            valueDelta = -removedValue;
          }
          const nextValue = lot.inventory_value_centavos + valueDelta;
          if (nextValue < 0 || !Number.isSafeInteger(nextValue))
            throw new InventoryError(409, "invalid_inventory_adjustment");

          const now = new Date().toISOString();
          if (quantityDelta !== 0) {
            const reason = `COUNT_CORRECTION: ${parsed.data.reason}`;
            const stockEventId = writeStockEvent(db, {
              productId: lot.product_id,
              type: "ADJUSTMENT",
              quantityDelta,
              unitCostCents,
              inventoryValueDeltaCents: valueDelta,
              reference: lot.lot_code,
              reason,
              actorUserId: req.user!.id,
              createdAt: now,
            });
            writeLotMovement(db, {
              productId: lot.product_id,
              lotId: lot.id,
              type: "ADJUSTMENT",
              stockEventId,
              quantityDelta,
              inventoryValueDeltaCentavos: valueDelta,
              unitCostCentavos: unitCostCents,
              reason,
              actorUserId: req.user!.id,
              createdAt: now,
            });
          }

          const priceChanged = priceCents !== lot.selling_price_centavos;
          const expiryChanged = parsed.data.expiryDate !== lot.expiry_date;
          if (quantityDelta !== 0 || priceChanged || expiryChanged) {
            db.prepare(
              `UPDATE products
               SET quantity_on_hand = ?, inventory_value_centavos = ?,
                   selling_price_centavos = ?, updated_at = ?
               WHERE id = ?`,
            ).run(nextQuantity, nextValue, priceCents, now, lot.product_id);
            if (expiryChanged) {
              db.prepare(
                "UPDATE inventory_lots SET expiry_date = ? WHERE id = ?",
              ).run(parsed.data.expiryDate, lot.id);
            }
            writeAuditEvent(db, {
              actorUserId: req.user!.id,
              action: "stock.lot_details_updated",
              entityType: "inventory_lot",
              entityId: lot.id,
              details: {
                sku: lot.sku,
                lotCode: lot.lot_code,
                reason: parsed.data.reason,
                old: {
                  expiryDate: lot.expiry_date,
                  quantity: balance.quantity,
                  sellingPrice: money(lot.selling_price_centavos),
                },
                new: {
                  expiryDate: parsed.data.expiryDate,
                  quantity: parsed.data.quantity,
                  sellingPrice: money(priceCents),
                },
                quantityDelta,
                inventoryValueDeltaCentavos: valueDelta,
                at: now,
              },
            });
          }
          return {
            lotId: lot.id,
            expiryDate: parsed.data.expiryDate,
            quantity: parsed.data.quantity,
            sellingPrice: money(priceCents),
          };
        })();
        res.json(result);
      } catch (error) {
        if (!handleInventoryError(error, res)) throw error;
      }
    },
  );

  router.patch(
    "/stock/lots/:id/expiry",
    requireAuth,
    requireOwner,
    csrf,
    (req, res) => {
      const lotId = z.uuid().safeParse(req.params.id);
      const parsed = z
        .object({ expiryDate: expiryDateSchema, reason: reasonSchema })
        .strict()
        .safeParse(req.body);
      if (!lotId.success || !parsed.success || !req.user)
        return bodyValidation(res);
      const lot = db
        .prepare(
          "SELECT id, product_id, lot_code, expiry_date FROM inventory_lots WHERE id = ?",
        )
        .get(lotId.data) as
        | {
            id: string;
            product_id: string;
            lot_code: string;
            expiry_date: string;
          }
        | undefined;
      if (!lot) return res.status(404).json({ error: "lot_not_found" });
      if (lot.expiry_date === parsed.data.expiryDate) {
        return res.json({ lotId: lot.id, expiryDate: lot.expiry_date });
      }
      const conflictingLot = db
        .prepare(
          `SELECT 1 FROM inventory_lots
           WHERE product_id = ? AND lot_code = ? AND expiry_date = ? AND id <> ?`,
        )
        .get(lot.product_id, lot.lot_code, parsed.data.expiryDate, lot.id);
      if (conflictingLot)
        return res.status(409).json({ error: "lot_expiry_conflict" });
      const updatedAt = new Date().toISOString();
      db.transaction(() => {
        db.prepare(
          "UPDATE inventory_lots SET expiry_date = ? WHERE id = ?",
        ).run(parsed.data.expiryDate, lot.id);
        writeAuditEvent(db, {
          actorUserId: req.user!.id,
          action: "stock.lot_expiry_updated",
          entityType: "inventory_lot",
          entityId: lot.id,
          details: {
            productId: lot.product_id,
            lotCode: lot.lot_code,
            oldExpiryDate: lot.expiry_date,
            expiryDate: parsed.data.expiryDate,
            reason: parsed.data.reason,
            at: updatedAt,
          },
        });
      })();
      res.json({ lotId: lot.id, expiryDate: parsed.data.expiryDate });
    },
  );

  router.patch(
    "/stock/lots/:id/quarantine",
    requireAuth,
    requireOwner,
    csrf,
    (req, res) => {
      const lotId = z.uuid().safeParse(req.params.id);
      const parsed = z
        .object({ quarantined: z.boolean(), reason: reasonSchema })
        .strict()
        .safeParse(req.body);
      if (!lotId.success || !parsed.success || !req.user)
        return bodyValidation(res);
      const lot = db
        .prepare(
          "SELECT id, product_id, quarantined FROM inventory_lots WHERE id = ?",
        )
        .get(lotId.data) as
        | { id: string; product_id: string; quarantined: number }
        | undefined;
      if (!lot) return res.status(404).json({ error: "lot_not_found" });
      const now = new Date().toISOString();
      db.transaction(() => {
        db.prepare(
          "UPDATE inventory_lots SET quarantined = ? WHERE id = ?",
        ).run(parsed.data.quarantined ? 1 : 0, lot.id);
        writeAuditEvent(db, {
          actorUserId: req.user!.id,
          action: parsed.data.quarantined
            ? "stock.lot_quarantined"
            : "stock.lot_released_from_quarantine",
          entityType: "inventory_lot",
          entityId: lot.id,
          details: {
            old: lot.quarantined === 1,
            quarantined: parsed.data.quarantined,
            reason: parsed.data.reason,
            productId: lot.product_id,
            at: now,
          },
        });
      })();
      res.json({ lotId: lot.id, quarantined: parsed.data.quarantined });
    },
  );

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
    "/stock/receipts/import-csv",
    requireAuth,
    requireOwner,
    csrf,
    express.text({ type: "text/csv", limit: "256kb" }),
    (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: "authentication_required" });
        return;
      }
      const document = parseCsvRows(req.body, STOCK_RECEIPT_CSV_HEADERS, [
        "sku",
        "quantity",
        "unitcost",
      ]);
      if (document.issues.length) {
        res.status(400).json({
          error: "csv_import_invalid",
          rowErrors: document.issues,
        });
        return;
      }

      const rowErrors: CsvIssue[] = [];
      const receipts: Array<{ row: number; input: ReceiptInput }> = [];
      for (const row of document.rows) {
        const sku = skuSchema.safeParse(row.values.sku);
        if (!sku.success) {
          rowErrors.push({
            row: row.row,
            message: "SKU is missing or invalid.",
          });
          continue;
        }
        const product = db
          .prepare(
            "SELECT id, tracks_lots FROM products WHERE sku = ? COLLATE NOCASE",
          )
          .get(sku.data) as { id: string; tracks_lots: number } | undefined;
        if (!product) {
          rowErrors.push({
            row: row.row,
            message: `SKU ${sku.data} was not found in the catalog.`,
          });
          continue;
        }
        const candidate = {
          productId: product.id,
          quantity:
            row.values.quantity === ""
              ? Number.NaN
              : Number(row.values.quantity),
          unitCost: row.values.unitcost ?? "",
          ...(row.values.reference ? { reference: row.values.reference } : {}),
          ...(row.values.supplier ? { supplier: row.values.supplier } : {}),
          ...(row.values.lotcode ? { lotCode: row.values.lotcode } : {}),
          ...(row.values.expirydate
            ? { expiryDate: row.values.expirydate }
            : {}),
          ...(row.values.zerocostreason
            ? { zeroCostReason: row.values.zerocostreason }
            : {}),
        };
        const parsed = receiptSchema.safeParse(candidate);
        const issueCountBeforeRow = rowErrors.length;
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            rowErrors.push({
              row: row.row,
              message: `${issue.path.join(".") || "row"}: ${issue.message}`,
            });
          }
        } else if (product.tracks_lots === 1) {
          if (!parsed.data.lotCode || !parsed.data.expiryDate) {
            rowErrors.push({
              row: row.row,
              message: "Lot-tracked products require lotCode and expiryDate.",
            });
          } else if (parsed.data.expiryDate < manilaCalendarDate()) {
            rowErrors.push({
              row: row.row,
              message: "Expired stock cannot be received.",
            });
          }
        } else if (parsed.data.lotCode || parsed.data.expiryDate) {
          rowErrors.push({
            row: row.row,
            message:
              "This product does not track lots; leave lot fields blank.",
          });
        }
        if (parsed.success && rowErrors.length === issueCountBeforeRow) {
          receipts.push({ row: row.row, input: parsed.data });
        }
      }
      if (rowErrors.length) {
        res.status(400).json({ error: "csv_import_invalid", rowErrors });
        return;
      }

      try {
        const now = new Date().toISOString();
        const productIds = db.transaction(() =>
          receipts.map(({ input }) =>
            receiveStockRecord(db, input, req.user!.id, now),
          ),
        )();
        res.status(201).json({
          importedCount: receipts.length,
          productsAffected: new Set(productIds).size,
        });
      } catch (error) {
        if (!handleInventoryError(error, res)) throw error;
      }
    },
  );

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
              "SELECT id, sku, name, tracks_lots, quantity_on_hand, inventory_value_centavos FROM products WHERE id = ?",
            )
            .get(parsed.data.productId) as
            | {
                id: string;
                sku: string;
                name: string;
                tracks_lots: number;
                quantity_on_hand: number;
                inventory_value_centavos: number;
              }
            | undefined;
          if (!product) throw new InventoryError(404, "product_not_found");
          if (product.tracks_lots === 1) {
            if (!parsed.data.lotCode || !parsed.data.expiryDate)
              throw new InventoryError(400, "receipt_lot_required");
            if (parsed.data.expiryDate < manilaCalendarDate())
              throw new InventoryError(409, "expired_lot_not_allowed");
          }
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
          const stockEventId = writeStockEvent(db, {
            productId: product.id,
            type: "RECEIPT",
            quantityDelta: parsed.data.quantity,
            unitCostCents: costCents,
            inventoryValueDeltaCents: valueDelta,
            reference: parsed.data.reference || null,
            supplier: parsed.data.supplier || null,
            reason:
              costCents === 0 ? (parsed.data.zeroCostReason ?? null) : null,
            actorUserId: req.user!.id,
            createdAt: now,
          });
          const lotId =
            product.tracks_lots === 1
              ? getOrCreateLot(db, {
                  productId: product.id,
                  lotCode: parsed.data.lotCode!,
                  expiryDate: parsed.data.expiryDate!,
                  actorUserId: req.user!.id,
                  createdAt: now,
                })
              : null;
          writeLotMovement(db, {
            productId: product.id,
            lotId,
            type: "RECEIPT",
            stockEventId,
            quantityDelta: parsed.data.quantity,
            inventoryValueDeltaCentavos: valueDelta,
            unitCostCentavos: costCents,
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
              supplier: parsed.data.supplier ?? null,
              lotCode: parsed.data.lotCode ?? null,
              expiryDate: parsed.data.expiryDate ?? null,
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
              "SELECT id, sku, tracks_lots, quantity_on_hand, inventory_value_centavos FROM products WHERE id = ?",
            )
            .get(parsed.data.productId) as
            | {
                id: string;
                sku: string;
                tracks_lots: number;
                quantity_on_hand: number;
                inventory_value_centavos: number;
              }
            | undefined;
          if (!product) throw new InventoryError(404, "product_not_found");
          const now = new Date().toISOString();
          const increasing = parsed.data.quantityDelta > 0;
          const absoluteDelta = Math.abs(parsed.data.quantityDelta);
          let lotId: string | null = null;
          let lotCode: string | null = parsed.data.lotCode ?? null;
          let lotExpiryDate: string | null = parsed.data.expiryDate ?? null;
          if (product.tracks_lots === 1) {
            if (increasing) {
              if (parsed.data.lotId) {
                const lot = db
                  .prepare(
                    "SELECT id, lot_code, expiry_date FROM inventory_lots WHERE id = ? AND product_id = ?",
                  )
                  .get(parsed.data.lotId, product.id) as
                  | { id: string; lot_code: string; expiry_date: string }
                  | undefined;
                if (!lot) throw new InventoryError(404, "lot_not_found");
                lotId = lot.id;
                lotCode = lot.lot_code;
                lotExpiryDate = lot.expiry_date;
              } else {
                if (!lotCode || !lotExpiryDate)
                  throw new InventoryError(400, "adjustment_lot_required");
                lotId = getOrCreateLot(db, {
                  productId: product.id,
                  lotCode,
                  expiryDate: lotExpiryDate,
                  actorUserId: req.user!.id,
                  createdAt: now,
                });
              }
              if (lotExpiryDate! < manilaCalendarDate())
                throw new InventoryError(409, "expired_lot_not_allowed");
            } else {
              if (!parsed.data.lotId)
                throw new InventoryError(400, "adjustment_lot_required");
              const lot = db
                .prepare(
                  "SELECT id, lot_code, expiry_date FROM inventory_lots WHERE id = ? AND product_id = ?",
                )
                .get(parsed.data.lotId, product.id) as
                | { id: string; lot_code: string; expiry_date: string }
                | undefined;
              if (!lot) throw new InventoryError(404, "lot_not_found");
              const balance = getLotBalances(db, product.id).find(
                (entry) => entry.id === lot.id,
              );
              if (!balance || absoluteDelta > balance.quantity)
                throw new InventoryError(409, "insufficient_lot_stock");
              lotId = lot.id;
              lotCode = lot.lot_code;
              lotExpiryDate = lot.expiry_date;
            }
          } else if (parsed.data.lotId) {
            throw new InventoryError(409, "product_does_not_track_lots");
          }
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
          const stockEventId = writeStockEvent(db, {
            productId: product.id,
            type: isWriteOff ? "WRITE_OFF" : "ADJUSTMENT",
            quantityDelta: parsed.data.quantityDelta,
            unitCostCents: unitCost,
            inventoryValueDeltaCents: valueDelta,
            reference: parsed.data.reference || null,
            supplier: parsed.data.supplier || null,
            reason,
            actorUserId: req.user!.id,
            createdAt: now,
          });
          writeLotMovement(db, {
            productId: product.id,
            lotId,
            type: isWriteOff ? "WRITE_OFF" : "ADJUSTMENT",
            stockEventId,
            quantityDelta: parsed.data.quantityDelta,
            inventoryValueDeltaCentavos: valueDelta,
            unitCostCentavos: unitCost,
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
              lotId,
              lotCode,
              expiryDate: lotExpiryDate,
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

  router.post(
    "/stock/cost-corrections",
    requireAuth,
    requireOwner,
    csrf,
    (req, res) => {
      const parsed = stockCostCorrectionSchema.safeParse(req.body);
      if (!parsed.success) return bodyValidation(res);
      if (!req.user)
        return res.status(401).json({ error: "authentication_required" });
      try {
        const productId = db.transaction(() => {
          const product = db
            .prepare(
              `SELECT id, sku, quantity_on_hand, inventory_value_centavos
               FROM products WHERE id = ?`,
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
          if (product.quantity_on_hand === 0)
            throw new InventoryError(409, "no_stock_to_revalue");

          const movements = db
            .prepare(
              `SELECT lot_id, coalesce(sum(quantity_delta), 0) AS quantity,
                      coalesce(sum(inventory_value_delta_centavos), 0) AS value_centavos
               FROM lot_stock_movements WHERE product_id = ? GROUP BY lot_id`,
            )
            .all(product.id) as Array<{
            lot_id: string | null;
            quantity: number;
            value_centavos: number;
          }>;
          if (
            movements.reduce((sum, movement) => sum + movement.quantity, 0) !==
              product.quantity_on_hand ||
            movements.reduce(
              (sum, movement) => sum + movement.value_centavos,
              0,
            ) !== product.inventory_value_centavos
          ) {
            throw new InventoryError(409, "inventory_ledger_mismatch");
          }

          const newUnitCost = parseMoney(parsed.data.unitCost);
          const newInventoryValue = roundedInteger(
            new Decimal(newUnitCost).mul(product.quantity_on_hand),
          );
          if (!Number.isSafeInteger(newInventoryValue))
            throw new InventoryError(400, "inventory_value_overflow");
          const valueDelta =
            newInventoryValue - product.inventory_value_centavos;
          if (valueDelta === 0)
            throw new InventoryError(409, "cost_correction_no_change");

          const oldUnitCost = roundedInteger(
            new Decimal(product.inventory_value_centavos).div(
              product.quantity_on_hand,
            ),
          );
          const correctionId = randomUUID();
          const now = new Date().toISOString();
          db.prepare(
            `INSERT INTO stock_cost_corrections
              (id, product_id, quantity_basis, old_unit_cost_centavos,
               new_unit_cost_centavos, old_inventory_value_centavos,
               new_inventory_value_centavos, inventory_value_delta_centavos,
               reason, actor_user_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            correctionId,
            product.id,
            product.quantity_on_hand,
            oldUnitCost,
            newUnitCost,
            product.inventory_value_centavos,
            newInventoryValue,
            valueDelta,
            parsed.data.reason,
            req.user!.id,
            now,
          );

          const correctionReason = `ACQUISITION_COST_CORRECTION: ${parsed.data.reason}`;
          for (const movement of movements) {
            const newBucketValue = roundedInteger(
              new Decimal(newUnitCost).mul(movement.quantity),
            );
            const bucketDelta = newBucketValue - movement.value_centavos;
            if (bucketDelta === 0) continue;
            writeLotMovement(db, {
              productId: product.id,
              lotId: movement.lot_id,
              type: "ADJUSTMENT",
              quantityDelta: 0,
              inventoryValueDeltaCentavos: bucketDelta,
              unitCostCentavos: newUnitCost,
              costCorrectionId: correctionId,
              reason: correctionReason,
              actorUserId: req.user!.id,
              createdAt: now,
            });
          }

          db.prepare(
            "UPDATE products SET inventory_value_centavos = ?, updated_at = ? WHERE id = ?",
          ).run(newInventoryValue, now, product.id);
          writeAuditEvent(db, {
            actorUserId: req.user!.id,
            action: "stock.acquisition_cost_corrected",
            entityType: "product",
            entityId: product.id,
            details: {
              sku: product.sku,
              quantity: product.quantity_on_hand,
              oldUnitCostCentavos: oldUnitCost,
              newUnitCostCentavos: newUnitCost,
              oldInventoryValueCentavos: product.inventory_value_centavos,
              newInventoryValueCentavos: newInventoryValue,
              inventoryValueDeltaCentavos: valueDelta,
              reason: parsed.data.reason,
            },
          });
          return product.id;
        })();
        const product = findProduct(db, productId);
        res.status(201).json({
          product: product ? presentProduct(db, product) : null,
        });
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
      bnpcEligible: row.bnpc_eligible === 1,
      bnpcCategory: row.bnpc_category,
      productType:
        row.product_type_applicable === 0 ? "NOT_APPLICABLE" : row.product_type,
      productTypeApplicable: row.product_type_applicable === 1,
      tracksLots: row.tracks_lots === 1,
      reorderLevel: row.reorder_level,
      active: row.is_active === 1,
    };
    output[key] = values[key] ?? null;
  }
  return output;
}

function applyProductUpdate(
  db: Database.Database,
  current: ProductRow,
  input: UpdateProductInput,
  actorUserId: string,
  now: string,
): ProductRow {
  productFromBody(db, input);
  if (input.unit && input.unit !== current.unit) {
    const history = db
      .prepare("SELECT 1 FROM stock_events WHERE product_id = ? LIMIT 1")
      .get(current.id);
    if (current.quantity_on_hand > 0 || history) {
      throw new InventoryError(409, "unit_locked_after_stock_history");
    }
  }
  const changes: Record<string, string | number | boolean | null> = {};
  if (input.name !== undefined && input.name !== current.name) {
    changes.name = input.name;
  }
  if (input.barcode !== undefined) {
    const barcode = input.barcode?.trim() || null;
    if (barcode !== current.barcode) changes.barcode = barcode;
  }
  if (input.unit !== undefined && input.unit !== current.unit) {
    changes.unit = input.unit;
  }
  if (input.sellingPrice !== undefined) {
    const amount = parseMoney(input.sellingPrice);
    if (amount <= 0)
      throw new InventoryError(400, "selling_price_must_be_positive");
    if (amount !== current.selling_price_centavos)
      changes.sellingPriceCentavos = amount;
  }
  if (input.taxClass !== undefined && input.taxClass !== current.tax_class) {
    changes.taxClass = input.taxClass;
  }
  const nextScEligible = input.isScEligible ?? current.sc_eligible === 1;
  const nextPwdEligible = input.isPwdEligible ?? current.pwd_eligible === 1;
  const nextBnpcEligible = input.bnpcEligible ?? current.bnpc_eligible === 1;
  const nextBnpcCategory = nextBnpcEligible
    ? (input.bnpcCategory ?? current.bnpc_category)
    : null;
  if (nextBnpcEligible && !nextBnpcCategory) {
    throw new InventoryError(400, "bnpc_classification_review_required");
  }
  const bnpcClassificationChanged =
    nextBnpcEligible !== (current.bnpc_eligible === 1) ||
    nextBnpcCategory !== current.bnpc_category;
  if (bnpcClassificationChanged) {
    changes.bnpcEligible = nextBnpcEligible;
    changes.bnpcCategory = nextBnpcCategory;
  }
  if (
    input.isScEligible !== undefined &&
    input.isScEligible !== (current.sc_eligible === 1)
  ) {
    changes.isScEligible = input.isScEligible;
  }
  if (
    input.isPwdEligible !== undefined &&
    input.isPwdEligible !== (current.pwd_eligible === 1)
  ) {
    changes.isPwdEligible = input.isPwdEligible;
  }
  const currentProductType =
    current.product_type_applicable === 0
      ? "NOT_APPLICABLE"
      : current.product_type;
  if (
    input.productType !== undefined &&
    input.productType !== currentProductType
  ) {
    changes.productType = input.productType;
    changes.productTypeApplicable =
      input.productType === "NOT_APPLICABLE" ? 0 : 1;
  }
  if (
    input.tracksLots !== undefined &&
    input.tracksLots !== (current.tracks_lots === 1)
  ) {
    if (!input.tracksLots) {
      const activeLot = db
        .prepare(
          `SELECT 1 FROM inventory_lots l
           JOIN lot_stock_movements m ON m.lot_id = l.id
           WHERE l.product_id = ? GROUP BY l.id
           HAVING sum(m.quantity_delta) > 0 LIMIT 1`,
        )
        .get(current.id);
      if (current.quantity_on_hand > 0 || activeLot)
        throw new InventoryError(409, "active_lots_require_tracking");
    }
    changes.tracksLots = input.tracksLots;
  }
  if (
    nextScEligible !== (current.sc_eligible === 1) ||
    nextPwdEligible !== (current.pwd_eligible === 1)
  ) {
    changes.scPwdEligible = nextScEligible || nextPwdEligible;
  }
  if (
    input.reorderLevel !== undefined &&
    input.reorderLevel !== current.reorder_level
  ) {
    changes.reorderLevel = input.reorderLevel;
  }
  if (
    input.active !== undefined &&
    input.active !== (current.is_active === 1)
  ) {
    changes.active = input.active;
  }
  if (Object.keys(changes).length === 0) return current;

  const assignments: string[] = [];
  const values: (string | number | null)[] = [];
  const map: Record<string, [string, string | number | null]> = {
    name: ["name", input.name ?? current.name],
    barcode: ["barcode", input.barcode?.trim() || null],
    unit: ["unit", input.unit ?? current.unit],
    sellingPriceCentavos: [
      "selling_price_centavos",
      Number(changes.sellingPriceCentavos),
    ],
    taxClass: ["tax_class", String(changes.taxClass)],
    isScEligible: ["sc_eligible", changes.isScEligible ? 1 : 0],
    isPwdEligible: ["pwd_eligible", changes.isPwdEligible ? 1 : 0],
    bnpcEligible: ["bnpc_eligible", changes.bnpcEligible ? 1 : 0],
    bnpcCategory: ["bnpc_category", changes.bnpcCategory as string | null],
    productType: [
      "product_type",
      changes.productType === null || changes.productType === "NOT_APPLICABLE"
        ? null
        : String(changes.productType),
    ],
    productTypeApplicable: [
      "product_type_applicable",
      Number(changes.productTypeApplicable),
    ],
    tracksLots: ["tracks_lots", changes.tracksLots ? 1 : 0],
    scPwdEligible: ["sc_pwd_eligible", changes.scPwdEligible ? 1 : 0],
    reorderLevel: ["reorder_level", input.reorderLevel ?? null],
    active: ["is_active", changes.active ? 1 : 0],
  };
  for (const key of Object.keys(changes)) {
    const [column, value] = map[key]!;
    assignments.push(`${column} = ?`);
    values.push(value);
  }
  if (bnpcClassificationChanged) {
    assignments.push("bnpc_reviewed_at = ?", "bnpc_reviewed_by_user_id = ?");
    values.push(
      nextBnpcEligible ? now : null,
      nextBnpcEligible ? actorUserId : null,
    );
  }
  assignments.push("updated_at = ?");
  values.push(now, current.id);
  db.transaction(() => {
    db.prepare(
      `UPDATE products SET ${assignments.join(", ")} WHERE id = ?`,
    ).run(...values);
    writeAuditEvent(db, {
      actorUserId,
      action:
        input.active === false ? "product.deactivated" : "product.updated",
      entityType: "product",
      entityId: current.id,
      details: { old: currentValues(current, changes), new: changes },
    });
  })();
  const updated = findProduct(db, current.id);
  if (!updated) throw new InventoryError(500, "product_update_failed");
  return updated;
}
