import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backupRoot = mkdtempSync(join(tmpdir(), "medtryx-e2e-backups-"));
const primaryBackupPath = join(backupRoot, "primary");
const secondaryBackupPath = join(backupRoot, "secondary");
mkdirSync(primaryBackupPath);
mkdirSync(secondaryBackupPath);
mkdirSync(join(primaryBackupPath, "test"));
mkdirSync(join(secondaryBackupPath, "test"));
const testEnvironment = {
  ...process.env,
  APP_ENV: "test",
  COOKIE_SECURE: "false",
  HOST: "127.0.0.1",
  PORT: "3001",
  E2E_EXTERNAL_SERVERS: "1",
  CUSTOMER_ID_ENCRYPTION_KEY: "c3".repeat(32),
  MEDTRYX_BACKUP_PRIMARY_DIR: primaryBackupPath,
  MEDTRYX_BACKUP_SECONDARY_DIR: secondaryBackupPath,
};
const running = [];

function launch(label, scriptPath, args, cwd) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd,
    env: testEnvironment,
    stdio: "inherit",
    windowsHide: true,
  });
  child.on("error", (error) => {
    process.stderr.write(`${label} failed to start: ${error.message}\n`);
  });
  running.push({ label, child });
  return child;
}

async function waitForService(label, child, url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`${label} stopped before becoming ready.`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The child is still starting; retry briefly before reporting a startup failure.
    }
    await delay(250);
  }
  throw new Error(`${label} did not become ready at ${url}.`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    delay(4_000).then(() => false),
  ]);
  if (graceful) return;
  child.kill("SIGKILL");
  await Promise.race([exited, delay(1_000)]);
}

let resultCode = 1;
try {
  const health = await fetch("http://127.0.0.1:3001/api/health").catch(
    () => undefined,
  );
  const vite = await fetch("http://127.0.0.1:5173/").catch(() => undefined);
  if (health?.ok || vite?.ok) {
    throw new Error(
      "Stop existing Medtryx processes on ports 3001 and 5173 before running browser tests.",
    );
  }

  const server = launch(
    "API server",
    resolve(root, "apps/server/dist/index.js"),
    [],
    root,
  );
  const web = launch(
    "Vite server",
    resolve(root, "node_modules/vite/bin/vite.js"),
    ["--host", "127.0.0.1"],
    resolve(root, "apps/web"),
  );
  await Promise.all([
    waitForService("API server", server, "http://127.0.0.1:3001/api/health"),
    waitForService("Vite server", web, "http://127.0.0.1:5173/"),
  ]);

  const playwright = launch(
    "Playwright",
    resolve(root, "node_modules/@playwright/test/cli.js"),
    ["test", ...process.argv.slice(2)],
    root,
  );
  resultCode = await new Promise((resolveExit, reject) => {
    playwright.once("error", reject);
    playwright.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Playwright exited after ${signal}.`));
      else resolveExit(code ?? 1);
    });
  });
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "End-to-end test startup failed."}\n`,
  );
} finally {
  await Promise.all(running.map(({ child }) => stop(child)));
  rmSync(backupRoot, { recursive: true, force: true });
}

process.exitCode = Number(resultCode);
