import "../config.js";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { customerEncryptionKeyHex } from "../customer-data.js";
import { repositoryRoot, selectedEnvironment } from "../db.js";

const errors: string[] = [];

function pathInside(base: string, candidate: string): boolean {
  const relativePath = relative(resolve(base), resolve(candidate));
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`))
  );
}

function configuredPath(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) {
    errors.push(`${name} is required.`);
    return undefined;
  }
  if (!isAbsolute(value)) {
    errors.push(`${name} must be an absolute path.`);
    return undefined;
  }
  const normalized = resolve(value);
  if (
    pathInside(repositoryRoot, normalized) ||
    pathInside(normalized, repositoryRoot)
  )
    errors.push(`${name} must be outside the application repository.`);
  if (!existsSync(normalized) || !statSync(normalized).isDirectory())
    errors.push(`${name} must point to an existing directory.`);
  return normalized;
}

if (Number(process.versions.node.split(".")[0]) !== 24)
  errors.push(
    `Node.js 24 is required; current runtime is ${process.versions.node}.`,
  );
if (process.env.APP_ENV !== "live" || selectedEnvironment() !== "live")
  errors.push("APP_ENV must be explicitly set to live.");
if (process.env.NODE_ENV !== "production")
  errors.push("NODE_ENV must be production for live use.");
if (
  !(["127.0.0.1", "::1"] as string[]).includes(process.env.HOST ?? "127.0.0.1")
)
  errors.push("HOST must be loopback; Caddy is the HTTPS network entry point.");
if (process.env.COOKIE_SECURE === "false")
  errors.push("COOKIE_SECURE cannot be false for live use.");

const dataPath = configuredPath("MEDTRYX_DATA_DIR");
const primary = configuredPath("MEDTRYX_BACKUP_PRIMARY_DIR");
const secondary = configuredPath("MEDTRYX_BACKUP_SECONDARY_DIR");
if (
  dataPath &&
  (pathInside(repositoryRoot, dataPath) || pathInside(dataPath, repositoryRoot))
)
  errors.push("The live database and repository must remain separate.");
if (
  dataPath &&
  primary &&
  (pathInside(dataPath, primary) || pathInside(primary, dataPath))
)
  errors.push("The primary backup and database paths must be separate.");
if (
  dataPath &&
  secondary &&
  (pathInside(dataPath, secondary) || pathInside(secondary, dataPath))
)
  errors.push("The secondary backup and database paths must be separate.");
if (
  primary &&
  secondary &&
  (pathInside(primary, secondary) || pathInside(secondary, primary))
)
  errors.push("The backup destinations must use separate directories.");
if (primary && secondary && existsSync(primary) && existsSync(secondary)) {
  const primaryDevice = statSync(primary).dev;
  const secondaryDevice = statSync(secondary).dev;
  if (primaryDevice === secondaryDevice)
    errors.push(
      "The secondary backup directory must be on a separate storage device.",
    );
}

const keyPath = process.env.CUSTOMER_ID_ENCRYPTION_KEY_FILE?.trim();
if (!keyPath || !isAbsolute(keyPath) || pathInside(repositoryRoot, keyPath))
  errors.push(
    "CUSTOMER_ID_ENCRYPTION_KEY_FILE must be an absolute path outside the repository.",
  );
try {
  customerEncryptionKeyHex();
} catch {
  errors.push(
    "The customer data key file is missing or not a 32-byte hexadecimal key.",
  );
}

if (errors.length) {
  process.stderr.write(
    `Live preflight failed:\n${errors.map((error) => `- ${error}`).join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    "Live environment preflight passed. This check did not configure HTTPS, verify physical storage, or test client devices.\n",
  );
}
