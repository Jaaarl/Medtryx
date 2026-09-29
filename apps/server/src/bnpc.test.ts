import { afterEach, describe, expect, it } from "vitest";
import { bnpcHolderKey, manilaWeekStart, parseBnpcMoney } from "./bnpc.js";

describe("BNPC identity and Manila weekly calendar", () => {
  const originalKey = process.env.CUSTOMER_ID_ENCRYPTION_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.CUSTOMER_ID_ENCRYPTION_KEY;
    } else {
      process.env.CUSTOMER_ID_ENCRYPTION_KEY = originalKey;
    }
  });

  it("uses Monday-based Asia/Manila calendar weeks across month and year boundaries", () => {
    expect(manilaWeekStart("2026-09-28")).toBe("2026-09-28");
    expect(manilaWeekStart("2026-10-04")).toBe("2026-09-28");
    expect(manilaWeekStart("2026-10-05")).toBe("2026-10-05");
    expect(manilaWeekStart("2027-01-01")).toBe("2026-12-28");
  });

  it("creates a keyed, normalized digest instead of storing a plaintext identifier", () => {
    process.env.CUSTOMER_ID_ENCRYPTION_KEY = "c7".repeat(32);
    const canonical = bnpcHolderKey("AB-123 456");
    expect(canonical).toMatch(/^[a-f0-9]{64}$/u);
    expect(canonical).toBe(bnpcHolderKey(" ab123456 "));
    expect(canonical).not.toContain("AB-123 456");
    process.env.CUSTOMER_ID_ENCRYPTION_KEY = "d8".repeat(32);
    expect(bnpcHolderKey("AB-123 456")).not.toBe(canonical);
  });

  it("parses centavo-exact amounts and rejects unsafe input", () => {
    expect(parseBnpcMoney("2500.00")).toBe(250_000);
    expect(parseBnpcMoney("0.05")).toBe(5);
    expect(() => parseBnpcMoney("-1.00")).toThrow("invalid_bnpc_amount");
  });
});
