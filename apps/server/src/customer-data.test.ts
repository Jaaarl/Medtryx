import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CustomerDataError,
  decryptCustomerField,
  encryptCustomerField,
} from "./customer-data.js";

const priorKey = process.env.CUSTOMER_ID_ENCRYPTION_KEY;

beforeAll(() => {
  process.env.CUSTOMER_ID_ENCRYPTION_KEY = "a1".repeat(32);
});

afterAll(() => {
  if (priorKey === undefined) delete process.env.CUSTOMER_ID_ENCRYPTION_KEY;
  else process.env.CUSTOMER_ID_ENCRYPTION_KEY = priorKey;
});

describe("customer identity encryption", () => {
  it("encrypts values with a random AES-GCM nonce and the matching field context", () => {
    const first = encryptCustomerField("Synthetic Person", "sale-1/name");
    const second = encryptCustomerField("Synthetic Person", "sale-1/name");
    expect(first).not.toBe(second);
    expect(first).not.toContain("Synthetic Person");
    expect(decryptCustomerField(first, "sale-1/name")).toBe("Synthetic Person");
    expect(() => decryptCustomerField(first, "sale-1/id-number")).toThrow(
      new CustomerDataError("customer_ciphertext_invalid"),
    );
  });

  it("fails closed when the encryption key is missing or malformed", () => {
    process.env.CUSTOMER_ID_ENCRYPTION_KEY = "not-a-key";
    expect(() => encryptCustomerField("Synthetic ID", "sale-1/id")).toThrow(
      new CustomerDataError("customer_encryption_unavailable"),
    );
  });
});
