#!/usr/bin/env node
/**
 * Post-planner gate: validates a features.json file against
 * docs/design/schemas/features.schema.json using Ajv (draft 2020-12).
 *
 * Usage: node scripts/check-features-json.js <path/to/features.json>
 *
 * Exit 0  — file exists, valid JSON, passes schema, needs_more_planning is falsy.
 * Exit 1  — file missing, invalid JSON, or schema validation failed.
 * Exit 2  — file is valid but needs_more_planning: true (route back to planner).
 *
 * On any non-zero exit the .yoke.yml action grammar loops back to the planner phase.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, "../docs/design/schemas/features.schema.json");

const targetPath = process.argv[2];

if (!targetPath) {
  console.error("Usage: node scripts/check-features-json.js <path/to/features.json>");
  process.exit(1);
}

const resolvedTarget = resolve(targetPath);

// --- existence check ---
if (!existsSync(resolvedTarget)) {
  console.error(
    `ERROR: ${targetPath} was not written by the planner session.\n` +
    "The planner prompt requires writing this file before stopping."
  );
  process.exit(1);
}

// --- JSON parse ---
let data;
try {
  data = JSON.parse(readFileSync(resolvedTarget, "utf8"));
} catch (err) {
  console.error(`ERROR: ${targetPath} is not valid JSON: ${err.message}`);
  process.exit(1);
}

// --- needs_more_planning flag ---
if (data.needs_more_planning === true) {
  console.error(
    `INFO: ${targetPath} has needs_more_planning:true — routing back to planner.`
  );
  process.exit(2);
}

// --- schema validation ---
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

if (!validate(data)) {
  console.error(`ERROR: ${targetPath} failed schema validation:`);
  for (const err of validate.errors ?? []) {
    console.error(`  • ${err.instancePath || "(root)"} ${err.message}`);
  }
  process.exit(1);
}

const count = Array.isArray(data.features) ? data.features.length : 0;
console.log(`OK: ${targetPath} is valid (${count} feature(s)).`);
process.exit(0);
