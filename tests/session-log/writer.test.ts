/**
 * SessionLogWriter — unit + integration tests.
 *
 * All tests use a real tmpdir; no mocks for fs.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import {
  SessionLogWriter,
  makeFingerprint,
  makeSessionLogPath,
  openSessionLog,
} from '../../src/server/session-log/writer.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yoke-writer-'));
});

afterEach(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// makeFingerprint
// ---------------------------------------------------------------------------

describe('makeFingerprint', () => {
  it('returns a 16-char lowercase hex string', () => {
    const fp = makeFingerprint('/some/path');
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for the same input', () => {
    expect(makeFingerprint('/same/path')).toBe(makeFingerprint('/same/path'));
  });

  it('differs for different configDir inputs (collision prevention, RC-4)', () => {
    expect(makeFingerprint('/path/project-a')).not.toBe(makeFingerprint('/path/project-b'));
  });

  it('handles empty string without throwing', () => {
    expect(() => makeFingerprint('')).not.toThrow();
    expect(makeFingerprint('')).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// makeSessionLogPath
// ---------------------------------------------------------------------------

describe('makeSessionLogPath', () => {
  it('produces the expected path structure', () => {
    const logPath = makeSessionLogPath({
      configDir: '/home/user/project',
      workflowId: 'wf-123',
      sessionId: 'ses-456',
      homeDir: '/home/user',
    });
    const fp = makeFingerprint('/home/user/project');
    expect(logPath).toBe(
      path.join('/home/user', '.yoke', fp, 'logs', 'wf-123', 'ses-456.jsonl'),
    );
  });

  it('uses os.homedir() when homeDir is omitted', () => {
    const logPath = makeSessionLogPath({
      configDir: '/some/dir',
      workflowId: 'wf-1',
      sessionId: 'ses-1',
    });
    expect(logPath.startsWith(os.homedir())).toBe(true);
    expect(logPath.endsWith('ses-1.jsonl')).toBe(true);
  });

  it('different configDirs produce different paths even for the same workflowId+sessionId (RC-4)', () => {
    const a = makeSessionLogPath({ configDir: '/proj-a', workflowId: 'wf', sessionId: 'ses', homeDir: '/h' });
    const b = makeSessionLogPath({ configDir: '/proj-b', workflowId: 'wf', sessionId: 'ses', homeDir: '/h' });
    expect(a).not.toBe(b);
  });

  it('path ends with <sessionId>.jsonl', () => {
    const logPath = makeSessionLogPath({
      configDir: '/c',
      workflowId: 'wf-99',
      sessionId: 'ses-77',
      homeDir: '/h',
    });
    expect(path.basename(logPath)).toBe('ses-77.jsonl');
  });
});

// ---------------------------------------------------------------------------
// SessionLogWriter — error paths
// ---------------------------------------------------------------------------

describe('SessionLogWriter — error paths', () => {
  it('throws if writeLine() is called before open()', async () => {
    const logPath = path.join(tmpDir, 'test.jsonl');
    const writer = new SessionLogWriter(logPath);
    await expect(writer.writeLine('{"test":1}')).rejects.toThrow('open()');
  });

  it('isOpen is false before open()', () => {
    const writer = new SessionLogWriter(path.join(tmpDir, 'x.jsonl'));
    expect(writer.isOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SessionLogWriter — lifecycle
// ---------------------------------------------------------------------------

describe('SessionLogWriter — lifecycle', () => {
  it('isOpen transitions: false → true → false', async () => {
    const logPath = path.join(tmpDir, 'lifecycle.jsonl');
    const writer = new SessionLogWriter(logPath);
    expect(writer.isOpen).toBe(false);
    await writer.open();
    expect(writer.isOpen).toBe(true);
    await writer.close();
    expect(writer.isOpen).toBe(false);
  });

  it('creates parent directories recursively on open()', async () => {
    const logPath = path.join(tmpDir, 'deep', 'nested', 'dir', 'session.jsonl');
    const writer = new SessionLogWriter(logPath);
    await writer.open();
    await writer.close();
    const stat = await fs.promises.stat(path.dirname(logPath));
    expect(stat.isDirectory()).toBe(true);
  });

  it('creates the file on open() with zero bytes if no writes occur', async () => {
    const logPath = path.join(tmpDir, 'empty.jsonl');
    const writer = new SessionLogWriter(logPath);
    await writer.open();
    await writer.close();
    const stat = await fs.promises.stat(logPath);
    expect(stat.size).toBe(0);
  });

  it('close() is idempotent — second call does not throw', async () => {
    const logPath = path.join(tmpDir, 'idem.jsonl');
    const writer = new SessionLogWriter(logPath);
    await writer.open();
    await writer.close();
    await expect(writer.close()).resolves.toBeUndefined();
  });

  it('exposes logPath as a readonly property', () => {
    const logPath = path.join(tmpDir, 'x.jsonl');
    const writer = new SessionLogWriter(logPath);
    expect(writer.logPath).toBe(logPath);
  });
});

// ---------------------------------------------------------------------------
// SessionLogWriter — write semantics (AC-1, RC-1)
// ---------------------------------------------------------------------------

describe('SessionLogWriter — write semantics', () => {
  it('writes lines terminated with \\n', async () => {
    const logPath = path.join(tmpDir, 'writes.jsonl');
    const writer = new SessionLogWriter(logPath);
    await writer.open();
    await writer.writeLine('{"type":"a"}');
    await writer.writeLine('{"type":"b"}');
    await writer.close();

    const contents = await fs.promises.readFile(logPath, 'utf8');
    expect(contents).toBe('{"type":"a"}\n{"type":"b"}\n');
  });

  it('appends to an existing file — does not overwrite (append-only, RC-1)', async () => {
    const logPath = path.join(tmpDir, 'append.jsonl');

    // First writer session
    const w1 = new SessionLogWriter(logPath);
    await w1.open();
    await w1.writeLine('{"seq":1}');
    await w1.close();

    // Second writer session — must append, not overwrite
    const w2 = new SessionLogWriter(logPath);
    await w2.open();
    await w2.writeLine('{"seq":2}');
    await w2.close();

    const contents = await fs.promises.readFile(logPath, 'utf8');
    expect(contents).toBe('{"seq":1}\n{"seq":2}\n');
  });

  it('handles 100 sequential writes correctly', async () => {
    const logPath = path.join(tmpDir, 'many.jsonl');
    const writer = new SessionLogWriter(logPath);
    await writer.open();
    for (let i = 0; i < 100; i++) {
      await writer.writeLine(`{"seq":${i}}`);
    }
    await writer.close();

    const lines = (await fs.promises.readFile(logPath, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(100);
    expect(JSON.parse(lines[0])).toEqual({ seq: 0 });
    expect(JSON.parse(lines[99])).toEqual({ seq: 99 });
  });

  it('writes arbitrary byte content without mangling (verbatim copy, AC-1)', async () => {
    const logPath = path.join(tmpDir, 'verbatim.jsonl');
    const writer = new SessionLogWriter(logPath);
    await writer.open();
    // Simulate verbatim stream-json stdout line (complex nested JSON)
    const line = '{"type":"assistant","message":{"id":"msg_01","content":[{"type":"text","text":"hello"}]}}';
    await writer.writeLine(line);
    await writer.close();

    const contents = (await fs.promises.readFile(logPath, 'utf8')).trimEnd();
    expect(contents).toBe(line);
  });

  it('log file is under ~/.yoke/, not in the worktree (AC-3 path structure)', () => {
    // makeSessionLogPath always anchors under homeDir/.yoke/
    const logPath = makeSessionLogPath({
      configDir: '/worktrees/my-worktree',
      workflowId: 'wf-1',
      sessionId: 'ses-1',
      homeDir: '/home/user',
    });
    expect(logPath.startsWith('/home/user/.yoke/')).toBe(true);
    expect(logPath).not.toContain('worktree');
  });
});

// ---------------------------------------------------------------------------
// openSessionLog — AC-4: sets sessions.session_log_path and opens the writer
// ---------------------------------------------------------------------------

describe('openSessionLog (AC-4)', () => {
  const migrationsDir = new URL(
    '../../src/server/storage/migrations/',
    import.meta.url,
  ).pathname;

  /** Set up a minimal DB with a sessions row. */
  async function makeDb(dbPath: string, sessionId: string): Promise<ReturnType<typeof openDbPool>> {
    const db = openDbPool(dbPath);
    await applyMigrations(db.writer, migrationsDir);
    db.writer
      .prepare(
        `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
         VALUES ('wf-1', 'test', '{}', '{}', '{}', 'running', datetime('now'), datetime('now'))`,
      )
      .run();
    db.writer
      .prepare(
        `INSERT INTO sessions
           (id, workflow_id, stage, phase, agent_profile, started_at, status)
         VALUES (?, 'wf-1', 'stage-1', 'phase-1', 'default', datetime('now'), 'running')`,
      )
      .run(sessionId);
    return db;
  }

  it('sets sessions.session_log_path in SQLite before returning (AC-4)', async () => {
    const db = await makeDb(path.join(tmpDir, 'open-session.db'), 'ses-open-1');
    try {
      const { writer, logPath } = await openSessionLog(db, {
        configDir: '/project',
        workflowId: 'wf-1',
        sessionId: 'ses-open-1',
        homeDir: tmpDir,
      });
      await writer.close();

      const row = db.reader()
        .prepare('SELECT session_log_path FROM sessions WHERE id = ?')
        .get('ses-open-1') as { session_log_path: string } | undefined;

      expect(row).toBeDefined();
      expect(row!.session_log_path).toBe(logPath);
      expect(row!.session_log_path.endsWith('ses-open-1.jsonl')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('returned writer is already open — writeLine() works immediately', async () => {
    const db = await makeDb(path.join(tmpDir, 'open-session2.db'), 'ses-open-2');
    try {
      const { writer } = await openSessionLog(db, {
        configDir: '/project',
        workflowId: 'wf-1',
        sessionId: 'ses-open-2',
        homeDir: tmpDir,
      });
      await writer.writeLine('{"type":"text"}');
      await writer.close();

      // The log path is the one stored in SQLite.
      const { session_log_path } = db.reader()
        .prepare('SELECT session_log_path FROM sessions WHERE id = ?')
        .get('ses-open-2') as { session_log_path: string };

      const content = await fs.promises.readFile(session_log_path, 'utf8');
      expect(content).toBe('{"type":"text"}\n');
    } finally {
      db.close();
    }
  });

  it('log path anchored under homeDir/.yoke/ (survives worktree cleanup, AC-3)', async () => {
    const db = await makeDb(path.join(tmpDir, 'open-session3.db'), 'ses-open-3');
    try {
      const { logPath, writer } = await openSessionLog(db, {
        configDir: '/worktrees/my-project',
        workflowId: 'wf-1',
        sessionId: 'ses-open-3',
        homeDir: tmpDir,
      });
      await writer.close();
      expect(logPath.startsWith(path.join(tmpDir, '.yoke'))).toBe(true);
    } finally {
      db.close();
    }
  });
});
