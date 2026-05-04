#!/usr/bin/env node
/**
 * Verify assertions for scenario-a after workflow completes.
 *
 * Usage: verify-scenario-a.mjs <tmpdir> <workflowId>
 *
 * Exit 0 if all assertions pass; exit 1 if any fail.
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFIX = '[verify-a]';

// ---------------------------------------------------------------------------
// Locate repo root (walk up from this file until we find package.json with "name":"yoke")
// ---------------------------------------------------------------------------
function findRepoRoot() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
        if (pkg.name === '@jdforsythe/yoke') return dir;
      } catch {
        // ignore parse errors and keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Could not find yoke repo root (no package.json with name=yoke)');
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Load better-sqlite3 from repo node_modules
// ---------------------------------------------------------------------------
const REPO_ROOT = findRepoRoot();
const require = createRequire(import.meta.url);
const Database = require(path.join(REPO_ROOT, 'node_modules', 'better-sqlite3'));

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const [, , tmpdir, workflowId] = process.argv;
if (!tmpdir || !workflowId) {
  console.error(`Usage: verify-scenario-a.mjs <tmpdir> <workflowId>`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Assertion runner
// ---------------------------------------------------------------------------
let allPass = true;

function pass(label) {
  console.log(`${PREFIX} OK: ${label}`);
}

function fail(label, reason) {
  console.error(`${PREFIX} FAIL: ${label}: ${reason}`);
  allPass = false;
}

function assert(label, condition, reason) {
  if (condition) {
    pass(label);
  } else {
    fail(label, reason);
  }
}

// ---------------------------------------------------------------------------
// Open database
// ---------------------------------------------------------------------------
const dbPath = path.join(tmpdir, '.yoke', 'yoke.db');
if (!existsSync(dbPath)) {
  fail('database exists', `file not found: ${dbPath}`);
  process.exit(1);
}

let db;
try {
  db = new Database(dbPath, { readonly: true });
} catch (err) {
  fail('database open', err.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Assertion 1: workflow status = completed
// ---------------------------------------------------------------------------
const workflowRow = db.prepare('SELECT status, worktree_path FROM workflows WHERE id = ?').get(workflowId);
if (!workflowRow) {
  fail('workflow row exists', `no row with id=${workflowId}`);
  process.exit(1);
}
assert(
  `workflow status = completed`,
  workflowRow.status === 'completed',
  `got status=${workflowRow.status}`,
);

// ---------------------------------------------------------------------------
// Assertion 2: at least 3 sessions for this workflow
// ---------------------------------------------------------------------------
const sessionCount = db.prepare('SELECT COUNT(*) AS cnt FROM sessions WHERE workflow_id = ?').get(workflowId);
assert(
  `sessions count >= 3 (got ${sessionCount.cnt})`,
  sessionCount.cnt >= 3,
  `only ${sessionCount.cnt} session(s) found`,
);

// ---------------------------------------------------------------------------
// Assertion 3: exactly 2 items in the per-item build stage with status=complete.
// (The once-stage planner also gets a synthetic items row with stable_id NULL;
// we filter that out here.)
// ---------------------------------------------------------------------------
const itemCount = db.prepare(
  "SELECT COUNT(*) AS cnt FROM items WHERE workflow_id = ? AND stage_id = 'build' AND stable_id IS NOT NULL AND status = 'complete'",
).get(workflowId);
assert(
  `completed per-item rows in build stage = 2 (got ${itemCount.cnt})`,
  itemCount.cnt === 2,
  `expected 2, got ${itemCount.cnt}`,
);

// ---------------------------------------------------------------------------
// Assertion 4: filesystem paths exist in worktree
// ---------------------------------------------------------------------------
const worktreePath = workflowRow.worktree_path;
if (!worktreePath) {
  fail('worktree_path is set', 'column is null/empty');
} else {
  const requiredPaths = [
    'package.json',
    'index.js',
    'test/index.test.js',
    'docs/idea/features.json',
  ];
  for (const rel of requiredPaths) {
    const full = path.join(worktreePath, rel);
    assert(`worktree file exists: ${rel}`, existsSync(full), `not found at ${full}`);
  }

  // ---------------------------------------------------------------------------
  // Assertion 5: features.json contents
  // ---------------------------------------------------------------------------
  const featuresPath = path.join(worktreePath, 'docs/idea/features.json');
  if (existsSync(featuresPath)) {
    let featuresJson;
    try {
      featuresJson = JSON.parse(readFileSync(featuresPath, 'utf8'));
    } catch (err) {
      fail('docs/idea/features.json parses as JSON', err.message);
      featuresJson = null;
    }

    if (featuresJson !== null) {
      const features = featuresJson?.features;
      assert(
        'features.json has .features array',
        Array.isArray(features),
        `features is ${typeof features}`,
      );

      if (Array.isArray(features)) {
        assert(
          'features.json .features.length === 2',
          features.length === 2,
          `length is ${features.length}`,
        );

        assert(
          'features[0].id = feat-001',
          features[0]?.id === 'feat-001',
          `got id=${features[0]?.id}`,
        );

        assert(
          'features[1].id = feat-002',
          features[1]?.id === 'feat-002',
          `got id=${features[1]?.id}`,
        );
      }
    }
  } else {
    fail('docs/idea/features.json exists for content checks', `not found at ${featuresPath}`);
  }
}

db.close();

// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------
process.exit(allPass ? 0 : 1);
