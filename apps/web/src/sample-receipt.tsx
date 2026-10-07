import { useEffect } from "react";
import { X } from "lucide-react";

export type SampleReceiptData = {
  transactionId: string;
  createdAt: string;
  paymentMethod: "CASH" | "QR";
  lines: Array<{
    description: string;
    sku?: string;
    unit: string;
    quantity: number;
    unitPrice: string;
    amount: string;
  }>;
  totalSales: string;
  discounts: string;
  vat: string;
  vatRemoved: string;
  amountDue: string;
  cashRoundingAdjustment?: string;
  estimate?: boolean;
  cancelled?: boolean;
};

export function moneyTimesQuantity(value: string, quantity: number): string {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
  const total = (negative ? -cents : cents) * BigInt(quantity);
  const sign = total < 0n ? "-" : "";
  const absolute = total < 0n ? -total : total;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

export function addMoney(...values: string[]): string {
  const total = values.reduce((sum, value) => {
    const negative = value.startsWith("-");
    const [whole = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
    return sum + (negative ? -cents : cents);
  }, 0n);
  const sign = total < 0n ? "-" : "";
  const absolute = total < 0n ? -total : total;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

function receiptMoney(value: string): string {
  const amount = Number(value);
  return `₱${(Number.isFinite(amount) ? amount : 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function receiptDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("en-PH", {
        timeZone: "Asia/Manila",
        dateStyle: "medium",
        timeStyle: "short",
      });
}

export function SampleReceiptModal({
  receipt,
  onClose,
}: {
  receipt: SampleReceiptData;
  onClose: () => void;
}) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const hasRounding =
    receipt.paymentMethod === "CASH" &&
    receipt.cashRoundingAdjustment !== undefined &&
    receipt.cashRoundingAdjustment !== "0.00";
  const hasVatRemoved = receipt.vatRemoved !== "0.00";

  return (
    <div className="sample-receipt-backdrop">
      <section
        className="sample-receipt-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sample-receipt-title"
      >
        <div className="sample-receipt-toolbar">
          <div>
            <span className="sample-receipt-label">SAMPLE PREVIEW</span>
            <h2 id="sample-receipt-title">Sample sales invoice</h2>
          </div>
          <button
            className="icon-button sample-receipt-close"
            type="button"
            aria-label="Close receipt preview"
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </div>

        <div className="sample-receipt-paper">
          <div className="sample-receipt-warning">
            {receipt.cancelled ? "CANCELLED SALE · " : ""}
            Sample only · Not a tax invoice · Not valid for input tax claims
          </div>
          <header className="sample-receipt-header">
            <span className="sample-receipt-overline">SALES INVOICE · SAMPLE</span>
          </header>

          <div className="sample-receipt-meta">
            <div>
              <span>Reference</span>
              <strong>{receipt.transactionId}</strong>
            </div>
            <div>
              <span>Date</span>
              <strong>{receiptDate(receipt.createdAt)}</strong>
            </div>
            <div>
              <span>Payment method</span>
              <strong>{receipt.paymentMethod === "CASH" ? "Cash" : "QR"}</strong>
            </div>
          </div>

          <div className="sample-receipt-table-wrap">
            <table className="sample-receipt-table">
              <thead>
                <tr>
                  <th>Description</th>
                  <th>Qty.</th>
                  <th>Unit price</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {receipt.lines.map((line, index) => (
                  <tr key={`${line.sku ?? line.description}-${index}`}>
                    <td>
                      <strong>{line.description}</strong>
                      {line.sku && <small>{line.sku}</small>}
                    </td>
                    <td>{line.quantity} {line.unit}</td>
                    <td>{receiptMoney(line.unitPrice)}</td>
                    <td>{receiptMoney(line.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <dl className="sample-receipt-totals">
            <div>
              <dt>Total sales</dt>
              <dd>{receiptMoney(receipt.totalSales)}</dd>
            </div>
            <div>
              <dt>Discounts recorded</dt>
              <dd>{receiptMoney(receipt.discounts)}</dd>
            </div>
            <div>
              <dt>VAT included / recorded</dt>
              <dd>{receiptMoney(receipt.vat)}</dd>
            </div>
            {hasVatRemoved && (
              <div>
                <dt>Less VAT removed</dt>
                <dd>−{receiptMoney(receipt.vatRemoved)}</dd>
              </div>
            )}
            {hasRounding && (
              <div>
                <dt>Cash rounding</dt>
                <dd>{receiptMoney(receipt.cashRoundingAdjustment!)}</dd>
              </div>
            )}
            <div className="sample-receipt-due">
              <dt>{receipt.estimate ? "Estimated amount due" : "Total amount due"}</dt>
              <dd>{receiptMoney(receipt.amountDue)}</dd>
            </div>
          </dl>

        </div>
      </section>
    </div>
  );
}
