import type Database from "better-sqlite3";
import type { Request, Response } from "express";
import express from "express";
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { z } from "zod";
import { requireAuthentication, requireCsrf, requireRole } from "./auth.js";
import { writeAuditEvent } from "./db.js";
import { getLotBalances, manilaCalendarDate } from "./lot-stock.js";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  });
const componentSchema = z
  .object({
    productId: z.uuid(),
    quantity: z.number().int().min(1).max(10_000),
  })
  .strict();
const editSchema = z
  .object({
    code: z.string().trim().min(1).max(48),
    name: z.string().trim().min(1).max(160),
    activeFrom: dateSchema,
    activeUntil: dateSchema.nullable(),
    maxQuantityPerSale: z.number().int().min(1).max(1000).nullable(),
    reductionType: z.enum(["PERCENT", "AMOUNT"]),
    reductionValue: z.number().int().positive(),
    promotionalPrice: z
      .string()
      .trim()
      .regex(/^\d{1,7}(?:\.\d{1,2})?$/),
    confirmFinalPrice: z.literal(true),
    components: z.array(componentSchema).min(2).max(20),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.activeUntil && value.activeUntil < value.activeFrom) {
      context.addIssue({
        code: "custom",
        path: ["activeUntil"],
        message: "invalid_active_period",
      });
    }
    if (value.reductionType === "PERCENT" && value.reductionValue > 9_999) {
      context.addIssue({
        code: "custom",
        path: ["reductionValue"],
        message: "invalid_percentage_reduction",
      });
    }
    const ids = value.components.map((component) => component.productId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["components"],
        message: "duplicate_bundle_component",
      });
    }
  });
const activeSchema = z.object({ active: z.boolean() }).strict();

type BundleRow = {
  id: string;
  code: string;
  is_active: number;
  current_version: number;
  version_id: string;
  name_snapshot: string;
  active_from: string;
  active_until: string | null;
  max_quantity_per_sale: number | null;
  reduction_type: "PERCENT" | "AMOUNT";
  reduction_value: number;
  suggested_price_centavos: number;
  promotional_price_centavos: number;
  price_rule_version: string;
  discount_interaction_rule: string;
};

function money(value: number): string {
  return new Decimal(value).div(100).toFixed(2);
}

function parseMoney(value: string): number {
  const cents = new Decimal(value).mul(100);
  const parsed = cents.toNumber();
  if (!cents.isInteger() || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new BundleError(400, "invalid_promotional_price");
  }
  return parsed;
}

class BundleError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function calculatedPricing(
  db: Database.Database,
  components: z.infer<typeof componentSchema>[],
  reductionType: "PERCENT" | "AMOUNT",
  reductionValue: number,
) {
  const products = components.map((component) => {
    const product = db
      .prepare(
        "SELECT id, selling_price_centavos, is_active FROM products WHERE id = ?",
      )
      .get(component.productId) as
      | { id: string; selling_price_centavos: number; is_active: number }
      | undefined;
    if (!product || product.is_active !== 1)
      throw new BundleError(400, "bundle_component_unavailable");
    return { ...component, unitPrice: product.selling_price_centavos };
  });
  const regularTotalCentavos = products.reduce((total, component) => {
    const next =
      total + BigInt(component.unitPrice) * BigInt(component.quantity);
    if (next > BigInt(Number.MAX_SAFE_INTEGER))
      throw new BundleError(400, "bundle_price_overflow");
    return next;
  }, 0n);
  const reduction =
    reductionType === "PERCENT"
      ? (regularTotalCentavos * BigInt(reductionValue) + 5_000n) / 10_000n
      : BigInt(reductionValue);
  const suggested = regularTotalCentavos - reduction;
  if (suggested <= 0n || suggested > BigInt(Number.MAX_SAFE_INTEGER))
    throw new BundleError(400, "invalid_bundle_suggested_price");
  return {
    products,
    regularTotalCentavos: Number(regularTotalCentavos),
    suggestedPriceCentavos: Number(suggested),
  };
}

function presentStoredVersion(db: Database.Database, row: BundleRow) {
  const components = db
    .prepare(
      `SELECT c.product_id, c.quantity, c.component_order, p.sku, p.name,
            p.unit, p.selling_price_centavos
     FROM sales_bundle_version_components c JOIN products p ON p.id = c.product_id
     WHERE c.bundle_version_id = ? ORDER BY c.component_order`,
    )
    .all(row.version_id) as Array<{
    product_id: string;
    quantity: number;
    component_order: number;
    sku: string;
    name: string;
    unit: string;
    selling_price_centavos: number;
  }>;
  const pricing = components.map((component) => ({
    productId: component.product_id,
    quantity: component.quantity,
    order: component.component_order,
    sku: component.sku,
    name: component.name,
    unit: component.unit,
    regularUnitPrice: money(component.selling_price_centavos),
  }));
  return {
    id: row.id,
    versionId: row.version_id,
    version: row.current_version,
    code: row.code,
    name: row.name_snapshot,
    active: row.is_active === 1,
    activeFrom: row.active_from,
    activeUntil: row.active_until,
    maxQuantityPerSale: row.max_quantity_per_sale,
    reductionType: row.reduction_type,
    reductionValue: row.reduction_value,
    suggestedPromotionalPrice: money(row.suggested_price_centavos),
    promotionalPrice: money(row.promotional_price_centavos),
    priceRuleVersion: row.price_rule_version,
    discountInteractionRule: row.discount_interaction_rule,
    components: pricing,
  };
}

function currentBundleRows(
  db: Database.Database,
  activeOnly: boolean,
): BundleRow[] {
  return db
    .prepare(
      `SELECT b.id, b.code, b.is_active, b.current_version, v.id AS version_id,
            v.name_snapshot, v.active_from, v.active_until,
            v.max_quantity_per_sale, v.reduction_type, v.reduction_value,
            v.suggested_price_centavos, v.promotional_price_centavos,
            v.price_rule_version, v.discount_interaction_rule
     FROM sales_bundles b JOIN sales_bundle_versions v
       ON v.bundle_id = b.id AND v.version = b.current_version
     ${activeOnly ? "WHERE b.is_active = 1" : ""}
     ORDER BY b.code COLLATE NOCASE`,
    )
    .all() as BundleRow[];
}

function activeOffer(db: Database.Database, row: BundleRow) {
  const today = manilaCalendarDate();
  if (row.active_from > today || (row.active_until && row.active_until < today))
    return null;
  const components = db
    .prepare(
      `SELECT p.id, p.sku, p.name, p.unit, p.selling_price_centavos,
            p.tax_class, p.sc_eligible, p.pwd_eligible, p.bnpc_eligible,
            p.bnpc_category, p.tracks_lots,
            p.quantity_on_hand, p.is_active, c.quantity, c.component_order
     FROM sales_bundle_version_components c JOIN products p ON p.id = c.product_id
     WHERE c.bundle_version_id = ? ORDER BY c.component_order`,
    )
    .all(row.version_id) as Array<{
    id: string;
    sku: string;
    name: string;
    unit: string;
    selling_price_centavos: number;
    tax_class: string;
    sc_eligible: number;
    pwd_eligible: number;
    bnpc_eligible: number;
    bnpc_category: "BASIC_NECESSITY" | "PRIME_COMMODITY" | null;
    tracks_lots: number;
    quantity_on_hand: number;
    is_active: number;
    quantity: number;
    component_order: number;
  }>;
  if (components.some((component) => component.is_active !== 1)) return null;
  let availableQuantity = Number.MAX_SAFE_INTEGER;
  const safeComponents = components.map((component) => {
    const assignedLots =
      component.tracks_lots === 1
        ? getLotBalances(db, component.id)
            .filter((lot) => lot.saleableQuantity > 0)
            .map((lot) => ({
              lotId: lot.id,
              lotCode: lot.lotCode,
              expiryDate: lot.expiryDate,
              quantityAvailable: lot.saleableQuantity,
            }))
        : [];
    const quantityAvailable =
      component.tracks_lots === 1
        ? getLotBalances(db, component.id, today).reduce(
            (sum, lot) => sum + lot.saleableQuantity,
            0,
          )
        : component.quantity_on_hand;
    availableQuantity = Math.min(
      availableQuantity,
      Math.floor(quantityAvailable / component.quantity),
    );
    return {
      productId: component.id,
      sku: component.sku,
      name: component.name,
      unit: component.unit,
      quantity: component.quantity,
      order: component.component_order,
      sellingPrice: money(component.selling_price_centavos),
      taxClass: component.tax_class,
      isScEligible: component.sc_eligible === 1,
      isPwdEligible: component.pwd_eligible === 1,
      isBnpcEligible: component.bnpc_eligible === 1,
      bnpcCategory: component.bnpc_category,
      tracksLots: component.tracks_lots === 1,
      quantityAvailable,
      assignedLots,
    };
  });
  const regularTotal = components.reduce(
    (sum, component) =>
      sum +
      BigInt(component.selling_price_centavos) * BigInt(component.quantity),
    0n,
  );
  const promotionalPrice = row.promotional_price_centavos;
  const regularTotalCentavos = Number(regularTotal);
  if (
    !Number.isSafeInteger(regularTotalCentavos) ||
    promotionalPrice >= regularTotalCentavos
  )
    return null;
  const todayActive =
    row.active_from <= today &&
    (!row.active_until || row.active_until >= today);
  if (!todayActive) return null;
  return {
    id: row.id,
    versionId: row.version_id,
    version: row.current_version,
    code: row.code,
    name: row.name_snapshot,
    activeFrom: row.active_from,
    activeUntil: row.active_until,
    maxQuantityPerSale: row.max_quantity_per_sale,
    promotionalPrice: money(promotionalPrice),
    regularTotal: money(regularTotalCentavos),
    suggestedPromotionalPrice: money(row.suggested_price_centavos),
    priceRuleVersion: row.price_rule_version,
    discountInteractionRule: row.discount_interaction_rule,
    quantityAvailable: availableQuantity,
    components: safeComponents,
  };
}

function parseId(req: Request, res: Response): string | null {
  const parsed = z.uuid().safeParse(req.params.id);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request" });
    return null;
  }
  return parsed.data;
}

export function registerBundleRoutes(
  router: express.Router,
  db: Database.Database,
): void {
  const requireAuth = requireAuthentication(db);
  const requireOwner = requireRole("owner");
  const csrf = (req: Request, res: Response, next: () => void) =>
    requireCsrf(db, req, res, next);

  router.get("/bundles/active", requireAuth, (_req, res) => {
    res.json({
      bundles: currentBundleRows(db, true)
        .map((row) => activeOffer(db, row))
        .filter((row) => row !== null),
    });
  });
  router.get("/bundles/manage", requireAuth, requireOwner, (_req, res) => {
    res.json({
      bundles: currentBundleRows(db, false).map((row) =>
        presentStoredVersion(db, row),
      ),
    });
  });

  const saveVersion = (
    bundleId: string | null,
    req: Request,
    res: Response,
  ) => {
    const parsed = editSchema.safeParse(req.body);
    if (!parsed.success || !req.user) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    if (
      (parsed.data.reductionType === "PERCENT" &&
        parsed.data.reductionValue > 9_999) ||
      (parsed.data.reductionType === "AMOUNT" &&
        parsed.data.reductionValue > 100_000_000)
    ) {
      res.status(400).json({ error: "invalid_reduction_value" });
      return;
    }
    try {
      const pricing = calculatedPricing(
        db,
        parsed.data.components,
        parsed.data.reductionType,
        parsed.data.reductionValue,
      );
      const promotionalPrice = parseMoney(parsed.data.promotionalPrice);
      if (promotionalPrice >= pricing.regularTotalCentavos) {
        res
          .status(400)
          .json({ error: "promotional_price_must_be_below_regular_total" });
        return;
      }
      const now = new Date().toISOString();
      const versionId = randomUUID();
      const id = bundleId ?? randomUUID();
      const current = bundleId
        ? (db
            .prepare(
              "SELECT current_version, is_active FROM sales_bundles WHERE id = ?",
            )
            .get(bundleId) as
            | { current_version: number; is_active: number }
            | undefined)
        : undefined;
      if (bundleId && !current) {
        res.status(404).json({ error: "bundle_not_found" });
        return;
      }
      const version = (current?.current_version ?? 0) + 1;
      db.transaction(() => {
        if (!bundleId) {
          db.prepare(
            `INSERT INTO sales_bundles (id, code, is_active, current_version, created_by_user_id, created_at, updated_by_user_id, updated_at)
            VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
          ).run(
            id,
            parsed.data.code,
            version,
            req.user!.id,
            now,
            req.user!.id,
            now,
          );
        } else {
          db.prepare(
            "UPDATE sales_bundles SET code = ?, current_version = ?, updated_by_user_id = ?, updated_at = ? WHERE id = ?",
          ).run(parsed.data.code, version, req.user!.id, now, id);
        }
        db.prepare(
          `INSERT INTO sales_bundle_versions
          (id, bundle_id, version, code_snapshot, name_snapshot, active_from, active_until,
           max_quantity_per_sale, reduction_type, reduction_value, suggested_price_centavos,
           promotional_price_centavos, price_rule_version, discount_interaction_rule,
           approved_by_user_id, approved_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OWNER_APPROVED_FIXED_CENTAVOS_V1',
                  'MORE_FAVORABLE_NO_STACK_V1', ?, ?, ?)`,
        ).run(
          versionId,
          id,
          version,
          parsed.data.code,
          parsed.data.name,
          parsed.data.activeFrom,
          parsed.data.activeUntil,
          parsed.data.maxQuantityPerSale,
          parsed.data.reductionType,
          parsed.data.reductionValue,
          pricing.suggestedPriceCentavos,
          promotionalPrice,
          req.user!.id,
          now,
          now,
        );
        const insertComponent =
          db.prepare(`INSERT INTO sales_bundle_version_components
          (bundle_version_id, product_id, quantity, component_order) VALUES (?, ?, ?, ?)`);
        parsed.data.components.forEach((component, index) =>
          insertComponent.run(
            versionId,
            component.productId,
            component.quantity,
            index + 1,
          ),
        );
        writeAuditEvent(db, {
          actorUserId: req.user!.id,
          action: bundleId
            ? "sales_bundle.version_created"
            : "sales_bundle.created",
          entityType: "sales_bundle",
          entityId: id,
          details: {
            code: parsed.data.code,
            version,
            componentCount: parsed.data.components.length,
            regularTotalCentavos: pricing.regularTotalCentavos,
            suggestedPriceCentavos: pricing.suggestedPriceCentavos,
            approvedPromotionalPriceCentavos: promotionalPrice,
            reductionType: parsed.data.reductionType,
            reductionValue: parsed.data.reductionValue,
            activeFrom: parsed.data.activeFrom,
            activeUntil: parsed.data.activeUntil,
            maxQuantityPerSale: parsed.data.maxQuantityPerSale,
            components: parsed.data.components.map((component, index) => ({
              productId: component.productId,
              quantity: component.quantity,
              order: index + 1,
            })),
          },
        });
      })();
      const row = currentBundleRows(db, false).find((entry) => entry.id === id);
      res.status(bundleId ? 200 : 201).json({
        bundle: row ? presentStoredVersion(db, row) : null,
        pricing: {
          regularTotal: money(pricing.regularTotalCentavos),
          suggestedPromotionalPrice: money(pricing.suggestedPriceCentavos),
          approvedPromotionalPrice: money(promotionalPrice),
        },
      });
    } catch (error) {
      if (error instanceof BundleError) {
        res.status(error.status).json({ error: error.code });
        return;
      }
      if (
        error instanceof Error &&
        error.message.includes("sales_bundles.code")
      ) {
        res.status(409).json({ error: "bundle_code_already_exists" });
        return;
      }
      throw error;
    }
  };

  router.post("/bundles", requireAuth, requireOwner, csrf, (req, res) =>
    saveVersion(null, req, res),
  );
  router.patch("/bundles/:id", requireAuth, requireOwner, csrf, (req, res) => {
    const id = parseId(req, res);
    if (id) saveVersion(id, req, res);
  });
  router.post(
    "/bundles/:id/active",
    requireAuth,
    requireOwner,
    csrf,
    (req, res) => {
      const id = parseId(req, res);
      const parsed = activeSchema.safeParse(req.body);
      if (!id || !parsed.success || !req.user) {
        if (id) res.status(400).json({ error: "invalid_request" });
        return;
      }
      const bundle = db
        .prepare("SELECT id, code, is_active FROM sales_bundles WHERE id = ?")
        .get(id) as { id: string; code: string; is_active: number } | undefined;
      if (!bundle) return res.status(404).json({ error: "bundle_not_found" });
      const now = new Date().toISOString();
      db.prepare(
        "UPDATE sales_bundles SET is_active = ?, updated_by_user_id = ?, updated_at = ? WHERE id = ?",
      ).run(parsed.data.active ? 1 : 0, req.user.id, now, id);
      writeAuditEvent(db, {
        actorUserId: req.user.id,
        action: parsed.data.active
          ? "sales_bundle.activated"
          : "sales_bundle.deactivated",
        entityType: "sales_bundle",
        entityId: id,
        details: { code: bundle.code },
      });
      res.json({ ok: true, active: parsed.data.active });
    },
  );
}
