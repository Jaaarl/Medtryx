import { Link } from "react-router";
import { useAuth } from "./auth-context";

export function DashboardPage() {
  const { user } = useAuth();

  return (
    <section className="page-section dashboard-home">
      <div className="page-heading">
        <div>
          <div className="eyebrow">STORE OVERVIEW</div>
          <h1>Dashboard</h1>
          <p>Choose an area to continue with today’s store operations.</p>
        </div>
      </div>
      <div className="dashboard-shortcuts" aria-label="Quick actions">
        <Link className="dashboard-shortcut" to="/checkout">
          <strong>Open Checkout</strong>
          <span>Start a sale or continue a cashier shift.</span>
        </Link>
        <Link className="dashboard-shortcut" to="/daily-sales">
          <strong>Daily sales</strong>
          <span>Review sales recorded for the day.</span>
        </Link>
        {user?.role === "owner" && (
          <Link className="dashboard-shortcut" to="/reports">
            <strong>Reports</strong>
            <span>Review store performance and activity.</span>
          </Link>
        )}
      </div>
    </section>
  );
}
