import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { MonthlyIncentiveTier } from "@medtryx/shared";
import { api } from "./api";

type MonthlyIncentiveProgressData = {
  month: string;
  salesCentavos: number;
  progressPercent: number;
  displayColor: string;
  nextTierAvailable: boolean;
  tiers?: MonthlyIncentiveTier[];
  showOnCheckout: boolean;
  showGoalAndIncentive: boolean;
};

function pesos(centavos: number): string {
  return `₱${new Intl.NumberFormat("en-PH", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(centavos / 100)}`;
}

function monthName(month: string): string {
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

export function MonthlyIncentiveProgress({
  placement,
  refreshKey,
  showDisabledState = false,
  allowMonthNavigation = false,
}: {
  placement: "dashboard" | "checkout";
  refreshKey: number;
  showDisabledState?: boolean;
  allowMonthNavigation?: boolean;
}) {
  const [progress, setProgress] = useState<MonthlyIncentiveProgressData | null>(
    null,
  );
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "failed">(
    "loading",
  );
  const [requestedMonth, setRequestedMonth] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const query = requestedMonth
      ? `?month=${encodeURIComponent(requestedMonth)}`
      : "";
    void api
      .get<{ progress: MonthlyIncentiveProgressData | null }>(
        `/dashboard/monthly-incentive${query}`,
      )
      .then(({ progress: result }) => {
        if (active) {
          setProgress(result);
          setLoadState("loaded");
        }
      })
      .catch(() => {
        if (active) {
          setProgress(null);
          setLoadState("failed");
        }
      });
    return () => {
      active = false;
    };
  }, [refreshKey, requestedMonth]);

  if (
    placement === "dashboard" &&
    showDisabledState &&
    loadState === "loading"
  ) {
    return (
      <div className="monthly-incentive-dashboard-state" role="status">
        Loading monthly sales progress…
      </div>
    );
  }
  if (
    placement === "dashboard" &&
    showDisabledState &&
    loadState === "failed"
  ) {
    return (
      <div
        className="monthly-incentive-dashboard-state monthly-incentive-dashboard-empty"
        role="status"
      >
        Unable to load monthly sales progress. Refresh the page to try again.
      </div>
    );
  }
  if (!progress || (progress.showGoalAndIncentive && !progress.tiers?.length)) {
    return placement === "dashboard" && showDisabledState ? (
      <div className="monthly-incentive-dashboard-state monthly-incentive-dashboard-empty">
        Monthly sales progress has not been enabled by the owner yet.
      </div>
    ) : null;
  }
  if (placement === "checkout" && !progress.showOnCheckout) return null;

  const tiers = progress.tiers ?? [];
  const nextTierIndex = tiers.findIndex(
    (tier) => tier.salesTargetCentavos > progress.salesCentavos,
  );
  const nextTier = nextTierIndex >= 0 ? tiers[nextTierIndex]! : null;
  const displayTier = nextTier ?? tiers.at(-1);
  const remaining = displayTier
    ? Math.max(0, displayTier.salesTargetCentavos - progress.salesCentavos)
    : 0;
  const monthLabel = monthName(progress.month);

  return (
    <section
      className="monthly-incentive-card"
      aria-label="Monthly sales progress"
      style={
        { "--monthly-incentive-color": progress.displayColor } as CSSProperties
      }
    >
      <div className="monthly-incentive-heading">
        <div>
          <span className="eyebrow">MONTHLY SALES PROGRESS</span>
          <h2>{monthLabel}</h2>
        </div>
        <div className="monthly-incentive-heading-actions">
          <span
            className={`monthly-incentive-status ${progress.nextTierAvailable ? "" : "monthly-incentive-complete"}`}
          >
            {progress.nextTierAvailable ? "In progress" : "Top tier reached"}
          </span>
          {allowMonthNavigation && (
            <nav
              className="monthly-incentive-month-navigation"
              aria-label="Dashboard month"
            >
              <button
                className="button button-quiet"
                type="button"
                onClick={() => {
                  setProgress(null);
                  setLoadState("loading");
                  setRequestedMonth(shiftMonth(progress.month, -1));
                }}
              >
                Previous month
              </button>
              {requestedMonth && (
                <button
                  className="button button-quiet"
                  type="button"
                  onClick={() => {
                    setProgress(null);
                    setLoadState("loading");
                    setRequestedMonth(null);
                  }}
                >
                  This month
                </button>
              )}
            </nav>
          )}
        </div>
      </div>

      <div className="monthly-incentive-sales-row">
        <span>Sales achieved</span>
        <strong>{pesos(progress.salesCentavos)}</strong>
      </div>
      <div
        className="monthly-incentive-track"
        role="progressbar"
        aria-label={
          progress.nextTierAvailable
            ? progress.showGoalAndIncentive
              ? `Progress to ${pesos(displayTier!.salesTargetCentavos)} sales`
              : "Progress to next monthly milestone"
            : "Top monthly incentive tier reached"
        }
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.progressPercent}
      >
        <span style={{ width: `${progress.progressPercent}%` }} />
      </div>
      <div className="monthly-incentive-progress-caption">
        <span>
          {progress.nextTierAvailable
            ? `${progress.progressPercent}% to next milestone`
            : "100% complete"}
        </span>
        {progress.showGoalAndIncentive && (
          <span>
            {nextTier
              ? `Target: ${pesos(displayTier!.salesTargetCentavos)}`
              : `Top target: ${pesos(displayTier!.salesTargetCentavos)}`}
          </span>
        )}
      </div>

      {progress.showGoalAndIncentive && (
        <>
          <div className="monthly-incentive-summary">
            <div>
              <span>Remaining sales</span>
              <strong>
                {progress.nextTierAvailable
                  ? pesos(remaining)
                  : "Top tier reached"}
              </strong>
            </div>
            <div>
              <span>
                {progress.nextTierAvailable
                  ? "Potential incentive"
                  : "Top incentive reached"}
              </span>
              <strong>{pesos(displayTier!.incentiveCentavos)}</strong>
            </div>
          </div>

          <div
            className="monthly-incentive-tiers"
            aria-label="Incentive milestones"
          >
            {tiers.map((tier) => {
              const achieved =
                tier.salesTargetCentavos <= progress.salesCentavos;
              return (
                <span
                  className={`monthly-incentive-tier ${achieved ? "monthly-incentive-tier-achieved" : ""}`}
                  key={tier.salesTargetCentavos}
                  style={{ "--tier-color": tier.color } as CSSProperties}
                >
                  <i aria-hidden="true" />
                  <span>
                    {pesos(tier.salesTargetCentavos)} sales ·{" "}
                    {pesos(tier.incentiveCentavos)}
                  </span>
                  {achieved && <small>Reached</small>}
                </span>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
