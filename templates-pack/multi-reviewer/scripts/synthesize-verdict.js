#!/usr/bin/env node
/**
 * Multi-angle verdict synthesizer.
 *
 * Reads verdict files from three reviewer angles, computes the overall
 * PASS/FAIL, and writes review-verdict.json at the worktree root.
 *
 * Usage:
 *   node scripts/synthesize-verdict.js [item-id]
 *
 * Falls back to $YOKE_ITEM_ID if item-id is not passed as an argument.
 *
 * Expects:
 *   reviews/<item-id>/correctness.json
 *   reviews/<item-id>/security.json
 *   reviews/<item-id>/simplicity.json
 *
 * Exit 0  — all three angles passed; review-verdict.json written with PASS.
 * Exit 1  — one or more angles failed; review-verdict.json written with FAIL.
 * Exit 2  — one or more verdict files are missing or not valid JSON.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

const itemId = process.argv[2] || process.env.YOKE_ITEM_ID;

if (!itemId) {
  console.error(
    "Usage: node scripts/synthesize-verdict.js <item-id>\n" +
    "Or set $YOKE_ITEM_ID in the environment."
  );
  process.exit(2);
}

const ANGLES = ["correctness", "security", "simplicity"];
const results = [];
let anyMissing = false;

for (const angle of ANGLES) {
  const path = `reviews/${itemId}/${angle}.json`;

  if (!existsSync(path)) {
    console.error(`ERROR: missing verdict file: ${path}`);
    anyMissing = true;
    continue;
  }

  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`ERROR: ${path} is not valid JSON: ${err.message}`);
    anyMissing = true;
    continue;
  }

  if (!data.verdict || !["pass", "fail"].includes(data.verdict)) {
    console.error(
      `ERROR: ${path} has invalid or missing "verdict" field ` +
      `(got ${JSON.stringify(data.verdict)}). Expected "pass" or "fail".`
    );
    anyMissing = true;
    continue;
  }

  results.push({ angle, data });
}

if (anyMissing) {
  console.error(
    "\nOne or more verdict files are missing or malformed. " +
    "Re-run the review phase to regenerate them."
  );
  process.exit(2);
}

// Separate passing from failing angles
const failing = results.filter(r => r.data.verdict === "fail");
const passing = results.filter(r => r.data.verdict === "pass");
const allPassed = failing.length === 0;

// Collect blocking issues from every failing angle
const blockingIssues = [];
for (const { angle, data } of failing) {
  const acFails = (data.acceptance_criteria_verdicts ?? [])
    .filter(c => c.pass === false)
    .map(c => `[${angle}/AC] ${c.criterion}${c.notes ? ": " + c.notes : ""}`);

  const rcFails = (data.review_criteria_verdicts ?? [])
    .filter(c => c.pass === false)
    .map(c => `[${angle}/RC] ${c.criterion}${c.notes ? ": " + c.notes : ""}`);

  const highSeverity = (data.additional_issues ?? [])
    .filter(i => ["high", "critical"].includes(i.severity))
    .map(i => `[${angle}/${i.severity}] ${i.description}`);

  blockingIssues.push(...acFails, ...rcFails, ...highSeverity);

  // Fall back to a generic message when no criteria were individually failed
  if (acFails.length === 0 && rcFails.length === 0 && highSeverity.length === 0) {
    blockingIssues.push(
      `[${angle}] Reviewer returned FAIL — see reviews/${itemId}/${angle}.json for details`
    );
  }
}

// Build the summary line shown in the dashboard / logs
const summaryParts = results.map(r => {
  const label = r.data.verdict === "pass" ? "PASS" : "FAIL";
  return `${r.angle}: ${label}${r.data.notes ? " — " + r.data.notes : ""}`;
});
const summaryLine = summaryParts.join(" | ");

// Write review-verdict.json
const verdict = allPassed
  ? { verdict: "PASS", notes: summaryLine }
  : {
      verdict: "FAIL",
      blocking_issues: blockingIssues,
      notes: summaryLine,
    };

writeFileSync(
  "review-verdict.json",
  JSON.stringify(verdict, null, 2) + "\n",
  "utf8"
);

if (allPassed) {
  console.log(`All ${ANGLES.length} reviewers passed.`);
  for (const { angle, data } of passing) {
    console.log(`  ✓ ${angle}${data.notes ? ": " + data.notes : ""}`);
  }
  process.exit(0);
} else {
  console.error(
    `Review FAIL: ${failing.map(f => f.angle).join(", ")} ` +
    `reviewer(s) failed (${blockingIssues.length} blocking issue(s)).`
  );
  for (const issue of blockingIssues.slice(0, 15)) {
    console.error(`  • ${issue}`);
  }
  if (blockingIssues.length > 15) {
    console.error(`  … and ${blockingIssues.length - 15} more — see review-verdict.json`);
  }
  process.exit(1);
}
