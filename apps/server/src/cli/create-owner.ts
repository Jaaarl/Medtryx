import "../config.js";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { createUserSchema } from "@medtryx/shared";
import { openDatabase, selectedEnvironment, writeAuditEvent } from "../db.js";

const email = process.env.MEDTRYX_OWNER_EMAIL;
const username = process.env.MEDTRYX_OWNER_USERNAME;
const password = process.env.MEDTRYX_OWNER_PASSWORD;
const parsed = createUserSchema.safeParse({
  email,
  username,
  password,
  role: "owner",
});
if (!parsed.success) {
  process.stderr.write(
    "Set MEDTRYX_OWNER_EMAIL and a unique MEDTRYX_OWNER_PASSWORD (8 to 128 characters); MEDTRYX_OWNER_USERNAME is optional.\n",
  );
  process.exit(1);
}

const db = openDatabase();
try {
  const count = db.prepare("SELECT COUNT(*) AS count FROM users").get() as {
    count: number;
  };
  if (count.count !== 0) {
    process.stderr.write(
      "Owner bootstrap is disabled because this environment already has users.\n",
    );
    process.exitCode = 1;
  } else {
    const id = randomUUID();
    const now = new Date().toISOString();
    const usernameValue = (
      parsed.data.username ??
      parsed.data.email.slice(0, parsed.data.email.indexOf("@")).slice(0, 64)
    ).toLowerCase();
    const passwordHash = await argon2.hash(parsed.data.password, {
      type: argon2.argon2id,
    });
    const emailValue = parsed.data.email.trim().toLowerCase();
    db.transaction(() => {
      db.prepare(
        "INSERT INTO users (id, email, username, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 'owner', 1, ?, ?)",
      ).run(id, emailValue, usernameValue, passwordHash, now, now);
      writeAuditEvent(db, {
        actorUserId: id,
        action: "user.owner_bootstrapped",
        entityType: "user",
        entityId: id,
      });
    })();
    process.stdout.write(
      `Owner account created in ${selectedEnvironment()} environment.\n`,
    );
  }
} finally {
  db.close();
}
