/**
 * Tests for GET /api/workflows/:wf/prepost-run/:runId/:stream — the Graph
 * View's coord-keyed sibling of the timeline /items/:item/prepost/:id endpoint.
 *
 * Covers:
 *   - 200 happy path (matches by session_id + when + command_name + started_at)
 *   - 200 when session_id is NULL (sessionId segment is `_`)
 *   - 404 on unknown runId
 *   - 404 on cross-workflow mismatch
 *   - 404 when stdout_path / stderr_path is NULL
 *   - 400 on invalid :stream
 *   - 400 on a stored path outside the expected workflow root
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type ServerHandle } from '../../src/server/api/server.js';
import { openDbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import { makePrepostOutputDir } from '../../src/server/session-log/writer.js';
import { prepostRunId } from '../../src/server/graph/derive.js';

let tmpDir: string;
let configDir: string;
let homeDir: string;
let db: ReturnType<typeof openDbPool>;
let handle: ServerHandle;

const migrationsDir = new URL(
  '../../src/server/storage/migrations/',
  import.meta.url,
).pathname;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yoke-prepost-by-run-'));
  configDir = path.join(tmpDir, 'cfg');
  homeDir = path.join(tmpDir, 'home');
  await fs.promises.mkdir(configDir, { recursive: true });
  await fs.promises.mkdir(homeDir, { recursive: true });

  db = openDbPool(path.join(tmpDir, 'test.db'));
  await applyMigrations(db.writer, migrationsDir);
  handle = await createServer(db, { configDir, homeDir });
  await handle.fastify.ready();
});

afterEach(async () => {
  await handle.fastify.close();
  db.close();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

interface InjectResult {
  statusCode: number;
  body: unknown;
}

async function get(url: string): Promise<InjectResult> {
  const res = await handle.fastify.inject({ method: 'GET', url });
  let body: unknown;
  try {
    body = JSON.parse(res.body) as unknown;
  } catch {
    body = res.body;
  }
  return { statusCode: res.statusCode, body };
}

let seq = 0;

function insertWorkflow(): string {
  seq++;
  const id = `wf-${seq}`;
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', '{"stages":[]}', '{}', 'pending', datetime('now'), datetime('now'))`,
    )
    .run(id, `Workflow ${seq}`);
  return id;
}

function insertSession(workflowId: string, sessionId: string): void {
  db.writer
    .prepare(
      `INSERT INTO sessions
         (id, workflow_id, item_id, parent_session_id, stage, phase, agent_profile,
          started_at, ended_at, exit_code, status)
       VALUES (?, ?, NULL, NULL, 'stage-1', 'implement', 'default',
               '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', 0, 'complete')`,
    )
    .run(sessionId, workflowId);
}

function insertPrepost(
  workflowId: string,
  opts: {
    sessionId: string | null;
    commandName: string;
    when: 'pre' | 'post';
    startedAt: string;
    stdoutPath?: string | null;
    stderrPath?: string | null;
  },
): void {
  const stdoutPath = opts.stdoutPath ?? null;
  const stderrPath = opts.stderrPath ?? null;
  db.writer
    .prepare(
      `INSERT INTO prepost_runs
         (session_id, workflow_id, item_id, stage, phase, when_phase, command_name, argv,
          started_at, ended_at, exit_code, action_taken, stdout_path, stderr_path)
       VALUES (?, ?, NULL, 'stage-1', 'implement', ?, ?, '[]', ?, '2026-01-01T00:00:01Z', 0, NULL, ?, ?)`,
    )
    .run(
      opts.sessionId,
      workflowId,
      opts.when,
      opts.commandName,
      opts.startedAt,
      stdoutPath,
      stderrPath,
    );
}

async function writeArtifact(workflowId: string, name: string, content: string): Promise<string> {
  const dir = makePrepostOutputDir({ configDir, workflowId, homeDir });
  await fs.promises.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await fs.promises.writeFile(filePath, content);
  return filePath;
}

describe('GET /api/workflows/:wf/prepost-run/:runId/:stream', () => {
  it('returns captured stdout when the runId matches a session-scoped row', async () => {
    const wfId = insertWorkflow();
    insertSession(wfId, 'sess-A');
    const startedAt = '2026-01-01T00:00:00.500Z';
    const stdoutPath = await writeArtifact(wfId, 'run-a.stdout.log', 'hello from graph\n');
    insertPrepost(wfId, {
      sessionId: 'sess-A',
      commandName: 'check-verdict',
      when: 'post',
      startedAt,
      stdoutPath,
    });

    const runId = prepostRunId('sess-A', 'post', 'check-verdict', startedAt);
    const { statusCode, body } = await get(
      `/api/workflows/${wfId}/prepost-run/${encodeURIComponent(runId)}/stdout`,
    );
    expect(statusCode).toBe(200);
    expect(body).toEqual({
      content: 'hello from graph\n',
      totalSize: Buffer.byteLength('hello from graph\n'),
      truncated: false,
    });
  });

  it('returns captured stderr when sessionId segment is `_` (null session)', async () => {
    const wfId = insertWorkflow();
    const startedAt = '2026-01-02T12:34:56Z';
    const stderrPath = await writeArtifact(wfId, 'null-sess.stderr.log', 'oops');
    insertPrepost(wfId, {
      sessionId: null,
      commandName: 'cleanup',
      when: 'pre',
      startedAt,
      stderrPath,
    });

    const runId = prepostRunId(null, 'pre', 'cleanup', startedAt);
    const { statusCode, body } = await get(
      `/api/workflows/${wfId}/prepost-run/${encodeURIComponent(runId)}/stderr`,
    );
    expect(statusCode).toBe(200);
    expect(body).toMatchObject({ content: 'oops', totalSize: 4, truncated: false });
  });

  it('returns 404 when no row matches the coordinates', async () => {
    const wfId = insertWorkflow();
    const runId = prepostRunId('sess-missing', 'post', 'nope', '2026-01-01T00:00:00Z');
    const { statusCode } = await get(
      `/api/workflows/${wfId}/prepost-run/${encodeURIComponent(runId)}/stdout`,
    );
    expect(statusCode).toBe(404);
  });

  it('returns 404 on a cross-workflow mismatch (coords only hit a different workflow)', async () => {
    const wfA = insertWorkflow();
    const wfB = insertWorkflow();
    const startedAt = '2026-01-03T08:00:00Z';
    const stdoutPath = await writeArtifact(wfA, 'cross.stdout.log', 'payload');
    insertPrepost(wfA, {
      sessionId: null,
      commandName: 'probe',
      when: 'post',
      startedAt,
      stdoutPath,
    });

    const runId = prepostRunId(null, 'post', 'probe', startedAt);
    const { statusCode } = await get(
      `/api/workflows/${wfB}/prepost-run/${encodeURIComponent(runId)}/stdout`,
    );
    expect(statusCode).toBe(404);
  });

  it('returns 404 with "no output captured" when stdout_path is NULL', async () => {
    const wfId = insertWorkflow();
    const startedAt = '2026-01-04T00:00:00Z';
    insertPrepost(wfId, {
      sessionId: null,
      commandName: 'lint',
      when: 'pre',
      startedAt,
      stdoutPath: null,
    });

    const runId = prepostRunId(null, 'pre', 'lint', startedAt);
    const { statusCode, body } = await get(
      `/api/workflows/${wfId}/prepost-run/${encodeURIComponent(runId)}/stdout`,
    );
    expect(statusCode).toBe(404);
    expect((body as { error: string }).error).toBe('no output captured');
  });

  it('rejects an invalid stream with 400', async () => {
    const wfId = insertWorkflow();
    const runId = prepostRunId(null, 'post', 'x', '2026-01-05T00:00:00Z');
    const { statusCode } = await get(
      `/api/workflows/${wfId}/prepost-run/${encodeURIComponent(runId)}/secret`,
    );
    expect(statusCode).toBe(400);
  });

  it('rejects a stored path outside the expected workflow root with 400', async () => {
    const wfId = insertWorkflow();
    const startedAt = '2026-01-06T00:00:00Z';
    const outside = path.join(tmpDir, 'outside.log');
    await fs.promises.writeFile(outside, 'leak');
    insertPrepost(wfId, {
      sessionId: null,
      commandName: 'escape',
      when: 'post',
      startedAt,
      stdoutPath: outside,
    });

    const runId = prepostRunId(null, 'post', 'escape', startedAt);
    const { statusCode } = await get(
      `/api/workflows/${wfId}/prepost-run/${encodeURIComponent(runId)}/stdout`,
    );
    expect(statusCode).toBe(400);
  });
});
