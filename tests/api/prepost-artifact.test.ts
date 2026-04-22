/**
 * Tests for GET /api/workflows/:wf/items/:item/prepost/:id/:stream (F4).
 *
 * Covers the artifact endpoint that serves captured prepost stdout/stderr:
 *   - 200 happy path with on-disk content
 *   - 200 empty file
 *   - 404 when stdout_path / stderr_path is NULL
 *   - 404 on unknown prepostId, cross-workflow mismatch, cross-item mismatch
 *   - 400 on invalid :stream
 *   - 400 on path-traversal (stored path outside the expected root)
 *   - Behaviour at exactly OUTPUT_CAPTURE_LIMIT (32_768 bytes) — the endpoint
 *     should return the full file without truncation since the cap is 64 KiB
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type ServerHandle } from '../../src/server/api/server.js';
import { openDbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import { makePrepostOutputDir } from '../../src/server/session-log/writer.js';
import { OUTPUT_CAPTURE_LIMIT } from '../../src/server/prepost/runner.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

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
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yoke-prepost-artifact-'));
  // Dedicated sub-dirs for configDir + homeDir so the fingerprint tree lives
  // under our tmp root (and the guard recomputes the same tree).
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function insertItem(workflowId: string): string {
  seq++;
  const id = `item-${seq}`;
  db.writer
    .prepare(
      `INSERT INTO items (id, workflow_id, stage_id, data, status, updated_at)
       VALUES (?, ?, 'stage-1', '{}', 'pending', datetime('now'))`,
    )
    .run(id, workflowId);
  return id;
}

function insertPrepost(
  workflowId: string,
  itemId: string,
  opts: {
    stdoutPath?: string | null;
    stderrPath?: string | null;
  } = {},
): number {
  const stdoutPath = opts.stdoutPath !== undefined ? opts.stdoutPath : null;
  const stderrPath = opts.stderrPath !== undefined ? opts.stderrPath : null;
  const info = db.writer
    .prepare(
      `INSERT INTO prepost_runs
         (workflow_id, item_id, stage, phase, when_phase, command_name, argv,
          started_at, ended_at, exit_code, action_taken, stdout_path, stderr_path)
       VALUES (?, ?, 'stage-1', 'implement', 'post', 'check', '[]',
               '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', 0, NULL, ?, ?)`,
    )
    .run(workflowId, itemId, stdoutPath, stderrPath);
  return Number(info.lastInsertRowid);
}

/** Computes the expected output root for a workflow given the test configDir / homeDir. */
function outputRootFor(workflowId: string): string {
  return makePrepostOutputDir({ configDir, workflowId, homeDir });
}

/** Writes a file under the workflow's expected output root. */
async function writeArtifact(workflowId: string, name: string, content: string): Promise<string> {
  const dir = outputRootFor(workflowId);
  await fs.promises.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await fs.promises.writeFile(filePath, content);
  return filePath;
}

// ---------------------------------------------------------------------------
// 200 success
// ---------------------------------------------------------------------------

describe('GET prepost artifact — 200', () => {
  it('returns file content with totalSize and truncated=false', async () => {
    const wfId = insertWorkflow();
    const itemId = insertItem(wfId);
    const content = 'hello stdout\ntriggered goto implement\n';
    const stdoutPath = await writeArtifact(wfId, 'one-post-check.stdout.log', content);
    const ppId = insertPrepost(wfId, itemId, { stdoutPath });

    const { statusCode, body } = await get(
      `/api/workflows/${wfId}/items/${itemId}/prepost/${ppId}/stdout`,
    );
    expect(statusCode).toBe(200);
    expect(body).toEqual({
      content,
      totalSize: Buffer.byteLength(content),
      truncated: false,
    });
  });

  it('serves stderr from stderr_path', async () => {
    const wfId = insertWorkflow();
    const itemId = insertItem(wfId);
    const stderrPath = await writeArtifact(wfId, 'two-post-check.stderr.log', 'oops');
    const ppId = insertPrepost(wfId, itemId, { stderrPath });

    const { statusCode, body } = await get(
      `/api/workflows/${wfId}/items/${itemId}/prepost/${ppId}/stderr`,
    );
    expect(statusCode).toBe(200);
    expect(body).toMatchObject({ content: 'oops', totalSize: 4, truncated: false });
  });

  it('returns empty content for a zero-byte file', async () => {
    const wfId = insertWorkflow();
    const itemId = insertItem(wfId);
    const stdoutPath = await writeArtifact(wfId, 'three-post-check.stdout.log', '');
    const ppId = insertPrepost(wfId, itemId, { stdoutPath });

    const { statusCode, body } = await get(
      `/api/workflows/${wfId}/items/${itemId}/prepost/${ppId}/stdout`,
    );
    expect(statusCode).toBe(200);
    expect(body).toEqual({ content: '', totalSize: 0, truncated: false });
  });

  it('returns the full file when it is exactly OUTPUT_CAPTURE_LIMIT bytes', async () => {
    const wfId = insertWorkflow();
    const itemId = insertItem(wfId);
    const payload = 'a'.repeat(OUTPUT_CAPTURE_LIMIT);
    const stdoutPath = await writeArtifact(wfId, 'cap-post-check.stdout.log', payload);
    const ppId = insertPrepost(wfId, itemId, { stdoutPath });

    const { statusCode, body } = await get(
      `/api/workflows/${wfId}/items/${itemId}/prepost/${ppId}/stdout`,
    );
    expect(statusCode).toBe(200);
    // The artifact reader's ceiling (64 KiB) is 2x the runner cap (32 KiB),
    // so a cap-sized file fits whole — no truncation.
    expect((body as { totalSize: number }).totalSize).toBe(OUTPUT_CAPTURE_LIMIT);
    expect((body as { truncated: boolean }).truncated).toBe(false);
    expect((body as { content: string }).content.length).toBe(OUTPUT_CAPTURE_LIMIT);
  });
});

// ---------------------------------------------------------------------------
// 404 branches
// ---------------------------------------------------------------------------

describe('GET prepost artifact — 404', () => {
  it('returns 404 with "no output captured" when stdout_path is NULL', async () => {
    const wfId = insertWorkflow();
    const itemId = insertItem(wfId);
    const ppId = insertPrepost(wfId, itemId, { stdoutPath: null });

    const { statusCode, body } = await get(
      `/api/workflows/${wfId}/items/${itemId}/prepost/${ppId}/stdout`,
    );
    expect(statusCode).toBe(404);
    expect((body as { error: string }).error).toBe('no output captured');
  });

  it('returns 404 with "no output captured" when stderr_path is NULL', async () => {
    const wfId = insertWorkflow();
    const itemId = insertItem(wfId);
    const ppId = insertPrepost(wfId, itemId, { stderrPath: null });

    const { statusCode, body } = await get(
      `/api/workflows/${wfId}/items/${itemId}/prepost/${ppId}/stderr`,
    );
    expect(statusCode).toBe(404);
    expect((body as { error: string }).error).toBe('no output captured');
  });

  it('returns 404 when the prepostId does not exist', async () => {
    const wfId = insertWorkflow();
    const itemId = insertItem(wfId);
    const { statusCode } = await get(
      `/api/workflows/${wfId}/items/${itemId}/prepost/99999/stdout`,
    );
    expect(statusCode).toBe(404);
  });

  it('returns 404 when the prepostId is not a positive integer', async () => {
    const wfId = insertWorkflow();
    const itemId = insertItem(wfId);
    const { statusCode } = await get(
      `/api/workflows/${wfId}/items/${itemId}/prepost/not-a-number/stdout`,
    );
    expect(statusCode).toBe(404);
  });

  it('returns 404 on cross-workflow mismatch', async () => {
    const wfA = insertWorkflow();
    const wfB = insertWorkflow();
    const itemA = insertItem(wfA);
    const stdoutPath = await writeArtifact(wfA, 'xw-post-check.stdout.log', 'data');
    const ppId = insertPrepost(wfA, itemA, { stdoutPath });

    const { statusCode, body } = await get(
      `/api/workflows/${wfB}/items/${itemA}/prepost/${ppId}/stdout`,
    );
    expect(statusCode).toBe(404);
    // Uniform error message — must not leak that the row exists in a
    // different workflow.
    expect((body as { error: string }).error).toBe('prepost run not found');
  });

  it('returns 404 on cross-item mismatch within the same workflow', async () => {
    const wfId = insertWorkflow();
    const itemX = insertItem(wfId);
    const itemY = insertItem(wfId);
    const stdoutPath = await writeArtifact(wfId, 'xi-post-check.stdout.log', 'data');
    const ppId = insertPrepost(wfId, itemX, { stdoutPath });

    const { statusCode } = await get(
      `/api/workflows/${wfId}/items/${itemY}/prepost/${ppId}/stdout`,
    );
    expect(statusCode).toBe(404);
  });

  it('returns 404 when the DB row points at a file that was deleted', async () => {
    const wfId = insertWorkflow();
    const itemId = insertItem(wfId);
    const stdoutPath = await writeArtifact(wfId, 'gone-post-check.stdout.log', 'x');
    const ppId = insertPrepost(wfId, itemId, { stdoutPath });

    await fs.promises.rm(stdoutPath);

    const { statusCode } = await get(
      `/api/workflows/${wfId}/items/${itemId}/prepost/${ppId}/stdout`,
    );
    expect(statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 400 branches
// ---------------------------------------------------------------------------

describe('GET prepost artifact — 400', () => {
  it('returns 400 on invalid :stream', async () => {
    const wfId = insertWorkflow();
    const itemId = insertItem(wfId);
    const ppId = insertPrepost(wfId, itemId, {});
    const { statusCode } = await get(
      `/api/workflows/${wfId}/items/${itemId}/prepost/${ppId}/banana`,
    );
    expect(statusCode).toBe(400);
  });

  it('returns 400 when the stored path resolves outside the workflow root', async () => {
    const wfId = insertWorkflow();
    const itemId = insertItem(wfId);
    // Malicious-looking stored path — not under the expected output root.
    const ppId = insertPrepost(wfId, itemId, { stdoutPath: '/etc/passwd' });

    const { statusCode, body } = await get(
      `/api/workflows/${wfId}/items/${itemId}/prepost/${ppId}/stdout`,
    );
    expect(statusCode).toBe(400);
    expect((body as { error: string }).error).toContain('outside the expected root');
  });

  it('rejects a path that escapes the root via ..', async () => {
    const wfId = insertWorkflow();
    const itemId = insertItem(wfId);
    const escape = path.join(outputRootFor(wfId), '..', 'not-mine.log');
    const ppId = insertPrepost(wfId, itemId, { stdoutPath: escape });

    const { statusCode } = await get(
      `/api/workflows/${wfId}/items/${itemId}/prepost/${ppId}/stdout`,
    );
    expect(statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 501 when configDir is not configured
// ---------------------------------------------------------------------------

describe('GET prepost artifact — no configDir', () => {
  it('returns 501 when the server was constructed without configDir', async () => {
    // Rebuild the handle without configDir to exercise the unconfigured branch.
    await handle.fastify.close();
    handle = await createServer(db, {}); // no configDir
    await handle.fastify.ready();

    const wfId = insertWorkflow();
    const itemId = insertItem(wfId);
    const ppId = insertPrepost(wfId, itemId, {});

    const { statusCode } = await get(
      `/api/workflows/${wfId}/items/${itemId}/prepost/${ppId}/stdout`,
    );
    expect(statusCode).toBe(501);
  });
});
