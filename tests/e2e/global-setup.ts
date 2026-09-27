import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../../apps/server/src/db.js";

export default async function globalSetup(): Promise<void> {
  process.env.APP_ENV = "test";
  const db = openDatabase("test");
  try {
    db.exec(
      "DELETE FROM audit_events; DELETE FROM sessions; DELETE FROM users;",
    );
    const now = new Date().toISOString();
    const passwordHash = await argon2.hash("SyntheticOwnerPassword-48!", {
      type: argon2.argon2id,
    });
    const cashierHash = await argon2.hash("SyntheticCashierPassword-72!", {
      type: argon2.argon2id,
    });
    const seed = db.transaction(() => {
      for (const user of [
        {
          id: randomUUID(),
          email: "owner@example.test",
          passwordHash,
          role: "owner",
        },
        {
          id: randomUUID(),
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
  } finally {
    db.close();
  }
}
