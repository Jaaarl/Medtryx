import type { AppConfig } from "@medtryx/shared";

export type CurrencyConfig = AppConfig;

let currentConfig: CurrencyConfig | undefined;
let integerFormatter: Intl.NumberFormat | undefined;
let decimalSeparator = ".";

export function setCurrencyConfig(config: CurrencyConfig): void {
  currentConfig = config;
  integerFormatter = new Intl.NumberFormat(config.locale, {
    maximumFractionDigits: 0,
  });
  decimalSeparator =
    new Intl.NumberFormat(config.locale, { minimumFractionDigits: 1 })
      .formatToParts(1.1)
      .find((part) => part.type === "decimal")?.value ?? ".";
}

function config(): CurrencyConfig {
  if (!currentConfig) throw new Error("Currency settings are not loaded.");
  return currentConfig;
}

export function currencyCode(): CurrencyConfig["currency"] {
  return config().currency;
}

export function currencySymbol(): CurrencyConfig["currencySymbol"] {
  return config().currencySymbol;
}

export function usesPhpRegionalPolicies(): boolean {
  return config().currency === "PHP";
}

function decimalParts(value: string): {
  negative: boolean;
  whole: bigint;
  cents: bigint;
} {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/u.exec(value.trim());
  if (!match) throw new TypeError("Invalid currency amount.");

  const sign = match[1] ?? "";
  const wholeText = match[2];
  const fraction = match[3] ?? "";
  if (wholeText === undefined) throw new TypeError("Invalid currency amount.");
  let whole = BigInt(wholeText);
  let cents = BigInt((fraction.slice(0, 2) + "00").slice(0, 2));
  if (fraction[2] && fraction[2] >= "5") cents += 1n;
  if (cents === 100n) {
    whole += 1n;
    cents = 0n;
  }
  return { negative: sign === "-", whole, cents };
}

function formatParts(negative: boolean, whole: bigint, cents: bigint): string {
  const { currencySymbol: symbol } = config();
  if (!integerFormatter) throw new Error("Currency settings are not loaded.");
  const sign = negative && (whole !== 0n || cents !== 0n) ? "−" : "";
  return `${sign}${symbol}${integerFormatter.format(whole)}${decimalSeparator}${String(cents).padStart(2, "0")}`;
}

export function formatCurrency(value: string | number): string {
  if (typeof value === "number" && !Number.isFinite(value))
    throw new TypeError("Invalid currency amount.");
  const parts = decimalParts(String(value));
  return formatParts(parts.negative, parts.whole, parts.cents);
}

export function formatCents(value: bigint | number): string {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new TypeError("Invalid cent amount.");
  const cents = typeof value === "bigint" ? value : BigInt(value);
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return formatParts(negative, absolute / 100n, absolute % 100n);
}
