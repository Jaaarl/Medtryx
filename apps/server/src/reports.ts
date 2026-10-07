import { Decimal } from "decimal.js";
import type Database from "better-sqlite3";
import express from "express";
import { z } from "zod";
import { requireAuthentication, requireRole } from "./auth.js";
import { decryptCustomerField, CustomerDataError } from "./customer-data.js";
import { writeAuditEvent } from "./db.js";
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
  benefit_treatment_snapshot: "REGULAR" | "SENIOR_CITIZEN" | "PWD" | "BNPC";
  benefit_type: "REGULAR" | "SENIOR_CITIZEN" | "PWD";
  tax_basis_centavos: number;
  vat_centavos: number;
  vat_removed_centavos: number;
  discount_centavos: number;
  bnpc_discount_centavos: number;
  bundle_promotion_discount_centavos: number;
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

type ProductMovementDbRow = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  quantity_on_hand: number;
  units_sold: number;
  units_returned: number;
  transaction_count: number;
  last_sold_at: string | null;
};

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
              sl.benefit_applied, sl.benefit_treatment_snapshot,
              s.benefit_type, sl.tax_basis_centavos,
              sl.vat_centavos, sl.vat_removed_centavos, sl.discount_centavos,
              sl.bnpc_discount_centavos,
              sl.bundle_promotion_discount_centavos,
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
    add(
      totals,
      "bundlePromotionalDiscounts",
      BigInt(line.bundle_promotion_discount_centavos),
    );
    if (line.benefit_treatment_snapshot === "SENIOR_CITIZEN") {
      add(totals, "seniorDiscounts", BigInt(line.discount_centavos));
    } else if (line.benefit_treatment_snapshot === "PWD") {
      add(totals, "pwdDiscounts", BigInt(line.discount_centavos));
    }
    add(totals, "bnpcDiscounts", BigInt(line.bnpc_discount_centavos));
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
              sl.benefit_applied, sl.benefit_treatment_snapshot,
              s.benefit_type, sl.tax_basis_centavos,
              sl.vat_centavos, sl.vat_removed_centavos, sl.discount_centavos,
              sl.bnpc_discount_centavos,
              sl.bundle_promotion_discount_centavos,
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
    add(
      totals,
      "bundlePromotionalDiscounts",
      -BigInt(line.bundle_promotion_discount_centavos),
    );
    if (line.benefit_treatment_snapshot === "SENIOR_CITIZEN") {
      add(totals, "seniorDiscounts", -BigInt(line.discount_centavos));
    } else if (line.benefit_treatment_snapshot === "PWD") {
      add(totals, "pwdDiscounts", -BigInt(line.discount_centavos));
    }
    add(totals, "bnpcDiscounts", -BigInt(line.bnpc_discount_centavos));
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

  const transactionChangeRows = db
    .prepare(
      `SELECT s.transaction_id, p.created_at AS changed_at, p.reason,
              u.email AS actor_email, u.role AS actor_role,
              'PAYMENT_SWITCH' AS kind,
              p.from_method, p.to_method, p.cash_amount_centavos,
              p.qr_amount_centavos, NULL AS refund_method,
              NULL AS refund_amount_centavos
       FROM sale_payment_switches p
       JOIN sales s ON s.id = p.sale_id
       JOIN users u ON u.id = p.changed_by_user_id
       WHERE p.created_at >= ? AND p.created_at < ?
       UNION ALL
       SELECT s.transaction_id, r.created_at AS changed_at, r.reason,
              u.email AS actor_email, u.role AS actor_role,
              CASE WHEN a.action = 'sale.cancelled'
                   THEN 'CANCELLATION' ELSE 'REVERSAL' END AS kind,
              NULL AS from_method, NULL AS to_method,
              NULL AS cash_amount_centavos, NULL AS qr_amount_centavos,
              r.refund_method, r.amount_centavos AS refund_amount_centavos
       FROM sale_reversals r
       JOIN sales s ON s.id = r.sale_id
       JOIN users u ON u.id = r.approved_by_user_id
       LEFT JOIN audit_events a ON a.entity_type = 'sale_reversal'
         AND a.entity_id = r.id
         AND a.action IN ('sale.cancelled', 'sale.reversed')
       WHERE r.created_at >= ? AND r.created_at < ?
       ORDER BY changed_at, transaction_id`,
    )
    .all(window.start, window.end, window.start, window.end) as Array<{
    transaction_id: string;
    changed_at: string;
    reason: string;
    actor_email: string;
    actor_role: "owner" | "cashier";
    kind: "PAYMENT_SWITCH" | "CANCELLATION" | "REVERSAL";
    from_method: "CASH" | "QR" | null;
    to_method: "CASH" | "QR" | null;
    cash_amount_centavos: number | null;
    qr_amount_centavos: number | null;
    refund_method: "CASH" | "QR" | null;
    refund_amount_centavos: number | null;
  }>;

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
  const bundlePromotionRows = db
    .prepare(
      `SELECT b.code_snapshot, b.name_snapshot, b.version_snapshot,
              b.quantity, b.regular_total_centavos,
              b.promotional_price_per_bundle_centavos,
              b.promotional_discount_offered_centavos,
              b.promotional_discount_applied_centavos
       FROM sale_bundle_snapshots b JOIN sales s ON s.id = b.sale_id
       WHERE s.business_date >= ? AND s.business_date <= ?
       ORDER BY s.created_at, b.code_snapshot`,
    )
    .all(startDay, endDay) as Array<{
    code_snapshot: string;
    name_snapshot: string;
    version_snapshot: number;
    quantity: number;
    regular_total_centavos: number;
    promotional_price_per_bundle_centavos: number;
    promotional_discount_offered_centavos: number;
    promotional_discount_applied_centavos: number;
  }>;
  const reversalCount = reversalRows.length;
  const bnpcSales = db
    .prepare(
      `SELECT s.transaction_id, s.benefit_type, p.version AS policy_version,
              p.effective_from, p.source_title, b.week_start_date,
              b.local_purchase_applied_centavos,
              b.bnpc_discount_centavos,
              b.verified_purchase_allowance_centavos,
              b.verified_discount_allowance_centavos,
              b.external_purchase_attested_centavos,
              b.external_discount_attested_centavos,
              SUM(sl.tax_basis_centavos) AS tax_basis_centavos,
              SUM(sl.vat_centavos) AS vat_centavos,
              SUM(sl.vat_removed_centavos) AS vat_removed_centavos
       FROM sale_bnpc_snapshots b
       JOIN sales s ON s.id = b.sale_id
       JOIN bnpc_policy_versions p ON p.id = b.bnpc_policy_version_id
       JOIN sale_lines sl ON sl.sale_id = s.id AND sl.bnpc_policy_version = p.id
       WHERE s.business_date >= ? AND s.business_date <= ?
       GROUP BY s.id ORDER BY s.created_at, s.transaction_id`,
    )
    .all(startDay, endDay) as Array<{
    transaction_id: string;
    benefit_type: "SENIOR_CITIZEN" | "PWD";
    policy_version: string;
    effective_from: string;
    source_title: string;
    week_start_date: string;
    local_purchase_applied_centavos: number;
    bnpc_discount_centavos: number;
    verified_purchase_allowance_centavos: number;
    verified_discount_allowance_centavos: number;
    external_purchase_attested_centavos: number;
    external_discount_attested_centavos: number;
    tax_basis_centavos: number;
    vat_centavos: number;
    vat_removed_centavos: number;
  }>;
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
      bnpcDiscounts: total("bnpcDiscounts"),
      bundlePromotionalDiscounts: total("bundlePromotionalDiscounts"),
      cashSales: total("cashSales"),
      qrSales: total("qrSales"),
      cashRoundingAdjustments: total("cashRoundingAdjustments"),
      qrRoundingAdjustments: total("qrRoundingAdjustments"),
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
    transactionChanges: transactionChangeRows.map((change) => ({
      transactionId: change.transaction_id,
      changedAt: change.changed_at,
      changedByEmail: change.actor_email,
      changedByRole: change.actor_role,
      kind: change.kind,
      reason: change.reason,
      payment:
        change.from_method &&
        change.to_method &&
        change.cash_amount_centavos !== null &&
        change.qr_amount_centavos !== null
          ? {
              fromMethod: change.from_method,
              toMethod: change.to_method,
              cashAmount: money(BigInt(change.cash_amount_centavos)),
              qrAmount: money(BigInt(change.qr_amount_centavos)),
            }
          : null,
      refund:
        change.refund_method && change.refund_amount_centavos !== null
          ? {
              method: change.refund_method,
              amount: money(BigInt(change.refund_amount_centavos)),
            }
          : null,
    })),
    bundlePromotions: bundlePromotionRows.map((bundle) => ({
      code: bundle.code_snapshot,
      name: bundle.name_snapshot,
      version: bundle.version_snapshot,
      quantity: bundle.quantity,
      regularTotal: money(
        BigInt(bundle.regular_total_centavos) * BigInt(bundle.quantity),
      ),
      promotionalPricePerBundle: money(
        BigInt(bundle.promotional_price_per_bundle_centavos),
      ),
      promotionalDiscountOffered: money(
        BigInt(bundle.promotional_discount_offered_centavos),
      ),
      promotionalDiscountApplied: money(
        BigInt(bundle.promotional_discount_applied_centavos),
      ),
    })),
    bnpcSales: bnpcSales.map((sale) => ({
      transactionId: sale.transaction_id,
      holderType: sale.benefit_type,
      policyVersion: sale.policy_version,
      effectiveFrom: sale.effective_from,
      sourceTitle: sale.source_title,
      weekStartDate: sale.week_start_date,
      localPurchaseApplied: money(BigInt(sale.local_purchase_applied_centavos)),
      discount: money(BigInt(sale.bnpc_discount_centavos)),
      verifiedPurchaseAllowance: money(
        BigInt(sale.verified_purchase_allowance_centavos),
      ),
      verifiedDiscountAllowance: money(
        BigInt(sale.verified_discount_allowance_centavos),
      ),
      externalPurchaseAttested: money(
        BigInt(sale.external_purchase_attested_centavos),
      ),
      externalDiscountAttested: money(
        BigInt(sale.external_discount_attested_centavos),
      ),
      taxBasis: money(BigInt(sale.tax_basis_centavos)),
      vat: money(BigInt(sale.vat_centavos)),
      vatRemoved: money(BigInt(sale.vat_removed_centavos)),
      localStoreOnly: true,
    })),
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
      "Net sales exclude output VAT and include statutory and bundle promotional discounts; full reversals are recorded on their reversal date.",
      "COGS follows saved sale-line acquisition-cost allocations; full reversals offset the original saved COGS on their recorded date.",
      "Estimated gross profit excludes separate stock write-offs and operating expenses.",
      "Cash and QR sales show staff-declared payments before refunds. Cancellations and reversals appear in separate cash or QR refund totals on their recorded reversal date; compare sales and refunds for the selected date range to understand net collections.",
      "Cash rounding adjustments are reported separately and do not change saved line tax, net-sales, or estimated gross-profit figures.",
      "Only cash totals use configured payment rounding; QR payments use the saved line total, so QR rounding adjustments remain 0.00.",
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
    [
      "Discounts",
      "BNPC 5% (net of full reversals)",
      report.metrics.bnpcDiscounts,
    ],
    [
      "Discounts",
      "Bundle promotional discounts (net of reversals)",
      report.metrics.bundlePromotionalDiscounts,
    ],
    ["Payments", "Cash sales before refunds", report.metrics.cashSales],
    ["Payments", "QR sales before refunds", report.metrics.qrSales],
    [
      "Payments",
      "Cash rounding adjustments (net of reversals)",
      report.metrics.cashRoundingAdjustments,
    ],
    [
      "Payments",
      "QR rounding adjustments (net of reversals)",
      report.metrics.qrRoundingAdjustments,
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
  for (const bundle of report.bundlePromotions) {
    rows.push([
      "Bundle offer",
      `${bundle.code} ${bundle.name} v${bundle.version} x${bundle.quantity}`,
      `regular ${bundle.regularTotal} / advertised ${bundle.promotionalPricePerBundle} each / offered discount ${bundle.promotionalDiscountOffered} / applied discount ${bundle.promotionalDiscountApplied}`,
    ]);
  }
  for (const change of report.transactionChanges) {
    const detail = change.payment
      ? `cash ${change.payment.cashAmount} / QR ${change.payment.qrAmount}`
      : change.refund
        ? `${change.refund.method} refund ${change.refund.amount}`
        : "";
    rows.push([
      "Transaction change",
      `${change.transactionId} ${change.kind}`,
      `${change.changedAt} / ${change.changedByEmail} (${change.changedByRole}) / ${change.reason}${detail ? ` / ${detail}` : ""}`,
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

  router.get(
    "/reports/product-movement",
    requireAuth,
    requireOwner,
    (req, res) => {
      const range = readRange(req.query.startDate, req.query.endDate);
      if (!range) {
        res.status(400).json({ error: "invalid_report_range" });
        return;
      }

      const window = utcWindowForManilaRange(range.start, range.end);
      const periodDays =
        Math.floor(
          (Date.parse(`${range.end}T00:00:00.000Z`) -
            Date.parse(`${range.start}T00:00:00.000Z`)) /
            (24 * 60 * 60 * 1000),
        ) + 1;
      const rows = db
        .prepare(
          `SELECT p.id, p.sku, p.name, p.unit, p.quantity_on_hand,
                  COALESCE(s.units_sold, 0) AS units_sold,
                  COALESCE(r.units_returned, 0) AS units_returned,
                  COALESCE(s.transaction_count, 0) AS transaction_count,
                  s.last_sold_at
           FROM products p
           LEFT JOIN (
             SELECT sl.product_id,
                    SUM(CASE WHEN s.created_at >= ? AND s.created_at < ?
                             THEN sl.quantity ELSE 0 END) AS units_sold,
                    COUNT(DISTINCT CASE WHEN s.created_at >= ? AND s.created_at < ?
                                        THEN s.id END) AS transaction_count,
                    MAX(s.created_at) AS last_sold_at
             FROM sale_lines sl
             JOIN sales s ON s.id = sl.sale_id
             GROUP BY sl.product_id
           ) s ON s.product_id = p.id
           LEFT JOIN (
             SELECT rl.product_id,
                    SUM(CASE WHEN r.created_at >= ? AND r.created_at < ?
                             THEN rl.quantity ELSE 0 END) AS units_returned
             FROM sale_reversal_lines rl
             JOIN sale_reversals r ON r.id = rl.reversal_id
             GROUP BY rl.product_id
           ) r ON r.product_id = p.id
           WHERE p.is_active = 1
           ORDER BY p.name COLLATE NOCASE, p.sku COLLATE NOCASE`,
        )
        .all(
          window.start,
          window.end,
          window.start,
          window.end,
          window.start,
          window.end,
        ) as ProductMovementDbRow[];

      const products = rows.map((row) => {
        const netUnitsMoved = row.units_sold - row.units_returned;
        return {
          id: row.id,
          sku: row.sku,
          name: row.name,
          unit: row.unit,
          quantityOnHand: row.quantity_on_hand,
          unitsSold: row.units_sold,
          unitsReturned: row.units_returned,
          netUnitsMoved,
          averageUnitsMovedPerDay: netUnitsMoved / periodDays,
          transactionCount: row.transaction_count,
          lastSoldAt: row.last_sold_at,
        };
      });
      const unitMovementTotals = new Map<
        string,
        { unitsPerDay: number; productCount: number }
      >();
      for (const product of products) {
        const totals = unitMovementTotals.get(product.unit) ?? {
          unitsPerDay: 0,
          productCount: 0,
        };
        totals.unitsPerDay += product.averageUnitsMovedPerDay;
        totals.productCount += 1;
        unitMovementTotals.set(product.unit, totals);
      }
      const classifiedProducts = products.map((product) => {
        const unitTotals = unitMovementTotals.get(product.unit);
        const unitAverage = unitTotals
          ? unitTotals.unitsPerDay / unitTotals.productCount
          : 0;
        return {
          ...product,
          movement:
            product.netUnitsMoved > 0 &&
            product.averageUnitsMovedPerDay >= unitAverage
              ? "FAST"
              : "SLOW",
        };
      });

      res.json({
        startDate: range.start,
        endDate: range.end,
        periodDays,
        activeProductCount: products.length,
        fastMovingCount: classifiedProducts.filter(
          (product) => product.movement === "FAST",
        ).length,
        slowMovingCount: classifiedProducts.filter(
          (product) => product.movement === "SLOW",
        ).length,
        productsWithSalesCount: products.filter(
          (product) => product.netUnitsMoved > 0,
        ).length,
        products: classifiedProducts.sort(
          (left, right) =>
            right.averageUnitsMovedPerDay - left.averageUnitsMovedPerDay ||
            left.name.localeCompare(right.name) ||
            left.sku.localeCompare(right.sku),
        ),
      });
    },
  );

  router.get("/reports/range", requireAuth, requireOwner, (req, res) => {
    const range = readRange(req.query.startDate, req.query.endDate);
    if (!range) {
      res.status(400).json({ error: "invalid_report_range" });
      return;
    }
    res.json({ report: reportRows(db, range.start, range.end) });
  });

  router.get(
    "/reports/beneficiaries/range",
    requireAuth,
    requireOwner,
    (req, res) => {
      const range = readRange(req.query.startDate, req.query.endDate);
      if (!range) {
        res.status(400).json({ error: "invalid_report_range" });
        return;
      }

      const sales = db
        .prepare(
          `SELECT s.id, s.transaction_id, s.business_date, s.created_at,
                  s.benefit_type, s.customer_name_ciphertext,
                  s.customer_id_number_ciphertext
           FROM sales s
           WHERE s.business_date >= ? AND s.business_date <= ?
             AND s.benefit_type IN ('SENIOR_CITIZEN', 'PWD')
           ORDER BY s.created_at, s.transaction_id`,
        )
        .all(range.start, range.end) as Array<{
        id: string;
        transaction_id: string;
        business_date: string;
        created_at: string;
        benefit_type: "SENIOR_CITIZEN" | "PWD";
        customer_name_ciphertext: string;
        customer_id_number_ciphertext: string;
      }>;

      try {
        const productsForSale = db.prepare(
          `SELECT product_name_snapshot, quantity FROM sale_lines
           WHERE sale_id = ? ORDER BY line_number`,
        );
        const transactions = sales.map((sale) => ({
          transactionId: sale.transaction_id,
          businessDate: sale.business_date,
          createdAt: sale.created_at,
          benefitType: sale.benefit_type,
          customerName: decryptCustomerField(
            sale.customer_name_ciphertext,
            `${sale.id}/name`,
          ),
          customerIdNumber: decryptCustomerField(
            sale.customer_id_number_ciphertext,
            `${sale.id}/id-number`,
          ),
          products: (
            productsForSale.all(sale.id) as Array<{
              product_name_snapshot: string;
              quantity: number;
            }>
          ).map((line) => ({
            name: line.product_name_snapshot,
            quantity: line.quantity,
          })),
        }));

        writeAuditEvent(db, {
          actorUserId: req.user!.id,
          action: "report.beneficiary_list_viewed",
          entityType: "report",
          entityId: "beneficiary-list",
          details: {
            startDate: range.start,
            endDate: range.end,
            recordCount: transactions.length,
          },
        });
        res.json({ transactions });
      } catch (error) {
        if (error instanceof CustomerDataError) {
          res.status(503).json({ error: error.code });
          return;
        }
        throw error;
      }
    },
  );

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
