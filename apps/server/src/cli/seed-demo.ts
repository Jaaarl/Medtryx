import "../config.js";
import argon2 from "argon2";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { lotLedgerIssues, manilaCalendarDate } from "../lot-stock.js";
import { openDatabase, repositoryRoot } from "../db.js";

const seedVersion = "portfolio-demo-v1";
const seedMarkerId = stableId("seed-marker");

const accounts = [
  {
    key: "owner",
    id: stableId("user-owner"),
    email: "owner@demo.medtryx.local",
    username: "owner",
    password: "DemoOwner2026!",
    role: "owner" as const,
  },
  {
    key: "manager",
    id: stableId("user-manager"),
    email: "manager@demo.medtryx.local",
    username: "manager",
    password: "DemoManager2026!",
    role: "owner" as const,
  },
  {
    key: "cashier",
    id: stableId("user-cashier"),
    email: "cashier@demo.medtryx.local",
    username: "cashier",
    password: "DemoCashier2026!",
    role: "cashier" as const,
  },
];

type Product = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  selling_price_centavos: number;
  quantity_on_hand: number;
  inventory_value_centavos: number;
  tracks_lots: number;
  tax_class: "VATABLE" | "VAT_EXEMPT" | "ZERO_RATED";
  sc_pwd_eligible: number;
  sc_eligible: number;
  pwd_eligible: number;
  product_type: "GENERIC" | "BRANDED" | null;
  bnpc_eligible: number;
  bnpc_category: string | null;
  bnpc_prescription_required: number;
  product_type_applicable: number;
};

type ReceiptLineSpec = { sku: string; quantity: number };
type SaleLineSpec = {
  sku: string;
  quantity: number;
  override?: {
    physicalQuantity: number;
    reason: string;
  };
};
type SaleSpec = {
  key: string;
  dateOffset: number;
  time: string;
  shiftKey: string;
  paymentMethod: "CASH" | "QR";
  lines: SaleLineSpec[];
  reverseInFull?: boolean;
};

const receiptSpecs: Array<{
  key: string;
  dateOffset: number;
  time: string;
  reference: string;
  supplier: string;
  lines: ReceiptLineSpec[];
}> = [
  {
    key: "receipt-a",
    dateOffset: -4,
    time: "08:10",
    reference: "CDJ-INV-10482",
    supplier: "CDJ Pharma Distribution",
    lines: [
      { sku: "MTX-000001", quantity: 30 },
      { sku: "MTX-000002", quantity: 80 },
      { sku: "MTX-000003", quantity: 60 },
      { sku: "MTX-000005", quantity: 50 },
    ],
  },
  {
    key: "receipt-b",
    dateOffset: -2,
    time: "08:20",
    reference: "PHD-INV-77106",
    supplier: "Pacific Health Depot",
    lines: [
      { sku: "MTX-000007", quantity: 40 },
      { sku: "MTX-000008", quantity: 10 },
      { sku: "MTX-000010", quantity: 80 },
    ],
  },
];

const saleSpecs: SaleSpec[] = [
  {
    key: "sale-day-minus-3-a",
    dateOffset: -3,
    time: "09:16",
    shiftKey: "shift-day-minus-3",
    paymentMethod: "CASH",
    lines: [
      { sku: "MTX-000001", quantity: 1 },
      { sku: "MTX-000002", quantity: 3 },
    ],
  },
  {
    key: "sale-day-minus-3-b",
    dateOffset: -3,
    time: "13:42",
    shiftKey: "shift-day-minus-3",
    paymentMethod: "QR",
    lines: [
      { sku: "MTX-000003", quantity: 2 },
      { sku: "MTX-000005", quantity: 1 },
    ],
  },
  {
    key: "sale-day-minus-2-a",
    dateOffset: -2,
    time: "10:08",
    shiftKey: "shift-day-minus-2",
    paymentMethod: "QR",
    lines: [
      { sku: "MTX-000007", quantity: 1 },
      { sku: "MTX-000010", quantity: 2 },
    ],
  },
  {
    key: "sale-day-minus-2-b",
    dateOffset: -2,
    time: "14:37",
    shiftKey: "shift-day-minus-2",
    paymentMethod: "CASH",
    reverseInFull: true,
    lines: [
      { sku: "MTX-000008", quantity: 1 },
      { sku: "MTX-000007", quantity: 1 },
    ],
  },
  {
    key: "sale-day-minus-1-a",
    dateOffset: -1,
    time: "09:34",
    shiftKey: "shift-day-minus-1",
    paymentMethod: "CASH",
    lines: [
      { sku: "MTX-000010", quantity: 1 },
      { sku: "MTX-000007", quantity: 1 },
    ],
  },
  {
    key: "sale-day-minus-1-count-override",
    dateOffset: -1,
    time: "11:48",
    shiftKey: "shift-day-minus-1",
    paymentMethod: "QR",
    lines: [
      {
        sku: "MTX-000006",
        quantity: 4,
        override: {
          physicalQuantity: 4,
          reason: "Shelf recount confirmed four sealed units before checkout.",
        },
      },
    ],
  },
  {
    key: "sale-day-minus-1-b",
    dateOffset: -1,
    time: "15:12",
    shiftKey: "shift-day-minus-1",
    paymentMethod: "QR",
    lines: [
      { sku: "MTX-000001", quantity: 1 },
      { sku: "MTX-000005", quantity: 2 },
    ],
  },
  {
    key: "sale-today-a",
    dateOffset: 0,
    time: "08:52",
    shiftKey: "shift-today",
    paymentMethod: "CASH",
    lines: [
      { sku: "MTX-000008", quantity: 1 },
      { sku: "MTX-000003", quantity: 2 },
    ],
  },
  {
    key: "sale-today-b",
    dateOffset: 0,
    time: "10:26",
    shiftKey: "shift-today",
    paymentMethod: "QR",
    lines: [
      { sku: "MTX-000002", quantity: 5 },
      { sku: "MTX-000010", quantity: 1 },
    ],
  },
];

const expenseSpecs = [
  {
    key: "expense-lunch-minus-3",
    dateOffset: -3,
    time: "12:05",
    shiftKey: "shift-day-minus-3",
    category: "LUNCH" as const,
    amountCentavos: 38500,
    description: "Team lunch during afternoon break",
    paymentSource: "CASHIER" as const,
    recordedBy: "cashier",
  },
  {
    key: "expense-delivery-minus-2",
    dateOffset: -2,
    time: "16:08",
    shiftKey: "shift-day-minus-2",
    category: "DELIVERY" as const,
    amountCentavos: 18000,
    description: "Local delivery and document handling",
    paymentSource: "CASHIER" as const,
    recordedBy: "cashier",
  },
  {
    key: "expense-supplies-minus-1",
    dateOffset: -1,
    time: "16:02",
    shiftKey: "shift-day-minus-1",
    category: "OTHER" as const,
    amountCentavos: 52600,
    description: "Receipt paper and counter supplies",
    paymentSource: "CASHIER" as const,
    recordedBy: "cashier",
  },
  {
    key: "expense-utilities-today",
    dateOffset: 0,
    time: "11:00",
    shiftKey: null,
    category: "DELIVERY" as const,
    amountCentavos: 185000,
    description: "Monthly supplier delivery charge",
    paymentSource: "OWNER" as const,
    recordedBy: "manager",
  },
];

function stableId(name: string): string {
  const hex = createHash("sha256")
    .update(`${seedVersion}:${name}`)
    .digest("hex")
    .slice(0, 32);
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function addDays(day: string, amount: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function atManilaTime(day: string, time: string): string {
  return new Date(`${day}T${time}:00+08:00`).toISOString();
}

function oneMinuteBefore(value: string): string {
  return new Date(new Date(value).getTime() - 60_000).toISOString();
}

function moneyText(centavos: number): string {
  return (centavos / 100).toFixed(2);
}

function tableCounts(db: Database.Database): Map<string, number> {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return new Map(
    tables.map(({ name }) => {
      const row = db
        .prepare(`SELECT COUNT(*) AS count FROM "${name}"`)
        .get() as {
        count: number;
      };
      return [name, row.count];
    }),
  );
}

function writeAudit(
  db: Database.Database,
  input: {
    actorUserId: string;
    action: string;
    entityType: string;
    entityId: string;
    createdAt: string;
    details?: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO audit_events
      (id, actor_user_id, action, entity_type, entity_id, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    stableId(`audit:${input.action}:${input.entityId}`),
    input.actorUserId,
    input.action,
    input.entityType,
    input.entityId,
    JSON.stringify(input.details ?? {}),
    input.createdAt,
  );
}

function productBySku(db: Database.Database, sku: string): Product {
  const row = db
    .prepare(
      `SELECT id, sku, name, unit, selling_price_centavos, quantity_on_hand,
              inventory_value_centavos, tracks_lots, tax_class, sc_pwd_eligible,
              sc_eligible, pwd_eligible, product_type, bnpc_eligible,
              bnpc_category, bnpc_prescription_required, product_type_applicable
       FROM products WHERE sku = ? AND is_active = 1 AND deleted_at IS NULL`,
    )
    .get(sku) as Product | undefined;
  if (!row)
    throw new Error(`Active product ${sku} is required by the demo seed.`);
  return row;
}

function existingAnchorDate(db: Database.Database): string | null {
  const marker = db
    .prepare(
      "SELECT details_json FROM audit_events WHERE id = ? AND action = 'demo.portfolio_seeded'",
    )
    .get(seedMarkerId) as { details_json: string } | undefined;
  if (!marker) return null;
  const details = JSON.parse(marker.details_json) as { anchorDate?: unknown };
  if (
    typeof details.anchorDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(details.anchorDate)
  ) {
    throw new Error("Demo seed marker is missing its original anchor date.");
  }
  return details.anchorDate;
}

async function ensureDemoAccounts(
  db: Database.Database,
  anchorDate: string,
): Promise<Map<string, string>> {
  const now = atManilaTime(anchorDate, "00:05");
  const ids = new Map<string, string>();
  for (const account of accounts) {
    const byEmail = db
      .prepare("SELECT id, username FROM users WHERE email = ?")
      .get(account.email) as
      | { id: string; username: string | null }
      | undefined;
    const byUsername = db
      .prepare("SELECT id, email FROM users WHERE username = ? COLLATE NOCASE")
      .get(account.username) as { id: string; email: string } | undefined;
    if (
      (byEmail && byEmail.id !== account.id) ||
      (byUsername && byUsername.id !== account.id)
    ) {
      throw new Error(
        `Cannot safely seed demo username ${account.username}; it is already in use.`,
      );
    }
    if (!byEmail) {
      const passwordHash = await argon2.hash(account.password, {
        type: argon2.argon2id,
      });
      db.prepare(
        `INSERT OR IGNORE INTO users
          (id, email, username, password_hash, role, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        account.id,
        account.email,
        account.username,
        passwordHash,
        account.role,
        now,
        now,
      );
      writeAudit(db, {
        actorUserId: account.id,
        action: "user.demo_account_seeded",
        entityType: "user",
        entityId: account.id,
        createdAt: now,
        details: { username: account.username, role: account.role },
      });
    } else if (byEmail.username !== account.username) {
      throw new Error(
        `Demo account ${account.username} exists with a different username.`,
      );
    }
    db.prepare(
      "UPDATE users SET created_at = ?, updated_at = ? WHERE id = ?",
    ).run(now, now, account.id);
    db.prepare("UPDATE audit_events SET created_at = ? WHERE id = ?").run(
      now,
      stableId(`audit:user.demo_account_seeded:${account.id}`),
    );
    ids.set(account.key, account.id);
  }
  return ids;
}

function insertReceipts(
  db: Database.Database,
  anchorDate: string,
  ownerId: string,
): void {
  const insertReceipt = db.prepare(
    `INSERT INTO stock_receipts
      (id, draft_id, source, reference, supplier, actor_user_id, created_at)
     VALUES (?, ?, 'AI_RECEIPT_IMPORT', ?, ?, ?, ?)`,
  );
  const insertLine = db.prepare(
    `INSERT INTO stock_receipt_lines
      (id, receipt_id, line_number, product_id, stock_event_id, inventory_lot_id,
       original_description, source_quantity, source_unit_cost, source_line_total,
       source_lot, source_expiry, received_quantity, received_unit_cost_centavos,
       conversion_factor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  );
  const insertStockEvent = db.prepare(
    `INSERT INTO stock_events
      (id, product_id, event_type, quantity_delta, unit_cost_centavos,
       inventory_value_delta_centavos, reference, reason, actor_user_id, created_at, supplier)
     VALUES (?, ?, 'RECEIPT', ?, ?, ?, ?, NULL, ?, ?, ?)`,
  );
  const insertLot = db.prepare(
    `INSERT INTO inventory_lots
      (id, product_id, lot_code, expiry_date, quarantined, created_at, created_by_user_id)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  );
  const insertLotMovement = db.prepare(
    `INSERT INTO lot_stock_movements
      (id, product_id, lot_id, movement_type, stock_event_id, quantity_delta,
       inventory_value_delta_centavos, unit_cost_centavos, actor_user_id, created_at)
     VALUES (?, ?, ?, 'RECEIPT', ?, ?, ?, ?, ?, ?)`,
  );
  const updateProduct = db.prepare(
    `UPDATE products
     SET quantity_on_hand = quantity_on_hand + ?,
         inventory_value_centavos = inventory_value_centavos + ?, updated_at = ?
     WHERE id = ?`,
  );

  for (const receipt of receiptSpecs) {
    const receiptId = stableId(receipt.key);
    const draftId = stableId(`${receipt.key}:draft`);
    const alreadyReceived = db
      .prepare("SELECT 1 AS present FROM stock_receipts WHERE draft_id = ?")
      .get(draftId);
    if (alreadyReceived) continue;

    const date = addDays(anchorDate, receipt.dateOffset);
    const createdAt = atManilaTime(date, receipt.time);
    insertReceipt.run(
      receiptId,
      draftId,
      receipt.reference,
      receipt.supplier,
      ownerId,
      createdAt,
    );
    receipt.lines.forEach((line, index) => {
      const product = productBySku(db, line.sku);
      if (product.tracks_lots !== 1)
        throw new Error(
          `Receipt product ${line.sku} must track inventory lots.`,
        );
      const unitCost = Math.max(
        1,
        Math.round(product.inventory_value_centavos / product.quantity_on_hand),
      );
      const value = unitCost * line.quantity;
      const eventId = stableId(`${receipt.key}:event:${index + 1}`);
      const lotId = stableId(`${receipt.key}:lot:${index + 1}`);
      const lotCode = `DEMO-${receipt.key.toUpperCase()}-${product.sku.slice(-3)}`;
      const expiry = addDays(anchorDate, 730 + index * 30);
      const sourceUnitCost = moneyText(unitCost);
      const sourceLineTotal = moneyText(value);
      insertStockEvent.run(
        eventId,
        product.id,
        line.quantity,
        unitCost,
        value,
        receipt.reference,
        ownerId,
        createdAt,
        receipt.supplier,
      );
      insertLot.run(lotId, product.id, lotCode, expiry, createdAt, ownerId);
      insertLotMovement.run(
        stableId(`${receipt.key}:lot-movement:${index + 1}`),
        product.id,
        lotId,
        eventId,
        line.quantity,
        value,
        unitCost,
        ownerId,
        createdAt,
      );
      insertLine.run(
        stableId(`${receipt.key}:line:${index + 1}`),
        receiptId,
        index + 1,
        product.id,
        eventId,
        lotId,
        `${product.name} (${product.sku})`,
        String(line.quantity),
        sourceUnitCost,
        sourceLineTotal,
        lotCode,
        expiry,
        line.quantity,
        unitCost,
        createdAt,
      );
      updateProduct.run(line.quantity, value, createdAt, product.id);
    });
    writeAudit(db, {
      actorUserId: ownerId,
      action: "stock.receipt_imported",
      entityType: "stock_receipt",
      entityId: receiptId,
      createdAt,
      details: {
        lineCount: receipt.lines.length,
        productsAffected: receipt.lines.length,
        supplier: receipt.supplier,
        reference: receipt.reference,
      },
    });
  }
}

function insertBundles(
  db: Database.Database,
  anchorDate: string,
  ownerId: string,
): void {
  const bundles = [
    {
      key: "bundle-everyday-care",
      code: "DEMO-CARE-01",
      name: "Everyday Care Pair",
      reductionType: "PERCENT",
      reductionValue: 1000,
      promotionalPriceCentavos: 3600,
      components: [
        { sku: "MTX-000002", quantity: 1 },
        { sku: "MTX-000010", quantity: 1 },
      ],
    },
    {
      key: "bundle-family-wellness",
      code: "DEMO-WELLNESS-02",
      name: "Family Wellness Set",
      reductionType: "PERCENT",
      reductionValue: 800,
      promotionalPriceCentavos: 59000,
      components: [
        { sku: "MTX-000008", quantity: 1 },
        { sku: "MTX-000007", quantity: 1 },
      ],
    },
    {
      key: "bundle-daily-essentials",
      code: "DEMO-ESSENTIALS-03",
      name: "Daily Essentials Pair",
      reductionType: "AMOUNT",
      reductionValue: 500,
      promotionalPriceCentavos: 2500,
      components: [
        { sku: "MTX-000003", quantity: 1 },
        { sku: "MTX-000005", quantity: 1 },
      ],
    },
  ];
  const now = atManilaTime(anchorDate, "00:08");
  const insertBundle = db.prepare(
    `INSERT OR IGNORE INTO sales_bundles
      (id, code, is_active, current_version, created_by_user_id, created_at, updated_by_user_id, updated_at)
     VALUES (?, ?, 1, 1, ?, ?, ?, ?)`,
  );
  const insertVersion = db.prepare(
    `INSERT OR IGNORE INTO sales_bundle_versions
      (id, bundle_id, version, code_snapshot, name_snapshot, active_from, active_until,
       max_quantity_per_sale, reduction_type, reduction_value, suggested_price_centavos,
       promotional_price_centavos, price_rule_version, discount_interaction_rule,
       approved_by_user_id, approved_at, created_at)
     VALUES (?, ?, 1, ?, ?, ?, NULL, 5, ?, ?, ?, ?,
       'OWNER_APPROVED_FIXED_CENTAVOS_V1', 'MORE_FAVORABLE_NO_STACK_V1', ?, ?, ?)`,
  );
  const insertComponent = db.prepare(
    `INSERT OR IGNORE INTO sales_bundle_version_components
      (bundle_version_id, product_id, quantity, component_order)
     VALUES (?, ?, ?, ?)`,
  );
  for (const bundle of bundles) {
    const id = stableId(bundle.key);
    const versionId = stableId(`${bundle.key}:version:1`);
    const products = bundle.components.map((component) => ({
      ...component,
      product: productBySku(db, component.sku),
    }));
    const regularTotal = products.reduce(
      (total, component) =>
        total + component.product.selling_price_centavos * component.quantity,
      0,
    );
    const reduction =
      bundle.reductionType === "PERCENT"
        ? Math.floor((regularTotal * bundle.reductionValue + 5000) / 10000)
        : bundle.reductionValue;
    const suggested = regularTotal - reduction;
    if (
      bundle.promotionalPriceCentavos <= 0 ||
      bundle.promotionalPriceCentavos >= regularTotal
    ) {
      throw new Error(`Invalid demo promotional price for ${bundle.code}.`);
    }
    insertBundle.run(id, bundle.code, ownerId, now, ownerId, now);
    insertVersion.run(
      versionId,
      id,
      bundle.code,
      bundle.name,
      addDays(anchorDate, -7),
      bundle.reductionType,
      bundle.reductionValue,
      suggested,
      bundle.promotionalPriceCentavos,
      ownerId,
      now,
      now,
    );
    products.forEach((component, index) => {
      insertComponent.run(
        versionId,
        component.product.id,
        component.quantity,
        index + 1,
      );
    });
    writeAudit(db, {
      actorUserId: ownerId,
      action: "sales_bundle.created",
      entityType: "sales_bundle",
      entityId: id,
      createdAt: now,
      details: {
        code: bundle.code,
        name: bundle.name,
        version: 1,
        componentCount: products.length,
        regularTotalCentavos: regularTotal,
        suggestedPriceCentavos: suggested,
        promotionalPriceCentavos: bundle.promotionalPriceCentavos,
      },
    });
    db.prepare(
      "UPDATE sales_bundles SET created_at = ?, updated_at = ? WHERE id = ?",
    ).run(now, now, id);
    db.prepare("UPDATE audit_events SET created_at = ? WHERE id = ?").run(
      now,
      stableId(`audit:sales_bundle.created:${id}`),
    );
  }
}

type SeedSale = {
  id: string;
  transactionId: string;
  date: string;
  createdAt: string;
  shiftId: string;
  cashierId: string;
  paymentMethod: "CASH" | "QR";
  total: number;
  lines: Array<{
    id: string;
    product: Product;
    quantity: number;
    amount: number;
    allocatedCogs: number;
    lotId: string | null;
    lotCode: string | null;
    lotExpiry: string | null;
    override: {
      recordedQuantity: number;
      physicalQuantity: number;
      correctionQuantity: number;
      reason: string;
      unitCostCentavos: number;
      inventoryValueDeltaCentavos: number;
      stockEventId: string;
    } | null;
  }>;
  reverseInFull: boolean;
};

function enableCheckoutCountOverrides(
  db: Database.Database,
  managerId: string,
  anchorDate: string,
): number {
  const row = db
    .prepare("SELECT value_json FROM settings WHERE key = 'checkout_inventory'")
    .get() as { value_json: string } | undefined;
  if (!row) throw new Error("Checkout inventory setting is missing.");
  const current = JSON.parse(row.value_json) as {
    allowStockCountOverride?: unknown;
    policyVersion?: unknown;
  };
  if (
    typeof current.allowStockCountOverride !== "boolean" ||
    !Number.isInteger(current.policyVersion)
  ) {
    throw new Error("Checkout inventory setting is invalid.");
  }
  if (current.allowStockCountOverride) return current.policyVersion as number;
  const policyVersion = (current.policyVersion as number) + 1;
  const updatedAt = atManilaTime(anchorDate, "00:06");
  db.prepare(
    `UPDATE settings SET value_json = ?, updated_at = ?, updated_by = ?
     WHERE key = 'checkout_inventory'`,
  ).run(
    JSON.stringify({ allowStockCountOverride: true, policyVersion }),
    updatedAt,
    managerId,
  );
  writeAudit(db, {
    actorUserId: managerId,
    action: "checkout.inventory_override_setting_updated",
    entityType: "setting",
    entityId: "checkout_inventory",
    createdAt: updatedAt,
    details: {
      oldValue: false,
      newValue: true,
      policyVersion,
    },
  });
  return policyVersion;
}

function ensureStoreProfile(
  db: Database.Database,
  managerId: string,
  anchorDate: string,
): void {
  const existing = db
    .prepare("SELECT 1 AS present FROM settings WHERE key = 'store_profile'")
    .get();
  if (existing) return;
  const profile = {
    id: stableId("store-profile"),
    name: "Harborview Community Pharmacy",
  };
  const createdAt = atManilaTime(anchorDate, "00:07");
  db.prepare(
    `INSERT OR IGNORE INTO settings (key, value_json, updated_at, updated_by)
     VALUES ('store_profile', ?, ?, ?)`,
  ).run(JSON.stringify(profile), createdAt, managerId);
  writeAudit(db, {
    actorUserId: managerId,
    action: "store.profile_updated",
    entityType: "store",
    entityId: profile.id,
    createdAt,
    details: { name: profile.name },
  });
}

function insertSales(
  db: Database.Database,
  anchorDate: string,
  cashierId: string,
  managerId: string,
  shiftIds: Map<string, string>,
): SeedSale[] {
  const taxSettings = db
    .prepare("SELECT value_json FROM settings WHERE key = 'tax'")
    .get() as { value_json: string } | undefined;
  const taxPolicyVersion = taxSettings
    ? ((JSON.parse(taxSettings.value_json) as { version?: string }).version ??
      "PH-APPROVED-V1")
    : "PH-APPROVED-V1";
  const checkoutSettings = db
    .prepare("SELECT value_json FROM settings WHERE key = 'checkout_inventory'")
    .get() as { value_json: string } | undefined;
  const overridePolicyVersion = checkoutSettings
    ? ((JSON.parse(checkoutSettings.value_json) as { policyVersion?: number })
        .policyVersion ?? 1)
    : 1;
  const sales: SeedSale[] = [];
  const insertSale = db.prepare(
    `INSERT OR IGNORE INTO sales
      (id, transaction_id, business_date, request_key, request_hash,
       cashier_user_id, shift_id, benefit_type, customer_name_ciphertext,
       customer_id_type_ciphertext, customer_id_number_ciphertext,
       customer_id_checked, payment_method, subtotal_centavos, vat_centavos,
       vat_removed_centavos, senior_discount_centavos, pwd_discount_centavos,
       amount_due_centavos, tax_policy_version, created_at, cash_rounding_mode,
       cash_rounding_adjustment_centavos, bnpc_discount_centavos)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'REGULAR', NULL, NULL, NULL, 0, ?, ?, 0,
       0, 0, 0, ?, ?, ?, 'NEAREST_25_CENTAVOS', 0, 0)`,
  );
  const insertLine = db.prepare(
    `INSERT OR IGNORE INTO sale_lines
      (id, sale_id, line_number, product_id, product_name_snapshot, sku_snapshot,
       unit_snapshot, quantity, unit_price_centavos, tax_class_snapshot,
       sc_pwd_eligible_snapshot, benefit_applied, tax_basis_centavos, vat_centavos,
       vat_removed_centavos, discount_centavos, amount_due_centavos,
       allocated_cogs_centavos, tax_policy_version, created_at, sc_eligible_snapshot,
       pwd_eligible_snapshot, product_type_snapshot, bundle_promotion_discount_centavos,
       benefit_treatment_snapshot, bnpc_eligible_snapshot, bnpc_category_snapshot,
       bnpc_discount_centavos, bnpc_policy_version, bnpc_prescription_required_snapshot,
       product_type_applicable_snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, 0,
       'REGULAR', ?, ?, 0, NULL, ?, ?)`,
  );
  const insertEvent = db.prepare(
    `INSERT OR IGNORE INTO stock_events
      (id, product_id, event_type, quantity_delta, unit_cost_centavos,
       inventory_value_delta_centavos, reference, reason, actor_user_id, created_at)
     VALUES (?, ?, 'SALE', ?, ?, ?, ?, NULL, ?, ?)`,
  );
  const insertOverrideEvent = db.prepare(
    `INSERT OR IGNORE INTO stock_events
      (id, product_id, event_type, quantity_delta, unit_cost_centavos,
       inventory_value_delta_centavos, reference, reason, actor_user_id, created_at)
     VALUES (?, ?, 'ADJUSTMENT', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAllocation = db.prepare(
    `INSERT OR IGNORE INTO sale_line_lot_allocations
      (id, sale_line_id, lot_id, quantity, allocated_cogs_centavos, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertMovement = db.prepare(
    `INSERT OR IGNORE INTO lot_stock_movements
      (id, product_id, lot_id, movement_type, stock_event_id, sale_line_id,
       quantity_delta, inventory_value_delta_centavos, unit_cost_centavos,
       actor_user_id, created_at)
     VALUES (?, ?, ?, 'SALE', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAdjustmentMovement = db.prepare(
    `INSERT OR IGNORE INTO lot_stock_movements
      (id, product_id, lot_id, movement_type, stock_event_id,
       quantity_delta, inventory_value_delta_centavos, unit_cost_centavos,
       reason, actor_user_id, created_at)
     VALUES (?, ?, ?, 'ADJUSTMENT', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertOverride = db.prepare(
    `INSERT OR IGNORE INTO checkout_stock_override_records
      (id, sale_id, cashier_user_id, product_id, stock_event_id,
       recorded_quantity, physical_quantity, correction_quantity, sale_quantity,
       reason_category, reason, cost_source_type, cost_source_event_id,
       cost_source_sequence, estimated_cost, unit_cost_centavos,
       inventory_value_delta_centavos, stock_state_hash, policy_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'COUNT_DISCREPANCY', ?,
       'WEIGHTED_AVERAGE', NULL, NULL, 0, ?, ?, ?, ?, ?)`,
  );
  const insertOverrideLot = db.prepare(
    `INSERT OR IGNORE INTO checkout_stock_override_lots
      (id, override_record_id, lot_id, lot_code_snapshot, expiry_date_snapshot,
       recorded_quantity, physical_quantity, correction_quantity, sale_quantity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertReview = db.prepare(
    `INSERT OR IGNORE INTO checkout_stock_override_reviews
      (id, override_record_id, reviewer_user_id, status, note, created_at)
     VALUES (?, ?, ?, 'REVIEWED', ?, ?)`,
  );
  const updateProduct = db.prepare(
    `UPDATE products
     SET quantity_on_hand = quantity_on_hand - ?,
         inventory_value_centavos = inventory_value_centavos - ?, updated_at = ?
     WHERE id = ?`,
  );
  const addCorrectionToProduct = db.prepare(
    `UPDATE products
     SET quantity_on_hand = quantity_on_hand + ?,
         inventory_value_centavos = inventory_value_centavos + ?, updated_at = ?
     WHERE id = ?`,
  );
  const lotForProduct = db.prepare(
    `SELECT l.id,
            l.lot_code,
            l.expiry_date,
            COALESCE((SELECT SUM(m.quantity_delta) FROM lot_stock_movements m WHERE m.lot_id = l.id), 0) AS quantity,
            COALESCE((SELECT SUM(m.inventory_value_delta_centavos) FROM lot_stock_movements m WHERE m.lot_id = l.id), 0) AS value
     FROM inventory_lots l
     WHERE l.product_id = ?
       AND COALESCE((SELECT SUM(m.quantity_delta) FROM lot_stock_movements m WHERE m.lot_id = l.id), 0) > 0
       AND l.quarantined = 0
     ORDER BY CASE WHEN l.lot_code LIKE 'DEMO-%' THEN 0 ELSE 1 END,
              l.expiry_date, l.lot_code LIMIT 1`,
  );

  const dailySequence = new Map<string, number>();
  for (const spec of saleSpecs) {
    const saleId = stableId(spec.key);
    const existing = db
      .prepare("SELECT 1 AS present FROM sales WHERE id = ?")
      .get(saleId);
    const date = addDays(anchorDate, spec.dateOffset);
    const createdAt = atManilaTime(date, spec.time);
    if (existing) {
      continue;
    }
    const dateKey = date.replaceAll("-", "");
    if (!dailySequence.has(date)) {
      const existingTransactions = db
        .prepare("SELECT transaction_id FROM sales WHERE business_date = ?")
        .all(date) as Array<{ transaction_id: string }>;
      const maxExisting = existingTransactions.reduce((max, sale) => {
        const match = sale.transaction_id.match(/^MTX-\d{8}-(\d{6})$/);
        return match ? Math.max(max, Number(match[1])) : max;
      }, 990000);
      dailySequence.set(date, maxExisting);
    }
    const sequence = dailySequence.get(date)! + 1;
    dailySequence.set(date, sequence);
    const transactionId = `MTX-${dateKey}-${String(sequence).padStart(6, "0")}`;
    const shiftId = shiftIds.get(spec.shiftKey);
    if (!shiftId) throw new Error(`Missing demo shift ${spec.shiftKey}.`);
    const lines = spec.lines.map((line, index) => {
      const product = productBySku(db, line.sku);
      const lot =
        product.tracks_lots === 1
          ? (lotForProduct.get(product.id) as
              | {
                  id: string;
                  lot_code: string;
                  expiry_date: string;
                  quantity: number;
                  value: number;
                }
              | undefined)
          : undefined;
      const correctionQuantity = line.override
        ? line.override.physicalQuantity - product.quantity_on_hand
        : 0;
      if (
        line.override &&
        (correctionQuantity < 1 ||
          line.override.physicalQuantity < line.quantity)
      ) {
        throw new Error(
          `Invalid demo physical-count correction for ${product.sku}.`,
        );
      }
      if (product.tracks_lots === 1 && !lot)
        throw new Error(`Demo lot stock is missing for ${product.sku}.`);
      if (
        product.tracks_lots === 1 &&
        lot &&
        lot.quantity + correctionQuantity < line.quantity
      ) {
        throw new Error(`Demo lot stock is insufficient for ${product.sku}.`);
      }
      if (
        product.tracks_lots === 0 &&
        product.quantity_on_hand + correctionQuantity < line.quantity
      ) {
        throw new Error(`Demo stock is insufficient for ${product.sku}.`);
      }
      const unitCost =
        line.override && product.quantity_on_hand > 0
          ? Math.round(
              product.inventory_value_centavos / product.quantity_on_hand,
            )
          : lot
            ? Math.round(lot.value / lot.quantity)
            : 0;
      const allocatedCogs = unitCost * line.quantity;
      return {
        id: stableId(`${spec.key}:line:${index + 1}`),
        product,
        quantity: line.quantity,
        amount: product.selling_price_centavos * line.quantity,
        allocatedCogs,
        lotId: lot?.id ?? null,
        lotCode: lot?.lot_code ?? null,
        lotExpiry: lot?.expiry_date ?? null,
        override: line.override
          ? {
              recordedQuantity: product.quantity_on_hand,
              physicalQuantity: line.override.physicalQuantity,
              correctionQuantity,
              reason: line.override.reason,
              unitCostCentavos: unitCost,
              inventoryValueDeltaCentavos: unitCost * correctionQuantity,
              stockEventId: stableId(
                `${spec.key}:override-stock-event:${index + 1}`,
              ),
            }
          : null,
      };
    });
    const total = lines.reduce((sum, line) => sum + line.amount, 0);
    const requestKey = stableId(`${spec.key}:request`);
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          transactionId,
          lines,
          paymentMethod: spec.paymentMethod,
        }),
      )
      .digest("hex");
    insertSale.run(
      saleId,
      transactionId,
      date,
      requestKey,
      requestHash,
      cashierId,
      shiftId,
      spec.paymentMethod,
      total,
      total,
      taxPolicyVersion,
      createdAt,
    );
    lines.forEach((line, index) => {
      const unitPrice = line.product.selling_price_centavos;
      const lineAmount = line.amount;
      const eventId = stableId(`${spec.key}:stock-event:${index + 1}`);
      if (line.override) {
        const overrideReason = `COUNT_DISCREPANCY: ${line.override.reason}`;
        const adjustmentAt = oneMinuteBefore(createdAt);
        insertOverrideEvent.run(
          line.override.stockEventId,
          line.product.id,
          line.override.correctionQuantity,
          line.override.unitCostCentavos,
          line.override.inventoryValueDeltaCentavos,
          transactionId,
          overrideReason,
          cashierId,
          adjustmentAt,
        );
        addCorrectionToProduct.run(
          line.override.correctionQuantity,
          line.override.inventoryValueDeltaCentavos,
          adjustmentAt,
          line.product.id,
        );
        insertAdjustmentMovement.run(
          stableId(`${spec.key}:override-lot-movement:${index + 1}`),
          line.product.id,
          line.lotId,
          line.override.stockEventId,
          line.override.correctionQuantity,
          line.override.inventoryValueDeltaCentavos,
          line.override.unitCostCentavos,
          overrideReason,
          cashierId,
          adjustmentAt,
        );
      }
      insertLine.run(
        line.id,
        saleId,
        index + 1,
        line.product.id,
        line.product.name,
        line.product.sku,
        line.product.unit,
        line.quantity,
        unitPrice,
        line.product.tax_class,
        line.product.sc_pwd_eligible,
        lineAmount,
        lineAmount,
        line.allocatedCogs,
        taxPolicyVersion,
        createdAt,
        line.product.sc_eligible,
        line.product.pwd_eligible,
        line.product.product_type,
        line.product.bnpc_eligible,
        line.product.bnpc_category,
        line.product.bnpc_prescription_required,
        line.product.product_type_applicable,
      );
      insertEvent.run(
        eventId,
        line.product.id,
        -line.quantity,
        Math.round(line.allocatedCogs / line.quantity),
        -line.allocatedCogs,
        transactionId,
        cashierId,
        createdAt,
      );
      if (line.lotId) {
        insertAllocation.run(
          stableId(`${spec.key}:allocation:${index + 1}`),
          line.id,
          line.lotId,
          line.quantity,
          line.allocatedCogs,
          createdAt,
        );
      }
      insertMovement.run(
        stableId(`${spec.key}:lot-movement:${index + 1}`),
        line.product.id,
        line.lotId,
        eventId,
        line.id,
        -line.quantity,
        -line.allocatedCogs,
        Math.round(line.allocatedCogs / line.quantity),
        cashierId,
        createdAt,
      );
      updateProduct.run(
        line.quantity,
        line.allocatedCogs,
        createdAt,
        line.product.id,
      );
      if (line.override) {
        const overrideId = stableId(`${spec.key}:override-record:${index + 1}`);
        const stockStateHash = createHash("sha256")
          .update(
            JSON.stringify({
              productId: line.product.id,
              recordedQuantity: line.override.recordedQuantity,
              inventoryValueCentavos: line.product.inventory_value_centavos,
              lotId: line.lotId,
            }),
          )
          .digest("hex");
        insertOverride.run(
          overrideId,
          saleId,
          cashierId,
          line.product.id,
          line.override.stockEventId,
          line.override.recordedQuantity,
          line.override.physicalQuantity,
          line.override.correctionQuantity,
          line.quantity,
          line.override.reason,
          line.override.unitCostCentavos,
          line.override.inventoryValueDeltaCentavos,
          stockStateHash,
          overridePolicyVersion,
          createdAt,
        );
        if (line.lotId && line.lotCode && line.lotExpiry) {
          insertOverrideLot.run(
            stableId(`${spec.key}:override-lot:${index + 1}`),
            overrideId,
            line.lotId,
            line.lotCode,
            line.lotExpiry,
            line.override.recordedQuantity,
            line.override.physicalQuantity,
            line.override.correctionQuantity,
            line.quantity,
          );
        }
        writeAudit(db, {
          actorUserId: cashierId,
          action: "checkout.stock_count_override_applied",
          entityType: "checkout_stock_override",
          entityId: overrideId,
          createdAt,
          details: {
            saleId,
            transactionId,
            productId: line.product.id,
            stockEventId: line.override.stockEventId,
            recordedQuantity: line.override.recordedQuantity,
            physicalQuantity: line.override.physicalQuantity,
            correctionQuantity: line.override.correctionQuantity,
            saleQuantity: line.quantity,
            reasonCategory: "COUNT_DISCREPANCY",
            policyVersion: overridePolicyVersion,
          },
        });
        const reviewedAt = atManilaTime(date, "17:05");
        insertReview.run(
          stableId(`${spec.key}:override-review:${index + 1}`),
          overrideId,
          managerId,
          "Shelf recount was matched against the signed checkout note.",
          reviewedAt,
        );
        writeAudit(db, {
          actorUserId: managerId,
          action: "checkout.inventory_override_reviewed",
          entityType: "checkout_stock_override",
          entityId: overrideId,
          createdAt: reviewedAt,
          details: {
            status: "REVIEWED",
            note: "Shelf recount was matched against the signed checkout note.",
          },
        });
      }
    });
    sales.push({
      id: saleId,
      transactionId,
      date,
      createdAt,
      shiftId,
      cashierId,
      paymentMethod: spec.paymentMethod,
      total,
      lines,
      reverseInFull: spec.reverseInFull ?? false,
    });
    writeAudit(db, {
      actorUserId: cashierId,
      action: "sale.completed",
      entityType: "sale",
      entityId: saleId,
      createdAt,
      details: {
        transactionId,
        amountDueCentavos: total,
        paymentMethod: spec.paymentMethod,
        lineCount: lines.length,
      },
    });
  }
  return sales;
}

function insertReversal(
  db: Database.Database,
  sales: SeedSale[],
  managerId: string,
): void {
  const sale = sales.find((candidate) => candidate.reverseInFull);
  if (!sale) return;
  const reversalId = stableId("reversal-day-minus-2");
  if (
    db
      .prepare("SELECT 1 AS present FROM sale_reversals WHERE id = ?")
      .get(reversalId)
  )
    return;
  const createdAt = atManilaTime(sale.date, "15:10");
  const reversalTransactionId = `MTR-${sale.date.replaceAll("-", "")}-990001`;
  db.prepare(
    `INSERT INTO sale_reversals
      (id, reversal_transaction_id, sale_id, approved_by_user_id, reason,
       refund_method, amount_centavos, cash_shift_id, created_at, cash_rounding_adjustment_centavos)
     VALUES (?, ?, ?, ?, ?, 'CASH', ?, ?, ?, 0)`,
  ).run(
    reversalId,
    reversalTransactionId,
    sale.id,
    managerId,
    "Customer returned the unopened items with the original receipt.",
    sale.total,
    sale.shiftId,
    createdAt,
  );
  const insertLine = db.prepare(
    `INSERT INTO sale_reversal_lines
      (id, reversal_id, sale_line_id, product_id, quantity, refund_amount_centavos,
       stock_treatment, original_cogs_centavos, cogs_restored_centavos,
       writeoff_centavos, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'RESTOCK', ?, ?, 0, ?)`,
  );
  const insertEvent = db.prepare(
    `INSERT INTO stock_events
      (id, product_id, event_type, quantity_delta, unit_cost_centavos,
       inventory_value_delta_centavos, reference, reason, actor_user_id, created_at)
     VALUES (?, ?, 'REVERSAL', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMovement = db.prepare(
    `INSERT INTO lot_stock_movements
      (id, product_id, lot_id, movement_type, stock_event_id, reversal_line_id,
       quantity_delta, inventory_value_delta_centavos, unit_cost_centavos,
       actor_user_id, created_at)
     VALUES (?, ?, ?, 'REVERSAL', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateProduct = db.prepare(
    `UPDATE products
     SET quantity_on_hand = quantity_on_hand + ?,
         inventory_value_centavos = inventory_value_centavos + ?, updated_at = ?
     WHERE id = ?`,
  );
  sale.lines.forEach((line, index) => {
    const reversalLineId = stableId(`reversal-day-minus-2:line:${index + 1}`);
    const stockEventId = stableId(`reversal-day-minus-2:event:${index + 1}`);
    insertLine.run(
      reversalLineId,
      reversalId,
      line.id,
      line.product.id,
      line.quantity,
      line.amount,
      line.allocatedCogs,
      line.allocatedCogs,
      createdAt,
    );
    insertEvent.run(
      stockEventId,
      line.product.id,
      line.quantity,
      Math.round(line.allocatedCogs / line.quantity),
      line.allocatedCogs,
      reversalTransactionId,
      "Full customer return; unopened stock restored.",
      managerId,
      createdAt,
    );
    insertMovement.run(
      stableId(`reversal-day-minus-2:lot-movement:${index + 1}`),
      line.product.id,
      line.lotId,
      stockEventId,
      reversalLineId,
      line.quantity,
      line.allocatedCogs,
      Math.round(line.allocatedCogs / line.quantity),
      managerId,
      createdAt,
    );
    updateProduct.run(
      line.quantity,
      line.allocatedCogs,
      createdAt,
      line.product.id,
    );
  });
  db.prepare(
    `INSERT INTO cash_movements
      (id, shift_id, movement_type, amount_delta_centavos, reversal_id, reason, actor_user_id, created_at)
     VALUES (?, ?, 'CASH_REFUND', ?, ?, ?, ?, ?)`,
  ).run(
    stableId("reversal-day-minus-2:cash-movement"),
    sale.shiftId,
    -sale.total,
    reversalId,
    `Refund for ${sale.transactionId}`,
    managerId,
    createdAt,
  );
  db.prepare(
    `INSERT INTO reversal_sequences (business_date, next_number)
     VALUES (?, 990002)
     ON CONFLICT (business_date) DO UPDATE SET next_number = MAX(reversal_sequences.next_number, excluded.next_number)`,
  ).run(sale.date);
  writeAudit(db, {
    actorUserId: managerId,
    action: "sale.reversed",
    entityType: "sale_reversal",
    entityId: reversalId,
    createdAt,
    details: {
      transactionId: sale.transactionId,
      reversalTransactionId,
      amountCentavos: sale.total,
      lineCount: sale.lines.length,
      stockTreatment: "RESTOCK",
    },
  });
}

function insertExpenses(
  db: Database.Database,
  anchorDate: string,
  ids: Map<string, string>,
  shiftIds: Map<string, string>,
): void {
  const insertExpense = db.prepare(
    `INSERT OR IGNORE INTO expenses
      (id, request_id, business_date, category, amount_centavos, description,
       payment_source, included_in_unit_cost, product_amount_centavos,
       delivery_fee_centavos, supplier, invoice_reference, recorded_by_user_id,
       shift_id, cash_movement_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, '', '', ?, ?, ?, ?)`,
  );
  const insertMovement = db.prepare(
    `INSERT OR IGNORE INTO cash_movements
      (id, shift_id, movement_type, amount_delta_centavos, reversal_id, reason, actor_user_id, created_at)
     VALUES (?, ?, 'CASH_OUT', ?, NULL, ?, ?, ?)`,
  );
  for (const expense of expenseSpecs) {
    const id = stableId(expense.key);
    const movementId = expense.shiftKey
      ? stableId(`${expense.key}:cash-movement`)
      : null;
    const date = addDays(anchorDate, expense.dateOffset);
    const createdAt = atManilaTime(date, expense.time);
    const shiftId = expense.shiftKey ? shiftIds.get(expense.shiftKey) : null;
    const actorId = ids.get(expense.recordedBy)!;
    if (movementId && shiftId) {
      insertMovement.run(
        movementId,
        shiftId,
        -expense.amountCentavos,
        `Expense: ${expense.description}`,
        actorId,
        createdAt,
      );
    }
    insertExpense.run(
      id,
      stableId(`${expense.key}:request`),
      date,
      expense.category,
      expense.amountCentavos,
      expense.description,
      expense.paymentSource,
      actorId,
      shiftId,
      movementId,
      createdAt,
    );
    writeAudit(db, {
      actorUserId: actorId,
      action: "expense.recorded",
      entityType: "expense",
      entityId: id,
      createdAt,
      details: {
        category: expense.category,
        amountCentavos: expense.amountCentavos,
        businessDate: date,
        paymentSource: expense.paymentSource,
      },
    });
  }
}

function closeStaleOpenShifts(
  db: Database.Database,
  managerId: string,
  anchorDate: string,
): void {
  const openShifts = db
    .prepare(
      `SELECT id, cashier_user_id, opened_at, opening_cash_centavos,
              expected_cash_centavos
       FROM shifts WHERE closed_at IS NULL AND opened_at < ?`,
    )
    .all(atManilaTime(anchorDate, "00:00")) as Array<{
    id: string;
    cashier_user_id: string;
    opened_at: string;
    opening_cash_centavos: number;
    expected_cash_centavos: number | null;
  }>;
  for (const shift of openShifts) {
    const cashSales = db
      .prepare(
        `SELECT COALESCE(SUM(amount_due_centavos), 0) AS total
         FROM sales WHERE shift_id = ? AND payment_method = 'CASH'`,
      )
      .get(shift.id) as { total: number };
    const movements = db
      .prepare(
        "SELECT COALESCE(SUM(amount_delta_centavos), 0) AS total FROM cash_movements WHERE shift_id = ?",
      )
      .get(shift.id) as { total: number };
    const expectedCash =
      shift.expected_cash_centavos ??
      shift.opening_cash_centavos + cashSales.total + movements.total;
    const closedAt = atManilaTime(anchorDate, "00:10");
    db.prepare(
      `UPDATE shifts SET closed_at = ?, expected_cash_centavos = ?,
         actual_cash_count_centavos = ?, variance_centavos = 0,
         variance_reason = NULL, close_actor_user_id = ?,
         variance_approval_status = 'NONE', variance_approved_by_user_id = NULL,
         variance_approved_at = NULL, variance_approval_note = NULL
       WHERE id = ? AND closed_at IS NULL`,
    ).run(closedAt, expectedCash, expectedCash, managerId, shift.id);
    writeAudit(db, {
      actorUserId: managerId,
      action: "shift.closed",
      entityType: "shift",
      entityId: shift.id,
      createdAt: closedAt,
      details: {
        previousCashierUserId: shift.cashier_user_id,
        priorOpenedAt: shift.opened_at,
        expectedCashCentavos: expectedCash,
        actualCashCountCentavos: expectedCash,
        note: "Pre-demo open shift reconciled and closed at its expected cash balance.",
      },
    });
  }
}

function insertShifts(
  db: Database.Database,
  anchorDate: string,
  cashierId: string,
  managerId: string,
): Map<string, string> {
  const shiftDefinitions = [
    {
      key: "shift-day-minus-3",
      offset: -3,
      opening: 250000,
      openingTime: "08:00",
      closing: "18:10",
      open: false,
    },
    {
      key: "shift-day-minus-2",
      offset: -2,
      opening: 300000,
      openingTime: "08:00",
      closing: "18:05",
      open: false,
    },
    {
      key: "shift-day-minus-1",
      offset: -1,
      opening: 250000,
      openingTime: "08:00",
      closing: "18:20",
      open: false,
    },
    {
      key: "shift-today",
      offset: 0,
      opening: 300000,
      openingTime: "08:00",
      closing: "12:00",
      open: false,
    },
    {
      key: "shift-today-current",
      offset: 0,
      opening: 200000,
      openingTime: "13:00",
      closing: null,
      open: true,
    },
  ];
  const shiftIds = new Map<string, string>();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO shifts
      (id, cashier_user_id, opened_at, opening_cash_centavos, closed_at,
       expected_cash_centavos, actual_cash_count_centavos, variance_centavos,
       variance_reason, close_actor_user_id, variance_approval_status,
       variance_approved_by_user_id, variance_approved_at, variance_approval_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const shift of shiftDefinitions) {
    const id = stableId(shift.key);
    const date = addDays(anchorDate, shift.offset);
    const openedAt = atManilaTime(date, shift.openingTime);
    const closedAt = shift.closing ? atManilaTime(date, shift.closing) : null;
    let expectedCash = shift.opening;
    for (const sale of saleSpecs) {
      if (sale.shiftKey === shift.key && sale.paymentMethod === "CASH") {
        const total = sale.lines.reduce(
          (amount, line) =>
            amount +
            productBySku(db, line.sku).selling_price_centavos * line.quantity,
          0,
        );
        expectedCash += total;
        if (sale.reverseInFull) expectedCash -= total;
      }
    }
    for (const expense of expenseSpecs) {
      if (expense.shiftKey === shift.key)
        expectedCash -= expense.amountCentavos;
    }
    const isVarianceShift = shift.key === "shift-day-minus-1";
    const variance = isVarianceShift ? 5000 : 0;
    insert.run(
      id,
      cashierId,
      openedAt,
      shift.opening,
      closedAt,
      expectedCash,
      shift.open ? null : expectedCash + variance,
      shift.open ? null : variance,
      isVarianceShift
        ? "Till count was higher than the recorded close total."
        : null,
      shift.open ? null : cashierId,
      isVarianceShift ? "APPROVED" : "NONE",
      isVarianceShift ? managerId : null,
      isVarianceShift ? atManilaTime(date, "18:35") : null,
      isVarianceShift
        ? "Reviewed against the signed end-of-day count sheet."
        : null,
    );
    if (shift.key === "shift-today") {
      db.prepare(
        `UPDATE shifts SET opened_at = ?, closed_at = ?, expected_cash_centavos = ?,
           actual_cash_count_centavos = ?, variance_centavos = 0, variance_reason = NULL,
           close_actor_user_id = ?, variance_approval_status = 'NONE',
           variance_approved_by_user_id = NULL, variance_approved_at = NULL,
           variance_approval_note = NULL WHERE id = ?`,
      ).run(openedAt, closedAt, expectedCash, expectedCash, cashierId, id);
      db.prepare("UPDATE audit_events SET created_at = ? WHERE id = ?").run(
        closedAt,
        stableId(`audit:shift.closed:${id}`),
      );
    }
    if (shift.key === "shift-today-current") {
      db.prepare(
        `UPDATE shifts SET opened_at = ?, opening_cash_centavos = ?,
           expected_cash_centavos = ?, actual_cash_count_centavos = NULL,
           variance_centavos = NULL, variance_reason = NULL,
           close_actor_user_id = NULL, variance_approval_status = 'NONE',
           variance_approved_by_user_id = NULL, variance_approved_at = NULL,
           variance_approval_note = NULL WHERE id = ?`,
      ).run(openedAt, shift.opening, expectedCash, id);
      db.prepare("UPDATE audit_events SET created_at = ? WHERE id = ?").run(
        openedAt,
        stableId(`audit:shift.opened:${id}`),
      );
    }
    shiftIds.set(shift.key, id);
    writeAudit(db, {
      actorUserId: cashierId,
      action: shift.open ? "shift.opened" : "shift.closed",
      entityType: "shift",
      entityId: id,
      createdAt: closedAt ?? openedAt,
      details: {
        businessDate: date,
        openingCashCentavos: shift.opening,
        ...(shift.open
          ? {}
          : { expectedCashCentavos: expectedCash, varianceCentavos: variance }),
      },
    });
  }
  return shiftIds;
}

function insertDailyLedger(db: Database.Database, sales: SeedSale[]): void {
  const insertLedger = db.prepare(
    `INSERT OR IGNORE INTO daily_sales_ledger
      (source_sale_id, source_business_date, business_month, ledger_date,
       invoice_number, senior_discount_centavos, non_vat_centavos,
       vatable_sales_centavos, total_vat_centavos, gross_sales_centavos,
       net_sales_centavos)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, 0, ?, ?)`,
  );
  const dates = new Set<string>();
  for (const sale of sales) {
    const taxable = sale.lines.reduce((sum, line) => sum + line.amount, 0);
    insertLedger.run(
      sale.id,
      sale.date,
      sale.date.slice(0, 7),
      sale.date,
      sale.transactionId,
      taxable,
      taxable,
      taxable,
    );
    dates.add(sale.date);
  }

  const insertJournal = db.prepare(
    `INSERT INTO daily_sales_journal
      (source_business_date, business_month, journal_date, invoice_number_range,
       senior_discount_centavos, non_vat_centavos, vatable_sales_centavos,
       total_vat_centavos, gross_sales_centavos, net_sales_centavos)
     SELECT ?, substr(?, 1, 7), ?,
            CASE WHEN MIN(transaction_id) = MAX(transaction_id) THEN MIN(transaction_id)
                 ELSE MIN(transaction_id) || ' – ' || MAX(transaction_id) END,
            COALESCE(SUM(s.senior_discount_centavos), 0),
            COALESCE(SUM(CASE WHEN sl.tax_class_snapshot <> 'VATABLE' THEN sl.amount_due_centavos ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN sl.tax_class_snapshot = 'VATABLE' THEN sl.tax_basis_centavos ELSE 0 END), 0),
            COALESCE(SUM(sl.vat_centavos), 0),
            COALESCE(SUM(sl.quantity * sl.unit_price_centavos), 0),
            COALESCE(SUM(sl.amount_due_centavos - sl.vat_centavos), 0)
     FROM sales s JOIN sale_lines sl ON sl.sale_id = s.id
     WHERE s.business_date = ?
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
  for (const date of dates) insertJournal.run(date, date, date, date);
}

function updateSaleSequences(db: Database.Database): void {
  const dates = db
    .prepare(
      "SELECT DISTINCT business_date FROM sales WHERE transaction_id GLOB 'MTX-[0-9]*-99*'",
    )
    .all() as Array<{ business_date: string }>;
  const update = db.prepare(
    `INSERT INTO sale_sequences (business_date, next_number)
     VALUES (?, ?)
     ON CONFLICT (business_date) DO UPDATE SET next_number = MAX(sale_sequences.next_number, excluded.next_number)`,
  );
  for (const { business_date: date } of dates) {
    const rows = db
      .prepare("SELECT transaction_id FROM sales WHERE business_date = ?")
      .all(date) as Array<{ transaction_id: string }>;
    const max = rows.reduce((value, row) => {
      const match = row.transaction_id.match(/^MTX-\d{8}-(\d{6})$/);
      return match ? Math.max(value, Number(match[1])) : value;
    }, 0);
    if (max >= 990001) update.run(date, max + 1);
  }
}

function insertSeedMarker(db: Database.Database, anchorDate: string): void {
  const now = atManilaTime(anchorDate, "00:01");
  db.prepare(
    `INSERT OR IGNORE INTO audit_events
      (id, actor_user_id, action, entity_type, entity_id, details_json, created_at)
     VALUES (?, NULL, 'demo.portfolio_seeded', 'demo_seed', ?, ?, ?)`,
  ).run(
    seedMarkerId,
    seedVersion,
    JSON.stringify({ anchorDate, version: seedVersion }),
    now,
  );
  db.prepare("UPDATE audit_events SET created_at = ? WHERE id = ?").run(
    now,
    seedMarkerId,
  );
}

function printSummary(
  before: Map<string, number>,
  after: Map<string, number>,
): void {
  process.stdout.write("\nDevelopment database row counts (before → after)\n");
  process.stdout.write("table\tbefore\tadded\tafter\n");
  for (const [table, count] of after) {
    const previous = before.get(table) ?? 0;
    process.stdout.write(
      `${table}\t${previous}\t${count - previous}\t${count}\n`,
    );
  }
}

async function main(): Promise<void> {
  // Always target the repository's development database for this portfolio-only seed.
  const db = openDatabase("development", resolve(repositoryRoot, "data"));
  try {
    const before = tableCounts(db);
    const priorAnchor = existingAnchorDate(db);
    const anchorDate = priorAnchor ?? manilaCalendarDate();
    const ids = await ensureDemoAccounts(db, anchorDate);
    const ownerId = ids.get("owner")!;
    const managerId = ids.get("manager")!;
    const cashierId = ids.get("cashier")!;
    db.transaction(() => {
      closeStaleOpenShifts(db, managerId, anchorDate);
    })();
    const shifts = insertShifts(db, anchorDate, cashierId, managerId);

    db.transaction(() => {
      insertSeedMarker(db, anchorDate);
      insertReceipts(db, anchorDate, ownerId);
      insertBundles(db, anchorDate, ownerId);
      insertExpenses(db, anchorDate, ids, shifts);
      ensureStoreProfile(db, managerId, anchorDate);
      enableCheckoutCountOverrides(db, managerId, anchorDate);
      const sales = insertSales(db, anchorDate, cashierId, managerId, shifts);
      insertReversal(db, sales, managerId);
      insertDailyLedger(db, sales);
      updateSaleSequences(db);
    })();

    const issues = lotLedgerIssues(db);
    if (issues.length > 0) {
      throw new Error(
        `Inventory lot ledger does not reconcile for products: ${issues.join(", ")}`,
      );
    }
    const after = tableCounts(db);
    process.stdout.write(
      `Demo seed complete for ${anchorDate} in data/development.sqlite. Accounts: owner, manager, cashier. Inventory ledger reconciles.\n`,
    );
    printSummary(before, after);
  } finally {
    db.close();
  }
}

await main();
