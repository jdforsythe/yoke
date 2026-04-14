/**
 * Unit tests for src/server/hook-contract/diff-checker.ts
 *
 * Coverage:
 *   AC-1  diff_check_fail when items_from has any non-whitespace change.
 *   AC-2  diff_check_ok when file is unchanged (whitespace ignored).
 *   RC-1  Pre-phase snapshot is taken from disk, not git history.
 *
 * All tests use real tmp-dir fs operations — no mocking required.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { takeSnapshot, checkDiff } from '../../src/server/hook-contract/diff-checker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-diff-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ITEMS_FROM = 'items.json';

function write(relPath: string, content: string): void {
  fs.writeFileSync(path.join(tmpDir, relPath), content, 'utf8');
}

function remove(relPath: string): void {
  fs.unlinkSync(path.join(tmpDir, relPath));
}

// ---------------------------------------------------------------------------
// takeSnapshot
// ---------------------------------------------------------------------------

describe('takeSnapshot', () => {
  it('returns null when itemsFromPath is undefined', () => {
    expect(takeSnapshot(tmpDir, undefined)).toBeNull();
  });

  it('returns null when the file does not exist', () => {
    expect(takeSnapshot(tmpDir, 'nonexistent.json')).toBeNull();
  });

  it('returns file content when the file exists', () => {
    write(ITEMS_FROM, '["a","b"]');
    expect(takeSnapshot(tmpDir, ITEMS_FROM)).toBe('["a","b"]');
  });

  it('never throws for an unreadable path', () => {
    // Pass a directory as the file path — readFileSync will throw EISDIR.
    expect(() => takeSnapshot(tmpDir, '.')).not.toThrow();
    expect(takeSnapshot(tmpDir, '.')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkDiff — itemsFromPath undefined
// ---------------------------------------------------------------------------

describe('checkDiff: itemsFromPath undefined', () => {
  it('returns skip regardless of snapshot value', () => {
    expect(checkDiff(null, tmpDir, undefined)).toEqual({ kind: 'skip' });
    expect(checkDiff('content', tmpDir, undefined)).toEqual({ kind: 'skip' });
  });
});

// ---------------------------------------------------------------------------
// checkDiff — snapshot was null (file absent before session)
// ---------------------------------------------------------------------------

describe('checkDiff: snapshot null (file absent before session)', () => {
  it('returns skip when file is still absent after session', () => {
    expect(checkDiff(null, tmpDir, ITEMS_FROM)).toEqual({ kind: 'skip' });
  });

  it('returns skip when created file is all-whitespace', () => {
    write(ITEMS_FROM, '   \n\t  \n');
    expect(checkDiff(null, tmpDir, ITEMS_FROM)).toEqual({ kind: 'skip' });
  });

  it('returns fail when file was created during session with non-whitespace content (AC-1)', () => {
    write(ITEMS_FROM, '["new-item"]');
    const result = checkDiff(null, tmpDir, ITEMS_FROM);
    expect(result.kind).toBe('fail');
    if (result.kind === 'fail') {
      expect(result.diffSummary).toMatch(/created during session/);
      expect(result.diffSummary).toMatch(/1 line/);
    }
  });

  it('includes correct line count in created-file summary', () => {
    write(ITEMS_FROM, 'line1\nline2\nline3');
    const result = checkDiff(null, tmpDir, ITEMS_FROM);
    expect(result.kind).toBe('fail');
    if (result.kind === 'fail') {
      expect(result.diffSummary).toMatch(/3 lines/);
    }
  });
});

// ---------------------------------------------------------------------------
// checkDiff — file existed before session (snapshot non-null)
// ---------------------------------------------------------------------------

describe('checkDiff: file existed before session', () => {
  it('returns ok when content is identical (AC-2)', () => {
    const content = '["a","b","c"]';
    write(ITEMS_FROM, content);
    const snapshot = takeSnapshot(tmpDir, ITEMS_FROM);
    // File unchanged — simulate session that wrote nothing.
    expect(checkDiff(snapshot, tmpDir, ITEMS_FROM)).toEqual({ kind: 'ok' });
  });

  it('returns ok when only whitespace changed (AC-2: whitespace ignored)', () => {
    write(ITEMS_FROM, '["a","b"]');
    const snapshot = takeSnapshot(tmpDir, ITEMS_FROM);
    // Add trailing newline — whitespace-only change.
    write(ITEMS_FROM, '["a","b"]\n\n');
    expect(checkDiff(snapshot, tmpDir, ITEMS_FROM)).toEqual({ kind: 'ok' });
  });

  it('returns fail when non-whitespace content changed (AC-1)', () => {
    write(ITEMS_FROM, '["a"]');
    const snapshot = takeSnapshot(tmpDir, ITEMS_FROM);
    write(ITEMS_FROM, '["a","b"]');
    const result = checkDiff(snapshot, tmpDir, ITEMS_FROM);
    expect(result.kind).toBe('fail');
  });

  it('diff summary includes line delta and char delta', () => {
    write(ITEMS_FROM, 'line1\nline2');
    const snapshot = takeSnapshot(tmpDir, ITEMS_FROM);
    write(ITEMS_FROM, 'line1\nline2\nline3');
    const result = checkDiff(snapshot, tmpDir, ITEMS_FROM);
    expect(result.kind).toBe('fail');
    if (result.kind === 'fail') {
      expect(result.diffSummary).toMatch(/lines:/);
      expect(result.diffSummary).toMatch(/non-whitespace chars:/);
    }
  });

  it('returns fail when file was deleted during session (AC-1)', () => {
    write(ITEMS_FROM, '["a"]');
    const snapshot = takeSnapshot(tmpDir, ITEMS_FROM);
    remove(ITEMS_FROM);
    const result = checkDiff(snapshot, tmpDir, ITEMS_FROM);
    expect(result.kind).toBe('fail');
    if (result.kind === 'fail') {
      expect(result.diffSummary).toMatch(/deleted during session/);
    }
  });

  it('returns fail on multi-line delta with correct sign', () => {
    write(ITEMS_FROM, 'a\nb\nc\nd');
    const snapshot = takeSnapshot(tmpDir, ITEMS_FROM);
    write(ITEMS_FROM, 'a\nb');
    const result = checkDiff(snapshot, tmpDir, ITEMS_FROM);
    expect(result.kind).toBe('fail');
    if (result.kind === 'fail') {
      // 4 lines → 2 lines: delta is -2
      expect(result.diffSummary).toMatch(/-2/);
    }
  });
});
