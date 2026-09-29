import { useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { api } from "./api";

type SalesReport = {
  businessDate: string;
  startDate: string;
  endDate: string;
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
      [
        "Cash rounding adjustments (net of reversals)",
        "cashRoundingAdjustments",
      ],
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

async function fetchReport(
  startDate: string,
  endDate: string,
): Promise<SalesReport> {
  const query = new URLSearchParams({ startDate, endDate });
  const result = await api.get<{ report: SalesReport }>(
    `/reports/range?${query}`,
  );
  return result.report;
}

export function ReportsPage() {
  const [startDate, setStartDate] = useState(todayInManila);
  const [endDate, setEndDate] = useState(todayInManila);
  const [report, setReport] = useState<SalesReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadReport(selectedStart = startDate, selectedEnd = endDate) {
    try {
      setReport(await fetchReport(selectedStart, selectedEnd));
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
    void fetchReport(startDate, endDate)
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
  }, [startDate, endDate]);

  function downloadCsv() {
    window.location.assign(
      `/api/reports/range.csv?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`,
    );
  }

  function selectMonthToDate() {
    const today = todayInManila();
    setLoading(true);
    setError("");
    setStartDate(`${today.slice(0, 7)}-01`);
    setEndDate(today);
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
          <h1>Sales reports</h1>
          <p>Review saved sales and cash activity for any Manila date range.</p>
        </div>
        <div className="report-actions">
          <label className="report-date-field">
            <span className="field-label">Start date</span>
            <input
              aria-label="Start date"
              className="text-input"
              type="date"
              value={startDate}
              onChange={(event) => {
                setLoading(true);
                setError("");
                setStartDate(event.target.value);
              }}
            />
          </label>
          <label className="report-date-field">
            <span className="field-label">End date</span>
            <input
              aria-label="End date"
              className="text-input"
              type="date"
              value={endDate}
              onChange={(event) => {
                setLoading(true);
                setError("");
                setEndDate(event.target.value);
              }}
            />
          </label>
          <button
            className="button button-secondary"
            type="button"
            onClick={selectMonthToDate}
            disabled={loading}
          >
            Month to date
          </button>
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
      {loading && <div className="table-loading">Loading report…</div>}
      {report && !loading && (
        <>
          <div className="report-summary-strip">
            <div>
              <span>REPORT PERIOD</span>
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
                <p>
                  Current balances shown beside the selected period's activity.
                </p>
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
