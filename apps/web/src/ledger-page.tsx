import { useEffect, useState } from "react";
import { Check, Pencil, RefreshCw, X } from "lucide-react";
import { api } from "./api";

type LedgerEntry = {
  sourceSaleId: string;
  month: string;
  invoiceNumber: string;
  seniorDiscount: string;
  nonVat: string;
  vatableSales: string;
  totalVat: string;
  grossSales: string;
  netSales: string;
  editedAt: string | null;
};

type LedgerDraft = Omit<LedgerEntry, "sourceSaleId" | "editedAt">;
type MoneyField =
  | "seniorDiscount"
  | "nonVat"
  | "vatableSales"
  | "totalVat"
  | "grossSales"
  | "netSales";

function currentMonth(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  return `${values.year}-${values.month}`;
}

function draftFor(entry: LedgerEntry): LedgerDraft {
  return {
    month: entry.month,
    invoiceNumber: entry.invoiceNumber,
    seniorDiscount: entry.seniorDiscount,
    nonVat: entry.nonVat,
    vatableSales: entry.vatableSales,
    totalVat: entry.totalVat,
    grossSales: entry.grossSales,
    netSales: entry.netSales,
  };
}

function monthName(month: string): string {
  return new Date(`${month}-01T00:00:00`).toLocaleDateString("en-PH", {
    month: "long",
    year: "numeric",
  });
}

const moneyFields: Array<{ key: MoneyField; label: string }> = [
  { key: "seniorDiscount", label: "Senior discount" },
  { key: "nonVat", label: "Non-VAT sales" },
  { key: "vatableSales", label: "VATable sales" },
  { key: "totalVat", label: "Total VAT" },
  { key: "grossSales", label: "Gross sales" },
  { key: "netSales", label: "Net sales" },
];

export function LedgerPage() {
  const [periodType, setPeriodType] = useState<"month" | "year">("month");
  const [month, setMonth] = useState(currentMonth);
  const [year, setYear] = useState(currentMonth().slice(0, 4));
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<LedgerDraft | null>(null);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const startMonth = periodType === "month" ? month : `${year}-01`;
  const endMonth = periodType === "month" ? month : `${year}-12`;
  const requestKey = `${startMonth}:${endMonth}:${refreshKey}`;
  const loading = loadedKey !== requestKey;

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ startMonth, endMonth });
    void api
      .get<{ entries: LedgerEntry[] }>(`/ledger/range?${query}`)
      .then(({ entries: nextEntries }) => {
        if (!active) return;
        setEntries(nextEntries);
        setError("");
      })
      .catch(() => {
        if (!active) return;
        setEntries([]);
        setError("Unable to load the ledger for this period. Try refreshing.");
      })
      .finally(() => {
        if (active) setLoadedKey(requestKey);
      });
    return () => {
      active = false;
    };
  }, [startMonth, endMonth, refreshKey, requestKey]);

  function beginEdit(entry: LedgerEntry) {
    setEditingId(entry.sourceSaleId);
    setDraft(draftFor(entry));
    setError("");
  }

  async function saveEdit(entry: LedgerEntry) {
    if (!draft) return;
    setSavingId(entry.sourceSaleId);
    setError("");
    try {
      const result = await api.patch<{ entry: LedgerEntry }>(
        `/ledger/${encodeURIComponent(entry.sourceSaleId)}`,
        draft,
      );
      setEntries((current) =>
        current.map((item) =>
          item.sourceSaleId === entry.sourceSaleId ? result.entry : item,
        ),
      );
      setEditingId(null);
      setDraft(null);
    } catch {
      setError("Unable to save this ledger row. Check its values and retry.");
    } finally {
      setSavingId(null);
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
    setError("");
  }

  const isEditing = (entry: LedgerEntry) =>
    editingId === entry.sourceSaleId && draft !== null;
  const draftValue = (entry: LedgerEntry) =>
    isEditing(entry) ? draft! : draftFor(entry);

  return (
    <section className="page-section reports-page ledger-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">OWNER BOOKKEEPING</div>
          <h1>Ledger</h1>
          <p>
            Review copied sales by month or year. Changes here are saved only to
            the ledger.
          </p>
        </div>
        <div className="ledger-period-actions">
          <label className="report-date-field">
            <span className="field-label">Period</span>
            <select
              className="text-input"
              aria-label="Ledger period"
              value={periodType}
              onChange={(event) => {
                setEditingId(null);
                setDraft(null);
                setPeriodType(event.target.value as "month" | "year");
              }}
            >
              <option value="month">Month</option>
              <option value="year">Year</option>
            </select>
          </label>
          <label className="report-date-field">
            <span className="field-label">
              {periodType === "month" ? "Month" : "Year"}
            </span>
            {periodType === "month" ? (
              <input
                className="text-input"
                aria-label="Ledger month"
                type="month"
                value={month}
                onChange={(event) => {
                  setEditingId(null);
                  setDraft(null);
                  setMonth(event.target.value);
                }}
              />
            ) : (
              <input
                className="text-input"
                aria-label="Ledger year"
                type="number"
                min="1"
                max="9998"
                step="1"
                value={year}
                onChange={(event) => {
                  setEditingId(null);
                  setDraft(null);
                  setYear(event.target.value);
                }}
              />
            )}
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
      {loading && <div className="table-loading">Loading ledger…</div>}

      {!loading && (
        <section className="settings-main-card report-low-stock ledger-card">
          <div className="card-heading">
            <div>
              <h2>
                {periodType === "month" ? monthName(month) : year || "Year"}
              </h2>
              <p>
                {entries.length} copied{" "}
                {entries.length === 1 ? "sale" : "sales"}. Unreviewed rows are
                red. Save a row after editing to mark it as reviewed.
              </p>
            </div>
            <span className="count-chip">{entries.length} entries</span>
          </div>
          {entries.length ? (
            <div className="inventory-table-wrap">
              <table className="inventory-table ledger-table">
                <thead>
                  <tr>
                    <th>MONTH</th>
                    <th>INVOICE NUMBER</th>
                    {moneyFields.map(({ key, label }) => (
                      <th key={key}>{label.toUpperCase()}</th>
                    ))}
                    <th>ACTION</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => {
                    const editing = isEditing(entry);
                    const values = draftValue(entry);
                    return (
                      <tr
                        className={entry.editedAt ? "" : "ledger-row-unedited"}
                        key={entry.sourceSaleId}
                      >
                        <td>
                          {editing ? (
                            <input
                              className="text-input ledger-cell-input"
                              aria-label={`Month for ${entry.invoiceNumber}`}
                              type="month"
                              value={values.month}
                              onChange={(event) =>
                                setDraft({
                                  ...values,
                                  month: event.target.value,
                                })
                              }
                            />
                          ) : (
                            monthName(entry.month)
                          )}
                        </td>
                        <td>
                          {editing ? (
                            <input
                              className="text-input ledger-cell-input"
                              aria-label={`Invoice number for ${entry.invoiceNumber}`}
                              type="text"
                              maxLength={80}
                              value={values.invoiceNumber}
                              onChange={(event) =>
                                setDraft({
                                  ...values,
                                  invoiceNumber: event.target.value,
                                })
                              }
                            />
                          ) : (
                            entry.invoiceNumber
                          )}
                        </td>
                        {moneyFields.map(({ key, label }) => (
                          <td key={key}>
                            {editing ? (
                              <input
                                className="text-input ledger-cell-input ledger-money-input"
                                aria-label={`${label} for ${entry.invoiceNumber}`}
                                type="number"
                                min="0"
                                step="0.01"
                                value={values[key]}
                                onChange={(event) =>
                                  setDraft({
                                    ...values,
                                    [key]: event.target.value,
                                  })
                                }
                              />
                            ) : (
                              `₱${entry[key]}`
                            )}
                          </td>
                        ))}
                        <td>
                          {editing ? (
                            <div className="ledger-row-actions">
                              <button
                                className="button button-primary ledger-action-button"
                                type="button"
                                onClick={() => void saveEdit(entry)}
                                disabled={savingId === entry.sourceSaleId}
                              >
                                <Check size={14} /> Save
                              </button>
                              <button
                                className="button button-secondary ledger-action-button"
                                type="button"
                                onClick={cancelEdit}
                                disabled={savingId === entry.sourceSaleId}
                              >
                                <X size={14} /> Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              className="button button-secondary ledger-action-button"
                              type="button"
                              onClick={() => beginEdit(entry)}
                            >
                              <Pencil size={14} /> Edit
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="report-empty">
              No sales were found for{" "}
              {periodType === "month" ? monthName(month) : year}.
            </p>
          )}
        </section>
      )}
    </section>
  );
}
