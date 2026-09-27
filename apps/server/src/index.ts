import "./config.js";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { openDatabase, selectedEnvironment } from "./db.js";
import {
  assertLiveBackupConfiguration,
  createAutomaticBackupIfDue,
} from "./backup-service.js";

const db = openDatabase();
if (selectedEnvironment() === "live") {
  assertLiveBackupConfiguration();
  if (
    !(["127.0.0.1", "::1"] as string[]).includes(
      process.env.HOST ?? "127.0.0.1",
    )
  )
    throw new Error(
      "Live Express must bind to loopback behind the HTTPS proxy.",
    );
  if (process.env.COOKIE_SECURE === "false")
    throw new Error(
      "Secure cookies cannot be disabled in the live environment.",
    );
}
const app = createApp(db, { serveWeb: true });
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";
const server = createServer(app);

server.listen(port, host, () => {
  process.stdout.write(
    `Medtryx ${selectedEnvironment()} server listening on ${host}:${port}\n`,
  );
});

if (selectedEnvironment() === "live") {
  const automaticBackupTimer = setInterval(
    () => {
      void createAutomaticBackupIfDue(db).catch((error: unknown) => {
        const code =
          error instanceof Error && "code" in error
            ? String(error.code)
            : "automatic_backup_failed";
        process.stderr.write(`Medtryx backup warning: ${code}\n`);
      });
    },
    60 * 60 * 1000,
  );
  automaticBackupTimer.unref();
  void createAutomaticBackupIfDue(db).catch((error: unknown) => {
    const code =
      error instanceof Error && "code" in error
        ? String(error.code)
        : "automatic_backup_failed";
    process.stderr.write(`Medtryx backup warning: ${code}\n`);
  });
}

function shutdown(): void {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
