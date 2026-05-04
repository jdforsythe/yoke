#!/usr/bin/env node
/**
 * Post-phase gate: validates handoff.json against
 * schemas/handoff.schema.json using Ajv (draft 2020-12).
 *
 * Exit 0  — file absent (not required every phase) or valid.
 * Exit 1  — file present but invalid JSON or fails schema.
 *
 * Both exit codes map to "continue" in .yoke.yml — this is a warning-only
 * check. A malformed handoff should not block the feature from completing,
 * but the error is printed so it's visible in session logs.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, "../schemas/handoff.schema.json");
const HANDOFF_PATH = "handoff.json";

// Absent is fine — not every phase writes a handoff entry.
if (!existsSync(HANDOFF_PATH)) {
  process.exit(0);
}

let data;
try {
  data = JSON.parse(readFileSync(HANDOFF_PATH, "utf8"));
} catch (err) {
  console.error(`WARN: ${HANDOFF_PATH} is not valid JSON: ${err.message}`);
  process.exit(1);
}

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

if (!validate(data)) {
  console.error(`WARN: ${HANDOFF_PATH} failed schema validation:`);
  for (const err of validate.errors ?? []) {
    console.error(`  • ${err.instancePath || "(root)"} ${err.message}`);
  }
  process.exit(1);
}

const count = Array.isArray(data.entries) ? data.entries.length : 0;
console.log(`OK: ${HANDOFF_PATH} is valid (${count} entr${count === 1 ? "y" : "ies"}).`);
process.exit(0);
