#!/usr/bin/env node
/**
 * Post-review gate: reads review-verdict.json from the worktree root.
 *
 * Exit 0  — verdict is PASS; continue to next stage.
 * Exit 1  — verdict is FAIL, file is absent, or file is malformed.
 *
 * The review agent is expected to write review-verdict.json before exiting.
 * If the file is absent or malformed, the gate fails (exit 1) so a
 * re-implement fires rather than silently promoting broken work.
 */

import { readFileSync, existsSync } from "fs";

const VERDICT_PATH = "review-verdict.json";

if (!existsSync(VERDICT_PATH)) {
  console.error(
    `ERROR: ${VERDICT_PATH} was not written by the review session.\n` +
    "The review prompt requires writing this file with " +
    '{"verdict": "PASS"} or {"verdict": "FAIL", "blocking_issues": [...]}.'
  );
  process.exit(1);
}

let data;
try {
  data = JSON.parse(readFileSync(VERDICT_PATH, "utf8"));
} catch (err) {
  console.error(`ERROR: ${VERDICT_PATH} is not valid JSON: ${err.message}`);
  process.exit(1);
}

const verdict = data.verdict ?? "";

if (verdict === "PASS") {
  console.log("Review verdict: PASS — feature complete.");
  process.exit(0);
}

const issues = Array.isArray(data.blocking_issues) ? data.blocking_issues : [];
console.error(`Review verdict: ${verdict || "FAIL"} — ${issues.length} blocking issue(s):`);
for (const issue of issues) {
  console.error(`  • ${issue}`);
}
process.exit(1);
