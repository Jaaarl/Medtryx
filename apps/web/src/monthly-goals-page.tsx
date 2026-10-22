import { useState } from "react";
import { useAuth } from "./auth-context";
import { MonthlyIncentiveProgress } from "./monthly-incentive-progress";
import { MonthlyIncentiveSettings } from "./monthly-incentive-settings";

export function MonthlyGoalsPage() {
  const { user } = useAuth();
  const [refreshKey, setRefreshKey] = useState(0);
  const isOwner = user?.role === "owner";

  return (
    <section className="page-section monthly-sales-dashboard">
      <div className="page-heading">
        <div>
          <div className="eyebrow">STORE PERFORMANCE</div>
          <h1>Monthly Goals</h1>
          <p>Review monthly sales progress and incentive milestones.</p>
        </div>
        {isOwner && <span className="secure-badge">OWNER CONTROLS</span>}
      </div>
      <MonthlyIncentiveProgress
        placement="monthly-goals"
        refreshKey={refreshKey}
        showDisabledState={isOwner}
        allowMonthNavigation={isOwner}
      />
      {isOwner && (
        <MonthlyIncentiveSettings
          onSaved={() => setRefreshKey((current) => current + 1)}
        />
      )}
    </section>
  );
}
