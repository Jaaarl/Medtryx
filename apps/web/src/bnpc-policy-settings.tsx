import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { api } from "./api";

type Policy = {
  versionId: string;
  version: string;
  effectiveFrom: string;
  sourceTitle: string;
  sourceUrl: string;
  reviewedAt: string;
  discountRateBasisPoints: number;
  weeklyPurchaseLimit: string;
  weeklyDiscountLimit: string;
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

type FormState = {
  version: string;
  effectiveFrom: string;
  sourceTitle: string;
  sourceUrl: string;
  reviewedAt: string;
  discountRate: string;
  weeklyPurchaseLimit: string;
  weeklyDiscountLimit: string;
  noCarryover: boolean;
  minimumKinds: string;
  storeEligibilityConfirmed: boolean;
  approvalReference: string;
  enabled: boolean;
  confirmAccountantApproval: boolean;
};

function percentText(basisPoints: number): string {
  return `${Math.floor(basisPoints / 100)}.${String(basisPoints % 100).padStart(2, "0")}`;
}

function today(): string {
  const fields = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    fields.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function formFromPolicy(policy?: Policy): FormState {
  return {
    version: `${policy?.version ?? "JAO-DTI-DA-DOE-24-02"}-REVIEW-${today()}`,
    effectiveFrom: policy?.effectiveFrom ?? "2024-03-25",
    sourceTitle:
      policy?.sourceTitle ??
      "DTI-DA-DOE Joint Administrative Order No. 24-02, Series of 2024",
    sourceUrl:
      policy?.sourceUrl ??
      "https://ncda.gov.ph/wp-content/uploads/2024/04/JAO-DTI-DA-DOE-No.-240-02-S2024.pdf",
    reviewedAt: today(),
    discountRate: percentText(policy?.discountRateBasisPoints ?? 500),
    weeklyPurchaseLimit: policy?.weeklyPurchaseLimit ?? "2500.00",
    weeklyDiscountLimit: policy?.weeklyDiscountLimit ?? "125.00",
    noCarryover: policy?.noCarryover ?? true,
    minimumKinds: String(policy?.minimumKindsAtPurchaseLimit ?? 4),
    storeEligibilityConfirmed: policy?.storeEligibilityConfirmed ?? false,
    approvalReference: policy?.approvalReference ?? "",
    enabled: policy?.enabled ?? false,
    confirmAccountantApproval: false,
  };
}

function basisPoints(value: string): number {
  if (!/^\d{1,3}(?:\.\d{1,2})?$/u.test(value)) {
    throw new Error("Enter a percentage with up to two decimal places.");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const result = Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0")));
  if (result > 10_000) throw new Error("The discount rate cannot exceed 100%.");
  return result;
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="inventory-field" htmlFor={id}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function BnpcPolicySettings() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [form, setForm] = useState<FormState>(formFromPolicy());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    void api
      .get<{ policy: Policy }>("/settings/bnpc-policy")
      .then(({ policy: loaded }) => {
        if (!active) return;
        setPolicy(loaded);
        setForm(formFromPolicy(loaded));
      })
      .catch(() => {
        if (active) setError("Unable to load BNPC policy settings.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setSaving(true);
    try {
      const saved = await api.post<{ policy: Policy }>(
        "/settings/bnpc-policy",
        {
          version: form.version.trim(),
          effectiveFrom: form.effectiveFrom,
          sourceTitle: form.sourceTitle.trim(),
          sourceUrl: form.sourceUrl.trim(),
          reviewedAt: form.reviewedAt,
          discountRateBasisPoints: basisPoints(form.discountRate),
          weeklyPurchaseLimit: form.weeklyPurchaseLimit.trim(),
          weeklyDiscountLimit: form.weeklyDiscountLimit.trim(),
          noCarryover: form.noCarryover,
          minimumKindsAtPurchaseLimit: Number(form.minimumKinds),
          storeEligibilityConfirmed: form.storeEligibilityConfirmed,
          approvalReference: form.approvalReference.trim(),
          enabled: form.enabled,
          confirmOwnerReview: true,
          confirmAccountantApproval:
            form.enabled && form.confirmAccountantApproval,
        },
      );
      setPolicy(saved.policy);
      setNotice(
        saved.policy.enabled
          ? "A new BNPC policy version is enabled for future sales."
          : "A BNPC policy version was saved with its switch off.",
      );
      setForm(formFromPolicy(saved.policy));
    } catch (caught) {
      setError(
        caught instanceof Error && !(caught instanceof TypeError)
          ? caught.message
          : "Unable to save the BNPC policy version. Check the review and approval details.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="activity-card tax-policy-card">
      <div className="card-heading">
        <div>
          <h2>BNPC 5% benefit policy</h2>
          <p>
            Each saved change creates an immutable policy version. The live-use
            switch is off unless the owner records store and accountant
            approval.
          </p>
        </div>
        <span
          className={`policy-status-icon ${policy?.enabled ? "policy-approved" : ""}`}
        >
          {policy?.enabled ? (
            <ShieldCheck size={17} />
          ) : (
            <AlertTriangle size={17} />
          )}
        </span>
      </div>
      {error && (
        <div className="banner banner-error tax-policy-message" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="banner banner-success tax-policy-message" role="status">
          {notice}
        </div>
      )}
      <div className="tax-policy-state">
        {loading
          ? "Loading BNPC policy…"
          : policy?.enabled
            ? `Enabled version ${policy.version}; source review ${policy.reviewedAt}.`
            : `Disabled. Current stored version ${policy?.version ?? "unavailable"}; checkout will not grant BNPC.`}
      </div>
      <form
        className="tax-policy-form"
        onSubmit={(event) => void submit(event)}
      >
        <div className="inventory-two-fields">
          <Field id="bnpc-policy-version" label="New policy version">
            <input
              id="bnpc-policy-version"
              className="text-input"
              value={form.version}
              onChange={(event) =>
                setForm({ ...form, version: event.target.value })
              }
              required
              minLength={3}
              maxLength={64}
            />
          </Field>
          <Field id="bnpc-policy-effective" label="Effective from">
            <input
              id="bnpc-policy-effective"
              className="text-input"
              type="date"
              value={form.effectiveFrom}
              onChange={(event) =>
                setForm({ ...form, effectiveFrom: event.target.value })
              }
              required
            />
          </Field>
        </div>
        <Field id="bnpc-policy-source-title" label="Rule source">
          <input
            id="bnpc-policy-source-title"
            className="text-input"
            value={form.sourceTitle}
            onChange={(event) =>
              setForm({ ...form, sourceTitle: event.target.value })
            }
            required
            maxLength={240}
          />
        </Field>
        <Field id="bnpc-policy-source-url" label="Official source URL">
          <input
            id="bnpc-policy-source-url"
            className="text-input"
            type="url"
            value={form.sourceUrl}
            onChange={(event) =>
              setForm({ ...form, sourceUrl: event.target.value })
            }
            required
            maxLength={500}
          />
        </Field>
        <div className="inventory-two-fields">
          <Field id="bnpc-policy-review-date" label="Reviewed on">
            <input
              id="bnpc-policy-review-date"
              className="text-input"
              type="date"
              value={form.reviewedAt}
              onChange={(event) =>
                setForm({ ...form, reviewedAt: event.target.value })
              }
              required
            />
          </Field>
          <Field id="bnpc-policy-rate" label="Discount rate (%)">
            <input
              id="bnpc-policy-rate"
              className="text-input"
              inputMode="decimal"
              value={form.discountRate}
              onChange={(event) =>
                setForm({ ...form, discountRate: event.target.value })
              }
              required
            />
          </Field>
          <Field
            id="bnpc-policy-purchase-limit"
            label="Weekly qualifying-purchase limit (PHP)"
          >
            <input
              id="bnpc-policy-purchase-limit"
              className="text-input"
              inputMode="decimal"
              value={form.weeklyPurchaseLimit}
              onChange={(event) =>
                setForm({ ...form, weeklyPurchaseLimit: event.target.value })
              }
              required
            />
          </Field>
          <Field
            id="bnpc-policy-discount-limit"
            label="Weekly discount limit (PHP)"
          >
            <input
              id="bnpc-policy-discount-limit"
              className="text-input"
              inputMode="decimal"
              value={form.weeklyDiscountLimit}
              onChange={(event) =>
                setForm({ ...form, weeklyDiscountLimit: event.target.value })
              }
              required
            />
          </Field>
          <Field
            id="bnpc-policy-kinds"
            label="Minimum kinds at full purchase limit"
          >
            <input
              id="bnpc-policy-kinds"
              className="text-input"
              type="number"
              min="1"
              max="20"
              value={form.minimumKinds}
              onChange={(event) =>
                setForm({ ...form, minimumKinds: event.target.value })
              }
              required
            />
          </Field>
        </div>
        <label className="inventory-checkbox">
          <input
            type="checkbox"
            checked={form.noCarryover}
            onChange={(event) =>
              setForm({ ...form, noCarryover: event.target.checked })
            }
          />
          <span>Unused weekly allowance does not carry over.</span>
        </label>
        <label className="inventory-checkbox">
          <input
            type="checkbox"
            checked={form.storeEligibilityConfirmed}
            onChange={(event) =>
              setForm({
                ...form,
                storeEligibilityConfirmed: event.target.checked,
              })
            }
          />
          <span>I verified this establishment is covered by this policy.</span>
        </label>
        <Field
          id="bnpc-policy-approval-reference"
          label="Owner/accountant review reference"
        >
          <input
            id="bnpc-policy-approval-reference"
            className="text-input"
            value={form.approvalReference}
            onChange={(event) =>
              setForm({ ...form, approvalReference: event.target.value })
            }
            required
            maxLength={300}
          />
        </Field>
        <div className="policy-rule-note">
          BNPC uses regular retail gross for the 5% base, normal VAT on the
          discounted gross, the current tax policy centavo rule, the more
          favorable promotion result without stacking, and staff confirmation
          from the purchase booklet for the four-kind condition.
        </div>
        <label className="inventory-checkbox">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(event) =>
              setForm({
                ...form,
                enabled: event.target.checked,
                confirmAccountantApproval: false,
              })
            }
          />
          <span>Enable this version for live checkout after review.</span>
        </label>
        {form.enabled && (
          <label className="inventory-checkbox">
            <input
              type="checkbox"
              checked={form.confirmAccountantApproval}
              onChange={(event) =>
                setForm({
                  ...form,
                  confirmAccountantApproval: event.target.checked,
                })
              }
            />
            <span>
              The accountant approved the exact centavo, tax, booklet,
              four-kind, promotion, weekly-cap, and reversal behavior recorded
              above.
            </span>
          </label>
        )}
        <button
          className="button button-primary"
          type="submit"
          disabled={saving || loading}
        >
          {saving ? "Saving…" : "Save new BNPC policy version"}
        </button>
      </form>
    </section>
  );
}
