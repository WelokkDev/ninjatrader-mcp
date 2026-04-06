import Database, { type Database as DatabaseType } from "better-sqlite3";
import path from "path";
import { mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { initializeSchema } from "./schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataPath = process.env.NT_DATA_PATH
  ? path.resolve(process.env.NT_DATA_PATH)
  : path.join(__dirname, "..", "..", "data");

mkdirSync(dataPath, { recursive: true });

const dbPath = path.join(dataPath, "candles.db");
const db: DatabaseType = new Database(dbPath);

db.pragma("journal_mode = WAL");

initializeSchema(db);

export default db;
