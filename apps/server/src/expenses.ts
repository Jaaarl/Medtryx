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
    businessDate: z.iso.date().optional(),
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
  recordedByUserId?: string,
  actor?: { id: string; role: string },
): ExpenseEntry[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.business_date, e.category, e.amount_centavos,
            e.description, e.payment_source, e.included_in_unit_cost,
            e.product_amount_centavos, e.delivery_fee_centavos, e.supplier, e.invoice_reference,
            e.shift_id, e.created_at, e.recorded_by_user_id,
            u.email AS recorded_by_email, cashier.email AS cashier_email,
            sh.cashier_user_id AS shift_cashier_user_id,
            sh.closed_at AS shift_closed_at,
            ec.created_at AS cancelled_at, canceller.email AS cancelled_by_email
     FROM expenses e JOIN users u ON u.id = e.recorded_by_user_id
     LEFT JOIN shifts sh ON sh.id = e.shift_id
     LEFT JOIN users cashier ON cashier.id = sh.cashier_user_id
     LEFT JOIN expense_cancellations ec ON ec.expense_id = e.id
     LEFT JOIN users canceller ON canceller.id = ec.cancelled_by_user_id
     WHERE e.business_date >= ? AND e.business_date <= ?
       ${cashierId ? `AND (sh.cashier_user_id = ? OR (e.shift_id IS NULL AND e.recorded_by_user_id = ?)${recordedByUserId ? " OR e.recorded_by_user_id = ?" : ""})` : ""}
     ORDER BY e.created_at DESC, e.id DESC`,
    )
    .all(
      startDate,
      endDate,
      ...(cashierId
        ? [
            cashierId,
            cashierId,
            ...(recordedByUserId ? [recordedByUserId] : []),
          ]
        : []),
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
    recorded_by_user_id: string;
    recorded_by_email: string;
    cashier_email: string | null;
    shift_cashier_user_id: string | null;
    shift_closed_at: string | null;
    cancelled_at: string | null;
    cancelled_by_email: string | null;
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
      row.cancelled_at !== null ||
        row.category === "STOCK_PURCHASE" ||
        row.included_in_unit_cost
        ? 0
        : row.amount_centavos,
    ),
    recordedByEmail: row.recorded_by_email,
    cashierEmail: row.cashier_email,
    shiftId: row.shift_id,
    createdAt: row.created_at,
    cancelled: row.cancelled_at !== null,
    cancelledAt: row.cancelled_at,
    cancelledByEmail: row.cancelled_by_email,
    canCancel:
      row.cancelled_at === null &&
      (actor?.role === "owner" ||
        (actor?.role === "cashier" &&
          ((row.shift_id !== null &&
            row.shift_closed_at === null &&
            (row.shift_cashier_user_id === actor.id ||
              row.recorded_by_user_id === actor.id)) ||
            (row.shift_id === null &&
              row.payment_source === "OWNER" &&
              row.recorded_by_user_id === actor.id)))),
  }));
}

export function summarizeExpenses(entries: ExpenseEntry[]): ExpenseTotals {
  const activeEntries = entries.filter((entry) => !entry.cancelled);
  const sum = (filter: (entry: ExpenseEntry) => boolean, operating = false) =>
    money(
      activeEntries
        .filter(filter)
        .reduce(
          (total, entry) =>
            total + cents(operating ? entry.operatingExpense : entry.amount),
          0n,
        ),
    );
  return {
    paymentCount: activeEntries.length,
    totalPayments: sum(() => true),
    operatingExpenses: sum(() => true, true),
    cashierPaid: sum((entry) => entry.paymentSource === "CASHIER"),
    ownerPaid: sum((entry) => entry.paymentSource === "OWNER"),
    includedInUnitCost: sum((entry) => entry.includedInUnitCost),
    stockPurchasePayments: sum((entry) => entry.category === "STOCK_PURCHASE"),
    stockProductPayments: money(
      activeEntries.reduce(
        (total, entry) => total + cents(entry.productAmount),
        0n,
      ),
    ),
    stockDeliveryFees: money(
      activeEntries
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

type ExpenseShift = RegisterShift & {
  opened_at: string;
  closed_at: string | null;
};

function manilaDayBounds(businessDate: string) {
  const start = new Date(`${businessDate}T00:00:00.000+08:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function expenseShiftsForDate(
  db: Database.Database,
  businessDate: string,
  actor: { id: string; role: string },
): ExpenseShift[] {
  const bounds = manilaDayBounds(businessDate);
  return db
    .prepare(
      `SELECT sh.id, sh.cashier_user_id, sh.opened_at, sh.closed_at,
         COALESCE(sh.expected_cash_centavos, sh.opening_cash_centavos) AS expected_cash_centavos,
         u.email AS cashier_email
       FROM shifts sh JOIN users u ON u.id = sh.cashier_user_id
       WHERE sh.opened_at < ? AND (sh.closed_at IS NULL OR sh.closed_at > ?)
         AND (? = 'owner' OR sh.cashier_user_id = ? OR sh.closed_at IS NULL)
       ORDER BY sh.opened_at, sh.id`,
    )
    .all(bounds.end, bounds.start, actor.role, actor.id) as ExpenseShift[];
}

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
      user.role === "owner" ? undefined : user.id,
      { id: user.id, role: user.role },
    );
    const shift = openRegister(db);
    const availableShifts = expenseShiftsForDate(db, start.data, {
      id: user.id,
      role: user.role,
    });
    res.json({
      expenses,
      totals: summarizeExpenses(expenses),
      availableShifts: availableShifts.map((available) => ({
        id: available.id,
        cashierEmail: available.cashier_email,
        expectedCash: money(available.expected_cash_centavos),
        openedAt: available.opened_at,
        closedAt: available.closed_at,
      })),
      registerShift: shift
        ? {
            id: shift.id,
            cashierEmail: shift.cashier_email,
            expectedCash: money(shift.expected_cash_centavos),
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
    const businessDate = input.businessDate ?? manilaCalendarDate();
    if (businessDate > manilaCalendarDate()) {
      res.status(400).json({ error: "future_expense_date" });
      return;
    }
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
            saved.business_date !== businessDate ||
            (input.shiftId !== undefined && saved.shift_id !== input.shiftId)
          ) {
            throw new ExpenseError(409, "expense_request_key_reused");
          }
          return { id: saved.id, date: saved.business_date, created: false };
        }
        let shift: ExpenseShift | undefined;
        if (input.paymentSource === "CASHIER") {
          const availableShifts = expenseShiftsForDate(db, businessDate, {
            id: user.id,
            role: user.role,
          });
          if (input.shiftId !== undefined) {
            shift = availableShifts.find(
              (candidate) => candidate.id === input.shiftId,
            );
            if (!shift)
              throw new ExpenseError(409, "expense_shift_unavailable");
          } else {
            const currentShift = openRegister(db);
            const today = manilaCalendarDate();
            shift =
              businessDate === today
                ? availableShifts.find(
                    (candidate) => candidate.id === currentShift?.id,
                  )
                : undefined;
            if (!shift && availableShifts.length === 1)
              shift = availableShifts[0];
            if (!shift) {
              if (availableShifts.length > 1)
                throw new ExpenseError(409, "expense_shift_selection_required");
              throw new ExpenseError(
                409,
                businessDate === today
                  ? "open_shift_required"
                  : "expense_shift_unavailable",
              );
            }
          }
          if (!Number.isSafeInteger(shift.expected_cash_centavos - amount))
            throw new ExpenseError(409, "cash_amount_overflow");
        }
        const now = new Date();
        const createdAt = now.toISOString();
        const date = businessDate;
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
          const expectedCash = shift.expected_cash_centavos - amount;
          if (shift.closed_at === null) {
            const updated = db
              .prepare(
                `UPDATE shifts SET expected_cash_centavos = ?
                 WHERE id = ? AND closed_at IS NULL`,
              )
              .run(expectedCash, shift.id);
            if (updated.changes !== 1)
              throw new ExpenseError(409, "expense_shift_changed");
          } else {
            const closedShift = db
              .prepare(
                `SELECT actual_cash_count_centavos, variance_reason
                 FROM shifts WHERE id = ? AND closed_at IS NOT NULL`,
              )
              .get(shift.id) as
              | {
                  actual_cash_count_centavos: number | null;
                  variance_reason: string | null;
                }
              | undefined;
            if (
              closedShift?.actual_cash_count_centavos === null ||
              !closedShift
            )
              throw new ExpenseError(409, "expense_shift_unavailable");
            const variance =
              closedShift.actual_cash_count_centavos - expectedCash;
            if (!Number.isSafeInteger(variance))
              throw new ExpenseError(409, "cash_amount_overflow");
            const varianceReason =
              variance === 0
                ? closedShift.variance_reason
                : (closedShift.variance_reason ??
                  "Payment recorded after shift close.");
            const updated = db
              .prepare(
                `UPDATE shifts
                 SET expected_cash_centavos = ?, variance_centavos = ?,
                     variance_reason = ?, variance_approval_status = ?,
                     variance_approved_by_user_id = NULL, variance_approved_at = NULL,
                     variance_approval_note = NULL
                 WHERE id = ? AND closed_at IS NOT NULL
                   AND actual_cash_count_centavos IS NOT NULL`,
              )
              .run(
                expectedCash,
                variance,
                varianceReason,
                variance === 0 ? "NONE" : "PENDING",
                shift.id,
              );
            if (updated.changes !== 1)
              throw new ExpenseError(409, "expense_shift_unavailable");
          }
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
            businessDate: date,
            description: input.description,
            shiftId: shift?.id ?? null,
            cashMovementId: movementId,
          },
        });
        return { id, date, created: true };
      })();
      const expense = getExpenseEntries(
        db,
        result.date,
        result.date,
        undefined,
        undefined,
        { id: user.id, role: user.role },
      ).find((entry) => entry.id === result.id)!;
      const balance = expense.shiftId
        ? (db
            .prepare(
              "SELECT COALESCE(expected_cash_centavos, opening_cash_centavos) AS expected_cash_centavos FROM shifts WHERE id = ?",
            )
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

  router.post(
    "/expenses/:expenseId/cancellation",
    requireAuth,
    csrf,
    (req, res) => {
      const expenseId = z.uuid().safeParse(req.params.expenseId);
      if (!expenseId.success || !req.user) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      const user = req.user;
      try {
        const result = db.transaction(() => {
          const expense = db
            .prepare(
              `SELECT e.id, e.business_date, e.category, e.amount_centavos,
                    e.description, e.payment_source, e.supplier,
                    e.invoice_reference, e.recorded_by_user_id, e.shift_id,
                    sh.cashier_user_id, sh.expected_cash_centavos,
                    sh.opening_cash_centavos, sh.closed_at,
                    sh.actual_cash_count_centavos, sh.variance_reason,
                    ec.id AS cancellation_id
             FROM expenses e
             LEFT JOIN shifts sh ON sh.id = e.shift_id
             LEFT JOIN expense_cancellations ec ON ec.expense_id = e.id
             WHERE e.id = ?`,
            )
            .get(expenseId.data) as
            | {
                id: string;
                business_date: string;
                category: ExpenseEntry["category"];
                amount_centavos: number;
                description: string;
                payment_source: ExpenseEntry["paymentSource"];
                supplier: string;
                invoice_reference: string;
                recorded_by_user_id: string;
                shift_id: string | null;
                cashier_user_id: string | null;
                expected_cash_centavos: number | null;
                opening_cash_centavos: number | null;
                closed_at: string | null;
                actual_cash_count_centavos: number | null;
                variance_reason: string | null;
                cancellation_id: string | null;
              }
            | undefined;
          if (!expense) throw new ExpenseError(404, "expense_not_found");
          if (expense.cancellation_id)
            throw new ExpenseError(409, "expense_already_cancelled");
          const allowed =
            user.role === "owner" ||
            (user.role === "cashier" &&
              ((expense.shift_id !== null &&
                expense.closed_at === null &&
                (expense.cashier_user_id === user.id ||
                  expense.recorded_by_user_id === user.id)) ||
                (expense.shift_id === null &&
                  expense.payment_source === "OWNER" &&
                  expense.recorded_by_user_id === user.id)));
          if (!allowed) throw new ExpenseError(403, "forbidden");

          const amount = expense.amount_centavos;
          const now = new Date().toISOString();
          const cancellationId = randomUUID();
          let movementId: string | null = null;
          let expectedCash: number | null = null;
          if (expense.shift_id) {
            const previousExpected =
              expense.expected_cash_centavos ?? expense.opening_cash_centavos;
            if (previousExpected === null)
              throw new ExpenseError(409, "expense_shift_unavailable");
            const adjustedExpected = previousExpected + amount;
            if (!Number.isSafeInteger(adjustedExpected))
              throw new ExpenseError(409, "cash_amount_overflow");
            movementId = randomUUID();
            const details = [
              expense.category === "STOCK_PURCHASE"
                ? "Stock purchase / COD"
                : `Expense: ${expense.category}`,
              expense.supplier,
              expense.invoice_reference,
              expense.description,
            ].filter(Boolean);
            db.prepare(
              `INSERT INTO cash_movements
              (id, shift_id, movement_type, amount_delta_centavos, reason, actor_user_id, created_at)
             VALUES (?, ?, 'CASH_IN', ?, ?, ?, ?)`,
            ).run(
              movementId,
              expense.shift_id,
              amount,
              `Refund canceled payment: ${details.join(" / ")}`,
              user.id,
              now,
            );
            if (expense.closed_at === null) {
              const updated = db
                .prepare(
                  `UPDATE shifts SET expected_cash_centavos = ?
                 WHERE id = ? AND closed_at IS NULL`,
                )
                .run(adjustedExpected, expense.shift_id);
              if (updated.changes !== 1)
                throw new ExpenseError(409, "expense_shift_changed");
            } else {
              if (expense.actual_cash_count_centavos === null)
                throw new ExpenseError(409, "expense_shift_unavailable");
              const variance =
                expense.actual_cash_count_centavos - adjustedExpected;
              if (!Number.isSafeInteger(variance))
                throw new ExpenseError(409, "cash_amount_overflow");
              const varianceReason =
                variance === 0
                  ? expense.variance_reason
                  : (expense.variance_reason ??
                    "Payment refund recorded after shift close.");
              db.prepare(
                `UPDATE shifts
               SET expected_cash_centavos = ?, variance_centavos = ?,
                   variance_reason = ?, variance_approval_status = ?,
                   variance_approved_by_user_id = NULL, variance_approved_at = NULL,
                   variance_approval_note = NULL
               WHERE id = ? AND closed_at IS NOT NULL`,
              ).run(
                adjustedExpected,
                variance,
                varianceReason,
                variance === 0 ? "NONE" : "PENDING",
                expense.shift_id,
              );
            }
            expectedCash = adjustedExpected;
          }

          const reason = `Cancelled ${expense.category} payment (${money(amount)}): ${[
            expense.supplier,
            expense.invoice_reference,
            expense.description,
          ]
            .filter(Boolean)
            .join(" / ")}`;
          db.prepare(
            `INSERT INTO expense_cancellations
             (id, expense_id, cash_movement_id, cancelled_by_user_id, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(cancellationId, expense.id, movementId, user.id, reason, now);
          writeAuditEvent(db, {
            actorUserId: user.id,
            action: "expense.cancelled",
            entityType: "expense",
            entityId: expense.id,
            details: {
              category: expense.category,
              amountCentavos: amount,
              paymentSource: expense.payment_source,
              shiftId: expense.shift_id,
              cashMovementId: movementId,
              reason,
            },
          });
          return {
            date: expense.business_date,
            expectedCash: expectedCash === null ? null : money(expectedCash),
          };
        })();
        const expense = getExpenseEntries(
          db,
          result.date,
          result.date,
          user.role === "owner" ? undefined : user.id,
          user.role === "owner" ? undefined : user.id,
          { id: user.id, role: user.role },
        ).find((entry) => entry.id === expenseId.data)!;
        res.json({ expense, expectedCash: result.expectedCash });
      } catch (error) {
        if (error instanceof ExpenseError)
          res.status(error.status).json({ error: error.code });
        else throw error;
      }
    },
  );
}
