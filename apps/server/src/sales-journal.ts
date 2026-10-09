import type Database from "better-sqlite3";
import type { Router } from "express";
import { z } from "zod";
import { requireAuthentication, requireRole } from "./auth.js";
import { writeAuditEvent } from "./db.js";

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const moneySchema = z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/);
const journalEntrySchema = z
  .object({
    month: monthSchema,
    date: z.iso.date(),
    invoiceNumberRange: z.string().trim().min(1).max(200),
    seniorDiscount: moneySchema,
    nonVat: moneySchema,
    vatableSales: moneySchema,
    totalVat: moneySchema,
    grossSales: moneySchema,
    netSales: moneySchema,
  })
  .strict();

type JournalRow = {
  source_business_date: string;
  business_month: string;
  journal_date: string;
  invoice_number_range: string;
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

function present(row: JournalRow) {
  return {
    sourceBusinessDate: row.source_business_date,
    month: row.business_month,
    date: row.journal_date,
    invoiceNumberRange: row.invoice_number_range,
    seniorDiscount: money(row.senior_discount_centavos),
    nonVat: money(row.non_vat_centavos),
    vatableSales: money(row.vatable_sales_centavos),
    totalVat: money(row.total_vat_centavos),
    grossSales: money(row.gross_sales_centavos),
    netSales: money(row.net_sales_centavos),
    editedAt: row.edited_at,
  };
}

export function registerSalesJournalRoutes(
  router: Router,
  db: Database.Database,
): void {
  const requireAuth = requireAuthentication(db);
  const requireOwner = requireRole("owner");

  router.get("/journal/range", requireAuth, requireOwner, (req, res): void => {
    const start = monthSchema.safeParse(req.query.startMonth);
    const end = monthSchema.safeParse(req.query.endMonth);
    if (!start.success || !end.success || start.data > end.data) {
      res.status(400).json({ error: "invalid_journal_range" });
      return;
    }
    const startYear = Number(start.data.slice(0, 4));
    const startMonth = Number(start.data.slice(5, 7));
    const endYear = Number(end.data.slice(0, 4));
    const endMonth = Number(end.data.slice(5, 7));
    if ((endYear - startYear) * 12 + endMonth - startMonth > 11) {
      res.status(400).json({ error: "journal_range_too_large" });
      return;
    }

    const refreshCopies = db.prepare(
      `INSERT INTO daily_sales_journal
         (source_business_date, business_month, journal_date,
            invoice_number_range, senior_discount_centavos, non_vat_centavos,
            vatable_sales_centavos, total_vat_centavos,
            gross_sales_centavos, net_sales_centavos)
         SELECT sale_totals.business_date,
                substr(sale_totals.business_date, 1, 7),
                sale_totals.business_date,
                CASE WHEN sale_totals.first_invoice = sale_totals.last_invoice
                     THEN sale_totals.first_invoice
                     ELSE sale_totals.first_invoice || ' – ' || sale_totals.last_invoice
                END,
                sale_totals.senior_discount_centavos,
                line_totals.non_vat_centavos,
                line_totals.vatable_sales_centavos,
                sale_totals.total_vat_centavos,
                line_totals.gross_sales_centavos,
                line_totals.net_sales_centavos
         FROM (
           SELECT business_date, MIN(transaction_id) AS first_invoice,
                  MAX(transaction_id) AS last_invoice,
                  SUM(senior_discount_centavos) AS senior_discount_centavos,
                  SUM(vat_centavos) AS total_vat_centavos
           FROM sales
           WHERE business_date >= ? AND business_date < ?
           GROUP BY business_date
         ) AS sale_totals
         JOIN (
           SELECT s.business_date,
                  COALESCE(SUM(CASE WHEN sl.tax_class_snapshot <> 'VATABLE'
                                    THEN sl.amount_due_centavos ELSE 0 END), 0)
                    AS non_vat_centavos,
                  COALESCE(SUM(CASE WHEN sl.tax_class_snapshot = 'VATABLE'
                                    THEN sl.tax_basis_centavos ELSE 0 END), 0)
                    AS vatable_sales_centavos,
                  COALESCE(SUM(sl.quantity * sl.unit_price_centavos), 0)
                    AS gross_sales_centavos,
                  COALESCE(SUM(sl.amount_due_centavos - sl.vat_centavos), 0)
                    AS net_sales_centavos
           FROM sales s JOIN sale_lines sl ON sl.sale_id = s.id
           WHERE s.business_date >= ? AND s.business_date < ?
           GROUP BY s.business_date
         ) AS line_totals
           ON line_totals.business_date = sale_totals.business_date
         WHERE TRUE
         ON CONFLICT(source_business_date) DO UPDATE SET
           business_month = excluded.business_month,
           journal_date = excluded.journal_date,
           invoice_number_range = excluded.invoice_number_range,
           senior_discount_centavos = excluded.senior_discount_centavos,
           non_vat_centavos = excluded.non_vat_centavos,
           vatable_sales_centavos = excluded.vatable_sales_centavos,
           total_vat_centavos = excluded.total_vat_centavos,
           gross_sales_centavos = excluded.gross_sales_centavos,
           net_sales_centavos = excluded.net_sales_centavos
         WHERE daily_sales_journal.edited_at IS NULL`,
    );
    db.transaction(() => {
      refreshCopies.run(
        `${start.data}-01`,
        `${nextMonth(end.data)}-01`,
        `${start.data}-01`,
        `${nextMonth(end.data)}-01`,
      );
    })();

    const rows = db
      .prepare(
        `SELECT source_business_date, business_month, journal_date,
                invoice_number_range, senior_discount_centavos,
                non_vat_centavos, vatable_sales_centavos,
                total_vat_centavos, gross_sales_centavos,
                net_sales_centavos, edited_at
         FROM daily_sales_journal
         WHERE business_month >= ? AND business_month <= ?
         ORDER BY business_month, journal_date, source_business_date`,
      )
      .all(start.data, end.data) as JournalRow[];
    res.json({ entries: rows.map(present) });
  });

  router.patch(
    "/journal/:sourceBusinessDate",
    requireAuth,
    requireOwner,
    (req, res): void => {
      const sourceBusinessDate = z.iso
        .date()
        .safeParse(req.params.sourceBusinessDate);
      const parsed = journalEntrySchema.safeParse(req.body);
      if (!sourceBusinessDate.success || !parsed.success) {
        res.status(400).json({ error: "invalid_journal_entry" });
        return;
      }
      const value = parsed.data;
      const now = new Date().toISOString();
      const update = db.transaction(() => {
        const result = db
          .prepare(
            `UPDATE daily_sales_journal
             SET business_month = ?, journal_date = ?,
                 invoice_number_range = ?, senior_discount_centavos = ?,
                 non_vat_centavos = ?, vatable_sales_centavos = ?,
                 total_vat_centavos = ?, gross_sales_centavos = ?,
                 net_sales_centavos = ?, edited_at = ?, edited_by_user_id = ?
             WHERE source_business_date = ?`,
          )
          .run(
            value.month,
            value.date,
            value.invoiceNumberRange,
            parseMoney(value.seniorDiscount),
            parseMoney(value.nonVat),
            parseMoney(value.vatableSales),
            parseMoney(value.totalVat),
            parseMoney(value.grossSales),
            parseMoney(value.netSales),
            now,
            req.user!.id,
            sourceBusinessDate.data,
          );
        if (result.changes !== 1) return false;
        writeAuditEvent(db, {
          actorUserId: req.user!.id,
          action: "journal.entry_edited",
          entityType: "sales_journal_entry",
          entityId: sourceBusinessDate.data,
          details: {
            fields: Object.keys(value),
            month: value.month,
            invoiceNumberRange: value.invoiceNumberRange,
          },
        });
        return true;
      });
      if (!update()) {
        res.status(404).json({ error: "journal_entry_not_found" });
        return;
      }

      const row = db
        .prepare(
          `SELECT source_business_date, business_month, journal_date,
                  invoice_number_range, senior_discount_centavos,
                  non_vat_centavos, vatable_sales_centavos,
                  total_vat_centavos, gross_sales_centavos,
                  net_sales_centavos, edited_at
           FROM daily_sales_journal WHERE source_business_date = ?`,
        )
        .get(sourceBusinessDate.data) as JournalRow;
      res.json({ entry: present(row) });
    },
  );
}
