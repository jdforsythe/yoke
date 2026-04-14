#!/usr/bin/env node
/**
 * last-output.js — print the result text from a session log.
 *
 * Reads the final result line from a .jsonl session log and prints
 * the "result" field (the agent's full output text).
 *
 * Usage: node scripts/last-output.js <path/to/session.jsonl>
 */

import { readFileSync } from "fs";

const logPath = process.argv[2];
if (!logPath) {
  process.stderr.write("Usage: node scripts/last-output.js <path/to/session.jsonl>\n");
  process.exit(1);
}

let obj;
try {
  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  obj = JSON.parse(lines[lines.length - 1]);
} catch (err) {
  process.stderr.write(`ERROR: could not read/parse ${logPath}: ${err.message}\n`);
  process.exit(1);
}

console.log(obj.result ?? "(no result field)");
