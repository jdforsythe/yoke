/**
 * POST /api/workflows/:id/github/create-pr — API layer tests.
 *
 * Uses real Fastify + real SQLite with an injected fake CreatePrExecutorFn
 * so no live GitHub API calls are made.
 *
 * Covers:
 *   AC-1  200 happy path
 *   AC-1  404 unknown workflow
 *   AC-1  409 non-terminal workflow status
 *   AC-1  409 github_state already created (different commandId)
 *   AC-1  409 github_state creating in progress (different commandId)
 *   AC-1  Idempotent replay — same commandId returns cached body byte-for-byte
 *   AC-4  Double-click with different commandIds returns 409 (github_state conflict)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type ServerHandle } from '../../src/server/api/server.js';
import { openDbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import { makeCreatePrExecutorFn } from '../../src/server/pipeline/create-pr-executor.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: ReturnType<typeof openDbPool>;
let handle: ServerHandle;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yoke-create-pr-'));
  db = openDbPool(path.join(tmpDir, 'test.db'));
  const migrationsDir = new URL(
    '../../src/server/storage/migrations/',
    import.meta.url,
  ).pathname;
  await applyMigrations(db.writer, migrationsDir);

  // Fake createPrFn — returns a fixed PR result without calling GitHub API.
  const fakeCreatePrFn = async (_workflowId: string) => ({
    prNumber: 42,
    prUrl: 'https://github.com/test/test/pull/42',
    usedPath: 'octokit' as const,
  });

  const createPrExecutor = makeCreatePrExecutorFn(db.writer, fakeCreatePrFn);
  handle = await createServer(db, { createPrExecutor });
  await handle.fastify.ready();
});

afterEach(async () => {
  await handle.fastify.close();
  db.close();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface InjectResult {
  statusCode: number;
  body: unknown;
  rawBody: string;
}

async function inject(
  method: string,
  url: string,
  body?: object,
): Promise<InjectResult> {
  const res = await handle.fastify.inject({
    method: method as 'GET' | 'POST',
    url,
    ...(body
      ? {
          payload: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        }
      : {}),
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as unknown, rawBody: res.body };
}

let wfSeq = 0;
function insertWorkflow(
  status: string,
  githubState: string | null = null,
): string {
  wfSeq++;
  const id = `wf-cpr-${wfSeq}`;
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, github_state, created_at, updated_at)
       VALUES (?, ?, '{}', '{"stages":[]}', '{}', ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(id, `Workflow ${wfSeq}`, status, githubState);
  return id;
}

// ---------------------------------------------------------------------------
// 200 happy path
// ---------------------------------------------------------------------------

describe('POST /api/workflows/:id/github/create-pr — happy path', () => {
  it('returns 200 with prNumber, prUrl, usedPath for a completed workflow with github_state=idle', async () => {
    const wfId = insertWorkflow('completed', 'idle');

    const { statusCode, body } = await inject('POST', `/api/workflows/${wfId}/github/create-pr`, {
      commandId: 'cmd-cpr-happy-1',
    });

    expect(statusCode).toBe(200);
    expect((body as any).status).toBe('created');
    expect((body as any).prNumber).toBe(42);
    expect((body as any).prUrl).toBe('https://github.com/test/test/pull/42');
    expect((body as any).usedPath).toBe('octokit');
  });

  it('returns 200 for completed_with_blocked workflow with github_state=idle', async () => {
    const wfId = insertWorkflow('completed_with_blocked', 'idle');
    const { statusCode } = await inject('POST', `/api/workflows/${wfId}/github/create-pr`, {
      commandId: 'cmd-cpr-blocked',
    });
    expect(statusCode).toBe(200);
  });

  it('returns 200 for abandoned workflow with github_state=failed', async () => {
    const wfId = insertWorkflow('abandoned', 'failed');
    const { statusCode } = await inject('POST', `/api/workflows/${wfId}/github/create-pr`, {
      commandId: 'cmd-cpr-abandoned',
    });
    expect(statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 404 unknown workflow
// ---------------------------------------------------------------------------

describe('POST /api/workflows/:id/github/create-pr — 404', () => {
  it('returns 404 for an unknown workflow id', async () => {
    const { statusCode } = await inject(
      'POST',
      '/api/workflows/does-not-exist/github/create-pr',
      { commandId: 'cmd-cpr-404' },
    );
    expect(statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 409 non-terminal
// ---------------------------------------------------------------------------

describe('POST /api/workflows/:id/github/create-pr — 409 non-terminal', () => {
  it('returns 409 when workflow status is in_progress', async () => {
    const wfId = insertWorkflow('in_progress', 'idle');
    const { statusCode, body } = await inject(
      'POST',
      `/api/workflows/${wfId}/github/create-pr`,
      { commandId: 'cmd-cpr-nonterminal' },
    );
    expect(statusCode).toBe(409);
    expect((body as any).currentStatus).toBe('in_progress');
  });

  it('returns 409 when workflow status is pending', async () => {
    const wfId = insertWorkflow('pending', 'idle');
    const { statusCode } = await inject(
      'POST',
      `/api/workflows/${wfId}/github/create-pr`,
      { commandId: 'cmd-cpr-pending' },
    );
    expect(statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// 409 github_state conflict
// ---------------------------------------------------------------------------

describe('POST /api/workflows/:id/github/create-pr — 409 github_state conflict', () => {
  it('returns 409 when github_state is already created', async () => {
    const wfId = insertWorkflow('completed', 'created');
    const { statusCode, body } = await inject(
      'POST',
      `/api/workflows/${wfId}/github/create-pr`,
      { commandId: 'cmd-cpr-already-created' },
    );
    expect(statusCode).toBe(409);
    expect((body as any).currentGithubState).toBe('created');
  });

  it('returns 409 when github_state is creating (in progress)', async () => {
    const wfId = insertWorkflow('completed', 'creating');
    const { statusCode, body } = await inject(
      'POST',
      `/api/workflows/${wfId}/github/create-pr`,
      { commandId: 'cmd-cpr-creating' },
    );
    expect(statusCode).toBe(409);
    expect((body as any).currentGithubState).toBe('creating');
  });

  it('returns 409 when github_state is disabled', async () => {
    const wfId = insertWorkflow('completed', 'disabled');
    const { statusCode } = await inject(
      'POST',
      `/api/workflows/${wfId}/github/create-pr`,
      { commandId: 'cmd-cpr-disabled' },
    );
    expect(statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Double-click with different commandIds → 409
// ---------------------------------------------------------------------------

describe('POST /api/workflows/:id/github/create-pr — double-click different commandIds', () => {
  it('second request with different commandId returns 409 when github_state=created', async () => {
    const wfId = insertWorkflow('completed', 'idle');

    // First request succeeds
    const { statusCode: s1 } = await inject(
      'POST',
      `/api/workflows/${wfId}/github/create-pr`,
      { commandId: 'cmd-double-click-1' },
    );
    expect(s1).toBe(200);

    // Simulate the executor having written 'created' to DB after success
    // (the real executor would call _writeGithubState which we're not using here,
    // so we manually update to simulate subsequent state)
    db.writer
      .prepare(`UPDATE workflows SET github_state = 'created' WHERE id = ?`)
      .run(wfId);

    // Second request with a DIFFERENT commandId → 409 (github_state conflict)
    const { statusCode: s2, body: b2 } = await inject(
      'POST',
      `/api/workflows/${wfId}/github/create-pr`,
      { commandId: 'cmd-double-click-2' },
    );
    expect(s2).toBe(409);
    expect((b2 as any).currentGithubState).toBe('created');
  });
});

// ---------------------------------------------------------------------------
// Idempotent replay — same commandId returns cached response byte-for-byte
// ---------------------------------------------------------------------------

describe('POST /api/workflows/:id/github/create-pr — idempotency', () => {
  it('returns cached response byte-for-byte on second invocation with same commandId', async () => {
    const wfId = insertWorkflow('completed', 'idle');

    const { statusCode: s1, rawBody: raw1 } = await inject(
      'POST',
      `/api/workflows/${wfId}/github/create-pr`,
      { commandId: 'cmd-cpr-idem-1' },
    );
    expect(s1).toBe(200);

    // Simulate state change between first and second calls
    db.writer
      .prepare(`UPDATE workflows SET github_state = 'created' WHERE id = ?`)
      .run(wfId);

    // Same commandId → cached response (not re-executed)
    const { statusCode: s2, rawBody: raw2 } = await inject(
      'POST',
      `/api/workflows/${wfId}/github/create-pr`,
      { commandId: 'cmd-cpr-idem-1' },
    );
    expect(s2).toBe(200);

    // Byte-for-byte equality
    expect(raw2).toBe(raw1);
  });

  it('does not re-run the executor on idempotent replay', async () => {
    let callCount = 0;
    const countingCreatePrFn = async (_wfId: string) => {
      callCount++;
      return {
        prNumber: 99,
        prUrl: 'https://github.com/test/test/pull/99',
        usedPath: 'octokit' as const,
      };
    };

    // Create a second server with a counting executor
    const tmpDir2 = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yoke-idem-'));
    const db2 = openDbPool(path.join(tmpDir2, 'test2.db'));
    const migrationsDir = new URL(
      '../../src/server/storage/migrations/',
      import.meta.url,
    ).pathname;
    await applyMigrations(db2.writer, migrationsDir);

    const countingExecutor = makeCreatePrExecutorFn(db2.writer, countingCreatePrFn);
    const handle2 = await createServer(db2, { createPrExecutor: countingExecutor });
    await handle2.fastify.ready();

    // Seed workflow
    db2.writer
      .prepare(
        `INSERT INTO workflows (id, name, spec, pipeline, config, status, github_state, created_at, updated_at)
         VALUES ('wf-count', 'Count WF', '{}', '{}', '{}', 'completed', 'idle', datetime('now'), datetime('now'))`,
      )
      .run();

    async function inject2(body: object): Promise<InjectResult> {
      const res = await handle2.fastify.inject({
        method: 'POST',
        url: '/api/workflows/wf-count/github/create-pr',
        payload: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      });
      return { statusCode: res.statusCode, body: JSON.parse(res.body) as unknown, rawBody: res.body };
    }

    await inject2({ commandId: 'cmd-count-idem' });
    await inject2({ commandId: 'cmd-count-idem' }); // second call, same commandId

    expect(callCount).toBe(1); // executor called exactly once

    await handle2.fastify.close();
    db2.close();
    await fs.promises.rm(tmpDir2, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Missing commandId → 400
// ---------------------------------------------------------------------------

describe('POST /api/workflows/:id/github/create-pr — validation', () => {
  it('returns 400 when commandId is missing', async () => {
    const wfId = insertWorkflow('completed', 'idle');
    const { statusCode } = await inject('POST', `/api/workflows/${wfId}/github/create-pr`, {});
    expect(statusCode).toBe(400);
  });
});
