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
  transactionChanges: Array<{
    transactionId: string;
    changedAt: string;
    changedByEmail: string;
    changedByRole: "owner" | "cashier";
    kind: "PAYMENT_SWITCH" | "CANCELLATION" | "REVERSAL";
    reason: string;
    payment: {
      fromMethod: "CASH" | "QR";
      toMethod: "CASH" | "QR";
      cashAmount: string;
      qrAmount: string;
    } | null;
    refund: { method: "CASH" | "QR"; amount: string } | null;
  }>;
  bundlePromotions: Array<{
    code: string;
    name: string;
    version: number;
    quantity: number;
    regularTotal: string;
    promotionalPricePerBundle: string;
    promotionalDiscountOffered: string;
    promotionalDiscountApplied: string;
  }>;
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

type BenefitTransaction = {
  transactionId: string;
  businessDate: string;
  createdAt: string;
  benefitType: "SENIOR_CITIZEN" | "PWD";
  customerName: string;
  customerIdNumber: string;
  products: Array<{ name: string; quantity: number }>;
};

type DailySalesEntry = {
  businessDate: string;
  month: string;
  date: string;
  invoiceNumberRange: string;
  seniorDiscount: string;
  nonVat: string;
  vatableSales: string;
  totalVat: string;
  grossSales: string;
  netSales: string;
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
      [
        "Bundle promotional discounts (net of reversals)",
        "bundlePromotionalDiscounts",
      ],
    ],
  },
  {
    heading: "Payments and refunds",
    metrics: [
      ["Cash sales (before refunds)", "cashSales"],
      ["QR sales (before refunds)", "qrSales"],
      [
        "Cash rounding adjustments (net of reversals)",
        "cashRoundingAdjustments",
      ],
      ["QR rounding adjustments (net of reversals)", "qrRoundingAdjustments"],
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

function monthLabel(month: string): string {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  return new Intl.DateTimeFormat("en-PH", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

async function fetchDailySales(
  startDate: string,
  endDate: string,
): Promise<DailySalesEntry[]> {
  const query = new URLSearchParams({ startDate, endDate });
  const result = await api.get<{ entries: DailySalesEntry[] }>(
    `/shifts/daily-sales-summary/range?${query}`,
  );
  return result.entries;
}

export function ReportsPage() {
  const [startDate, setStartDate] = useState(todayInManila);
  const [endDate, setEndDate] = useState(todayInManila);
  const [report, setReport] = useState<SalesReport | null>(null);
  const [benefitTransactions, setBenefitTransactions] = useState<
    BenefitTransaction[]
  >([]);
  const [dailySalesEntries, setDailySalesEntries] = useState<DailySalesEntry[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadReport(selectedStart = startDate, selectedEnd = endDate) {
    try {
      const query = new URLSearchParams({
        startDate: selectedStart,
        endDate: selectedEnd,
      });
      const [nextReport, nextBenefits, nextDailySalesEntries] =
        await Promise.all([
          fetchReport(selectedStart, selectedEnd),
          api.get<{ transactions: BenefitTransaction[] }>(
            `/reports/beneficiaries/range?${query}`,
          ),
          fetchDailySales(selectedStart, selectedEnd),
        ]);
      setReport(nextReport);
      setBenefitTransactions(nextBenefits.transactions);
      setDailySalesEntries(nextDailySalesEntries);
      setError("");
    } catch {
      setReport(null);
      setBenefitTransactions([]);
      setDailySalesEntries([]);
      setError("Unable to load the report. Check the date and try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ startDate, endDate });
    void Promise.all([
      fetchReport(startDate, endDate),
      api.get<{ transactions: BenefitTransaction[] }>(
        `/reports/beneficiaries/range?${query}`,
      ),
      fetchDailySales(startDate, endDate),
    ])
      .then(([nextReport, nextBenefits, nextDailySalesEntries]) => {
        if (active) {
          setReport(nextReport);
          setBenefitTransactions(nextBenefits.transactions);
          setDailySalesEntries(nextDailySalesEntries);
          setError("");
        }
      })
      .catch(() => {
        if (active) {
          setReport(null);
          setBenefitTransactions([]);
          setDailySalesEntries([]);
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

  function selectToday() {
    const today = todayInManila();
    setLoading(true);
    setError("");
    setStartDate(today);
    setEndDate(today);
  }

  function selectYearToDate() {
    const today = todayInManila();
    setLoading(true);
    setError("");
    setStartDate(`${today.slice(0, 4)}-01-01`);
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
            onClick={selectToday}
            disabled={loading}
          >
            Today
          </button>
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
            onClick={selectYearToDate}
            disabled={loading}
          >
            Year to date
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
                <h2>Daily sales summary</h2>
                <p>
                  Original Daily Sales totals for each business date in the
                  selected range.
                </p>
              </div>
              <span className="count-chip">
                {dailySalesEntries.length} days
              </span>
            </div>
            {dailySalesEntries.length ? (
              <div className="inventory-table-wrap">
                <table className="inventory-table">
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th>Date</th>
                      <th>Invoice number range</th>
                      <th>Senior discount</th>
                      <th>Non-VAT sales</th>
                      <th>VATable sales</th>
                      <th>Total VAT</th>
                      <th>Gross sales</th>
                      <th>Net sales</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dailySalesEntries.map((entry) => (
                      <tr key={entry.businessDate}>
                        <td>{monthLabel(entry.month)}</td>
                        <td>{entry.date}</td>
                        <td>{entry.invoiceNumberRange}</td>
                        <td>₱{entry.seniorDiscount}</td>
                        <td>₱{entry.nonVat}</td>
                        <td>₱{entry.vatableSales}</td>
                        <td>₱{entry.totalVat}</td>
                        <td>₱{entry.grossSales}</td>
                        <td>₱{entry.netSales}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="report-empty">
                No Daily Sales were recorded in the selected date range.
              </p>
            )}
          </section>

          <section className="settings-main-card report-low-stock">
            <div className="card-heading">
              <div>
                <h2>Transaction corrections</h2>
                <p>
                  Cancellations, reversals, and cash-to-QR switches made during
                  the selected Manila date range.
                </p>
              </div>
              <span className="count-chip">
                {report.transactionChanges.length} changes
              </span>
            </div>
            {report.transactionChanges.length ? (
              <div className="inventory-table-wrap">
                <table className="inventory-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Transaction</th>
                      <th>Action</th>
                      <th>Changed by</th>
                      <th>Reason</th>
                      <th>Payment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.transactionChanges.map((change) => (
                      <tr
                        key={`${change.transactionId}-${change.changedAt}-${change.kind}`}
                      >
                        <td>
                          {new Date(change.changedAt).toLocaleString("en-PH", {
                            timeZone: "Asia/Manila",
                            dateStyle: "medium",
                            timeStyle: "medium",
                          })}
                        </td>
                        <td>{change.transactionId}</td>
                        <td>
                          {change.kind === "PAYMENT_SWITCH"
                            ? "Cash to QR"
                            : change.kind === "CANCELLATION"
                              ? "Cancelled"
                              : "Reversed"}
                        </td>
                        <td>
                          {change.changedByEmail} ({change.changedByRole})
                        </td>
                        <td>{change.reason}</td>
                        <td>
                          {change.payment
                            ? `Cash ₱${change.payment.cashAmount} → QR ₱${change.payment.qrAmount}`
                            : change.refund
                              ? `${change.refund.method} refund ₱${change.refund.amount}`
                              : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="report-empty">
                No transaction corrections appear in this date range.
              </p>
            )}
          </section>

          <section className="settings-main-card report-low-stock">
            <div className="card-heading">
              <div>
                <h2>Senior citizen and PWD customers</h2>
                <p>
                  Benefit use and products for each sale in the selected Manila
                  date range.
                </p>
              </div>
              <span className="count-chip">
                {benefitTransactions.length} transactions
              </span>
            </div>
            {benefitTransactions.length ? (
              <div className="inventory-table-wrap">
                <table className="inventory-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Customer</th>
                      <th>ID number</th>
                      <th>Benefit</th>
                      <th>Products</th>
                      <th>Transaction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {benefitTransactions.map((transaction) => (
                      <tr key={transaction.transactionId}>
                        <td>
                          {new Date(transaction.createdAt).toLocaleString(
                            "en-PH",
                            {
                              timeZone: "Asia/Manila",
                              dateStyle: "medium",
                              timeStyle: "short",
                            },
                          )}
                        </td>
                        <td>{transaction.customerName}</td>
                        <td>{transaction.customerIdNumber}</td>
                        <td>
                          {transaction.benefitType === "SENIOR_CITIZEN"
                            ? "Senior citizen"
                            : "PWD"}
                        </td>
                        <td>
                          {transaction.products
                            .map(
                              (product) =>
                                `${product.name} × ${product.quantity}`,
                            )
                            .join(", ")}
                        </td>
                        <td>{transaction.transactionId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="report-empty">
                No senior citizen or PWD purchases appear in the selected
                period.
              </p>
            )}
            <small className="field-hint">
              Customer names and ID numbers are shown to owners only. Each list
              view is recorded in the audit history.
            </small>
          </section>

          <section className="settings-main-card report-low-stock">
            <div className="card-heading">
              <div>
                <h2>Bundle offer snapshots</h2>
                <p>
                  Original approved prices and component promotion outcomes from
                  sales in this period.
                </p>
              </div>
            </div>
            {report.bundlePromotions.length ? (
              <div className="inventory-table-wrap">
                <table className="inventory-table">
                  <thead>
                    <tr>
                      <th>Offer</th>
                      <th>Qty</th>
                      <th>Regular components</th>
                      <th>Offer price each</th>
                      <th>Discount offered</th>
                      <th>Discount applied</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.bundlePromotions.map((bundle, index) => (
                      <tr key={`${bundle.code}-${bundle.version}-${index}`}>
                        <td>
                          {bundle.code} · {bundle.name} · v{bundle.version}
                        </td>
                        <td>{bundle.quantity}</td>
                        <td>₱{bundle.regularTotal}</td>
                        <td>₱{bundle.promotionalPricePerBundle}</td>
                        <td>₱{bundle.promotionalDiscountOffered}</td>
                        <td>₱{bundle.promotionalDiscountApplied}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="report-empty">
                No bundle offers appear in the selected sales.
              </p>
            )}
          </section>

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
