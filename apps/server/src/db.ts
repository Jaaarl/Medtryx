import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type AppEnvironment = "development" | "test" | "live";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../",
);
const migrationsDirectory = resolve(repositoryRoot, "database/migrations");

export function selectedEnvironment(): AppEnvironment {
  const configured = process.env.APP_ENV;
  if (
    configured === "development" ||
    configured === "test" ||
    configured === "live"
  ) {
    return configured;
  }
  if (configured)
    throw new Error("APP_ENV must be development, test, or live.");
  if (process.env.NODE_ENV === "production") return "live";
  if (process.env.NODE_ENV === "test") return "test";
  return "development";
}

export function openDatabase(
  environment: AppEnvironment = selectedEnvironment(),
  baseDirectory = resolve(repositoryRoot, "data"),
): Database.Database {
  mkdirSync(baseDirectory, { recursive: true });
  const db = new Database(resolve(baseDirectory, `${environment}.sqlite`));
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  migrateDatabase(db);
  return db;
}

export function migrateDatabase(db: Database.Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (
      db.prepare("SELECT name FROM schema_migrations").all() as {
        name: string;
      }[]
    ).map(({ name }) => name),
  );
  const migrations = readdirSync(migrationsDirectory)
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort();

  for (const name of migrations) {
    if (applied.has(name)) continue;
    const sql = readFileSync(resolve(migrationsDirectory, name), "utf8");
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare(
        "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
      ).run(name, new Date().toISOString());
    });
    apply();
  }
}

export function writeAuditEvent(
  db: Database.Database,
  event: {
    actorUserId: string | null;
    action: string;
    entityType: string;
    entityId: string;
    details?: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO audit_events (id, actor_user_id, action, entity_type, entity_id, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    event.actorUserId,
    event.action,
    event.entityType,
    event.entityId,
    JSON.stringify(event.details ?? {}),
    new Date().toISOString(),
  );
}
