import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENVELOPE_VERSION = "v1";

export class CustomerDataError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function customerEncryptionKeyHex(): string {
  const keyFile = process.env.CUSTOMER_ID_ENCRYPTION_KEY_FILE;
  let configured = process.env.CUSTOMER_ID_ENCRYPTION_KEY;
  if (keyFile) {
    try {
      configured = readFileSync(resolve(keyFile), "utf8").trim();
    } catch {
      throw new CustomerDataError("customer_encryption_unavailable");
    }
  }
  if (!configured || !/^[a-f0-9]{64}$/i.test(configured)) {
    throw new CustomerDataError("customer_encryption_unavailable");
  }
  return configured.toLowerCase();
}

function encryptionKey(): Buffer {
  return Buffer.from(customerEncryptionKeyHex(), "hex");
}

function normalizedLookupName(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase();
}

export function customerLookupDigest(name: string, birthday: string): string {
  return customerLookupDigestWithKey(name, birthday, encryptionKey());
}

export function customerLookupDigestWithKey(
  name: string,
  birthday: string,
  key: Buffer | string,
): string {
  const keyBytes = typeof key === "string" ? Buffer.from(key, "hex") : key;
  return createHmac("sha256", keyBytes)
    .update(
      `medtryx/customer-lookup/v1\0${normalizedLookupName(name)}\0${birthday}`,
      "utf8",
    )
    .digest("hex");
}

function additionalData(context: string): Buffer {
  return Buffer.from(`medtryx/customer-data/${ENVELOPE_VERSION}/${context}`);
}

export function encryptCustomerField(value: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(additionalData(context));
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    ENVELOPE_VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptCustomerField(
  envelope: string,
  context: string,
): string {
  return decryptCustomerFieldWithKey(envelope, context, encryptionKey());
}

export function decryptCustomerFieldWithKey(
  envelope: string,
  context: string,
  key: Buffer | string,
): string {
  const [version, encodedIv, encodedTag, encodedValue, extra] =
    envelope.split(".");
  if (
    version !== ENVELOPE_VERSION ||
    !encodedIv ||
    !encodedTag ||
    encodedValue === undefined ||
    extra !== undefined
  ) {
    throw new CustomerDataError("customer_ciphertext_invalid");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    typeof key === "string" ? Buffer.from(key, "hex") : key,
    Buffer.from(encodedIv, "base64url"),
  );
  decipher.setAAD(additionalData(context));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(encodedValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new CustomerDataError("customer_ciphertext_invalid");
  }
}
