import { describe, expect, it } from "vitest";
import {
  calculateTaxLine,
  PROVISIONAL_TAX_POLICY,
  TaxCalculationError,
} from "./tax-engine.js";

const proposedPolicy = {
  ...PROVISIONAL_TAX_POLICY,
  approved: true,
};

describe("line-level decimal tax calculations", () => {
  it("separates included VAT from a regular VATable line", () => {
    expect(
      calculateTaxLine(
        {
          unitPriceCentavos: 11_200,
          quantity: 1,
          taxClass: "VATABLE",
          scPwdEligible: true,
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

  it("removes included VAT before applying a selected eligible SC discount", () => {
    expect(
      calculateTaxLine(
        {
          unitPriceCentavos: 11_200,
          quantity: 1,
          taxClass: "VATABLE",
          scPwdEligible: true,
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
          scPwdEligible: true,
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
        scPwdEligible: true,
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
        scPwdEligible: false,
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

  it("rejects benefits on an ineligible line and rejects unapproved zero-rated items", () => {
    expect(() =>
      calculateTaxLine(
        {
          unitPriceCentavos: 1_000,
          quantity: 1,
          taxClass: "VAT_EXEMPT",
          scPwdEligible: false,
          benefit: "PWD",
          benefitApplied: true,
        },
        proposedPolicy,
      ),
    ).toThrow(new TaxCalculationError("product_not_benefit_eligible"));
    expect(() =>
      calculateTaxLine(
        {
          unitPriceCentavos: 1_000,
          quantity: 1,
          taxClass: "ZERO_RATED",
          scPwdEligible: false,
          benefit: "REGULAR",
          benefitApplied: false,
        },
        proposedPolicy,
      ),
    ).toThrow(new TaxCalculationError("zero_rated_not_approved"));
  });
});
