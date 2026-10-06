import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "./api";

type DailySalesSummary = {
  businessDate: string;
  scope: "STORE" | "CASHIER";
  totals: {
    transactionCount: number;
    sales: string;
    cashSales: string;
    qrSales: string;
  };
  shifts: Array<{
    id: string;
    cashierEmail: string;
    openedAt: string;
    closedAt: string | null;
    transactionCount: number;
    sales: string;
    cashSales: string;
    qrSales: string;
  }>;
  products: Array<{
    sku: string;
    name: string;
    quantity: number;
    sales: string;
  }>;
};

function todayInManila(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function localTime(value: string): string {
  return new Date(value).toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function DailySalesSummaryPage() {
  const [date, setDate] = useState(todayInManila);
  const [summary, setSummary] = useState<DailySalesSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void api
      .get<{ summary: DailySalesSummary }>(
        `/shifts/daily-sales-summary?date=${encodeURIComponent(date)}`,
      )
      .then(({ summary: nextSummary }) => {
        if (!active) return;
        setSummary(nextSummary);
        setError("");
      })
      .catch(() => {
        if (!active) return;
        setSummary(null);
        setError("Unable to load the daily sales summary. Try refreshing.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [date, refreshKey]);

  return (
    <section className="page-section reports-page daily-sales-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">REGISTER SUMMARY</div>
          <h1>Daily sales</h1>
          <p>
            Review sales by shift and the products sold for a Manila business
            date.
          </p>
        </div>
        <div className="daily-sales-actions">
          <label className="report-date-field">
            <span className="field-label">Business date</span>
            <input
              aria-label="Business date"
              className="text-input"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
          <button
            className="button button-secondary"
            type="button"
            onClick={() => setRefreshKey((value) => value + 1)}
            disabled={loading}
          >
            <RefreshCw size={16} /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      {loading && <div className="table-loading">Loading daily sales…</div>}
      {summary && !loading && (
        <>
          <div className="report-summary-strip daily-sales-totals">
            <div>
              <span>BUSINESS DATE</span>
              <strong>{summary.businessDate}</strong>
            </div>
            <div>
              <span>TRANSACTIONS</span>
              <strong>{summary.totals.transactionCount}</strong>
            </div>
            <div>
              <span>TOTAL SALES</span>
              <strong>₱{summary.totals.sales}</strong>
            </div>
            <div>
              <span>CASH / QR</span>
              <strong>
                ₱{summary.totals.cashSales} / ₱{summary.totals.qrSales}
              </strong>
            </div>
          </div>

          <section className="settings-main-card report-low-stock">
            <div className="card-heading">
              <div>
                <h2>Sales by shift</h2>
                <p>
                  {summary.scope === "STORE"
                    ? "All register shifts with sales on this date."
                    : "Your shifts with sales on this date."}
                </p>
              </div>
              <span className="count-chip">{summary.shifts.length} shifts</span>
            </div>
            {summary.shifts.length ? (
              <div className="inventory-table-wrap">
                <table className="inventory-table">
                  <thead>
                    <tr>
                      <th>CASHIER</th>
                      <th>OPENED</th>
                      <th>CLOSED</th>
                      <th>TRANSACTIONS</th>
                      <th>TOTAL SALES</th>
                      <th>CASH</th>
                      <th>QR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.shifts.map((shift) => (
                      <tr key={shift.id}>
                        <td>{shift.cashierEmail}</td>
                        <td>{localTime(shift.openedAt)}</td>
                        <td>
                          {shift.closedAt ? localTime(shift.closedAt) : "Open"}
                        </td>
                        <td>{shift.transactionCount}</td>
                        <td>₱{shift.sales}</td>
                        <td>₱{shift.cashSales}</td>
                        <td>₱{shift.qrSales}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="report-empty">
                No shifts recorded sales on this date.
              </p>
            )}
          </section>

          <section className="settings-main-card report-low-stock">
            <div className="card-heading">
              <div>
                <h2>Products sold</h2>
                <p>Quantities and line totals from saved sales on this date.</p>
              </div>
              <span className="count-chip">
                {summary.products.length} products
              </span>
            </div>
            {summary.products.length ? (
              <div className="inventory-table-wrap">
                <table className="inventory-table">
                  <thead>
                    <tr>
                      <th>PRODUCT</th>
                      <th>SKU</th>
                      <th>QUANTITY SOLD</th>
                      <th>LINE TOTAL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.products.map((product) => (
                      <tr key={`${product.sku}-${product.name}`}>
                        <td>{product.name}</td>
                        <td>{product.sku}</td>
                        <td>{product.quantity}</td>
                        <td>₱{product.sales}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="report-empty">
                No products were sold on this date.
              </p>
            )}
          </section>
        </>
      )}
      <div className="report-notes">
        <p>
          Cashiers see their own shifts and products. Owners see store totals
          across all cashiers. Product quantities show sold units before
          refunds.
        </p>
      </div>
    </section>
  );
}
