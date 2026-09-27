import { Decimal } from "decimal.js";

export type SaleBenefit = "REGULAR" | "SENIOR_CITIZEN" | "PWD";
export type SaleTaxClass = "VATABLE" | "VAT_EXEMPT" | "ZERO_RATED";
export type TaxRoundingMode = "HALF_UP" | "HALF_EVEN" | "DOWN";

export type TaxPolicy = {
  version: string;
  approved: boolean;
  vatRateBasisPoints: number;
  seniorDiscountBasisPoints: number;
  pwdDiscountBasisPoints: number;
  vatInclusivePrices: boolean;
  allowZeroRated: boolean;
  roundingMode: TaxRoundingMode;
};

export type TaxLineInput = {
  unitPriceCentavos: number;
  quantity: number;
  taxClass: SaleTaxClass;
  scPwdEligible: boolean;
  benefit: SaleBenefit;
  benefitApplied: boolean;
};

export type TaxLineResult = {
  grossCentavos: number;
  taxBasisCentavos: number;
  vatCentavos: number;
  vatRemovedCentavos: number;
  discountCentavos: number;
  amountDueCentavos: number;
  benefitApplied: boolean;
  ruleVersion: string;
};

export class TaxCalculationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export const PROVISIONAL_TAX_POLICY: TaxPolicy = {
  version: "PH-PROVISIONAL-12-VAT-LINE-HALF-UP-1",
  approved: false,
  vatRateBasisPoints: 1_200,
  seniorDiscountBasisPoints: 2_000,
  pwdDiscountBasisPoints: 2_000,
  vatInclusivePrices: true,
  allowZeroRated: false,
  roundingMode: "HALF_UP",
};

function decimalRoundingMode(mode: TaxRoundingMode): Decimal.Rounding {
  switch (mode) {
    case "HALF_EVEN":
      return Decimal.ROUND_HALF_EVEN;
    case "DOWN":
      return Decimal.ROUND_DOWN;
    case "HALF_UP":
      return Decimal.ROUND_HALF_UP;
  }
}

function roundedCentavos(value: Decimal, mode: TaxRoundingMode): number {
  const result = value.toDecimalPlaces(0, decimalRoundingMode(mode)).toNumber();
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TaxCalculationError("sale_amount_overflow");
  }
  return result;
}

export function calculateTaxLine(
  input: TaxLineInput,
  policy: TaxPolicy,
): TaxLineResult {
  if (
    !Number.isSafeInteger(input.unitPriceCentavos) ||
    input.unitPriceCentavos <= 0 ||
    !Number.isSafeInteger(input.quantity) ||
    input.quantity < 1
  ) {
    throw new TaxCalculationError("invalid_sale_line");
  }
  if (input.benefitApplied && input.benefit === "REGULAR") {
    throw new TaxCalculationError("regular_sale_cannot_apply_benefit");
  }
  if (input.benefitApplied && !input.scPwdEligible) {
    throw new TaxCalculationError("product_not_benefit_eligible");
  }
  if (input.taxClass === "ZERO_RATED" && !policy.allowZeroRated) {
    throw new TaxCalculationError("zero_rated_not_approved");
  }
  const gross = new Decimal(input.unitPriceCentavos).mul(input.quantity);
  const useBenefit = input.benefitApplied;
  const discountRate =
    input.benefit === "SENIOR_CITIZEN"
      ? policy.seniorDiscountBasisPoints
      : policy.pwdDiscountBasisPoints;
  let taxBasis: Decimal;
  let vat = new Decimal(0);
  let vatRemoved = new Decimal(0);
  let discount = new Decimal(0);

  if (input.taxClass === "VATABLE") {
    const basis = policy.vatInclusivePrices
      ? gross
          .mul(10_000)
          .div(10_000 + policy.vatRateBasisPoints)
          .toDecimalPlaces(0, decimalRoundingMode(policy.roundingMode))
      : gross;
    if (useBenefit) {
      taxBasis = basis;
      if (policy.vatInclusivePrices) vatRemoved = gross.minus(basis);
      discount = basis
        .mul(discountRate)
        .div(10_000)
        .toDecimalPlaces(0, decimalRoundingMode(policy.roundingMode));
    } else {
      taxBasis = basis;
      vat = policy.vatInclusivePrices
        ? gross.minus(basis)
        : gross
            .mul(policy.vatRateBasisPoints)
            .div(10_000)
            .toDecimalPlaces(0, decimalRoundingMode(policy.roundingMode));
    }
  } else {
    taxBasis = gross;
    if (useBenefit) {
      discount = gross
        .mul(discountRate)
        .div(10_000)
        .toDecimalPlaces(0, decimalRoundingMode(policy.roundingMode));
    }
  }

  const grossCentavos = roundedCentavos(gross, policy.roundingMode);
  const taxBasisCentavos = roundedCentavos(taxBasis, policy.roundingMode);
  const vatCentavos = roundedCentavos(vat, policy.roundingMode);
  const vatRemovedCentavos = roundedCentavos(vatRemoved, policy.roundingMode);
  const discountCentavos = roundedCentavos(discount, policy.roundingMode);
  const amountDue =
    input.taxClass === "VATABLE" && useBenefit && policy.vatInclusivePrices
      ? taxBasis.minus(discount)
      : input.taxClass === "VATABLE" && useBenefit
        ? gross.minus(discount)
        : gross.plus(policy.vatInclusivePrices ? 0 : vat).minus(discount);
  const amountDueCentavos = roundedCentavos(amountDue, policy.roundingMode);

  return {
    grossCentavos,
    taxBasisCentavos,
    vatCentavos,
    vatRemovedCentavos,
    discountCentavos,
    amountDueCentavos,
    benefitApplied: useBenefit,
    ruleVersion: policy.version,
  };
}
