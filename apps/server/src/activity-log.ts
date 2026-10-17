import type Database from "better-sqlite3";
import type { Express } from "express";
import { z } from "zod";
import {
  activityActionLabel,
  activityCategories,
  activityCategoryFor,
  type ActivityEvent,
  type ActivityFilterOptions,
  type ActivityLogResponse,
} from "@medtryx/shared";
import { requireAuthentication, requireRole } from "./auth.js";
import { validCalendarDate } from "./lot-stock.js";

const dateSchema = z.string().refine(validCalendarDate);
const actionSchema = z.string().trim().min(1).max(160);
const querySchema = z.object({
  q: z.string().trim().max(160).optional(),
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  category: z
    .enum(activityCategories.map((category) => category.value))
    .optional(),
  action: z
    .union([actionSchema, z.array(actionSchema).min(1).max(200)])
    .transform((value) => [...new Set(Array.isArray(value) ? value : [value])])
    .optional(),
  actorId: z.string().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  // Preserve the existing Settings page's /audit?limit=12 request.
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const categorySql = `CASE ${activityCategories
  .filter((category) => category.prefixes.length)
  .map(
    (category) =>
      `WHEN ${category.prefixes
        .map(
          (prefix) =>
            `substr(a.action, 1, ${prefix.length}) = ${quote(prefix)}`,
        )
        .join(" OR ")} THEN ${quote(category.value)}`,
  )
  .join(" ")} ELSE 'other' END`;

const joins = `FROM audit_events a
  LEFT JOIN users u ON u.id = a.actor_user_id
  LEFT JOIN products p ON a.entity_type = 'product' AND p.id = a.entity_id
  LEFT JOIN sales s ON a.entity_type = 'sale' AND s.id = a.entity_id
  LEFT JOIN sale_reversals r ON a.entity_type = 'sale_reversal' AND r.id = a.entity_id
  LEFT JOIN sales_bundles b ON a.entity_type = 'sales_bundle' AND b.id = a.entity_id
  LEFT JOIN expenses e ON a.entity_type = 'expense' AND e.id = a.entity_id
  LEFT JOIN users target ON a.entity_type = 'user' AND target.id = a.entity_id
  LEFT JOIN inventory_lots lot ON a.entity_type = 'inventory_lot' AND lot.id = a.entity_id
  LEFT JOIN products lp ON lp.id = lot.product_id`;

function safeDetails(value: unknown, depth = 0): unknown {
  if (depth > 12) return "Additional nested details omitted";
  if (Array.isArray(value))
    return value.map((item) => safeDetails(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/password|token|secret|ciphertext|encryption|digest|holderkey|customeridnumber/iu.test(
              key,
            ),
        )
        .map(([key, item]) => [key, safeDetails(item, depth + 1)]),
    );
  }
  return value;
}

function parseDetails(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    if (value && typeof value === "object" && !Array.isArray(value))
      return safeDetails(value) as Record<string, unknown>;
  } catch {
    /* Keep older malformed entries visible in the log. */
  }
  return {};
}

function subjectFor(row: EventRow, details: Record<string, unknown>): string {
  if (row.productName) return `${row.productName} · ${row.productSku}`;
  if (row.lotCode)
    return `${row.lotProductName ?? "Stock lot"} · ${row.lotCode}`;
  for (const value of [
    row.transactionId,
    details.originalTransactionId,
    details.transactionId,
    row.reversalTransactionId,
    row.bundleCode,
    details.code,
    row.targetEmail,
    details.name,
    details.sku,
    row.expenseDescription,
    details.description,
    details.reference,
  ]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  const labels: Record<string, string> = {
    shift: "Cash register",
    cash_movement: "Cash register movement",
    backup: "Store backup",
    report: "Store report",
    store: "Store profile",
    checkout_stock_override: "Checkout stock override",
    lot_reconciliation: "Stock lot allocation",
    stock_receipt: "Stock receipt",
    sales_journal_entry: "Sales journal",
    bnpc_policy_version: "BNPC policy",
    settings: "Store settings",
    setting: "Store settings",
  };
  return labels[row.entityType] ?? row.entityType.replaceAll("_", " ");
}

type EventRow = Omit<
  ActivityEvent,
  "details" | "subject" | "actionLabel" | "category"
> & {
  detailsJson: string;
  productName: string | null;
  productSku: string | null;
  transactionId: string | null;
  reversalTransactionId: string | null;
  bundleCode: string | null;
  targetEmail: string | null;
  expenseDescription: string | null;
  lotCode: string | null;
  lotProductName: string | null;
};

export function registerActivityLogRoutes(
  app: Express,
  db: Database.Database,
): void {
  const requireAuth = requireAuthentication(db);
  const requireOwner = requireRole("owner");

  app.get("/api/audit/options", requireAuth, requireOwner, (_req, res) => {
    const actions = (
      db
        .prepare("SELECT DISTINCT action FROM audit_events ORDER BY action")
        .all() as Array<{ action: string }>
    )
      .map(({ action }) => ({
        value: action,
        label: activityActionLabel(action),
        category: activityCategoryFor(action),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const actors = db
      .prepare(
        `SELECT DISTINCT u.id, u.email, u.username, u.role, u.is_active
      FROM audit_events a JOIN users u ON u.id = a.actor_user_id
      ORDER BY coalesce(u.username, u.email) COLLATE NOCASE`,
      )
      .all() as Array<{
      id: string;
      email: string;
      username: string | null;
      role: "owner" | "cashier";
      is_active: number;
    }>;
    const system = db
      .prepare(
        "SELECT EXISTS(SELECT 1 FROM audit_events WHERE actor_user_id IS NULL) AS found",
      )
      .get() as { found: number };
    const result: ActivityFilterOptions = {
      actions,
      actors: actors.map(({ is_active, ...actor }) => ({
        ...actor,
        active: is_active === 1,
      })),
      hasSystemEvents: system.found === 1,
    };
    res.json(result);
  });

  app.get("/api/audit", requireAuth, requireOwner, (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success)
      return res.status(400).json({ error: "invalid_request" });
    const input = parsed.data;
    if (input.startDate && input.endDate && input.startDate > input.endDate)
      return res.status(400).json({ error: "invalid_date_range" });
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (input.startDate) {
      conditions.push("a.created_at >= ?");
      values.push(new Date(`${input.startDate}T00:00:00+08:00`).toISOString());
    }
    if (input.endDate) {
      const exclusiveEnd = new Date(`${input.endDate}T00:00:00+08:00`);
      exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
      conditions.push("a.created_at < ?");
      values.push(exclusiveEnd.toISOString());
    }
    if (input.category) {
      conditions.push(`(${categorySql}) = ?`);
      values.push(input.category);
    }
    if (input.action?.length) {
      conditions.push(
        `a.action IN (${input.action.map(() => "?").join(", ")})`,
      );
      values.push(...input.action);
    }
    if (input.actorId === "system") conditions.push("a.actor_user_id IS NULL");
    else if (input.actorId) {
      conditions.push("a.actor_user_id = ?");
      values.push(input.actorId);
    }
    if (input.q) {
      const fields = [
        "a.action",
        "a.entity_type",
        "a.entity_id",
        "a.details_json",
        "u.email",
        "u.username",
        "p.name",
        "p.sku",
        "s.transaction_id",
        "r.reversal_transaction_id",
        "b.code",
        "e.description",
        "target.email",
        "lot.lot_code",
        "lp.name",
        "lp.sku",
      ];
      const searchConditions = fields.map(
        (field) => `instr(lower(coalesce(${field}, '')), lower(?)) > 0`,
      );
      values.push(...fields.map(() => input.q!));
      const actions = (
        db.prepare("SELECT DISTINCT action FROM audit_events").all() as Array<{
          action: string;
        }>
      ).filter(({ action }) =>
        activityActionLabel(action)
          .toLowerCase()
          .includes(input.q!.toLowerCase()),
      );
      if (actions.length) {
        searchConditions.push(
          `a.action IN (${actions.map(() => "?").join(", ")})`,
        );
        values.push(...actions.map(({ action }) => action));
      }
      conditions.push(`(${searchConditions.join(" OR ")})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    // Keep the count and page consistent while other app instances record events.
    const result = db.transaction((): ActivityLogResponse => {
      const { total } = db
        .prepare(`SELECT count(*) AS total ${joins} ${where}`)
        .get(...values) as { total: number };
      const pageSize = input.pageSize ?? input.limit ?? 100;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(input.page, totalPages);
      const rows = db
        .prepare(
          `SELECT a.id, a.action, a.entity_type AS entityType,
        a.entity_id AS entityId, a.details_json AS detailsJson, a.created_at AS createdAt,
        a.actor_user_id AS actorId, u.email AS actorEmail, u.username AS actorUsername, u.role AS actorRole,
        p.name AS productName, p.sku AS productSku, s.transaction_id AS transactionId,
        r.reversal_transaction_id AS reversalTransactionId, b.code AS bundleCode,
        target.email AS targetEmail, e.description AS expenseDescription,
        lot.lot_code AS lotCode, lp.name AS lotProductName
        ${joins} ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
        )
        .all(...values, pageSize, (page - 1) * pageSize) as EventRow[];
      return {
        events: rows.map((row) => {
          const details = parseDetails(row.detailsJson);
          return {
            id: row.id,
            action: row.action,
            actionLabel: activityActionLabel(row.action),
            category: activityCategoryFor(row.action),
            entityType: row.entityType,
            entityId: row.entityId,
            subject: subjectFor(row, details),
            details,
            createdAt: row.createdAt,
            actorId: row.actorId,
            actorEmail: row.actorEmail,
            actorUsername: row.actorUsername,
            actorRole: row.actorRole,
          };
        }),
        pagination: { page, pageSize, total, totalPages },
      };
    })();
    res.json(result);
  });
}
