import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../../apps/server/src/db.js";
import {
  clearBundleLedgerForTest,
  clearLotLedgerForTest,
} from "../../apps/server/src/test-ledger.js";

export default async function globalSetup(): Promise<void> {
  process.env.APP_ENV = "test";
  const db = openDatabase("test");
  try {
    clearBundleLedgerForTest(db);
    clearLotLedgerForTest(db);
    db.exec(
      "DELETE FROM sale_reversal_lines; DELETE FROM cash_movements; DELETE FROM sale_reversals; DELETE FROM reversal_sequences; DELETE FROM sale_lines; DELETE FROM sales; DELETE FROM shifts; DELETE FROM stock_events; DELETE FROM products; DELETE FROM product_sku_sequence; DELETE FROM sale_sequences; DELETE FROM settings; DELETE FROM audit_events; DELETE FROM sessions; DELETE FROM users;",
    );
    const now = new Date().toISOString();
    const passwordHash = await argon2.hash("SyntheticOwnerPassword-48!", {
      type: argon2.argon2id,
    });
    const cashierHash = await argon2.hash("SyntheticCashierPassword-72!", {
      type: argon2.argon2id,
    });
    const ownerId = randomUUID();
    const cashierId = randomUUID();
    const seed = db.transaction(() => {
      for (const user of [
        {
          id: ownerId,
          email: "owner@example.test",
          passwordHash,
          role: "owner",
        },
        {
          id: cashierId,
          email: "cashier@example.test",
          passwordHash: cashierHash,
          role: "cashier",
        },
      ]) {
        db.prepare(
          "INSERT INTO users (id, email, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
        ).run(user.id, user.email, user.passwordHash, user.role, now, now);
      }
    });
    seed();
    db.prepare(
      "INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES ('tax', ?, ?, ?)",
    ).run(
      JSON.stringify({
        approved: true,
        version: "SYNTHETIC-E2E-TAX-12-HALF-UP",
        vatRateBasisPoints: 1_200,
        seniorDiscountBasisPoints: 2_000,
        pwdDiscountBasisPoints: 2_000,
        vatInclusivePrices: true,
        allowZeroRated: false,
        roundingMode: "HALF_UP",
        approvalReference: "Synthetic browser-test policy; not a real approval",
        costBasisDescription:
          "Synthetic acquisition costs for browser tests only",
        approvedAt: now,
        approvedBy: ownerId,
      }),
      now,
      ownerId,
    );
  } finally {
    db.close();
  }
}
