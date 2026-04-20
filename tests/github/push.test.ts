/**
 * Unit tests for src/server/github/push.ts.
 *
 * Uses a stub execGit that either resolves (success) or throws with canned
 * stderr (all four error classifications).  No real git repo is needed.
 *
 * Coverage:
 *   success          — pushBranch resolves { ok: true }
 *   auth_failed      — stderr matches 'authentication', 'permission denied',
 *                      'could not read Username', 'could not read Password'
 *   non_fast_forward — stderr matches 'non-fast-forward', 'updates were
 *                      rejected', 'fetch first'
 *   network_failed   — stderr matches 'could not resolve',
 *                      'network is unreachable', 'timeout',
 *                      'connection refused'
 *   other            — stderr with no known marker
 *
 *   args shape       — execGit receives ['-C', worktreePath, 'push', '-u',
 *                      'origin', branchName] with no --force flag
 */

import { describe, it, expect, vi } from 'vitest';
import { pushBranch } from '../../src/server/github/push.js';
import type { PushDeps } from '../../src/server/github/push.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStub(stderr?: string): PushDeps {
  return {
    execGit: stderr === undefined
      ? vi.fn(async () => '')
      : vi.fn(async () => { throw new Error(stderr); }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pushBranch', () => {
  it('success — returns {ok:true} when execGit resolves', async () => {
    const deps = makeStub();
    const result = await pushBranch('my-branch', '/tmp/worktree', deps);
    expect(result).toEqual({ ok: true });
  });

  it('passes correct args to execGit (includes -C and -u, no --force)', async () => {
    const deps = makeStub();
    await pushBranch('feature-x', '/repo/worktree', deps);
    expect(deps.execGit).toHaveBeenCalledOnce();
    const args: string[] = (deps.execGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args).toEqual(['-C', '/repo/worktree', 'push', '-u', 'origin', 'feature-x']);
    expect(args).not.toContain('--force');
    expect(args).not.toContain('--no-verify');
  });

  describe('auth_failed', () => {
    it.each([
      'remote: authentication required',
      'Permission denied (publickey)',
      'fatal: could not read Username for https://github.com',
      'fatal: could not read Password for https://github.com',
    ])('classifies stderr %j as auth_failed', async (stderr) => {
      const result = await pushBranch('branch', '/path', makeStub(stderr));
      expect(result).toMatchObject({ ok: false, kind: 'auth_failed', rawStderr: stderr });
    });
  });

  describe('non_fast_forward', () => {
    it.each([
      'error: failed to push some refs (non-fast-forward)',
      'error: updates were rejected because the remote contains work',
      'hint: integrate the remote changes (e.g. git pull ...) before pushing again.\nhint: See the fetch first message',
    ])('classifies stderr %j as non_fast_forward', async (stderr) => {
      const result = await pushBranch('branch', '/path', makeStub(stderr));
      expect(result).toMatchObject({ ok: false, kind: 'non_fast_forward', rawStderr: stderr });
    });
  });

  describe('network_failed', () => {
    it.each([
      'fatal: unable to connect: could not resolve host: github.com',
      'error: network is unreachable',
      'error: timeout while talking to remote',
      'fatal: unable to connect to remote: connection refused',
    ])('classifies stderr %j as network_failed', async (stderr) => {
      const result = await pushBranch('branch', '/path', makeStub(stderr));
      expect(result).toMatchObject({ ok: false, kind: 'network_failed', rawStderr: stderr });
    });
  });

  describe('other', () => {
    it('classifies unrecognised stderr as other', async () => {
      const stderr = 'error: unexpected failure with no recognisable marker';
      const result = await pushBranch('branch', '/path', makeStub(stderr));
      expect(result).toMatchObject({ ok: false, kind: 'other', rawStderr: stderr });
    });
  });

  it('ok:false result includes message and rawStderr fields', async () => {
    const stderr = 'authentication required';
    const result = await pushBranch('branch', '/path', makeStub(stderr));
    if (result.ok) throw new Error('expected ok:false');
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.rawStderr).toBe(stderr);
  });
});
