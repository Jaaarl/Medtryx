import type { ExpenseEntry, ExpenseTotals } from "@medtryx/shared";
import type Database from "better-sqlite3";
import { Decimal } from "decimal.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuthentication, requireCsrf } from "./auth.js";
import { writeAuditEvent } from "./db.js";
import { manilaCalendarDate } from "./lot-stock.js";

const expenseSchema = z
  .object({
    requestKey: z.uuid(),
    shiftId: z.uuid().optional(),
    category: z.enum(["LUNCH", "DELIVERY", "OTHER", "STOCK_PURCHASE"]),
    amount: z
      .string()
      .trim()
      .regex(/^\d{1,8}(?:\.\d{1,2})?$/)
      .pipe(
        z
          .string()
          .refine(
            (amount) => new Decimal(amount).gt(0),
            "amount_must_be_positive",
          ),
      ),
    description: z.string().trim().max(500).default(""),
    paymentSource: z.enum(["CASHIER", "OWNER"]),
    includedInUnitCost: z.boolean().default(false),
    productAmount: z
      .string()
      .trim()
      .regex(/^\d{1,7}(?:\.\d{1,2})?$/)
      .default("0"),
    deliveryFee: z
      .string()
      .trim()
      .regex(/^\d{1,7}(?:\.\d{1,2})?$/)
      .default("0"),
    supplier: z.string().trim().max(200).default(""),
    invoiceReference: z.string().trim().max(200).default(""),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      !/^\d{1,8}(?:\.\d{1,2})?$/.test(value.amount) ||
      ![value.productAmount, value.deliveryFee].every((amount) =>
        /^\d{1,7}(?:\.\d{1,2})?$/.test(amount),
      )
    )
      return;
    if (
      value.category !== "STOCK_PURCHASE" &&
      cents(value.amount) > 999_999_999n
    ) {
      context.addIssue({
        code: "custom",
        path: ["amount"],
        message: "amount_exceeds_expense_limit",
      });
    }
    if (value.paymentSource === "OWNER" && value.shiftId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["shiftId"],
        message: "owner_payment_has_no_shift",
      });
    }
    if (
      value.category !== "DELIVERY" &&
      value.category !== "STOCK_PURCHASE" &&
      (value.paymentSource !== "CASHIER" || value.includedInUnitCost)
    ) {
      context.addIssue({ code: "custom", message: "delivery_options_only" });
    }
    if (value.category === "OTHER" && value.description.length < 3) {
      context.addIssue({
        code: "custom",
        path: ["description"],
        message: "description_required",
      });
    }
    if (value.category === "STOCK_PURCHASE") {
      if (value.includedInUnitCost) {
        context.addIssue({
          code: "custom",
          path: ["includedInUnitCost"],
          message: "stock_payment_is_automatically_inventory_cost",
        });
      }
      if (
        cents(value.productAmount) <= 0n ||
        cents(value.amount) !==
          cents(value.productAmount) + cents(value.deliveryFee)
      ) {
        context.addIssue({
          code: "custom",
          path: ["productAmount"],
          message: "stock_payment_breakdown_must_match_total",
        });
      }
    } else if (
      cents(value.productAmount) !== 0n ||
      cents(value.deliveryFee) !== 0n ||
      value.supplier ||
      value.invoiceReference
    ) {
      context.addIssue({
        code: "custom",
        message: "stock_payment_details_only",
      });
    }
  });

const cents = (value: string) => BigInt(new Decimal(value).mul(100).toFixed(0));
const money = (value: bigint | number) =>
  new Decimal(value.toString()).div(100).toFixed(2);

export function getExpenseEntries(
  db: Database.Database,
  startDate: string,
  endDate: string,
  cashierId?: string,
): ExpenseEntry[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.business_date, e.category, e.amount_centavos,
            e.description, e.payment_source, e.included_in_unit_cost,
            e.product_amount_centavos, e.delivery_fee_centavos, e.supplier, e.invoice_reference,
            e.shift_id, e.created_at, u.email AS recorded_by_email,
            cashier.email AS cashier_email
     FROM expenses e JOIN users u ON u.id = e.recorded_by_user_id
     LEFT JOIN shifts sh ON sh.id = e.shift_id
     LEFT JOIN users cashier ON cashier.id = sh.cashier_user_id
     WHERE e.business_date >= ? AND e.business_date <= ?
       ${cashierId ? "AND (sh.cashier_user_id = ? OR (e.shift_id IS NULL AND e.recorded_by_user_id = ?))" : ""}
     ORDER BY e.created_at DESC, e.id DESC`,
    )
    .all(
      startDate,
      endDate,
      ...(cashierId ? [cashierId, cashierId] : []),
    ) as Array<{
    id: string;
    business_date: string;
    category: ExpenseEntry["category"];
    amount_centavos: number;
    product_amount_centavos: number;
    delivery_fee_centavos: number;
    supplier: string;
    invoice_reference: string;
    description: string;
    payment_source: ExpenseEntry["paymentSource"];
    included_in_unit_cost: number;
    shift_id: string | null;
    created_at: string;
    recorded_by_email: string;
    cashier_email: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    businessDate: row.business_date,
    category: row.category,
    amount: money(row.amount_centavos),
    productAmount: money(row.product_amount_centavos),
    deliveryFee: money(
      row.category === "DELIVERY"
        ? row.amount_centavos
        : row.delivery_fee_centavos,
    ),
    supplier: row.supplier,
    invoiceReference: row.invoice_reference,
    description: row.description,
    paymentSource: row.payment_source,
    includedInUnitCost: row.included_in_unit_cost === 1,
    operatingExpense: money(
      row.category === "STOCK_PURCHASE" || row.included_in_unit_cost
        ? 0
        : row.amount_centavos,
    ),
    recordedByEmail: row.recorded_by_email,
    cashierEmail: row.cashier_email,
    shiftId: row.shift_id,
    createdAt: row.created_at,
  }));
}

export function summarizeExpenses(entries: ExpenseEntry[]): ExpenseTotals {
  const sum = (filter: (entry: ExpenseEntry) => boolean, operating = false) =>
    money(
      entries
        .filter(filter)
        .reduce(
          (total, entry) =>
            total + cents(operating ? entry.operatingExpense : entry.amount),
          0n,
        ),
    );
  return {
    paymentCount: entries.length,
    totalPayments: sum(() => true),
    operatingExpenses: sum(() => true, true),
    cashierPaid: sum((entry) => entry.paymentSource === "CASHIER"),
    ownerPaid: sum((entry) => entry.paymentSource === "OWNER"),
    includedInUnitCost: sum((entry) => entry.includedInUnitCost),
    stockPurchasePayments: sum((entry) => entry.category === "STOCK_PURCHASE"),
    stockProductPayments: money(
      entries.reduce((total, entry) => total + cents(entry.productAmount), 0n),
    ),
    stockDeliveryFees: money(
      entries
        .filter((entry) => entry.category === "STOCK_PURCHASE")
        .reduce((total, entry) => total + cents(entry.deliveryFee), 0n),
    ),
    cashierPaidStockPurchases: sum(
      (entry) =>
        entry.category === "STOCK_PURCHASE" &&
        entry.paymentSource === "CASHIER",
    ),
    ownerPaidStockPurchases: sum(
      (entry) =>
        entry.category === "STOCK_PURCHASE" && entry.paymentSource === "OWNER",
    ),
    lunch: sum((entry) => entry.category === "LUNCH", true),
    delivery: sum((entry) => entry.category === "DELIVERY", true),
    other: sum((entry) => entry.category === "OTHER", true),
  };
}

class ExpenseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

type RegisterShift = {
  id: string;
  cashier_user_id: string;
  cashier_email: string;
  expected_cash_centavos: number;
};

function openRegister(db: Database.Database): RegisterShift | undefined {
  return db
    .prepare(
      `SELECT sh.id, sh.cashier_user_id,
       COALESCE(sh.expected_cash_centavos, sh.opening_cash_centavos) AS expected_cash_centavos,
       u.email AS cashier_email
     FROM shifts sh JOIN users u ON u.id = sh.cashier_user_id
     WHERE sh.closed_at IS NULL LIMIT 1`,
    )
    .get() as RegisterShift | undefined;
}

export function registerExpenseRoutes(
  router: express.Router,
  db: Database.Database,
): void {
  const requireAuth = requireAuthentication(db);
  const csrf: express.RequestHandler = (req, res, next) =>
    requireCsrf(db, req, res, next);
  router.get("/expenses", requireAuth, (req, res) => {
    const start = z.iso
      .date()
      .safeParse(req.query.startDate ?? manilaCalendarDate());
    const end = z.iso.date().safeParse(req.query.endDate ?? start.data);
    if (!start.success || !end.success || start.data > end.data) {
      res.status(400).json({ error: "invalid_report_range" });
      return;
    }
    const user = req.user!;
    const expenses = getExpenseEntries(
      db,
      start.data,
      end.data,
      user.role === "owner" ? undefined : user.id,
    );
    const shift = openRegister(db);
    res.json({
      expenses,
      totals: summarizeExpenses(expenses),
      registerShift: shift
        ? {
            id: shift.id,
            cashierEmail: shift.cashier_email,
            expectedCash: money(shift.expected_cash_centavos),
            canCharge:
              user.role === "owner" || shift.cashier_user_id === user.id,
          }
        : null,
    });
  });

  router.post("/expenses", requireAuth, csrf, (req, res) => {
    const parsed = expenseSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_expense", issues: parsed.error.issues });
      return;
    }
    const input = parsed.data;
    const user = req.user!;
    const amount = Number(cents(input.amount));
    const productAmount = Number(cents(input.productAmount));
    const deliveryFee = Number(cents(input.deliveryFee));
    try {
      const result = db.transaction(() => {
        const saved = db
          .prepare(
            "SELECT * FROM expenses WHERE recorded_by_user_id = ? AND request_id = ?",
          )
          .get(user.id, input.requestKey) as
          | {
              id: string;
              business_date: string;
              category: string;
              amount_centavos: number;
              product_amount_centavos: number;
              delivery_fee_centavos: number;
              supplier: string;
              invoice_reference: string;
              description: string;
              payment_source: string;
              included_in_unit_cost: number;
              shift_id: string | null;
            }
          | undefined;
        if (saved) {
          if (
            saved.category !== input.category ||
            saved.amount_centavos !== amount ||
            saved.product_amount_centavos !== productAmount ||
            saved.delivery_fee_centavos !== deliveryFee ||
            saved.supplier !== input.supplier ||
            saved.invoice_reference !== input.invoiceReference ||
            saved.description !== input.description ||
            saved.payment_source !== input.paymentSource ||
            Boolean(saved.included_in_unit_cost) !== input.includedInUnitCost ||
            (input.shiftId !== undefined && saved.shift_id !== input.shiftId)
          ) {
            throw new ExpenseError(409, "expense_request_key_reused");
          }
          return { id: saved.id, date: saved.business_date, created: false };
        }
        const shift =
          input.paymentSource === "CASHIER" ? openRegister(db) : undefined;
        if (input.paymentSource === "CASHIER") {
          if (!shift) throw new ExpenseError(409, "open_shift_required");
          if (input.shiftId !== undefined && shift.id !== input.shiftId)
            throw new ExpenseError(409, "expense_shift_changed");
          if (user.role !== "owner" && shift.cashier_user_id !== user.id)
            throw new ExpenseError(403, "expense_requires_own_shift");
          if (!Number.isSafeInteger(shift.expected_cash_centavos - amount))
            throw new ExpenseError(409, "cash_amount_overflow");
        }
        const now = new Date();
        const createdAt = now.toISOString();
        const date = manilaCalendarDate(now);
        const id = randomUUID();
        const movementId = shift ? randomUUID() : null;
        if (shift && movementId) {
          db.prepare(
            `INSERT INTO cash_movements
              (id, shift_id, movement_type, amount_delta_centavos, reason, actor_user_id, created_at)
             VALUES (?, ?, 'CASH_OUT', ?, ?, ?, ?)`,
          ).run(
            movementId,
            shift.id,
            -amount,
            `${input.category === "STOCK_PURCHASE" ? "Stock purchase / COD" : `Expense: ${input.category}`}${input.supplier ? ` / ${input.supplier}` : ""}${input.invoiceReference ? ` / ${input.invoiceReference}` : ""}${input.description ? ` / ${input.description}` : ""}`,
            user.id,
            createdAt,
          );
          const updated = db
            .prepare(
              `UPDATE shifts SET expected_cash_centavos = COALESCE(expected_cash_centavos, opening_cash_centavos) - ?
             WHERE id = ? AND closed_at IS NULL`,
            )
            .run(amount, shift.id);
          if (updated.changes !== 1)
            throw new ExpenseError(409, "open_shift_required");
        }
        db.prepare(
          `INSERT INTO expenses (id, request_id, business_date, category, amount_centavos,
            description, payment_source, included_in_unit_cost, recorded_by_user_id,
            shift_id, cash_movement_id, created_at, product_amount_centavos,
            delivery_fee_centavos, supplier, invoice_reference)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          input.requestKey,
          date,
          input.category,
          amount,
          input.description,
          input.paymentSource,
          input.includedInUnitCost ? 1 : 0,
          user.id,
          shift?.id ?? null,
          movementId,
          createdAt,
          productAmount,
          deliveryFee,
          input.supplier,
          input.invoiceReference,
        );
        writeAuditEvent(db, {
          actorUserId: user.id,
          action: "expense.recorded",
          entityType: "expense",
          entityId: id,
          details: {
            category: input.category,
            amountCentavos: amount,
            productAmountCentavos: productAmount,
            deliveryFeeCentavos: deliveryFee,
            supplier: input.supplier,
            invoiceReference: input.invoiceReference,
            paymentSource: input.paymentSource,
            includedInUnitCost: input.includedInUnitCost,
            description: input.description,
            shiftId: shift?.id ?? null,
            cashMovementId: movementId,
          },
        });
        return { id, date, created: true };
      })();
      const expense = getExpenseEntries(db, result.date, result.date).find(
        (entry) => entry.id === result.id,
      )!;
      const balance = expense.shiftId
        ? (db
            .prepare("SELECT expected_cash_centavos FROM shifts WHERE id = ?")
            .get(expense.shiftId) as { expected_cash_centavos: number })
        : undefined;
      res.status(result.created ? 201 : 200).json({
        expense,
        expectedCash: balance ? money(balance.expected_cash_centavos) : null,
      });
    } catch (error) {
      if (error instanceof ExpenseError)
        res.status(error.status).json({ error: error.code });
      else throw error;
    }
  });
}
