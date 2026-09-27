import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ENVELOPE_VERSION = "v1";

export class CustomerDataError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function encryptionKey(): Buffer {
  const configured = process.env.CUSTOMER_ID_ENCRYPTION_KEY;
  if (!configured || !/^[a-f0-9]{64}$/i.test(configured)) {
    throw new CustomerDataError("customer_encryption_unavailable");
  }
  return Buffer.from(configured, "hex");
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
    encryptionKey(),
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
