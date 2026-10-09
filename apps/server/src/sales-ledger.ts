import type Database from "better-sqlite3";
import type { Router } from "express";
import { z } from "zod";
import { requireAuthentication, requireRole } from "./auth.js";
import { writeAuditEvent } from "./db.js";

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const moneySchema = z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/);
const ledgerEntrySchema = z
  .object({
    month: monthSchema,
    invoiceNumber: z.string().trim().min(1).max(80),
    seniorDiscount: moneySchema,
    nonVat: moneySchema,
    vatableSales: moneySchema,
    totalVat: moneySchema,
    grossSales: moneySchema,
    netSales: moneySchema,
  })
  .strict();

type LedgerRow = {
  source_sale_id: string;
  business_month: string;
  invoice_number: string;
  senior_discount_centavos: number;
  non_vat_centavos: number;
  vatable_sales_centavos: number;
  total_vat_centavos: number;
  gross_sales_centavos: number;
  net_sales_centavos: number;
  edited_at: string | null;
};

function money(centavos: number): string {
  return (centavos / 100).toFixed(2);
}

function parseMoney(value: string): number {
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

function nextMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonthNumber = monthNumber === 12 ? 1 : monthNumber + 1;
  return `${nextYear}-${String(nextMonthNumber).padStart(2, "0")}`;
}

function present(row: LedgerRow) {
  return {
    sourceSaleId: row.source_sale_id,
    month: row.business_month,
    invoiceNumber: row.invoice_number,
    seniorDiscount: money(row.senior_discount_centavos),
    nonVat: money(row.non_vat_centavos),
    vatableSales: money(row.vatable_sales_centavos),
    totalVat: money(row.total_vat_centavos),
    grossSales: money(row.gross_sales_centavos),
    netSales: money(row.net_sales_centavos),
    editedAt: row.edited_at,
  };
}

export function registerSalesLedgerRoutes(
  router: Router,
  db: Database.Database,
): void {
  const requireAuth = requireAuthentication(db);
  const requireOwner = requireRole("owner");

  router.get("/ledger/range", requireAuth, requireOwner, (req, res): void => {
    const start = monthSchema.safeParse(req.query.startMonth);
    const end = monthSchema.safeParse(req.query.endMonth);
    if (!start.success || !end.success || start.data > end.data) {
      res.status(400).json({ error: "invalid_ledger_range" });
      return;
    }
    const startYear = Number(start.data.slice(0, 4));
    const startMonth = Number(start.data.slice(5, 7));
    const endYear = Number(end.data.slice(0, 4));
    const endMonth = Number(end.data.slice(5, 7));
    if ((endYear - startYear) * 12 + endMonth - startMonth > 11) {
      res.status(400).json({ error: "ledger_range_too_large" });
      return;
    }

    const insertCopies = db.prepare(
      `INSERT OR IGNORE INTO daily_sales_ledger
           (source_sale_id, source_business_date, business_month,
            invoice_number, senior_discount_centavos, non_vat_centavos,
            vatable_sales_centavos, total_vat_centavos,
            gross_sales_centavos, net_sales_centavos)
         SELECT s.id, s.business_date, substr(s.business_date, 1, 7),
                s.transaction_id, s.senior_discount_centavos,
                COALESCE(SUM(CASE WHEN sl.tax_class_snapshot <> 'VATABLE'
                                  THEN sl.amount_due_centavos ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN sl.tax_class_snapshot = 'VATABLE'
                                  THEN sl.tax_basis_centavos ELSE 0 END), 0),
                s.vat_centavos,
                COALESCE(SUM(sl.quantity * sl.unit_price_centavos), 0),
                COALESCE(SUM(sl.amount_due_centavos - sl.vat_centavos), 0)
         FROM sales s JOIN sale_lines sl ON sl.sale_id = s.id
         WHERE s.business_date >= ? AND s.business_date < ?
         GROUP BY s.id`,
    );
    db.transaction(() => {
      insertCopies.run(`${start.data}-01`, `${nextMonth(end.data)}-01`);
    })();

    const rows = db
      .prepare(
        `SELECT source_sale_id, business_month, invoice_number,
                  senior_discount_centavos, non_vat_centavos,
                  vatable_sales_centavos, total_vat_centavos,
                  gross_sales_centavos, net_sales_centavos, edited_at
           FROM daily_sales_ledger
           WHERE business_month >= ? AND business_month <= ?
           ORDER BY business_month, invoice_number, source_sale_id`,
      )
      .all(start.data, end.data) as LedgerRow[];
    res.json({ entries: rows.map(present) });
  });

  router.patch(
    "/ledger/:sourceSaleId",
    requireAuth,
    requireOwner,
    (req, res): void => {
      const sourceSaleId = z.uuid().safeParse(req.params.sourceSaleId);
      const parsed = ledgerEntrySchema.safeParse(req.body);
      if (!sourceSaleId.success || !parsed.success) {
        res.status(400).json({ error: "invalid_ledger_entry" });
        return;
      }
      const value = parsed.data;
      const now = new Date().toISOString();
      const update = db.transaction(() => {
        const result = db
          .prepare(
            `UPDATE daily_sales_ledger
             SET business_month = ?, invoice_number = ?,
                 senior_discount_centavos = ?, non_vat_centavos = ?,
                 vatable_sales_centavos = ?, total_vat_centavos = ?,
                 gross_sales_centavos = ?, net_sales_centavos = ?,
                 edited_at = ?, edited_by_user_id = ?
             WHERE source_sale_id = ?`,
          )
          .run(
            value.month,
            value.invoiceNumber,
            parseMoney(value.seniorDiscount),
            parseMoney(value.nonVat),
            parseMoney(value.vatableSales),
            parseMoney(value.totalVat),
            parseMoney(value.grossSales),
            parseMoney(value.netSales),
            now,
            req.user!.id,
            sourceSaleId.data,
          );
        if (result.changes !== 1) return false;
        writeAuditEvent(db, {
          actorUserId: req.user!.id,
          action: "ledger.entry_edited",
          entityType: "sales_ledger_entry",
          entityId: sourceSaleId.data,
          details: {
            fields: Object.keys(value),
            month: value.month,
            invoiceNumber: value.invoiceNumber,
          },
        });
        return true;
      });
      if (!update()) {
        res.status(404).json({ error: "ledger_entry_not_found" });
        return;
      }

      const row = db
        .prepare(
          `SELECT source_sale_id, business_month, invoice_number,
                  senior_discount_centavos, non_vat_centavos,
                  vatable_sales_centavos, total_vat_centavos,
                  gross_sales_centavos, net_sales_centavos, edited_at
           FROM daily_sales_ledger WHERE source_sale_id = ?`,
        )
        .get(sourceSaleId.data) as LedgerRow;
      res.json({ entry: present(row) });
    },
  );
}
