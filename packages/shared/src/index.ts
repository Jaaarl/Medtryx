import { z } from "zod";
export * from "./activity.js";

export { calculateRefundTotal, prorateCentavos } from "./refunds.js";

export const userRoleSchema = z.enum(["owner", "cashier"]);

export const userSchema = z.object({
  id: z.string().uuid(),
  email: z.email(),
  username: z.string().nullable(),
  role: userRoleSchema,
  isActive: z.boolean(),
  createdAt: z.iso.datetime(),
});

export const createUserSchema = z
  .object({
    email: z.email().max(254),
    username: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9._-]+$/)
      .optional(),
    password: z.string().min(8).max(128),
    role: userRoleSchema,
  })
  .strict();

export const monthlyIncentiveTierSchema = z
  .object({
    salesTargetCentavos: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    incentiveCentavos: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  })
  .strict();

export const monthlyIncentiveSettingSchema = z
  .object({
    enabled: z.boolean(),
    tiers: z.array(monthlyIncentiveTierSchema).min(1).max(12),
  })
  .strict()
  .superRefine((setting, context) => {
    for (let index = 1; index < setting.tiers.length; index += 1) {
      if (
        setting.tiers[index]!.salesTargetCentavos <=
        setting.tiers[index - 1]!.salesTargetCentavos
      ) {
        context.addIssue({
          code: "custom",
          message: "Monthly incentive sales targets must increase.",
          path: ["tiers", index, "salesTargetCentavos"],
        });
      }
      if (
        setting.tiers[index]!.incentiveCentavos <
        setting.tiers[index - 1]!.incentiveCentavos
      ) {
        context.addIssue({
          code: "custom",
          message: "Monthly incentive amounts cannot decrease at higher tiers.",
          path: ["tiers", index, "incentiveCentavos"],
        });
      }
    }
  });

export type MonthlyIncentiveTier = z.infer<typeof monthlyIncentiveTierSchema>;
export type MonthlyIncentiveSetting = z.infer<
  typeof monthlyIncentiveSettingSchema
>;

export const defaultMonthlyIncentiveSetting: MonthlyIncentiveSetting = {
  enabled: false,
  tiers: [
    {
      salesTargetCentavos: 25_000_000,
      incentiveCentavos: 5_000,
      color: "#25875A",
    },
    {
      salesTargetCentavos: 50_000_000,
      incentiveCentavos: 10_000,
      color: "#2878B8",
    },
  ],
};

export type UserRole = z.infer<typeof userRoleSchema>;
export type User = z.infer<typeof userSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;

export type CashRefundSource = "CURRENT" | "ORIGINAL";
export type CashRefundShift = {
  id: string;
  cashierUserId: string;
  cashierEmail: string;
  cashierUsername: string | null;
  openedAt: string;
  closedAt: string | null;
  expectedCash: string;
};
export type RefundSourceOptions = {
  transactionId: string;
  currentShift: CashRefundShift | null;
  originalShift: CashRefundShift | null;
  ownerApprovalAllowed: boolean;
};

export type ExpenseCategory = "LUNCH" | "DELIVERY" | "OTHER" | "STOCK_PURCHASE";
export type ExpensePaymentSource = "CASHIER" | "OWNER";

export type ExpenseEntry = {
  id: string;
  businessDate: string;
  category: ExpenseCategory;
  amount: string;
  productAmount: string;
  deliveryFee: string;
  supplier: string;
  invoiceReference: string;
  description: string;
  paymentSource: ExpensePaymentSource;
  includedInUnitCost: boolean;
  operatingExpense: string;
  recordedByEmail: string;
  cashierEmail: string | null;
  shiftId: string | null;
  createdAt: string;
};

export type ExpenseTotals = {
  paymentCount: number;
  totalPayments: string;
  operatingExpenses: string;
  cashierPaid: string;
  ownerPaid: string;
  includedInUnitCost: string;
  stockPurchasePayments: string;
  stockProductPayments: string;
  stockDeliveryFees: string;
  cashierPaidStockPurchases: string;
  ownerPaidStockPurchases: string;
  lunch: string;
  delivery: string;
  other: string;
};
