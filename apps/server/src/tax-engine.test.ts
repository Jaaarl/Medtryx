import { describe, expect, it } from "vitest";
import {
  cashRoundingAdjustment,
  calculateTaxLine,
  PROVISIONAL_TAX_POLICY,
  TaxCalculationError,
} from "./tax-engine.js";

const proposedPolicy = {
  ...PROVISIONAL_TAX_POLICY,
  approved: true,
};

describe("cash total rounding to the nearest 25 centavos", () => {
  it.each([
    [0, 0],
    [12, -12],
    [13, 12],
    [37, -12],
    [38, 12],
    [62, -12],
    [63, 12],
    [87, -12],
    [88, 12],
    [99, 1],
  ])(
    "maps an ending of %i centavos to its nearest quarter",
    (ending, adjustment) => {
      expect(
        cashRoundingAdjustment(11_200 + ending, "NEAREST_25_CENTAVOS"),
      ).toBe(adjustment);
    },
  );

  it("leaves totals unchanged when cash rounding is off", () => {
    expect(cashRoundingAdjustment(11_213, "NONE")).toBe(0);
  });
});

describe("line-level decimal tax calculations", () => {
  it("separates included VAT from a regular VATable line", () => {
    expect(
      calculateTaxLine(
        {
          unitPriceCentavos: 11_200,
          quantity: 1,
          taxClass: "VATABLE",
          isScEligible: true,
          isPwdEligible: true,
          benefit: "REGULAR",
          benefitApplied: false,
        },
        proposedPolicy,
      ),
    ).toMatchObject({
      grossCentavos: 11_200,
      taxBasisCentavos: 10_000,
      vatCentavos: 1_200,
      discountCentavos: 0,
      amountDueCentavos: 11_200,
    });
  });

  it.each([true, false])(
    "supports a 0% VATable line with vatInclusivePrices=%s",
    (vatInclusivePrices) => {
      const result = calculateTaxLine(
        {
          unitPriceCentavos: 10_000,
          quantity: 1,
          taxClass: "VATABLE",
          isScEligible: true,
          isPwdEligible: true,
          benefit: "REGULAR",
          benefitApplied: false,
        },
        {
          ...proposedPolicy,
          vatRateBasisPoints: 0,
          vatInclusivePrices,
        },
      );

      expect(result).toMatchObject({
        grossCentavos: 10_000,
        taxBasisCentavos: 10_000,
        vatCentavos: 0,
        amountDueCentavos: 10_000,
      });
    },
  );

  it("removes included VAT before applying a selected eligible SC discount", () => {
    expect(
      calculateTaxLine(
        {
          unitPriceCentavos: 11_200,
          quantity: 1,
          taxClass: "VATABLE",
          isScEligible: true,
          isPwdEligible: true,
          benefit: "SENIOR_CITIZEN",
          benefitApplied: true,
        },
        proposedPolicy,
      ),
    ).toMatchObject({
      grossCentavos: 11_200,
      taxBasisCentavos: 10_000,
      vatCentavos: 0,
      discountCentavos: 2_000,
      amountDueCentavos: 8_000,
      ruleVersion: PROVISIONAL_TAX_POLICY.version,
    });
  });

  it("applies a PWD discount to the full VAT-exempt line without removing VAT twice", () => {
    expect(
      calculateTaxLine(
        {
          unitPriceCentavos: 10_000,
          quantity: 1,
          taxClass: "VAT_EXEMPT",
          isScEligible: true,
          isPwdEligible: true,
          benefit: "PWD",
          benefitApplied: true,
        },
        proposedPolicy,
      ),
    ).toMatchObject({
      taxBasisCentavos: 10_000,
      vatCentavos: 0,
      discountCentavos: 2_000,
      amountDueCentavos: 8_000,
    });
  });

  it("rounds VAT and discount for each whole line in centavos", () => {
    const result = calculateTaxLine(
      {
        unitPriceCentavos: 5,
        quantity: 1,
        taxClass: "VATABLE",
        isScEligible: true,
        isPwdEligible: true,
        benefit: "SENIOR_CITIZEN",
        benefitApplied: true,
      },
      proposedPolicy,
    );
    expect(result.taxBasisCentavos).toBe(4);
    expect(result.discountCentavos).toBe(1);
    expect(result.amountDueCentavos).toBe(3);
  });

  it("supports an explicitly configured VAT-exclusive policy for development review", () => {
    const result = calculateTaxLine(
      {
        unitPriceCentavos: 10_000,
        quantity: 1,
        taxClass: "VATABLE",
        isScEligible: false,
        isPwdEligible: false,
        benefit: "REGULAR",
        benefitApplied: false,
      },
      { ...proposedPolicy, vatInclusivePrices: false },
    );
    expect(result).toMatchObject({
      grossCentavos: 10_000,
      taxBasisCentavos: 10_000,
      vatCentavos: 1_200,
      amountDueCentavos: 11_200,
    });
  });

  it("checks SC and PWD eligibility separately and rejects unapproved zero-rated items", () => {
    expect(() =>
      calculateTaxLine(
        {
          unitPriceCentavos: 1_000,
          quantity: 1,
          taxClass: "VAT_EXEMPT",
          isScEligible: true,
          isPwdEligible: false,
          benefit: "PWD",
          benefitApplied: true,
        },
        proposedPolicy,
      ),
    ).toThrow(new TaxCalculationError("product_not_pwd_eligible"));
    expect(() =>
      calculateTaxLine(
        {
          unitPriceCentavos: 1_000,
          quantity: 1,
          taxClass: "VAT_EXEMPT",
          isScEligible: false,
          isPwdEligible: true,
          benefit: "SENIOR_CITIZEN",
          benefitApplied: true,
        },
        proposedPolicy,
      ),
    ).toThrow(new TaxCalculationError("product_not_senior_eligible"));
    expect(() =>
      calculateTaxLine(
        {
          unitPriceCentavos: 1_000,
          quantity: 1,
          taxClass: "ZERO_RATED",
          isScEligible: false,
          isPwdEligible: false,
          benefit: "REGULAR",
          benefitApplied: false,
        },
        proposedPolicy,
      ),
    ).toThrow(new TaxCalculationError("zero_rated_not_approved"));
  });
});
