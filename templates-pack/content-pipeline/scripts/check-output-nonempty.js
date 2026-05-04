#!/usr/bin/env node
/**
 * Domain "tests" gate for the content-pipeline template.
 *
 * Asserts that the chapter file produced by the draft phase exists and is
 * non-empty. The file path is derived from the item id in $YOKE_ITEM_ID,
 * defaulting to chapters/<item-id>.md.
 *
 * Override the path with --path <file>.
 *
 * Exit codes:
 *   0  file exists and is non-empty
 *   1  file is missing or empty
 *   4  argument / environment error
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
let outPath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--path") outPath = args[++i];
  else if (args[i] === "--help" || args[i] === "-h") {
    console.log("Usage: node scripts/check-output-nonempty.js [--path <file>]");
    process.exit(0);
  } else {
    console.error(`unknown argument: ${args[i]}`);
    process.exit(4);
  }
}

if (!outPath) {
  const itemId = process.env.YOKE_ITEM_ID;
  if (!itemId) {
    console.error("no --path flag and $YOKE_ITEM_ID is unset");
    process.exit(4);
  }
  outPath = `chapters/${itemId}.md`;
}

const abs = resolve(outPath);
if (!existsSync(abs)) {
  console.error(`expected output file does not exist: ${outPath}`);
  process.exit(1);
}

const size = statSync(abs).size;
if (size === 0) {
  console.error(`output file is empty: ${outPath}`);
  process.exit(1);
}

console.log(`OK ${outPath} (${size} bytes)`);
process.exit(0);
