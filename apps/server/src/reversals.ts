import argon2 from "argon2";
import { Decimal } from "decimal.js";
import type { NextFunction, Request, Response } from "express";
import type Database from "better-sqlite3";
import express from "express";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuthentication, requireCsrf, requireRole } from "./auth.js";
import { writeAuditEvent } from "./db.js";
import { getSavedSale } from "./sales.js";
import { manilaCalendarDate, writeLotMovement } from "./lot-stock.js";

const moneySchema = z
  .string()
  .trim()
  .regex(/^\d{1,7}(?:\.\d{1,2})?$/);
const cashMovementSchema = z
  .object({
    movementType: z.enum(["CASH_IN", "CASH_OUT"]),
    amount: moneySchema,
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
const reversalSchema = z
  .object({
    ownerPassword: z.string().min(1).max(128),
    reason: z.string().trim().min(3).max(500),
    refundMethod: z.enum(["CASH", "QR"]),
    refundShiftId: z.uuid().optional(),
    lines: z
      .array(
        z
          .object({
            saleLineId: z.uuid(),
            restock: z.boolean(),
            lotPickVerified: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.refundMethod === "CASH" && !value.refundShiftId) {
      context.addIssue({
        code: "custom",
        path: ["refundShiftId"],
        message: "cash_refund_shift_required",
      });
    }
    if (value.refundMethod === "QR" && value.refundShiftId) {
      context.addIssue({
        code: "custom",
        path: ["refundShiftId"],
        message: "qr_refund_has_no_cash_shift",
      });
    }
    const lineIds = value.lines.map((line) => line.saleLineId);
    if (new Set(lineIds).size !== lineIds.length) {
      context.addIssue({
        code: "custom",
        path: ["lines"],
        message: "duplicate_sale_line",
      });
    }
  });
const varianceApprovalSchema = z
  .object({
    ownerPassword: z.string().min(1).max(128),
    decision: z.enum(["APPROVE", "REJECT"]),
    note: z.string().trim().min(3).max(500),
  })
  .strict();

class ReversalError extends Error {
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
    throw new ReversalError(400, "invalid_money_amount");
  }
  return result;
}

function money(cents: number): string {
  return new Decimal(cents).div(100).toFixed(2);
}

function businessDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}${values.month}${values.day}`;
}

function validationFailure(res: Response): void {
  res.status(400).json({ error: "invalid_request" });
}

function handleReversalError(error: unknown, res: Response): boolean {
  if (error instanceof ReversalError) {
    res.status(error.status).json({ error: error.code });
    return true;
  }
  if (
    error instanceof Error &&
    error.message.includes("sale_reversals.sale_id")
  ) {
    res.status(409).json({ error: "sale_already_reversed" });
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

type SaleSummaryRow = {
  id: string;
  transaction_id: string;
  business_date: string;
  cashier_email: string;
  payment_method: "CASH" | "QR";
  amount_due_centavos: number;
  created_at: string;
  reversal_transaction_id: string | null;
  reversal_created_at: string | null;
  refund_method: "CASH" | "QR" | null;
  refund_amount_centavos: number | null;
  reversal_cash_rounding_adjustment_centavos: number | null;
  cash_rounding_adjustment_centavos: number;
};

function presentSaleSummary(row: SaleSummaryRow) {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    businessDate: row.business_date,
    cashierEmail: row.cashier_email,
    paymentMethod: row.payment_method,
    amountDue: money(row.amount_due_centavos),
    cashRoundingAdjustment: money(row.cash_rounding_adjustment_centavos),
    createdAt: row.created_at,
    status: row.reversal_transaction_id ? "REVERSED" : "FINALIZED",
    reversal: row.reversal_transaction_id
      ? {
          transactionId: row.reversal_transaction_id,
          createdAt: row.reversal_created_at,
          refundMethod: row.refund_method,
          amount: money(row.refund_amount_centavos ?? 0),
          cashRoundingAdjustment: money(
            row.reversal_cash_rounding_adjustment_centavos ?? 0,
          ),
        }
      : null,
  };
}

function internalReversalId(db: Database.Database, date: string): string {
  db.prepare(
    "INSERT OR IGNORE INTO reversal_sequences (business_date, next_number) VALUES (?, 1)",
  ).run(date);
  const row = db
    .prepare(
      "SELECT next_number FROM reversal_sequences WHERE business_date = ?",
    )
    .get(date) as { next_number: number } | undefined;
  if (!row || !Number.isSafeInteger(row.next_number)) {
    throw new ReversalError(409, "reversal_sequence_unavailable");
  }
  db.prepare(
    "UPDATE reversal_sequences SET next_number = next_number + 1 WHERE business_date = ?",
  ).run(date);
  return `MTR-${date}-${String(row.next_number).padStart(6, "0")}`;
}

export function registerReversalRoutes(
  router: express.Router,
  db: Database.Database,
): void {
  const requireAuth = requireAuthentication(db);
  const requireOwner = requireRole("owner");
  const csrf = (req: Request, res: Response, next: NextFunction) =>
    requireCsrf(db, req, res, next);
  const reversalRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: process.env.APP_ENV === "test" ? 100 : 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "too_many_reversal_attempts" },
  });

  router.get("/sales", requireAuth, requireOwner, (req, res) => {
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .safeParse(req.query.limit ?? "100");
    if (!limit.success) return validationFailure(res);
    const rows = db
      .prepare(
        `SELECT s.id, s.transaction_id, s.business_date, u.email AS cashier_email,
                s.payment_method, s.amount_due_centavos,
                s.cash_rounding_adjustment_centavos, s.created_at,
                r.reversal_transaction_id, r.created_at AS reversal_created_at,
                r.refund_method, r.amount_centavos AS refund_amount_centavos,
                r.cash_rounding_adjustment_centavos
                  AS reversal_cash_rounding_adjustment_centavos
         FROM sales s JOIN users u ON u.id = s.cashier_user_id
         LEFT JOIN sale_reversals r ON r.sale_id = s.id
         ORDER BY s.created_at DESC, s.transaction_id DESC LIMIT ?`,
      )
      .all(limit.data) as SaleSummaryRow[];
    res.json({ sales: rows.map(presentSaleSummary) });
  });

  router.get("/shifts/open", requireAuth, requireOwner, (_req, res) => {
    const rows = db
      .prepare(
        `SELECT s.id, s.cashier_user_id, u.email AS cashier_email, s.opened_at,
                s.opening_cash_centavos, s.expected_cash_centavos
         FROM shifts s JOIN users u ON u.id = s.cashier_user_id
         WHERE s.closed_at IS NULL ORDER BY s.opened_at, u.email`,
      )
      .all() as {
      id: string;
      cashier_user_id: string;
      cashier_email: string;
      opened_at: string;
      opening_cash_centavos: number;
      expected_cash_centavos: number;
    }[];
    res.json({
      shifts: rows.map((row) => ({
        id: row.id,
        cashierUserId: row.cashier_user_id,
        cashierEmail: row.cashier_email,
        openedAt: row.opened_at,
        openingCash: money(row.opening_cash_centavos),
        expectedCash: money(row.expected_cash_centavos),
      })),
    });
  });

  router.get(
    "/shifts/variance-approvals",
    requireAuth,
    requireOwner,
    (_req, res) => {
      const rows = db
        .prepare(
          `SELECT s.id, s.cashier_user_id, u.email AS cashier_email,
                  s.opened_at, s.closed_at, s.opening_cash_centavos,
                  s.expected_cash_centavos, s.actual_cash_count_centavos,
                  s.variance_centavos, s.variance_reason, c.email AS closed_by_email
           FROM shifts s JOIN users u ON u.id = s.cashier_user_id
           LEFT JOIN users c ON c.id = s.close_actor_user_id
           WHERE s.variance_approval_status = 'PENDING'
           ORDER BY s.closed_at, s.opened_at LIMIT 100`,
        )
        .all() as {
        id: string;
        cashier_user_id: string;
        cashier_email: string;
        opened_at: string;
        closed_at: string;
        opening_cash_centavos: number;
        expected_cash_centavos: number;
        actual_cash_count_centavos: number;
        variance_centavos: number;
        variance_reason: string | null;
        closed_by_email: string | null;
      }[];
      res.json({
        shifts: rows.map((shift) => ({
          id: shift.id,
          cashierUserId: shift.cashier_user_id,
          cashierEmail: shift.cashier_email,
          openedAt: shift.opened_at,
          closedAt: shift.closed_at,
          closedByEmail: shift.closed_by_email,
          openingCash: money(shift.opening_cash_centavos),
          expectedCash: money(shift.expected_cash_centavos),
          actualCashCount: money(shift.actual_cash_count_centavos),
          variance: money(shift.variance_centavos),
          cashierReason: shift.variance_reason,
        })),
      });
    },
  );

  router.post(
    "/shifts/:id/variance-approval",
    requireAuth,
    requireOwner,
    csrf,
    reversalRateLimit,
    async (req, res): Promise<void> => {
      const shiftId = z.uuid().safeParse(req.params.id);
      const parsed = varianceApprovalSchema.safeParse(req.body);
      if (!shiftId.success || !parsed.success || !req.user)
        return validationFailure(res);

      const owner = db
        .prepare(
          "SELECT password_hash FROM users WHERE id = ? AND role = 'owner' AND is_active = 1",
        )
        .get(req.user.id) as { password_hash: string } | undefined;
      let verified = false;
      try {
        verified =
          !!owner &&
          (await argon2.verify(owner.password_hash, parsed.data.ownerPassword));
      } catch {
        verified = false;
      }
      if (!verified || !owner) {
        res.status(403).json({ error: "reauthentication_failed" });
        return;
      }

      try {
        const now = new Date().toISOString();
        db.transaction(() => {
          const currentOwner = db
            .prepare(
              "SELECT password_hash FROM users WHERE id = ? AND role = 'owner' AND is_active = 1",
            )
            .get(req.user!.id) as { password_hash: string } | undefined;
          if (
            !currentOwner ||
            currentOwner.password_hash !== owner.password_hash
          ) {
            throw new ReversalError(403, "reauthentication_failed");
          }
          const shift = db
            .prepare(
              `SELECT id, variance_centavos FROM shifts
               WHERE id = ? AND closed_at IS NOT NULL
                 AND variance_approval_status = 'PENDING'`,
            )
            .get(shiftId.data) as
            | { id: string; variance_centavos: number }
            | undefined;
          if (!shift)
            throw new ReversalError(409, "variance_not_pending_approval");
          const status =
            parsed.data.decision === "APPROVE" ? "APPROVED" : "REJECTED";
          db.prepare(
            `UPDATE shifts SET variance_approval_status = ?,
               variance_approved_by_user_id = ?, variance_approved_at = ?,
               variance_approval_note = ? WHERE id = ?`,
          ).run(status, req.user!.id, now, parsed.data.note, shift.id);
          writeAuditEvent(db, {
            actorUserId: req.user!.id,
            action: `shift.variance_${parsed.data.decision.toLowerCase()}`,
            entityType: "shift",
            entityId: shift.id,
            details: {
              status,
              varianceCentavos: shift.variance_centavos,
              note: parsed.data.note,
            },
          });
        })();
        res.json({
          approvalStatus:
            parsed.data.decision === "APPROVE" ? "APPROVED" : "REJECTED",
        });
      } catch (error) {
        if (!handleReversalError(error, res)) throw error;
      }
    },
  );

  router.get(
    "/shifts/:id/cash-movements",
    requireAuth,
    requireOwner,
    (req, res) => {
      const shiftId = z.uuid().safeParse(req.params.id);
      if (!shiftId.success) return validationFailure(res);
      const movements = db
        .prepare(
          `SELECT m.id, m.movement_type, m.amount_delta_centavos,
                  m.reversal_id, m.reason, m.created_at, u.email AS actor_email,
                  r.reversal_transaction_id
           FROM cash_movements m JOIN users u ON u.id = m.actor_user_id
           LEFT JOIN sale_reversals r ON r.id = m.reversal_id
           WHERE m.shift_id = ? ORDER BY m.created_at DESC LIMIT 100`,
        )
        .all(shiftId.data) as {
        id: string;
        movement_type: "CASH_IN" | "CASH_OUT" | "CASH_REFUND";
        amount_delta_centavos: number;
        reversal_id: string | null;
        reversal_transaction_id: string | null;
        reason: string;
        created_at: string;
        actor_email: string;
      }[];
      res.json({
        movements: movements.map((movement) => ({
          id: movement.id,
          type: movement.movement_type,
          amountDelta: money(movement.amount_delta_centavos),
          reversalTransactionId: movement.reversal_transaction_id,
          reason: movement.reason,
          actorEmail: movement.actor_email,
          createdAt: movement.created_at,
        })),
      });
    },
  );

  router.post(
    "/shifts/:id/cash-movements",
    requireAuth,
    requireOwner,
    csrf,
    (req, res) => {
      const shiftId = z.uuid().safeParse(req.params.id);
      const parsed = cashMovementSchema.safeParse(req.body);
      if (!shiftId.success || !parsed.success || !req.user)
        return validationFailure(res);
      try {
        const amount = parseMoney(parsed.data.amount);
        if (amount <= 0) throw new ReversalError(400, "invalid_money_amount");
        const movement = db.transaction(() => {
          const shift = db
            .prepare(
              `SELECT id, expected_cash_centavos FROM shifts
               WHERE id = ? AND closed_at IS NULL`,
            )
            .get(shiftId.data) as
            | { id: string; expected_cash_centavos: number }
            | undefined;
          if (!shift) throw new ReversalError(404, "open_shift_not_found");
          const delta =
            parsed.data.movementType === "CASH_IN" ? amount : -amount;
          const expected = shift.expected_cash_centavos + delta;
          if (!Number.isSafeInteger(expected))
            throw new ReversalError(409, "cash_amount_overflow");
          if (expected < 0)
            throw new ReversalError(409, "insufficient_shift_cash");
          const id = randomUUID();
          const now = new Date().toISOString();
          db.prepare(
            `INSERT INTO cash_movements
               (id, shift_id, movement_type, amount_delta_centavos, reason,
                actor_user_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id,
            shift.id,
            parsed.data.movementType,
            delta,
            parsed.data.reason,
            req.user!.id,
            now,
          );
          db.prepare(
            "UPDATE shifts SET expected_cash_centavos = ? WHERE id = ? AND closed_at IS NULL",
          ).run(expected, shift.id);
          writeAuditEvent(db, {
            actorUserId: req.user!.id,
            action: `shift.${parsed.data.movementType.toLowerCase()}`,
            entityType: "cash_movement",
            entityId: id,
            details: {
              shiftId: shift.id,
              amountDeltaCentavos: delta,
              reason: parsed.data.reason,
            },
          });
          return { id, shiftId: shift.id, amountDelta: delta, expected };
        })();
        res.status(201).json({
          movement: {
            id: movement.id,
            shiftId: movement.shiftId,
            amountDelta: money(movement.amountDelta),
          },
          expectedCash: money(movement.expected),
        });
      } catch (error) {
        if (!handleReversalError(error, res)) throw error;
      }
    },
  );

  router.post(
    "/sales/:transactionId/reversals",
    requireAuth,
    requireOwner,
    csrf,
    reversalRateLimit,
    async (req, res): Promise<void> => {
      const transactionId = z
        .string()
        .regex(/^MTX-\d{8}-\d{6,}$/)
        .safeParse(req.params.transactionId);
      const parsed = reversalSchema.safeParse(req.body);
      if (!transactionId.success || !parsed.success || !req.user)
        return validationFailure(res);

      const sale = db
        .prepare(
          `SELECT id, amount_due_centavos, cash_rounding_adjustment_centavos
           FROM sales WHERE transaction_id = ?`,
        )
        .get(transactionId.data) as
        | {
            id: string;
            amount_due_centavos: number;
            cash_rounding_adjustment_centavos: number;
          }
        | undefined;
      if (!sale) {
        res.status(404).json({ error: "sale_not_found" });
        return;
      }

      const owner = db
        .prepare(
          "SELECT password_hash FROM users WHERE id = ? AND role = 'owner' AND is_active = 1",
        )
        .get(req.user.id) as { password_hash: string } | undefined;
      let verified = false;
      try {
        verified =
          !!owner &&
          (await argon2.verify(owner.password_hash, parsed.data.ownerPassword));
      } catch {
        verified = false;
      }
      if (!verified || !owner) {
        res.status(403).json({ error: "reauthentication_failed" });
        return;
      }

      try {
        const result = db.transaction(() => {
          const currentOwner = db
            .prepare(
              "SELECT password_hash FROM users WHERE id = ? AND role = 'owner' AND is_active = 1",
            )
            .get(req.user!.id) as { password_hash: string } | undefined;
          if (
            !currentOwner ||
            currentOwner.password_hash !== owner.password_hash
          ) {
            throw new ReversalError(403, "reauthentication_failed");
          }
          const original = db
            .prepare(
              `SELECT id, amount_due_centavos, cash_rounding_adjustment_centavos
               FROM sales WHERE id = ?`,
            )
            .get(sale.id) as
            | {
                id: string;
                amount_due_centavos: number;
                cash_rounding_adjustment_centavos: number;
              }
            | undefined;
          if (!original) throw new ReversalError(404, "sale_not_found");
          if (
            db
              .prepare("SELECT 1 FROM sale_reversals WHERE sale_id = ?")
              .get(sale.id)
          ) {
            throw new ReversalError(409, "sale_already_reversed");
          }

          const saleLines = db
            .prepare(
              `SELECT id, product_id, quantity, amount_due_centavos,
                      allocated_cogs_centavos,
                      EXISTS(SELECT 1 FROM sale_line_lot_allocations a
                             WHERE a.sale_line_id = sale_lines.id) AS lot_tracked
               FROM sale_lines WHERE sale_id = ? ORDER BY line_number`,
            )
            .all(sale.id) as {
            id: string;
            product_id: string;
            quantity: number;
            amount_due_centavos: number;
            allocated_cogs_centavos: number;
            lot_tracked: number;
          }[];
          const decisionByLine = new Map(
            parsed.data.lines.map((line) => [line.saleLineId, line]),
          );
          if (
            saleLines.length !== parsed.data.lines.length ||
            saleLines.some((line) => !decisionByLine.has(line.id))
          ) {
            throw new ReversalError(400, "reversal_lines_must_match_sale");
          }
          for (const line of saleLines) {
            const decision = decisionByLine.get(line.id)!;
            if (line.lot_tracked === 1 && decision.restock) {
              if (!decision.lotPickVerified)
                throw new ReversalError(
                  400,
                  "lot_return_verification_required",
                );
              const allocations = db
                .prepare(
                  `SELECT l.id, l.expiry_date, l.quarantined
                   FROM sale_line_lot_allocations a
                   JOIN inventory_lots l ON l.id = a.lot_id
                   WHERE a.sale_line_id = ?`,
                )
                .all(line.id) as Array<{
                id: string;
                expiry_date: string;
                quarantined: number;
              }>;
              const today = manilaCalendarDate();
              if (
                allocations.length === 0 ||
                allocations.some(
                  (lot) => lot.expiry_date < today || lot.quarantined === 1,
                )
              ) {
                throw new ReversalError(409, "returned_lot_not_saleable");
              }
            }
          }
          const lineRefundTotal = saleLines.reduce(
            (total, line) => total + line.amount_due_centavos,
            0,
          );
          const refundTotal =
            lineRefundTotal + original.cash_rounding_adjustment_centavos;
          if (
            !Number.isSafeInteger(refundTotal) ||
            refundTotal < 0 ||
            refundTotal !== original.amount_due_centavos
          ) {
            throw new ReversalError(409, "sale_totals_do_not_reconcile");
          }

          let cashShift:
            | { id: string; expected_cash_centavos: number }
            | undefined;
          if (parsed.data.refundMethod === "CASH") {
            cashShift = db
              .prepare(
                `SELECT id, expected_cash_centavos FROM shifts
                 WHERE id = ? AND closed_at IS NULL`,
              )
              .get(parsed.data.refundShiftId!) as
              | { id: string; expected_cash_centavos: number }
              | undefined;
            if (!cashShift)
              throw new ReversalError(409, "cash_refund_requires_open_shift");
            if (cashShift.expected_cash_centavos < refundTotal) {
              throw new ReversalError(409, "insufficient_shift_cash");
            }
          }

          const now = new Date();
          const createdAt = now.toISOString();
          const reversalId = randomUUID();
          const reversalTransactionId = internalReversalId(
            db,
            businessDate(now),
          );
          db.prepare(
            `INSERT INTO sale_reversals
              (id, reversal_transaction_id, sale_id, approved_by_user_id, reason,
               refund_method, amount_centavos, cash_shift_id, created_at,
               cash_rounding_adjustment_centavos)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            reversalId,
            reversalTransactionId,
            sale.id,
            req.user!.id,
            parsed.data.reason,
            parsed.data.refundMethod,
            refundTotal,
            cashShift?.id ?? null,
            createdAt,
            original.cash_rounding_adjustment_centavos,
          );

          const insertLine = db.prepare(
            `INSERT INTO sale_reversal_lines
              (id, reversal_id, sale_line_id, product_id, quantity,
               refund_amount_centavos, stock_treatment, original_cogs_centavos,
               cogs_restored_centavos, writeoff_centavos, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          const insertStockEvent = db.prepare(
            `INSERT INTO stock_events
              (id, product_id, event_type, quantity_delta, unit_cost_centavos,
               inventory_value_delta_centavos, reference, reason, actor_user_id, created_at)
             VALUES (?, ?, 'REVERSAL', ?, NULL, ?, ?, ?, ?, ?)`,
          );
          let restoredCogs = 0;
          let writeoffCogs = 0;
          const reversalLotActions: Array<{
            saleLineId: string;
            lotId: string;
            quantity: number;
            treatment: "RESTOCK" | "WRITE_OFF";
          }> = [];
          for (const line of saleLines) {
            const decision = decisionByLine.get(line.id)!;
            const restock = decision.restock;
            const cogsRestored = restock ? line.allocated_cogs_centavos : 0;
            const lineWriteoff = restock ? 0 : line.allocated_cogs_centavos;
            const reversalLineId = randomUUID();
            insertLine.run(
              reversalLineId,
              reversalId,
              line.id,
              line.product_id,
              line.quantity,
              line.amount_due_centavos,
              restock ? "RESTOCK" : "WRITE_OFF",
              line.allocated_cogs_centavos,
              cogsRestored,
              lineWriteoff,
              createdAt,
            );
            const update = db
              .prepare(
                `UPDATE products SET quantity_on_hand = quantity_on_hand + ?,
                   inventory_value_centavos = inventory_value_centavos + ?, updated_at = ?
                 WHERE id = ? AND quantity_on_hand <= ? AND inventory_value_centavos <= ?`,
              )
              .run(
                line.quantity,
                line.allocated_cogs_centavos,
                createdAt,
                line.product_id,
                Number.MAX_SAFE_INTEGER - line.quantity,
                Number.MAX_SAFE_INTEGER - line.allocated_cogs_centavos,
              );
            if (update.changes !== 1)
              throw new ReversalError(409, "inventory_value_overflow");
            const reversalStockEventId = randomUUID();
            insertStockEvent.run(
              reversalStockEventId,
              line.product_id,
              line.quantity,
              line.allocated_cogs_centavos,
              reversalTransactionId,
              parsed.data.reason,
              req.user!.id,
              createdAt,
            );
            const originalLots =
              line.lot_tracked === 1
                ? (db
                    .prepare(
                      `SELECT lot_id, quantity, allocated_cogs_centavos
                       FROM sale_line_lot_allocations WHERE sale_line_id = ?`,
                    )
                    .all(line.id) as Array<{
                    lot_id: string;
                    quantity: number;
                    allocated_cogs_centavos: number;
                  }>)
                : [];
            if (line.lot_tracked === 1 && originalLots.length === 0)
              throw new ReversalError(409, "sale_lot_allocation_missing");
            reversalLotActions.push(
              ...originalLots.map((lot) => ({
                saleLineId: line.id,
                lotId: lot.lot_id,
                quantity: lot.quantity,
                treatment: restock
                  ? ("RESTOCK" as const)
                  : ("WRITE_OFF" as const),
              })),
            );
            if (originalLots.length) {
              for (const lot of originalLots) {
                writeLotMovement(db, {
                  productId: line.product_id,
                  lotId: lot.lot_id,
                  type: "REVERSAL",
                  stockEventId: reversalStockEventId,
                  reversalLineId,
                  quantityDelta: lot.quantity,
                  inventoryValueDeltaCentavos: lot.allocated_cogs_centavos,
                  actorUserId: req.user!.id,
                  createdAt,
                });
              }
            } else {
              writeLotMovement(db, {
                productId: line.product_id,
                lotId: null,
                type: "REVERSAL",
                stockEventId: reversalStockEventId,
                reversalLineId,
                quantityDelta: line.quantity,
                inventoryValueDeltaCentavos: line.allocated_cogs_centavos,
                actorUserId: req.user!.id,
                createdAt,
              });
            }
            if (restock) {
              restoredCogs += cogsRestored;
            } else {
              const writeoff = db
                .prepare(
                  `UPDATE products SET quantity_on_hand = quantity_on_hand - ?,
                     inventory_value_centavos = inventory_value_centavos - ?, updated_at = ?
                   WHERE id = ? AND quantity_on_hand >= ?
                     AND inventory_value_centavos >= ?`,
                )
                .run(
                  line.quantity,
                  lineWriteoff,
                  createdAt,
                  line.product_id,
                  line.quantity,
                  lineWriteoff,
                );
              if (writeoff.changes !== 1)
                throw new ReversalError(409, "reversal_writeoff_failed");
              const writeOffStockEventId = randomUUID();
              db.prepare(
                `INSERT INTO stock_events
                  (id, product_id, event_type, quantity_delta, unit_cost_centavos,
                   inventory_value_delta_centavos, reference, reason, actor_user_id, created_at)
                 VALUES (?, ?, 'WRITE_OFF', ?, NULL, ?, ?, ?, ?, ?)`,
              ).run(
                writeOffStockEventId,
                line.product_id,
                -line.quantity,
                -lineWriteoff,
                reversalTransactionId,
                parsed.data.reason,
                req.user!.id,
                createdAt,
              );
              if (originalLots.length) {
                for (const lot of originalLots) {
                  writeLotMovement(db, {
                    productId: line.product_id,
                    lotId: lot.lot_id,
                    type: "WRITE_OFF",
                    stockEventId: writeOffStockEventId,
                    reversalLineId,
                    quantityDelta: -lot.quantity,
                    inventoryValueDeltaCentavos: -lot.allocated_cogs_centavos,
                    actorUserId: req.user!.id,
                    createdAt,
                    reason: parsed.data.reason,
                  });
                }
              } else {
                writeLotMovement(db, {
                  productId: line.product_id,
                  lotId: null,
                  type: "WRITE_OFF",
                  stockEventId: writeOffStockEventId,
                  reversalLineId,
                  quantityDelta: -line.quantity,
                  inventoryValueDeltaCentavos: -lineWriteoff,
                  actorUserId: req.user!.id,
                  createdAt,
                  reason: parsed.data.reason,
                });
              }
              writeoffCogs += lineWriteoff;
            }
          }

          const bnpcUsage = db
            .prepare(
              `SELECT holder_key_hmac, week_start_date,
                      local_purchase_applied_centavos, bnpc_discount_centavos
               FROM sale_bnpc_snapshots WHERE sale_id = ?`,
            )
            .get(sale.id) as
            | {
                holder_key_hmac: string;
                week_start_date: string;
                local_purchase_applied_centavos: number;
                bnpc_discount_centavos: number;
              }
            | undefined;
          if (bnpcUsage) {
            db.prepare(
              `INSERT INTO bnpc_usage_events
               (id, holder_key_hmac, week_start_date, event_type, sale_id,
                reversal_id, qualifying_purchase_delta_centavos,
                bnpc_discount_delta_centavos, created_at)
               VALUES (?, ?, ?, 'REVERSAL', ?, ?, ?, ?, ?)`,
            ).run(
              randomUUID(),
              bnpcUsage.holder_key_hmac,
              bnpcUsage.week_start_date,
              sale.id,
              reversalId,
              -bnpcUsage.local_purchase_applied_centavos,
              -bnpcUsage.bnpc_discount_centavos,
              createdAt,
            );
          }

          if (cashShift && refundTotal > 0) {
            const expected = cashShift.expected_cash_centavos - refundTotal;
            db.prepare(
              "UPDATE shifts SET expected_cash_centavos = ? WHERE id = ? AND closed_at IS NULL",
            ).run(expected, cashShift.id);
            db.prepare(
              `INSERT INTO cash_movements
                 (id, shift_id, movement_type, amount_delta_centavos, reversal_id,
                  reason, actor_user_id, created_at)
               VALUES (?, ?, 'CASH_REFUND', ?, ?, ?, ?, ?)`,
            ).run(
              randomUUID(),
              cashShift.id,
              -refundTotal,
              reversalId,
              parsed.data.reason,
              req.user!.id,
              createdAt,
            );
          }

          writeAuditEvent(db, {
            actorUserId: req.user!.id,
            action: "sale.reversed",
            entityType: "sale_reversal",
            entityId: reversalId,
            details: {
              reversalTransactionId,
              originalTransactionId: transactionId.data,
              reason: parsed.data.reason,
              refundMethod: parsed.data.refundMethod,
              refundCentavos: refundTotal,
              restoredCogsCentavos: restoredCogs,
              writeoffCentavos: writeoffCogs,
              lineCount: saleLines.length,
              cashShiftId: cashShift?.id ?? null,
              lotActions: reversalLotActions,
            },
          });
          return { reversalId, reversalTransactionId, createdAt, refundTotal };
        })();

        const reversal = db
          .prepare(
            `SELECT r.id, r.reversal_transaction_id, r.sale_id, r.reason,
                    r.refund_method, r.amount_centavos, r.cash_shift_id,
                    r.cash_rounding_adjustment_centavos, r.created_at,
                    u.email AS approved_by_email
             FROM sale_reversals r JOIN users u ON u.id = r.approved_by_user_id
             WHERE r.id = ?`,
          )
          .get(result.reversalId) as {
          id: string;
          reversal_transaction_id: string;
          sale_id: string;
          reason: string;
          refund_method: "CASH" | "QR";
          amount_centavos: number;
          cash_shift_id: string | null;
          cash_rounding_adjustment_centavos: number;
          created_at: string;
          approved_by_email: string;
        };
        const lines = db
          .prepare(
            `SELECT rl.sale_line_id, rl.product_id, rl.quantity,
                    rl.refund_amount_centavos, rl.stock_treatment,
                    rl.original_cogs_centavos, rl.cogs_restored_centavos,
                    rl.writeoff_centavos, sl.product_name_snapshot, sl.sku_snapshot
             FROM sale_reversal_lines rl JOIN sale_lines sl ON sl.id = rl.sale_line_id
             WHERE rl.reversal_id = ? ORDER BY sl.line_number`,
          )
          .all(result.reversalId) as {
          sale_line_id: string;
          product_id: string;
          quantity: number;
          refund_amount_centavos: number;
          stock_treatment: "RESTOCK" | "WRITE_OFF";
          original_cogs_centavos: number;
          cogs_restored_centavos: number;
          writeoff_centavos: number;
          product_name_snapshot: string;
          sku_snapshot: string;
        }[];
        res.status(201).json({
          reversal: {
            id: reversal.id,
            transactionId: reversal.reversal_transaction_id,
            saleTransactionId: transactionId.data,
            reason: reversal.reason,
            refundMethod: reversal.refund_method,
            amount: money(reversal.amount_centavos),
            cashRoundingAdjustment: money(
              reversal.cash_rounding_adjustment_centavos,
            ),
            cashShiftId: reversal.cash_shift_id,
            approvedBy: reversal.approved_by_email,
            createdAt: reversal.created_at,
            lines: lines.map((line) => ({
              saleLineId: line.sale_line_id,
              productId: line.product_id,
              productName: line.product_name_snapshot,
              sku: line.sku_snapshot,
              quantity: line.quantity,
              refundAmount: money(line.refund_amount_centavos),
              stockTreatment: line.stock_treatment,
              originalCogs: money(line.original_cogs_centavos),
              cogsRestored: money(line.cogs_restored_centavos),
              writeoff: money(line.writeoff_centavos),
            })),
          },
          sale: getSavedSale(db, reversal.sale_id),
        });
      } catch (error) {
        if (!handleReversalError(error, res)) throw error;
      }
    },
  );
}
