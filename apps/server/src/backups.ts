import argon2 from "argon2";
import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  clearAuthCookies,
  requireAuthentication,
  requireCsrf,
  requireRole,
} from "./auth.js";
import { writeAuditEvent } from "./db.js";
import {
  backupStatus,
  BackupError,
  createBackup,
  listBackups,
  restoreBackup,
  storeProfile,
} from "./backup-service.js";
import { beginRestore, finishRestore } from "./maintenance.js";

const storeNameSchema = z
  .object({ name: z.string().trim().min(1).max(160) })
  .strict();
const restoreSchema = z
  .object({
    backupId: z.uuid(),
    location: z.enum(["primary", "secondary"]),
    confirmStoreId: z.uuid(),
    ownerPassword: z.string().min(1).max(128),
  })
  .strict();

function fail(res: Response, error: unknown): void {
  if (error instanceof BackupError) {
    const status =
      error.code === "backup_not_found"
        ? 404
        : error.code.includes("not_configured") ||
            error.code.includes("required") ||
            error.code.includes("separate_storage")
          ? 409
          : error.code.includes("failed") || error.code.includes("invalid")
            ? 422
            : 400;
    res.status(status).json({ error: error.code });
    return;
  }
  res.status(500).json({ error: "backup_operation_failed" });
}

async function actorCredentials(
  db: Database.Database,
  req: Request,
): Promise<{ id: string; email: string; passwordHash: string } | null> {
  if (!req.user) return null;
  return (
    (db
      .prepare(
        `SELECT id, email, password_hash AS passwordHash FROM users
         WHERE id = ? AND role = 'owner' AND is_active = 1`,
      )
      .get(req.user.id) as
      | { id: string; email: string; passwordHash: string }
      | undefined) ?? null
  );
}

export function registerBackupRoutes(
  router: express.Router,
  db: Database.Database,
): void {
  const requireAuth = requireAuthentication(db);
  const requireOwner = requireRole("owner");
  const csrf = (req: Request, res: Response, next: () => void) =>
    requireCsrf(db, req, res, next);

  router.get(
    "/settings/store-profile",
    requireAuth,
    requireOwner,
    (_req, res) => {
      res.json({ profile: storeProfile(db) });
    },
  );

  router.put(
    "/settings/store-profile",
    requireAuth,
    requireOwner,
    csrf,
    (req, res) => {
      const parsed = storeNameSchema.safeParse(req.body);
      if (!parsed.success || !req.user) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      const current = storeProfile(db);
      const profile = {
        id: current?.id ?? randomUUID(),
        name: parsed.data.name,
      };
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO settings (key, value_json, updated_at, updated_by)
         VALUES ('store_profile', ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      ).run(JSON.stringify(profile), now, req.user.id);
      writeAuditEvent(db, {
        actorUserId: req.user.id,
        action: "store.profile_updated",
        entityType: "store",
        entityId: profile.id,
        details: { name: profile.name },
      });
      res.json({ profile });
    },
  );

  router.get("/backups/status", requireAuth, requireOwner, (req, res) => {
    res.json({ status: backupStatus(db) });
  });

  router.get("/backups", requireAuth, requireOwner, async (_req, res) => {
    try {
      res.json({ backups: await listBackups() });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/backups", requireAuth, requireOwner, csrf, async (req, res) => {
    if (!req.user || (req.body && Object.keys(req.body).length > 0)) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    try {
      const backup = await createBackup(db, "manual", req.user.id);
      res.status(201).json({ backup });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post(
    "/backups/restore",
    requireAuth,
    requireOwner,
    csrf,
    async (req, res) => {
      const parsed = restoreSchema.safeParse(req.body);
      if (!parsed.success || !req.user) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      const actor = await actorCredentials(db, req);
      if (
        !actor ||
        !(await argon2.verify(actor.passwordHash, parsed.data.ownerPassword))
      ) {
        res.status(403).json({ error: "reauthentication_failed" });
        return;
      }
      if (!beginRestore()) {
        res.status(409).json({ error: "database_restore_already_in_progress" });
        return;
      }
      try {
        const restored = await restoreBackup(db, {
          backupId: parsed.data.backupId,
          location: parsed.data.location,
          confirmStoreId: parsed.data.confirmStoreId,
          actorUserId: actor.id,
          actorEmail: actor.email,
        });
        clearAuthCookies(res);
        res.json({
          backup: restored.backup,
          safetyBackupId: restored.safetyBackupId,
          reauthenticationRequired: true,
        });
      } catch (error) {
        fail(res, error);
      } finally {
        finishRestore();
      }
    },
  );
}
