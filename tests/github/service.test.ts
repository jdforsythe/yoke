/**
 * Integration tests for the GitHub service (src/server/github/service.ts).
 *
 * Uses real SQLite (with migrations) and scripted stub deps for all external
 * I/O — no live GitHub API calls in any test (AC-5, RC-2).
 *
 * The "scripted fixture" pattern used here mirrors how ScriptedProcessManager
 * works: each test wires up injectable deps that return pre-scripted responses
 * exactly as a fixture file would replay NDJSON lines.
 *
 * Coverage:
 *   AC-1   Octokit path: GITHUB_TOKEN set → octokit adapter called →
 *           github_state transitions idle → creating → created; prNumber +
 *           prUrl written to DB.
 *   AC-2a  gh CLI path: GITHUB_TOKEN absent → gh_auth token resolved →
 *           gh CLI adapter called → github_state transitions to created.
 *   AC-2b  Octokit 401 fallback: GITHUB_TOKEN set but octokit returns 401 →
 *           gh CLI adapter called instead → created.
 *   AC-2c  Both auth paths exhausted → gh auth token exec fails →
 *           structured GithubAuthError returned; github_state = failed.
 *   AC-3   Push guard: unpushed commits → github_state = failed, PR not
 *           attempted.
 *   AC-4   Auth failure: structured error includes attempts array naming
 *           GITHUB_TOKEN and gh_auth with per-source failure reasons.
 *   RC-4   github_state DB write paired with events row in same transaction.
 *   RC-4b  initGithubState sets initial state at workflow creation time.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDbPool } from '../../src/server/storage/db.js';
import { applyMigrations } from '../../src/server/storage/migrate.js';
import type { DbPool } from '../../src/server/storage/db.js';
import { createPr, initGithubState } from '../../src/server/github/service.js';
import type { GithubServiceDeps, CreatePrInput, GithubBroadcastFn } from '../../src/server/github/service.js';
import type { AuthDeps } from '../../src/server/github/auth.js';
import type { PushGuardDeps } from '../../src/server/github/push-guard.js';
import type { OctokitAdapter, GhCliAdapter } from '../../src/server/github/pr.js';
import { OctokitPrError } from '../../src/server/github/pr.js';
import type { GithubStateRow } from '../../src/server/github/types.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../..', 'src/server/storage/migrations');

let tmpDir: string;
let db: DbPool;

/** Minimal workflow row inserted so FK constraints are satisfied. */
function insertWorkflow(workflowId: string): void {
  const now = new Date().toISOString();
  db.writer
    .prepare(
      `INSERT INTO workflows
         (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', '{}', '{}', 'running', ?, ?)`,
    )
    .run(workflowId, 'test-wf', now, now);
}

/** Read back github_state columns from the workflows table. */
function readGithubState(workflowId: string): GithubStateRow {
  return db.reader().prepare(
    `SELECT github_state, github_pr_number, github_pr_url,
            github_pr_state, github_error, github_last_checked_at
     FROM workflows WHERE id = ?`,
  ).get(workflowId) as GithubStateRow;
}

/** Read all events rows for a workflow. */
function readEvents(workflowId: string): Array<{ event_type: string; message: string; extra: string | null }> {
  return db.reader().prepare(
    `SELECT event_type, message, extra FROM events WHERE workflow_id = ? ORDER BY id`,
  ).all(workflowId) as Array<{ event_type: string; message: string; extra: string | null }>;
}

// ---------------------------------------------------------------------------
// Scripted stub factories
// ---------------------------------------------------------------------------

/** Push guard stub: always reports branch is fully pushed (ok=true). */
function pushedGuardDeps(): PushGuardDeps {
  return {
    execGit: async (_args: string[]) => '',  // empty output = no unpushed commits
  };
}

/** Push guard stub: reports N unpushed commits. */
function unpushedGuardDeps(count: number): PushGuardDeps {
  return {
    execGit: async (_args: string[]) => Array.from({ length: count }, (_, i) => `abc123${i} commit ${i}`).join('\n'),
  };
}

/** Auth stub: GITHUB_TOKEN=<token> set. */
function githubTokenAuthDeps(token: string): AuthDeps {
  return {
    getEnv: (key: string) => key === 'GITHUB_TOKEN' ? token : undefined,
    execGhAuthToken: async () => { throw new Error('should not be called'); },
  };
}

/** Auth stub: GITHUB_TOKEN absent, gh auth token returns <token>. */
function ghAuthOnlyDeps(token: string): AuthDeps {
  return {
    getEnv: () => undefined,
    execGhAuthToken: async () => token,
  };
}

/** Auth stub: both sources fail. */
function noAuthDeps(ghReason: string): AuthDeps {
  return {
    getEnv: () => undefined,
    execGhAuthToken: async () => { throw new Error(ghReason); },
  };
}

/** Octokit adapter stub: returns scripted PrResult. */
function scriptedOctokitSuccess(prNumber: number, prUrl: string): OctokitAdapter {
  return {
    createPr: async (_token: string, _input) => ({ prNumber, prUrl }),
  };
}

/** Octokit adapter stub: throws OctokitPrError with the given status. */
function scriptedOctokitError(statusCode: number): OctokitAdapter {
  return {
    createPr: async () => {
      throw new OctokitPrError(statusCode, `GitHub API error ${statusCode}`);
    },
  };
}

/** gh CLI adapter stub: returns scripted PrResult. */
function scriptedGhSuccess(prNumber: number, prUrl: string): GhCliAdapter {
  return {
    createPr: async (_input) => ({ prNumber, prUrl }),
  };
}

/** gh CLI adapter stub: throws an error. */
function scriptedGhError(message: string): GhCliAdapter {
  return {
    createPr: async () => { throw new Error(message); },
  };
}

// ---------------------------------------------------------------------------
// Standard CreatePrInput
// ---------------------------------------------------------------------------

const BASE_INPUT: CreatePrInput = {
  workflowId: 'wf-1',
  branchName: 'feat/my-branch',
  owner: 'myorg',
  repo: 'myrepo',
  base: 'main',
  title: 'My PR',
  body: 'Test body',
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-github-test-'));
  db = openDbPool(path.join(tmpDir, 'test.db'));
  applyMigrations(db.writer, MIGRATIONS_DIR);
  insertWorkflow('wf-1');
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createPr — octokit path (AC-1)', () => {
  it('transitions idle → creating → created and writes prNumber + prUrl', async () => {
    // Set idle state first (simulating initGithubState)
    initGithubState(db, 'wf-1', { enabled: true, autoPr: true, hasOwnerRepo: true });

    const deps: GithubServiceDeps = {
      db,
      authDeps: githubTokenAuthDeps('ghp_test_token'),
      pushGuardDeps: pushedGuardDeps(),
      octokitAdapter: scriptedOctokitSuccess(42, 'https://github.com/myorg/myrepo/pull/42'),
      ghCliAdapter: scriptedGhError('should not be called'),
    };

    const result = await createPr(BASE_INPUT, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prNumber).toBe(42);
    expect(result.prUrl).toBe('https://github.com/myorg/myrepo/pull/42');
    expect(result.usedPath).toBe('octokit');

    const row = readGithubState('wf-1');
    expect(row.github_state).toBe('created');
    expect(row.github_pr_number).toBe(42);
    expect(row.github_pr_url).toBe('https://github.com/myorg/myrepo/pull/42');
    expect(row.github_error).toBeNull();
  });

  it('writes events rows for idle, creating, and created transitions (RC-4)', async () => {
    initGithubState(db, 'wf-1', { enabled: true, autoPr: true, hasOwnerRepo: true });

    const deps: GithubServiceDeps = {
      db,
      authDeps: githubTokenAuthDeps('ghp_test_token'),
      pushGuardDeps: pushedGuardDeps(),
      octokitAdapter: scriptedOctokitSuccess(7, 'https://github.com/myorg/myrepo/pull/7'),
      ghCliAdapter: scriptedGhError('should not be called'),
    };

    await createPr(BASE_INPUT, deps);

    const events = readEvents('wf-1');
    // initGithubState → idle event, then creating event, then created event
    const stateEvents = events.filter((e) => e.event_type === 'github.state');
    const states = stateEvents.map((e) => {
      const extra = JSON.parse(e.extra ?? '{}') as { state: string };
      return extra.state;
    });
    expect(states).toContain('idle');
    expect(states).toContain('creating');
    expect(states).toContain('created');
  });
});

describe('createPr — gh CLI path (AC-2a)', () => {
  it('uses gh CLI when GITHUB_TOKEN is absent', async () => {
    const deps: GithubServiceDeps = {
      db,
      authDeps: ghAuthOnlyDeps('gh_test_token'),
      pushGuardDeps: pushedGuardDeps(),
      octokitAdapter: scriptedOctokitError(500),  // should not be called via GITHUB_TOKEN path
      ghCliAdapter: scriptedGhSuccess(99, 'https://github.com/myorg/myrepo/pull/99'),
    };

    const result = await createPr(BASE_INPUT, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prNumber).toBe(99);
    expect(result.usedPath).toBe('gh_cli');

    const row = readGithubState('wf-1');
    expect(row.github_state).toBe('created');
    expect(row.github_pr_number).toBe(99);
  });
});

describe('createPr — octokit 401 fallback to gh CLI (AC-2b)', () => {
  it('falls back to gh CLI when octokit returns 401', async () => {
    const deps: GithubServiceDeps = {
      db,
      authDeps: githubTokenAuthDeps('ghp_bad_token'),
      pushGuardDeps: pushedGuardDeps(),
      octokitAdapter: scriptedOctokitError(401),
      ghCliAdapter: scriptedGhSuccess(55, 'https://github.com/myorg/myrepo/pull/55'),
    };

    const result = await createPr(BASE_INPUT, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prNumber).toBe(55);
    expect(result.usedPath).toBe('gh_cli');

    const row = readGithubState('wf-1');
    expect(row.github_state).toBe('created');
  });

  it('falls back to gh CLI when octokit returns 403', async () => {
    const deps: GithubServiceDeps = {
      db,
      authDeps: githubTokenAuthDeps('ghp_bad_token'),
      pushGuardDeps: pushedGuardDeps(),
      octokitAdapter: scriptedOctokitError(403),
      ghCliAdapter: scriptedGhSuccess(56, 'https://github.com/myorg/myrepo/pull/56'),
    };

    const result = await createPr(BASE_INPUT, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prNumber).toBe(56);
    expect(result.usedPath).toBe('gh_cli');
  });
});

describe('createPr — auth failure (AC-2c, AC-4)', () => {
  it('returns structured auth error when both sources fail', async () => {
    const deps: GithubServiceDeps = {
      db,
      authDeps: noAuthDeps('gh: not logged in'),
      pushGuardDeps: pushedGuardDeps(),
      octokitAdapter: scriptedOctokitError(500),
      ghCliAdapter: scriptedGhError('should not be called'),
    };

    const result = await createPr(BASE_INPUT, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('auth_failed');
    if (result.error.kind !== 'auth_failed') return;

    // AC-4: both attempted sources named
    const sources = result.error.attempts.map((a) => a.source);
    expect(sources).toContain('GITHUB_TOKEN');
    expect(sources).toContain('gh_auth');

    // Each attempt has a non-empty reason
    for (const attempt of result.error.attempts) {
      expect(attempt.reason.length).toBeGreaterThan(0);
    }

    // DB updated to failed
    const row = readGithubState('wf-1');
    expect(row.github_state).toBe('failed');
    expect(row.github_error).not.toBeNull();
    const storedError = JSON.parse(row.github_error!) as { kind: string };
    expect(storedError.kind).toBe('auth_failed');
  });

  it('structured auth error includes specific failure reason for each source (AC-4)', async () => {
    const deps: GithubServiceDeps = {
      db,
      authDeps: noAuthDeps('exit code 1: You are not logged into any GitHub hosts'),
      pushGuardDeps: pushedGuardDeps(),
      octokitAdapter: scriptedOctokitError(500),
      ghCliAdapter: scriptedGhError('should not be called'),
    };

    const result = await createPr(BASE_INPUT, deps);
    if (result.ok || result.error.kind !== 'auth_failed') {
      expect(result.ok).toBe(false);
      return;
    }

    const ghAttempt = result.error.attempts.find((a) => a.source === 'gh_auth');
    expect(ghAttempt).toBeDefined();
    expect(ghAttempt!.reason).toMatch(/exit code 1|not logged in/i);
  });
});

describe('createPr — push guard (AC-3, RC-1)', () => {
  it('fails with api_failed error when branch has unpushed commits', async () => {
    const deps: GithubServiceDeps = {
      db,
      authDeps: githubTokenAuthDeps('ghp_test_token'),
      pushGuardDeps: unpushedGuardDeps(3),
      octokitAdapter: scriptedOctokitSuccess(1, 'https://github.com/myorg/myrepo/pull/1'),
      ghCliAdapter: scriptedGhSuccess(1, 'https://github.com/myorg/myrepo/pull/1'),
    };

    const result = await createPr(BASE_INPUT, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('api_failed');
    if (result.error.kind !== 'api_failed') return;
    expect(result.error.message).toMatch(/unpushed/i);

    // DB updated to failed, no PR created
    const row = readGithubState('wf-1');
    expect(row.github_state).toBe('failed');
    expect(row.github_pr_number).toBeNull();
    expect(row.github_pr_url).toBeNull();
  });

  it('push guard fails when remote tracking branch does not exist', async () => {
    const deps: GithubServiceDeps = {
      db,
      authDeps: githubTokenAuthDeps('ghp_test_token'),
      pushGuardDeps: {
        execGit: async () => {
          throw new Error("fatal: unknown revision 'origin/feat/my-branch'");
        },
      },
      octokitAdapter: scriptedOctokitSuccess(1, 'https://github.com/myorg/myrepo/pull/1'),
      ghCliAdapter: scriptedGhSuccess(1, 'https://github.com/myorg/myrepo/pull/1'),
    };

    const result = await createPr(BASE_INPUT, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('api_failed');
  });
});

describe('createPr — octokit non-auth API error', () => {
  it('fails immediately on 422 (non-auth error), does not fall back to gh CLI', async () => {
    let ghCalled = false;
    const deps: GithubServiceDeps = {
      db,
      authDeps: githubTokenAuthDeps('ghp_test_token'),
      pushGuardDeps: pushedGuardDeps(),
      octokitAdapter: scriptedOctokitError(422),
      ghCliAdapter: {
        createPr: async () => {
          ghCalled = true;
          return { prNumber: 1, prUrl: 'https://github.com/myorg/myrepo/pull/1' };
        },
      },
    };

    const result = await createPr(BASE_INPUT, deps);

    expect(result.ok).toBe(false);
    expect(ghCalled).toBe(false);
    const row = readGithubState('wf-1');
    expect(row.github_state).toBe('failed');
  });
});

describe('initGithubState (RC-4b)', () => {
  it('sets disabled when github.enabled is false', () => {
    initGithubState(db, 'wf-1', { enabled: false, autoPr: true, hasOwnerRepo: true });
    const row = readGithubState('wf-1');
    expect(row.github_state).toBe('disabled');
  });

  it('sets disabled when auto_pr is false', () => {
    initGithubState(db, 'wf-1', { enabled: true, autoPr: false, hasOwnerRepo: true });
    const row = readGithubState('wf-1');
    expect(row.github_state).toBe('disabled');
  });

  it('sets unconfigured when enabled+auto_pr but no owner/repo', () => {
    initGithubState(db, 'wf-1', { enabled: true, autoPr: true, hasOwnerRepo: false });
    const row = readGithubState('wf-1');
    expect(row.github_state).toBe('unconfigured');
  });

  it('sets idle when fully configured', () => {
    initGithubState(db, 'wf-1', { enabled: true, autoPr: true, hasOwnerRepo: true });
    const row = readGithubState('wf-1');
    expect(row.github_state).toBe('idle');
  });

  it('writes an events row for the initial state (RC-4)', () => {
    initGithubState(db, 'wf-1', { enabled: true, autoPr: true, hasOwnerRepo: true });
    const events = readEvents('wf-1');
    const stateEvents = events.filter((e) => e.event_type === 'github.state');
    expect(stateEvents.length).toBeGreaterThan(0);
    expect(stateEvents[0]!.message).toMatch(/idle/);
  });
});

describe('gh CLI adapter error path (AC-2)', () => {
  it('returns structured api_failed error when gh CLI fails', async () => {
    const deps: GithubServiceDeps = {
      db,
      authDeps: ghAuthOnlyDeps('gh_test_token'),
      pushGuardDeps: pushedGuardDeps(),
      octokitAdapter: scriptedOctokitError(500),
      ghCliAdapter: scriptedGhError('gh pr create failed: GraphQL: head sha is not behind base'),
    };

    const result = await createPr(BASE_INPUT, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('api_failed');
    if (result.error.kind !== 'api_failed') return;
    expect(result.error.message).toMatch(/gh pr create failed/i);

    const row = readGithubState('wf-1');
    expect(row.github_state).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// Broadcast tests (r2-12) — GithubBroadcastFn injected through deps
// ---------------------------------------------------------------------------

interface BroadcastCall {
  workflowId: string;
  frameType: string;
  payload: unknown;
}

function makeBroadcastStub(): { calls: BroadcastCall[]; fn: GithubBroadcastFn } {
  const calls: BroadcastCall[] = [];
  const fn: GithubBroadcastFn = (workflowId, frameType, payload) => {
    calls.push({ workflowId, frameType, payload });
  };
  return { calls, fn };
}

describe('broadcast — initGithubState (r2-12)', () => {
  it('emits exactly 1 workflow.update with status=idle when fully configured', () => {
    const stub = makeBroadcastStub();
    initGithubState(db, 'wf-1', { enabled: true, autoPr: true, hasOwnerRepo: true }, stub.fn);

    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.workflowId).toBe('wf-1');
    expect(call.frameType).toBe('workflow.update');
    const payload = call.payload as { githubState: Record<string, unknown> };
    expect(payload.githubState.status).toBe('idle');
    expect(payload.githubState.lastCheckedAt).toBeTruthy();
    // No extra fields beyond GithubState shape
    expect(payload.githubState.prNumber).toBeUndefined();
    expect(payload.githubState.prUrl).toBeUndefined();
    expect(payload.githubState.error).toBeUndefined();
  });

  it('emits status=disabled when github.enabled is false', () => {
    const stub = makeBroadcastStub();
    initGithubState(db, 'wf-1', { enabled: false, autoPr: true, hasOwnerRepo: true }, stub.fn);

    expect(stub.calls).toHaveLength(1);
    const payload = stub.calls[0]!.payload as { githubState: Record<string, unknown> };
    expect(payload.githubState.status).toBe('disabled');
  });

  it('emits status=unconfigured when owner/repo is absent', () => {
    const stub = makeBroadcastStub();
    initGithubState(db, 'wf-1', { enabled: true, autoPr: true, hasOwnerRepo: false }, stub.fn);

    expect(stub.calls).toHaveLength(1);
    const payload = stub.calls[0]!.payload as { githubState: Record<string, unknown> };
    expect(payload.githubState.status).toBe('unconfigured');
  });

  it('no broadcast fires when broadcast is not provided', () => {
    const stub = makeBroadcastStub();
    initGithubState(db, 'wf-1', { enabled: true, autoPr: true, hasOwnerRepo: true });
    // Called without broadcast — stub must not be called
    expect(stub.calls).toHaveLength(0);
  });
});

describe('broadcast — createPr success path (r2-12)', () => {
  it('emits creating then created — two broadcasts, payload shape correct', async () => {
    const stub = makeBroadcastStub();
    const deps: GithubServiceDeps = {
      db,
      authDeps: githubTokenAuthDeps('ghp_token'),
      pushGuardDeps: pushedGuardDeps(),
      octokitAdapter: scriptedOctokitSuccess(7, 'https://github.com/org/repo/pull/7'),
      ghCliAdapter: scriptedGhError('should not be called'),
      broadcast: stub.fn,
    };

    await createPr(BASE_INPUT, deps);

    expect(stub.calls).toHaveLength(2);

    // First broadcast: creating
    const creating = stub.calls[0]!.payload as { githubState: Record<string, unknown> };
    expect(creating.githubState.status).toBe('creating');
    expect(creating.githubState.lastCheckedAt).toBeTruthy();
    expect(creating.githubState.prNumber).toBeUndefined();
    expect(creating.githubState.prUrl).toBeUndefined();
    expect(creating.githubState.error).toBeUndefined();

    // Second broadcast: created with prNumber + prUrl
    const created = stub.calls[1]!.payload as { githubState: Record<string, unknown> };
    expect(created.githubState.status).toBe('created');
    expect(created.githubState.prNumber).toBe(7);
    expect(created.githubState.prUrl).toBe('https://github.com/org/repo/pull/7');
    expect(created.githubState.error).toBeUndefined();
  });
});

describe('broadcast — createPr failure paths (r2-12)', () => {
  it('push guard failure: emits exactly 1 broadcast with status=failed and error', async () => {
    const stub = makeBroadcastStub();
    const deps: GithubServiceDeps = {
      db,
      authDeps: githubTokenAuthDeps('ghp_token'),
      pushGuardDeps: unpushedGuardDeps(2),
      octokitAdapter: scriptedOctokitSuccess(1, 'https://github.com/org/repo/pull/1'),
      ghCliAdapter: scriptedGhSuccess(1, 'https://github.com/org/repo/pull/1'),
      broadcast: stub.fn,
    };

    await createPr(BASE_INPUT, deps);

    expect(stub.calls).toHaveLength(1);
    const payload = stub.calls[0]!.payload as { githubState: Record<string, unknown> };
    expect(payload.githubState.status).toBe('failed');
    expect(typeof payload.githubState.error).toBe('string');
    expect(payload.githubState.prNumber).toBeUndefined();
  });

  it('auth failure: emits exactly 1 broadcast with status=failed and error string', async () => {
    const stub = makeBroadcastStub();
    const deps: GithubServiceDeps = {
      db,
      authDeps: noAuthDeps('not logged in'),
      pushGuardDeps: pushedGuardDeps(),
      octokitAdapter: scriptedOctokitError(500),
      ghCliAdapter: scriptedGhError('should not be called'),
      broadcast: stub.fn,
    };

    await createPr(BASE_INPUT, deps);

    expect(stub.calls).toHaveLength(1);
    const payload = stub.calls[0]!.payload as { githubState: Record<string, unknown> };
    expect(payload.githubState.status).toBe('failed');
    expect(typeof payload.githubState.error).toBe('string');
    // Auth failure error contains both attempt sources
    expect(payload.githubState.error as string).toMatch(/GITHUB_TOKEN|gh_auth/);
  });

  it('gh CLI failure: emits creating then failed — two broadcasts', async () => {
    const stub = makeBroadcastStub();
    const deps: GithubServiceDeps = {
      db,
      authDeps: ghAuthOnlyDeps('gh_token'),
      pushGuardDeps: pushedGuardDeps(),
      octokitAdapter: scriptedOctokitError(500),
      ghCliAdapter: scriptedGhError('GraphQL error'),
      broadcast: stub.fn,
    };

    await createPr(BASE_INPUT, deps);

    expect(stub.calls).toHaveLength(2);
    expect((stub.calls[0]!.payload as { githubState: Record<string, unknown> }).githubState.status).toBe('creating');
    const failed = stub.calls[1]!.payload as { githubState: Record<string, unknown> };
    expect(failed.githubState.status).toBe('failed');
    expect(failed.githubState.error).toBe('GraphQL error');
  });
});

describe('broadcast — rollback suppresses broadcast (r2-12)', () => {
  it('no broadcast fires when the transaction throws (simulated rollback)', () => {
    const stub = makeBroadcastStub();

    // A DbPool whose transaction always throws (simulates a constraint violation rollback).
    const throwingDb = {
      writer: db.writer,
      reader: () => db.reader(),
      close: () => db.close(),
      transaction: <T>(_fn: (w: unknown) => T): T => {
        throw new Error('simulated rollback');
      },
    };

    expect(() => {
      initGithubState(throwingDb as Parameters<typeof initGithubState>[0], 'wf-1', {
        enabled: true, autoPr: true, hasOwnerRepo: true,
      }, stub.fn);
    }).toThrow('simulated rollback');

    // The broadcast must NOT have fired since the transaction rolled back.
    expect(stub.calls).toHaveLength(0);
  });
});
