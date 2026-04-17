/**
 * Unit tests for ingestWorkflow (src/server/scheduler/ingest.ts).
 *
 * Coverage:
 *   - Fresh ingest creates name as `${projectName}-${workflowId.slice(0,8)}`
 *   - Two consecutive fresh ingests against the same project produce distinct names
 *   - Resume path (live workflow exists) returns the same workflowId without
 *     changing the name (stable suffix for the lifetime of a workflow)
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

function makeConfig(projectName = 'yoke', configDir?: string): ResolvedConfig {
  return {
    version: '1',
    configDir: configDir ?? tmpDir,
    project: { name: projectName },
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
  };
}

function getWorkflowRow(workflowId: string): { id: string; name: string } {
  return db.reader()
    .prepare('SELECT id, name FROM workflows WHERE id = ?')
    .get(workflowId) as { id: string; name: string };
}

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
