import { useEffect, useState } from "react";
import { Check, Pencil, RefreshCw, X } from "lucide-react";
import { api } from "./api";

type JournalEntry = {
  sourceBusinessDate: string;
  month: string;
  date: string;
  invoiceNumberRange: string;
  seniorDiscount: string;
  nonVat: string;
  vatableSales: string;
  totalVat: string;
  grossSales: string;
  netSales: string;
  editedAt: string | null;
};

type JournalDraft = Omit<JournalEntry, "sourceBusinessDate" | "editedAt">;
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

function manilaBusinessDate(): string {
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

function draftFor(entry: JournalEntry): JournalDraft {
  return {
    month: entry.month,
    date: entry.date,
    invoiceNumberRange: entry.invoiceNumberRange,
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

export function JournalPage() {
  const [periodType, setPeriodType] = useState<"month" | "year">("month");
  const [month, setMonth] = useState(currentMonth);
  const [year, setYear] = useState(currentMonth().slice(0, 4));
  const [todayBusinessDate, setTodayBusinessDate] =
    useState(manilaBusinessDate);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<JournalDraft | null>(null);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const startMonth = periodType === "month" ? month : `${year}-01`;
  const endMonth = periodType === "month" ? month : `${year}-12`;
  const requestKey = `${startMonth}:${endMonth}:${refreshKey}`;
  const loading = loadedKey !== requestKey;

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTodayBusinessDate(manilaBusinessDate());
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ startMonth, endMonth });
    void api
      .get<{ entries: JournalEntry[] }>(`/journal/range?${query}`)
      .then(({ entries: nextEntries }) => {
        if (!active) return;
        setEntries(nextEntries);
        setError("");
      })
      .catch(() => {
        if (!active) return;
        setEntries([]);
        setError("Unable to load the journal for this period. Try refreshing.");
      })
      .finally(() => {
        if (active) setLoadedKey(requestKey);
      });
    return () => {
      active = false;
    };
  }, [startMonth, endMonth, refreshKey, requestKey]);

  function beginEdit(entry: JournalEntry) {
    setEditingId(entry.sourceBusinessDate);
    setDraft(draftFor(entry));
    setError("");
  }

  async function saveEdit(entry: JournalEntry) {
    if (!draft) return;
    setSavingId(entry.sourceBusinessDate);
    setError("");
    try {
      const result = await api.patch<{ entry: JournalEntry }>(
        `/journal/${encodeURIComponent(entry.sourceBusinessDate)}`,
        draft,
      );
      setEntries((current) =>
        current.map((item) =>
          item.sourceBusinessDate === entry.sourceBusinessDate
            ? result.entry
            : item,
        ),
      );
      setEditingId(null);
      setDraft(null);
    } catch {
      setError("Unable to save this journal row. Check its values and retry.");
    } finally {
      setSavingId(null);
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
    setError("");
  }

  const isEditing = (entry: JournalEntry) =>
    editingId === entry.sourceBusinessDate && draft !== null;
  const draftValue = (entry: JournalEntry) =>
    isEditing(entry) ? draft! : draftFor(entry);

  return (
    <section className="page-section reports-page journal-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">OWNER BOOKKEEPING</div>
          <h1>Journal</h1>
          <p>
            Review copied sales by month or year. A day becomes editable after
            it ends in Philippines time. Changes here are saved only to the
            journal.
          </p>
        </div>
        <div className="journal-period-actions">
          <label className="report-date-field">
            <span className="field-label">Period</span>
            <select
              className="text-input"
              aria-label="Journal period"
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
                aria-label="Journal month"
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
                aria-label="Journal year"
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
      {loading && <div className="table-loading">Loading journal…</div>}

      {!loading && (
        <section className="settings-main-card report-low-stock journal-card">
          <div className="card-heading">
            <div>
              <h2>
                {periodType === "month" ? monthName(month) : year || "Year"}
              </h2>
              <p>
                {entries.length} daily{" "}
                {entries.length === 1 ? "summary" : "summaries"}. Each row
                copies one day of sales. Unedited rows are red; save an edit to
                mark it as reviewed.
              </p>
            </div>
            <span className="count-chip">{entries.length} days</span>
          </div>
          {entries.length ? (
            <div className="inventory-table-wrap">
              <table className="inventory-table journal-table">
                <thead>
                  <tr>
                    <th>MONTH</th>
                    <th>DATE</th>
                    <th>INVOICE NUMBER RANGE</th>
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
                    const canEdit =
                      entry.sourceBusinessDate < todayBusinessDate;
                    return (
                      <tr
                        className={entry.editedAt ? "" : "journal-row-unedited"}
                        key={entry.sourceBusinessDate}
                      >
                        <td>
                          {editing ? (
                            <input
                              className="text-input journal-cell-input"
                              aria-label={`Month for ${entry.invoiceNumberRange}`}
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
                              className="text-input journal-cell-input"
                              aria-label={`Date for ${entry.invoiceNumberRange}`}
                              type="date"
                              value={values.date}
                              onChange={(event) =>
                                setDraft({
                                  ...values,
                                  date: event.target.value,
                                })
                              }
                            />
                          ) : (
                            entry.date
                          )}
                        </td>
                        <td>
                          {editing ? (
                            <input
                              className="text-input journal-cell-input"
                              aria-label={`Invoice number range for ${entry.invoiceNumberRange}`}
                              type="text"
                              maxLength={200}
                              value={values.invoiceNumberRange}
                              onChange={(event) =>
                                setDraft({
                                  ...values,
                                  invoiceNumberRange: event.target.value,
                                })
                              }
                            />
                          ) : (
                            entry.invoiceNumberRange
                          )}
                        </td>
                        {moneyFields.map(({ key, label }) => (
                          <td key={key}>
                            {editing ? (
                              <input
                                className="text-input journal-cell-input journal-money-input"
                                aria-label={`${label} for ${entry.invoiceNumberRange}`}
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
                            <div className="journal-row-actions">
                              <button
                                className="button button-primary journal-action-button"
                                type="button"
                                onClick={() => void saveEdit(entry)}
                                disabled={savingId === entry.sourceBusinessDate}
                              >
                                <Check size={14} /> Save
                              </button>
                              <button
                                className="button button-secondary journal-action-button"
                                type="button"
                                onClick={cancelEdit}
                                disabled={savingId === entry.sourceBusinessDate}
                              >
                                <X size={14} /> Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              className="button button-secondary journal-action-button"
                              type="button"
                              onClick={() => beginEdit(entry)}
                              disabled={!canEdit}
                              title={
                                canEdit
                                  ? undefined
                                  : "Available after this business day ends in Philippines time."
                              }
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
