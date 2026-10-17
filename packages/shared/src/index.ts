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

export type UserRole = z.infer<typeof userRoleSchema>;
export type User = z.infer<typeof userSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;

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
