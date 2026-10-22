import { Link } from "react-router";
import { useAuth } from "./auth-context";
import { MonthlyIncentiveProgress } from "./monthly-incentive-progress";

export function DashboardPage() {
  const { user } = useAuth();

  return (
    <section className="page-section monthly-sales-dashboard">
      <div className="page-heading">
        <div>
          <div className="eyebrow">STORE OVERVIEW</div>
          <h1>Dashboard</h1>
          <p>
            Track this month’s store sales progress and incentive milestones.
          </p>
        </div>
      </div>
      <MonthlyIncentiveProgress placement="dashboard" refreshKey={0} />
      {user?.role === "owner" && (
        <p className="monthly-sales-dashboard-settings-link">
          <Link to="/settings">Manage monthly incentive settings</Link>
        </p>
      )}
    </section>
  );
}
