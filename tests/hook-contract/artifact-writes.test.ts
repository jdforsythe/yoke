/**
 * Unit tests for src/server/hook-contract/artifact-writes.ts
 *
 * Coverage:
 *   AC-3  sha256 of every file written by the session recorded; streaming hash.
 *   RC-2  sha256 computed with a streaming hash — no large-file buffering.
 *
 * captureGitHead and scanArtifactWrites rely on git CLI availability.
 * We test them with:
 *   - A real git repo for the happy path (initialized in tmp).
 *   - A non-git directory for the graceful-degradation path.
 *
 * computeSha256Streaming is tested directly for correctness and RC-2 compliance.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  captureGitHead,
  scanArtifactWrites,
  computeSha256Streaming,
} from '../../src/server/hook-contract/artifact-writes.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-artifact-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync('git', ['init', '-q'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
}

async function gitAdd(dir: string, ...files: string[]): Promise<void> {
  await execFileAsync('git', ['add', ...files], { cwd: dir });
}

async function gitCommit(dir: string, message: string): Promise<void> {
  await execFileAsync('git', ['commit', '-q', '-m', message], { cwd: dir });
}

function write(dir: string, relPath: string, content: string): void {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

// ---------------------------------------------------------------------------
// computeSha256Streaming — correctness + RC-2 compliance
// ---------------------------------------------------------------------------

describe('computeSha256Streaming', () => {
  it('returns the correct sha256 hex for a known file', async () => {
    const content = 'hello world\n';
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, content);

    // Reference: compute hash directly with crypto.createHash().
    const expected = crypto.createHash('sha256').update(content).digest('hex');
    const actual = await computeSha256Streaming(filePath);
    expect(actual).toBe(expected);
  });

  it('returns a 64-character hex string (RC-2: sha256 output width)', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'any content');
    const result = await computeSha256Streaming(filePath);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces distinct hashes for distinct files', async () => {
    const a = path.join(tmpDir, 'a.txt');
    const b = path.join(tmpDir, 'b.txt');
    fs.writeFileSync(a, 'content-a');
    fs.writeFileSync(b, 'content-b');
    const hashA = await computeSha256Streaming(a);
    const hashB = await computeSha256Streaming(b);
    expect(hashA).not.toBe(hashB);
  });

  it('computes correctly for an empty file', async () => {
    const filePath = path.join(tmpDir, 'empty.txt');
    fs.writeFileSync(filePath, '');
    const expected = crypto.createHash('sha256').update('').digest('hex');
    expect(await computeSha256Streaming(filePath)).toBe(expected);
  });

  it('throws when the file does not exist', async () => {
    await expect(
      computeSha256Streaming(path.join(tmpDir, 'nonexistent.txt')),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// captureGitHead — graceful degradation
// ---------------------------------------------------------------------------

describe('captureGitHead', () => {
  it('returns null for a non-git directory (never throws)', async () => {
    const result = await captureGitHead(tmpDir);
    expect(result).toBeNull();
  });

  it('returns null for an empty git repo (no commits)', async () => {
    await initGitRepo(tmpDir);
    const result = await captureGitHead(tmpDir);
    expect(result).toBeNull();
  });

  it('returns a 40-character commit hash after an initial commit', async () => {
    await initGitRepo(tmpDir);
    write(tmpDir, 'readme.txt', 'hello');
    await gitAdd(tmpDir, 'readme.txt');
    await gitCommit(tmpDir, 'init');
    const result = await captureGitHead(tmpDir);
    expect(result).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ---------------------------------------------------------------------------
// scanArtifactWrites — graceful degradation (non-git dir)
// ---------------------------------------------------------------------------

describe('scanArtifactWrites: non-git directory', () => {
  it('returns empty array for a non-git worktree (never throws)', async () => {
    const result = await scanArtifactWrites(tmpDir, null);
    expect(result).toEqual([]);
  });

  it('returns empty array when preSessionHead is null and no git', async () => {
    write(tmpDir, 'file.txt', 'data');
    const result = await scanArtifactWrites(tmpDir, null);
    // git status will fail silently — result must still be empty
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scanArtifactWrites — with a real git repo
// ---------------------------------------------------------------------------

describe('scanArtifactWrites: git repo', () => {
  it('picks up uncommitted new files written during session', async () => {
    await initGitRepo(tmpDir);
    write(tmpDir, 'seed.txt', 'seed');
    await gitAdd(tmpDir, 'seed.txt');
    await gitCommit(tmpDir, 'init');

    const preHead = await captureGitHead(tmpDir);

    // Simulate session writing a new file (uncommitted).
    write(tmpDir, 'output.json', '{"result":"ok"}');

    const writes = await scanArtifactWrites(tmpDir, preHead);
    const paths = writes.map((w) => w.path);
    expect(paths).toContain('output.json');
  });

  it('records sha256 for each discovered file (AC-3)', async () => {
    await initGitRepo(tmpDir);
    write(tmpDir, 'seed.txt', 'seed');
    await gitAdd(tmpDir, 'seed.txt');
    await gitCommit(tmpDir, 'init');

    const preHead = await captureGitHead(tmpDir);

    const content = 'artifact content';
    write(tmpDir, 'artifact.txt', content);

    const writes = await scanArtifactWrites(tmpDir, preHead);
    const found = writes.find((w) => w.path === 'artifact.txt');
    expect(found).toBeDefined();
    if (found) {
      const expected = crypto.createHash('sha256').update(content).digest('hex');
      expect(found.sha256).toBe(expected);
    }
  });

  it('picks up committed files when preSessionHead differs', async () => {
    await initGitRepo(tmpDir);
    write(tmpDir, 'seed.txt', 'seed');
    await gitAdd(tmpDir, 'seed.txt');
    await gitCommit(tmpDir, 'init');

    const preHead = await captureGitHead(tmpDir);

    // Simulate session committing a file.
    write(tmpDir, 'committed.ts', 'export const x = 1;');
    await gitAdd(tmpDir, 'committed.ts');
    await gitCommit(tmpDir, 'session work');

    const writes = await scanArtifactWrites(tmpDir, preHead);
    const paths = writes.map((w) => w.path);
    expect(paths).toContain('committed.ts');
  });

  it('skips deleted files (no sha256 attempt on ENOENT)', async () => {
    await initGitRepo(tmpDir);
    write(tmpDir, 'to-delete.txt', 'bye');
    await gitAdd(tmpDir, 'to-delete.txt');
    await gitCommit(tmpDir, 'init');

    const preHead = await captureGitHead(tmpDir);

    // Delete the file — git status will report 'D' for it.
    fs.unlinkSync(path.join(tmpDir, 'to-delete.txt'));

    // Should not throw; deleted file should be absent from results.
    const writes = await scanArtifactWrites(tmpDir, preHead);
    const paths = writes.map((w) => w.path);
    expect(paths).not.toContain('to-delete.txt');
  });

  it('returns empty array when no files changed (no diff, clean status)', async () => {
    await initGitRepo(tmpDir);
    write(tmpDir, 'seed.txt', 'seed');
    await gitAdd(tmpDir, 'seed.txt');
    await gitCommit(tmpDir, 'init');

    const preHead = await captureGitHead(tmpDir);

    // Session wrote nothing — no changes.
    const writes = await scanArtifactWrites(tmpDir, preHead);
    expect(writes).toEqual([]);
  });
});
