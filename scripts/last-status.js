#!/usr/bin/env node
/**
 * last-status.js — print PASS/FAIL verdict for a session log.
 *
 * Reads the final result line from a .jsonl session log and evaluates:
 *   - exit subtype (must be "success")
 *   - is_error flag
 *   - count of ": FAIL" occurrences in the result text
 *   - presence of a non-empty "Blocking Issues" section
 *
 * Usage: node scripts/last-status.js <path/to/session.jsonl>
 *
 * Exit 0 — PASS
 * Exit 1 — FAIL or error reading the file
 */

import { readFileSync } from "fs";

const logPath = process.argv[2];
if (!logPath) {
  process.stderr.write("Usage: node scripts/last-status.js <path/to/session.jsonl>\n");
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

const subtype  = obj.subtype ?? "";
const is_error = obj.is_error ?? false;
const result   = obj.result ?? "";
const terminal = obj.terminal_reason ?? "";

const failCount = (result.match(/: FAIL/g) ?? []).length;
const blockingSection = result.includes("Blocking Issues")
  ? result.split("Blocking Issues").pop().split("###")[0]
  : "";
const blocking = result.includes("Blocking Issues") && !blockingSection.includes("None");

const verdict = (subtype !== "success" || is_error || failCount > 0 || blocking) ? "FAIL" : "PASS";

console.log(`Session : ${obj.session_id ?? "?"}`);
console.log(`Exit    : ${subtype} / terminal=${terminal} / is_error=${is_error}`);
console.log(`Turns   : ${obj.num_turns ?? "?"}  Cost: $${(obj.total_cost_usd ?? 0).toFixed(4)}`);
console.log(`Criteria: ${failCount} FAIL(s)  Blocking: ${blocking ? "YES" : "none"}`);
console.log(``);
console.log(`Verdict : ${verdict}`);

process.exit(verdict === "PASS" ? 0 : 1);
