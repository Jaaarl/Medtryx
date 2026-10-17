import { z } from "zod";

export const currencyCodeSchema = z.enum(["PHP", "USD"]);
export type CurrencyCode = z.infer<typeof currencyCodeSchema>;

export const appConfigSchema = z
  .object({
    currency: currencyCodeSchema,
    currencySymbol: z.enum(["₱", "$"]),
    locale: z.enum(["en-PH", "en-US"]),
    businessTimeZone: z.literal("Asia/Manila"),
  })
  .strict();

export type AppConfig = z.infer<typeof appConfigSchema>;

export function appConfigForCurrency(currency: CurrencyCode): AppConfig {
  return {
    currency,
    currencySymbol: currency === "PHP" ? "₱" : "$",
    locale: currency === "PHP" ? "en-PH" : "en-US",
    businessTimeZone: "Asia/Manila",
  };
}
