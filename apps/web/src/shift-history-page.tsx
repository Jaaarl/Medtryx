import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "./api";

type ShiftHistoryRow = {
  id: string;
  status: "OPEN" | "CLOSED";
  openedAt: string;
  closedAt: string | null;
  openedByEmail: string;
  closedByEmail: string | null;
  openingCash: string;
  cashSales: string;
  qrSales: string;
  cashRefunds: string;
  cashIn: string;
  cashOut: string;
  expectedCash: string;
  actualCashCount: string | null;
  variance: string | null;
};

async function fetchShiftHistory(before?: ShiftHistoryRow): Promise<{
  shifts: ShiftHistoryRow[];
  hasMore: boolean;
}> {
  const query = new URLSearchParams({ limit: "200" });
  if (before) {
    query.set("beforeOpenedAt", before.openedAt);
    query.set("beforeId", before.id);
  }
  return api.get<{ shifts: ShiftHistoryRow[]; hasMore: boolean }>(
    `/shifts/history?${query}`,
  );
}

function localTime(value: string | null): string {
  return value
    ? new Date(value).toLocaleString("en-PH", { timeZone: "Asia/Manila" })
    : "Open";
}

export function ShiftHistoryPage() {
  const [shifts, setShifts] = useState<ShiftHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchShiftHistory();
      setShifts(result.shifts);
      setHasMore(result.hasMore);
      setError("");
    } catch {
      setShifts([]);
      setHasMore(false);
      setError("Unable to load shift history. Refresh and try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  const oldestShift = shifts.at(-1);
  const loadOlderShifts = useCallback(async () => {
    setLoadingMore(true);
    try {
      if (!oldestShift) return;
      const result = await fetchShiftHistory(oldestShift);
      setShifts((current) => [...current, ...result.shifts]);
      setHasMore(result.hasMore);
      setError("");
    } catch {
      setError("Unable to load older shifts. Try again.");
    } finally {
      setLoadingMore(false);
    }
  }, [oldestShift]);

  useEffect(() => {
    let active = true;
    void fetchShiftHistory()
      .then((result) => {
        if (active) {
          setShifts(result.shifts);
          setHasMore(result.hasMore);
          setError("");
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) {
          setShifts([]);
          setError("Unable to load shift history. Refresh and try again.");
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section className="page-section reports-page shift-history-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">OWNER REGISTER REVIEW</div>
          <h1>Shift history</h1>
          <p>
            Opening and closing accounts, declared sales, and physical drawer
            reconciliation for each register shift.
          </p>
        </div>
        <button
          className="button button-secondary"
          type="button"
          onClick={() => void loadHistory()}
          disabled={loading}
        >
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      <section className="settings-main-card shift-history-card">
        <div className="card-heading">
          <div>
            <h2>Register shifts</h2>
            <p>
              Most recent shifts appear first. Amounts are in Philippine pesos.
            </p>
          </div>
          <span className="count-chip">{shifts.length} shifts</span>
        </div>
        {loading ? (
          <div className="table-loading">Loading shift history…</div>
        ) : shifts.length ? (
          <div className="inventory-table-wrap">
            <table className="inventory-table shift-history-table">
              <thead>
                <tr>
                  <th>STATUS</th>
                  <th>OPENED BY / TIME</th>
                  <th>CLOSED BY / TIME</th>
                  <th>OPENING CASH</th>
                  <th>CASH SALES</th>
                  <th>QR SALES</th>
                  <th>CASH REFUNDS</th>
                  <th>CASH-IN</th>
                  <th>CASH-OUT</th>
                  <th>EXPECTED CASH</th>
                  <th>ACTUAL COUNT</th>
                  <th>VARIANCE</th>
                </tr>
              </thead>
              <tbody>
                {shifts.map((shift) => (
                  <tr key={shift.id}>
                    <td>
                      <span
                        className={`product-state ${shift.status === "OPEN" ? "product-state-active" : ""}`}
                      >
                        {shift.status}
                      </span>
                    </td>
                    <td>
                      <strong>{shift.openedByEmail}</strong>
                      <small>{localTime(shift.openedAt)}</small>
                    </td>
                    <td>
                      <strong>{shift.closedByEmail ?? "—"}</strong>
                      <small>{localTime(shift.closedAt)}</small>
                    </td>
                    <td>₱{shift.openingCash}</td>
                    <td>₱{shift.cashSales}</td>
                    <td>₱{shift.qrSales}</td>
                    <td>₱{shift.cashRefunds}</td>
                    <td>₱{shift.cashIn}</td>
                    <td>₱{shift.cashOut}</td>
                    <td>₱{shift.expectedCash}</td>
                    <td>
                      {shift.actualCashCount === null
                        ? "—"
                        : `₱${shift.actualCashCount}`}
                    </td>
                    <td>
                      {shift.variance === null ? "—" : `₱${shift.variance}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="report-empty">No register shifts have been recorded.</p>
        )}
      </section>
      {hasMore && (
        <button
          className="button button-secondary shift-history-more"
          type="button"
          onClick={() => void loadOlderShifts()}
          disabled={loadingMore}
        >
          {loadingMore ? "Loading older shifts…" : "Load older shifts"}
        </button>
      )}
      <div className="report-notes">
        <p>
          QR-declared sales are displayed separately and do not enter expected
          physical cash. Expected cash includes the opening float, cash sales,
          cash refunds, and recorded cash-in/out movements.
        </p>
      </div>
    </section>
  );
}
