import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { api, ApiError } from "./api";

type Policy = {
  approved: boolean;
  version: string;
  vatRateBasisPoints: number;
  seniorDiscountBasisPoints: number;
  pwdDiscountBasisPoints: number;
  vatInclusivePrices: boolean;
  allowZeroRated: boolean;
  roundingMode: "HALF_UP" | "HALF_EVEN" | "DOWN";
  cashRoundingMode: "NONE" | "NEAREST_25_CENTAVOS";
  approvalReference: string;
  costBasisDescription: string;
};

type FormState = {
  version: string;
  vatRate: string;
  seniorDiscount: string;
  pwdDiscount: string;
  vatInclusivePrices: boolean;
  allowZeroRated: boolean;
  roundingMode: Policy["roundingMode"];
  cashRoundingMode: Policy["cashRoundingMode"];
  approvalReference: string;
  costBasisDescription: string;
  confirmApproved: boolean;
};

function percentText(basisPoints: number): string {
  return `${Math.floor(basisPoints / 100)}.${String(basisPoints % 100).padStart(2, "0")}`;
}

function percentBasisPoints(value: string): number {
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(value)) {
    throw new Error("Enter a percentage with up to two decimal places.");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (result > 10_000n) throw new Error("A rate cannot exceed 100%.");
  return Number(result);
}

function Field({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <label className="inventory-field" htmlFor={id}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function emptyForm(policy?: Policy): FormState {
  return {
    version: policy?.approved ? policy.version : "PH-APPROVED-V1",
    vatRate: percentText(policy?.vatRateBasisPoints ?? 1_200),
    seniorDiscount: percentText(policy?.seniorDiscountBasisPoints ?? 2_000),
    pwdDiscount: percentText(policy?.pwdDiscountBasisPoints ?? 2_000),
    vatInclusivePrices: policy?.vatInclusivePrices ?? true,
    allowZeroRated: policy?.allowZeroRated ?? false,
    roundingMode: policy?.roundingMode ?? "HALF_UP",
    cashRoundingMode: policy?.cashRoundingMode ?? "NONE",
    approvalReference: policy?.approvalReference ?? "",
    costBasisDescription: policy?.costBasisDescription ?? "",
    confirmApproved: false,
  };
}

export function TaxPolicySettings() {
  const [form, setForm] = useState<FormState>(emptyForm());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    void api
      .get<{ policy: Policy }>("/settings/tax-policy")
      .then(({ policy }) => {
        if (!active) return;
        setForm(emptyForm(policy));
        setApproved(policy.approved);
      })
      .catch(() => {
        if (active) setError("Unable to load tax policy settings.");
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
    if (!form.confirmApproved) {
      setError(
        "Confirm the policy was approved by your tax adviser/accountant.",
      );
      return;
    }
    setSaving(true);
    try {
      await api.post("/settings/tax-policy", {
        confirmApproved: true,
        version: form.version.trim(),
        vatRateBasisPoints: percentBasisPoints(form.vatRate),
        seniorDiscountBasisPoints: percentBasisPoints(form.seniorDiscount),
        pwdDiscountBasisPoints: percentBasisPoints(form.pwdDiscount),
        vatInclusivePrices: form.vatInclusivePrices,
        allowZeroRated: form.allowZeroRated,
        roundingMode: form.roundingMode,
        cashRoundingMode: form.cashRoundingMode,
        approvalReference: form.approvalReference.trim(),
        costBasisDescription: form.costBasisDescription.trim(),
      });
      setApproved(true);
      setNotice("Approved policy saved and recorded in the audit history.");
    } catch (caught) {
      if (caught instanceof Error && !(caught instanceof ApiError)) {
        setError(caught.message);
      } else {
        setError(
          "Unable to save policy settings. Check the fields and try again.",
        );
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="activity-card tax-policy-card">
      <div className="card-heading">
        <div>
          <h2>Tax and acquisition-cost policy</h2>
          <p>
            Save these settings only after the pharmacy's tax adviser/accountant
            approves the rules and supplier-cost basis.
          </p>
        </div>
        <span
          className={`policy-status-icon ${approved ? "policy-approved" : ""}`}
        >
          {approved ? <ShieldCheck size={17} /> : <AlertTriangle size={17} />}
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
          ? "Loading policy…"
          : approved
            ? "An approved policy is active for future sales."
            : "No approved policy is active. Checkout previews are provisional and sale finalization is blocked."}
      </div>
      <form
        className="tax-policy-form"
        onSubmit={(event) => void submit(event)}
      >
        <div className="inventory-two-fields">
          <Field id="tax-policy-version" label="Policy version">
            <input
              id="tax-policy-version"
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
          <Field id="tax-rounding-mode" label="Tax-component centavo rounding">
            <select
              id="tax-rounding-mode"
              className="text-input select-input"
              value={form.roundingMode}
              onChange={(event) =>
                setForm({
                  ...form,
                  roundingMode: event.target.value as Policy["roundingMode"],
                })
              }
            >
              <option value="HALF_UP">Half up</option>
              <option value="HALF_EVEN">Half even</option>
              <option value="DOWN">Truncate</option>
            </select>
          </Field>
        </div>
        <Field id="cash-rounding-mode" label="Cash total rounding">
          <select
            id="cash-rounding-mode"
            className="text-input select-input"
            value={form.cashRoundingMode}
            onChange={(event) =>
              setForm({
                ...form,
                cashRoundingMode: event.target
                  .value as Policy["cashRoundingMode"],
              })
            }
          >
            <option value="NONE">No cash total rounding</option>
            <option value="NEAREST_25_CENTAVOS">
              Nearest ₱0.25 (cash only)
            </option>
          </select>
        </Field>
        <p className="field-hint">
          Nearest ₱0.25 for the final cash total: ₱0.00–₱0.12 → ₱0.00;
          ₱0.13–₱0.37 → ₱0.25; ₱0.38–₱0.62 → ₱0.50; ₱0.63–₱0.87 → ₱0.75;
          ₱0.88–₱0.99 → next ₱1.00. This does not change item tax calculations
          or QR totals.
        </p>
        <div className="tax-percentage-grid">
          <Field id="tax-vat-rate" label="VAT rate (%)">
            <input
              id="tax-vat-rate"
              className="text-input"
              inputMode="decimal"
              value={form.vatRate}
              onChange={(event) =>
                setForm({ ...form, vatRate: event.target.value })
              }
              required
              pattern="[0-9]{1,3}(\.[0-9]{1,2})?"
            />
          </Field>
          <Field id="tax-senior-discount" label="Senior discount (%)">
            <input
              id="tax-senior-discount"
              className="text-input"
              inputMode="decimal"
              value={form.seniorDiscount}
              onChange={(event) =>
                setForm({ ...form, seniorDiscount: event.target.value })
              }
              required
              pattern="[0-9]{1,3}(\.[0-9]{1,2})?"
            />
          </Field>
          <Field id="tax-pwd-discount" label="PWD discount (%)">
            <input
              id="tax-pwd-discount"
              className="text-input"
              inputMode="decimal"
              value={form.pwdDiscount}
              onChange={(event) =>
                setForm({ ...form, pwdDiscount: event.target.value })
              }
              required
              pattern="[0-9]{1,3}(\.[0-9]{1,2})?"
            />
          </Field>
        </div>
        <div className="tax-policy-toggles">
          <label className="inventory-checkbox">
            <input
              type="checkbox"
              checked={form.vatInclusivePrices}
              onChange={(event) =>
                setForm({ ...form, vatInclusivePrices: event.target.checked })
              }
            />
            <span>Catalog selling prices include VAT</span>
          </label>
          <label className="inventory-checkbox">
            <input
              type="checkbox"
              checked={form.allowZeroRated}
              onChange={(event) =>
                setForm({ ...form, allowZeroRated: event.target.checked })
              }
            />
            <span>Approved policy permits zero-rated products</span>
          </label>
        </div>
        <Field
          id="tax-approval-reference"
          label="Approval reference (document, date, or record ID)"
        >
          <input
            id="tax-approval-reference"
            className="text-input"
            value={form.approvalReference}
            onChange={(event) =>
              setForm({ ...form, approvalReference: event.target.value })
            }
            required
            minLength={3}
            maxLength={160}
          />
        </Field>
        <Field
          id="tax-cost-basis"
          label="Approved acquisition-cost basis (supplier VAT, freight, and other costs)"
        >
          <textarea
            id="tax-cost-basis"
            className="text-input tax-policy-textarea"
            value={form.costBasisDescription}
            onChange={(event) =>
              setForm({ ...form, costBasisDescription: event.target.value })
            }
            required
            minLength={3}
            maxLength={500}
          />
        </Field>
        <label className="inventory-checkbox tax-approval-attestation">
          <input
            type="checkbox"
            checked={form.confirmApproved}
            onChange={(event) =>
              setForm({ ...form, confirmApproved: event.target.checked })
            }
          />
          <span>
            I confirm these tax, benefit, cash and tax-component rounding,
            classification, and cost-basis rules have been approved for this
            pharmacy.
          </span>
        </label>
        <button
          className="button button-primary"
          type="submit"
          disabled={saving || loading}
        >
          {saving ? "Saving…" : "Record approved policy"}
        </button>
      </form>
    </section>
  );
}
