import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import {
  ArrowDownLeft,
  ArrowUpRight,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { api, ApiError } from "./api";

type SaleSummary = {
  id: string;
  transactionId: string;
  businessDate: string;
  cashierEmail: string;
  paymentMethod: "CASH" | "QR";
  amountDue: string;
  cashRoundingAdjustment: string;
  createdAt: string;
  status: "FINALIZED" | "REVERSED";
  reversal: {
    transactionId: string;
    createdAt: string;
    refundMethod: "CASH" | "QR";
    amount: string;
    cashRoundingAdjustment: string;
  } | null;
};

type SaleLine = {
  saleLineId: string;
  productId: string;
  productName: string;
  sku: string;
  unit: string;
  quantity: number;
  unitPrice: string;
  amountDue: string;
  cogs: string;
  lotAllocations: Array<{
    lotId: string;
    lotCode: string;
    expiryDate: string;
    quantity: number;
  }>;
};

type SaleDetails = {
  id: string;
  transactionId: string;
  cashierEmail: string;
  paymentMethod: "CASH" | "QR";
  amountDue: string;
  cashRoundingMode: "NONE" | "NEAREST_25_CENTAVOS";
  cashRoundingAdjustment: string;
  createdAt: string;
  label: string;
  lines: SaleLine[];
};

type OpenShift = {
  id: string;
  cashierEmail: string;
  openedAt: string;
  openingCash: string;
  expectedCash: string;
};

type CashMovement = {
  id: string;
  type: "CASH_IN" | "CASH_OUT" | "CASH_REFUND";
  amountDelta: string;
  reversalTransactionId: string | null;
  reason: string;
  actorEmail: string;
  createdAt: string;
};

type PendingVariance = {
  id: string;
  cashierEmail: string;
  closedAt: string;
  closedByEmail: string | null;
  openingCash: string;
  expectedCash: string;
  actualCashCount: string;
  variance: string;
  cashierReason: string | null;
};

function cents(value: string): bigint {
  const negative = value.startsWith("-");
  const normalized = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = normalized.split(".");
  const total = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -total : total;
}

function cashAdjustmentText(value: string): string {
  const total = cents(value);
  const absolute = total < 0n ? -total : total;
  return `${total < 0n ? "−" : ""}₱${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

function dateText(value: string): string {
  return new Date(value).toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function requestError(error: unknown): string {
  if (!(error instanceof ApiError))
    return "The request could not be completed.";
  const messages: Record<string, string> = {
    reauthentication_failed: "The owner password was not accepted.",
    sale_already_reversed: "This sale already has a saved full reversal.",
    lot_return_verification_required:
      "Confirm the returned items match their original lots before restocking.",
    returned_lot_not_saleable:
      "An original lot is expired or quarantined. Choose the write-off treatment.",
    reversal_lines_must_match_sale:
      "Review every sale line and choose whether returned items are sellable.",
    cash_refund_requires_open_shift:
      "Cash refunds must be assigned to an open cash drawer.",
    insufficient_shift_cash:
      "The selected drawer does not have enough expected cash for this refund.",
    insufficient_cash: "That drawer does not have enough expected cash.",
    open_shift_not_found:
      "That cash drawer is no longer open. Refresh and retry.",
    cash_amount_overflow:
      "The resulting drawer balance is outside the supported range.",
  };
  return (
    messages[error.code] ?? "The request was rejected. Refresh and try again."
  );
}

function Field({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <label className="inventory-field" htmlFor={id}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function SalesHistoryPage() {
  const [sales, setSales] = useState<SaleSummary[]>([]);
  const [openShifts, setOpenShifts] = useState<OpenShift[]>([]);
  const [pendingVariances, setPendingVariances] = useState<PendingVariance[]>(
    [],
  );
  const [variancePasswords, setVariancePasswords] = useState<
    Record<string, string>
  >({});
  const [varianceNotes, setVarianceNotes] = useState<Record<string, string>>(
    {},
  );
  const [selectedId, setSelectedId] = useState("");
  const [sale, setSale] = useState<SaleDetails | null>(null);
  const [restock, setRestock] = useState<Record<string, boolean>>({});
  const [lotVerified, setLotVerified] = useState<Record<string, boolean>>({});
  const [refundMethod, setRefundMethod] = useState<"CASH" | "QR">("CASH");
  const [refundShiftId, setRefundShiftId] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [reversalReason, setReversalReason] = useState("");
  const [movementShiftId, setMovementShiftId] = useState("");
  const [movementType, setMovementType] = useState<"CASH_IN" | "CASH_OUT">(
    "CASH_IN",
  );
  const [movementAmount, setMovementAmount] = useState("");
  const [movementReason, setMovementReason] = useState("");
  const [movements, setMovements] = useState<CashMovement[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refreshLists() {
    const [salesResult, shiftResult, varianceResult] = await Promise.all([
      api.get<{ sales: SaleSummary[] }>("/sales?limit=100"),
      api.get<{ shifts: OpenShift[] }>("/shifts/open"),
      api.get<{ shifts: PendingVariance[] }>("/shifts/variance-approvals"),
    ]);
    setSales(salesResult.sales);
    setOpenShifts(shiftResult.shifts);
    setPendingVariances(varianceResult.shifts);
    if (
      movementShiftId &&
      !shiftResult.shifts.some((shift) => shift.id === movementShiftId)
    ) {
      setMovementShiftId("");
      setMovements([]);
    }
    if (
      refundShiftId &&
      !shiftResult.shifts.some((shift) => shift.id === refundShiftId)
    ) {
      setRefundShiftId("");
    }
  }

  useEffect(() => {
    let active = true;
    void Promise.all([
      api.get<{ sales: SaleSummary[] }>("/sales?limit=100"),
      api.get<{ shifts: OpenShift[] }>("/shifts/open"),
      api.get<{ shifts: PendingVariance[] }>("/shifts/variance-approvals"),
    ])
      .then(([salesResult, shiftResult, varianceResult]) => {
        if (!active) return;
        setSales(salesResult.sales);
        setOpenShifts(shiftResult.shifts);
        setPendingVariances(varianceResult.shifts);
        const firstShift = shiftResult.shifts.at(0);
        if (firstShift) {
          setMovementShiftId(firstShift.id);
          setRefundShiftId(firstShift.id);
        }
      })
      .catch(() => {
        if (active) setError("Unable to load sales and open cash drawers.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    void api
      .get<{ sale: SaleDetails }>(`/sales/${selectedId}`)
      .then(({ sale: result }) => {
        if (active) {
          setSale(result);
          setRestock(
            Object.fromEntries(
              result.lines.map((line) => [line.saleLineId, false]),
            ),
          );
          setLotVerified({});
        }
      })
      .catch(() => {
        if (active) setError("Unable to load the saved sale snapshot.");
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedId]);

  useEffect(() => {
    if (!movementShiftId) return;
    let active = true;
    void api
      .get<{ movements: CashMovement[] }>(
        `/shifts/${movementShiftId}/cash-movements`,
      )
      .then(({ movements: result }) => {
        if (active) setMovements(result);
      })
      .catch(() => {
        if (active) setError("Unable to load drawer movement history.");
      });
    return () => {
      active = false;
    };
  }, [movementShiftId]);

  const selectedSummary =
    sales.find((item) => item.transactionId === selectedId) ?? null;
  const selectedRefundShift =
    openShifts.find((shift) => shift.id === refundShiftId) ?? null;
  const refundHasEnoughCash =
    selectedRefundShift && sale
      ? cents(selectedRefundShift.expectedCash) >= cents(sale.amountDue)
      : false;

  async function reverseSale(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sale) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await api.post<{
        reversal: { transactionId: string; amount: string };
      }>(`/sales/${sale.transactionId}/reversals`, {
        ownerPassword,
        reason: reversalReason,
        refundMethod,
        ...(refundMethod === "CASH" ? { refundShiftId } : {}),
        lines: sale.lines.map((line) => ({
          saleLineId: line.saleLineId,
          restock: restock[line.saleLineId] === true,
          lotPickVerified: lotVerified[line.saleLineId] === true,
        })),
      });
      setNotice(
        `Reversal ${result.reversal.transactionId} saved for ₱${result.reversal.amount}.`,
      );
      setOwnerPassword("");
      setReversalReason("");
      await refreshLists();
      const detail = await api.get<{ sale: SaleDetails }>(
        `/sales/${sale.transactionId}`,
      );
      setSale(detail.sale);
    } catch (caught) {
      setError(requestError(caught));
    } finally {
      setSaving(false);
    }
  }

  async function recordCashMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!movementShiftId) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await api.post<{ expectedCash: string }>(
        `/shifts/${movementShiftId}/cash-movements`,
        {
          movementType,
          amount: movementAmount,
          reason: movementReason,
        },
      );
      setNotice(
        `${movementType === "CASH_IN" ? "Cash-in" : "Cash-out"} recorded. Expected drawer cash: ₱${result.expectedCash}.`,
      );
      setMovementAmount("");
      setMovementReason("");
      await refreshLists();
      const updated = await api.get<{ movements: CashMovement[] }>(
        `/shifts/${movementShiftId}/cash-movements`,
      );
      setMovements(updated.movements);
    } catch (caught) {
      setError(requestError(caught));
    } finally {
      setSaving(false);
    }
  }

  async function reviewVariance(
    event: FormEvent<HTMLFormElement>,
    shiftId: string,
  ) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent)
      .submitter as HTMLButtonElement | null;
    const decision = submitter?.value;
    if (decision !== "APPROVE" && decision !== "REJECT") return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await api.post(`/shifts/${shiftId}/variance-approval`, {
        ownerPassword: variancePasswords[shiftId] ?? "",
        decision,
        note: varianceNotes[shiftId] ?? "",
      });
      setNotice(
        decision === "APPROVE"
          ? "Cash variance approved and recorded."
          : "Cash variance rejection recorded for follow-up.",
      );
      setVariancePasswords((current) => ({ ...current, [shiftId]: "" }));
      setVarianceNotes((current) => ({ ...current, [shiftId]: "" }));
      await refreshLists();
    } catch (caught) {
      setError(requestError(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="page-section sales-history-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">OWNER CONTROLS</div>
          <h1>Sales history</h1>
          <p>
            Review saved sale snapshots, approve a full reversal, and reconcile
            cash movements.
          </p>
        </div>
        <span className="secure-badge">
          <ShieldCheck size={15} /> OWNER ACCESS
        </span>
      </div>
      {(error || notice) && (
        <div
          className={`banner ${error ? "banner-error" : "banner-success"}`}
          role={error ? "alert" : "status"}
        >
          {error || notice}
        </div>
      )}

      <section className="settings-main-card variance-approval-card">
        <div className="card-heading inventory-card-heading">
          <div>
            <h2>Cash variance approvals</h2>
            <p>
              Every non-zero count stays pending until an owner records a
              decision.
            </p>
          </div>
          <span className="count-chip">{pendingVariances.length} pending</span>
        </div>
        {pendingVariances.length ? (
          <div className="variance-approval-list">
            {pendingVariances.map((shift) => (
              <form
                className="variance-approval-row"
                key={shift.id}
                onSubmit={(event) => void reviewVariance(event, shift.id)}
              >
                <div className="variance-approval-summary">
                  <strong>{shift.cashierEmail}</strong>
                  <small>
                    Closed {dateText(shift.closedAt)} · by{" "}
                    {shift.closedByEmail ?? "staff"}
                  </small>
                  <span>
                    Expected ₱{shift.expectedCash} · Counted ₱
                    {shift.actualCashCount} · Variance ₱{shift.variance}
                  </span>
                  <small>Cashier reason: {shift.cashierReason}</small>
                </div>
                <div className="variance-approval-controls">
                  <Field
                    id={`variance-password-${shift.id}`}
                    label="Owner password"
                  >
                    <input
                      id={`variance-password-${shift.id}`}
                      className="text-input"
                      type="password"
                      autoComplete="current-password"
                      value={variancePasswords[shift.id] ?? ""}
                      onChange={(event) =>
                        setVariancePasswords((current) => ({
                          ...current,
                          [shift.id]: event.target.value,
                        }))
                      }
                      required
                    />
                  </Field>
                  <Field
                    id={`variance-note-${shift.id}`}
                    label="Owner decision note"
                  >
                    <input
                      id={`variance-note-${shift.id}`}
                      className="text-input"
                      value={varianceNotes[shift.id] ?? ""}
                      onChange={(event) =>
                        setVarianceNotes((current) => ({
                          ...current,
                          [shift.id]: event.target.value,
                        }))
                      }
                      required
                      minLength={3}
                      maxLength={500}
                    />
                  </Field>
                  <div className="variance-decision-actions">
                    <button
                      className="button button-secondary"
                      type="submit"
                      name="decision"
                      value="REJECT"
                      disabled={saving}
                    >
                      Reject
                    </button>
                    <button
                      className="button button-primary"
                      type="submit"
                      name="decision"
                      value="APPROVE"
                      disabled={saving}
                    >
                      Approve variance
                    </button>
                  </div>
                </div>
              </form>
            ))}
          </div>
        ) : (
          <div className="table-loading">
            No non-zero variances need review.
          </div>
        )}
      </section>

      <div className="history-layout">
        <section className="settings-main-card history-list-card">
          <div className="card-heading inventory-card-heading">
            <div>
              <h2>Recent internal sales</h2>
              <p>Latest 100 records. A reversal leaves the original intact.</p>
            </div>
            <span className="count-chip">{sales.length} records</span>
          </div>
          <div className="inventory-table-wrap">
            <table className="inventory-table">
              <thead>
                <tr>
                  <th>TRANSACTION</th>
                  <th>DATE / CASHIER</th>
                  <th>SETTLEMENT</th>
                  <th>AMOUNT</th>
                  <th>STATUS</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={6} className="table-loading">
                      Loading sales…
                    </td>
                  </tr>
                ) : sales.length ? (
                  sales.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <strong>{item.transactionId}</strong>
                        {item.reversal && (
                          <small>{item.reversal.transactionId}</small>
                        )}
                      </td>
                      <td>
                        {dateText(item.createdAt)}
                        <small>{item.cashierEmail}</small>
                      </td>
                      <td>{item.paymentMethod} declared</td>
                      <td>₱{item.amountDue}</td>
                      <td>
                        <span
                          className={`sale-status ${item.status === "REVERSED" ? "sale-status-reversed" : ""}`}
                        >
                          {item.status === "REVERSED"
                            ? "Reversed"
                            : "Finalized"}
                        </span>
                      </td>
                      <td>
                        <button
                          className="text-action"
                          onClick={() => {
                            setError("");
                            if (selectedId !== item.transactionId)
                              setDetailLoading(true);
                            setSelectedId(item.transactionId);
                          }}
                        >
                          Review
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="table-loading">
                      No sales have been finalized yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="create-card sale-review-card">
          {!selectedId ? (
            <div className="sale-empty-state">
              <span className="create-card-icon">
                <RotateCcw size={18} />
              </span>
              <h2>Review a sale</h2>
              <p>
                Select a transaction to view its immutable line and cost
                snapshots.
              </p>
            </div>
          ) : detailLoading || !sale ? (
            <div className="table-loading">Loading saved sale…</div>
          ) : (
            <>
              <span className="create-card-icon">
                <RotateCcw size={18} />
              </span>
              <h2>{sale.transactionId}</h2>
              <p>
                {dateText(sale.createdAt)} · {sale.cashierEmail}
              </p>
              <strong className="sale-record-label">{sale.label}</strong>
              <div className="sale-detail-lines">
                {sale.lines.map((line) => (
                  <div className="sale-detail-line" key={line.saleLineId}>
                    <strong>{line.productName}</strong>
                    <small>
                      {line.sku} · {line.quantity} {line.unit} × ₱
                      {line.unitPrice}
                    </small>
                    <span>
                      Due ₱{line.amountDue} · Saved COGS ₱{line.cogs}
                    </span>
                    {line.lotAllocations.length > 0 && (
                      <small>
                        Original lot(s):{" "}
                        {line.lotAllocations
                          .map(
                            (lot) =>
                              `${lot.lotCode} · exp ${lot.expiryDate} · ${lot.quantity}`,
                          )
                          .join("; ")}
                      </small>
                    )}
                    {selectedSummary?.status === "FINALIZED" && (
                      <>
                        <label className="inventory-checkbox reversal-restock-choice">
                          <input
                            type="checkbox"
                            checked={restock[line.saleLineId] === true}
                            onChange={(event) =>
                              setRestock((current) => ({
                                ...current,
                                [line.saleLineId]: event.target.checked,
                              }))
                            }
                          />
                          <span>
                            Returned item is sellable; restore to stock
                          </span>
                        </label>
                        {restock[line.saleLineId] &&
                          line.lotAllocations.length > 0 && (
                            <label className="inventory-checkbox reversal-restock-choice">
                              <input
                                type="checkbox"
                                checked={lotVerified[line.saleLineId] === true}
                                onChange={(event) =>
                                  setLotVerified((current) => ({
                                    ...current,
                                    [line.saleLineId]: event.target.checked,
                                  }))
                                }
                                required
                              />
                              <span>
                                I physically verified the returned goods match
                                their original lot(s)
                              </span>
                            </label>
                          )}
                      </>
                    )}
                  </div>
                ))}
              </div>
              {sale.cashRoundingMode === "NEAREST_25_CENTAVOS" &&
                sale.paymentMethod === "CASH" && (
                  <small className="field-hint">
                    Cash rounding adjustment:{" "}
                    {cashAdjustmentText(sale.cashRoundingAdjustment)}
                  </small>
                )}
              <div className="sale-detail-total">
                <span>Full refund amount</span>
                <strong>₱{sale.amountDue}</strong>
              </div>

              {selectedSummary?.reversal ? (
                <div className="reversal-saved-note" role="status">
                  Reversal {selectedSummary.reversal.transactionId} saved on{" "}
                  {dateText(selectedSummary.reversal.createdAt)} for ₱
                  {selectedSummary.reversal.amount} by{" "}
                  {selectedSummary.reversal.refundMethod}.
                  {selectedSummary.reversal.cashRoundingAdjustment !==
                    "0.00" && (
                    <>
                      Cash rounding adjustment:{" "}
                      {cashAdjustmentText(
                        selectedSummary.reversal.cashRoundingAdjustment,
                      )}
                      .
                    </>
                  )}
                </div>
              ) : (
                <form
                  className="form-stack reversal-form"
                  onSubmit={(event) => void reverseSale(event)}
                >
                  <h3>Approve full reversal</h3>
                  <p>
                    This creates a linked internal reversal. The original sale
                    cannot be edited or deleted.
                  </p>
                  <Field id="refund-method" label="Actual refund method">
                    <select
                      id="refund-method"
                      className="text-input select-input"
                      value={refundMethod}
                      onChange={(event) =>
                        setRefundMethod(event.target.value as "CASH" | "QR")
                      }
                    >
                      <option value="CASH">Cash returned</option>
                      <option value="QR">
                        QR returned (staff declaration)
                      </option>
                    </select>
                  </Field>
                  {refundMethod === "CASH" && (
                    <Field
                      id="refund-shift"
                      label="Cash refund from open drawer"
                    >
                      <select
                        id="refund-shift"
                        className="text-input select-input"
                        value={refundShiftId}
                        onChange={(event) =>
                          setRefundShiftId(event.target.value)
                        }
                        required
                      >
                        <option value="">Select a drawer</option>
                        {openShifts.map((shift) => (
                          <option key={shift.id} value={shift.id}>
                            {shift.cashierEmail} · expected ₱
                            {shift.expectedCash}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                  {refundMethod === "CASH" && openShifts.length === 0 && (
                    <small className="field-hint">
                      No drawer is open. Open a shift from{" "}
                      <Link to="/checkout">Checkout</Link> before recording a
                      cash refund.
                    </small>
                  )}
                  {refundMethod === "CASH" &&
                    selectedRefundShift &&
                    !refundHasEnoughCash && (
                      <small className="field-hint field-hint-error">
                        This drawer's expected cash is below the full refund.
                      </small>
                    )}
                  <Field id="reversal-reason" label="Reason for reversal">
                    <textarea
                      id="reversal-reason"
                      className="text-input reversal-reason-input"
                      value={reversalReason}
                      onChange={(event) =>
                        setReversalReason(event.target.value)
                      }
                      required
                      minLength={3}
                      maxLength={500}
                    />
                  </Field>
                  <Field id="owner-reauth-password" label="Owner password">
                    <input
                      id="owner-reauth-password"
                      className="text-input"
                      type="password"
                      autoComplete="current-password"
                      value={ownerPassword}
                      onChange={(event) => setOwnerPassword(event.target.value)}
                      required
                    />
                  </Field>
                  <small className="field-hint">
                    Choose sellable stock per line. Items left out of stock are
                    recorded as a cost write-off. Cash refunds reduce the
                    selected drawer; QR refunds do not change physical cash.
                  </small>
                  <button
                    className="button button-primary"
                    type="submit"
                    disabled={
                      saving ||
                      selectedSummary?.status !== "FINALIZED" ||
                      !sale.lines.length ||
                      (refundMethod === "CASH" &&
                        (!refundShiftId || !refundHasEnoughCash))
                    }
                  >
                    {saving ? "Saving reversal…" : "Approve full reversal"}
                  </button>
                </form>
              )}
            </>
          )}
        </aside>
      </div>

      <section className="settings-main-card cash-drawer-card">
        <div className="card-heading inventory-card-heading">
          <div>
            <h2>Open cash drawers</h2>
            <p>
              Cash-in and cash-out entries change expected cash and require an
              owner reason.
            </p>
          </div>
          <span className="count-chip">{openShifts.length} open</span>
        </div>
        {!openShifts.length ? (
          <div className="table-loading">
            No open shifts. Cashiers open and close their own shifts from
            Checkout.
          </div>
        ) : (
          <div className="cash-drawer-grid">
            <div className="cash-drawer-list">
              {openShifts.map((shift) => (
                <button
                  key={shift.id}
                  className={`cash-drawer-row ${movementShiftId === shift.id ? "cash-drawer-row-selected" : ""}`}
                  onClick={() => setMovementShiftId(shift.id)}
                >
                  <span className="activity-icon">
                    <ShieldCheck size={16} />
                  </span>
                  <span>
                    <strong>{shift.cashierEmail}</strong>
                    <small>Opened {dateText(shift.openedAt)}</small>
                  </span>
                  <strong>₱{shift.expectedCash}</strong>
                </button>
              ))}
            </div>
            <div className="cash-movement-panel">
              <form
                className="cash-movement-form"
                onSubmit={(event) => void recordCashMovement(event)}
              >
                <Field id="cash-movement-type" label="Movement type">
                  <select
                    id="cash-movement-type"
                    className="text-input select-input"
                    value={movementType}
                    onChange={(event) =>
                      setMovementType(
                        event.target.value as "CASH_IN" | "CASH_OUT",
                      )
                    }
                  >
                    <option value="CASH_IN">Cash-in</option>
                    <option value="CASH_OUT">Cash-out</option>
                  </select>
                </Field>
                <Field id="cash-movement-amount" label="Amount (₱)">
                  <input
                    id="cash-movement-amount"
                    className="text-input"
                    inputMode="decimal"
                    value={movementAmount}
                    onChange={(event) => setMovementAmount(event.target.value)}
                    required
                    pattern="[0-9]+(\.[0-9]{1,2})?"
                  />
                </Field>
                <Field id="cash-movement-reason" label="Reason">
                  <input
                    id="cash-movement-reason"
                    className="text-input"
                    value={movementReason}
                    onChange={(event) => setMovementReason(event.target.value)}
                    required
                    minLength={3}
                    maxLength={500}
                  />
                </Field>
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={saving || !movementShiftId}
                >
                  {saving ? "Saving…" : "Record cash movement"}
                </button>
              </form>
              <div className="cash-movement-history">
                <strong>Recent movements</strong>
                {movements.length ? (
                  movements.map((movement) => (
                    <div className="cash-movement-row" key={movement.id}>
                      <span className="cash-movement-icon">
                        {movement.amountDelta.startsWith("-") ? (
                          <ArrowUpRight size={14} />
                        ) : (
                          <ArrowDownLeft size={14} />
                        )}
                      </span>
                      <span>
                        <strong>{movement.type.replaceAll("_", " ")}</strong>
                        <small>
                          {movement.reason} · {movement.actorEmail}
                        </small>
                      </span>
                      <b>₱{movement.amountDelta}</b>
                    </div>
                  ))
                ) : (
                  <small>No cash movements recorded for this shift.</small>
                )}
              </div>
            </div>
          </div>
        )}
      </section>
    </section>
  );
}
