import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { MonthlyIncentiveTier } from "@medtryx/shared";
import { api } from "./api";

type MonthlyIncentiveProgressData = {
  month: string;
  salesCentavos: number;
  tiers: MonthlyIncentiveTier[];
  showOnCheckout: boolean;
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

export function MonthlyIncentiveProgress({
  placement,
  refreshKey,
}: {
  placement: "dashboard" | "checkout";
  refreshKey: number;
}) {
  const [progress, setProgress] = useState<MonthlyIncentiveProgressData | null>(
    null,
  );
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "failed">(
    "loading",
  );

  useEffect(() => {
    let active = true;
    void api
      .get<{ progress: MonthlyIncentiveProgressData | null }>(
        "/dashboard/monthly-incentive",
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
  }, [refreshKey]);

  if (placement === "dashboard" && loadState === "loading") {
    return (
      <div className="monthly-incentive-dashboard-state" role="status">
        Loading monthly sales progress…
      </div>
    );
  }
  if (placement === "dashboard" && loadState === "failed") {
    return (
      <div
        className="monthly-incentive-dashboard-state monthly-incentive-dashboard-empty"
        role="status"
      >
        Unable to load monthly sales progress. Refresh the page to try again.
      </div>
    );
  }
  if (!progress || progress.tiers.length === 0) {
    return placement === "dashboard" ? (
      <div className="monthly-incentive-dashboard-state monthly-incentive-dashboard-empty">
        Monthly sales progress has not been enabled by the owner yet.
      </div>
    ) : null;
  }
  if (placement === "checkout" && !progress.showOnCheckout) return null;

  const currentTierIndex = progress.tiers.reduce(
    (matched, tier, index) =>
      tier.salesTargetCentavos <= progress.salesCentavos ? index : matched,
    -1,
  );
  const nextTierIndex = progress.tiers.findIndex(
    (tier) => tier.salesTargetCentavos > progress.salesCentavos,
  );
  const nextTier = nextTierIndex >= 0 ? progress.tiers[nextTierIndex]! : null;
  const displayTier = nextTier ?? progress.tiers.at(-1)!;
  const previousTarget =
    currentTierIndex >= 0
      ? progress.tiers[currentTierIndex]!.salesTargetCentavos
      : 0;
  const span = displayTier.salesTargetCentavos - previousTarget;
  const progressPercent = nextTier
    ? Math.min(
        100,
        Math.max(
          0,
          Math.round(((progress.salesCentavos - previousTarget) / span) * 100),
        ),
      )
    : 100;
  const remaining = Math.max(
    0,
    displayTier.salesTargetCentavos - progress.salesCentavos,
  );
  const monthLabel = monthName(progress.month);

  return (
    <section
      className="monthly-incentive-card"
      aria-label="Monthly sales progress"
      style={
        { "--monthly-incentive-color": displayTier.color } as CSSProperties
      }
    >
      <div className="monthly-incentive-heading">
        <div>
          <span className="eyebrow">MONTHLY SALES PROGRESS</span>
          <h2>{monthLabel}</h2>
        </div>
        <span
          className={`monthly-incentive-status ${nextTier ? "" : "monthly-incentive-complete"}`}
        >
          {nextTier ? "In progress" : "Top tier reached"}
        </span>
      </div>

      <div className="monthly-incentive-sales-row">
        <span>Sales achieved</span>
        <strong>{pesos(progress.salesCentavos)}</strong>
      </div>
      <div
        className="monthly-incentive-track"
        role="progressbar"
        aria-label={
          nextTier
            ? `Progress to ${pesos(displayTier.salesTargetCentavos)} sales`
            : "Top monthly incentive tier reached"
        }
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progressPercent}
      >
        <span style={{ width: `${progressPercent}%` }} />
      </div>
      <div className="monthly-incentive-progress-caption">
        <span>
          {nextTier ? `${progressPercent}% to next milestone` : "100% complete"}
        </span>
        <span>
          {nextTier
            ? `Target: ${pesos(displayTier.salesTargetCentavos)}`
            : `Top target: ${pesos(displayTier.salesTargetCentavos)}`}
        </span>
      </div>

      <div className="monthly-incentive-summary">
        <div>
          <span>Remaining sales</span>
          <strong>{nextTier ? pesos(remaining) : "Top tier reached"}</strong>
        </div>
        <div>
          <span>
            {nextTier ? "Potential incentive" : "Top incentive reached"}
          </span>
          <strong>{pesos(displayTier.incentiveCentavos)}</strong>
        </div>
      </div>

      <div
        className="monthly-incentive-tiers"
        aria-label="Incentive milestones"
      >
        {progress.tiers.map((tier, index) => {
          const achieved = index <= currentTierIndex;
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
    </section>
  );
}
