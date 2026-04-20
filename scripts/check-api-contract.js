#!/usr/bin/env node
/**
 * API contract check — boots a real Yoke server on a random port, fetches
 * every documented HTTP endpoint, and validates each response against the
 * JSON Schema in docs/design/schemas/api-responses.schema.json.
 *
 * Exit 0  — all endpoint shapes match.
 * Exit 1  — one or more shapes drifted, or the server failed to start.
 *
 * Run via: pnpm test:contract  (which invokes: tsx scripts/check-api-contract.js)
 *
 * The script must be run with `tsx` (not plain `node`) so that the TypeScript
 * sources under src/ can be imported directly without a prior build step.
 *
 * Endpoints validated:
 *   GET /api/workflows
 *   GET /api/workflows/:id/timeline
 *   GET /api/workflows/:id/usage
 *   GET /api/workflows/:id/usage/timeseries
 *   GET /api/workflows/:id/items/:itemId/data
 *   GET /api/items/:id/sessions
 *   GET /api/sessions/:id/log
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { startServer } from '../src/cli/start.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '../docs/design/schemas/api-responses.schema.json');

// Minimal .yoke.yml accepted by loadConfig — prompt_template is never read
// because noScheduler:true skips all agent runs.
const MINIMAL_CONFIG = `version: "1"
project:
  name: contract-test
pipeline:
  stages:
    - id: stage-1
      run: once
      phases:
        - implement
phases:
  implement:
    command: echo
    args: []
    prompt_template: prompt.md
`;

// ---------------------------------------------------------------------------
// Module-level state for cleanup (shared by main + signal handlers)
// ---------------------------------------------------------------------------

/** @type {Awaited<ReturnType<typeof startServer>> | null} */
let handle = null;
/** @type {string | null} */
let tempDir = null;
let cleanupDone = false;

async function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  if (handle) {
    try { await handle.close(); } catch { /* best-effort */ }
    handle = null;
  }
  if (tempDir) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    tempDir = null;
  }
}

process.on('SIGINT', async () => { await cleanup(); process.exit(130); });
process.on('SIGTERM', async () => { await cleanup(); process.exit(143); });

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a URL and return parsed JSON. Throws on network error or unexpected
 * HTTP status (2xx expected; 4xx/5xx are test seeding errors, not shape drift).
 */
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${url} → HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

/**
 * Validate `data` against `validator`. Returns a result object.
 * @param {string} label
 * @param {unknown} data
 * @param {import('ajv').ValidateFunction} validator
 */
function check(label, data, validator) {
  const valid = validator(data);
  return valid
    ? { ok: true, label }
    : { ok: false, label, errors: validator.errors ?? [] };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // ── Schema + validators ───────────────────────────────────────────────────
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  ajv.addSchema(schema);

  const ref = (name) => ajv.compile({ '$ref': `${schema.$id}#/$defs/${name}` });
  const validators = {
    WorkflowsList: ref('WorkflowsListResponse'),
    Timeline:      ref('TimelineResponse'),
    Usage:         ref('UsageResponse'),
    Timeseries:    ref('TimeseriesResponse'),
    ItemSessions:  ref('ItemSessionsResponse'),
    SessionLog:    ref('SessionLogResponse'),
  };

  // ── Temp directory + config ───────────────────────────────────────────────
  tempDir = path.join(os.tmpdir(), `yoke-contract-${randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const configPath = path.join(tempDir, '.yoke.yml');
  fs.writeFileSync(configPath, MINIMAL_CONFIG, 'utf8');

  // ── Boot server ───────────────────────────────────────────────────────────
  console.log('Starting server…');
  handle = await startServer({
    configPath,
    port: 0,            // OS-assigned port — no collision risk
    noScheduler: true,  // no items advance; pure read/schema test
    _gitCheck: async () => {},
  });
  console.log(`Server up at ${handle.url}`);

  // ── Seed minimal data ─────────────────────────────────────────────────────
  const wfId     = randomUUID();
  const itemId   = randomUUID();
  const sessionId = randomUUID();
  const now = new Date().toISOString().slice(0, 19);
  const db = handle.db.writer;

  db.prepare(
    `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(wfId, 'contract-test', 'spec', '[]', '{}', 'pending', now, now);

  db.prepare(
    `INSERT INTO items (id, workflow_id, stage_id, data, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(itemId, wfId, 'stage-1', '{"contractKey":"contractValue"}', 'pending', now);

  db.prepare(
    `INSERT INTO sessions (id, workflow_id, item_id, stage, phase, agent_profile, started_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, wfId, itemId, 'stage-1', 'implement', 'default', now, 'ok');

  const base = handle.url;
  const results = [];

  // ── GET /api/workflows ────────────────────────────────────────────────────
  {
    const data = await fetchJson(`${base}/api/workflows`);
    results.push(check('GET /api/workflows', data, validators.WorkflowsList));
  }

  // ── GET /api/workflows/:id/timeline ──────────────────────────────────────
  {
    const data = await fetchJson(`${base}/api/workflows/${wfId}/timeline`);
    results.push(check('GET /api/workflows/:id/timeline', data, validators.Timeline));
  }

  // ── GET /api/workflows/:id/usage ─────────────────────────────────────────
  {
    const data = await fetchJson(`${base}/api/workflows/${wfId}/usage`);
    results.push(check('GET /api/workflows/:id/usage', data, validators.Usage));
  }

  // ── GET /api/workflows/:id/usage/timeseries ───────────────────────────────
  {
    const data = await fetchJson(`${base}/api/workflows/${wfId}/usage/timeseries`);
    results.push(check('GET /api/workflows/:id/usage/timeseries', data, validators.Timeseries));
  }

  // ── GET /api/workflows/:id/items/:itemId/data ─────────────────────────────
  // Opaque JSON — just verify it is parseable and the endpoint returns 200.
  {
    const res = await fetch(`${base}/api/workflows/${wfId}/items/${itemId}/data`);
    if (!res.ok) {
      results.push({
        ok: false,
        label: 'GET /api/workflows/:id/items/:itemId/data',
        errors: [{ instancePath: '', message: `HTTP ${res.status}` }],
      });
    } else {
      await res.json(); // verify parseable
      results.push({ ok: true, label: 'GET /api/workflows/:id/items/:itemId/data' });
    }
  }

  // ── GET /api/items/:id/sessions ───────────────────────────────────────────
  {
    const data = await fetchJson(`${base}/api/items/${itemId}/sessions`);
    results.push(check('GET /api/items/:id/sessions', data, validators.ItemSessions));
  }

  // ── GET /api/sessions/:id/log ─────────────────────────────────────────────
  {
    const data = await fetchJson(`${base}/api/sessions/${sessionId}/log`);
    results.push(check('GET /api/sessions/:id/log', data, validators.SessionLog));
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  const passed = results.filter((r) => r.ok);

  console.log('');
  for (const { label, errors } of failed) {
    console.error(`FAIL ${label}`);
    for (const err of errors ?? []) {
      const loc = err.instancePath || '(root)';
      console.error(`     • ${loc}: ${err.message}`);
    }
  }
  if (passed.length > 0) {
    for (const { label } of passed) {
      console.log(`OK   ${label}`);
    }
  }
  console.log(`\n${passed.length}/${results.length} endpoint(s) passed contract validation`);

  return failed.length === 0 ? 0 : 1;
}

main()
  .then(async (code) => {
    await cleanup();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('\nContract check failed with unexpected error:');
    console.error(err);
    await cleanup();
    process.exit(1);
  });
