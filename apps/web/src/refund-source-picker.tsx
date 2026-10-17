import { useEffect, useId, useRef, useState } from "react";
import type {
  CashRefundSource,
  CashRefundShift,
  RefundSourceOptions,
} from "@medtryx/shared";
import { api } from "./api";
import "./refund-source-picker.css";

export type SelectedRefundSource = {
  transactionId: string;
  source: CashRefundSource;
  shift: CashRefundShift;
  ownerPassword?: string;
  ready: boolean;
};

function shiftTime(value: string): string {
  return new Date(value).toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function ShiftDescription({ shift }: { shift: CashRefundShift | null }) {
  if (!shift) return null;
  return (
    <span className="refund-source-shift">
      <span>
        {shift.cashierUsername
          ? `${shift.cashierUsername} · ${shift.cashierEmail}`
          : shift.cashierEmail}
      </span>
      <span>
        Opened {shiftTime(shift.openedAt)} ·{" "}
        {shift.closedAt ? "Closed" : "Open"}
      </span>
      {shift.closedAt && <span>Closed {shiftTime(shift.closedAt)}</span>}
      <span>
        Expected cash:{" "}
        {shift.expectedCash.startsWith("-")
          ? `−₱${shift.expectedCash.slice(1)}`
          : `₱${shift.expectedCash}`}
      </span>
    </span>
  );
}

export function RefundSourcePicker({
  transactionId,
  ownerApprovalInParent = false,
  onChange,
}: {
  transactionId: string;
  ownerApprovalInParent?: boolean;
  onChange: (selection: SelectedRefundSource | null) => void;
}) {
  const id = useId();
  const callback = useRef(onChange);
  const [options, setOptions] = useState<RefundSourceOptions | null>(null);
  const [source, setSource] = useState<CashRefundSource>("CURRENT");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    callback.current = onChange;
  }, [onChange]);
  useEffect(() => {
    let active = true;
    void api
      .get<RefundSourceOptions>(
        `/sales/${encodeURIComponent(transactionId)}/refund-sources`,
      )
      .then((result) => {
        if (active) {
          setOptions(result);
          setError(false);
        }
      })
      .catch(() => {
        if (active) {
          setOptions(null);
          setError(true);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [transactionId, revision]);

  useEffect(() => {
    const shift =
      source === "CURRENT" ? options?.currentShift : options?.originalShift;
    if (
      loading ||
      error ||
      !shift ||
      options?.transactionId !== transactionId
    ) {
      callback.current(null);
      return;
    }
    const closed = shift.closedAt !== null;
    callback.current({
      transactionId,
      source,
      shift,
      ...(closed && !ownerApprovalInParent ? { ownerPassword } : {}),
      ready:
        !closed ||
        (options.ownerApprovalAllowed &&
          (ownerApprovalInParent || ownerPassword.length > 0)),
    });
  }, [
    options,
    source,
    ownerPassword,
    loading,
    error,
    transactionId,
    ownerApprovalInParent,
  ]);

  function refresh() {
    setLoading(true);
    setError(false);
    setOwnerPassword("");
    callback.current(null);
    setRevision((value) => value + 1);
  }
  const originalClosed = options?.originalShift?.closedAt != null;
  const needsPassword =
    source === "ORIGINAL" && originalClosed && !ownerApprovalInParent;
  const originalAllowed =
    !!options?.originalShift &&
    (!originalClosed || options.ownerApprovalAllowed);
  const sameShift =
    !!options?.originalShift &&
    options.originalShift.id === options.currentShift?.id;

  return (
    <fieldset className="refund-source-picker" disabled={loading}>
      <legend>Charge cash refund to</legend>
      {loading ? (
        <p className="field-hint" role="status">
          Loading refund shifts…
        </p>
      ) : error ? (
        <p className="field-hint field-hint-error" role="alert">
          Unable to load refund shifts.{" "}
          <button type="button" className="text-action" onClick={refresh}>
            Retry
          </button>
        </p>
      ) : (
        <>
          <label
            className={`refund-source-choice ${source === "CURRENT" ? "is-selected" : ""}`}
          >
            <input
              type="radio"
              name={`${id}-source`}
              value="CURRENT"
              checked={source === "CURRENT"}
              onChange={() => {
                setSource("CURRENT");
                setOwnerPassword("");
              }}
            />
            <span>
              <strong>Current open shift</strong>
              <ShiftDescription shift={options?.currentShift ?? null} />
              {!options?.currentShift && (
                <span className="field-hint">
                  No shift is currently open. Open a shift or choose the
                  original sale’s shift.
                </span>
              )}
            </span>
          </label>
          <label
            className={`refund-source-choice ${source === "ORIGINAL" ? "is-selected" : ""}`}
          >
            <input
              type="radio"
              name={`${id}-source`}
              value="ORIGINAL"
              checked={source === "ORIGINAL"}
              disabled={!originalAllowed}
              onChange={() => setSource("ORIGINAL")}
            />
            <span>
              <strong>Original sale’s shift</strong>
              <ShiftDescription shift={options?.originalShift ?? null} />
              {sameShift && (
                <span className="field-hint">
                  This is also the current open shift.
                </span>
              )}
              {!options?.originalShift && (
                <span className="field-hint">
                  No shift was recorded for this sale.
                </span>
              )}
              {originalClosed && !options?.ownerApprovalAllowed && (
                <span className="field-hint">
                  An owner must approve refunds against this closed shift in
                  Sales history.
                </span>
              )}
            </span>
          </label>
          {source === "ORIGINAL" && originalClosed && (
            <p className="field-hint refund-source-closed-note">
              Owner approval is required. This updates the closed shift’s
              expected cash and closing variance. Its counted cash and closing
              time are kept. A changed variance will return to pending approval.
            </p>
          )}
          {needsPassword && options?.ownerApprovalAllowed && (
            <label
              className="refund-source-password"
              htmlFor={`${id}-owner-password`}
            >
              <span className="field-label">
                Owner password to approve closed-shift refund
              </span>
              <input
                id={`${id}-owner-password`}
                className="text-input"
                type="password"
                autoComplete="current-password"
                value={ownerPassword}
                onChange={(event) => setOwnerPassword(event.target.value)}
                required
                maxLength={128}
              />
            </label>
          )}
          <div className="refund-source-footer">
            <small>
              Only the selected shift is charged. Expected cash can be negative.
            </small>
            <button type="button" className="text-action" onClick={refresh}>
              Refresh shifts
            </button>
          </div>
        </>
      )}
    </fieldset>
  );
}
