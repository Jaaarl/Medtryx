/** Allocate saved centavos by quantity, rounding half up without floating point. */
export function prorateCentavos(
  total: number,
  quantity: number,
  sold: number,
): number {
  if (
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(quantity) ||
    !Number.isSafeInteger(sold) ||
    sold <= 0 ||
    quantity < 0 ||
    quantity > sold
  ) {
    throw new Error("invalid_refund_quantity");
  }
  const sign = total < 0 ? -1n : 1n;
  const numerator = BigInt(Math.abs(total)) * BigInt(quantity);
  return Number(sign * ((numerator * 2n + BigInt(sold)) / (2n * BigInt(sold))));
}

export function calculateRefundTotal(
  lines: Array<{
    quantity: number;
    refundQuantity: number;
    amountCentavos: number;
  }>,
  cashRoundingAdjustmentCentavos: number,
): { amountCentavos: number; cashRoundingAdjustmentCentavos: number } {
  const savedTotal = lines.reduce((sum, line) => sum + line.amountCentavos, 0);
  const lineTotal = lines.reduce(
    (sum, line) =>
      sum +
      prorateCentavos(line.amountCentavos, line.refundQuantity, line.quantity),
    0,
  );
  const full = lines.every((line) => line.refundQuantity === line.quantity);
  const adjustment = full
    ? cashRoundingAdjustmentCentavos
    : savedTotal > 0
      ? prorateCentavos(cashRoundingAdjustmentCentavos, lineTotal, savedTotal)
      : 0;
  return {
    amountCentavos: lineTotal + adjustment,
    cashRoundingAdjustmentCentavos: adjustment,
  };
}
