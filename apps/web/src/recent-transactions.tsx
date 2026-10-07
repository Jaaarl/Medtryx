import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api, ApiError } from "./api";

type RecentTransaction = {
  transactionId: string;
  paymentMethod: "CASH" | "QR";
  amountDue: string;
  qrAmountIfSwitched: string;
  cashAmountIfSwitched: string;
  paymentSwitchRecorded: boolean;
  createdAt: string;
  status: "FINALIZED" | "REVERSED";
  reversalTransactionId: string | null;
  lines: Array<{
    saleLineId: string;
    productName: string;
    sku: string;
    quantity: number;
    lotAllocations: Array<{
      lotId: string;
      lotCode: string;
      expiryDate: string;
      quantity: number;
    }>;
  }>;
};

type RefundShift = { id: string; expectedCash: string };
type TransactionAction = "payment" | "cancel";

const ACTION_WINDOW_MS = 10 * 60 * 1000;
type ReasonChoice = "" | "Cashier Fault" | "Customer Fault" | "Custom";

function recordedReason(choice: ReasonChoice, customReason: string): string {
  if (choice !== "Custom") return choice;
  return customReason.trim() || "Custom";
}

function transactionError(error: unknown): string {
  if (!(error instanceof ApiError))
    return "The cancellation could not be completed.";
  const messages: Record<string, string> = {
    quick_action_window_expired:
      "The 10-minute cancellation window has passed.",
    quick_cancel_refund_method_must_match:
      "The refund method must match the original payment.",
    qr_refund_confirmation_required:
      "Confirm that the QR refund was sent before recording the cancellation.",
    sale_already_reversed: "This sale has already been cancelled or reversed.",
    payment_switch_already_saved:
      "This transaction has already had a payment correction.",
    cash_shift_unavailable:
      "The original cash drawer could not be updated. Ask an owner to review it.",
    lot_return_verification_required:
      "Confirm the returned products match their original lots before restocking.",
    returned_lot_not_saleable:
      "An original lot is expired or quarantined. Select write-off for that item.",
    cash_refund_requires_open_shift:
      "Open a cash drawer before recording a cash refund.",
    insufficient_shift_cash:
      "The selected drawer does not have enough expected cash for this refund.",
    sale_totals_do_not_reconcile:
      "The saved sale total could not be reconciled. Ask an owner to review it.",
  };
  return (
    messages[error.code] ?? "The cancellation was rejected. Refresh and retry."
  );
}

function transactionDate(value: string): string {
  return new Date(value).toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function RecentTransactions({
  refundShift,
  refreshKey,
  onUpdated,
}: {
  refundShift: RefundShift | null;
  refreshKey: number;
  onUpdated: () => Promise<void>;
}) {
  const [transactions, setTransactions] = useState<RecentTransaction[]>([]);
  const [restockChoices, setRestockChoices] = useState<Record<string, boolean>>(
    {},
  );
  const [lotVerified, setLotVerified] = useState<Record<string, boolean>>({});
  const [reasons, setReasons] = useState<Record<string, ReasonChoice>>({});
  const [customReasons, setCustomReasons] = useState<Record<string, string>>(
    {},
  );
  const [switchReasons, setSwitchReasons] = useState<
    Record<string, ReasonChoice>
  >({});
  const [customSwitchReasons, setCustomSwitchReasons] = useState<
    Record<string, string>
  >({});
  const [qrRefundConfirmed, setQrRefundConfirmed] = useState<
    Record<string, boolean>
  >({});
  const [openActions, setOpenActions] = useState<
    Record<string, TransactionAction | null>
  >({});
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now());
  const [localRefresh, setLocalRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void api
        .get<{ sales: RecentTransaction[] }>("/sales/recent")
        .then((result) => {
          if (active) setTransactions(result.sales);
        })
        .catch(() => {
          if (active) setError("Unable to load recent transactions.");
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    };
    refresh();
    const refreshTimer = window.setInterval(refresh, 30_000);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      active = false;
      window.clearInterval(refreshTimer);
      window.clearInterval(clockTimer);
    };
  }, [refreshKey, localRefresh]);

  async function cancelTransaction(
    event: FormEvent<HTMLFormElement>,
    transaction: RecentTransaction,
  ) {
    event.preventDefault();
    setError("");
    setNotice("");
    const lines = transaction.lines.map((line) => {
      const restock = restockChoices[line.saleLineId];
      if (restock === undefined) return null;
      if (
        restock &&
        line.lotAllocations.length > 0 &&
        lotVerified[line.saleLineId] !== true
      ) {
        return null;
      }
      return {
        saleLineId: line.saleLineId,
        restock,
        ...(restock && line.lotAllocations.length > 0
          ? { lotPickVerified: true }
          : {}),
      };
    });
    if (lines.some((line) => line === null)) {
      setError(
        "Choose a stock outcome for every product and verify returned lots.",
      );
      return;
    }
    if (
      transaction.paymentMethod === "QR" &&
      !qrRefundConfirmed[transaction.transactionId]
    ) {
      setError(
        "Send the QR refund, then confirm it here to record the cancellation.",
      );
      return;
    }
    if (transaction.paymentMethod === "CASH" && !refundShift) {
      setError("Open a cash drawer before recording a cash refund.");
      return;
    }

    setSavingId(transaction.transactionId);
    try {
      const result = await api.post<{
        reversal: { transactionId: string; amount: string };
      }>(`/sales/${transaction.transactionId}/reversals`, {
        reason: recordedReason(
          reasons[transaction.transactionId] ?? "",
          customReasons[transaction.transactionId] ?? "",
        ),
        refundMethod: transaction.paymentMethod,
        ...(transaction.paymentMethod === "CASH"
          ? { refundShiftId: refundShift!.id }
          : { qrRefundConfirmed: true }),
        lines,
      });
      setNotice(
        `Cancellation ${result.reversal.transactionId} recorded for ₱${result.reversal.amount}.`,
      );
      setLocalRefresh((value) => value + 1);
      await onUpdated();
    } catch (caught) {
      setError(transactionError(caught));
    } finally {
      setSavingId("");
    }
  }

  async function switchPayment(
    event: FormEvent<HTMLFormElement>,
    transaction: RecentTransaction,
  ) {
    event.preventDefault();
    setError("");
    setNotice("");
    setSavingId(transaction.transactionId);
    try {
      const result = await api.post<{
        paymentSwitch: { cashAmount: string; qrAmount: string };
      }>(`/sales/${transaction.transactionId}/payment-switches`, {
        reason: recordedReason(
          switchReasons[transaction.transactionId] ?? "",
          customSwitchReasons[transaction.transactionId] ?? "",
        ),
      });
      setNotice(
        transaction.paymentMethod === "CASH"
          ? `Payment switched: cash reduced by ₱${result.paymentSwitch.cashAmount}; QR now shows ₱${result.paymentSwitch.qrAmount}.`
          : `Payment switched: QR reduced by ₱${result.paymentSwitch.qrAmount}; cash now shows ₱${result.paymentSwitch.cashAmount}.`,
      );
      setLocalRefresh((value) => value + 1);
      await onUpdated();
    } catch (caught) {
      setError(transactionError(caught));
    } finally {
      setSavingId("");
    }
  }

  function toggleAction(transactionId: string, action: TransactionAction) {
    setOpenActions((current) => ({
      ...current,
      [transactionId]: current[transactionId] === action ? null : action,
    }));
  }

  return (
    <section className="settings-main-card recent-transactions-card">
      <div className="card-heading">
        <div>
          <h2>Recent transactions</h2>
          <p>
            Correct a payment or cancel a sale within 10 minutes. These are
            separate actions.
          </p>
        </div>
        <span className="count-chip">{transactions.length} in window</span>
      </div>
      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="banner banner-success" role="status">
          {notice}
        </div>
      )}
      {loading ? (
        <div className="table-loading">Loading recent transactions…</div>
      ) : transactions.length ? (
        <div className="recent-transactions-list">
          {transactions.map((transaction) => {
            const remainingMs =
              Date.parse(transaction.createdAt) + ACTION_WINDOW_MS - now;
            const canCancel =
              transaction.status === "FINALIZED" && remainingMs > 0;
            const openAction = openActions[transaction.transactionId] ?? null;
            const secondsRemaining = Math.max(
              0,
              Math.ceil(remainingMs / 1_000),
            );
            return (
              <article
                className="recent-transaction"
                key={transaction.transactionId}
              >
                <div className="recent-transaction-heading">
                  <div>
                    <strong>{transaction.transactionId}</strong>
                    <small>{transactionDate(transaction.createdAt)}</small>
                  </div>
                  <div>
                    <strong>₱{transaction.amountDue}</strong>
                    <small>{transaction.paymentMethod} declared</small>
                  </div>
                </div>
                <ul className="recent-transaction-products">
                  {transaction.lines.map((line) => (
                    <li key={line.saleLineId}>
                      <strong>{line.productName}</strong>
                      <small>
                        {line.sku} · quantity {line.quantity}
                      </small>
                      {line.lotAllocations.length > 0 && (
                        <small>
                          Original lots:{" "}
                          {line.lotAllocations
                            .map(
                              (lot) =>
                                `${lot.lotCode} · ${lot.quantity} · exp ${lot.expiryDate}`,
                            )
                            .join("; ")}
                        </small>
                      )}
                    </li>
                  ))}
                </ul>
                {transaction.status === "REVERSED" ? (
                  <small className="reversal-saved-note">
                    Cancelled as {transaction.reversalTransactionId}.
                  </small>
                ) : canCancel ? (
                  <>
                    <div
                      className={`recent-action-picker ${transaction.paymentSwitchRecorded ? "recent-action-picker-single" : ""}`}
                      role="group"
                      aria-label={`Actions for ${transaction.transactionId}`}
                    >
                      {!transaction.paymentSwitchRecorded && (
                        <button
                          className={`recent-action-button ${openAction === "payment" ? "recent-action-button-active" : ""}`}
                          type="button"
                          aria-expanded={openAction === "payment"}
                          onClick={() =>
                            toggleAction(transaction.transactionId, "payment")
                          }
                        >
                          Switch payment
                        </button>
                      )}
                      <button
                        className={`recent-action-button recent-action-button-cancel ${openAction === "cancel" ? "recent-action-button-active" : ""}`}
                        type="button"
                        aria-expanded={openAction === "cancel"}
                        onClick={() =>
                          toggleAction(transaction.transactionId, "cancel")
                        }
                      >
                        Cancel sale
                      </button>
                    </div>
                    {!transaction.paymentSwitchRecorded &&
                      openAction === "payment" && (
                        <form
                          id={`payment-action-${transaction.transactionId}`}
                          className="recent-cancel-form recent-payment-switch-form"
                          onSubmit={(event) =>
                            void switchPayment(event, transaction)
                          }
                        >
                          <div className="recent-action-heading">
                            <span className="recent-action-kicker">
                              Optional payment correction
                            </span>
                            <h3>
                              {transaction.paymentMethod === "CASH"
                                ? "Cash was recorded by mistake?"
                                : "QR was recorded by mistake?"}
                            </h3>
                            <p>
                              {transaction.paymentMethod === "CASH"
                                ? "This changes the payment record to QR. The sale stays active, and no refund is sent."
                                : "This changes the payment record to cash. The sale stays active, and no refund is sent."}
                            </p>
                          </div>
                          <small className="field-hint">
                            {transaction.paymentMethod === "CASH"
                              ? `Cash will decrease by ₱${transaction.amountDue}; QR will increase by ₱${transaction.qrAmountIfSwitched}. The QR total does not include cash rounding.`
                              : `QR will decrease by ₱${transaction.amountDue}; expected drawer cash will increase by ₱${transaction.cashAmountIfSwitched}.`}
                          </small>
                          <label
                            className="field-label"
                            htmlFor={`switch-reason-${transaction.transactionId}`}
                          >
                            Reason for payment correction
                          </label>
                          <select
                            id={`switch-reason-${transaction.transactionId}`}
                            className="text-input select-input"
                            required
                            value={
                              switchReasons[transaction.transactionId] ?? ""
                            }
                            onChange={(event) =>
                              setSwitchReasons((current) => ({
                                ...current,
                                [transaction.transactionId]: event.target
                                  .value as ReasonChoice,
                              }))
                            }
                          >
                            <option value="" disabled>
                              Select a reason
                            </option>
                            <option value="Cashier Fault">Cashier Fault</option>
                            <option value="Customer Fault">
                              Customer Fault
                            </option>
                            <option value="Custom">Custom</option>
                          </select>
                          {switchReasons[transaction.transactionId] ===
                            "Custom" && (
                            <textarea
                              aria-label="Custom payment correction reason"
                              className="text-input reversal-reason-input"
                              placeholder="Add a custom reason (optional)"
                              maxLength={500}
                              value={
                                customSwitchReasons[
                                  transaction.transactionId
                                ] ?? ""
                              }
                              onChange={(event) =>
                                setCustomSwitchReasons((current) => ({
                                  ...current,
                                  [transaction.transactionId]:
                                    event.target.value,
                                }))
                              }
                            />
                          )}
                          <button
                            className="button button-secondary"
                            type="submit"
                            disabled={savingId === transaction.transactionId}
                          >
                            {savingId === transaction.transactionId
                              ? "Updating payment…"
                              : transaction.paymentMethod === "CASH"
                                ? "Switch cash to QR"
                                : "Switch QR to cash"}
                          </button>
                        </form>
                      )}
                    {openAction === "cancel" && (
                      <form
                        id={`cancel-action-${transaction.transactionId}`}
                        className="recent-cancel-form recent-cancel-action"
                        onSubmit={(event) =>
                          void cancelTransaction(event, transaction)
                        }
                      >
                        <div className="recent-action-heading">
                          <span className="recent-action-kicker">
                            Separate action
                          </span>
                          <h3>Cancel and refund this sale</h3>
                          <p>
                            {transaction.paymentMethod === "QR"
                              ? "This reverses the sale. Send the QR refund first, then confirm it below."
                              : "This reverses the sale and refunds cash from the open drawer."}
                          </p>
                        </div>
                        <div className="recent-cancel-stock">
                          <div className="recent-cancel-section-heading">
                            <strong>
                              1. Choose a stock outcome for each item
                            </strong>
                            <small>
                              Check what was physically returned before
                              choosing.
                            </small>
                          </div>
                          {transaction.lines.map((line) => (
                            <fieldset
                              className="recent-cancel-line-stock"
                              key={line.saleLineId}
                            >
                              <legend>
                                <strong>{line.productName}</strong>
                                <small>
                                  {line.sku} / quantity {line.quantity}
                                </small>
                              </legend>
                              <div className="recent-stock-choice">
                                <label>
                                  <input
                                    type="radio"
                                    name={`stock-${line.saleLineId}`}
                                    required
                                    checked={
                                      restockChoices[line.saleLineId] === true
                                    }
                                    onChange={() =>
                                      setRestockChoices((current) => ({
                                        ...current,
                                        [line.saleLineId]: true,
                                      }))
                                    }
                                  />
                                  Returned and saleable; restock
                                </label>
                                <label>
                                  <input
                                    type="radio"
                                    name={`stock-${line.saleLineId}`}
                                    required
                                    checked={
                                      restockChoices[line.saleLineId] === false
                                    }
                                    onChange={() =>
                                      setRestockChoices((current) => ({
                                        ...current,
                                        [line.saleLineId]: false,
                                      }))
                                    }
                                  />
                                  Not saleable; write off
                                </label>
                                {restockChoices[line.saleLineId] === true &&
                                  line.lotAllocations.length > 0 && (
                                    <label>
                                      <input
                                        type="checkbox"
                                        required
                                        checked={
                                          lotVerified[line.saleLineId] === true
                                        }
                                        onChange={(event) =>
                                          setLotVerified((current) => ({
                                            ...current,
                                            [line.saleLineId]:
                                              event.target.checked,
                                          }))
                                        }
                                      />
                                      I physically checked the original lots
                                    </label>
                                  )}
                              </div>
                            </fieldset>
                          ))}
                        </div>
                        <div className="recent-cancel-details">
                          <strong>2. Review and record the cancellation</strong>
                          <label
                            className="field-label"
                            htmlFor={`reason-${transaction.transactionId}`}
                          >
                            Cancellation reason
                          </label>
                          <select
                            id={`reason-${transaction.transactionId}`}
                            className="text-input select-input"
                            required
                            value={reasons[transaction.transactionId] ?? ""}
                            onChange={(event) =>
                              setReasons((current) => ({
                                ...current,
                                [transaction.transactionId]: event.target
                                  .value as ReasonChoice,
                              }))
                            }
                          >
                            <option value="" disabled>
                              Select a reason
                            </option>
                            <option value="Cashier Fault">Cashier Fault</option>
                            <option value="Customer Fault">
                              Customer Fault
                            </option>
                            <option value="Custom">Custom</option>
                          </select>
                          {reasons[transaction.transactionId] === "Custom" && (
                            <textarea
                              aria-label="Custom cancellation reason"
                              className="text-input reversal-reason-input"
                              placeholder="Add a custom reason (optional)"
                              maxLength={500}
                              value={
                                customReasons[transaction.transactionId] ?? ""
                              }
                              onChange={(event) =>
                                setCustomReasons((current) => ({
                                  ...current,
                                  [transaction.transactionId]:
                                    event.target.value,
                                }))
                              }
                            />
                          )}
                          {transaction.paymentMethod === "QR" ? (
                            <label className="inventory-checkbox">
                              <input
                                type="checkbox"
                                required
                                checked={
                                  qrRefundConfirmed[
                                    transaction.transactionId
                                  ] === true
                                }
                                onChange={(event) =>
                                  setQrRefundConfirmed((current) => ({
                                    ...current,
                                    [transaction.transactionId]:
                                      event.target.checked,
                                  }))
                                }
                              />
                              <span>I sent the QR refund to the customer.</span>
                            </label>
                          ) : refundShift ? (
                            <small className="field-hint">
                              Cash refund will come from this drawer (expected ₱
                              {refundShift.expectedCash}).
                            </small>
                          ) : (
                            <small className="field-hint field-hint-error">
                              Open a cash drawer before recording this cash
                              refund.
                            </small>
                          )}
                          <small className="field-hint">
                            Cancellation window closes in{" "}
                            {Math.floor(secondsRemaining / 60)}:
                            {String(secondsRemaining % 60).padStart(2, "0")}.
                          </small>
                        </div>
                        <button
                          className="button button-danger"
                          type="submit"
                          disabled={
                            savingId === transaction.transactionId ||
                            (transaction.paymentMethod === "CASH" &&
                              !refundShift)
                          }
                        >
                          {savingId === transaction.transactionId
                            ? "Recording cancellation…"
                            : "Cancel and refund sale"}
                        </button>
                      </form>
                    )}
                  </>
                ) : (
                  <small className="field-hint">
                    Cancellation window expired.
                  </small>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="table-loading">
          No transactions are within the 10-minute cancellation window.
        </div>
      )}
    </section>
  );
}
