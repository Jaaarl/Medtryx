import type { NextFunction, Request, Response } from "express";
import type Database from "better-sqlite3";
import express from "express";
import {
  defaultMonthlyIncentiveSetting,
  monthlyIncentiveSettingSchema,
} from "@medtryx/shared";
import { requireAuthentication, requireCsrf, requireRole } from "./auth.js";
import { writeAuditEvent } from "./db.js";

export function monthlyIncentiveSetting(
  db: Database.Database,
): typeof defaultMonthlyIncentiveSetting {
  const row = db
    .prepare("SELECT value_json FROM settings WHERE key = 'monthly_incentive'")
    .get() as { value_json: string } | undefined;
  if (!row) return defaultMonthlyIncentiveSetting;

  try {
    const parsed = monthlyIncentiveSettingSchema.safeParse(
      JSON.parse(row.value_json),
    );
    return parsed.success ? parsed.data : defaultMonthlyIncentiveSetting;
  } catch {
    return defaultMonthlyIncentiveSetting;
  }
}

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

export function registerMonthlyIncentiveRoutes(
  router: express.Router,
  db: Database.Database,
): void {
  const requireAuth = requireAuthentication(db);
  const requireOwner = requireRole("owner");
  const csrf = (req: Request, res: Response, next: NextFunction) =>
    requireCsrf(db, req, res, next);

  router.get(
    "/settings/monthly-incentive",
    requireAuth,
    requireOwner,
    (_req, res) => {
      res.json(monthlyIncentiveSetting(db));
    },
  );

  router.put(
    "/settings/monthly-incentive",
    requireAuth,
    requireOwner,
    csrf,
    (req, res) => {
      const parsed = monthlyIncentiveSettingSchema.safeParse(req.body);
      if (!parsed.success || !req.user) {
        res.status(400).json({ error: "invalid_monthly_incentive_setting" });
        return;
      }

      const previous = monthlyIncentiveSetting(db);
      const value = parsed.data;
      const now = new Date().toISOString();
      db.transaction(() => {
        db.prepare(
          `INSERT INTO settings (key, value_json, updated_at, updated_by)
           VALUES ('monthly_incentive', ?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
             updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        ).run(JSON.stringify(value), now, req.user!.id);
        writeAuditEvent(db, {
          actorUserId: req.user!.id,
          action: "settings.monthly_incentive.updated",
          entityType: "setting",
          entityId: "monthly_incentive",
          details: { oldValue: previous, newValue: value, updatedAt: now },
        });
      })();
      res.json(value);
    },
  );

  router.get("/dashboard/monthly-incentive", requireAuth, (_req, res) => {
    const setting = monthlyIncentiveSetting(db);
    if (!setting.enabled) {
      res.json({ progress: null });
      return;
    }

    const businessDate = todayInManila();
    const month = businessDate.slice(0, 7);
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(s.amount_due_centavos - COALESCE(r.amount_centavos, 0)), 0)
           AS sales_centavos
         FROM sales s
         LEFT JOIN sale_reversals r ON r.sale_id = s.id
         WHERE s.business_date >= ? AND s.business_date <= ?`,
      )
      .get(`${month}-01`, businessDate) as { sales_centavos: number };

    res.json({
      progress: {
        month,
        salesCentavos: row.sales_centavos,
        tiers: setting.tiers,
        showOnCheckout: setting.showOnCheckout,
      },
    });
  });
}
