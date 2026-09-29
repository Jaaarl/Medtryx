import argon2 from "argon2";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { restoreBackup } from "./backup-service.js";
import {
  customerEncryptionKeyHex,
  decryptCustomerField,
} from "./customer-data.js";
import { openDatabase } from "./db.js";
import {
  clearBnpcLedgerForTest,
  clearBundleLedgerForTest,
  clearLotLedgerForTest,
} from "./test-ledger.js";

process.env.APP_ENV = "test";
process.env.COOKIE_SECURE = "false";
process.env.CUSTOMER_ID_ENCRYPTION_KEY = "e5".repeat(32);

const ownerPassword = "SyntheticBackupOwner-98!";
const cashierPassword = "SyntheticBackupCashier-87!";
let dataDirectory: string;
let backupDirectory: string;
let primaryDirectory: string;
let secondaryDirectory: string;
let db: ReturnType<typeof openDatabase>;
let app: ReturnType<typeof createApp>;
let ownerHash: string;
let cashierHash: string;

type Agent = ReturnType<typeof request.agent>;

async function signIn(email: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const csrf = await agent.get("/api/auth/csrf");
  const response = await agent
    .post("/api/auth/login")
    .set("x-csrf-token", csrf.body.token as string)
    .send({ email, password });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return agent;
}

async function postWithCsrf(
  agent: Agent,
  path: string,
  body: Record<string, unknown>,
) {
  const csrf = (await agent.get("/api/auth/csrf")).body.token as string;
  return agent.post(`/api${path}`).set("x-csrf-token", csrf).send(body);
}

function manilaDayAfter(days: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const today = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  const date = new Date(
    `${today.year}-${today.month}-${today.day}T00:00:00.000Z`,
  );
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

beforeAll(async () => {
  dataDirectory = mkdtempSync(join(tmpdir(), "medtryx-backup-db-"));
  backupDirectory = mkdtempSync(join(tmpdir(), "medtryx-backup-files-"));
  primaryDirectory = join(backupDirectory, "primary");
  secondaryDirectory = join(backupDirectory, "secondary");
  mkdirSync(primaryDirectory);
  mkdirSync(secondaryDirectory);
  process.env.MEDTRYX_BACKUP_PRIMARY_DIR = primaryDirectory;
  process.env.MEDTRYX_BACKUP_SECONDARY_DIR = secondaryDirectory;
  db = openDatabase("test", dataDirectory);
  app = createApp(db);
  ownerHash = await argon2.hash(ownerPassword, { type: argon2.argon2id });
  cashierHash = await argon2.hash(cashierPassword, { type: argon2.argon2id });
});

beforeEach(() => {
  clearBnpcLedgerForTest(db);
  clearBundleLedgerForTest(db);
  clearLotLedgerForTest(db);
  for (const path of [primaryDirectory, secondaryDirectory]) {
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path);
  }
  db.exec(
    `DELETE FROM sale_reversal_lines;
     DELETE FROM cash_movements;
     DELETE FROM sale_reversals;
     DELETE FROM reversal_sequences;
     DELETE FROM sale_lines;
     DELETE FROM sales;
     DELETE FROM shifts;
     DELETE FROM stock_events;
     DELETE FROM products;
     DELETE FROM product_sku_sequence;
     DELETE FROM sale_sequences;
     DELETE FROM settings;
     DELETE FROM audit_events;
     DELETE FROM sessions;
     DELETE FROM users;`,
  );
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users
       (id, email, password_hash, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 'owner', 1, ?, ?), (?, ?, ?, 'cashier', 1, ?, ?)`,
  ).run(
    randomUUID(),
    "owner.backups@example.test",
    ownerHash,
    now,
    now,
    randomUUID(),
    "cashier.backups@example.test",
    cashierHash,
    now,
    now,
  );
});

afterAll(() => {
  db.close();
  rmSync(dataDirectory, { recursive: true, force: true });
  rmSync(backupDirectory, { recursive: true, force: true });
  delete process.env.MEDTRYX_BACKUP_PRIMARY_DIR;
  delete process.env.MEDTRYX_BACKUP_SECONDARY_DIR;
});

describe("owner-only verified backup and restore", () => {
  it("writes two restricted copies and restores saved stock, sales, customer data, and sessions", async () => {
    const owner = await signIn("owner.backups@example.test", ownerPassword);
    const cashier = await signIn(
      "cashier.backups@example.test",
      cashierPassword,
    );
    expect((await cashier.get("/api/backups/status")).status).toBe(403);
    expect((await cashier.get("/api/backups")).status).toBe(403);
    expect((await postWithCsrf(cashier, "/backups", {})).status).toBe(403);

    const profileCsrf = (await owner.get("/api/auth/csrf")).body
      .token as string;
    const profileResponse = await owner
      .put("/api/settings/store-profile")
      .set("x-csrf-token", profileCsrf)
      .send({ name: "Synthetic Backup Pharmacy" });
    expect(profileResponse.status, JSON.stringify(profileResponse.body)).toBe(
      200,
    );
    const storeId = profileResponse.body.profile.id as string;
    expect((await owner.get("/api/backups/status")).body.status.ready).toBe(
      true,
    );
    const policy = await postWithCsrf(owner, "/settings/tax-policy", {
      confirmApproved: true,
      version: "SYNTHETIC-BACKUP-TAX",
      vatRateBasisPoints: 1_200,
      seniorDiscountBasisPoints: 2_000,
      pwdDiscountBasisPoints: 2_000,
      vatInclusivePrices: true,
      allowZeroRated: false,
      roundingMode: "HALF_UP",
      approvalReference: "Synthetic backup test policy only",
      costBasisDescription: "Synthetic weighted-average acquisition cost",
    });
    expect(policy.status).toBe(200);
    const bnpcPolicy = await postWithCsrf(owner, "/settings/bnpc-policy", {
      version: "SYNTHETIC-BACKUP-BNPC-V1",
      effectiveFrom: "2024-03-25",
      sourceTitle: "Synthetic backup review of JAO No. 24-02",
      sourceUrl:
        "https://ncda.gov.ph/wp-content/uploads/2024/04/JAO-DTI-DA-DOE-No.-240-02-S2024.pdf",
      reviewedAt: manilaDayAfter(0),
      discountRateBasisPoints: 500,
      weeklyPurchaseLimit: "2500.00",
      weeklyDiscountLimit: "125.00",
      noCarryover: true,
      minimumKindsAtPurchaseLimit: 4,
      storeEligibilityConfirmed: true,
      approvalReference: "Synthetic backup/accountant approval",
      enabled: true,
      confirmOwnerReview: true,
      confirmAccountantApproval: true,
    });
    expect(bnpcPolicy.status, JSON.stringify(bnpcPolicy.body)).toBe(201);
    const productResponse = await postWithCsrf(owner, "/products", {
      sku: "SYN-BACKUP-001",
      name: "Synthetic backup medicine",
      unit: "piece",
      sellingPrice: "112.00",
      taxClass: "VATABLE",
      productType: "BRANDED",
      isScEligible: true,
      isPwdEligible: true,
      openingQuantity: 4,
      openingUnitCost: "35.00",
      reorderLevel: 4,
    });
    expect(productResponse.status).toBe(201);
    const productId = productResponse.body.product.id as string;
    const shift = await postWithCsrf(cashier, "/shifts", {
      openingCash: "50.00",
    });
    expect(shift.status).toBe(201);
    const saleResponse = await postWithCsrf(cashier, "/sales", {
      benefitType: "PWD",
      items: [{ productId, quantity: 1, benefitApplied: true }],
      paymentMethod: "CASH",
      requestKey: randomUUID(),
      customerName: "SYNTHETIC RESTORE CUSTOMER",
      customerIdType: "Synthetic ID",
      customerIdNumber: "SYN-RESTORE-ID-4432",
      customerIdChecked: true,
    });
    expect(saleResponse.status, JSON.stringify(saleResponse.body)).toBe(201);
    const sale = saleResponse.body.sale as {
      transactionId: string;
      businessDate: string;
    };
    const bnpcProductResponse = await postWithCsrf(owner, "/products", {
      sku: "SYN-BACKUP-BNPC-001",
      name: "Synthetic backup BNPC item",
      unit: "piece",
      sellingPrice: "112.00",
      taxClass: "VATABLE",
      productType: "GENERIC",
      isScEligible: false,
      isPwdEligible: false,
      bnpcEligible: true,
      bnpcPrescriptionRequired: true,
      bnpcCategory: "BASIC_NECESSITY",
      bnpcSource: "Synthetic DTI/DA covered-goods list review",
      bnpcReviewReference: "Synthetic backup classification BNPC-01",
      openingQuantity: 4,
      openingUnitCost: "40.00",
    });
    expect(bnpcProductResponse.status).toBe(201);
    const bnpcProductId = bnpcProductResponse.body.product.id as string;
    const bnpcSaleResponse = await postWithCsrf(cashier, "/sales", {
      benefitType: "PWD",
      items: [
        { productId: bnpcProductId, quantity: 1, benefitTreatment: "BNPC" },
      ],
      paymentMethod: "QR",
      requestKey: randomUUID(),
      customerName: "SYNTHETIC BNPC RESTORE CUSTOMER",
      customerIdType: "Synthetic PWD ID",
      customerIdNumber: "SYN-BNPC-RESTORE-ID-6621",
      customerIdChecked: true,
      bnpcChecks: {
        bookletChecked: true,
        priorPurchaseConfirmed: true,
        externalPurchaseAmount: "0.00",
        externalDiscountUsedAmount: "0.00",
        representativePurchase: false,
        representativeDocumentsChecked: false,
        authorizationLetterIssuedDate: null,
        prescriptionApplicable: true,
        prescriptionChecked: true,
        fourKindsChecked: false,
      },
    });
    expect(bnpcSaleResponse.status, JSON.stringify(bnpcSaleResponse.body)).toBe(
      201,
    );
    const bnpcSale = bnpcSaleResponse.body.sale as {
      id: string;
      transactionId: string;
      bnpcDiscount: string;
    };
    expect(bnpcSale.bnpcDiscount).toBe("5.60");
    const trackedProductResponse = await postWithCsrf(owner, "/products", {
      sku: "SYN-BACKUP-LOT-001",
      name: "Synthetic tracked backup item",
      unit: "piece",
      sellingPrice: "20.00",
      taxClass: "VAT_EXEMPT",
      productType: "GENERIC",
      isScEligible: false,
      isPwdEligible: false,
      tracksLots: true,
      openingQuantity: 2,
      openingUnitCost: "12.00",
      openingLotCode: "SYN-BACKUP-BATCH",
      openingExpiryDate: manilaDayAfter(30),
    });
    expect(trackedProductResponse.status).toBe(201);
    const trackedProductId = trackedProductResponse.body.product.id as string;

    const bundleResponse = await postWithCsrf(owner, "/bundles", {
      code: "SYN-BACKUP-BUNDLE",
      name: "Synthetic backup bundle",
      activeFrom: manilaDayAfter(0),
      activeUntil: null,
      maxQuantityPerSale: null,
      reductionType: "AMOUNT",
      reductionValue: 100,
      promotionalPrice: "131.00",
      confirmFinalPrice: true,
      components: [
        { productId: trackedProductId, quantity: 1 },
        { productId, quantity: 1 },
      ],
    });
    expect(bundleResponse.status, JSON.stringify(bundleResponse.body)).toBe(
      201,
    );
    const bundleVersionId = bundleResponse.body.bundle.versionId as string;
    const bundleOfferKey = randomUUID();
    const bundlePreview = await postWithCsrf(cashier, "/sales/preview", {
      benefitType: "REGULAR",
      paymentMethod: "QR",
      items: [],
      bundleOffers: [
        {
          offerKey: bundleOfferKey,
          bundleVersionId,
          quantity: 1,
          components: [{ productId: trackedProductId }, { productId }],
        },
      ],
    });
    expect(bundlePreview.status, JSON.stringify(bundlePreview.body)).toBe(200);
    const bundleLotPick = (
      bundlePreview.body.lines[0].assignedLots as Array<{
        lotId: string;
        quantity: number;
      }>
    ).map(({ lotId, quantity }) => ({ lotId, quantity }));
    const bundleSaleResponse = await postWithCsrf(cashier, "/sales", {
      benefitType: "REGULAR",
      paymentMethod: "QR",
      requestKey: randomUUID(),
      items: [],
      bundleOffers: [
        {
          offerKey: bundleOfferKey,
          bundleVersionId,
          quantity: 1,
          components: [
            {
              productId: trackedProductId,
              lotAllocations: bundleLotPick,
              lotPickConfirmed: true,
            },
            { productId },
          ],
        },
      ],
    });
    expect(
      bundleSaleResponse.status,
      JSON.stringify(bundleSaleResponse.body),
    ).toBe(201);
    const bundleSale = bundleSaleResponse.body.sale as {
      transactionId: string;
    };

    const backupResponse = await postWithCsrf(owner, "/backups", {});
    expect(backupResponse.status, JSON.stringify(backupResponse.body)).toBe(
      201,
    );
    const backup = backupResponse.body.backup as {
      backupId: string;
      copies: Array<{ location: string; valid: boolean }>;
      store: { id: string; name: string };
    };
    expect(backup).toMatchObject({
      store: { id: storeId, name: "Synthetic Backup Pharmacy" },
      copies: [
        { location: "primary", valid: true },
        { location: "secondary", valid: true },
      ],
    });
    const primaryPackage = join(primaryDirectory, "test", backup.backupId);
    const secondaryPackage = join(secondaryDirectory, "test", backup.backupId);
    expect(
      readFileSync(join(primaryPackage, "store.sqlite"))
        .subarray(0, 16)
        .toString("utf8"),
    ).toBe("SQLite format 3\u0000");
    expect(
      readFileSync(
        join(primaryPackage, "customer-id-encryption-key.txt"),
        "utf8",
      ).trim(),
    ).toBe(process.env.CUSTOMER_ID_ENCRYPTION_KEY);
    expect(
      readFileSync(join(primaryPackage, "store.sqlite")).equals(
        readFileSync(join(secondaryPackage, "store.sqlite")),
      ),
    ).toBe(true);
    if (process.platform === "win32") {
      const acl = execFileSync("icacls.exe", [primaryPackage], {
        encoding: "utf8",
      }).toLowerCase();
      const account = execFileSync("whoami.exe", [], {
        encoding: "utf8",
      })
        .trim()
        .toLowerCase();
      expect(acl).toContain(account);
      expect(acl).toContain("system");
      expect(acl).toContain("administrators");
      expect(acl).not.toMatch(/everyone|authenticated users|\\users:/);
    } else {
      expect(statSync(primaryPackage).mode & 0o777).toBe(0o700);
      expect(
        statSync(join(primaryPackage, "customer-id-encryption-key.txt")).mode &
          0o777,
      ).toBe(0o600);
    }
    expect((await cashier.post("/api/backups/restore").send({})).status).toBe(
      403,
    );

    const productCsrf = (await owner.get("/api/auth/csrf")).body
      .token as string;
    const changedProduct = await owner
      .patch(`/api/products/${productId}`)
      .set("x-csrf-token", productCsrf)
      .send({ name: "Changed after backup", sellingPrice: "120.00" });
    expect(changedProduct.status).toBe(200);

    const failedReauth = await postWithCsrf(owner, "/backups/restore", {
      backupId: backup.backupId,
      location: "secondary",
      confirmStoreId: storeId,
      ownerPassword: "NotTheOwnerPassword",
    });
    expect(failedReauth.status).toBe(403);
    expect(failedReauth.body.error).toBe("reauthentication_failed");

    const restore = await postWithCsrf(owner, "/backups/restore", {
      backupId: backup.backupId,
      location: "secondary",
      confirmStoreId: storeId,
      ownerPassword,
    });
    expect(restore.status, JSON.stringify(restore.body)).toBe(200);
    expect(restore.body).toMatchObject({
      backup: { backupId: backup.backupId, store: { id: storeId } },
      reauthenticationRequired: true,
    });
    expect(restore.body.safetyBackupId).toMatch(/[0-9a-f-]{36}/);
    expect((await owner.get("/api/auth/me")).status).toBe(401);

    const signedInOwner = await signIn(
      "owner.backups@example.test",
      ownerPassword,
    );
    const restoredProduct = db
      .prepare(
        "SELECT name, selling_price_centavos, quantity_on_hand, inventory_value_centavos FROM products WHERE id = ?",
      )
      .get(productId);
    expect(restoredProduct).toEqual({
      name: "Synthetic backup medicine",
      selling_price_centavos: 11_200,
      quantity_on_hand: 2,
      inventory_value_centavos: 7_000,
    });
    const restoredLot = db
      .prepare(
        `SELECT l.id, l.lot_code, l.expiry_date,
                sum(m.quantity_delta) AS quantity
         FROM inventory_lots l JOIN lot_stock_movements m ON m.lot_id = l.id
         WHERE l.product_id = ? GROUP BY l.id`,
      )
      .get(trackedProductId);
    expect(restoredLot).toMatchObject({
      lot_code: "SYN-BACKUP-BATCH",
      expiry_date: manilaDayAfter(30),
      quantity: 1,
    });
    const restoredLotId = db
      .prepare("SELECT id FROM inventory_lots WHERE product_id = ?")
      .get(trackedProductId) as { id: string };
    expect(() =>
      db
        .prepare(
          `INSERT INTO lot_stock_movements
          (id, product_id, lot_id, movement_type, quantity_delta,
           inventory_value_delta_centavos, reason, created_at)
         VALUES (?, ?, ?, 'ADJUSTMENT', -3, 0, ?, ?)`,
        )
        .run(
          randomUUID(),
          trackedProductId,
          restoredLotId.id,
          "Synthetic restored-balance guard check",
          new Date().toISOString(),
        ),
    ).toThrow(/lot_stock_balance_cannot_be_negative/u);
    const restoredSale = await signedInOwner.get(
      `/api/sales/${sale.transactionId}`,
    );
    expect(restoredSale.status).toBe(200);
    expect(restoredSale.body.sale.lines[0].cogs).toBe("35.00");
    const restoredBundleSale = await signedInOwner.get(
      `/api/sales/${bundleSale.transactionId}`,
    );
    expect(restoredBundleSale.status).toBe(200);
    expect(restoredBundleSale.body.sale.lines[0]).toMatchObject({
      productName: "Synthetic tracked backup item",
      bundle: {
        code: "SYN-BACKUP-BUNDLE",
        name: "Synthetic backup bundle",
        version: 1,
      },
      lotAllocations: [
        expect.objectContaining({ lotCode: "SYN-BACKUP-BATCH" }),
      ],
    });
    expect(
      (
        db
          .prepare(
            "SELECT promotional_discount_applied_centavos FROM sale_bundle_snapshots WHERE sale_id = (SELECT id FROM sales WHERE transaction_id = ?)",
          )
          .get(bundleSale.transactionId) as {
          promotional_discount_applied_centavos: number;
        }
      ).promotional_discount_applied_centavos,
    ).toBe(100);
    expect(
      (
        db
          .prepare(
            "SELECT count(*) AS count FROM sales_bundle_versions WHERE bundle_id = (SELECT id FROM sales_bundles WHERE code = 'SYN-BACKUP-BUNDLE')",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    expect(() =>
      db
        .prepare(
          "UPDATE sales_bundle_versions SET name_snapshot = 'tampered' WHERE bundle_id = (SELECT id FROM sales_bundles WHERE code = 'SYN-BACKUP-BUNDLE')",
        )
        .run(),
    ).toThrow(/sales_bundle_versions_are_immutable/u);
    expect(() =>
      db
        .prepare(
          "UPDATE sale_bundle_snapshots SET name_snapshot = 'tampered' WHERE sale_id = (SELECT id FROM sales WHERE transaction_id = ?)",
        )
        .run(bundleSale.transactionId),
    ).toThrow(/sale_bundle_snapshots_are_immutable/u);
    const restoredBnpcSale = await signedInOwner.get(
      `/api/sales/${bnpcSale.transactionId}`,
    );
    expect(restoredBnpcSale.status).toBe(200);
    expect(restoredBnpcSale.body.sale).toMatchObject({
      bnpcDiscount: "5.60",
      lines: [
        expect.objectContaining({
          benefitTreatment: "BNPC",
          bnpcEligible: true,
          bnpcCategory: "BASIC_NECESSITY",
          bnpcPrescriptionRequired: true,
          bnpcDiscount: "5.60",
          bnpcPolicyVersion: "SYNTHETIC-BACKUP-BNPC-V1",
        }),
      ],
    });
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM bnpc_usage_events WHERE sale_id = ?",
          )
          .get(bnpcSale.id) as { count: number }
      ).count,
    ).toBe(1);
    expect(() =>
      db
        .prepare("UPDATE bnpc_policy_versions SET enabled = 0 WHERE id = ?")
        .run(
          (
            db
              .prepare(
                "SELECT bnpc_policy_version_id FROM sale_bnpc_snapshots WHERE sale_id = ?",
              )
              .get(bnpcSale.id) as
              | { bnpc_policy_version_id: string }
              | undefined
          )?.bnpc_policy_version_id,
        ),
    ).toThrow(/bnpc_policy_versions_are_immutable/u);
    expect(() =>
      db
        .prepare("DELETE FROM bnpc_usage_events WHERE sale_id = ?")
        .run(bnpcSale.id),
    ).toThrow(/bnpc_usage_events_are_append_only/u);
    const customer = await signedInOwner.get(
      `/api/sales/${sale.transactionId}/customer`,
    );
    expect(customer.status).toBe(200);
    expect(customer.body.customer).toMatchObject({
      name: "SYNTHETIC RESTORE CUSTOMER",
      idNumber: "SYN-RESTORE-ID-4432",
    });
    const report = await signedInOwner.get(
      `/api/reports/daily?date=${sale.businessDate}`,
    );
    expect(report.body.report.metrics.grossSales).toBe("356.00");
    expect(report.body.report.metrics.bnpcDiscounts).toBe("5.60");
    expect(report.body.report.metrics.bundlePromotionalDiscounts).toBe("1.00");
    expect(report.body.report.inventory.inventoryValue).toBe("202.00");
    const restoredBackups = await signedInOwner.get("/api/backups");
    expect(restoredBackups.body.backups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          purpose: "manual",
          backupId: backup.backupId,
        }),
        expect.objectContaining({
          purpose: "safety",
          backupId: restore.body.safetyBackupId,
        }),
      ]),
    );
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);

    const cleanInstallDirectory = mkdtempSync(
      join(tmpdir(), "medtryx-clean-restore-test-"),
    );
    const cleanInstallDb = openDatabase("test", cleanInstallDirectory);
    const keyDirectory = join(cleanInstallDirectory, "secrets");
    mkdirSync(keyDirectory);
    const keyFile = join(keyDirectory, "customer-data.key");
    writeFileSync(keyFile, "f6".repeat(32));
    try {
      const cleanOwnerId = randomUUID();
      const cleanStoreId = randomUUID();
      const now = new Date().toISOString();
      cleanInstallDb
        .prepare(
          `INSERT INTO users
             (id, email, password_hash, role, is_active, created_at, updated_at)
           VALUES (?, ?, ?, 'owner', 1, ?, ?)`,
        )
        .run(
          cleanOwnerId,
          "owner.clean-restore@example.test",
          ownerHash,
          now,
          now,
        );
      cleanInstallDb
        .prepare(
          `INSERT INTO settings (key, value_json, updated_at, updated_by)
           VALUES ('store_profile', ?, ?, ?)`,
        )
        .run(
          JSON.stringify({ id: cleanStoreId, name: "Synthetic Clean Target" }),
          now,
          cleanOwnerId,
        );
      process.env.CUSTOMER_ID_ENCRYPTION_KEY_FILE = keyFile;
      const cleanRestore = await restoreBackup(cleanInstallDb, {
        backupId: backup.backupId,
        location: "primary",
        confirmStoreId: storeId,
        actorUserId: cleanOwnerId,
        actorEmail: "owner.clean-restore@example.test",
      });
      expect(cleanRestore.backup.store).toEqual({
        id: storeId,
        name: "Synthetic Backup Pharmacy",
      });
      expect(
        (
          cleanInstallDb
            .prepare("SELECT COUNT(*) AS count FROM sales")
            .get() as { count: number }
        ).count,
      ).toBe(3);
      expect(
        (
          cleanInstallDb
            .prepare("SELECT COUNT(*) AS count FROM sale_bundle_snapshots")
            .get() as { count: number }
        ).count,
      ).toBe(1);
      expect(
        cleanInstallDb
          .prepare(
            "SELECT quantity_on_hand, inventory_value_centavos FROM products WHERE id = ?",
          )
          .get(productId),
      ).toEqual({ quantity_on_hand: 2, inventory_value_centavos: 7_000 });
      expect(
        (
          cleanInstallDb
            .prepare("SELECT COUNT(*) AS count FROM sessions")
            .get() as { count: number }
        ).count,
      ).toBe(0);
      expect(customerEncryptionKeyHex()).toBe("e5".repeat(32));
      const encryptedCustomer = cleanInstallDb
        .prepare(
          "SELECT id, customer_name_ciphertext FROM sales WHERE customer_name_ciphertext IS NOT NULL",
        )
        .get() as { id: string; customer_name_ciphertext: string };
      expect(
        decryptCustomerField(
          encryptedCustomer.customer_name_ciphertext,
          `${encryptedCustomer.id}/name`,
        ),
      ).toBe("SYNTHETIC RESTORE CUSTOMER");
    } finally {
      delete process.env.CUSTOMER_ID_ENCRYPTION_KEY_FILE;
      cleanInstallDb.close();
      rmSync(cleanInstallDirectory, { recursive: true, force: true });
    }
  });
});
