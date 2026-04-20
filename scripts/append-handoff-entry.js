#!/usr/bin/env node
/**
 * Safe handoff.json append helper.
 *
 * Reads a single JSON entry from stdin, parses and validates the current
 * handoff.json (creating it with an empty entries array if absent), pushes
 * the new entry onto entries[], validates the full document against
 * docs/design/schemas/handoff.schema.json, and writes it back atomically
 * (temp file + rename).
 *
 * Agents should call this instead of editing handoff.json directly — any
 * off-by-one bracket produced by a free-form edit poisons the file for all
 * future sessions (the prompt-assembly JSON.parse throws and the scheduler
 * routes the item to awaiting_user).
 *
 * Usage:
 *   echo '{"phase":"implement","attempt":1,"session_id":"...","ts":"..."}' \
 *     | node scripts/append-handoff-entry.js [--item-id <id>] [--path handoff.json]
 *
 * Flags:
 *   --item-id <id>   item_id to set if handoff.json does not yet exist.
 *                    Ignored if the file already exists with an item_id.
 *                    Defaults to $YOKE_ITEM_ID.
 *   --path <file>    handoff file path (default: ./handoff.json).
 *
 * Exit codes:
 *   0  entry appended and written
 *   1  input JSON could not be parsed
 *   2  existing handoff.json is syntactically invalid
 *   3  resulting document fails schema validation
 *   4  other I/O / argument error
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, "../docs/design/schemas/handoff.schema.json");

// ---- args --------------------------------------------------------------
const args = process.argv.slice(2);
let handoffPath = "handoff.json";
let itemId = process.env.YOKE_ITEM_ID ?? "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--path") handoffPath = args[++i];
  else if (args[i] === "--item-id") itemId = args[++i];
  else if (args[i] === "--help" || args[i] === "-h") {
    console.log("Usage: echo '<entry-json>' | node scripts/append-handoff-entry.js [--item-id <id>] [--path <file>]");
    process.exit(0);
  } else {
    console.error(`unknown argument: ${args[i]}`);
    process.exit(4);
  }
}

// ---- read stdin --------------------------------------------------------
const stdinBuf = readFileSync(0, "utf8").trim();
if (!stdinBuf) {
  console.error("no entry provided on stdin — pipe a single JSON object describing the entry.");
  process.exit(1);
}

let entry;
try {
  entry = JSON.parse(stdinBuf);
} catch (err) {
  console.error(`input is not valid JSON: ${err.message}`);
  process.exit(1);
}
if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
  console.error("input must be a JSON object, not an array or primitive.");
  process.exit(1);
}

// ---- read + parse existing handoff.json --------------------------------
let doc;
if (existsSync(handoffPath)) {
  const raw = readFileSync(handoffPath, "utf8");
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    console.error(`${handoffPath} is not valid JSON (refusing to overwrite): ${err.message}`);
    console.error("fix or delete the file, then re-run.");
    process.exit(2);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    console.error(`${handoffPath} is not a JSON object (refusing to overwrite).`);
    process.exit(2);
  }
} else {
  if (!itemId) {
    console.error("handoff.json does not exist and no --item-id flag / $YOKE_ITEM_ID was provided.");
    process.exit(4);
  }
  doc = { item_id: itemId, entries: [] };
}

if (!Array.isArray(doc.entries)) doc.entries = [];
doc.entries.push(entry);

// ---- schema validate ---------------------------------------------------
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);
if (!validate(doc)) {
  console.error("resulting handoff.json fails schema validation:");
  for (const e of validate.errors ?? []) {
    console.error(`  ${e.instancePath || "(root)"}: ${e.message}`);
  }
  process.exit(3);
}

// ---- atomic write ------------------------------------------------------
const tmp = `${handoffPath}.tmp`;
writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
renameSync(tmp, handoffPath);
console.log(`appended entry to ${handoffPath} (${doc.entries.length} total).`);
