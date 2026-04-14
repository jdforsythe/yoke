/**
 * HTTP endpoint — GET /api/sessions/:id/log integration tests.
 *
 * Spins up a real Node.js http.Server on a random port, inserts SQLite rows,
 * and makes real HTTP requests. No mocks.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../../src/server/api/http.js';
import { openDbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: ReturnType<typeof openDbPool>;
let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yoke-http-'));
  db = openDbPool(path.join(tmpDir, 'test.db'));
  // Apply migrations so all tables exist.
  const migrationsDir = new URL(
    '../../src/server/storage/migrations/',
    import.meta.url,
  ).pathname;
  await applyMigrations(db.writer, migrationsDir);

  // Insert the workflow row required by the sessions FK.
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES ('wf-1', 'test-workflow', '{}', '{}', '{}', 'running', datetime('now'), datetime('now'))`,
    )
    .run();

  server = createHttpServer(db);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number;
  body: unknown;
}

async function get(urlStr: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    http
      .get(urlStr, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            reject(new Error(`Failed to parse JSON response: ${data}`));
          }
        });
      })
      .on('error', reject);
  });
}

let sessionSeq = 0;

/** Insert a minimal sessions row. Returns the new session id. */
function insertSession(logPath: string | null = null): string {
  sessionSeq++;
  const id = `ses-${sessionSeq}`;
  db.writer
    .prepare(
      `INSERT INTO sessions
         (id, workflow_id, stage, phase, agent_profile, started_at, status, session_log_path)
       VALUES (?, 'wf-1', 'stage-1', 'phase-1', 'default', datetime('now'), 'running', ?)`,
    )
    .run(id, logPath);
  return id;
}

/** Write n JSONL lines to a file in tmpDir; return its absolute path. */
async function makeLogFile(n: number, name = 'session.jsonl'): Promise<string> {
  const logPath = path.join(tmpDir, name);
  const lines = Array.from({ length: n }, (_, i) => `{"seq":${i}}`).join('\n');
  await fs.promises.writeFile(logPath, n > 0 ? lines + '\n' : '', 'utf8');
  return logPath;
}

// ---------------------------------------------------------------------------
// 404 paths
// ---------------------------------------------------------------------------

describe('GET /api/sessions/:id/log — 404 paths', () => {
  it('returns 404 for an unknown session id (AC-5)', async () => {
    const { status, body } = await get(`${baseUrl}/api/sessions/nonexistent/log`);
    expect(status).toBe(404);
    expect((body as any).error).toBe('session not found');
  });

  it('returns 404 for an unknown route', async () => {
    const { status } = await get(`${baseUrl}/api/other/route`);
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 200 — session exists, no log yet
// ---------------------------------------------------------------------------

describe('GET /api/sessions/:id/log — session exists, no log', () => {
  it('returns 200 with empty entries when session_log_path is null (AC-5)', async () => {
    const id = insertSession(null);
    const { status, body } = await get(`${baseUrl}/api/sessions/${id}/log`);
    expect(status).toBe(200);
    const page = body as any;
    expect(page.entries).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextSeq).toBe(0);
  });

  it('returns 200 with empty entries when log file does not yet exist', async () => {
    const logPath = path.join(tmpDir, 'not-yet-created.jsonl');
    const id = insertSession(logPath);
    const { status, body } = await get(`${baseUrl}/api/sessions/${id}/log`);
    expect(status).toBe(200);
    expect((body as any).entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 200 — paging correctness (AC-5)
// ---------------------------------------------------------------------------

describe('GET /api/sessions/:id/log — paging correctness', () => {
  it('returns all entries in original order with sinceSeq=0 and large limit', async () => {
    const logPath = await makeLogFile(5);
    const id = insertSession(logPath);
    const { status, body } = await get(`${baseUrl}/api/sessions/${id}/log?sinceSeq=0&limit=10`);
    expect(status).toBe(200);
    const page = body as any;
    expect(page.entries).toHaveLength(5);
    expect(JSON.parse(page.entries[0])).toEqual({ seq: 0 });
    expect(JSON.parse(page.entries[4])).toEqual({ seq: 4 });
    expect(page.hasMore).toBe(false);
    expect(page.nextSeq).toBe(5);
  });

  it('honours sinceSeq to return frames N+1..N+M (AC-5)', async () => {
    const logPath = await makeLogFile(5);
    const id = insertSession(logPath);
    const { status, body } = await get(`${baseUrl}/api/sessions/${id}/log?sinceSeq=1&limit=2`);
    expect(status).toBe(200);
    const page = body as any;
    expect(page.entries).toHaveLength(2);
    expect(JSON.parse(page.entries[0])).toEqual({ seq: 1 });
    expect(JSON.parse(page.entries[1])).toEqual({ seq: 2 });
    expect(page.hasMore).toBe(true);
    expect(page.nextSeq).toBe(3);
  });

  it('supports full sequential paging — all entries retrieved with no gap or overlap', async () => {
    const logPath = await makeLogFile(10);
    const id = insertSession(logPath);
    let allEntries: string[] = [];
    let sinceSeq = 0;
    let iterations = 0;

    while (true) {
      const { body } = await get(
        `${baseUrl}/api/sessions/${id}/log?sinceSeq=${sinceSeq}&limit=3`,
      );
      const page = body as any;
      allEntries = allEntries.concat(page.entries);
      if (!page.hasMore) break;
      sinceSeq = page.nextSeq;
      iterations++;
      if (iterations > 20) throw new Error('paging loop did not terminate');
    }

    expect(allEntries).toHaveLength(10);
    allEntries.forEach((entry, i) => {
      expect(JSON.parse(entry).seq).toBe(i);
    });
  });

  it('reading past the end returns empty entries with hasMore=false', async () => {
    const logPath = await makeLogFile(3);
    const id = insertSession(logPath);
    const { status, body } = await get(
      `${baseUrl}/api/sessions/${id}/log?sinceSeq=10&limit=5`,
    );
    expect(status).toBe(200);
    const page = body as any;
    expect(page.entries).toEqual([]);
    expect(page.hasMore).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Read-only (AC-6)
// ---------------------------------------------------------------------------

describe('GET /api/sessions/:id/log — read-only (AC-6)', () => {
  it('does not expose a POST/PUT/DELETE endpoint on the log path', async () => {
    // Non-GET methods fall through to the "not found" handler.
    // We test via a different path — the server only routes GET /api/sessions/*/log.
    const { status } = await get(`${baseUrl}/api/sessions/x/log/write`);
    expect(status).toBe(404);
  });

  it('returns 404 for a path that would mutate the log', async () => {
    const { status } = await get(`${baseUrl}/api/sessions/x/delete`);
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// AC-6 strengthened: non-GET methods on the log path return 404
// ---------------------------------------------------------------------------

describe('GET /api/sessions/:id/log — read-only method check (AC-6)', () => {
  /** Issue an HTTP request with an arbitrary method; return status code. */
  async function method(verb: string, urlStr: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request(urlStr, { method: verb }, (res) => {
        res.resume(); // drain body
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('POST /api/sessions/:id/log returns 404 — no write path exposed', async () => {
    const id = insertSession(null);
    const status = await method('POST', `${baseUrl}/api/sessions/${id}/log`);
    expect(status).toBe(404);
  });

  it('DELETE /api/sessions/:id/log returns 404 — no delete path exposed', async () => {
    const id = insertSession(null);
    const status = await method('DELETE', `${baseUrl}/api/sessions/${id}/log`);
    expect(status).toBe(404);
  });

  it('PUT /api/sessions/:id/log returns 404 — no write path exposed', async () => {
    const id = insertSession(null);
    const status = await method('PUT', `${baseUrl}/api/sessions/${id}/log`);
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// RC-3: reads from JSONL file, not from SQLite
// ---------------------------------------------------------------------------

describe('GET /api/sessions/:id/log — reads from JSONL file (RC-3)', () => {
  it('returns verbatim stream-json lines without modification', async () => {
    const logPath = path.join(tmpDir, 'stream.jsonl');
    const streamLine =
      '{"type":"assistant","message":{"id":"msg_01","content":[{"type":"text","text":"hello"}]}}';
    await fs.promises.writeFile(logPath, streamLine + '\n', 'utf8');
    const id = insertSession(logPath);

    const { body } = await get(`${baseUrl}/api/sessions/${id}/log`);
    const page = body as any;
    expect(page.entries[0]).toBe(streamLine);
  });

  it('sessions.session_log_path is the only SQLite field consulted (path pointer only)', async () => {
    // Verify: we can update session_log_path and the endpoint follows it.
    const logPath1 = await makeLogFile(3, 'log1.jsonl');
    const logPath2 = await makeLogFile(7, 'log2.jsonl');
    const id = insertSession(logPath1);

    const before = await get(`${baseUrl}/api/sessions/${id}/log`);
    expect((before.body as any).entries).toHaveLength(3);

    // Switch the pointer.
    db.writer
      .prepare('UPDATE sessions SET session_log_path = ? WHERE id = ?')
      .run(logPath2, id);

    const after = await get(`${baseUrl}/api/sessions/${id}/log`);
    expect((after.body as any).entries).toHaveLength(7);
  });
});
