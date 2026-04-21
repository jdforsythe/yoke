/**
 * Unit tests for ingestWorkflow (src/server/scheduler/ingest.ts).
 *
 * Coverage:
 *   - Fresh ingest creates name as `${projectName}-${workflowId.slice(0,8)}`
 *   - Two consecutive fresh ingests against the same project produce distinct names
 *   - Resume path (live workflow exists) returns the same workflowId without
 *     changing the name (stable suffix for the lifetime of a workflow)
 *   - github_state init: disabled (github.enabled=false)
 *   - github_state init: unconfigured (github.enabled=true, no remote URL)
 *   - github_state init: idle (github.enabled=true, valid remote URL parsed)
 *   - Resume path does not re-call initGithubState (github_state preserved)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import type { DbPool } from '../../src/server/storage/db.js';
import { ingestWorkflow } from '../../src/server/scheduler/ingest.js';
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

function makeConfig(projectName = 'yoke', configDir?: string, extra?: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    version: '1',
    configDir: configDir ?? tmpDir,
    template: { name: projectName },
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

function getWorkflowRow(workflowId: string): { id: string; name: string; github_state: string | null } {
  return db.reader()
    .prepare('SELECT id, name, github_state FROM workflows WHERE id = ?')
    .get(workflowId) as { id: string; name: string; github_state: string | null };
}

// ---------------------------------------------------------------------------
// Existing name-suffix tests (unchanged behaviour)
// ---------------------------------------------------------------------------

describe('ingestWorkflow — name suffix', () => {
  it('formats name as ${projectName}-${first8charsOfUUID}', () => {
    const config = makeConfig('yoke');
    const { workflowId } = ingestWorkflow(db, config);
    const row = getWorkflowRow(workflowId);

    expect(row.name).toMatch(/^yoke-[0-9a-f]{8}$/);
    expect(row.name).toBe(`yoke-${workflowId.slice(0, 8)}`);
  });

  it('produces distinct names for two consecutive fresh ingests', () => {
    const config = makeConfig('yoke');

    // First ingest creates a new workflow.
    const first = ingestWorkflow(db, config);
    expect(first.isResume).toBe(false);

    // Move the first workflow to a terminal state so the second is fresh too.
    db.writer
      .prepare("UPDATE workflows SET status = 'completed' WHERE id = ?")
      .run(first.workflowId);

    // Second ingest creates another new workflow.
    const second = ingestWorkflow(db, config);
    expect(second.isResume).toBe(false);
    expect(second.workflowId).not.toBe(first.workflowId);

    const firstRow = getWorkflowRow(first.workflowId);
    const secondRow = getWorkflowRow(second.workflowId);

    expect(firstRow.name).not.toBe(secondRow.name);
    expect(firstRow.name).toBe(`yoke-${first.workflowId.slice(0, 8)}`);
    expect(secondRow.name).toBe(`yoke-${second.workflowId.slice(0, 8)}`);
  });

  it('resume path returns same workflowId and does not change the name', () => {
    const config = makeConfig('yoke');

    const { workflowId: originalId } = ingestWorkflow(db, config);
    const originalRow = getWorkflowRow(originalId);

    // Second call against the same live workflow should resume.
    const { workflowId: resumedId, isResume } = ingestWorkflow(db, config);

    expect(isResume).toBe(true);
    expect(resumedId).toBe(originalId);

    const resumedRow = getWorkflowRow(resumedId);
    expect(resumedRow.name).toBe(originalRow.name);
  });
});

// ---------------------------------------------------------------------------
// github_state init paths (AC: all three paths covered)
// ---------------------------------------------------------------------------

describe('ingestWorkflow — github_state initialisation', () => {
  it('sets github_state=disabled when github.enabled=false', () => {
    const config = makeConfig('yoke', undefined, {
      github: { enabled: false, auto_pr: true },
    });
    // Even with a valid remote URL, disabled flag wins.
    const deps: IngestDeps = { getRemoteOriginUrl: () => 'git@github.com:owner/repo.git' };

    const { workflowId } = ingestWorkflow(db, config, deps);
    const row = getWorkflowRow(workflowId);

    expect(row.github_state).toBe('disabled');
  });

  it('sets github_state=unconfigured when github.enabled=true but no remote URL', () => {
    const config = makeConfig('yoke', undefined, {
      github: { enabled: true, auto_pr: true },
    });
    // getRemoteOriginUrl returns null — git remote not configured.
    const deps: IngestDeps = { getRemoteOriginUrl: () => null };

    const { workflowId } = ingestWorkflow(db, config, deps);
    const row = getWorkflowRow(workflowId);

    expect(row.github_state).toBe('unconfigured');
  });

  it('sets github_state=unconfigured when deps not provided (no git helper)', () => {
    const config = makeConfig('yoke', undefined, {
      github: { enabled: true, auto_pr: true },
    });
    // No deps passed — falls back to hasOwnerRepo=false → unconfigured.
    const { workflowId } = ingestWorkflow(db, config);
    const row = getWorkflowRow(workflowId);

    expect(row.github_state).toBe('unconfigured');
  });

  it('sets github_state=idle when github.enabled=true and remote URL is valid', () => {
    const config = makeConfig('yoke', undefined, {
      github: { enabled: true, auto_pr: true },
    });
    const deps: IngestDeps = { getRemoteOriginUrl: () => 'git@github.com:owner/repo.git' };

    const { workflowId } = ingestWorkflow(db, config, deps);
    const row = getWorkflowRow(workflowId);

    expect(row.github_state).toBe('idle');
  });

  it('sets github_state=unconfigured when remote URL is malformed (never throws)', () => {
    const config = makeConfig('yoke', undefined, {
      github: { enabled: true, auto_pr: true },
    });
    // Malformed URL — parseGitRemoteUrl returns null → hasOwnerRepo=false.
    const deps: IngestDeps = { getRemoteOriginUrl: () => 'not-a-valid-git-url' };

    const { workflowId } = ingestWorkflow(db, config, deps);
    const row = getWorkflowRow(workflowId);

    expect(row.github_state).toBe('unconfigured');
  });

  it('resume path does not re-call initGithubState (github_state preserved)', () => {
    const config = makeConfig('yoke', undefined, {
      github: { enabled: true, auto_pr: true },
    });
    const deps: IngestDeps = { getRemoteOriginUrl: () => 'git@github.com:owner/repo.git' };

    // Fresh ingest → github_state = 'idle'
    const { workflowId } = ingestWorkflow(db, config, deps);
    expect(getWorkflowRow(workflowId).github_state).toBe('idle');

    // Manually set github_state to 'creating' to simulate mid-run state.
    db.writer
      .prepare("UPDATE workflows SET github_state = 'creating' WHERE id = ?")
      .run(workflowId);
    expect(getWorkflowRow(workflowId).github_state).toBe('creating');

    // Second ingest (resume) must NOT reset github_state.
    const { isResume } = ingestWorkflow(db, config, deps);
    expect(isResume).toBe(true);
    expect(getWorkflowRow(workflowId).github_state).toBe('creating');
  });

  it('accepts full github config with pr_target_branch and auth_order (no throw)', () => {
    // Mirrors the github section in .yoke.yml and .yoke-round-3.yml verbatim.
    const config = makeConfig('yoke', undefined, {
      github: {
        enabled: true,
        auto_pr: true,
        pr_target_branch: 'master',
        auth_order: ['env:GITHUB_TOKEN', 'gh:auth:token'],
      },
    });
    const deps: IngestDeps = { getRemoteOriginUrl: () => 'git@github.com:owner/repo.git' };

    expect(() => ingestWorkflow(db, config, deps)).not.toThrow();

    const { workflowId } = ingestWorkflow(db, config);
    // The first call created a live workflow; second call resumes — both are fine.
    expect(workflowId).toBeTruthy();
  });
});
