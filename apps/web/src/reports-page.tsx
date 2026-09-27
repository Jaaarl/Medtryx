import { useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { api } from "./api";

type DailyReport = {
  businessDate: string;
  timeZone: string;
  generatedAt: string;
  metrics: Record<string, string>;
  reversalCount: number;
  inventory: {
    activeProductCount: number;
    lowStockCount: number;
    inventoryValue: string;
    lowStock: Array<{
      sku: string;
      name: string;
      unit: string;
      quantityOnHand: number;
      reorderLevel: number;
      inventoryValue: string;
    }>;
  };
  notes: string[];
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

const metricGroups: Array<{
  heading: string;
  metrics: Array<[string, string]>;
}> = [
  {
    heading: "Sales and profit",
    metrics: [
      ["Gross sales", "grossSales"],
      ["Net sales excluding VAT", "netSalesExcludingVat"],
      ["Estimated gross profit", "estimatedGrossProfit"],
      ["COGS", "cogs"],
      ["Full reversals", "reversalCount"],
    ],
  },
  {
    heading: "Tax and discounts",
    metrics: [
      ["VATable sales base", "vatableSalesBase"],
      ["VAT-exempt sales", "vatExemptSales"],
      ["Zero-rated sales", "zeroRatedSales"],
      ["Output VAT", "vatOutput"],
      ["VAT removed for benefits", "vatRemoved"],
      ["Senior citizen discounts", "seniorDiscounts"],
      ["PWD discounts", "pwdDiscounts"],
    ],
  },
  {
    heading: "Declared payments and cash movement",
    metrics: [
      ["Cash sales", "cashSales"],
      ["QR sales", "qrSales"],
      ["Cash refunds", "cashRefunds"],
      ["QR refunds", "qrRefunds"],
      ["Cash-in", "cashIn"],
      ["Cash-out", "cashOut"],
      ["Net cash impact", "netCashImpact"],
    ],
  },
  {
    heading: "Stock",
    metrics: [["Write-off value", "writeOffValue"]],
  },
];

async function fetchDailyReport(day: string): Promise<DailyReport> {
  const result = await api.get<{ report: DailyReport }>(
    `/reports/daily?date=${encodeURIComponent(day)}`,
  );
  return result.report;
}

export function ReportsPage() {
  const [date, setDate] = useState(todayInManila);
  const [report, setReport] = useState<DailyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadReport(selectedDate = date) {
    try {
      setReport(await fetchDailyReport(selectedDate));
      setError("");
    } catch {
      setReport(null);
      setError("Unable to load the report. Check the date and try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void fetchDailyReport(date)
      .then((nextReport) => {
        if (active) {
          setReport(nextReport);
          setError("");
        }
      })
      .catch(() => {
        if (active) {
          setReport(null);
          setError("Unable to load the report. Check the date and try again.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [date]);

  function downloadCsv() {
    window.location.assign(
      `/api/reports/daily.csv?date=${encodeURIComponent(date)}`,
    );
  }

  const metricValue = (key: string) =>
    key === "reversalCount"
      ? String(report?.reversalCount ?? 0)
      : `₱${report?.metrics[key] ?? "0.00"}`;

  return (
    <section className="page-section reports-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">OWNER REPORTING</div>
          <h1>Daily reports</h1>
          <p>Saved sales, tax, cash declarations, and inventory estimates.</p>
        </div>
        <div className="report-actions">
          <label className="report-date-field">
            <span className="field-label">Manila business date</span>
            <input
              aria-label="Manila business date"
              className="text-input"
              type="date"
              value={date}
              onChange={(event) => {
                setLoading(true);
                setError("");
                setDate(event.target.value);
              }}
            />
          </label>
          <button
            className="button button-secondary"
            type="button"
            onClick={() => {
              setLoading(true);
              setError("");
              void loadReport();
            }}
            disabled={loading}
          >
            <RefreshCw size={16} /> Refresh
          </button>
          <button
            className="button button-primary"
            type="button"
            onClick={downloadCsv}
            disabled={!report}
          >
            <Download size={16} /> Export CSV
          </button>
        </div>
      </div>

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      {loading && <div className="table-loading">Loading daily report…</div>}
      {report && !loading && (
        <>
          <div className="report-summary-strip">
            <div>
              <span>REPORT DATE</span>
              <strong>{report.businessDate}</strong>
            </div>
            <div>
              <span>ACTIVE PRODUCTS</span>
              <strong>{report.inventory.activeProductCount}</strong>
            </div>
            <div>
              <span>LOW STOCK</span>
              <strong>{report.inventory.lowStockCount}</strong>
            </div>
            <div>
              <span>CURRENT INVENTORY VALUE</span>
              <strong>₱{report.inventory.inventoryValue}</strong>
            </div>
          </div>

          <div className="report-group-grid">
            {metricGroups.map((group) => (
              <section className="report-group-card" key={group.heading}>
                <h2>{group.heading}</h2>
                <dl>
                  {group.metrics.map(([label, key]) => (
                    <div className="report-metric-row" key={key}>
                      <dt>{label}</dt>
                      <dd>{metricValue(key)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>

          <section className="settings-main-card report-low-stock">
            <div className="card-heading">
              <div>
                <h2>Current low stock</h2>
                <p>Current balances shown with today’s selected report.</p>
              </div>
              <span className="count-chip">
                {report.inventory.lowStock.length} products
              </span>
            </div>
            {report.inventory.lowStock.length ? (
              <div className="inventory-table-wrap">
                <table className="inventory-table">
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Product</th>
                      <th>On hand</th>
                      <th>Reorder level</th>
                      <th>Inventory value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.inventory.lowStock.map((product) => (
                      <tr key={product.sku}>
                        <td>{product.sku}</td>
                        <td>{product.name}</td>
                        <td>
                          {product.quantityOnHand} {product.unit}
                        </td>
                        <td>{product.reorderLevel}</td>
                        <td>₱{product.inventoryValue}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="report-empty">
                No active products are at or below their reorder level.
              </p>
            )}
          </section>

          <div className="report-notes">
            {report.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
            <small>
              Generated{" "}
              {new Date(report.generatedAt).toLocaleString("en-PH", {
                timeZone: "Asia/Manila",
              })}{" "}
              · {report.timeZone}
            </small>
          </div>
        </>
      )}
    </section>
  );
}
