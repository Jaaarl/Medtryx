import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type LotAllocation = { lotId: string; quantity: number };

export type LotBalance = {
  id: string;
  productId: string;
  lotCode: string;
  expiryDate: string;
  quarantined: boolean;
  quantity: number;
  saleableQuantity: number;
};

export function manilaCalendarDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

export function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export function getLotBalances(
  db: Database.Database,
  productId: string,
  asOf = manilaCalendarDate(),
): LotBalance[] {
  const rows = db
    .prepare(
      `SELECT l.id, l.product_id, l.lot_code, l.expiry_date, l.quarantined,
              coalesce(sum(m.quantity_delta), 0) AS quantity
       FROM inventory_lots l
       LEFT JOIN lot_stock_movements m ON m.lot_id = l.id
       WHERE l.product_id = ?
       GROUP BY l.id
       ORDER BY l.expiry_date, l.lot_code COLLATE NOCASE, l.id`,
    )
    .all(productId) as Array<{
    id: string;
    product_id: string;
    lot_code: string;
    expiry_date: string;
    quarantined: number;
    quantity: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    productId: row.product_id,
    lotCode: row.lot_code,
    expiryDate: row.expiry_date,
    quarantined: row.quarantined === 1,
    quantity: row.quantity,
    saleableQuantity:
      row.expiry_date >= asOf && row.quarantined === 0
        ? Math.max(0, row.quantity)
        : 0,
  }));
}

export function unallocatedBalance(
  db: Database.Database,
  productId: string,
): { quantity: number; valueCentavos: number } {
  const row = db
    .prepare(
      `SELECT coalesce(sum(quantity_delta), 0) AS quantity,
              coalesce(sum(inventory_value_delta_centavos), 0) AS value_centavos
       FROM lot_stock_movements WHERE product_id = ? AND lot_id IS NULL`,
    )
    .get(productId) as { quantity: number; value_centavos: number };
  return { quantity: row.quantity, valueCentavos: row.value_centavos };
}

export function allocateFefo(
  db: Database.Database,
  productId: string,
  quantity: number,
  reserved = new Map<string, number>(),
  asOf = manilaCalendarDate(),
): LotAllocation[] {
  let remaining = quantity;
  const allocations: LotAllocation[] = [];
  for (const lot of getLotBalances(db, productId, asOf)) {
    const available = Math.max(
      0,
      lot.saleableQuantity - (reserved.get(lot.id) ?? 0),
    );
    if (available === 0) continue;
    const take = Math.min(remaining, available);
    allocations.push({ lotId: lot.id, quantity: take });
    reserved.set(lot.id, (reserved.get(lot.id) ?? 0) + take);
    remaining -= take;
    if (remaining === 0) break;
  }
  return remaining === 0 ? allocations : [];
}

export function writeLotMovement(
  db: Database.Database,
  movement: {
    productId: string;
    lotId: string | null;
    type: string;
    stockEventId?: string | null;
    saleLineId?: string | null;
    reversalLineId?: string | null;
    reconciliationId?: string | null;
    quantityDelta: number;
    inventoryValueDeltaCentavos: number;
    unitCostCentavos?: number | null;
    reason?: string | null;
    actorUserId?: string | null;
    createdAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO lot_stock_movements
      (id, product_id, lot_id, movement_type, stock_event_id, sale_line_id,
       reversal_line_id, reconciliation_id, quantity_delta,
       inventory_value_delta_centavos, unit_cost_centavos, reason,
       actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    movement.productId,
    movement.lotId,
    movement.type,
    movement.stockEventId ?? null,
    movement.saleLineId ?? null,
    movement.reversalLineId ?? null,
    movement.reconciliationId ?? null,
    movement.quantityDelta,
    movement.inventoryValueDeltaCentavos,
    movement.unitCostCentavos ?? null,
    movement.reason ?? null,
    movement.actorUserId ?? null,
    movement.createdAt,
  );
}

export function lotLedgerIssues(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.quantity_on_hand, p.inventory_value_centavos,
              coalesce((SELECT sum(m.quantity_delta) FROM lot_stock_movements m WHERE m.product_id = p.id), 0) AS lot_quantity,
              coalesce((SELECT sum(m.inventory_value_delta_centavos) FROM lot_stock_movements m WHERE m.product_id = p.id), 0) AS lot_value,
              coalesce((SELECT sum(e.quantity_delta) FROM stock_events e WHERE e.product_id = p.id), 0) AS event_quantity,
              coalesce((SELECT sum(e.inventory_value_delta_centavos) FROM stock_events e WHERE e.product_id = p.id), 0) AS event_value
       FROM products p`,
    )
    .all() as Array<{
    id: string;
    quantity_on_hand: number;
    inventory_value_centavos: number;
    lot_quantity: number;
    lot_value: number;
    event_quantity: number;
    event_value: number;
  }>;
  const issues = new Set(
    rows
      .filter(
        (row) =>
          row.quantity_on_hand !== row.lot_quantity ||
          row.inventory_value_centavos !== row.lot_value ||
          row.quantity_on_hand !== row.event_quantity ||
          row.inventory_value_centavos !== row.event_value,
      )
      .map((row) => row.id),
  );
  const negativeBalances = db
    .prepare(
      `SELECT product_id FROM inventory_lots l
       WHERE coalesce((
         SELECT sum(m.quantity_delta) FROM lot_stock_movements m
         WHERE m.lot_id = l.id
       ), 0) < 0
       UNION
       SELECT product_id FROM lot_stock_movements m
       WHERE lot_id IS NULL GROUP BY product_id
       HAVING sum(quantity_delta) < 0`,
    )
    .all() as Array<{ product_id: string }>;
  for (const row of negativeBalances) issues.add(row.product_id);
  return [...issues];
}
