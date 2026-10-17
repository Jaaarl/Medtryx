import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { appConfigForCurrency, appConfigSchema } from "@medtryx/shared";
import { api } from "./api";
import { setCurrencyConfig, type CurrencyConfig } from "./currency";

type LoadState = "loading" | "failed" | "ready";

export function CurrencyBootstrap({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LoadState>("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void api
      .get<unknown>("/config")
      .then((response) => {
        const result = appConfigSchema.safeParse(response);
        if (!result.success) {
          throw new Error("The server returned invalid currency settings.");
        }
        const config: CurrencyConfig = result.data;
        const expected = appConfigForCurrency(config.currency);
        if (
          config.currencySymbol !== expected.currencySymbol ||
          config.locale !== expected.locale ||
          config.businessTimeZone !== expected.businessTimeZone
        )
          throw new Error("The server returned invalid currency settings.");
        if (active) {
          setCurrencyConfig(config);
          setState("ready");
        }
      })
      .catch(() => {
        if (active) setState("failed");
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  if (state === "failed") {
    return (
      <main className="config-error-screen" role="alert">
        <section className="config-error-card">
          <h1>Store settings unavailable</h1>
          <p>
            Medtryx could not load this store&apos;s currency settings. Check
            the connection and retry before continuing.
          </p>
          <button
            className="button button-primary"
            type="button"
            onClick={() => {
              setState("loading");
              setAttempt((value) => value + 1);
            }}
          >
            Retry
          </button>
        </section>
      </main>
    );
  }

  if (state !== "ready")
    return <div className="loading-screen">Loading store settings…</div>;

  return children;
}
