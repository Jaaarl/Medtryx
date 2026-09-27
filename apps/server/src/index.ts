import "./config.js";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { openDatabase, selectedEnvironment } from "./db.js";

const db = openDatabase();
const app = createApp(db, { serveWeb: true });
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";
const server = createServer(app);

server.listen(port, host, () => {
  process.stdout.write(
    `Medtryx ${selectedEnvironment()} server listening on ${host}:${port}\n`,
  );
});

function shutdown(): void {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
