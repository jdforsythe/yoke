#!/usr/bin/env node
/**
 * Verify assertions for scenario-b after workflow completes.
 *
 * Usage: verify-scenario-b.mjs <tmpdir> <workflowId>
 *
 * Exit 0 if all assertions pass; exit 1 if any fail.
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFIX = '[verify-b]';

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
  console.error(`Usage: verify-scenario-b.mjs <tmpdir> <workflowId>`);
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
// Assertion 2: at least 4 sessions (1 plan + 2 implement + 1 submit_pr)
// ---------------------------------------------------------------------------
const sessionCount = db.prepare('SELECT COUNT(*) AS cnt FROM sessions WHERE workflow_id = ?').get(workflowId);
assert(
  `sessions count >= 4 (got ${sessionCount.cnt})`,
  sessionCount.cnt >= 4,
  `only ${sessionCount.cnt} session(s) found`,
);

// ---------------------------------------------------------------------------
// Assertion 3: exactly 2 completed items
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
// Assertion 4: prepost_runs has >= 2 run-tests rows with exit_code = 0
// ---------------------------------------------------------------------------
const testRunCount = db.prepare(
  "SELECT COUNT(*) AS cnt FROM prepost_runs WHERE workflow_id = ? AND command_name = 'run-tests' AND exit_code = 0",
).get(workflowId);
assert(
  `prepost_runs has >= 2 run-tests rows with exit_code=0 (got ${testRunCount.cnt})`,
  testRunCount.cnt >= 2,
  `only ${testRunCount.cnt} passing run-tests prepost_runs found`,
);

// ---------------------------------------------------------------------------
// Assertion 5: no prepost_runs rows with command_name suggesting gh / git push
// ---------------------------------------------------------------------------
const ghRunCount = db.prepare(
  "SELECT COUNT(*) AS cnt FROM prepost_runs WHERE workflow_id = ? AND (command_name LIKE '%gh%' OR command_name LIKE '%git-push%' OR command_name = 'git push')",
).get(workflowId);
assert(
  `no prepost_runs rows with gh or git-push command_name (got ${ghRunCount.cnt})`,
  ghRunCount.cnt === 0,
  `found ${ghRunCount.cnt} suspicious prepost_runs row(s)`,
);

// ---------------------------------------------------------------------------
// Assertion 6: filesystem checks
// ---------------------------------------------------------------------------
const worktreePath = workflowRow.worktree_path;
if (!worktreePath) {
  fail('worktree_path is set', 'column is null/empty');
} else {
  // 6a. Seeded baseline must still be present (never deleted by the model).
  const seededFiles = ['package.json', 'index.js', 'test/smoke.test.js'];
  for (const rel of seededFiles) {
    const full = path.join(worktreePath, rel);
    assert(`seeded file preserved: ${rel}`, existsSync(full), `not found at ${full}`);
  }

  // 6b. Original greet test must still pass — assert the file still asserts
  // greet() === 'hello' (the model could have deleted/rewritten it).
  const smokeTestPath = path.join(worktreePath, 'test/smoke.test.js');
  if (existsSync(smokeTestPath)) {
    const smokeContent = readFileSync(smokeTestPath, 'utf8');
    assert(
      'seeded greet test still references greet()',
      /greet\s*\(\s*\)/.test(smokeContent) && /hello/.test(smokeContent),
      `smoke.test.js no longer asserts greet() === 'hello': ${smokeContent.slice(0, 200)}`,
    );
  }

  // 6c. New per-feature additions land in their own test files.
  const newFeatureFiles = ['test/farewell.test.js', 'test/shout.test.js'];
  for (const rel of newFeatureFiles) {
    const full = path.join(worktreePath, rel);
    assert(`new feature test file added: ${rel}`, existsSync(full), `not found at ${full}`);
  }

  // 6d. index.js must export every function (greet preserved + 2 new).
  const indexPath = path.join(worktreePath, 'index.js');
  if (existsSync(indexPath)) {
    const indexSrc = readFileSync(indexPath, 'utf8');
    for (const fn of ['greet', 'farewell', 'shout']) {
      assert(
        `index.js exports ${fn}`,
        new RegExp(`export\\s+function\\s+${fn}\\b`).test(indexSrc),
        `no export named '${fn}' found`,
      );
    }
  }

  // 6b. feature-b.json exists and is valid
  const featureBPath = path.join(worktreePath, 'docs/idea/feature-b.json');
  assert(
    'docs/idea/feature-b.json exists',
    existsSync(featureBPath),
    `not found at ${featureBPath}`,
  );

  if (existsSync(featureBPath)) {
    let featureBJson;
    try {
      featureBJson = JSON.parse(readFileSync(featureBPath, 'utf8'));
    } catch (err) {
      fail('docs/idea/feature-b.json parses as JSON', err.message);
      featureBJson = null;
    }

    if (featureBJson !== null) {
      const features = featureBJson?.features;
      assert(
        'feature-b.json has .features array',
        Array.isArray(features),
        `features is ${typeof features}`,
      );

      if (Array.isArray(features)) {
        assert(
          'feature-b.json .features.length === 2',
          features.length === 2,
          `length is ${features.length}`,
        );

        assert(
          'features[0].id = feat-b-001',
          features[0]?.id === 'feat-b-001',
          `got id=${features[0]?.id}`,
        );

        assert(
          'features[1].id = feat-b-002',
          features[1]?.id === 'feat-b-002',
          `got id=${features[1]?.id}`,
        );

        // Sanity: feat-b-002 should depend on feat-b-001 so the per-item
        // scheduler exercises depends_on gating.
        assert(
          'features[1].depends_on includes feat-b-001',
          Array.isArray(features[1]?.depends_on) &&
            features[1].depends_on.includes('feat-b-001'),
          `depends_on=${JSON.stringify(features[1]?.depends_on)}`,
        );
      }
    }
  }

  // 6c. artifacts/pr-summary.txt
  const prSummaryPath = path.join(worktreePath, 'artifacts/pr-summary.txt');
  assert(
    'artifacts/pr-summary.txt exists',
    existsSync(prSummaryPath),
    `not found at ${prSummaryPath}`,
  );

  if (existsSync(prSummaryPath)) {
    const prContents = readFileSync(prSummaryPath, 'utf8');
    const expectedPrefix = 'Pretend PR #1 created at https://example.invalid/pr/1';
    assert(
      `artifacts/pr-summary.txt starts with expected line`,
      prContents.startsWith(expectedPrefix),
      `content starts with: ${JSON.stringify(prContents.slice(0, 80))}`,
    );
  }
}

db.close();

// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------
process.exit(allPass ? 0 : 1);
