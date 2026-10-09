import type { NextFunction, Request, Response } from "express";
import type Database from "better-sqlite3";
import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuthentication, requireCsrf, requireRole } from "./auth.js";
import { writeAuditEvent } from "./db.js";

export const CHECKOUT_INVENTORY_POLICY_VERSION = 1;

export type CheckoutInventoryPolicy = {
  allowStockCountOverride: boolean;
  policyVersion: number;
  valid: boolean;
};

const checkoutInventorySettingSchema = z
  .object({
    allowStockCountOverride: z.boolean(),
    policyVersion: z.number().int().positive(),
  })
  .strict();

export function checkoutInventoryPolicy(
  db: Database.Database,
): CheckoutInventoryPolicy {
  const row = db
    .prepare("SELECT value_json FROM settings WHERE key = 'checkout_inventory'")
    .get() as { value_json: string } | undefined;
  if (!row) {
    return {
      allowStockCountOverride: false,
      policyVersion: CHECKOUT_INVENTORY_POLICY_VERSION,
      valid: false,
    };
  }
  try {
    const parsed = checkoutInventorySettingSchema.safeParse(
      JSON.parse(row.value_json),
    );
    if (!parsed.success) throw new Error("invalid_checkout_inventory_setting");
    return { ...parsed.data, valid: true };
  } catch {
    return {
      allowStockCountOverride: false,
      policyVersion: CHECKOUT_INVENTORY_POLICY_VERSION,
      valid: false,
    };
  }
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export function registerCheckoutInventoryRoutes(
  router: express.Router,
  db: Database.Database,
): void {
  const requireAuth = requireAuthentication(db);
  const requireOwner = requireRole("owner");
  const csrf = (req: Request, res: Response, next: NextFunction) =>
    requireCsrf(db, req, res, next);

  router.get("/settings/checkout-inventory", requireAuth, (_req, res) => {
    const policy = checkoutInventoryPolicy(db);
    res.json({
      allowStockCountOverride: policy.allowStockCountOverride,
      policyVersion: policy.policyVersion,
    });
  });

  router.put(
    "/settings/checkout-inventory",
    requireAuth,
    requireOwner,
    csrf,
    (req, res) => {
      const parsed = z
        .object({ allowStockCountOverride: z.boolean() })
        .strict()
        .safeParse(req.body);
      if (!parsed.success || !req.user) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      const previous = checkoutInventoryPolicy(db);
      const nextVersion =
        previous.allowStockCountOverride === parsed.data.allowStockCountOverride
          ? previous.policyVersion
          : previous.policyVersion + 1;
      const value = {
        allowStockCountOverride: parsed.data.allowStockCountOverride,
        policyVersion: nextVersion,
      };
      const now = new Date().toISOString();
      db.transaction(() => {
        db.prepare(
          `INSERT INTO settings (key, value_json, updated_at, updated_by)
           VALUES ('checkout_inventory', ?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
             updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        ).run(JSON.stringify(value), now, req.user!.id);
        writeAuditEvent(db, {
          actorUserId: req.user!.id,
          action: "checkout.inventory_override_setting_updated",
          entityType: "setting",
          entityId: "checkout_inventory",
          details: {
            oldValue: previous.allowStockCountOverride,
            newValue: value.allowStockCountOverride,
            policyVersion: nextVersion,
            updatedAt: now,
          },
        });
      })();
      res.json(value);
    },
  );

  router.get(
    "/checkout-stock-overrides.csv",
    requireAuth,
    requireOwner,
    (req, res) => {
      const filters = historyFilters(req.query);
      if (!filters) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      const records = queryOverrideHistory(db, filters);
      const header = [
        "Transaction",
        "Business date",
        "Recorded at",
        "Cashier",
        "SKU",
        "Product",
        "Unit",
        "Recorded count",
        "Physical count",
        "Correction",
        "Sold quantity",
        "Reason category",
        "Reason",
        "Cost source",
        "Estimated cost",
        "Unit cost centavos",
        "Value added centavos",
        "Review status",
        "Reviewer",
        "Reviewed at",
        "Review note",
        "Lots",
      ];
      const rows = records.map((record) => [
        record.transactionId,
        record.businessDate,
        record.createdAt,
        record.cashierEmail,
        record.sku,
        record.productName,
        record.unit,
        record.recordedQuantity,
        record.physicalQuantity,
        record.correctionQuantity,
        record.saleQuantity,
        record.reasonCategory,
        record.reason,
        record.costSourceType,
        record.estimatedCost,
        record.unitCostCentavos,
        record.inventoryValueDeltaCentavos,
        record.reviewStatus,
        record.reviewerEmail,
        record.reviewedAt,
        record.reviewNote,
        record.lots
          .map(
            (lot) =>
              `${lot.lotCode} (${lot.expiryDate}): ${lot.recordedQuantity} -> ${lot.physicalQuantity}; correction +${lot.correctionQuantity}; sold ${lot.saleQuantity}`,
          )
          .join(" | "),
      ]);
      res.type("text/csv; charset=utf-8");
      res.setHeader(
        "content-disposition",
        'attachment; filename="checkout-stock-overrides.csv"',
      );
      res.send(
        [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n"),
      );
    },
  );

  router.get(
    "/checkout-stock-overrides",
    requireAuth,
    requireOwner,
    (req, res) => {
      const filters = historyFilters(req.query);
      if (!filters) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      res.json({ records: queryOverrideHistory(db, filters) });
    },
  );

  router.post(
    "/checkout-stock-overrides/:id/review",
    requireAuth,
    requireOwner,
    csrf,
    (req, res) => {
      const id = z.uuid().safeParse(req.params.id);
      const parsed = z
        .object({
          status: z.enum(["REVIEWED", "UNREVIEWED"]),
          note: z.string().trim().max(500).optional(),
        })
        .strict()
        .safeParse(req.body);
      if (!id.success || !parsed.success || !req.user) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      const exists = db
        .prepare("SELECT id FROM checkout_stock_override_records WHERE id = ?")
        .get(id.data);
      if (!exists) {
        res.status(404).json({ error: "checkout_override_not_found" });
        return;
      }
      const now = new Date().toISOString();
      db.transaction(() => {
        db.prepare(
          `INSERT INTO checkout_stock_override_reviews
           (id, override_record_id, reviewer_user_id, status, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          id.data,
          req.user!.id,
          parsed.data.status,
          parsed.data.note?.trim() || null,
          now,
        );
        writeAuditEvent(db, {
          actorUserId: req.user!.id,
          action: "checkout.inventory_override_reviewed",
          entityType: "checkout_stock_override",
          entityId: id.data,
          details: {
            status: parsed.data.status,
            note: parsed.data.note?.trim() || null,
          },
        });
      })();
      res.json({ reviewedAt: now, status: parsed.data.status });
    },
  );
}

type HistoryFilters = {
  from: string | null;
  to: string | null;
  productId: string | null;
  cashierUserId: string | null;
};

function historyFilters(query: Request["query"]): HistoryFilters | null {
  const parsed = z
    .object({
      from: z.iso.date().optional(),
      to: z.iso.date().optional(),
      productId: z.uuid().optional(),
      cashierUserId: z.uuid().optional(),
    })
    .strict()
    .safeParse(query);
  if (
    !parsed.success ||
    (parsed.data.from && parsed.data.to && parsed.data.from > parsed.data.to)
  ) {
    return null;
  }
  return {
    from: parsed.data.from ?? null,
    to: parsed.data.to ?? null,
    productId: parsed.data.productId ?? null,
    cashierUserId: parsed.data.cashierUserId ?? null,
  };
}

function queryOverrideHistory(db: Database.Database, filters: HistoryFilters) {
  const conditions = ["1 = 1"];
  const values: Array<string | number> = [];
  if (filters.from) {
    conditions.push("s.business_date >= ?");
    values.push(filters.from);
  }
  if (filters.to) {
    conditions.push("s.business_date <= ?");
    values.push(filters.to);
  }
  if (filters.productId) {
    conditions.push("o.product_id = ?");
    values.push(filters.productId);
  }
  if (filters.cashierUserId) {
    conditions.push("o.cashier_user_id = ?");
    values.push(filters.cashierUserId);
  }
  const rows = db
    .prepare(
      `SELECT o.id, o.sale_id, s.transaction_id, s.business_date,
              o.created_at, o.cashier_user_id, cashier.email AS cashier_email,
              p.id AS product_id, p.sku, p.name AS product_name, p.unit,
              o.recorded_quantity, o.physical_quantity, o.correction_quantity,
              o.sale_quantity, o.reason_category, o.reason,
              o.cost_source_type, o.cost_source_event_id,
              o.cost_source_sequence, o.estimated_cost,
              o.unit_cost_centavos, o.inventory_value_delta_centavos,
              o.stock_event_id, o.stock_state_hash, o.policy_version,
              review.status AS review_status, review.created_at AS reviewed_at,
              reviewer.email AS reviewer_email, review.note AS review_note
       FROM checkout_stock_override_records o
       JOIN sales s ON s.id = o.sale_id
       JOIN users cashier ON cashier.id = o.cashier_user_id
       JOIN products p ON p.id = o.product_id
       LEFT JOIN checkout_stock_override_reviews review ON review.sequence = (
         SELECT max(latest.sequence) FROM checkout_stock_override_reviews latest
         WHERE latest.override_record_id = o.id
       )
       LEFT JOIN users reviewer ON reviewer.id = review.reviewer_user_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY s.business_date DESC, o.created_at DESC, p.name COLLATE NOCASE`,
    )
    .all(...values) as Array<Record<string, unknown>>;
  const lotRows = db.prepare(
    `SELECT l.lot_code_snapshot AS lot_code, l.expiry_date_snapshot AS expiry_date,
            l.recorded_quantity, l.physical_quantity, l.correction_quantity,
            l.sale_quantity
     FROM checkout_stock_override_lots l WHERE l.override_record_id = ?
     ORDER BY l.expiry_date_snapshot, l.lot_code_snapshot COLLATE NOCASE`,
  );
  return rows
    .map((row) => ({
      id: row.id as string,
      saleId: row.sale_id as string,
      transactionId: row.transaction_id as string,
      businessDate: row.business_date as string,
      createdAt: row.created_at as string,
      cashierUserId: row.cashier_user_id as string,
      cashierEmail: row.cashier_email as string,
      productId: row.product_id as string,
      sku: row.sku as string,
      productName: row.product_name as string,
      unit: row.unit as string,
      recordedQuantity: row.recorded_quantity as number,
      physicalQuantity: row.physical_quantity as number,
      correctionQuantity: row.correction_quantity as number,
      saleQuantity: row.sale_quantity as number,
      reasonCategory: row.reason_category as string,
      reason: row.reason as string,
      costSourceType: row.cost_source_type as string,
      costSourceEventId: row.cost_source_event_id as string | null,
      costSourceSequence: row.cost_source_sequence as number | null,
      estimatedCost: (row.estimated_cost as number) === 1,
      unitCostCentavos: row.unit_cost_centavos as number,
      inventoryValueDeltaCentavos: row.inventory_value_delta_centavos as number,
      stockEventId: row.stock_event_id as string,
      stockStateHash: row.stock_state_hash as string,
      policyVersion: row.policy_version as number,
      reviewStatus: (row.review_status as string | null) ?? "UNREVIEWED",
      reviewerEmail: (row.reviewer_email as string | null) ?? null,
      reviewedAt: (row.reviewed_at as string | null) ?? null,
      reviewNote: (row.review_note as string | null) ?? null,
      lots: lotRows.all(row.id) as Array<{
        lot_code: string;
        expiry_date: string;
        recorded_quantity: number;
        physical_quantity: number;
        correction_quantity: number;
        sale_quantity: number;
      }>,
    }))
    .map((record) => ({
      ...record,
      lots: record.lots.map((lot) => ({
        lotCode: lot.lot_code,
        expiryDate: lot.expiry_date,
        recordedQuantity: lot.recorded_quantity,
        physicalQuantity: lot.physical_quantity,
        correctionQuantity: lot.correction_quantity,
        saleQuantity: lot.sale_quantity,
      })),
    }));
}
