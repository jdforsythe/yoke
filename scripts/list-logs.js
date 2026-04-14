#!/usr/bin/env node
/**
 * Print all session logs from .yoke/yoke.db, newest first.
 */

import Database from "better-sqlite3";
import { join } from "path";
import { existsSync } from "fs";

const dbPath = join(process.cwd(), ".yoke", "yoke.db");
if (!existsSync(dbPath)) {
  process.stderr.write(`No DB at ${dbPath}\n`);
  process.exit(1);
}

const db   = new Database(dbPath, { readonly: true });
const rows = db
  .prepare(
    `SELECT started_at, stage, phase, status, session_log_path
     FROM sessions WHERE session_log_path IS NOT NULL
     ORDER BY started_at DESC LIMIT 30`
  )
  .all();

if (!rows.length) {
  console.log("No session logs in DB");
  process.exit(0);
}

for (const { started_at, stage, phase, status, session_log_path } of rows) {
  console.log(
    `${started_at}  ${(stage ?? "").padEnd(35)} ${(phase ?? "").padEnd(12)} ${(status ?? "").padEnd(12)} ${session_log_path}`
  );
}
