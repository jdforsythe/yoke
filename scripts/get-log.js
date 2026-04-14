#!/usr/bin/env node
/**
 * Print the session_log_path of the most recent session from .yoke/yoke.db.
 *
 * Optional env filters:
 *   FEATURE=<stage_id>      restrict to a specific feature stage
 *   PHASE=implement|review  restrict to a specific phase
 */

import Database from "better-sqlite3";
import { join } from "path";
import { existsSync } from "fs";

const dbPath = join(process.cwd(), ".yoke", "yoke.db");
if (!existsSync(dbPath)) {
  process.stderr.write(`No DB at ${dbPath}\n`);
  process.exit(1);
}

const feature = process.env.FEATURE ?? "";
const phase   = process.env.PHASE ?? "";

let where = "session_log_path IS NOT NULL";
const params = [];
if (feature) { where += " AND stage = ?";  params.push(feature); }
if (phase)   { where += " AND phase = ?";  params.push(phase);   }

const db  = new Database(dbPath, { readonly: true });
const row = db
  .prepare(`SELECT session_log_path FROM sessions WHERE ${where} ORDER BY started_at DESC LIMIT 1`)
  .get(...params);

if (!row?.session_log_path) {
  const desc = [feature ? ` for ${feature}` : "", phase ? ` phase=${phase}` : ""].join("");
  process.stderr.write(`No session logs found${desc}\n`);
  process.exit(1);
}

process.stdout.write(row.session_log_path);
