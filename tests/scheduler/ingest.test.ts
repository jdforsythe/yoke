/**
 * Unit tests for createWorkflow (src/server/scheduler/ingest.ts).
 *
 * Coverage:
 *   - Two back-to-back createWorkflow calls from the same template produce two
 *     distinct workflow rows with distinct UUIDs (no dedup / resume path)
 *   - User-supplied name is stored verbatim (no suffix appended)
 *   - template_name column is populated from config.template.name
 *   - pipeline JSON snapshot captures the full stages array
 *   - depends_on chaining across stages is preserved
 *   - github_state init: disabled (github.enabled=false)
 *   - github_state init: unconfigured (github.enabled=true, no remote URL)
 *   - github_state init: idle (github.enabled=true, valid remote URL parsed)
 *   - github_state init: unconfigured when deps omitted
 *   - github_state init: unconfigured when remote URL malformed
 *   - Full github config (pr_target_branch + auth_order) accepted without throw
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import type { DbPool } from '../../src/server/storage/db.js';
import { createWorkflow } from '../../src/server/scheduler/ingest.js';
import type { IngestDeps } from '../../src/server/scheduler/ingest.js';
import type { ResolvedConfig } from '../../src/shared/types/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../..', 'src/server/storage/migrations');

let tmpDir: string;
let db: DbPool;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-ingest-test-'));
  db = openDbPool(path.join(tmpDir, 'test.db'));
  applyMigrations(db.writer, MIGRATIONS_DIR);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(templateName = 'yoke', configDir?: string, extra?: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    version: '1',
    configDir: configDir ?? tmpDir,
    template: { name: templateName },
    pipeline: {
      stages: [
        { id: 'stage-one', run: 'once', phases: ['phase-a'] },
      ],
    },
    phases: {
      'phase-a': {
        command: 'claude',
        args: [],
        prompt_template: 'Do the thing.',
      },
    },
    ...extra,
  };
}

function getWorkflowRow(workflowId: string): {
  id: string;
  name: string;
  template_name: string | null;
  pipeline: string;
  github_state: string | null;
} {
  return db.reader()
    .prepare('SELECT id, name, template_name, pipeline, github_state FROM workflows WHERE id = ?')
    .get(workflowId) as {
      id: string;
      name: string;
      template_name: string | null;
      pipeline: string;
      github_state: string | null;
    };
}

// ---------------------------------------------------------------------------
// AC: always inserts — no dedup
// ---------------------------------------------------------------------------

describe('createWorkflow — always inserts a new row', () => {
  it('creates a distinct workflow row on each call with the same template', () => {
    const config = makeConfig('yoke');

    const first = createWorkflow(db, config, { name: 'my-run-1' });
    const second = createWorkflow(db, config, { name: 'my-run-2' });

    expect(first.workflowId).toBeTruthy();
    expect(second.workflowId).toBeTruthy();
    expect(first.workflowId).not.toBe(second.workflowId);

    const firstRow = getWorkflowRow(first.workflowId);
    const secondRow = getWorkflowRow(second.workflowId);

    expect(firstRow).toBeDefined();
    expect(secondRow).toBeDefined();
  });

  it('two calls from the same template with the same name produce two distinct rows', () => {
    const config = makeConfig('yoke');

    const first = createWorkflow(db, config, { name: 'duplicate-name' });
    const second = createWorkflow(db, config, { name: 'duplicate-name' });

    expect(first.workflowId).not.toBe(second.workflowId);

    const allRows = db.reader()
      .prepare('SELECT id FROM workflows WHERE name = ?')
      .all('duplicate-name') as { id: string }[];

    // Both rows must exist — no dedup removes the second insert.
    expect(allRows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// AC: name stored verbatim, template_name populated
// ---------------------------------------------------------------------------

describe('createWorkflow — name and template_name columns', () => {
  it('stores user-supplied name verbatim (no suffix appended)', () => {
    const config = makeConfig('my-template');
    const { workflowId } = createWorkflow(db, config, { name: 'my-feature-run' });
    const row = getWorkflowRow(workflowId);

    expect(row.name).toBe('my-feature-run');
  });

  it('populates template_name from config.template.name', () => {
    const config = makeConfig('awesome-template');
    const { workflowId } = createWorkflow(db, config, { name: 'run-1' });
    const row = getWorkflowRow(workflowId);

    expect(row.template_name).toBe('awesome-template');
  });

  it('pipeline snapshot captures the full stages array', () => {
    const config = makeConfig('yoke', undefined, {
      pipeline: {
        stages: [
          { id: 's1', run: 'once', phases: ['phase-a'] },
          { id: 's2', run: 'once', phases: ['phase-a'] },
        ],
      },
    });
    const { workflowId } = createWorkflow(db, config, { name: 'snapshot-test' });
    const row = getWorkflowRow(workflowId);
    const pipeline = JSON.parse(row.pipeline) as { stages: { id: string }[] };

    expect(pipeline.stages).toHaveLength(2);
    expect(pipeline.stages[0].id).toBe('s1');
    expect(pipeline.stages[1].id).toBe('s2');
  });

  it('chains depends_on across stages (stage N+1 depends on stage N item)', () => {
    const config = makeConfig('yoke', undefined, {
      pipeline: {
        stages: [
          { id: 's1', run: 'once', phases: ['phase-a'] },
          { id: 's2', run: 'once', phases: ['phase-a'] },
        ],
      },
    });
    const { workflowId } = createWorkflow(db, config, { name: 'chain-test' });
    const items = db.reader()
      .prepare('SELECT id, stage_id, depends_on FROM items WHERE workflow_id = ? ORDER BY rowid')
      .all(workflowId) as { id: string; stage_id: string; depends_on: string | null }[];

    expect(items).toHaveLength(2);
    expect(items[0].depends_on).toBeNull();
    const deps = JSON.parse(items[1].depends_on!);
    expect(deps).toEqual([items[0].id]);
  });
});

// ---------------------------------------------------------------------------
// github_state init paths
// ---------------------------------------------------------------------------

describe('createWorkflow — github_state initialisation', () => {
  it('sets github_state=disabled when github.enabled=false', () => {
    const config = makeConfig('yoke', undefined, {
      github: { enabled: false, auto_pr: true },
    });
    const deps: IngestDeps = { getRemoteOriginUrl: () => 'git@github.com:owner/repo.git' };

    const { workflowId } = createWorkflow(db, config, { name: 'run' }, deps);
    const row = getWorkflowRow(workflowId);

    expect(row.github_state).toBe('disabled');
  });

  it('sets github_state=unconfigured when github.enabled=true but no remote URL', () => {
    const config = makeConfig('yoke', undefined, {
      github: { enabled: true, auto_pr: true },
    });
    const deps: IngestDeps = { getRemoteOriginUrl: () => null };

    const { workflowId } = createWorkflow(db, config, { name: 'run' }, deps);
    const row = getWorkflowRow(workflowId);

    expect(row.github_state).toBe('unconfigured');
  });

  it('sets github_state=unconfigured when deps not provided', () => {
    const config = makeConfig('yoke', undefined, {
      github: { enabled: true, auto_pr: true },
    });

    const { workflowId } = createWorkflow(db, config, { name: 'run' });
    const row = getWorkflowRow(workflowId);

    expect(row.github_state).toBe('unconfigured');
  });

  it('sets github_state=idle when github.enabled=true and remote URL is valid', () => {
    const config = makeConfig('yoke', undefined, {
      github: { enabled: true, auto_pr: true },
    });
    const deps: IngestDeps = { getRemoteOriginUrl: () => 'git@github.com:owner/repo.git' };

    const { workflowId } = createWorkflow(db, config, { name: 'run' }, deps);
    const row = getWorkflowRow(workflowId);

    expect(row.github_state).toBe('idle');
  });

  it('sets github_state=unconfigured when remote URL is malformed (never throws)', () => {
    const config = makeConfig('yoke', undefined, {
      github: { enabled: true, auto_pr: true },
    });
    const deps: IngestDeps = { getRemoteOriginUrl: () => 'not-a-valid-git-url' };

    const { workflowId } = createWorkflow(db, config, { name: 'run' }, deps);
    const row = getWorkflowRow(workflowId);

    expect(row.github_state).toBe('unconfigured');
  });

  it('accepts full github config with pr_target_branch and auth_order (no throw)', () => {
    const config = makeConfig('yoke', undefined, {
      github: {
        enabled: true,
        auto_pr: true,
        pr_target_branch: 'master',
        auth_order: ['env:GITHUB_TOKEN', 'gh:auth:token'],
      },
    });
    const deps: IngestDeps = { getRemoteOriginUrl: () => 'git@github.com:owner/repo.git' };

    expect(() => createWorkflow(db, config, { name: 'run-1' }, deps)).not.toThrow();
    // Second call — no dedup, a second row is created without throwing.
    expect(() => createWorkflow(db, config, { name: 'run-2' }, deps)).not.toThrow();
  });
});
