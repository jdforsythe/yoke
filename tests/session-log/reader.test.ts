/**
 * readLogPage — integration tests.
 *
 * All tests use a real tmpdir and real files; no mocks.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_PAGE_SIZE, readLogPage } from '../../src/server/session-log/reader.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yoke-reader-'));
});

afterEach(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write n JSONL lines to a file; return its absolute path. */
async function makeLogFile(n: number, tag = 'line'): Promise<string> {
  const logPath = path.join(tmpDir, 'session.jsonl');
  const lines = Array.from({ length: n }, (_, i) => `{"seq":${i},"tag":"${tag}"}`).join('\n');
  await fs.promises.writeFile(logPath, n > 0 ? lines + '\n' : '', 'utf8');
  return logPath;
}

// ---------------------------------------------------------------------------
// Null / missing file
// ---------------------------------------------------------------------------

describe('readLogPage — missing or unreadable file', () => {
  it('returns null for a non-existent file (AC-5 — 404 mapping)', async () => {
    const result = await readLogPage(path.join(tmpDir, 'no-such-file.jsonl'), 0, 10);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Empty file
// ---------------------------------------------------------------------------

describe('readLogPage — empty file', () => {
  it('returns an empty page with hasMore=false for a zero-byte file', async () => {
    const logPath = await makeLogFile(0);
    const result = await readLogPage(logPath, 0, 10);
    expect(result).toEqual({ entries: [], nextSeq: 0, hasMore: false });
  });
});

// ---------------------------------------------------------------------------
// Basic paging
// ---------------------------------------------------------------------------

describe('readLogPage — basic paging', () => {
  it('returns all lines when sinceSeq=0 and limit >= total (AC-5)', async () => {
    const logPath = await makeLogFile(5);
    const result = await readLogPage(logPath, 0, 10);
    expect(result?.entries).toHaveLength(5);
    expect(result?.hasMore).toBe(false);
    expect(result?.nextSeq).toBe(5);
  });

  it('respects sinceSeq — skips the first N lines (AC-5: frames N+1..N+M)', async () => {
    const logPath = await makeLogFile(10);
    const result = await readLogPage(logPath, 3, 10);
    // Lines 4..10 (sinceSeq=3 skips first 3)
    expect(result?.entries).toHaveLength(7);
    expect(JSON.parse(result!.entries[0])).toMatchObject({ seq: 3 });
    expect(result?.nextSeq).toBe(10);
    expect(result?.hasMore).toBe(false);
  });

  it('respects limit — returns at most limit lines', async () => {
    const logPath = await makeLogFile(20);
    const result = await readLogPage(logPath, 0, 5);
    expect(result?.entries).toHaveLength(5);
    expect(result?.hasMore).toBe(true);
    expect(result?.nextSeq).toBe(5);
  });

  it('sets hasMore=true when more lines follow the page', async () => {
    const logPath = await makeLogFile(10);
    const result = await readLogPage(logPath, 0, 5);
    expect(result?.hasMore).toBe(true);
  });

  it('sets hasMore=false when the page ends at the last line', async () => {
    const logPath = await makeLogFile(5);
    const result = await readLogPage(logPath, 2, 10);
    // Lines 3..5 → 3 entries
    expect(result?.entries).toHaveLength(3);
    expect(result?.hasMore).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// nextSeq / sequential paging
// ---------------------------------------------------------------------------

describe('readLogPage — sequential paging', () => {
  it('nextSeq advances correctly across pages', async () => {
    const logPath = await makeLogFile(10);
    const page1 = await readLogPage(logPath, 0, 4);
    expect(page1?.nextSeq).toBe(4);

    const page2 = await readLogPage(logPath, page1!.nextSeq, 4);
    expect(page2?.nextSeq).toBe(8);
    expect(page2?.entries[0]).toContain('"seq":4');
  });

  it('three pages cover all 10 lines in original order with no overlap or gap', async () => {
    const logPath = await makeLogFile(10);
    const page1 = await readLogPage(logPath, 0, 4);
    const page2 = await readLogPage(logPath, page1!.nextSeq, 4);
    const page3 = await readLogPage(logPath, page2!.nextSeq, 4);

    const all = [...page1!.entries, ...page2!.entries, ...page3!.entries];
    expect(all).toHaveLength(10);
    all.forEach((entry, i) => {
      expect(JSON.parse(entry).seq).toBe(i);
    });
    expect(page3?.hasMore).toBe(false);
  });

  it('reading past end of file returns empty page with hasMore=false', async () => {
    const logPath = await makeLogFile(5);
    const result = await readLogPage(logPath, 5, 10);
    expect(result?.entries).toEqual([]);
    expect(result?.hasMore).toBe(false);
    expect(result?.nextSeq).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Limit clamping
// ---------------------------------------------------------------------------

describe('readLogPage — limit clamping', () => {
  it('clamps limit to MAX_PAGE_SIZE', async () => {
    const logPath = await makeLogFile(MAX_PAGE_SIZE + 5);
    const result = await readLogPage(logPath, 0, MAX_PAGE_SIZE + 100);
    expect(result?.entries).toHaveLength(MAX_PAGE_SIZE);
    expect(result?.hasMore).toBe(true);
  });

  it('clamps limit to minimum of 1 when 0 is passed', async () => {
    const logPath = await makeLogFile(5);
    const result = await readLogPage(logPath, 0, 0);
    expect(result?.entries).toHaveLength(1);
  });

  it('clamps limit to minimum of 1 when negative is passed', async () => {
    const logPath = await makeLogFile(5);
    const result = await readLogPage(logPath, 0, -10);
    expect(result?.entries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Order preservation (AC-5 — original order)
// ---------------------------------------------------------------------------

describe('readLogPage — original order preserved', () => {
  it('returns lines in the order they were written, not sorted', async () => {
    const logPath = path.join(tmpDir, 'unsorted.jsonl');
    await fs.promises.writeFile(logPath, 'z-line\na-line\nm-line\n', 'utf8');
    const result = await readLogPage(logPath, 0, 10);
    expect(result?.entries).toEqual(['z-line', 'a-line', 'm-line']);
  });
});

// ---------------------------------------------------------------------------
// RC-3: reads from file, not SQLite
// ---------------------------------------------------------------------------

describe('readLogPage — reads directly from JSONL file (RC-3)', () => {
  it('reads verbatim stream-json lines without interpretation', async () => {
    const logPath = path.join(tmpDir, 'stream.jsonl');
    const streamJsonLine = '{"type":"assistant","message":{"id":"msg_01","content":[{"type":"text","text":"hello"}]}}';
    await fs.promises.writeFile(logPath, streamJsonLine + '\n', 'utf8');

    const result = await readLogPage(logPath, 0, 10);
    expect(result?.entries).toHaveLength(1);
    expect(result?.entries[0]).toBe(streamJsonLine);
  });
});
