#!/usr/bin/env node
/**
 * Post-review gate: marks a feature complete in a feature manifest JSON file.
 *
 * Contract:
 *   - Caller passes the manifest path as the first CLI argument.
 *   - Script reads review-verdict.json written by the review agent.
 *   - If verdict is PASS, sets status:"complete" on the matching entry in the
 *     features manifest so that a future workflow re-run skips this feature.
 *
 * Usage:
 *   node scripts/mark-feature-complete.js <path/to/features.json>
 *
 * Exit 0 always — failures are logged but non-blocking so the pipeline
 * continues regardless. The pipeline tracks completion state in SQLite;
 * the features JSON is updated for re-run convenience only.
 *
 * Called as a post-command in the review phase (after check-verdict).
 * CWD is the worktree root.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

const VERDICT_PATH = "review-verdict.json";
const FEATURES_PATH = process.argv[2];
if (!FEATURES_PATH) {
  console.error("Usage: node scripts/mark-feature-complete.js <path/to/features.json>");
  process.exit(0); // non-blocking — preserve existing exit-0 contract
}

// --- read verdict -----------------------------------------------------------

if (!existsSync(VERDICT_PATH)) {
  console.log(`[mark-feature-complete] ${VERDICT_PATH} not found, skipping.`);
  process.exit(0);
}

let verdict;
try {
  verdict = JSON.parse(readFileSync(VERDICT_PATH, "utf8"));
} catch (err) {
  console.error(`[mark-feature-complete] Could not parse ${VERDICT_PATH}: ${err.message}`);
  process.exit(0);
}

if (verdict.verdict !== "PASS") {
  console.log(`[mark-feature-complete] Verdict is ${verdict.verdict || "unknown"}, skipping.`);
  process.exit(0);
}

const featureId = verdict.feature_id;
if (!featureId || typeof featureId !== "string") {
  console.error(`[mark-feature-complete] review-verdict.json missing feature_id field.`);
  process.exit(0);
}

// --- update features manifest -----------------------------------------------

if (!existsSync(FEATURES_PATH)) {
  console.error(`[mark-feature-complete] ${FEATURES_PATH} not found, skipping.`);
  process.exit(0);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(FEATURES_PATH, "utf8"));
} catch (err) {
  console.error(`[mark-feature-complete] Could not parse ${FEATURES_PATH}: ${err.message}`);
  process.exit(0);
}

const features = Array.isArray(manifest.features) ? manifest.features : [];
const feature = features.find((f) => f.id === featureId);

if (!feature) {
  console.error(`[mark-feature-complete] Feature "${featureId}" not found in ${FEATURES_PATH}.`);
  process.exit(0);
}

if (feature.status === "complete") {
  console.log(`[mark-feature-complete] Feature "${featureId}" already marked complete.`);
  process.exit(0);
}

feature.status = "complete";

try {
  writeFileSync(FEATURES_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`[mark-feature-complete] Marked "${featureId}" as complete in ${FEATURES_PATH}.`);
} catch (err) {
  console.error(`[mark-feature-complete] Could not write ${FEATURES_PATH}: ${err.message}`);
}

process.exit(0);
