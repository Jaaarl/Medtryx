import { createHmac } from "node:crypto";
import type Database from "better-sqlite3";
import { customerEncryptionKeyHex } from "./customer-data.js";
import { manilaCalendarDate } from "./lot-stock.js";
import { readBnpcPolicy, type BnpcPolicy } from "./bnpc-policy.js";

export type BnpcEvidence = {
  bookletChecked: boolean;
  priorPurchaseConfirmed: boolean;
  externalPurchaseAmount: string;
  externalDiscountUsedAmount: string;
  representativePurchase: boolean;
  representativeDocumentsChecked: boolean;
  authorizationLetterIssuedDate: string | null;
  prescriptionApplicable: boolean;
  prescriptionChecked: boolean;
  fourKindsChecked: boolean;
};

export type BnpcCheckoutContext = {
  policy: BnpcPolicy;
  holderKeyHmac: string;
  weekStartDate: string;
  localPurchaseBeforeCentavos: number;
  localDiscountBeforeCentavos: number;
  externalPurchaseAttestedCentavos: number;
  externalDiscountAttestedCentavos: number;
  purchaseAllowanceCentavos: number;
  discountAllowanceCentavos: number;
  evidence: BnpcEvidence;
};

export class BnpcCheckoutError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function parseBnpcMoney(value: string): number {
  const [whole, fraction = ""] = value.trim().split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error("invalid_bnpc_amount");
  }
  return cents;
}

function normalizedId(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]/gu, "");
}

export function bnpcHolderKey(value: string): string {
  const key = Buffer.from(customerEncryptionKeyHex(), "hex");
  return createHmac("sha256", key).update(normalizedId(value)).digest("hex");
}

export function manilaWeekStart(date = manilaCalendarDate()): string {
  const parts = date.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const value = new Date(Date.UTC(year, month - 1, day));
  const daysSinceMonday = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - daysSinceMonday);
  return value.toISOString().slice(0, 10);
}

export function resolveBnpcCheckoutContext(
  db: Database.Database,
  evidence: BnpcEvidence,
  idNumber: string,
  businessDate?: string,
): BnpcCheckoutContext {
  const policy = readBnpcPolicy(db);
  if (!policy.enabled || !policy.storeEligibilityConfirmed) {
    throw new BnpcCheckoutError("bnpc_policy_not_enabled");
  }
  if (policy.effectiveFrom > manilaCalendarDate()) {
    throw new BnpcCheckoutError("bnpc_policy_not_effective");
  }
  if (!evidence.bookletChecked || !evidence.priorPurchaseConfirmed) {
    throw new BnpcCheckoutError("bnpc_booklet_confirmation_required");
  }
  if (evidence.representativePurchase) {
    if (
      !evidence.representativeDocumentsChecked ||
      !evidence.authorizationLetterIssuedDate
    ) {
      throw new BnpcCheckoutError("bnpc_representative_documents_required");
    }
    const letterDate = new Date(
      `${evidence.authorizationLetterIssuedDate}T00:00:00.000Z`,
    );
    const today = new Date(
      `${businessDate ?? manilaCalendarDate()}T00:00:00.000Z`,
    );
    if (
      !Number.isFinite(letterDate.getTime()) ||
      letterDate.toISOString().slice(0, 10) !==
        evidence.authorizationLetterIssuedDate
    ) {
      throw new BnpcCheckoutError("bnpc_authorization_letter_expired");
    }
    const ageDays = Math.floor(
      (today.getTime() - letterDate.getTime()) / 86_400_000,
    );
    if (ageDays < 0 || ageDays > 7) {
      throw new BnpcCheckoutError("bnpc_authorization_letter_expired");
    }
  }
  if (evidence.prescriptionApplicable && !evidence.prescriptionChecked) {
    throw new BnpcCheckoutError("bnpc_prescription_confirmation_required");
  }

  const holderKeyHmac = bnpcHolderKey(idNumber);
  const weekStartDate = manilaWeekStart(businessDate);
  const local = db
    .prepare(
      `SELECT COALESCE(SUM(qualifying_purchase_delta_centavos), 0) AS purchase,
              COALESCE(SUM(bnpc_discount_delta_centavos), 0) AS discount
       FROM bnpc_usage_events WHERE holder_key_hmac = ? AND week_start_date = ?`,
    )
    .get(holderKeyHmac, weekStartDate) as {
    purchase: number;
    discount: number;
  };
  const externalPurchaseAttestedCentavos = parseBnpcMoney(
    evidence.externalPurchaseAmount,
  );
  const externalDiscountAttestedCentavos = parseBnpcMoney(
    evidence.externalDiscountUsedAmount,
  );
  const lastAttestation = db
    .prepare(
      `SELECT COALESCE(MAX(external_purchase_attested_centavos), 0)
                AS external_purchase_attested_centavos,
              COALESCE(MAX(external_discount_attested_centavos), 0)
                AS external_discount_attested_centavos
       FROM sale_bnpc_snapshots WHERE holder_key_hmac = ? AND week_start_date = ?`,
    )
    .get(holderKeyHmac, weekStartDate) as
    | {
        external_purchase_attested_centavos: number;
        external_discount_attested_centavos: number;
      }
    | undefined;
  if (
    lastAttestation &&
    (externalPurchaseAttestedCentavos <
      lastAttestation.external_purchase_attested_centavos ||
      externalDiscountAttestedCentavos <
        lastAttestation.external_discount_attested_centavos)
  ) {
    throw new BnpcCheckoutError("bnpc_prior_usage_attestation_decreased");
  }
  const purchaseAllowanceCentavos = Math.max(
    0,
    policy.weeklyPurchaseLimitCentavos -
      local.purchase -
      externalPurchaseAttestedCentavos,
  );
  const discountAllowanceCentavos = Math.max(
    0,
    policy.weeklyDiscountLimitCentavos -
      local.discount -
      externalDiscountAttestedCentavos,
  );
  return {
    policy,
    holderKeyHmac,
    weekStartDate,
    localPurchaseBeforeCentavos: local.purchase,
    localDiscountBeforeCentavos: local.discount,
    externalPurchaseAttestedCentavos,
    externalDiscountAttestedCentavos,
    purchaseAllowanceCentavos,
    discountAllowanceCentavos,
    evidence,
  };
}

export function bnpcAllowanceSnapshot(context: BnpcCheckoutContext) {
  return {
    purchase: context.purchaseAllowanceCentavos,
    discount: context.discountAllowanceCentavos,
    localPurchaseBefore: context.localPurchaseBeforeCentavos,
    localDiscountBefore: context.localDiscountBeforeCentavos,
    externalPurchase: context.externalPurchaseAttestedCentavos,
    externalDiscount: context.externalDiscountAttestedCentavos,
  };
}
