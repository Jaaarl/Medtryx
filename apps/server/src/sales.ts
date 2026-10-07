import { Decimal } from "decimal.js";
import type { NextFunction, Request, Response } from "express";
import type Database from "better-sqlite3";
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  resolveBnpcCheckoutContext,
  bnpcHolderKey,
  type BnpcCheckoutContext,
  type BnpcEvidence,
  BnpcCheckoutError,
} from "./bnpc.js";
import { requireAuthentication, requireCsrf, requireRole } from "./auth.js";
import {
  customerLookupDigest,
  decryptCustomerField,
  encryptCustomerField,
  CustomerDataError,
} from "./customer-data.js";
import { writeAuditEvent } from "./db.js";
import {
  allocateFefo,
  getLotBalances,
  manilaCalendarDate,
  writeLotMovement,
} from "./lot-stock.js";
import {
  cashRoundingAdjustment,
  calculateTaxLine,
  PROVISIONAL_TAX_POLICY,
  TaxCalculationError,
} from "./tax-engine.js";
import type {
  CashRoundingMode,
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
const lineTreatmentSchema = z.enum([
  "REGULAR",
  "SENIOR_CITIZEN",
  "PWD",
  "BNPC",
]);
const paymentSchema = z.enum(["CASH", "QR"]);
const roundingSchema = z.enum(["HALF_UP", "HALF_EVEN", "DOWN"]);
const cashRoundingSchema = z.enum(["NONE", "NEAREST_25_CENTAVOS"]);
const checkoutItemSchema = z
  .object({
    productId: z.uuid(),
    quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
    benefitApplied: z.boolean().default(false),
    benefitTreatment: lineTreatmentSchema.optional(),
    lotAllocations: z
      .array(
        z
          .object({
            lotId: z.uuid(),
            quantity: z.number().int().positive(),
          })
          .strict(),
      )
      .optional(),
    lotPickConfirmed: z.boolean().default(false),
  })
  .strict();
const checkoutBundleComponentSchema = z
  .object({
    productId: z.uuid(),
    benefitApplied: z.boolean().default(false),
    benefitTreatment: lineTreatmentSchema.optional(),
    lotAllocations: z
      .array(
        z
          .object({ lotId: z.uuid(), quantity: z.number().int().positive() })
          .strict(),
      )
      .optional(),
    lotPickConfirmed: z.boolean().default(false),
  })
  .strict();
const checkoutBundleOffersSchema = z
  .array(
    z
      .object({
        offerKey: z.uuid(),
        bundleVersionId: z.uuid(),
        quantity: z.number().int().min(1).max(1000),
        components: z.array(checkoutBundleComponentSchema).min(2).max(20),
      })
      .strict(),
  )
  .max(20);

const checkoutItemsSchema = z
  .array(checkoutItemSchema)
  .min(0)
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

const bnpcEvidenceSchema = z
  .object({
    bookletChecked: z.boolean().default(false),
    priorPurchaseConfirmed: z.boolean().default(false),
    externalPurchaseAmount: moneySchema.default("0.00"),
    externalDiscountUsedAmount: moneySchema.default("0.00"),
    representativePurchase: z.boolean().default(false),
    representativeDocumentsChecked: z.boolean().default(false),
    authorizationLetterIssuedDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .nullable()
      .default(null),
    prescriptionApplicable: z.boolean().default(false),
    prescriptionChecked: z.boolean().default(false),
    fourKindsChecked: z.boolean().default(false),
  })
  .strict();

const checkoutBaseSchema = z
  .object({
    benefitType: benefitSchema,
    items: checkoutItemsSchema,
    bundleOffers: checkoutBundleOffersSchema.default([]),
    paymentMethod: paymentSchema.default("QR"),
    customerIdNumber: z.string().trim().min(2).max(80).optional(),
    bnpcChecks: bnpcEvidenceSchema.optional(),
  })
  .strict()
  .refine((value) => value.items.length > 0 || value.bundleOffers.length > 0, {
    message: "checkout_cart_empty",
  });

const saleRequestSchema = z
  .object({
    benefitType: benefitSchema,
    items: checkoutItemsSchema,
    bundleOffers: checkoutBundleOffersSchema.default([]),
    paymentMethod: paymentSchema,
    requestKey: z.uuid(),
    customerName: z.string().trim().min(2).max(160).optional(),
    customerBirthday: z.iso.date().optional(),
    customerIdType: z.string().trim().min(2).max(60).optional(),
    customerIdNumber: z.string().trim().min(2).max(80).optional(),
    customerIdChecked: z.boolean().default(false),
    bnpcChecks: bnpcEvidenceSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const requestedTreatments = [
      ...value.items.map(
        (item) =>
          item.benefitTreatment ??
          (item.benefitApplied ? value.benefitType : "REGULAR"),
      ),
      ...value.bundleOffers.flatMap((offer) =>
        offer.components.map(
          (component) =>
            component.benefitTreatment ??
            (component.benefitApplied ? value.benefitType : "REGULAR"),
        ),
      ),
    ];
    const hasCustomerBenefit = requestedTreatments.some(
      (treatment) => treatment === "SENIOR_CITIZEN" || treatment === "PWD",
    );
    const hasBnpc = requestedTreatments.includes("BNPC");
    const customerValues = [
      value.customerName,
      value.customerBirthday,
      value.customerIdType,
      value.customerIdNumber,
    ];
    if (value.benefitType === "REGULAR") {
      if (hasCustomerBenefit || hasBnpc) {
        context.addIssue({
          code: "custom",
          path: ["benefitType"],
          message: "benefit_holder_type_required",
        });
      }
      if (
        customerValues.some((entry) => entry !== undefined) ||
        value.customerIdChecked
      ) {
        context.addIssue({
          code: "custom",
          path: ["customerName"],
          message: "regular_sale_has_no_customer_benefit_record",
        });
      }
      return;
    }
    if (!hasCustomerBenefit && !hasBnpc) {
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
    if (!hasCustomerBenefit && !hasBnpc) return;
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
    if (hasBnpc && (!value.customerIdNumber || !value.bnpcChecks)) {
      context.addIssue({
        code: "custom",
        path: ["bnpcChecks"],
        message: "bnpc_evidence_required",
      });
    }
    if (hasBnpc && !value.bnpcChecks?.bookletChecked) {
      context.addIssue({
        code: "custom",
        path: ["bnpcChecks", "bookletChecked"],
        message: "bnpc_booklet_confirmation_required",
      });
    }
    if (hasBnpc && !value.bnpcChecks?.priorPurchaseConfirmed) {
      context.addIssue({
        code: "custom",
        path: ["bnpcChecks", "priorPurchaseConfirmed"],
        message: "bnpc_prior_purchase_confirmation_required",
      });
    }
    if (
      (value.benefitType === "SENIOR_CITIZEN" &&
        requestedTreatments.includes("PWD")) ||
      (value.benefitType === "PWD" &&
        requestedTreatments.includes("SENIOR_CITIZEN"))
    ) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "benefit_holder_line_mismatch",
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
    cashRoundingMode: cashRoundingSchema.default("NONE"),
    approvalReference: z.string().trim().min(3).max(160),
    costBasisDescription: z.string().trim().min(3).max(500),
  })
  .strict();

const openShiftSchema = z.object({ openingCash: moneySchema }).strict();
const closeShiftSchema = z
  .object({
    actualCashCount: moneySchema,
    varianceReason: z
      .enum(["Cashier Fault", "Customer Fault", "No Fault"])
      .optional(),
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
  sc_eligible: number;
  pwd_eligible: number;
  bnpc_eligible: number;
  bnpc_category: "BASIC_NECESSITY" | "PRIME_COMMODITY" | null;
  product_type: "GENERIC" | "BRANDED" | null;
  product_type_applicable: number;
  tracks_lots: number;
  quantity_on_hand: number;
  inventory_value_centavos: number;
  is_active: number;
};

type CheckoutItem = z.infer<typeof checkoutItemSchema>;
type SaleLineTreatment = z.infer<typeof lineTreatmentSchema>;

function requestedTreatment(
  item: CheckoutItem,
  benefitType: SaleBenefit,
): SaleLineTreatment {
  return (
    item.benefitTreatment ?? (item.benefitApplied ? benefitType : "REGULAR")
  );
}

function bnpcDiscountFor(
  regularGrossCentavos: number,
  rateBasisPoints: number,
  roundingMode: TaxRoundingMode,
): number {
  const mode =
    roundingMode === "HALF_EVEN"
      ? Decimal.ROUND_HALF_EVEN
      : roundingMode === "DOWN"
        ? Decimal.ROUND_DOWN
        : Decimal.ROUND_HALF_UP;
  const value = new Decimal(regularGrossCentavos)
    .mul(rateBasisPoints)
    .div(10_000)
    .toDecimalPlaces(0, mode)
    .toNumber();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SalesError(400, "sale_amount_overflow");
  }
  return value;
}

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
        cashRoundingMode: cashRoundingSchema.default("NONE"),
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
      cashRoundingMode: parsed.data.cashRoundingMode as CashRoundingMode,
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
    cashRoundingMode: configured.cashRoundingMode,
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
    cashRoundingMode: policy.cashRoundingMode,
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
  if (error instanceof BnpcCheckoutError) {
    res.status(409).json({ error: error.code });
    return true;
  }
  if (
    error instanceof Error &&
    error.message.includes("shifts_one_open_store_idx")
  ) {
    res.status(409).json({ error: "shift_already_open" });
    return true;
  }
  return false;
}

function hasRequestedBnpc(
  items: z.infer<typeof checkoutItemsSchema>,
  bundleOffers: z.infer<typeof checkoutBundleOffersSchema>,
): boolean {
  return (
    items.some((item) => item.benefitTreatment === "BNPC") ||
    bundleOffers.some((offer) =>
      offer.components.some(
        (component) => component.benefitTreatment === "BNPC",
      ),
    )
  );
}

function bnpcContextForCheckout(
  db: Database.Database,
  items: z.infer<typeof checkoutItemsSchema>,
  bundleOffers: z.infer<typeof checkoutBundleOffersSchema>,
  benefitType: SaleBenefit,
  idNumber: string | undefined,
  evidence: BnpcEvidence | undefined,
): BnpcCheckoutContext | undefined {
  if (!hasRequestedBnpc(items, bundleOffers)) return undefined;
  if (
    benefitType === "REGULAR" ||
    !idNumber ||
    !evidence ||
    !evidence.bookletChecked ||
    !evidence.priorPurchaseConfirmed
  ) {
    throw new SalesError(409, "bnpc_evidence_required");
  }
  try {
    return resolveBnpcCheckoutContext(db, evidence, idNumber);
  } catch (error) {
    if (error instanceof BnpcCheckoutError)
      throw new SalesError(409, error.code);
    throw error;
  }
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

type BundleComponentCalculation = {
  offerKey: string;
  bundleId: string;
  bundleVersionId: string;
  code: string;
  name: string;
  version: number;
  bundleQuantity: number;
  componentQuantityPerBundle: number;
  allocatedPromotionDiscountCentavos: number;
  appliedPromotionDiscountCentavos: number;
  promotionSelected: boolean;
  selectedStatutoryTreatment: SaleLineTreatment;
  regularTotalCentavos: number;
  promotionalPriceCentavos: number;
  maxQuantityPerSale: number | null;
  priceRuleVersion: string;
  discountInteractionRule: string;
  statutoryAlternativeAmountDueCentavos: number;
  promotionAlternativeAmountDueCentavos: number;
};

type BundleSnapshotCalculation = {
  offerKey: string;
  bundleId: string;
  bundleVersionId: string;
  code: string;
  name: string;
  version: number;
  activeFrom: string;
  activeUntil: string | null;
  quantity: number;
  maxQuantityPerSale: number | null;
  regularTotalCentavos: number;
  promotionalPriceCentavos: number;
  promotionalDiscountOfferedCentavos: number;
  promotionalDiscountAppliedCentavos: number;
  priceRuleVersion: string;
  discountInteractionRule: string;
};

function calculateCart(
  db: Database.Database,
  benefitType: SaleBenefit,
  items: z.infer<typeof checkoutItemsSchema>,
  policy: TaxPolicy,
  paymentMethod: "CASH" | "QR",
  requireLotConfirmation = false,
  bundleOffers: z.infer<typeof checkoutBundleOffersSchema> = [],
  bnpcContext?: BnpcCheckoutContext,
) {
  const reservedLots = new Map<string, number>();
  const reservedUntracked = new Map<string, number>();
  const today = manilaCalendarDate();
  const expandedItems: Array<{
    item: z.infer<typeof checkoutItemSchema>;
    bundle: BundleComponentCalculation | null;
  }> = items.map((item) => ({ item, bundle: null }));
  const seenBundleVersions = new Set<string>();
  const bundleSnapshotDrafts: Array<{
    snapshot: BundleSnapshotCalculation;
    components: Array<{
      productId: string;
      quantityPerBundle: number;
      lineIndex: number;
    }>;
  }> = [];
  for (const offer of bundleOffers) {
    if (seenBundleVersions.has(offer.bundleVersionId)) {
      throw new SalesError(400, "duplicate_bundle_offer");
    }
    seenBundleVersions.add(offer.bundleVersionId);
    const version = db
      .prepare(
        `SELECT b.id AS bundle_id, b.code, b.is_active, b.current_version,
                v.id, v.version, v.name_snapshot, v.active_from, v.active_until,
                v.max_quantity_per_sale, v.promotional_price_centavos,
                v.price_rule_version, v.discount_interaction_rule
         FROM sales_bundle_versions v JOIN sales_bundles b ON b.id = v.bundle_id
         WHERE v.id = ?`,
      )
      .get(offer.bundleVersionId) as
      | {
          bundle_id: string;
          code: string;
          is_active: number;
          current_version: number;
          id: string;
          version: number;
          name_snapshot: string;
          active_from: string;
          active_until: string | null;
          max_quantity_per_sale: number | null;
          promotional_price_centavos: number;
          price_rule_version: string;
          discount_interaction_rule: string;
        }
      | undefined;
    if (
      !version ||
      version.is_active !== 1 ||
      version.current_version !== version.version
    ) {
      throw new SalesError(409, "bundle_offer_unavailable");
    }
    if (
      version.active_from > today ||
      (version.active_until !== null && version.active_until < today)
    ) {
      throw new SalesError(409, "bundle_offer_outside_active_period");
    }
    if (
      version.max_quantity_per_sale !== null &&
      offer.quantity > version.max_quantity_per_sale
    ) {
      throw new SalesError(409, "bundle_sale_limit_exceeded");
    }
    const components = db
      .prepare(
        `SELECT c.product_id, c.quantity, c.component_order
         FROM sales_bundle_version_components c
         WHERE c.bundle_version_id = ? ORDER BY c.component_order`,
      )
      .all(version.id) as Array<{
      product_id: string;
      quantity: number;
      component_order: number;
    }>;
    const supplied = new Map(
      offer.components.map((component) => [component.productId, component]),
    );
    if (
      components.length !== offer.components.length ||
      components.some((component) => !supplied.has(component.product_id))
    ) {
      throw new SalesError(400, "bundle_component_mapping_changed");
    }
    const bundleProducts = components.map((component) => {
      const product = db
        .prepare(
          `SELECT id, selling_price_centavos, is_active FROM products WHERE id = ?`,
        )
        .get(component.product_id) as
        | { id: string; selling_price_centavos: number; is_active: number }
        | undefined;
      if (!product || product.is_active !== 1) {
        throw new SalesError(409, "bundle_component_unavailable");
      }
      return { ...component, product };
    });
    const regularTotalBig = bundleProducts.reduce(
      (total, component) =>
        total +
        BigInt(component.product.selling_price_centavos) *
          BigInt(component.quantity),
      0n,
    );
    if (
      regularTotalBig <= BigInt(version.promotional_price_centavos) ||
      regularTotalBig > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new SalesError(409, "bundle_price_no_longer_promotional");
    }
    const regularTotalCentavos = Number(regularTotalBig);
    const offeredDiscountPerBundle =
      regularTotalCentavos - version.promotional_price_centavos;
    const offeredDiscountTotalBig =
      BigInt(offeredDiscountPerBundle) * BigInt(offer.quantity);
    if (offeredDiscountTotalBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new SalesError(400, "bundle_price_overflow");
    }
    const offeredDiscountTotal = Number(offeredDiscountTotalBig);
    let remainingDiscount = offeredDiscountTotal;
    const draftComponents: Array<{
      productId: string;
      quantityPerBundle: number;
      lineIndex: number;
    }> = [];
    for (const [index, component] of bundleProducts.entries()) {
      const suppliedComponent = supplied.get(component.product_id)!;
      const lineQuantity = component.quantity * offer.quantity;
      if (
        !Number.isSafeInteger(lineQuantity) ||
        lineQuantity > MAX_LINE_QUANTITY
      ) {
        throw new SalesError(400, "bundle_quantity_overflow");
      }
      const regularLineTotal =
        component.product.selling_price_centavos * lineQuantity;
      const allocation =
        index === bundleProducts.length - 1
          ? remainingDiscount
          : Number(
              (BigInt(offeredDiscountTotal) * BigInt(regularLineTotal)) /
                (regularTotalBig * BigInt(offer.quantity)),
            );
      remainingDiscount -= allocation;
      const item = {
        productId: component.product_id,
        quantity: lineQuantity,
        benefitApplied: suppliedComponent.benefitApplied,
        benefitTreatment: suppliedComponent.benefitTreatment,
        lotAllocations: suppliedComponent.lotAllocations,
        lotPickConfirmed: suppliedComponent.lotPickConfirmed,
      };
      const lineIndex = expandedItems.length;
      expandedItems.push({
        item,
        bundle: {
          offerKey: offer.offerKey,
          bundleId: version.bundle_id,
          bundleVersionId: version.id,
          code: version.code,
          name: version.name_snapshot,
          version: version.version,
          bundleQuantity: offer.quantity,
          componentQuantityPerBundle: component.quantity,
          allocatedPromotionDiscountCentavos: allocation,
          appliedPromotionDiscountCentavos: 0,
          promotionSelected: false,
          selectedStatutoryTreatment: "REGULAR",
          regularTotalCentavos,
          promotionalPriceCentavos: version.promotional_price_centavos,
          maxQuantityPerSale: version.max_quantity_per_sale,
          priceRuleVersion: version.price_rule_version,
          discountInteractionRule: version.discount_interaction_rule,
          statutoryAlternativeAmountDueCentavos: 0,
          promotionAlternativeAmountDueCentavos: 0,
        },
      });
      draftComponents.push({
        productId: component.product_id,
        quantityPerBundle: component.quantity,
        lineIndex,
      });
    }
    if (remainingDiscount !== 0) {
      throw new SalesError(409, "bundle_discount_allocation_failed");
    }
    bundleSnapshotDrafts.push({
      snapshot: {
        offerKey: offer.offerKey,
        bundleId: version.bundle_id,
        bundleVersionId: version.id,
        code: version.code,
        name: version.name_snapshot,
        version: version.version,
        activeFrom: version.active_from,
        activeUntil: version.active_until,
        quantity: offer.quantity,
        maxQuantityPerSale: version.max_quantity_per_sale,
        regularTotalCentavos,
        promotionalPriceCentavos: version.promotional_price_centavos,
        promotionalDiscountOfferedCentavos: offeredDiscountTotal,
        promotionalDiscountAppliedCentavos: 0,
        priceRuleVersion: version.price_rule_version,
        discountInteractionRule: version.discount_interaction_rule,
      },
      components: draftComponents,
    });
  }

  const lines = expandedItems.map(({ item, bundle }) => {
    const product = db
      .prepare(
        `SELECT id, sku, name, unit, selling_price_centavos, tax_class,
                sc_pwd_eligible, sc_eligible, pwd_eligible, bnpc_eligible,
                bnpc_category, product_type, product_type_applicable,
                quantity_on_hand, tracks_lots,
                inventory_value_centavos, is_active
         FROM products WHERE id = ?`,
      )
      .get(item.productId) as ProductSaleRow | undefined;
    if (!product || product.is_active !== 1) {
      throw new SalesError(409, "product_unavailable");
    }
    let lotAllocations: ReturnType<typeof allocateFefo> = [];
    if (product.tracks_lots === 1) {
      lotAllocations = allocateFefo(
        db,
        product.id,
        item.quantity,
        reservedLots,
        today,
      );
      if (!lotAllocations.length)
        throw new SalesError(409, "insufficient_saleable_lot_stock");
      if (requireLotConfirmation) {
        const requested = [...(item.lotAllocations ?? [])]
          .map((allocation) => ({
            lotId: allocation.lotId,
            quantity: allocation.quantity,
          }))
          .sort((left, right) => left.lotId.localeCompare(right.lotId));
        const assigned = [...lotAllocations].sort((left, right) =>
          left.lotId.localeCompare(right.lotId),
        );
        if (
          !item.lotPickConfirmed ||
          JSON.stringify(requested) !== JSON.stringify(assigned)
        ) {
          throw new SalesError(409, "lot_pick_confirmation_required");
        }
      }
    } else {
      const alreadyReserved = reservedUntracked.get(product.id) ?? 0;
      if (item.quantity + alreadyReserved > product.quantity_on_hand) {
        throw new SalesError(409, "insufficient_stock");
      }
      reservedUntracked.set(product.id, alreadyReserved + item.quantity);
    }
    const treatment = requestedTreatment(item, benefitType);
    if (treatment === "BNPC") {
      if (!bnpcContext) throw new SalesError(409, "bnpc_evidence_required");
      if (!product.bnpc_eligible || !product.bnpc_category) {
        throw new SalesError(409, "product_not_bnpc_eligible");
      }
    }
    if (
      (treatment === "SENIOR_CITIZEN" && benefitType !== "SENIOR_CITIZEN") ||
      (treatment === "PWD" && benefitType !== "PWD")
    ) {
      throw new SalesError(400, "benefit_holder_line_mismatch");
    }
    const regularGrossCentavos = product.selling_price_centavos * item.quantity;
    const bnpcDiscountCentavos =
      treatment === "BNPC"
        ? bnpcDiscountFor(
            regularGrossCentavos,
            bnpcContext!.policy.discountRateBasisPoints,
            policy.roundingMode,
          )
        : 0;
    let calculation: ReturnType<typeof calculateTaxLine> & {
      bnpcDiscountCentavos: number;
    };
    let statutoryAlternative: ReturnType<typeof calculateTaxLine> & {
      bnpcDiscountCentavos: number;
    };
    let promotionAlternative:
      | (ReturnType<typeof calculateTaxLine> & {
          bnpcDiscountCentavos: number;
        })
      | null = null;
    try {
      if (treatment === "BNPC") {
        statutoryAlternative = {
          ...calculateTaxLine(
            {
              unitPriceCentavos: product.selling_price_centavos,
              quantity: item.quantity,
              grossOverrideCentavos:
                regularGrossCentavos - bnpcDiscountCentavos,
              taxClass: product.tax_class,
              isScEligible: false,
              isPwdEligible: false,
              benefit: benefitType,
              benefitApplied: false,
            },
            policy,
          ),
          bnpcDiscountCentavos,
        };
      } else {
        statutoryAlternative = {
          ...calculateTaxLine(
            {
              unitPriceCentavos: product.selling_price_centavos,
              quantity: item.quantity,
              grossOverrideCentavos: regularGrossCentavos,
              taxClass: product.tax_class,
              isScEligible: product.sc_eligible === 1,
              isPwdEligible: product.pwd_eligible === 1,
              benefit: benefitType,
              benefitApplied:
                treatment === "SENIOR_CITIZEN" || treatment === "PWD",
            },
            policy,
          ),
          bnpcDiscountCentavos: 0,
        };
      }
      if (bundle) {
        const promotionalGross =
          product.selling_price_centavos * item.quantity -
          bundle.allocatedPromotionDiscountCentavos;
        promotionAlternative = {
          ...calculateTaxLine(
            {
              unitPriceCentavos: product.selling_price_centavos,
              quantity: item.quantity,
              grossOverrideCentavos: promotionalGross,
              taxClass: product.tax_class,
              isScEligible: product.sc_eligible === 1,
              isPwdEligible: product.pwd_eligible === 1,
              benefit: benefitType,
              benefitApplied: false,
            },
            policy,
          ),
          bnpcDiscountCentavos: 0,
        };
        const promotionSelected =
          promotionAlternative.amountDueCentavos <=
          statutoryAlternative.amountDueCentavos;
        calculation = promotionSelected
          ? promotionAlternative
          : statutoryAlternative;
        bundle.statutoryAlternativeAmountDueCentavos =
          statutoryAlternative.amountDueCentavos;
        bundle.promotionAlternativeAmountDueCentavos =
          promotionAlternative.amountDueCentavos;
        bundle.promotionSelected = promotionSelected;
        bundle.selectedStatutoryTreatment = promotionSelected
          ? "REGULAR"
          : treatment;
        bundle.appliedPromotionDiscountCentavos = promotionSelected
          ? bundle.allocatedPromotionDiscountCentavos
          : 0;
        bundleSnapshotDrafts.find(
          (entry) => entry.snapshot.offerKey === bundle.offerKey,
        )!.snapshot.promotionalDiscountAppliedCentavos +=
          bundle.appliedPromotionDiscountCentavos;
      } else {
        calculation = statutoryAlternative;
      }
    } catch (error) {
      if (error instanceof TaxCalculationError) throw error;
      throw new SalesError(400, "sale_calculation_failed");
    }
    return {
      product,
      quantity: item.quantity,
      lotAllocations,
      bundle,
      regularGrossCentavos,
      requestedBenefitTreatment: treatment,
      ...calculation,
      benefitTreatment: bundle?.promotionSelected ? "REGULAR" : treatment,
      unitPriceCentavos: product.selling_price_centavos,
    };
  });
  const bnpcPurchaseCentavos = safeCentavoTotal(
    lines
      .filter((line) => line.requestedBenefitTreatment === "BNPC")
      .map((line) => line.regularGrossCentavos),
  );
  const bnpcDiscountCentavos = safeCentavoTotal(
    lines.map((line) => line.bnpcDiscountCentavos),
  );
  if (bnpcContext) {
    if (bnpcPurchaseCentavos > bnpcContext.purchaseAllowanceCentavos) {
      throw new SalesError(409, "bnpc_purchase_allowance_exceeded");
    }
    if (bnpcDiscountCentavos > bnpcContext.discountAllowanceCentavos) {
      throw new SalesError(409, "bnpc_discount_allowance_exceeded");
    }
    if (
      bnpcPurchaseCentavos > 0 &&
      bnpcContext.localPurchaseBeforeCentavos +
        bnpcContext.externalPurchaseAttestedCentavos +
        bnpcPurchaseCentavos >=
        bnpcContext.policy.weeklyPurchaseLimitCentavos &&
      !bnpcContext.evidence.fourKindsChecked
    ) {
      throw new SalesError(409, "bnpc_four_kinds_confirmation_required");
    }
  }
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
  const lineAmountDueCentavos = safeCentavoTotal(
    lines.map((line) => line.amountDueCentavos),
  );
  const bundlePromotionalDiscountCentavos = safeCentavoTotal(
    lines.map((line) => line.bundle?.appliedPromotionDiscountCentavos ?? 0),
  );
  const cashRoundingAdjustmentCentavos =
    paymentMethod === "CASH"
      ? cashRoundingAdjustment(lineAmountDueCentavos, policy.cashRoundingMode)
      : 0;
  const amountDueCentavos =
    lineAmountDueCentavos + cashRoundingAdjustmentCentavos;
  if (!Number.isSafeInteger(amountDueCentavos) || amountDueCentavos < 0) {
    throw new SalesError(400, "sale_amount_overflow");
  }
  return {
    lines,
    subtotalCentavos,
    vatCentavos,
    vatRemovedCentavos,
    discountCentavos,
    bnpcDiscountCentavos,
    bnpcPurchaseCentavos,
    lineAmountDueCentavos,
    cashRoundingAdjustmentCentavos,
    amountDueCentavos,
    bundlePromotionalDiscountCentavos,
    bundleOffers: bundleSnapshotDrafts,
    seniorDiscountCentavos: safeCentavoTotal(
      lines
        .filter((line) => line.benefitTreatment === "SENIOR_CITIZEN")
        .map((line) => line.discountCentavos),
    ),
    pwdDiscountCentavos: safeCentavoTotal(
      lines
        .filter((line) => line.benefitTreatment === "PWD")
        .map((line) => line.discountCentavos),
    ),
  };
}

function presentCheckout(
  db: Database.Database,
  result: ReturnType<typeof calculateCart>,
  policy: TaxPolicy,
  paymentMethod: "CASH" | "QR",
  bnpcContext?: BnpcCheckoutContext,
) {
  return {
    policy: presentPolicy(policy),
    paymentMethod,
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
      regularGross: money(line.regularGrossCentavos),
      gross: money(line.grossCentavos),
      taxClass: line.product.tax_class,
      productType:
        line.product.product_type_applicable === 0
          ? "NOT_APPLICABLE"
          : line.product.product_type,
      scPwdEligible: line.product.sc_pwd_eligible === 1,
      isScEligible: line.product.sc_eligible === 1,
      isPwdEligible: line.product.pwd_eligible === 1,
      bnpcEligible: line.product.bnpc_eligible === 1,
      bnpcCategory: line.product.bnpc_category,
      benefitApplied: line.benefitApplied,
      benefitTreatment: line.benefitTreatment,
      taxBasis: money(line.taxBasisCentavos),
      vat: money(line.vatCentavos),
      vatRemoved: money(line.vatRemovedCentavos),
      discount: money(line.discountCentavos),
      bnpcDiscount: money(line.bnpcDiscountCentavos),
      amountDue: money(line.amountDueCentavos),
      ruleVersion: line.ruleVersion,
      bundle: line.bundle
        ? {
            offerKey: line.bundle.offerKey,
            code: line.bundle.code,
            name: line.bundle.name,
            componentQuantityPerBundle: line.bundle.componentQuantityPerBundle,
            regularGross: money(line.regularGrossCentavos),
            allocatedPromotionDiscount: money(
              line.bundle.allocatedPromotionDiscountCentavos,
            ),
            appliedPromotionDiscount: money(
              line.bundle.appliedPromotionDiscountCentavos,
            ),
            promotionSelected: line.bundle.promotionSelected,
            statutoryAlternativeAmountDue: money(
              line.bundle.statutoryAlternativeAmountDueCentavos,
            ),
            promotionAlternativeAmountDue: money(
              line.bundle.promotionAlternativeAmountDueCentavos,
            ),
            selectedStatutoryTreatment: line.bundle.selectedStatutoryTreatment,
            priceRuleVersion: line.bundle.priceRuleVersion,
            discountInteractionRule: line.bundle.discountInteractionRule,
          }
        : null,
      assignedLots: line.lotAllocations.map((allocation) => {
        const lot = getLotBalances(db, line.product.id).find(
          (entry) => entry.id === allocation.lotId,
        );
        return {
          lotId: allocation.lotId,
          lotCode: lot?.lotCode ?? "Unknown lot",
          expiryDate: lot?.expiryDate ?? "",
          quantity: allocation.quantity,
        };
      }),
    })),
    bundles: result.bundleOffers.map(({ snapshot, components }) => ({
      offerKey: snapshot.offerKey,
      code: snapshot.code,
      name: snapshot.name,
      version: snapshot.version,
      quantity: snapshot.quantity,
      regularTotal: money(snapshot.regularTotalCentavos * snapshot.quantity),
      promotionalPricePerBundle: money(snapshot.promotionalPriceCentavos),
      promotionalDiscountOffered: money(
        snapshot.promotionalDiscountOfferedCentavos,
      ),
      promotionalDiscountApplied: money(
        snapshot.promotionalDiscountAppliedCentavos,
      ),
      discountInteractionRule: snapshot.discountInteractionRule,
      components: components.map(({ lineIndex }) => {
        const line = result.lines[lineIndex]!;
        return {
          productId: line.product.id,
          productName: line.product.name,
          quantity: line.quantity,
          regularAmount: money(line.regularGrossCentavos),
          promotionAlternativeAmountDue: money(
            line.bundle!.promotionAlternativeAmountDueCentavos,
          ),
          statutoryAlternativeAmountDue: money(
            line.bundle!.statutoryAlternativeAmountDueCentavos,
          ),
          appliedPromotionDiscount: money(
            line.bundle!.appliedPromotionDiscountCentavos,
          ),
          selectedStatutoryTreatment: line.bundle!.selectedStatutoryTreatment,
        };
      }),
    })),
    totals: {
      subtotal: money(result.subtotalCentavos),
      vat: money(result.vatCentavos),
      vatRemoved: money(result.vatRemovedCentavos),
      seniorDiscount: money(result.seniorDiscountCentavos),
      pwdDiscount: money(result.pwdDiscountCentavos),
      bnpcDiscount: money(result.bnpcDiscountCentavos),
      bnpcQualifyingPurchase: money(result.bnpcPurchaseCentavos),
      bnpcAllowance: bnpcContext
        ? {
            purchaseBeforeSale: money(bnpcContext.purchaseAllowanceCentavos),
            discountBeforeSale: money(bnpcContext.discountAllowanceCentavos),
            localStoreOnly: true,
            weekStartDate: bnpcContext.weekStartDate,
          }
        : null,
      bundlePromotionalDiscount: money(
        result.bundlePromotionalDiscountCentavos,
      ),
      amountBeforeCashRounding: money(result.lineAmountDueCentavos),
      cashRoundingAdjustment: money(result.cashRoundingAdjustmentCentavos),
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
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO stock_events
      (id, product_id, event_type, quantity_delta, unit_cost_centavos,
       inventory_value_delta_centavos, reference, reason, actor_user_id, created_at)
     VALUES (?, ?, 'SALE', ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    id,
    values.productId,
    values.quantityDelta,
    values.unitCostCentavos,
    values.inventoryValueDeltaCentavos,
    values.actorUserId,
    values.createdAt,
  );
  return id;
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
  bnpc_discount_centavos: number;
  amount_due_centavos: number;
  cash_rounding_mode: CashRoundingMode;
  cash_rounding_adjustment_centavos: number;
  tax_policy_version: string;
  created_at: string;
};

type SaleChange = {
  id: string;
  kind: "PAYMENT_SWITCH" | "CANCELLATION" | "REVERSAL";
  createdAt: string;
  actorEmail: string;
  reason: string;
  products: Array<{
    name: string;
    sku: string;
    quantity: number;
    stockTreatment: "RESTOCK" | "WRITE_OFF" | null;
  }>;
  payment: null | {
    fromMethod: "CASH";
    toMethod: "QR";
    cashAmount: string;
    qrAmount: string;
    cashRoundingAdjustment: string;
  };
  refund: null | {
    transactionId: string;
    method: "CASH" | "QR";
    amount: string;
    cashRoundingAdjustment: string;
  };
};

export function getSavedSale(
  db: Database.Database,
  id: string,
  includeCogs = true,
) {
  const sale = db
    .prepare(
      `SELECT s.*, u.email AS cashier_email FROM sales s
       JOIN users u ON u.id = s.cashier_user_id WHERE s.id = ?`,
    )
    .get(id) as SaleRow | undefined;
  if (!sale) throw new SalesError(500, "sale_persistence_failed");
  const lines = db
    .prepare(
      `SELECT sl.id, sl.product_id, product_name_snapshot, sku_snapshot, unit_snapshot,
              quantity, unit_price_centavos, tax_class_snapshot,
              sc_pwd_eligible_snapshot, sc_eligible_snapshot,
              pwd_eligible_snapshot, product_type_snapshot,
              product_type_applicable_snapshot,
              benefit_applied, benefit_treatment_snapshot,
              bnpc_eligible_snapshot, bnpc_category_snapshot,
              bnpc_discount_centavos, p.version AS bnpc_policy_version,
              bnpc_prescription_required_snapshot,
              tax_basis_centavos,
              vat_centavos, vat_removed_centavos, discount_centavos,
              bundle_promotion_discount_centavos, amount_due_centavos,
              allocated_cogs_centavos, tax_policy_version
       FROM sale_lines sl
       LEFT JOIN bnpc_policy_versions p ON p.id = sl.bnpc_policy_version
       WHERE sl.sale_id = ? ORDER BY line_number`,
    )
    .all(id) as {
    id: string;
    product_id: string;
    product_name_snapshot: string;
    sku_snapshot: string;
    unit_snapshot: string;
    quantity: number;
    unit_price_centavos: number;
    tax_class_snapshot: SaleTaxClass;
    sc_pwd_eligible_snapshot: number;
    sc_eligible_snapshot: number;
    pwd_eligible_snapshot: number;
    product_type_snapshot: "GENERIC" | "BRANDED" | null;
    product_type_applicable_snapshot: number;
    benefit_applied: number;
    benefit_treatment_snapshot: SaleLineTreatment;
    bnpc_eligible_snapshot: number;
    bnpc_category_snapshot: "BASIC_NECESSITY" | "PRIME_COMMODITY" | null;
    bnpc_discount_centavos: number;
    bnpc_policy_version: string | null;
    bnpc_prescription_required_snapshot: number;
    tax_basis_centavos: number;
    vat_centavos: number;
    vat_removed_centavos: number;
    discount_centavos: number;
    bundle_promotion_discount_centavos: number;
    amount_due_centavos: number;
    allocated_cogs_centavos: number;
    tax_policy_version: string;
  }[];
  const changes: SaleChange[] = [];
  const paymentSwitch = db
    .prepare(
      `SELECT p.id, p.reason, p.from_method, p.to_method,
              p.cash_amount_centavos, p.qr_amount_centavos,
              p.cash_rounding_adjustment_centavos, p.created_at,
              u.email AS actor_email
       FROM sale_payment_switches p
       JOIN users u ON u.id = p.changed_by_user_id
       WHERE p.sale_id = ?`,
    )
    .get(id) as
    | {
        id: string;
        reason: string;
        from_method: "CASH";
        to_method: "QR";
        cash_amount_centavos: number;
        qr_amount_centavos: number;
        cash_rounding_adjustment_centavos: number;
        created_at: string;
        actor_email: string;
      }
    | undefined;
  if (paymentSwitch) {
    changes.push({
      id: paymentSwitch.id,
      kind: "PAYMENT_SWITCH",
      createdAt: paymentSwitch.created_at,
      actorEmail: paymentSwitch.actor_email,
      reason: paymentSwitch.reason,
      products: lines.map((line) => ({
        name: line.product_name_snapshot,
        sku: line.sku_snapshot,
        quantity: line.quantity,
        stockTreatment: null,
      })),
      payment: {
        fromMethod: paymentSwitch.from_method,
        toMethod: paymentSwitch.to_method,
        cashAmount: money(paymentSwitch.cash_amount_centavos),
        qrAmount: money(paymentSwitch.qr_amount_centavos),
        cashRoundingAdjustment: money(
          paymentSwitch.cash_rounding_adjustment_centavos,
        ),
      },
      refund: null,
    });
  }
  const reversal = db
    .prepare(
      `SELECT r.id, r.reversal_transaction_id, r.reason, r.refund_method,
              r.amount_centavos, r.cash_rounding_adjustment_centavos,
              r.created_at, u.email AS actor_email, e.action
       FROM sale_reversals r
       JOIN users u ON u.id = r.approved_by_user_id
       LEFT JOIN audit_events e ON e.entity_id = r.id
         AND e.entity_type = 'sale_reversal'
         AND e.action IN ('sale.cancelled', 'sale.reversed')
       WHERE r.sale_id = ? ORDER BY e.created_at DESC LIMIT 1`,
    )
    .get(id) as
    | {
        id: string;
        reversal_transaction_id: string;
        reason: string;
        refund_method: "CASH" | "QR";
        amount_centavos: number;
        cash_rounding_adjustment_centavos: number;
        created_at: string;
        actor_email: string;
        action: "sale.cancelled" | "sale.reversed" | null;
      }
    | undefined;
  if (reversal) {
    const reversalLines = db
      .prepare(
        `SELECT sl.product_name_snapshot, sl.sku_snapshot, rl.quantity,
                rl.stock_treatment
         FROM sale_reversal_lines rl
         JOIN sale_lines sl ON sl.id = rl.sale_line_id
         WHERE rl.reversal_id = ? ORDER BY sl.line_number`,
      )
      .all(reversal.id) as Array<{
      product_name_snapshot: string;
      sku_snapshot: string;
      quantity: number;
      stock_treatment: "RESTOCK" | "WRITE_OFF";
    }>;
    changes.push({
      id: reversal.id,
      kind: reversal.action === "sale.cancelled" ? "CANCELLATION" : "REVERSAL",
      createdAt: reversal.created_at,
      actorEmail: reversal.actor_email,
      reason: reversal.reason,
      products: reversalLines.map((line) => ({
        name: line.product_name_snapshot,
        sku: line.sku_snapshot,
        quantity: line.quantity,
        stockTreatment: line.stock_treatment,
      })),
      payment: null,
      refund: {
        transactionId: reversal.reversal_transaction_id,
        method: reversal.refund_method,
        amount: money(reversal.amount_centavos),
        cashRoundingAdjustment: money(
          reversal.cash_rounding_adjustment_centavos,
        ),
      },
    });
  }
  changes.sort((first, second) =>
    first.createdAt.localeCompare(second.createdAt),
  );
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
    bnpcDiscount: money(sale.bnpc_discount_centavos),
    amountDue: money(sale.amount_due_centavos),
    cashRoundingMode: sale.cash_rounding_mode,
    cashRoundingAdjustment: money(sale.cash_rounding_adjustment_centavos),
    taxPolicyVersion: sale.tax_policy_version,
    createdAt: sale.created_at,
    changes,
    label: "INTERNAL SALES RECORD — NOT AN INVOICE",
    lines: lines.map((line) => ({
      saleLineId: line.id,
      productId: line.product_id,
      productName: line.product_name_snapshot,
      sku: line.sku_snapshot,
      unit: line.unit_snapshot,
      quantity: line.quantity,
      unitPrice: money(line.unit_price_centavos),
      taxClass: line.tax_class_snapshot,
      scPwdEligible: line.sc_pwd_eligible_snapshot === 1,
      isScEligible: line.sc_eligible_snapshot === 1,
      isPwdEligible: line.pwd_eligible_snapshot === 1,
      productType:
        line.product_type_applicable_snapshot === 0
          ? "NOT_APPLICABLE"
          : line.product_type_snapshot,
      benefitApplied: line.benefit_applied === 1,
      benefitTreatment: line.benefit_treatment_snapshot,
      bnpcEligible: line.bnpc_eligible_snapshot === 1,
      bnpcCategory: line.bnpc_category_snapshot,
      bnpcPrescriptionRequired: line.bnpc_prescription_required_snapshot === 1,
      bnpcDiscount: money(line.bnpc_discount_centavos),
      bnpcPolicyVersion: line.bnpc_policy_version,
      lotAllocations: (
        db
          .prepare(
            `SELECT a.lot_id, l.lot_code, l.expiry_date, a.quantity
             FROM sale_line_lot_allocations a
             JOIN inventory_lots l ON l.id = a.lot_id
             WHERE a.sale_line_id = ? ORDER BY l.expiry_date, l.lot_code, l.id`,
          )
          .all(line.id) as Array<{
          lot_id: string;
          lot_code: string;
          expiry_date: string;
          quantity: number;
        }>
      ).map((lot) => ({
        lotId: lot.lot_id,
        lotCode: lot.lot_code,
        expiryDate: lot.expiry_date,
        quantity: lot.quantity,
      })),
      taxBasis: money(line.tax_basis_centavos),
      vat: money(line.vat_centavos),
      vatRemoved: money(line.vat_removed_centavos),
      discount: money(line.discount_centavos),
      bundlePromotionDiscount: money(line.bundle_promotion_discount_centavos),
      bundle: (() => {
        const row = db
          .prepare(
            `SELECT b.code_snapshot, b.name_snapshot, b.version_snapshot,
                    b.quantity AS bundle_quantity,
                    b.promotional_price_per_bundle_centavos,
                    b.price_rule_version, b.discount_interaction_rule,
                    c.component_quantity_per_bundle,
                    c.regular_line_total_centavos,
                    c.promotional_discount_allocated_centavos,
                    c.promotional_discount_applied_centavos,
                    c.selected_statutory_treatment
             FROM sale_bundle_component_snapshots c
             JOIN sale_bundle_snapshots b ON b.id = c.sale_bundle_snapshot_id
             WHERE c.sale_line_id = ?`,
          )
          .get(line.id) as
          | {
              code_snapshot: string;
              name_snapshot: string;
              version_snapshot: number;
              bundle_quantity: number;
              promotional_price_per_bundle_centavos: number;
              price_rule_version: string;
              discount_interaction_rule: string;
              component_quantity_per_bundle: number;
              regular_line_total_centavos: number;
              promotional_discount_allocated_centavos: number;
              promotional_discount_applied_centavos: number;
              selected_statutory_treatment: string;
            }
          | undefined;
        return row
          ? {
              code: row.code_snapshot,
              name: row.name_snapshot,
              version: row.version_snapshot,
              bundleQuantity: row.bundle_quantity,
              promotionalPricePerBundle: money(
                row.promotional_price_per_bundle_centavos,
              ),
              componentQuantityPerBundle: row.component_quantity_per_bundle,
              regularLineTotal: money(row.regular_line_total_centavos),
              allocatedPromotionDiscount: money(
                row.promotional_discount_allocated_centavos,
              ),
              appliedPromotionDiscount: money(
                row.promotional_discount_applied_centavos,
              ),
              selectedStatutoryTreatment: row.selected_statutory_treatment,
              priceRuleVersion: row.price_rule_version,
              discountInteractionRule: row.discount_interaction_rule,
            }
          : null;
      })(),
      bnpc: (() => {
        const bnpc = db
          .prepare(
            `SELECT p.version, p.effective_from, p.source_title,
                    s.week_start_date, s.local_purchase_before_centavos,
                    s.local_discount_before_centavos,
                    s.external_purchase_attested_centavos,
                    s.external_discount_attested_centavos,
                    s.verified_purchase_allowance_centavos,
                    s.verified_discount_allowance_centavos,
                    s.local_purchase_applied_centavos,
                    s.bnpc_discount_centavos, s.booklet_checked,
                    s.representative_purchase, s.representative_documents_checked,
                    s.authorization_letter_issued_date, s.prescription_applicable,
                    s.prescription_checked, s.four_kinds_checked
             FROM sale_bnpc_snapshots s
             JOIN bnpc_policy_versions p ON p.id = s.bnpc_policy_version_id
             WHERE s.sale_id = ?`,
          )
          .get(id) as
          | {
              version: string;
              effective_from: string;
              source_title: string;
              week_start_date: string;
              local_purchase_before_centavos: number;
              local_discount_before_centavos: number;
              external_purchase_attested_centavos: number;
              external_discount_attested_centavos: number;
              verified_purchase_allowance_centavos: number;
              verified_discount_allowance_centavos: number;
              local_purchase_applied_centavos: number;
              bnpc_discount_centavos: number;
              booklet_checked: number;
              representative_purchase: number;
              representative_documents_checked: number;
              authorization_letter_issued_date: string | null;
              prescription_applicable: number;
              prescription_checked: number;
              four_kinds_checked: number;
            }
          | undefined;
        return bnpc
          ? {
              policyVersion: bnpc.version,
              effectiveFrom: bnpc.effective_from,
              sourceTitle: bnpc.source_title,
              weekStartDate: bnpc.week_start_date,
              localPurchaseBefore: money(bnpc.local_purchase_before_centavos),
              localDiscountBefore: money(bnpc.local_discount_before_centavos),
              externalPurchaseAttested: money(
                bnpc.external_purchase_attested_centavos,
              ),
              externalDiscountAttested: money(
                bnpc.external_discount_attested_centavos,
              ),
              verifiedPurchaseAllowance: money(
                bnpc.verified_purchase_allowance_centavos,
              ),
              verifiedDiscountAllowance: money(
                bnpc.verified_discount_allowance_centavos,
              ),
              localPurchaseApplied: money(bnpc.local_purchase_applied_centavos),
              discount: money(bnpc.bnpc_discount_centavos),
              bookletChecked: bnpc.booklet_checked === 1,
              representativePurchase: bnpc.representative_purchase === 1,
              representativeDocumentsChecked:
                bnpc.representative_documents_checked === 1,
              authorizationLetterIssuedDate:
                bnpc.authorization_letter_issued_date,
              prescriptionApplicable: bnpc.prescription_applicable === 1,
              prescriptionChecked: bnpc.prescription_checked === 1,
              fourKindsChecked: bnpc.four_kinds_checked === 1,
              localStoreOnly: true,
            }
          : null;
      })(),
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
        cashRoundingMode: parsed.data.cashRoundingMode,
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
            cashRoundingMode: approval.cashRoundingMode,
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
    const registerShiftRow = db
      .prepare(
        `SELECT s.id, s.opened_at, s.opening_cash_centavos,
                s.expected_cash_centavos, u.email AS opened_by_email
         FROM shifts s JOIN users u ON u.id = s.cashier_user_id
         WHERE s.closed_at IS NULL LIMIT 1`,
      )
      .get() as
      | {
          id: string;
          opened_at: string;
          opening_cash_centavos: number;
          expected_cash_centavos: number;
          opened_by_email: string;
        }
      | undefined;
    const expectedQrSalesCentavos = registerShiftRow
      ? (
          db
            .prepare(
              `SELECT COALESCE(SUM(
                 CASE WHEN s.payment_method = 'QR'
                      THEN s.amount_due_centavos ELSE 0 END
                 - CASE WHEN r.refund_method = 'QR'
                        THEN r.amount_centavos ELSE 0 END
               ), 0) AS qr_sales_centavos
               FROM sales s
               LEFT JOIN sale_reversals r ON r.sale_id = s.id
               WHERE s.shift_id = ?`,
            )
            .get(registerShiftRow.id) as { qr_sales_centavos: number }
        ).qr_sales_centavos
      : 0;
    res.json({
      shift: shift
        ? {
            id: shift.id,
            openedAt: shift.opened_at,
            openingCash: money(shift.opening_cash_centavos),
            expectedCash: money(shift.expected_cash_centavos),
            expectedQrSales: money(expectedQrSalesCentavos),
          }
        : null,
      registerOpen: Boolean(registerShiftRow),
      registerShift: registerShiftRow
        ? {
            id: registerShiftRow.id,
            openedAt: registerShiftRow.opened_at,
            openedByEmail: registerShiftRow.opened_by_email,
            openingCash: money(registerShiftRow.opening_cash_centavos),
            expectedCash: money(registerShiftRow.expected_cash_centavos),
            expectedQrSales: money(expectedQrSalesCentavos),
          }
        : null,
    });
  });

  router.get("/shifts/daily-sales-summary", requireAuth, (req, res) => {
    const parsedDate = z.iso
      .date()
      .safeParse(req.query.date ?? manilaBusinessDate(new Date()));
    if (!parsedDate.success)
      return res.status(400).json({ error: "invalid_report_date" });
    const date = parsedDate.data;
    const cashierOnly =
      req.user!.role === "owner" ? "" : "AND s.cashier_user_id = ?";
    const parameters =
      req.user!.role === "owner" ? [date] : [date, req.user!.id];
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS transaction_count,
                COALESCE(SUM(amount_due_centavos), 0) AS sales_centavos,
                COALESCE(SUM(CASE WHEN payment_method = 'CASH' THEN amount_due_centavos ELSE 0 END), 0)
                  AS cash_sales_centavos,
                COALESCE(SUM(CASE WHEN payment_method = 'QR' THEN amount_due_centavos ELSE 0 END), 0)
                  AS qr_sales_centavos
         FROM sales s WHERE s.business_date = ? ${cashierOnly}`,
      )
      .get(...parameters) as {
      transaction_count: number;
      sales_centavos: number;
      cash_sales_centavos: number;
      qr_sales_centavos: number;
    };
    const shifts = db
      .prepare(
        `SELECT sh.id, sh.opened_at, sh.closed_at, u.email AS cashier_email,
                COUNT(s.id) AS transaction_count,
                COALESCE(SUM(s.amount_due_centavos), 0) AS sales_centavos,
                COALESCE(SUM(CASE WHEN s.payment_method = 'CASH' THEN s.amount_due_centavos ELSE 0 END), 0)
                  AS cash_sales_centavos,
                COALESCE(SUM(CASE WHEN s.payment_method = 'QR' THEN s.amount_due_centavos ELSE 0 END), 0)
                  AS qr_sales_centavos
         FROM sales s
         JOIN shifts sh ON sh.id = s.shift_id
         JOIN users u ON u.id = sh.cashier_user_id
         WHERE s.business_date = ? ${cashierOnly}
         GROUP BY sh.id
         ORDER BY sh.opened_at, sh.id`,
      )
      .all(...parameters) as Array<{
      id: string;
      opened_at: string;
      closed_at: string | null;
      cashier_email: string;
      transaction_count: number;
      sales_centavos: number;
      cash_sales_centavos: number;
      qr_sales_centavos: number;
    }>;
    const products = db
      .prepare(
        `SELECT sl.sku_snapshot AS sku,
                sl.product_name_snapshot AS name,
                SUM(sl.quantity) AS quantity,
                SUM(sl.amount_due_centavos) AS sales_centavos
         FROM sales s JOIN sale_lines sl ON sl.sale_id = s.id
         WHERE s.business_date = ? ${cashierOnly}
         GROUP BY sl.product_id, sl.sku_snapshot, sl.product_name_snapshot
         ORDER BY sales_centavos DESC, name COLLATE NOCASE`,
      )
      .all(...parameters) as Array<{
      sku: string;
      name: string;
      quantity: number;
      sales_centavos: number;
    }>;
    res.json({
      summary: {
        businessDate: date,
        scope: req.user!.role === "owner" ? "STORE" : "CASHIER",
        totals: {
          transactionCount: totals.transaction_count,
          sales: money(totals.sales_centavos),
          cashSales: money(totals.cash_sales_centavos),
          qrSales: money(totals.qr_sales_centavos),
        },
        shifts: shifts.map((shift) => ({
          id: shift.id,
          cashierEmail: shift.cashier_email,
          openedAt: shift.opened_at,
          closedAt: shift.closed_at,
          transactionCount: shift.transaction_count,
          sales: money(shift.sales_centavos),
          cashSales: money(shift.cash_sales_centavos),
          qrSales: money(shift.qr_sales_centavos),
        })),
        products: products.map((product) => ({
          sku: product.sku,
          name: product.name,
          quantity: product.quantity,
          sales: money(product.sales_centavos),
        })),
      },
    });
  });

  router.get("/shifts/history", requireAuth, requireOwner, (req, res) => {
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(500)
      .safeParse(req.query.limit ?? "200");
    const beforeOpenedAt = z
      .string()
      .datetime()
      .optional()
      .safeParse(req.query.beforeOpenedAt);
    const beforeId = z
      .string()
      .min(1)
      .max(100)
      .optional()
      .safeParse(req.query.beforeId);
    if (
      !limit.success ||
      !beforeOpenedAt.success ||
      !beforeId.success ||
      Boolean(beforeOpenedAt.data) !== Boolean(beforeId.data)
    ) {
      return validationFailure(res);
    }
    const rows = db
      .prepare(
        `SELECT s.id, s.opened_at, s.closed_at, s.opening_cash_centavos,
                s.expected_cash_centavos, s.actual_cash_count_centavos,
                s.variance_centavos, s.variance_reason,
                opened.email AS opened_by_email,
                closed.email AS closed_by_email,
                COALESCE(sales.cash_sales_centavos, 0) AS cash_sales_centavos,
                COALESCE(sales.qr_sales_centavos, 0) AS qr_sales_centavos,
                COALESCE(sales.qr_refunds_centavos, 0) AS qr_refunds_centavos,
                COALESCE(movements.cash_refunds_centavos, 0) AS cash_refunds_centavos,
                COALESCE(movements.cash_in_centavos, 0) AS cash_in_centavos,
                COALESCE(movements.cash_out_centavos, 0) AS cash_out_centavos
         FROM shifts s
         JOIN users opened ON opened.id = s.cashier_user_id
         LEFT JOIN users closed ON closed.id = s.close_actor_user_id
         LEFT JOIN (
           SELECT s.shift_id,
                  SUM(CASE WHEN s.payment_method = 'CASH' THEN s.amount_due_centavos ELSE 0 END)
                    AS cash_sales_centavos,
                  SUM(CASE WHEN s.payment_method = 'QR' THEN s.amount_due_centavos ELSE 0 END)
                    AS qr_sales_centavos,
                  SUM(CASE WHEN r.refund_method = 'QR' THEN r.amount_centavos ELSE 0 END)
                    AS qr_refunds_centavos
           FROM sales s
           LEFT JOIN sale_reversals r ON r.sale_id = s.id
           GROUP BY s.shift_id
         ) sales ON sales.shift_id = s.id
         LEFT JOIN (
           SELECT shift_id,
                  SUM(CASE WHEN movement_type = 'CASH_REFUND' THEN -amount_delta_centavos ELSE 0 END)
                    AS cash_refunds_centavos,
                  SUM(CASE WHEN movement_type = 'CASH_IN' THEN amount_delta_centavos ELSE 0 END)
                    AS cash_in_centavos,
                  SUM(CASE WHEN movement_type = 'CASH_OUT' THEN -amount_delta_centavos ELSE 0 END)
                    AS cash_out_centavos
           FROM cash_movements GROUP BY shift_id
         ) movements ON movements.shift_id = s.id
         WHERE (? IS NULL OR s.opened_at < ? OR (s.opened_at = ? AND s.id < ?))
         ORDER BY s.opened_at DESC, s.id DESC LIMIT ?`,
      )
      .all(
        beforeOpenedAt.data ?? null,
        beforeOpenedAt.data ?? null,
        beforeOpenedAt.data ?? null,
        beforeId.data ?? null,
        limit.data + 1,
      ) as {
      id: string;
      opened_at: string;
      closed_at: string | null;
      opening_cash_centavos: number;
      expected_cash_centavos: number | null;
      actual_cash_count_centavos: number | null;
      variance_centavos: number | null;
      variance_reason: string | null;
      opened_by_email: string;
      closed_by_email: string | null;
      cash_sales_centavos: number;
      qr_sales_centavos: number;
      qr_refunds_centavos: number;
      cash_refunds_centavos: number;
      cash_in_centavos: number;
      cash_out_centavos: number;
    }[];
    res.json({
      shifts: rows.slice(0, limit.data).map((row) => ({
        id: row.id,
        status: row.closed_at === null ? "OPEN" : "CLOSED",
        openedAt: row.opened_at,
        closedAt: row.closed_at,
        openedByEmail: row.opened_by_email,
        closedByEmail: row.closed_by_email,
        openingCash: money(row.opening_cash_centavos),
        cashSales: money(row.cash_sales_centavos),
        qrSales: money(row.qr_sales_centavos),
        qrRefunds: money(row.qr_refunds_centavos),
        cashRefunds: money(row.cash_refunds_centavos),
        cashIn: money(row.cash_in_centavos),
        cashOut: money(row.cash_out_centavos),
        expectedCash: money(
          row.expected_cash_centavos ?? row.opening_cash_centavos,
        ),
        actualCashCount:
          row.actual_cash_count_centavos === null
            ? null
            : money(row.actual_cash_count_centavos),
        variance:
          row.variance_centavos === null ? null : money(row.variance_centavos),
        varianceReason: row.variance_reason,
      })),
      hasMore: rows.length > limit.data,
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
        if (
          db
            .prepare("SELECT 1 FROM shifts WHERE closed_at IS NULL LIMIT 1")
            .get()
        ) {
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
          expectedQrSales: money(0),
        },
      });
    } catch (error) {
      if (!handleSalesError(error, res)) throw error;
    }
  });

  function closeShiftRequest(
    req: Request,
    res: Response,
    emergencyClose: boolean,
  ) {
    const id = z.uuid().safeParse(req.params.id);
    const parsed = closeShiftSchema.safeParse(req.body);
    if (!id.success || !parsed.success || !req.user)
      return validationFailure(res);
    try {
      const actualCash = parseMoney(parsed.data.actualCashCount);
      const result = db.transaction(() => {
        const shift = db
          .prepare(
            emergencyClose
              ? `SELECT id, expected_cash_centavos FROM shifts
                 WHERE id = ? AND closed_at IS NULL`
              : `SELECT id, expected_cash_centavos FROM shifts
                 WHERE id = ? AND cashier_user_id = ? AND closed_at IS NULL`,
          )
          .get(...(emergencyClose ? [id.data] : [id.data, req.user!.id])) as
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
        const varianceApprovalStatus = variance === 0 ? "NONE" : "PENDING";
        db.prepare(
          `UPDATE shifts SET closed_at = ?, actual_cash_count_centavos = ?,
             variance_centavos = ?, variance_reason = ?, close_actor_user_id = ?,
             variance_approval_status = ?
           WHERE id = ?`,
        ).run(
          now,
          actualCash,
          variance,
          parsed.data.varianceReason?.trim() || null,
          req.user!.id,
          varianceApprovalStatus,
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
            varianceApprovalStatus,
            emergencyClose,
          },
        });
        return {
          id: shift.id,
          expectedCashCentavos: shift.expected_cash_centavos,
          actualCashCentavos: actualCash,
          varianceCentavos: variance,
          varianceApprovalStatus,
          closedAt: now,
        };
      })();
      res.json({
        shift: {
          id: result.id,
          expectedCash: money(result.expectedCashCentavos),
          actualCashCount: money(result.actualCashCentavos),
          variance: money(result.varianceCentavos),
          varianceApprovalStatus: result.varianceApprovalStatus,
          closedAt: result.closedAt,
        },
      });
    } catch (error) {
      if (!handleSalesError(error, res)) throw error;
    }
  }

  router.post("/shifts/:id/close", requireAuth, csrf, (req, res) => {
    closeShiftRequest(req, res, false);
  });

  router.post("/shifts/:id/emergency-close", requireAuth, csrf, (req, res) =>
    closeShiftRequest(req, res, true),
  );

  router.post("/sales/preview", requireAuth, csrf, (req, res) => {
    const parsed = checkoutBaseSchema.safeParse(req.body);
    if (!parsed.success) return validationFailure(res);
    try {
      const policy = taxPolicy(db);
      const bnpcContext = bnpcContextForCheckout(
        db,
        parsed.data.items,
        parsed.data.bundleOffers,
        parsed.data.benefitType,
        parsed.data.customerIdNumber,
        parsed.data.bnpcChecks,
      );
      const result = calculateCart(
        db,
        parsed.data.benefitType,
        parsed.data.items,
        policy,
        parsed.data.paymentMethod,
        false,
        parsed.data.bundleOffers,
        bnpcContext,
      );
      res.json(
        presentCheckout(
          db,
          result,
          policy,
          parsed.data.paymentMethod,
          bnpcContext,
        ),
      );
    } catch (error) {
      if (!handleSalesError(error, res)) throw error;
    }
  });

  router.post("/sales", requireAuth, csrf, (req, res) => {
    const parsed = saleRequestSchema.safeParse(req.body);
    if (!parsed.success || !req.user) return validationFailure(res);
    const bnpcRequested = hasRequestedBnpc(
      parsed.data.items,
      parsed.data.bundleOffers,
    );
    let holderKeyForHash: string | null = null;
    if (bnpcRequested) {
      if (!parsed.data.customerIdNumber) {
        return res.status(400).json({ error: "bnpc_evidence_required" });
      }
      try {
        holderKeyForHash = bnpcHolderKey(parsed.data.customerIdNumber);
      } catch (error) {
        if (error instanceof CustomerDataError) {
          return res.status(503).json({ error: error.code });
        }
        throw error;
      }
    }
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          benefitType: parsed.data.benefitType,
          paymentMethod: parsed.data.paymentMethod,
          items: parsed.data.items,
          bundleOffers: parsed.data.bundleOffers,
          bnpcChecks: parsed.data.bnpcChecks ?? null,
          bnpcHolderKey: holderKeyForHash,
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
        const bnpcContext = bnpcContextForCheckout(
          db,
          parsed.data.items,
          parsed.data.bundleOffers,
          parsed.data.benefitType,
          parsed.data.customerIdNumber,
          parsed.data.bnpcChecks,
        );
        const preview = calculateCart(
          db,
          parsed.data.benefitType,
          parsed.data.items,
          policy,
          parsed.data.paymentMethod,
          true,
          parsed.data.bundleOffers,
          bnpcContext,
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
        const customerBirthdayCiphertext =
          parsed.data.benefitType === "REGULAR" || !parsed.data.customerBirthday
            ? null
            : encryptCustomerField(
                parsed.data.customerBirthday,
                `${saleId}/birthday`,
              );
        const customerLookupDigestValue =
          parsed.data.benefitType === "REGULAR" || !parsed.data.customerBirthday
            ? null
            : customerLookupDigest(
                parsed.data.customerName!,
                parsed.data.customerBirthday,
              );
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
             customer_birthday_ciphertext, customer_lookup_digest,
             customer_id_type_ciphertext, customer_id_number_ciphertext,
             customer_id_checked, payment_method, subtotal_centavos, vat_centavos,
             vat_removed_centavos,
             senior_discount_centavos, pwd_discount_centavos, amount_due_centavos,
             tax_policy_version, created_at, cash_rounding_mode,
             cash_rounding_adjustment_centavos, bnpc_discount_centavos)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          customerBirthdayCiphertext,
          customerLookupDigestValue,
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
          policy.cashRoundingMode,
          preview.cashRoundingAdjustmentCentavos,
          preview.bnpcDiscountCentavos,
        );

        const bundleSnapshotIds = new Map<string, string>();
        const insertBundleSnapshot = db.prepare(
          `INSERT INTO sale_bundle_snapshots
            (id, sale_id, bundle_id, bundle_version_id, code_snapshot,
             name_snapshot, version_snapshot, active_from_snapshot,
             active_until_snapshot, quantity, max_quantity_per_sale_snapshot,
             regular_total_centavos, promotional_price_per_bundle_centavos,
             promotional_discount_offered_centavos,
             promotional_discount_applied_centavos, price_rule_version,
             discount_interaction_rule, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const { snapshot } of preview.bundleOffers) {
          const snapshotId = randomUUID();
          bundleSnapshotIds.set(snapshot.offerKey, snapshotId);
          insertBundleSnapshot.run(
            snapshotId,
            saleId,
            snapshot.bundleId,
            snapshot.bundleVersionId,
            snapshot.code,
            snapshot.name,
            snapshot.version,
            snapshot.activeFrom,
            snapshot.activeUntil,
            snapshot.quantity,
            snapshot.maxQuantityPerSale,
            snapshot.regularTotalCentavos,
            snapshot.promotionalPriceCentavos,
            snapshot.promotionalDiscountOfferedCentavos,
            snapshot.promotionalDiscountAppliedCentavos,
            snapshot.priceRuleVersion,
            snapshot.discountInteractionRule,
            now,
          );
        }

        const insertLine = db.prepare(
          `INSERT INTO sale_lines
            (id, sale_id, line_number, product_id, product_name_snapshot,
             sku_snapshot, unit_snapshot, quantity, unit_price_centavos,
             tax_class_snapshot, sc_pwd_eligible_snapshot,
             sc_eligible_snapshot, pwd_eligible_snapshot, product_type_snapshot,
             product_type_applicable_snapshot,
             benefit_applied, benefit_treatment_snapshot,
             bnpc_eligible_snapshot, bnpc_category_snapshot,
             bnpc_discount_centavos, bnpc_policy_version,
             bnpc_prescription_required_snapshot,
             tax_basis_centavos, vat_centavos, vat_removed_centavos, discount_centavos,
             bundle_promotion_discount_centavos,
             amount_due_centavos, allocated_cogs_centavos,
             tax_policy_version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          const stockEventId = createStockEvent(db, {
            productId: product.id,
            quantityDelta: -line.quantity,
            unitCostCentavos: unitCogs,
            inventoryValueDeltaCentavos: -allocatedCogs,
            actorUserId: req.user!.id,
            createdAt: now,
          });
          const saleLineId = randomUUID();
          insertLine.run(
            saleLineId,
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
            line.product.sc_eligible,
            line.product.pwd_eligible,
            line.product.product_type,
            line.product.product_type_applicable,
            line.benefitApplied ? 1 : 0,
            line.benefitTreatment,
            line.product.bnpc_eligible,
            line.product.bnpc_category,
            line.bnpcDiscountCentavos,
            bnpcContext && line.requestedBenefitTreatment === "BNPC"
              ? bnpcContext.policy.id
              : null,
            0,
            line.taxBasisCentavos,
            line.vatCentavos,
            line.vatRemovedCentavos,
            line.discountCentavos,
            line.bundle?.appliedPromotionDiscountCentavos ?? 0,
            line.amountDueCentavos,
            allocatedCogs,
            line.ruleVersion,
            now,
          );
          if (line.bundle) {
            const snapshotId = bundleSnapshotIds.get(line.bundle.offerKey);
            if (!snapshotId) {
              throw new SalesError(500, "bundle_snapshot_missing");
            }
            db.prepare(
              `INSERT INTO sale_bundle_component_snapshots
                (id, sale_bundle_snapshot_id, sale_line_id, product_id,
                 component_quantity_per_bundle, total_quantity,
                 regular_unit_price_centavos, regular_line_total_centavos,
                 promotional_discount_allocated_centavos,
                 promotional_discount_applied_centavos,
                 selected_statutory_treatment, tax_policy_version, created_at,
                 benefit_treatment_snapshot)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              randomUUID(),
              snapshotId,
              saleLineId,
              line.product.id,
              line.bundle.componentQuantityPerBundle,
              line.quantity,
              line.unitPriceCentavos,
              line.regularGrossCentavos,
              line.bundle.allocatedPromotionDiscountCentavos,
              line.bundle.appliedPromotionDiscountCentavos,
              line.benefitTreatment,
              line.ruleVersion,
              now,
              line.benefitTreatment,
            );
          }
          if (line.product.tracks_lots === 1) {
            let remainingCogs = allocatedCogs;
            for (const [
              lotIndex,
              allocation,
            ] of line.lotAllocations.entries()) {
              const allocationCogs =
                lotIndex === line.lotAllocations.length - 1
                  ? remainingCogs
                  : roundedInteger(
                      new Decimal(allocatedCogs)
                        .mul(allocation.quantity)
                        .div(line.quantity),
                    );
              remainingCogs -= allocationCogs;
              db.prepare(
                `INSERT INTO sale_line_lot_allocations
                  (id, sale_line_id, lot_id, quantity, allocated_cogs_centavos, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
              ).run(
                randomUUID(),
                saleLineId,
                allocation.lotId,
                allocation.quantity,
                allocationCogs,
                now,
              );
              writeLotMovement(db, {
                productId: line.product.id,
                lotId: allocation.lotId,
                type: "SALE",
                stockEventId,
                saleLineId,
                quantityDelta: -allocation.quantity,
                inventoryValueDeltaCentavos: -allocationCogs,
                unitCostCentavos: roundedInteger(
                  new Decimal(allocationCogs).div(allocation.quantity),
                ),
                actorUserId: req.user!.id,
                createdAt: now,
              });
            }
          } else {
            writeLotMovement(db, {
              productId: line.product.id,
              lotId: null,
              type: "SALE",
              stockEventId,
              quantityDelta: -line.quantity,
              inventoryValueDeltaCentavos: -allocatedCogs,
              unitCostCentavos: unitCogs,
              actorUserId: req.user!.id,
              createdAt: now,
            });
          }
        }

        if (bnpcContext) {
          db.prepare(
            `INSERT INTO sale_bnpc_snapshots
             (id, sale_id, bnpc_policy_version_id, holder_type, holder_key_hmac,
              week_start_date, local_purchase_before_centavos,
              local_discount_before_centavos,
              external_purchase_attested_centavos,
              external_discount_attested_centavos,
              verified_purchase_allowance_centavos,
              verified_discount_allowance_centavos,
              local_purchase_applied_centavos, bnpc_discount_centavos,
              booklet_checked, representative_purchase,
              representative_documents_checked,
              authorization_letter_issued_date, prescription_applicable,
              prescription_checked, four_kinds_checked, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            randomUUID(),
            saleId,
            bnpcContext.policy.id,
            parsed.data.benefitType,
            bnpcContext.holderKeyHmac,
            bnpcContext.weekStartDate,
            bnpcContext.localPurchaseBeforeCentavos,
            bnpcContext.localDiscountBeforeCentavos,
            bnpcContext.externalPurchaseAttestedCentavos,
            bnpcContext.externalDiscountAttestedCentavos,
            bnpcContext.purchaseAllowanceCentavos,
            bnpcContext.discountAllowanceCentavos,
            preview.bnpcPurchaseCentavos,
            preview.bnpcDiscountCentavos,
            bnpcContext.evidence.bookletChecked ? 1 : 0,
            bnpcContext.evidence.representativePurchase ? 1 : 0,
            bnpcContext.evidence.representativeDocumentsChecked ? 1 : 0,
            bnpcContext.evidence.authorizationLetterIssuedDate,
            bnpcContext.evidence.prescriptionApplicable ? 1 : 0,
            bnpcContext.evidence.prescriptionChecked ? 1 : 0,
            bnpcContext.evidence.fourKindsChecked ? 1 : 0,
            now,
          );
          db.prepare(
            `INSERT INTO bnpc_usage_events
             (id, holder_key_hmac, week_start_date, event_type, sale_id,
              qualifying_purchase_delta_centavos, bnpc_discount_delta_centavos,
              created_at)
             VALUES (?, ?, ?, 'SALE', ?, ?, ?, ?)`,
          ).run(
            randomUUID(),
            bnpcContext.holderKeyHmac,
            bnpcContext.weekStartDate,
            saleId,
            preview.bnpcPurchaseCentavos,
            preview.bnpcDiscountCentavos,
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
            cashRoundingMode: policy.cashRoundingMode,
            cashRoundingAdjustmentCentavos:
              preview.cashRoundingAdjustmentCentavos,
            lotAllocations: preview.lines
              .filter((line) => line.product.tracks_lots === 1)
              .map((line) => ({
                productId: line.product.id,
                allocations: line.lotAllocations,
              })),
          },
        });
        return { id: saleId, replayed: false };
      })();
      const sale = getSavedSale(db, outcome.id, req.user?.role === "owner");
      res.status(outcome.replayed ? 200 : 201).json({
        sale,
        replayed: outcome.replayed,
      });
    } catch (error) {
      if (!handleSalesError(error, res)) throw error;
    }
  });

  router.get("/sales/customer-lookup", requireAuth, (req, res) => {
    const parsed = z
      .object({
        benefitType: z.enum(["SENIOR_CITIZEN", "PWD"]),
        name: z.string().trim().min(2).max(160),
        birthday: z.iso.date(),
      })
      .strict()
      .safeParse({
        benefitType: req.query.benefitType,
        name: req.query.name,
        birthday: req.query.birthday,
      });
    if (!parsed.success || !req.user)
      return res.status(400).json({ error: "invalid_customer_lookup" });
    try {
      const digest = customerLookupDigest(
        parsed.data.name,
        parsed.data.birthday,
      );
      const row = db
        .prepare(
          `SELECT id, transaction_id, benefit_type,
                  customer_id_type_ciphertext, customer_id_number_ciphertext
           FROM sales WHERE customer_lookup_digest = ? AND benefit_type = ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(digest, parsed.data.benefitType) as
        | {
            id: string;
            transaction_id: string;
            benefit_type: "SENIOR_CITIZEN" | "PWD";
            customer_id_type_ciphertext: string | null;
            customer_id_number_ciphertext: string | null;
          }
        | undefined;
      if (!row) return res.json({ customer: null });
      const customer = {
        benefitType: row.benefit_type,
        idType: decryptCustomerField(
          row.customer_id_type_ciphertext!,
          `${row.id}/id-type`,
        ),
        idNumber: decryptCustomerField(
          row.customer_id_number_ciphertext!,
          `${row.id}/id-number`,
        ),
      };
      writeAuditEvent(db, {
        actorUserId: req.user.id,
        action: "sale.customer_details_prefilled",
        entityType: "sale",
        entityId: row.id,
        details: { transactionId: row.transaction_id },
      });
      res.json({ customer });
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
      sale: getSavedSale(db, saleRow.id, req.user.role === "owner"),
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
                  customer_birthday_ciphertext,
                  customer_id_type_ciphertext, customer_id_number_ciphertext,
                  customer_id_checked
           FROM sales WHERE transaction_id = ?`,
        )
        .get(transactionId.data) as
        | {
            id: string;
            benefit_type: SaleBenefit;
            customer_name_ciphertext: string | null;
            customer_birthday_ciphertext: string | null;
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
          birthday: row.customer_birthday_ciphertext
            ? decryptCustomerField(
                row.customer_birthday_ciphertext,
                `${row.id}/birthday`,
              )
            : null,
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
