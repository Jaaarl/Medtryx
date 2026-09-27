import "../config.js";
import { openDatabase, selectedEnvironment } from "../db.js";

const db = openDatabase();
const rows = db
  .prepare("SELECT name FROM schema_migrations ORDER BY name")
  .all() as { name: string }[];
process.stdout.write(
  `Database migrations ready (${selectedEnvironment()}): ${rows.map((row) => row.name).join(", ")}\n`,
);
db.close();
