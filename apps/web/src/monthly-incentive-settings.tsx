import { useEffect, useState } from "react";
import {
  defaultMonthlyIncentiveSetting,
  monthlyIncentiveSettingSchema,
} from "@medtryx/shared";
import type {
  MonthlyIncentiveSetting,
  MonthlyIncentiveTier,
} from "@medtryx/shared";
import { ChevronLeft, ChevronRight, Plus, Trash2 } from "lucide-react";
import { api } from "./api";

type TierDraft = {
  salesTarget: string;
  incentive: string;
  color: string;
};

type SettingDraft = {
  enabled: boolean;
  showOnCheckout: boolean;
  showGoalAndIncentive: boolean;
  tiers: TierDraft[];
};

function amountInput(centavos: number): string {
  return (centavos / 100).toFixed(2);
}

function makeDraft(setting: MonthlyIncentiveSetting): SettingDraft {
  return {
    enabled: setting.enabled,
    showOnCheckout: setting.showOnCheckout,
    showGoalAndIncentive: setting.showGoalAndIncentive,
    tiers: setting.tiers.map((tier) => ({
      salesTarget: amountInput(tier.salesTargetCentavos),
      incentive: amountInput(tier.incentiveCentavos),
      color: tier.color,
    })),
  };
}

function tierFromDraft(tier: TierDraft): MonthlyIncentiveTier | null {
  if (!tier.salesTarget.trim() || !tier.incentive.trim()) return null;
  const target = Number(tier.salesTarget);
  const incentive = Number(tier.incentive);
  if (
    !Number.isFinite(target) ||
    !Number.isFinite(incentive) ||
    target <= 0 ||
    incentive < 0
  ) {
    return null;
  }
  return {
    salesTargetCentavos: Math.round(target * 100),
    incentiveCentavos: Math.round(incentive * 100),
    color: tier.color,
  };
}

const tierColors = ["#25875A", "#2878B8", "#C68120", "#7558B5", "#C45252"];

function currentMonthInManila(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}`;
}

function monthLabel(month: string): string {
  return new Date(`${month}-01T12:00:00+08:00`).toLocaleDateString("en-PH", {
    month: "long",
    year: "numeric",
    timeZone: "Asia/Manila",
  });
}

function shiftMonth(month: string, amount: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, monthNumber! - 1 + amount, 1))
    .toISOString()
    .slice(0, 7);
}

export function MonthlyIncentiveSettings({
  onSaved,
}: {
  onSaved?: () => void;
} = {}) {
  const [draft, setDraft] = useState<SettingDraft>(() =>
    makeDraft(defaultMonthlyIncentiveSetting),
  );
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [goalMonth, setGoalMonth] = useState(currentMonthInManila);

  useEffect(() => {
    let active = true;
    void api
      .get<MonthlyIncentiveSetting>(
        `/settings/monthly-incentive?month=${encodeURIComponent(goalMonth)}`,
      )
      .then((setting) => {
        if (active) setDraft(makeDraft(setting));
      })
      .catch(() => {
        if (active) {
          setLoadFailed(true);
          setError("Unable to load monthly incentive settings.");
        }
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [goalMonth]);

  function changeGoalMonth(month: string) {
    if (!month || month === goalMonth) return;
    setLoaded(false);
    setLoadFailed(false);
    setError("");
    setNotice("");
    setGoalMonth(month);
  }

  function updateTier(index: number, key: keyof TierDraft, value: string) {
    setDraft((current) => ({
      ...current,
      tiers: current.tiers.map((tier, tierIndex) =>
        tierIndex === index ? { ...tier, [key]: value } : tier,
      ),
    }));
    setNotice("");
  }

  function addTier() {
    setDraft((current) => {
      const last = current.tiers.at(-1);
      const previousTarget = Number(last?.salesTarget ?? 0);
      const previousIncentive = Number(last?.incentive ?? 0);
      return {
        ...current,
        tiers: [
          ...current.tiers,
          {
            salesTarget: String(previousTarget + 250_000),
            incentive: String(previousIncentive + 50),
            color: tierColors[current.tiers.length % tierColors.length]!,
          },
        ],
      };
    });
    setNotice("");
  }

  function removeTier(index: number) {
    setDraft((current) => ({
      ...current,
      tiers: current.tiers.filter((_, tierIndex) => tierIndex !== index),
    }));
    setNotice("");
  }

  async function save() {
    setError("");
    setNotice("");
    const tiers = draft.tiers.map(tierFromDraft);
    if (tiers.some((tier) => tier === null)) {
      setError("Enter valid sales targets and incentive amounts.");
      return;
    }
    const parsed = monthlyIncentiveSettingSchema.safeParse({
      enabled: draft.enabled,
      showOnCheckout: draft.showOnCheckout,
      showGoalAndIncentive: draft.showGoalAndIncentive,
      tiers,
    });
    if (!parsed.success) {
      setError(
        parsed.error.issues.some((issue) =>
          issue.path.includes("salesTargetCentavos"),
        )
          ? "Sales targets must increase from one tier to the next."
          : parsed.error.issues.some((issue) =>
                issue.path.includes("incentiveCentavos"),
              )
            ? "Incentive amounts cannot decrease at higher sales tiers."
            : "Keep between 1 and 12 incentive tiers and check each color and amount.",
      );
      return;
    }

    setSaving(true);
    try {
      const saved = await api.put<MonthlyIncentiveSetting>(
        `/settings/monthly-incentive?month=${encodeURIComponent(goalMonth)}`,
        parsed.data,
      );
      setDraft(makeDraft(saved));
      onSaved?.();
      setNotice(
        `Saved ${monthLabel(goalMonth)} goals and incentive settings. ${
          saved.enabled && saved.showOnCheckout
            ? "Progress is available on Monthly Goals and Checkout."
            : saved.enabled
              ? "Progress is available on Monthly Goals."
              : "Monthly Goals is hidden from cashier accounts."
        }`,
      );
    } catch {
      setError("Unable to save monthly incentive settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-main-card monthly-incentive-settings">
      <div className="card-heading">
        <div>
          <h2>Monthly sales incentives</h2>
          <p>
            Set monthly sales milestones, incentive amounts, and tier colors.
            Each month keeps its saved goals when you update another month.
          </p>
        </div>
      </div>
      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="banner banner-success" role="status">
          {notice}
        </div>
      )}
      <div className="monthly-incentive-settings-body">
        <div
          className="monthly-incentive-month-field"
          role="group"
          aria-label="Choose monthly goals month"
        >
          <button
            className="button button-quiet"
            type="button"
            aria-label={`Previous month from ${monthLabel(goalMonth)}`}
            disabled={!loaded || loadFailed || saving}
            onClick={() => changeGoalMonth(shiftMonth(goalMonth, -1))}
          >
            <ChevronLeft size={16} /> Previous
          </button>
          <div className="monthly-incentive-month-label">
            <span>Goals for</span>
            <strong>{monthLabel(goalMonth)}</strong>
          </div>
          <button
            className="button button-quiet"
            type="button"
            aria-label={`Next month after ${monthLabel(goalMonth)}`}
            disabled={!loaded || loadFailed || saving}
            onClick={() => changeGoalMonth(shiftMonth(goalMonth, 1))}
          >
            Next <ChevronRight size={16} />
          </button>
        </div>

        <label className="inventory-checkbox monthly-incentive-toggle">
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={!loaded || loadFailed || saving}
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                enabled: event.target.checked,
              }));
              setNotice("");
            }}
          />
          <span>
            <strong>Show Monthly Goals to cashiers</strong>
            <small>
              {draft.enabled
                ? "Cashiers can open Monthly Goals and view current progress."
                : "Cashiers cannot see this page. Owner controls remain available here."}
            </small>
          </span>
        </label>

        <label className="inventory-checkbox monthly-incentive-checkout-toggle">
          <input
            type="checkbox"
            checked={draft.showOnCheckout}
            disabled={!loaded || loadFailed || saving}
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                showOnCheckout: event.target.checked,
              }));
              setNotice("");
            }}
          />
          <span>
            <strong>Also show progress at the top of Checkout</strong>
            <small>
              Optional and off by default. The Dashboard remains available when
              incentives are enabled.
            </small>
          </span>
        </label>

        <label className="inventory-checkbox monthly-incentive-checkout-toggle">
          <input
            type="checkbox"
            checked={draft.showGoalAndIncentive}
            disabled={!loaded || loadFailed || saving}
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                showGoalAndIncentive: event.target.checked,
              }));
              setNotice("");
            }}
          />
          <span>
            <strong>Show goal and incentive amounts</strong>
            <small>
              Off by default for cashiers. Owners always see amounts on Monthly
              Goals; this option controls amounts on the cashier view and
              Checkout.
            </small>
          </span>
        </label>

        <div className="monthly-incentive-tier-editor">
          <h3>Sales milestones</h3>
          <div className="monthly-incentive-editor-heading">
            <span>Monthly sales target</span>
            <span>Incentive</span>
            <span>Tier color</span>
            <span className="visually-hidden">Actions</span>
          </div>
          {draft.tiers.map((tier, index) => (
            <div className="monthly-incentive-editor-row" key={index}>
              <label>
                <span className="visually-hidden">
                  Tier {index + 1} monthly sales target in pesos
                </span>
                <span className="monthly-incentive-input-prefix">₱</span>
                <input
                  aria-label={`Tier ${index + 1} monthly sales target in pesos`}
                  className="text-input"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={tier.salesTarget}
                  disabled={!loaded || loadFailed || saving}
                  onChange={(event) =>
                    updateTier(index, "salesTarget", event.target.value)
                  }
                />
              </label>
              <label>
                <span className="visually-hidden">
                  Tier {index + 1} incentive in pesos
                </span>
                <span className="monthly-incentive-input-prefix">₱</span>
                <input
                  aria-label={`Tier ${index + 1} incentive in pesos`}
                  className="text-input"
                  type="number"
                  min="0"
                  step="0.01"
                  value={tier.incentive}
                  disabled={!loaded || loadFailed || saving}
                  onChange={(event) =>
                    updateTier(index, "incentive", event.target.value)
                  }
                />
              </label>
              <label className="monthly-incentive-color-control">
                <span className="visually-hidden">Tier {index + 1} color</span>
                <input
                  aria-label={`Tier ${index + 1} color`}
                  type="color"
                  value={tier.color}
                  disabled={!loaded || loadFailed || saving}
                  onChange={(event) =>
                    updateTier(index, "color", event.target.value)
                  }
                />
                <code>{tier.color.toUpperCase()}</code>
              </label>
              <button
                className="icon-button monthly-incentive-remove"
                type="button"
                aria-label={`Remove tier ${index + 1}`}
                title="Remove tier"
                disabled={
                  !loaded || loadFailed || saving || draft.tiers.length <= 1
                }
                onClick={() => removeTier(index)}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>

        <div className="monthly-incentive-setting-actions">
          <button
            className="button button-secondary"
            type="button"
            disabled={
              !loaded || loadFailed || saving || draft.tiers.length >= 12
            }
            onClick={addTier}
          >
            <Plus size={16} /> Add milestone
          </button>
          <button
            className="button button-primary"
            type="button"
            disabled={!loaded || loadFailed || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save monthly goals and settings"}
          </button>
        </div>
      </div>
    </section>
  );
}
