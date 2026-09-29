import { Decimal } from "decimal.js";
import type Database from "better-sqlite3";
import express from "express";
import { z } from "zod";
import { requireAuthentication, requireRole } from "./auth.js";
import { getLotBalances, manilaCalendarDate } from "./lot-stock.js";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  });

type SaleLineRow = {
  quantity: number;
  unit_price_centavos: number;
  tax_class_snapshot: "VATABLE" | "VAT_EXEMPT" | "ZERO_RATED";
  benefit_applied: number;
  benefit_type: "REGULAR" | "SENIOR_CITIZEN" | "PWD";
  tax_basis_centavos: number;
  vat_centavos: number;
  vat_removed_centavos: number;
  discount_centavos: number;
  amount_due_centavos: number;
  allocated_cogs_centavos: number;
};

type ReversalLineRow = SaleLineRow & {
  refund_amount_centavos: number;
  original_cogs_centavos: number;
};

function todayInManila(now = new Date()): string {
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

function utcWindowForManilaRange(
  startDay: string,
  endDay: string,
): { start: string; end: string } {
  const start = new Date(`${startDay}T00:00:00+08:00`);
  const end = new Date(`${endDay}T00:00:00+08:00`);
  end.setTime(end.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function money(cents: bigint): string {
  return new Decimal(cents.toString()).div(100).toFixed(2);
}

function add(
  target: Record<string, bigint>,
  key: string,
  amount: bigint,
): void {
  target[key] = (target[key] ?? 0n) + amount;
}

export function safeCsvCell(value: string | number): string {
  let normalized = String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(normalized))
    normalized = `'${normalized}`;
  return `"${normalized.replaceAll('"', '""')}"`;
}

function reportRows(db: Database.Database, startDay: string, endDay: string) {
  const window = utcWindowForManilaRange(startDay, endDay);
  const totals: Record<string, bigint> = {};
  const sales = db
    .prepare(
      `SELECT payment_method, amount_due_centavos,
              cash_rounding_adjustment_centavos FROM sales
       WHERE business_date >= ? AND business_date <= ?`,
    )
    .all(startDay, endDay) as {
    payment_method: "CASH" | "QR";
    amount_due_centavos: number;
    cash_rounding_adjustment_centavos: number;
  }[];
  for (const sale of sales) {
    add(
      totals,
      sale.payment_method === "CASH" ? "cashSales" : "qrSales",
      BigInt(sale.amount_due_centavos),
    );
    add(
      totals,
      "cashRoundingAdjustments",
      BigInt(sale.cash_rounding_adjustment_centavos),
    );
  }

  const saleLines = db
    .prepare(
      `SELECT sl.quantity, sl.unit_price_centavos, sl.tax_class_snapshot,
              sl.benefit_applied, s.benefit_type, sl.tax_basis_centavos,
              sl.vat_centavos, sl.vat_removed_centavos, sl.discount_centavos,
              sl.amount_due_centavos, sl.allocated_cogs_centavos
       FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
       WHERE s.business_date >= ? AND s.business_date <= ?`,
    )
    .all(startDay, endDay) as SaleLineRow[];
  for (const line of saleLines) {
    const gross = BigInt(line.quantity) * BigInt(line.unit_price_centavos);
    add(totals, "grossSales", gross);
    add(
      totals,
      "netSalesExcludingVat",
      BigInt(line.amount_due_centavos - line.vat_centavos),
    );
    if (line.tax_class_snapshot === "VATABLE") {
      add(totals, "vatableSalesBase", BigInt(line.tax_basis_centavos));
    } else if (line.tax_class_snapshot === "VAT_EXEMPT") {
      add(totals, "vatExemptSales", BigInt(line.amount_due_centavos));
    } else {
      add(totals, "zeroRatedSales", BigInt(line.amount_due_centavos));
    }
    add(totals, "vatOutput", BigInt(line.vat_centavos));
    add(totals, "vatRemoved", BigInt(line.vat_removed_centavos));
    add(totals, "cogs", BigInt(line.allocated_cogs_centavos));
    if (line.benefit_applied === 1) {
      if (line.benefit_type === "SENIOR_CITIZEN") {
        add(totals, "seniorDiscounts", BigInt(line.discount_centavos));
      } else if (line.benefit_type === "PWD") {
        add(totals, "pwdDiscounts", BigInt(line.discount_centavos));
      }
    }
  }

  const reversalRows = db
    .prepare(
      `SELECT r.refund_method, r.amount_centavos,
              r.cash_rounding_adjustment_centavos
       FROM sale_reversals r
       WHERE r.created_at >= ? AND r.created_at < ?`,
    )
    .all(window.start, window.end) as {
    refund_method: "CASH" | "QR";
    amount_centavos: number;
    cash_rounding_adjustment_centavos: number;
  }[];
  for (const reversal of reversalRows) {
    add(
      totals,
      reversal.refund_method === "CASH" ? "cashRefunds" : "qrRefunds",
      BigInt(reversal.amount_centavos),
    );
    add(
      totals,
      "cashRoundingAdjustments",
      -BigInt(reversal.cash_rounding_adjustment_centavos),
    );
  }

  const reversalLines = db
    .prepare(
      `SELECT sl.quantity, sl.unit_price_centavos, sl.tax_class_snapshot,
              sl.benefit_applied, s.benefit_type, sl.tax_basis_centavos,
              sl.vat_centavos, sl.vat_removed_centavos, sl.discount_centavos,
              sl.amount_due_centavos, sl.allocated_cogs_centavos,
              rl.refund_amount_centavos, rl.original_cogs_centavos
       FROM sale_reversal_lines rl
       JOIN sale_reversals r ON r.id = rl.reversal_id
       JOIN sale_lines sl ON sl.id = rl.sale_line_id
       JOIN sales s ON s.id = sl.sale_id
       WHERE r.created_at >= ? AND r.created_at < ?`,
    )
    .all(window.start, window.end) as ReversalLineRow[];
  for (const line of reversalLines) {
    const gross = BigInt(line.quantity) * BigInt(line.unit_price_centavos);
    add(totals, "grossSales", -gross);
    add(
      totals,
      "netSalesExcludingVat",
      -BigInt(line.refund_amount_centavos - line.vat_centavos),
    );
    if (line.tax_class_snapshot === "VATABLE") {
      add(totals, "vatableSalesBase", -BigInt(line.tax_basis_centavos));
    } else if (line.tax_class_snapshot === "VAT_EXEMPT") {
      add(totals, "vatExemptSales", -BigInt(line.refund_amount_centavos));
    } else {
      add(totals, "zeroRatedSales", -BigInt(line.refund_amount_centavos));
    }
    add(totals, "vatOutput", -BigInt(line.vat_centavos));
    add(totals, "vatRemoved", -BigInt(line.vat_removed_centavos));
    add(totals, "cogs", -BigInt(line.original_cogs_centavos));
    if (line.benefit_applied === 1) {
      if (line.benefit_type === "SENIOR_CITIZEN") {
        add(totals, "seniorDiscounts", -BigInt(line.discount_centavos));
      } else if (line.benefit_type === "PWD") {
        add(totals, "pwdDiscounts", -BigInt(line.discount_centavos));
      }
    }
  }

  const cashRows = db
    .prepare(
      `SELECT movement_type, amount_delta_centavos FROM cash_movements
       WHERE created_at >= ? AND created_at < ?`,
    )
    .all(window.start, window.end) as {
    movement_type: "CASH_IN" | "CASH_OUT" | "CASH_REFUND";
    amount_delta_centavos: number;
  }[];
  for (const movement of cashRows) {
    if (movement.movement_type === "CASH_IN") {
      add(totals, "cashIn", BigInt(movement.amount_delta_centavos));
    } else if (movement.movement_type === "CASH_OUT") {
      add(totals, "cashOut", -BigInt(movement.amount_delta_centavos));
    }
  }

  const writeoffRows = db
    .prepare(
      `SELECT inventory_value_delta_centavos FROM stock_events
       WHERE event_type = 'WRITE_OFF' AND created_at >= ? AND created_at < ?`,
    )
    .all(window.start, window.end) as {
    inventory_value_delta_centavos: number;
  }[];
  for (const event of writeoffRows) {
    add(totals, "writeOffValue", -BigInt(event.inventory_value_delta_centavos));
  }

  const productRows = db
    .prepare(
      `SELECT id, sku, name, unit, tracks_lots, quantity_on_hand, reorder_level,
              inventory_value_centavos, is_active
       FROM products ORDER BY name COLLATE NOCASE`,
    )
    .all() as {
    id: string;
    sku: string;
    name: string;
    unit: string;
    tracks_lots: number;
    quantity_on_hand: number;
    reorder_level: number | null;
    inventory_value_centavos: number;
    is_active: number;
  }[];
  const activeProducts = productRows.filter(
    (product) => product.is_active === 1,
  );
  const lowStock = activeProducts.filter(
    (product) =>
      product.reorder_level !== null &&
      product.quantity_on_hand <= product.reorder_level,
  );
  const inventoryValue = productRows.reduce(
    (sum, product) => sum + BigInt(product.inventory_value_centavos),
    0n,
  );
  const asOf = manilaCalendarDate();
  const warningSetting = db
    .prepare("SELECT value_json FROM settings WHERE key = 'inventory_expiry'")
    .get() as { value_json: string } | undefined;
  let warningDays = 30;
  if (warningSetting) {
    try {
      const configured = JSON.parse(warningSetting.value_json) as {
        warningDays?: unknown;
      };
      if (
        typeof configured.warningDays === "number" &&
        Number.isInteger(configured.warningDays) &&
        configured.warningDays >= 0 &&
        configured.warningDays <= 365
      )
        warningDays = configured.warningDays;
    } catch {
      warningDays = 30;
    }
  }
  const warningEnd = new Date(`${asOf}T00:00:00.000Z`);
  warningEnd.setUTCDate(warningEnd.getUTCDate() + warningDays);
  const warningEndDay = warningEnd.toISOString().slice(0, 10);
  const trackedLots = productRows
    .filter((product) => product.tracks_lots === 1)
    .flatMap((product) =>
      getLotBalances(db, product.id, asOf).map((lot) => ({
        sku: product.sku,
        productName: product.name,
        lotCode: lot.lotCode,
        expiryDate: lot.expiryDate,
        physicalQuantity: lot.quantity,
        saleableQuantity: lot.saleableQuantity,
        quarantined: lot.quarantined,
        alert:
          lot.quantity <= 0
            ? null
            : lot.expiryDate < asOf
              ? "EXPIRED"
              : lot.expiryDate <= warningEndDay
                ? "NEAR_EXPIRY"
                : null,
      })),
    );
  const unallocatedTrackedStock = productRows
    .filter((product) => product.tracks_lots === 1)
    .map((product) => {
      const row = db
        .prepare(
          `SELECT coalesce(sum(quantity_delta), 0) AS quantity
           FROM lot_stock_movements WHERE product_id = ? AND lot_id IS NULL`,
        )
        .get(product.id) as { quantity: number };
      return { sku: product.sku, name: product.name, quantity: row.quantity };
    })
    .filter((product) => product.quantity !== 0);
  const lotWriteOffRows = db
    .prepare(
      `SELECT coalesce(sum(-quantity_delta), 0) AS quantity
       FROM lot_stock_movements WHERE lot_id IS NOT NULL
         AND movement_type = 'WRITE_OFF' AND quantity_delta < 0
         AND created_at >= ? AND created_at < ?`,
    )
    .get(window.start, window.end) as { quantity: number };
  const reversalCount = reversalRows.length;
  const total = (key: string) => money(totals[key] ?? 0n);
  const estimatedGrossProfit =
    (totals.netSalesExcludingVat ?? 0n) - (totals.cogs ?? 0n);
  return {
    businessDate: startDay === endDay ? startDay : `${startDay} to ${endDay}`,
    startDate: startDay,
    endDate: endDay,
    timeZone: "Asia/Manila",
    generatedAt: new Date().toISOString(),
    metrics: {
      grossSales: total("grossSales"),
      netSalesExcludingVat: total("netSalesExcludingVat"),
      vatableSalesBase: total("vatableSalesBase"),
      vatExemptSales: total("vatExemptSales"),
      zeroRatedSales: total("zeroRatedSales"),
      vatOutput: total("vatOutput"),
      vatRemoved: total("vatRemoved"),
      seniorDiscounts: total("seniorDiscounts"),
      pwdDiscounts: total("pwdDiscounts"),
      cashSales: total("cashSales"),
      qrSales: total("qrSales"),
      cashRoundingAdjustments: total("cashRoundingAdjustments"),
      cashRefunds: total("cashRefunds"),
      qrRefunds: total("qrRefunds"),
      cashIn: total("cashIn"),
      cashOut: total("cashOut"),
      cogs: total("cogs"),
      writeOffValue: total("writeOffValue"),
      lotWriteOffQuantity: String(lotWriteOffRows.quantity),
      netCashImpact: money(
        (totals.cashSales ?? 0n) -
          (totals.cashRefunds ?? 0n) +
          (totals.cashIn ?? 0n) -
          (totals.cashOut ?? 0n),
      ),
      estimatedGrossProfit: money(estimatedGrossProfit),
    },
    reversalCount,
    inventory: {
      activeProductCount: activeProducts.length,
      lowStockCount: lowStock.length,
      inventoryValue: money(inventoryValue),
      lowStock: lowStock.map((product) => ({
        sku: product.sku,
        name: product.name,
        unit: product.unit,
        quantityOnHand: product.quantity_on_hand,
        reorderLevel: product.reorder_level,
        inventoryValue: money(BigInt(product.inventory_value_centavos)),
      })),
      asOf,
      expiryWarningDays: warningDays,
      trackedLots,
      unallocatedTrackedStock,
      expiredLotCount: trackedLots.filter((lot) => lot.alert === "EXPIRED")
        .length,
      nearExpiryLotCount: trackedLots.filter(
        (lot) => lot.alert === "NEAR_EXPIRY",
      ).length,
    },
    notes: [
      "Net sales exclude output VAT and subtract line discounts and full reversals recorded during the selected Manila business-date range.",
      "COGS follows saved sale-line acquisition-cost allocations; full reversals offset the original saved COGS on their recorded date.",
      "Estimated gross profit excludes separate stock write-offs and operating expenses.",
      "Cash and QR are staff-declared settlement methods, not payment verification.",
      "Cash rounding adjustments are reported separately and do not change saved line tax, net-sales, or estimated gross-profit figures.",
      "Inventory value and low-stock counts show current balances, not historical end-of-day balances.",
      "Lot balances and expiry alerts are current Manila-date balances; unallocated legacy units are excluded from saleable stock until physically reconciled.",
    ],
  };
}

function csvForReport(report: ReturnType<typeof reportRows>): string {
  const rows: Array<[string, string, string | number]> = [
    ["Report", "Manila business dates", report.businessDate],
    ["Sales", "Gross sales", report.metrics.grossSales],
    ["Sales", "Net sales excluding VAT", report.metrics.netSalesExcludingVat],
    ["Tax", "VATable sales base", report.metrics.vatableSalesBase],
    ["Tax", "VAT-exempt sales", report.metrics.vatExemptSales],
    ["Tax", "Zero-rated sales", report.metrics.zeroRatedSales],
    ["Tax", "Output VAT", report.metrics.vatOutput],
    ["Tax", "VAT removed for benefits", report.metrics.vatRemoved],
    ["Discounts", "Senior citizen", report.metrics.seniorDiscounts],
    ["Discounts", "PWD", report.metrics.pwdDiscounts],
    ["Payments", "Cash declared sales", report.metrics.cashSales],
    ["Payments", "QR declared sales", report.metrics.qrSales],
    [
      "Payments",
      "Cash rounding adjustments (net of reversals)",
      report.metrics.cashRoundingAdjustments,
    ],
    ["Payments", "Cash refunds", report.metrics.cashRefunds],
    ["Payments", "QR refunds", report.metrics.qrRefunds],
    ["Payments", "Cash-in", report.metrics.cashIn],
    ["Payments", "Cash-out", report.metrics.cashOut],
    ["Inventory", "COGS", report.metrics.cogs],
    ["Inventory", "Write-off value", report.metrics.writeOffValue],
    ["Inventory", "Lot disposal quantity", report.metrics.lotWriteOffQuantity],
    ["Profit", "Estimated gross profit", report.metrics.estimatedGrossProfit],
    ["Inventory", "Current inventory value", report.inventory.inventoryValue],
    [
      "Inventory",
      "Current low-stock product count",
      report.inventory.lowStockCount,
    ],
    [
      "Inventory",
      "Expired lot count (current)",
      report.inventory.expiredLotCount,
    ],
    [
      "Inventory",
      "Near-expiry lot count (current)",
      report.inventory.nearExpiryLotCount,
    ],
    ["Sales", "Full reversal count", report.reversalCount],
  ];
  for (const product of report.inventory.lowStock) {
    rows.push([
      "Low stock",
      `${product.sku} ${product.name} (${product.unit})`,
      `${product.quantityOnHand} / reorder ${product.reorderLevel}`,
    ]);
  }
  for (const lot of report.inventory.trackedLots) {
    rows.push([
      "Lot balance",
      `${lot.sku} ${lot.productName} batch ${lot.lotCode} exp ${lot.expiryDate}`,
      `physical ${lot.physicalQuantity} / saleable ${lot.saleableQuantity} / ${lot.alert ?? (lot.quarantined ? "QUARANTINED" : "OK")}`,
    ]);
  }
  for (const product of report.inventory.unallocatedTrackedStock) {
    rows.push([
      "Unallocated tracked stock",
      `${product.sku} ${product.name}`,
      product.quantity,
    ]);
  }
  return [["Section", "Metric", "Value"], ...rows]
    .map((row) => row.map(safeCsvCell).join(","))
    .join("\r\n");
}

export function registerReportRoutes(
  router: express.Router,
  db: Database.Database,
): void {
  const requireAuth = requireAuthentication(db);
  const requireOwner = requireRole("owner");
  const readDate = (value: unknown) => {
    const parsed =
      value === undefined
        ? { success: true as const, data: todayInManila() }
        : dateSchema.safeParse(value);
    return parsed;
  };
  const readRange = (startValue: unknown, endValue: unknown) => {
    const start = dateSchema.safeParse(startValue);
    const end = dateSchema.safeParse(endValue);
    if (!start.success || !end.success || start.data > end.data) return null;
    return { start: start.data, end: end.data };
  };

  router.get("/reports/range", requireAuth, requireOwner, (req, res) => {
    const range = readRange(req.query.startDate, req.query.endDate);
    if (!range) {
      res.status(400).json({ error: "invalid_report_range" });
      return;
    }
    res.json({ report: reportRows(db, range.start, range.end) });
  });

  router.get("/reports/range.csv", requireAuth, requireOwner, (req, res) => {
    const range = readRange(req.query.startDate, req.query.endDate);
    if (!range) {
      res.status(400).json({ error: "invalid_report_range" });
      return;
    }
    const report = reportRows(db, range.start, range.end);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="medtryx-report-${range.start}-to-${range.end}.csv"`,
    );
    res.send(csvForReport(report));
  });

  router.get("/reports/daily", requireAuth, requireOwner, (req, res) => {
    const day = readDate(req.query.date);
    if (!day.success) {
      res.status(400).json({ error: "invalid_report_date" });
      return;
    }
    res.json({ report: reportRows(db, day.data, day.data) });
  });

  router.get("/reports/daily.csv", requireAuth, requireOwner, (req, res) => {
    const day = readDate(req.query.date);
    if (!day.success) {
      res.status(400).json({ error: "invalid_report_date" });
      return;
    }
    const report = reportRows(db, day.data, day.data);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="medtryx-daily-${day.data}.csv"`,
    );
    res.send(csvForReport(report));
  });
}
