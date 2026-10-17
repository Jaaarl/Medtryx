import { calculateRefundTotal, prorateCentavos } from "@medtryx/shared";

export type RefundLine = {
  saleLineId: string;
  productName: string;
  quantity: number;
  amountDue: string;
  lotAllocations: Array<{ lotId: string; lotCode: string; quantity: number }>;
};
export type RefundSelection = {
  mode: "FULL" | "PARTIAL";
  quantities: Record<string, string>;
  lotQuantities: Record<string, string>;
};
export const fullRefund: RefundSelection = {
  mode: "FULL",
  quantities: {},
  lotQuantities: {},
};

function cents(value: string): number {
  return Number(value.replace(".", ""));
}
function money(value: number): string {
  return (value / 100).toFixed(2);
}
export function refundQuantity(
  line: RefundLine,
  selection: RefundSelection,
): number {
  return selection.mode === "FULL"
    ? line.quantity
    : Number(selection.quantities[line.saleLineId] ?? "0");
}
export function refundReview(
  lines: RefundLine[],
  adjustment: string,
  selection: RefundSelection,
) {
  const valid =
    lines.every((line) => {
      if (
        selection.mode === "PARTIAL" &&
        selection.quantities[line.saleLineId] === ""
      )
        return false;
      const quantity = refundQuantity(line, selection);
      if (
        !Number.isSafeInteger(quantity) ||
        quantity < 0 ||
        quantity > line.quantity
      )
        return false;
      if (
        quantity > 0 &&
        quantity < line.quantity &&
        line.lotAllocations.length > 1
      ) {
        const quantities = line.lotAllocations.map((lot) =>
          Number(
            selection.lotQuantities[`${line.saleLineId}:${lot.lotId}`] ?? "0",
          ),
        );
        return (
          quantities.every(
            (value, index) =>
              Number.isSafeInteger(value) &&
              value >= 0 &&
              value <= line.lotAllocations[index]!.quantity,
          ) && quantities.reduce((sum, value) => sum + value, 0) === quantity
        );
      }
      return true;
    }) && lines.some((line) => refundQuantity(line, selection) > 0);
  const total = valid
    ? calculateRefundTotal(
        lines.map((line) => ({
          quantity: line.quantity,
          refundQuantity: refundQuantity(line, selection),
          amountCentavos: cents(line.amountDue),
        })),
        cents(adjustment),
      ).amountCentavos
    : 0;
  return { valid, total: money(total) };
}
export function refundLineRequest(
  line: RefundLine,
  selection: RefundSelection,
) {
  const quantity = refundQuantity(line, selection);
  return {
    saleLineId: line.saleLineId,
    quantity,
    ...(quantity > 0 &&
    quantity < line.quantity &&
    line.lotAllocations.length > 1
      ? {
          lotQuantities: line.lotAllocations.map((lot) => ({
            lotId: lot.lotId,
            quantity: Number(
              selection.lotQuantities[`${line.saleLineId}:${lot.lotId}`] ?? "0",
            ),
          })),
        }
      : {}),
  };
}

export function RefundOptions({
  id,
  lines,
  adjustment,
  selection,
  onChange,
}: {
  id: string;
  lines: RefundLine[];
  adjustment: string;
  selection: RefundSelection;
  onChange: (selection: RefundSelection) => void;
}) {
  const review = refundReview(lines, adjustment, selection);
  return (
    <div className="refund-options">
      <label className="inventory-field" htmlFor={`refund-scope-${id}`}>
        <span>Refund option</span>
        <select
          id={`refund-scope-${id}`}
          className="text-input select-input"
          value={selection.mode}
          onChange={(event) =>
            onChange({
              ...selection,
              mode: event.target.value as RefundSelection["mode"],
            })
          }
        >
          <option value="FULL">Full refund — all items</option>
          <option value="PARTIAL">Selected quantities — partial refund</option>
        </select>
      </label>
      {selection.mode === "PARTIAL" && (
        <>
          <p className="field-hint">
            Enter only the quantities being refunded. Use 0 for consumed or kept
            items; they remain sold.
          </p>
          {lines.map((line) => {
            const quantity = refundQuantity(line, selection);
            const validQuantity =
              Number.isSafeInteger(quantity) &&
              quantity >= 0 &&
              quantity <= line.quantity;
            return (
              <div className="refund-quantity-row" key={line.saleLineId}>
                <label
                  className="inventory-field"
                  htmlFor={`refund-quantity-${line.saleLineId}`}
                >
                  <span>
                    {line.productName} — quantity to refund (sold{" "}
                    {line.quantity})
                  </span>
                  <input
                    id={`refund-quantity-${line.saleLineId}`}
                    type="number"
                    className="text-input"
                    min={0}
                    max={line.quantity}
                    step={1}
                    required
                    value={selection.quantities[line.saleLineId] ?? "0"}
                    onChange={(event) =>
                      onChange({
                        ...selection,
                        quantities: {
                          ...selection.quantities,
                          [line.saleLineId]: event.target.value,
                        },
                      })
                    }
                  />
                </label>
                {validQuantity && (
                  <small className="field-hint">
                    Item refund: ₱
                    {money(
                      prorateCentavos(
                        cents(line.amountDue),
                        quantity,
                        line.quantity,
                      ),
                    )}
                  </small>
                )}
                {quantity > 0 &&
                  quantity < line.quantity &&
                  line.lotAllocations.length > 1 && (
                    <div>
                      <p className="field-hint">
                        Identify the returned lots. Their quantities must add up
                        to {quantity}.
                      </p>
                      {line.lotAllocations.map((lot) => (
                        <label className="inventory-field" key={lot.lotId}>
                          <span>
                            Returned from lot {lot.lotCode} (sold {lot.quantity}
                            )
                          </span>
                          <input
                            type="number"
                            className="text-input"
                            min={0}
                            max={lot.quantity}
                            step={1}
                            required
                            value={
                              selection.lotQuantities[
                                `${line.saleLineId}:${lot.lotId}`
                              ] ?? "0"
                            }
                            onChange={(event) =>
                              onChange({
                                ...selection,
                                lotQuantities: {
                                  ...selection.lotQuantities,
                                  [`${line.saleLineId}:${lot.lotId}`]:
                                    event.target.value,
                                },
                              })
                            }
                          />
                        </label>
                      ))}
                    </div>
                  )}
              </div>
            );
          })}
        </>
      )}
      <div className="sale-detail-total" role="status" aria-live="polite">
        <span>Amount to refund customer</span>
        <strong>
          {review.valid ? `₱${review.total}` : "Select valid quantities"}
        </strong>
      </div>
      <small className="field-hint">
        Based on the original prices after discounts, including the proportional
        share of any saved cash rounding.
      </small>
      <small className="field-hint">
        Review all returned items before saving; each sale can have one refund
        record.
      </small>
    </div>
  );
}
