#!/usr/bin/env node
/**
 * Domain "tests" gate for the marketing-pipeline template.
 *
 * Asserts copy/<persona-id>/variant-1.md … variant-5.md all exist and are
 * non-empty. The persona id is read from $YOKE_ITEM_ID. Override the count
 * with --count <n> or the directory with --dir <path>.
 *
 * Exit codes:
 *   0  all variant files exist and are non-empty
 *   1  one or more files missing or empty
 *   4  argument / environment error
 */

import { existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const args = process.argv.slice(2);
let count = 5;
let dir = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--count") count = parseInt(args[++i], 10);
  else if (args[i] === "--dir") dir = args[++i];
  else if (args[i] === "--help" || args[i] === "-h") {
    console.log("Usage: node scripts/check-variants-nonempty.js [--count <n>] [--dir <path>]");
    process.exit(0);
  } else {
    console.error(`unknown argument: ${args[i]}`);
    process.exit(4);
  }
}

if (!dir) {
  const itemId = process.env.YOKE_ITEM_ID;
  if (!itemId) {
    console.error("no --dir flag and $YOKE_ITEM_ID is unset");
    process.exit(4);
  }
  dir = `copy/${itemId}`;
}

let missing = 0;
for (let i = 1; i <= count; i++) {
  const p = resolve(join(dir, `variant-${i}.md`));
  if (!existsSync(p)) {
    console.error(`missing: ${dir}/variant-${i}.md`);
    missing++;
    continue;
  }
  const size = statSync(p).size;
  if (size === 0) {
    console.error(`empty: ${dir}/variant-${i}.md`);
    missing++;
  }
}

if (missing > 0) {
  console.error(`${missing} of ${count} variant files missing or empty`);
  process.exit(1);
}

console.log(`OK ${count} variants in ${dir}`);
process.exit(0);
