import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import express from "express";
import { z } from "zod";
import { requireAuthentication, requireCsrf, requireRole } from "./auth.js";
import { writeAuditEvent } from "./db.js";

const moneySchema = z
  .string()
  .trim()
  .regex(/^\d{1,7}(?:\.\d{1,2})?$/u);
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  });

const BNPC_DISCOUNT_RATE_BASIS_POINTS = 500;

const policyUpdateSchema = z
  .object({
    version: z.string().trim().min(3).max(64),
    effectiveFrom: dateSchema,
    sourceTitle: z.string().trim().min(8).max(240),
    sourceUrl: z.string().url().max(500),
    reviewedAt: dateSchema,
    discountRateBasisPoints: z.literal(BNPC_DISCOUNT_RATE_BASIS_POINTS),
    weeklyPurchaseLimit: moneySchema,
    weeklyDiscountLimit: moneySchema,
    noCarryover: z.boolean(),
    minimumKindsAtPurchaseLimit: z.number().int().min(1).max(20),
    storeEligibilityConfirmed: z.boolean(),
    approvalReference: z.string().trim().min(3).max(300),
    enabled: z.boolean(),
    confirmOwnerReview: z.literal(true),
    confirmAccountantApproval: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    const purchaseLimit = parseMoney(value.weeklyPurchaseLimit);
    const discountLimit = parseMoney(value.weeklyDiscountLimit);
    if (purchaseLimit <= 0 || discountLimit <= 0) {
      context.addIssue({ code: "custom", path: ["weeklyPurchaseLimit"] });
    }
    if (value.enabled && !value.storeEligibilityConfirmed) {
      context.addIssue({ code: "custom", path: ["storeEligibilityConfirmed"] });
    }
    if (value.enabled && !value.confirmAccountantApproval) {
      context.addIssue({ code: "custom", path: ["confirmAccountantApproval"] });
    }
  });

export type BnpcPolicy = {
  id: string;
  version: string;
  effectiveFrom: string;
  sourceTitle: string;
  sourceUrl: string;
  reviewedAt: string;
  discountRateBasisPoints: number;
  weeklyPurchaseLimitCentavos: number;
  weeklyDiscountLimitCentavos: number;
  noCarryover: boolean;
  minimumKindsAtPurchaseLimit: number;
  centavoRule: string;
  vatRule: string;
  promotionRule: string;
  fourKindEvidenceRule: string;
  enabled: boolean;
  storeEligibilityConfirmed: boolean;
  approvalReference: string | null;
};

type BnpcPolicyRow = {
  id: string;
  version: string;
  effective_from: string;
  source_title: string;
  source_url: string;
  reviewed_at: string;
  discount_rate_basis_points: number;
  weekly_purchase_limit_centavos: number;
  weekly_discount_limit_centavos: number;
  no_carryover: number;
  minimum_kinds_at_purchase_limit: number;
  centavo_rule: string;
  vat_rule: string;
  promotion_rule: string;
  four_kind_evidence_rule: string;
  enabled: number;
  store_eligibility_confirmed: number;
  approval_reference: string | null;
};

function parseMoney(value: string): number {
  const amount = new Decimal(value).mul(100);
  const cents = amount.toNumber();
  if (!amount.isInteger() || !Number.isSafeInteger(cents)) {
    throw new Error("invalid_bnpc_money");
  }
  return cents;
}

function money(value: number): string {
  return new Decimal(value).div(100).toFixed(2);
}

export function readBnpcPolicy(db: Database.Database): BnpcPolicy {
  const setting = db
    .prepare(
      "SELECT value_json FROM settings WHERE key = 'bnpc-policy-version'",
    )
    .get() as { value_json: string } | undefined;
  let id = "BNPC-JAO-24-02-INITIAL";
  if (setting) {
    try {
      const parsed = z
        .object({ versionId: z.string().min(1) })
        .safeParse(JSON.parse(setting.value_json));
      if (parsed.success) id = parsed.data.versionId;
    } catch {
      // A damaged pointer leaves the feature unavailable below.
    }
  }
  const row = db
    .prepare("SELECT * FROM bnpc_policy_versions WHERE id = ?")
    .get(id) as BnpcPolicyRow | undefined;
  if (!row) {
    return {
      id: "BNPC-DISABLED",
      version: "BNPC-DISABLED",
      effectiveFrom: "2024-03-25",
      sourceTitle:
        "DTI-DA-DOE Joint Administrative Order No. 24-02, Series of 2024",
      sourceUrl:
        "https://ncda.gov.ph/wp-content/uploads/2024/04/JAO-DTI-DA-DOE-No.-240-02-S2024.pdf",
      reviewedAt: "2026-09-30",
      discountRateBasisPoints: 500,
      weeklyPurchaseLimitCentavos: 250_000,
      weeklyDiscountLimitCentavos: 12_500,
      noCarryover: true,
      minimumKindsAtPurchaseLimit: 4,
      centavoRule: "TAX_POLICY_ROUNDING_V1",
      vatRule: "NORMAL_VAT_ON_DISCOUNTED_GROSS_V1",
      promotionRule: "MORE_FAVORABLE_NO_STACK_V1",
      fourKindEvidenceRule: "BOOKLET_CONFIRMATION_V1",
      enabled: false,
      storeEligibilityConfirmed: false,
      approvalReference: null,
    };
  }
  return {
    id: row.id,
    version: row.version,
    effectiveFrom: row.effective_from,
    sourceTitle: row.source_title,
    sourceUrl: row.source_url,
    reviewedAt: row.reviewed_at,
    discountRateBasisPoints: row.discount_rate_basis_points,
    weeklyPurchaseLimitCentavos: row.weekly_purchase_limit_centavos,
    weeklyDiscountLimitCentavos: row.weekly_discount_limit_centavos,
    noCarryover: row.no_carryover === 1,
    minimumKindsAtPurchaseLimit: row.minimum_kinds_at_purchase_limit,
    centavoRule: row.centavo_rule,
    vatRule: row.vat_rule,
    promotionRule: row.promotion_rule,
    fourKindEvidenceRule: row.four_kind_evidence_rule,
    enabled:
      row.enabled === 1 &&
      row.discount_rate_basis_points === BNPC_DISCOUNT_RATE_BASIS_POINTS,
    storeEligibilityConfirmed: row.store_eligibility_confirmed === 1,
    approvalReference: row.approval_reference,
  };
}

export function presentBnpcPolicy(policy: BnpcPolicy) {
  return {
    versionId: policy.id,
    version: policy.version,
    effectiveFrom: policy.effectiveFrom,
    sourceTitle: policy.sourceTitle,
    sourceUrl: policy.sourceUrl,
    reviewedAt: policy.reviewedAt,
    discountRateBasisPoints: policy.discountRateBasisPoints,
    weeklyPurchaseLimit: money(policy.weeklyPurchaseLimitCentavos),
    weeklyDiscountLimit: money(policy.weeklyDiscountLimitCentavos),
    noCarryover: policy.noCarryover,
    minimumKindsAtPurchaseLimit: policy.minimumKindsAtPurchaseLimit,
    centavoRule: policy.centavoRule,
    vatRule: policy.vatRule,
    promotionRule: policy.promotionRule,
    fourKindEvidenceRule: policy.fourKindEvidenceRule,
    enabled: policy.enabled,
    storeEligibilityConfirmed: policy.storeEligibilityConfirmed,
    approvalReference: policy.approvalReference,
  };
}

function sendInvalid(res: Response): void {
  res.status(400).json({ error: "invalid_request" });
}

export function registerBnpcPolicyRoutes(
  router: express.Router,
  db: Database.Database,
): void {
  const requireAuth = requireAuthentication(db);
  const requireOwner = requireRole("owner");
  const csrf = (req: Request, res: Response, next: () => void) =>
    requireCsrf(db, req, res, next);

  router.get("/bnpc-policy", requireAuth, (_req, res) => {
    res.json({ policy: presentBnpcPolicy(readBnpcPolicy(db)) });
  });
  router.get(
    "/settings/bnpc-policy",
    requireAuth,
    requireOwner,
    (_req, res) => {
      res.json({ policy: presentBnpcPolicy(readBnpcPolicy(db)) });
    },
  );
  router.post(
    "/settings/bnpc-policy",
    requireAuth,
    requireOwner,
    csrf,
    (req, res) => {
      const parsed = policyUpdateSchema.safeParse(req.body);
      if (!parsed.success || !req.user) return sendInvalid(res);
      let purchaseLimitCentavos: number;
      let discountLimitCentavos: number;
      try {
        purchaseLimitCentavos = parseMoney(parsed.data.weeklyPurchaseLimit);
        discountLimitCentavos = parseMoney(parsed.data.weeklyDiscountLimit);
      } catch {
        return sendInvalid(res);
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      const approved = parsed.data.enabled;
      db.transaction(() => {
        db.prepare(
          `INSERT INTO bnpc_policy_versions
           (id, version, effective_from, source_title, source_url, reviewed_at,
            discount_rate_basis_points, weekly_purchase_limit_centavos,
            weekly_discount_limit_centavos, no_carryover,
            minimum_kinds_at_purchase_limit, centavo_rule, vat_rule,
            promotion_rule, four_kind_evidence_rule, enabled,
            store_eligibility_confirmed, approval_reference, approved_by_user_id,
            approved_at, created_by_user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   'TAX_POLICY_ROUNDING_V1', 'NORMAL_VAT_ON_DISCOUNTED_GROSS_V1',
                   'MORE_FAVORABLE_NO_STACK_V1', 'BOOKLET_CONFIRMATION_V1',
                   ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          parsed.data.version,
          parsed.data.effectiveFrom,
          parsed.data.sourceTitle,
          parsed.data.sourceUrl,
          parsed.data.reviewedAt,
          parsed.data.discountRateBasisPoints,
          purchaseLimitCentavos,
          discountLimitCentavos,
          parsed.data.noCarryover ? 1 : 0,
          parsed.data.minimumKindsAtPurchaseLimit,
          parsed.data.enabled ? 1 : 0,
          parsed.data.storeEligibilityConfirmed ? 1 : 0,
          parsed.data.approvalReference,
          approved ? req.user!.id : null,
          approved ? now : null,
          req.user!.id,
          now,
        );
        db.prepare(
          `INSERT INTO settings (key, value_json, updated_at, updated_by)
           VALUES ('bnpc-policy-version', ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
             updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        ).run(JSON.stringify({ versionId: id }), now, req.user!.id);
        writeAuditEvent(db, {
          actorUserId: req.user!.id,
          action: parsed.data.enabled
            ? "settings.bnpc_policy.enabled"
            : "settings.bnpc_policy.version_created",
          entityType: "bnpc_policy_version",
          entityId: id,
          details: {
            version: parsed.data.version,
            effectiveFrom: parsed.data.effectiveFrom,
            sourceTitle: parsed.data.sourceTitle,
            sourceUrl: parsed.data.sourceUrl,
            reviewedAt: parsed.data.reviewedAt,
            discountRateBasisPoints: parsed.data.discountRateBasisPoints,
            weeklyPurchaseLimitCentavos: purchaseLimitCentavos,
            weeklyDiscountLimitCentavos: discountLimitCentavos,
            noCarryover: parsed.data.noCarryover,
            minimumKindsAtPurchaseLimit:
              parsed.data.minimumKindsAtPurchaseLimit,
            storeEligibilityConfirmed: parsed.data.storeEligibilityConfirmed,
            enabled: parsed.data.enabled,
            approvalReference: parsed.data.approvalReference,
          },
        });
      })();
      res.status(201).json({ policy: presentBnpcPolicy(readBnpcPolicy(db)) });
    },
  );
}
