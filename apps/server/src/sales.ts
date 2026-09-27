import { Decimal } from "decimal.js";
import type { NextFunction, Request, Response } from "express";
import type Database from "better-sqlite3";
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuthentication, requireCsrf, requireRole } from "./auth.js";
import {
  decryptCustomerField,
  encryptCustomerField,
  CustomerDataError,
} from "./customer-data.js";
import { writeAuditEvent } from "./db.js";
import {
  calculateTaxLine,
  PROVISIONAL_TAX_POLICY,
  TaxCalculationError,
} from "./tax-engine.js";
import type {
  SaleBenefit,
  SaleTaxClass,
  TaxPolicy,
  TaxRoundingMode,
} from "./tax-engine.js";

const MAX_CART_LINES = 100;
const MAX_LINE_QUANTITY = 1_000_000;
const moneySchema = z
  .string()
  .trim()
  .regex(/^\d{1,7}(?:\.\d{1,2})?$/);
const benefitSchema = z.enum(["REGULAR", "SENIOR_CITIZEN", "PWD"]);
const paymentSchema = z.enum(["CASH", "QR"]);
const roundingSchema = z.enum(["HALF_UP", "HALF_EVEN", "DOWN"]);

const checkoutItemsSchema = z
  .array(
    z
      .object({
        productId: z.uuid(),
        quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
        benefitApplied: z.boolean().default(false),
      })
      .strict(),
  )
  .min(1)
  .max(MAX_CART_LINES)
  .superRefine((items, context) => {
    const ids = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (ids.has(item.productId)) {
        context.addIssue({
          code: "custom",
          path: [index, "productId"],
          message: "duplicate_cart_product",
        });
      }
      ids.add(item.productId);
    }
  });

const checkoutBaseSchema = z
  .object({ benefitType: benefitSchema, items: checkoutItemsSchema })
  .strict();

const saleRequestSchema = z
  .object({
    benefitType: benefitSchema,
    items: checkoutItemsSchema,
    paymentMethod: paymentSchema,
    requestKey: z.uuid(),
    customerName: z.string().trim().min(2).max(160).optional(),
    customerIdType: z.string().trim().min(2).max(60).optional(),
    customerIdNumber: z.string().trim().min(2).max(80).optional(),
    customerIdChecked: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    const customerValues = [
      value.customerName,
      value.customerIdType,
      value.customerIdNumber,
    ];
    if (value.benefitType === "REGULAR") {
      if (customerValues.some((entry) => entry !== undefined)) {
        context.addIssue({
          code: "custom",
          path: ["customerName"],
          message: "regular_sale_has_no_customer_benefit_record",
        });
      }
      if (value.customerIdChecked) {
        context.addIssue({
          code: "custom",
          path: ["customerIdChecked"],
          message: "regular_sale_has_no_customer_benefit_record",
        });
      }
      return;
    }
    if (customerValues.some((entry) => entry === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["customerName"],
        message: "benefit_customer_details_required",
      });
    }
    if (!value.customerIdChecked) {
      context.addIssue({
        code: "custom",
        path: ["customerIdChecked"],
        message: "physical_id_check_required",
      });
    }
    if (!value.items.some((item) => item.benefitApplied)) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "benefit_sale_requires_eligible_line",
      });
    }
  });

const taxPolicyUpdateSchema = z
  .object({
    confirmApproved: z.literal(true),
    version: z.string().trim().min(3).max(64),
    vatRateBasisPoints: z.number().int().min(0).max(5_000),
    seniorDiscountBasisPoints: z.number().int().min(0).max(10_000),
    pwdDiscountBasisPoints: z.number().int().min(0).max(10_000),
    vatInclusivePrices: z.boolean(),
    allowZeroRated: z.boolean(),
    roundingMode: roundingSchema,
    approvalReference: z.string().trim().min(3).max(160),
    costBasisDescription: z.string().trim().min(3).max(500),
  })
  .strict();

const openShiftSchema = z.object({ openingCash: moneySchema }).strict();
const closeShiftSchema = z
  .object({
    actualCashCount: moneySchema,
    varianceReason: z.string().trim().max(500).optional(),
  })
  .strict();

type ProductSaleRow = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  selling_price_centavos: number;
  tax_class: SaleTaxClass;
  sc_pwd_eligible: number;
  quantity_on_hand: number;
  inventory_value_centavos: number;
  is_active: number;
};

type StoredTaxApproval = TaxPolicy & {
  approvalReference: string;
  costBasisDescription: string;
  approvedAt: string;
  approvedBy: string;
};

class SalesError extends Error {
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
    throw new SalesError(400, "invalid_money_amount");
  }
  return result;
}

function money(cents: number): string {
  return new Decimal(cents)
    .div(100)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
}

function safeCentavoTotal(values: number[]): number {
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  if (total < 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SalesError(400, "sale_amount_overflow");
  }
  return Number(total);
}

function roundedInteger(value: Decimal): number {
  const result = value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new SalesError(409, "inventory_value_overflow");
  }
  return result;
}

function configuredTaxApproval(
  db: Database.Database,
): StoredTaxApproval | null {
  const row = db
    .prepare("SELECT value_json FROM settings WHERE key = 'tax'")
    .get() as { value_json: string } | undefined;
  if (!row) return null;
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
        roundingMode: roundingSchema,
        approvalReference: z.string().min(3).max(160),
        costBasisDescription: z.string().min(3).max(500),
        approvedAt: z.string().min(1),
        approvedBy: z.string().min(1),
      })
      .safeParse(JSON.parse(row.value_json));
    if (!parsed.success) return null;
    return {
      ...parsed.data,
      roundingMode: parsed.data.roundingMode as TaxRoundingMode,
    };
  } catch {
    return null;
  }
}

function taxPolicy(db: Database.Database): TaxPolicy {
  const configured = configuredTaxApproval(db);
  if (!configured) return PROVISIONAL_TAX_POLICY;
  return {
    version: configured.version,
    approved: true,
    vatRateBasisPoints: configured.vatRateBasisPoints,
    seniorDiscountBasisPoints: configured.seniorDiscountBasisPoints,
    pwdDiscountBasisPoints: configured.pwdDiscountBasisPoints,
    vatInclusivePrices: configured.vatInclusivePrices,
    allowZeroRated: configured.allowZeroRated,
    roundingMode: configured.roundingMode,
  };
}

function presentPolicy(policy: TaxPolicy) {
  return {
    approved: policy.approved,
    version: policy.version,
    vatRateBasisPoints: policy.vatRateBasisPoints,
    seniorDiscountBasisPoints: policy.seniorDiscountBasisPoints,
    pwdDiscountBasisPoints: policy.pwdDiscountBasisPoints,
    vatInclusivePrices: policy.vatInclusivePrices,
    allowZeroRated: policy.allowZeroRated,
    roundingMode: policy.roundingMode,
  };
}

function validationFailure(res: Response): void {
  res.status(400).json({ error: "invalid_request" });
}

function handleSalesError(error: unknown, res: Response): boolean {
  if (error instanceof SalesError) {
    res.status(error.status).json({ error: error.code });
    return true;
  }
  if (error instanceof TaxCalculationError) {
    const status = error.code === "zero_rated_not_approved" ? 409 : 400;
    res.status(status).json({ error: error.code });
    return true;
  }
  if (error instanceof CustomerDataError) {
    res.status(503).json({ error: error.code });
    return true;
  }
  if (
    error instanceof Error &&
    error.message.includes("shifts_one_open_per_cashier_idx")
  ) {
    res.status(409).json({ error: "shift_already_open" });
    return true;
  }
  return false;
}

function manilaBusinessDate(now: Date): string {
  const fields = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(
    fields.map((field) => [field.type, field.value]),
  );
  return `${value.year}-${value.month}-${value.day}`;
}

function calculateCart(
  db: Database.Database,
  benefitType: SaleBenefit,
  items: z.infer<typeof checkoutItemsSchema>,
  policy: TaxPolicy,
) {
  const lines = items.map((item) => {
    const product = db
      .prepare(
        `SELECT id, sku, name, unit, selling_price_centavos, tax_class,
                sc_pwd_eligible, quantity_on_hand, inventory_value_centavos, is_active
         FROM products WHERE id = ?`,
      )
      .get(item.productId) as ProductSaleRow | undefined;
    if (!product || product.is_active !== 1) {
      throw new SalesError(409, "product_unavailable");
    }
    if (item.quantity > product.quantity_on_hand) {
      throw new SalesError(409, "insufficient_stock");
    }
    let calculation;
    try {
      calculation = calculateTaxLine(
        {
          unitPriceCentavos: product.selling_price_centavos,
          quantity: item.quantity,
          taxClass: product.tax_class,
          scPwdEligible: product.sc_pwd_eligible === 1,
          benefit: benefitType,
          benefitApplied: item.benefitApplied,
        },
        policy,
      );
    } catch (error) {
      if (error instanceof TaxCalculationError) throw error;
      throw new SalesError(400, "sale_calculation_failed");
    }
    return {
      product,
      quantity: item.quantity,
      ...calculation,
      unitPriceCentavos: product.selling_price_centavos,
    };
  });
  const subtotalCentavos = safeCentavoTotal(
    lines.map((line) => line.grossCentavos),
  );
  const vatCentavos = safeCentavoTotal(lines.map((line) => line.vatCentavos));
  const vatRemovedCentavos = safeCentavoTotal(
    lines.map((line) => line.vatRemovedCentavos),
  );
  const discountCentavos = safeCentavoTotal(
    lines.map((line) => line.discountCentavos),
  );
  const amountDueCentavos = safeCentavoTotal(
    lines.map((line) => line.amountDueCentavos),
  );
  return {
    lines,
    subtotalCentavos,
    vatCentavos,
    vatRemovedCentavos,
    discountCentavos,
    amountDueCentavos,
    seniorDiscountCentavos:
      benefitType === "SENIOR_CITIZEN" ? discountCentavos : 0,
    pwdDiscountCentavos: benefitType === "PWD" ? discountCentavos : 0,
  };
}

function presentCheckout(
  result: ReturnType<typeof calculateCart>,
  policy: TaxPolicy,
) {
  return {
    policy: presentPolicy(policy),
    policyNotice: policy.approved
      ? null
      : "Provisional estimate only. Sale finalization is disabled until tax, rounding, and acquisition-cost policy approval is recorded.",
    lines: result.lines.map((line) => ({
      productId: line.product.id,
      name: line.product.name,
      sku: line.product.sku,
      unit: line.product.unit,
      quantity: line.quantity,
      unitPrice: money(line.unitPriceCentavos),
      gross: money(line.grossCentavos),
      taxClass: line.product.tax_class,
      scPwdEligible: line.product.sc_pwd_eligible === 1,
      benefitApplied: line.benefitApplied,
      taxBasis: money(line.taxBasisCentavos),
      vat: money(line.vatCentavos),
      vatRemoved: money(line.vatRemovedCentavos),
      discount: money(line.discountCentavos),
      amountDue: money(line.amountDueCentavos),
      ruleVersion: line.ruleVersion,
    })),
    totals: {
      subtotal: money(result.subtotalCentavos),
      vat: money(result.vatCentavos),
      vatRemoved: money(result.vatRemovedCentavos),
      seniorDiscount: money(result.seniorDiscountCentavos),
      pwdDiscount: money(result.pwdDiscountCentavos),
      amountDue: money(result.amountDueCentavos),
    },
  };
}

function shiftForCashier(db: Database.Database, cashierId: string) {
  return db
    .prepare(
      `SELECT id, cashier_user_id, opened_at, opening_cash_centavos,
              expected_cash_centavos
       FROM shifts WHERE cashier_user_id = ? AND closed_at IS NULL`,
    )
    .get(cashierId) as
    | {
        id: string;
        cashier_user_id: string;
        opened_at: string;
        opening_cash_centavos: number;
        expected_cash_centavos: number;
      }
    | undefined;
}

function createStockEvent(
  db: Database.Database,
  values: {
    productId: string;
    quantityDelta: number;
    unitCostCentavos: number;
    inventoryValueDeltaCentavos: number;
    actorUserId: string;
    createdAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO stock_events
      (id, product_id, event_type, quantity_delta, unit_cost_centavos,
       inventory_value_delta_centavos, reference, reason, actor_user_id, created_at)
     VALUES (?, ?, 'SALE', ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    randomUUID(),
    values.productId,
    values.quantityDelta,
    values.unitCostCentavos,
    values.inventoryValueDeltaCentavos,
    values.actorUserId,
    values.createdAt,
  );
}

function nextTransactionId(
  db: Database.Database,
  businessDate: string,
): string {
  db.prepare(
    "INSERT INTO sale_sequences (business_date, next_number) VALUES (?, 1) ON CONFLICT (business_date) DO NOTHING",
  ).run(businessDate);
  const row = db
    .prepare("SELECT next_number FROM sale_sequences WHERE business_date = ?")
    .get(businessDate) as { next_number: number };
  db.prepare(
    "UPDATE sale_sequences SET next_number = ? WHERE business_date = ?",
  ).run(row.next_number + 1, businessDate);
  return `MTX-${businessDate.replaceAll("-", "")}-${String(row.next_number).padStart(6, "0")}`;
}

type SaleRow = {
  id: string;
  transaction_id: string;
  business_date: string;
  cashier_user_id: string;
  cashier_email: string;
  benefit_type: SaleBenefit;
  payment_method: "CASH" | "QR";
  subtotal_centavos: number;
  vat_centavos: number;
  vat_removed_centavos: number;
  senior_discount_centavos: number;
  pwd_discount_centavos: number;
  amount_due_centavos: number;
  tax_policy_version: string;
  created_at: string;
};

function getSale(db: Database.Database, id: string, includeCogs = true) {
  const sale = db
    .prepare(
      `SELECT s.*, u.email AS cashier_email FROM sales s
       JOIN users u ON u.id = s.cashier_user_id WHERE s.id = ?`,
    )
    .get(id) as SaleRow | undefined;
  if (!sale) throw new SalesError(500, "sale_persistence_failed");
  const lines = db
    .prepare(
      `SELECT product_id, product_name_snapshot, sku_snapshot, unit_snapshot,
              quantity, unit_price_centavos, tax_class_snapshot,
              sc_pwd_eligible_snapshot, benefit_applied, tax_basis_centavos,
              vat_centavos, vat_removed_centavos, discount_centavos, amount_due_centavos,
              allocated_cogs_centavos, tax_policy_version
       FROM sale_lines WHERE sale_id = ? ORDER BY line_number`,
    )
    .all(id) as {
    product_id: string;
    product_name_snapshot: string;
    sku_snapshot: string;
    unit_snapshot: string;
    quantity: number;
    unit_price_centavos: number;
    tax_class_snapshot: SaleTaxClass;
    sc_pwd_eligible_snapshot: number;
    benefit_applied: number;
    tax_basis_centavos: number;
    vat_centavos: number;
    vat_removed_centavos: number;
    discount_centavos: number;
    amount_due_centavos: number;
    allocated_cogs_centavos: number;
    tax_policy_version: string;
  }[];
  return {
    id: sale.id,
    transactionId: sale.transaction_id,
    businessDate: sale.business_date,
    cashierEmail: sale.cashier_email,
    benefitType: sale.benefit_type,
    paymentMethod: sale.payment_method,
    subtotal: money(sale.subtotal_centavos),
    vat: money(sale.vat_centavos),
    vatRemoved: money(sale.vat_removed_centavos),
    seniorDiscount: money(sale.senior_discount_centavos),
    pwdDiscount: money(sale.pwd_discount_centavos),
    amountDue: money(sale.amount_due_centavos),
    taxPolicyVersion: sale.tax_policy_version,
    createdAt: sale.created_at,
    label: "INTERNAL SALES RECORD — NOT AN INVOICE",
    lines: lines.map((line) => ({
      productId: line.product_id,
      productName: line.product_name_snapshot,
      sku: line.sku_snapshot,
      unit: line.unit_snapshot,
      quantity: line.quantity,
      unitPrice: money(line.unit_price_centavos),
      taxClass: line.tax_class_snapshot,
      scPwdEligible: line.sc_pwd_eligible_snapshot === 1,
      benefitApplied: line.benefit_applied === 1,
      taxBasis: money(line.tax_basis_centavos),
      vat: money(line.vat_centavos),
      vatRemoved: money(line.vat_removed_centavos),
      discount: money(line.discount_centavos),
      amountDue: money(line.amount_due_centavos),
      ...(includeCogs ? { cogs: money(line.allocated_cogs_centavos) } : {}),
      taxPolicyVersion: line.tax_policy_version,
    })),
  };
}

export function registerSalesRoutes(
  router: express.Router,
  db: Database.Database,
): void {
  const requireAuth = requireAuthentication(db);
  const requireOwner = requireRole("owner");
  const csrf = (req: Request, res: Response, next: NextFunction) =>
    requireCsrf(db, req, res, next);

  router.get("/tax-policy", requireAuth, (_req, res) => {
    const policy = taxPolicy(db);
    res.json({
      policy: presentPolicy(policy),
      notice: policy.approved
        ? null
        : "Tax and cost-basis approval is pending. Preview calculations are provisional; sale finalization is disabled.",
    });
  });

  router.get("/settings/tax-policy", requireAuth, requireOwner, (_req, res) => {
    const configured = configuredTaxApproval(db);
    res.json({
      policy: configured
        ? {
            ...presentPolicy(configured),
            approvalReference: configured.approvalReference,
            costBasisDescription: configured.costBasisDescription,
            approvedAt: configured.approvedAt,
            approvedBy: configured.approvedBy,
          }
        : {
            ...presentPolicy(PROVISIONAL_TAX_POLICY),
            approvalReference: "",
            costBasisDescription: "",
          },
    });
  });

  router.post(
    "/settings/tax-policy",
    requireAuth,
    requireOwner,
    csrf,
    (req, res) => {
      const parsed = taxPolicyUpdateSchema.safeParse(req.body);
      if (!parsed.success || !req.user) return validationFailure(res);
      const now = new Date().toISOString();
      const approval = {
        version: parsed.data.version,
        vatRateBasisPoints: parsed.data.vatRateBasisPoints,
        seniorDiscountBasisPoints: parsed.data.seniorDiscountBasisPoints,
        pwdDiscountBasisPoints: parsed.data.pwdDiscountBasisPoints,
        vatInclusivePrices: parsed.data.vatInclusivePrices,
        allowZeroRated: parsed.data.allowZeroRated,
        roundingMode: parsed.data.roundingMode,
        approvalReference: parsed.data.approvalReference,
        costBasisDescription: parsed.data.costBasisDescription,
        approved: true,
        approvedAt: now,
        approvedBy: req.user.id,
      };
      db.transaction(() => {
        db.prepare(
          `INSERT INTO settings (key, value_json, updated_at, updated_by)
           VALUES ('tax', ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
             updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        ).run(JSON.stringify(approval), now, req.user!.id);
        writeAuditEvent(db, {
          actorUserId: req.user!.id,
          action: "settings.tax_policy.approved",
          entityType: "settings",
          entityId: "tax",
          details: {
            version: approval.version,
            vatRateBasisPoints: approval.vatRateBasisPoints,
            seniorDiscountBasisPoints: approval.seniorDiscountBasisPoints,
            pwdDiscountBasisPoints: approval.pwdDiscountBasisPoints,
            vatInclusivePrices: approval.vatInclusivePrices,
            roundingMode: approval.roundingMode,
            allowZeroRated: approval.allowZeroRated,
            approvalReference: approval.approvalReference,
            costBasisDescription: approval.costBasisDescription,
          },
        });
      })();
      res.json({ policy: presentPolicy(taxPolicy(db)) });
    },
  );

  router.get("/shifts/current", requireAuth, (req, res) => {
    const shift = shiftForCashier(db, req.user!.id);
    res.json({
      shift: shift
        ? {
            id: shift.id,
            openedAt: shift.opened_at,
            openingCash: money(shift.opening_cash_centavos),
            expectedCash: money(shift.expected_cash_centavos),
          }
        : null,
    });
  });

  router.post("/shifts", requireAuth, csrf, (req, res) => {
    const parsed = openShiftSchema.safeParse(req.body);
    if (!parsed.success || !req.user) return validationFailure(res);
    try {
      const id = randomUUID();
      const now = new Date().toISOString();
      const openingCashCentavos = parseMoney(parsed.data.openingCash);
      db.transaction(() => {
        if (shiftForCashier(db, req.user!.id)) {
          throw new SalesError(409, "shift_already_open");
        }
        db.prepare(
          `INSERT INTO shifts
            (id, cashier_user_id, opened_at, opening_cash_centavos, expected_cash_centavos)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(id, req.user!.id, now, openingCashCentavos, openingCashCentavos);
        writeAuditEvent(db, {
          actorUserId: req.user!.id,
          action: "shift.opened",
          entityType: "shift",
          entityId: id,
          details: { openingCashCentavos },
        });
      })();
      res.status(201).json({
        shift: {
          id,
          openedAt: now,
          openingCash: money(openingCashCentavos),
          expectedCash: money(openingCashCentavos),
        },
      });
    } catch (error) {
      if (!handleSalesError(error, res)) throw error;
    }
  });

  router.post("/shifts/:id/close", requireAuth, csrf, (req, res) => {
    const id = z.uuid().safeParse(req.params.id);
    const parsed = closeShiftSchema.safeParse(req.body);
    if (!id.success || !parsed.success || !req.user)
      return validationFailure(res);
    try {
      const actualCash = parseMoney(parsed.data.actualCashCount);
      const result = db.transaction(() => {
        const shift = db
          .prepare(
            `SELECT id, expected_cash_centavos FROM shifts
             WHERE id = ? AND cashier_user_id = ? AND closed_at IS NULL`,
          )
          .get(id.data, req.user!.id) as
          | { id: string; expected_cash_centavos: number }
          | undefined;
        if (!shift) throw new SalesError(404, "open_shift_not_found");
        const variance = actualCash - shift.expected_cash_centavos;
        if (
          variance !== 0 &&
          (parsed.data.varianceReason?.trim().length ?? 0) < 3
        ) {
          throw new SalesError(400, "variance_reason_required");
        }
        const now = new Date().toISOString();
        db.prepare(
          `UPDATE shifts SET closed_at = ?, actual_cash_count_centavos = ?,
             variance_centavos = ?, variance_reason = ?, close_actor_user_id = ?
           WHERE id = ?`,
        ).run(
          now,
          actualCash,
          variance,
          parsed.data.varianceReason?.trim() || null,
          req.user!.id,
          shift.id,
        );
        writeAuditEvent(db, {
          actorUserId: req.user!.id,
          action: "shift.closed",
          entityType: "shift",
          entityId: shift.id,
          details: {
            expectedCashCentavos: shift.expected_cash_centavos,
            actualCashCentavos: actualCash,
            varianceCentavos: variance,
            varianceReason: parsed.data.varianceReason?.trim() || null,
          },
        });
        return {
          id: shift.id,
          expectedCashCentavos: shift.expected_cash_centavos,
          actualCashCentavos: actualCash,
          varianceCentavos: variance,
          closedAt: now,
        };
      })();
      res.json({
        shift: {
          id: result.id,
          expectedCash: money(result.expectedCashCentavos),
          actualCashCount: money(result.actualCashCentavos),
          variance: money(result.varianceCentavos),
          closedAt: result.closedAt,
        },
      });
    } catch (error) {
      if (!handleSalesError(error, res)) throw error;
    }
  });

  router.post("/sales/preview", requireAuth, csrf, (req, res) => {
    const parsed = checkoutBaseSchema.safeParse(req.body);
    if (!parsed.success) return validationFailure(res);
    try {
      const policy = taxPolicy(db);
      const result = calculateCart(
        db,
        parsed.data.benefitType,
        parsed.data.items,
        policy,
      );
      res.json(presentCheckout(result, policy));
    } catch (error) {
      if (!handleSalesError(error, res)) throw error;
    }
  });

  router.post("/sales", requireAuth, csrf, (req, res) => {
    const parsed = saleRequestSchema.safeParse(req.body);
    if (!parsed.success || !req.user) return validationFailure(res);
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          benefitType: parsed.data.benefitType,
          paymentMethod: parsed.data.paymentMethod,
          items: parsed.data.items,
        }),
      )
      .digest("hex");
    try {
      const outcome = db.transaction(() => {
        const prior = db
          .prepare(
            `SELECT id, request_hash FROM sales
             WHERE cashier_user_id = ? AND request_key = ?`,
          )
          .get(req.user!.id, parsed.data.requestKey) as
          | { id: string; request_hash: string }
          | undefined;
        if (prior) {
          if (prior.request_hash !== requestHash) {
            throw new SalesError(409, "idempotency_key_reused");
          }
          return { id: prior.id, replayed: true };
        }

        const policy = taxPolicy(db);
        if (!policy.approved) {
          throw new SalesError(409, "tax_policy_not_approved");
        }
        const currentShift = shiftForCashier(db, req.user!.id);
        if (!currentShift) throw new SalesError(409, "open_shift_required");
        const preview = calculateCart(
          db,
          parsed.data.benefitType,
          parsed.data.items,
          policy,
        );
        const nowDate = new Date();
        const businessDate = manilaBusinessDate(nowDate);
        const transactionId = nextTransactionId(db, businessDate);
        const saleId = randomUUID();
        const now = nowDate.toISOString();
        const customerNameCiphertext =
          parsed.data.benefitType === "REGULAR"
            ? null
            : encryptCustomerField(parsed.data.customerName!, `${saleId}/name`);
        const customerIdTypeCiphertext =
          parsed.data.benefitType === "REGULAR"
            ? null
            : encryptCustomerField(
                parsed.data.customerIdType!,
                `${saleId}/id-type`,
              );
        const customerIdNumberCiphertext =
          parsed.data.benefitType === "REGULAR"
            ? null
            : encryptCustomerField(
                parsed.data.customerIdNumber!,
                `${saleId}/id-number`,
              );

        db.prepare(
          `INSERT INTO sales
            (id, transaction_id, business_date, request_key, request_hash,
             cashier_user_id, shift_id, benefit_type, customer_name_ciphertext,
             customer_id_type_ciphertext, customer_id_number_ciphertext,
             customer_id_checked, payment_method, subtotal_centavos, vat_centavos,
             vat_removed_centavos,
             senior_discount_centavos, pwd_discount_centavos, amount_due_centavos,
             tax_policy_version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          saleId,
          transactionId,
          businessDate,
          parsed.data.requestKey,
          requestHash,
          req.user!.id,
          currentShift.id,
          parsed.data.benefitType,
          customerNameCiphertext,
          customerIdTypeCiphertext,
          customerIdNumberCiphertext,
          parsed.data.benefitType === "REGULAR" ? 0 : 1,
          parsed.data.paymentMethod,
          preview.subtotalCentavos,
          preview.vatCentavos,
          preview.vatRemovedCentavos,
          preview.seniorDiscountCentavos,
          preview.pwdDiscountCentavos,
          preview.amountDueCentavos,
          policy.version,
          now,
        );

        const insertLine = db.prepare(
          `INSERT INTO sale_lines
            (id, sale_id, line_number, product_id, product_name_snapshot,
             sku_snapshot, unit_snapshot, quantity, unit_price_centavos,
             tax_class_snapshot, sc_pwd_eligible_snapshot, benefit_applied,
             tax_basis_centavos, vat_centavos, vat_removed_centavos, discount_centavos,
             amount_due_centavos, allocated_cogs_centavos,
             tax_policy_version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const [index, line] of preview.lines.entries()) {
          const product = db
            .prepare(
              `SELECT id, quantity_on_hand, inventory_value_centavos
               FROM products WHERE id = ?`,
            )
            .get(line.product.id) as
            | {
                id: string;
                quantity_on_hand: number;
                inventory_value_centavos: number;
              }
            | undefined;
          if (!product || line.quantity > product.quantity_on_hand) {
            throw new SalesError(409, "insufficient_stock");
          }
          const allocatedCogs =
            line.quantity === product.quantity_on_hand
              ? product.inventory_value_centavos
              : roundedInteger(
                  new Decimal(product.inventory_value_centavos)
                    .mul(line.quantity)
                    .div(product.quantity_on_hand),
                );
          const nextQuantity = product.quantity_on_hand - line.quantity;
          const nextValue = product.inventory_value_centavos - allocatedCogs;
          if (nextQuantity < 0 || nextValue < 0) {
            throw new SalesError(409, "insufficient_stock");
          }
          db.prepare(
            `UPDATE products SET quantity_on_hand = ?, inventory_value_centavos = ?,
               updated_at = ? WHERE id = ? AND quantity_on_hand >= ?`,
          ).run(nextQuantity, nextValue, now, product.id, line.quantity);
          const unitCogs = roundedInteger(
            new Decimal(allocatedCogs).div(line.quantity),
          );
          createStockEvent(db, {
            productId: product.id,
            quantityDelta: -line.quantity,
            unitCostCentavos: unitCogs,
            inventoryValueDeltaCentavos: -allocatedCogs,
            actorUserId: req.user!.id,
            createdAt: now,
          });
          insertLine.run(
            randomUUID(),
            saleId,
            index + 1,
            line.product.id,
            line.product.name,
            line.product.sku,
            line.product.unit,
            line.quantity,
            line.unitPriceCentavos,
            line.product.tax_class,
            line.product.sc_pwd_eligible,
            line.benefitApplied ? 1 : 0,
            line.taxBasisCentavos,
            line.vatCentavos,
            line.vatRemovedCentavos,
            line.discountCentavos,
            line.amountDueCentavos,
            allocatedCogs,
            line.ruleVersion,
            now,
          );
        }

        if (parsed.data.paymentMethod === "CASH") {
          const expected =
            currentShift.expected_cash_centavos + preview.amountDueCentavos;
          if (!Number.isSafeInteger(expected)) {
            throw new SalesError(400, "sale_amount_overflow");
          }
          db.prepare(
            "UPDATE shifts SET expected_cash_centavos = ? WHERE id = ? AND closed_at IS NULL",
          ).run(expected, currentShift.id);
        }
        writeAuditEvent(db, {
          actorUserId: req.user!.id,
          action: "sale.finalized",
          entityType: "sale",
          entityId: saleId,
          details: {
            transactionId,
            paymentMethod: parsed.data.paymentMethod,
            benefitType: parsed.data.benefitType,
            lineCount: preview.lines.length,
            amountDueCentavos: preview.amountDueCentavos,
          },
        });
        return { id: saleId, replayed: false };
      })();
      const sale = getSale(db, outcome.id, req.user?.role === "owner");
      res.status(outcome.replayed ? 200 : 201).json({
        sale,
        replayed: outcome.replayed,
      });
    } catch (error) {
      if (!handleSalesError(error, res)) throw error;
    }
  });

  router.get("/sales/:transactionId", requireAuth, (req, res) => {
    const transactionId = z
      .string()
      .regex(/^MTX-\d{8}-\d{6,}$/)
      .safeParse(req.params.transactionId);
    if (!transactionId.success || !req.user) return validationFailure(res);
    const saleRow = db
      .prepare("SELECT id, cashier_user_id FROM sales WHERE transaction_id = ?")
      .get(transactionId.data) as
      | { id: string; cashier_user_id: string }
      | undefined;
    if (!saleRow) return res.status(404).json({ error: "sale_not_found" });
    if (req.user.role !== "owner" && saleRow.cashier_user_id !== req.user.id) {
      return res.status(403).json({ error: "forbidden" });
    }
    res.json({
      sale: getSale(db, saleRow.id, req.user.role === "owner"),
    });
  });

  router.get(
    "/sales/:transactionId/customer",
    requireAuth,
    requireOwner,
    (req, res) => {
      const transactionId = z
        .string()
        .regex(/^MTX-\d{8}-\d{6,}$/)
        .safeParse(req.params.transactionId);
      if (!transactionId.success || !req.user) return validationFailure(res);
      const row = db
        .prepare(
          `SELECT id, benefit_type, customer_name_ciphertext,
                  customer_id_type_ciphertext, customer_id_number_ciphertext,
                  customer_id_checked
           FROM sales WHERE transaction_id = ?`,
        )
        .get(transactionId.data) as
        | {
            id: string;
            benefit_type: SaleBenefit;
            customer_name_ciphertext: string | null;
            customer_id_type_ciphertext: string | null;
            customer_id_number_ciphertext: string | null;
            customer_id_checked: number;
          }
        | undefined;
      if (!row) return res.status(404).json({ error: "sale_not_found" });
      if (row.benefit_type === "REGULAR") {
        return res
          .status(404)
          .json({ error: "customer_benefit_record_not_found" });
      }
      try {
        const details = {
          benefitType: row.benefit_type,
          name: decryptCustomerField(
            row.customer_name_ciphertext!,
            `${row.id}/name`,
          ),
          idType: decryptCustomerField(
            row.customer_id_type_ciphertext!,
            `${row.id}/id-type`,
          ),
          idNumber: decryptCustomerField(
            row.customer_id_number_ciphertext!,
            `${row.id}/id-number`,
          ),
          idChecked: row.customer_id_checked === 1,
        };
        writeAuditEvent(db, {
          actorUserId: req.user.id,
          action: "sale.customer_details_viewed",
          entityType: "sale",
          entityId: row.id,
          details: { transactionId: transactionId.data },
        });
        res.json({ customer: details });
      } catch (error) {
        if (!handleSalesError(error, res)) throw error;
      }
    },
  );
}
