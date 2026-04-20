/**
 * Integration tests for src/server/prompt/context.ts (buildPromptContext).
 *
 * These tests use a real temporary filesystem but NO SQLite — item rows are
 * plain objects. The git helper is injected as a stub so no real git repo
 * is required.
 *
 * Coverage map (feat-prompt-asm):
 *
 *   AC-1  item.data parsed as opaque blob → ctx.item; item_state projected
 *         from harness columns (status, current_phase, retry_count).
 *   AC-4  Builder does not access named fields in item.data beyond opaque parse.
 *   AC-6  {{handoff}} populated from handoff.json entries array.
 *   RC-3  Opaque-blob handling verified — no harness-specific field names
 *         accessed inside context.ts.
 *
 * Standard-variable coverage:
 *   - workflow_name, stage_id, architecture_md, git_log_recent,
 *     user_injected_context (all phases)
 *   - item, item_id, item_state, progress_md, handoff, recent_diff
 *     (per-item phases only)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPromptContext,
  type WorkflowRow,
  type ItemRow,
  type GitHelper,
} from '../../src/server/prompt/context.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKFLOW: WorkflowRow = {
  id: 'wf-abc123',
  name: 'add-auth',
  current_stage: 'implementation',
};

const STAGE_PER_ITEM = { id: 'implementation', run: 'per-item' as const };
const STAGE_ONCE = { id: 'plan', run: 'once' as const };

/** Opaque item data blob — the builder must NOT access any named fields. */
const ITEM_DATA_OBJ = {
  id: 'feat-001',
  description: 'User can log in with email and password',
  acceptance_criteria: ['- accepts email/password', '- returns JWT'],
  review_criteria: ['- no plaintext passwords'],
  depends_on: [] as string[],
  category: 'auth',
};

const ITEM_ROW: ItemRow = {
  id: 'feat-001',
  data: JSON.stringify(ITEM_DATA_OBJ),
  status: 'in_progress',
  current_phase: 'implement',
  retry_count: 0,
  blocked_reason: null,
};

/** Stub git helper — no real repository needed. */
const STUB_GIT: GitHelper = {
  logRecent: async (_n: number) => 'abc123 initial commit\ndef456 second commit\n',
  diffRange: async (_from: string, _to: string) => 'diff --git a/src/foo.ts ...',
};

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoke-ctx-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// § 1  Base context (all-phases variables)
// ---------------------------------------------------------------------------

describe('buildPromptContext — base context (all phases)', () => {
  it('sets workflow_name from workflow.name', async () => {
    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_ONCE,
      worktreePath: tmpDir,
      git: STUB_GIT,
    });
    expect(ctx['workflow_name']).toBe('add-auth');
  });

  it('sets stage_id from stage.id', async () => {
    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_ONCE,
      worktreePath: tmpDir,
      git: STUB_GIT,
    });
    expect(ctx['stage_id']).toBe('plan');
  });

  it('architecture_md is "" when architecture.md absent', async () => {
    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_ONCE,
      worktreePath: tmpDir,
      git: STUB_GIT,
    });
    expect(ctx['architecture_md']).toBe('');
  });

  it('architecture_md contains file contents when present', async () => {
    fs.writeFileSync(path.join(tmpDir, 'architecture.md'), '# Architecture\n\ncontent here');
    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_ONCE,
      worktreePath: tmpDir,
      git: STUB_GIT,
    });
    expect(ctx['architecture_md']).toBe('# Architecture\n\ncontent here');
  });

  it('architectureMdPath override is used instead of default path', async () => {
    const overridePath = path.join(tmpDir, 'custom-arch.md');
    fs.writeFileSync(overridePath, 'custom arch content');
    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_ONCE,
      worktreePath: tmpDir,
      architectureMdPath: overridePath,
      git: STUB_GIT,
    });
    expect(ctx['architecture_md']).toBe('custom arch content');
  });

  it('git_log_recent comes from git.logRecent(20)', async () => {
    let capturedN = -1;
    const git: GitHelper = {
      logRecent: async (n: number) => {
        capturedN = n;
        return 'abc123 commit\n';
      },
      diffRange: STUB_GIT.diffRange,
    };
    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_ONCE,
      worktreePath: tmpDir,
      git,
    });
    expect(capturedN).toBe(20);
    expect(ctx['git_log_recent']).toBe('abc123 commit\n');
  });

  it('user_injected_context defaults to ""', async () => {
    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_ONCE,
      worktreePath: tmpDir,
      git: STUB_GIT,
    });
    expect(ctx['user_injected_context']).toBe('');
  });

  it('user_injected_context uses provided value', async () => {
    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_ONCE,
      worktreePath: tmpDir,
      git: STUB_GIT,
      userInjectedContext: 'focus on the auth module',
    });
    expect(ctx['user_injected_context']).toBe('focus on the auth module');
  });
});

// ---------------------------------------------------------------------------
// § 2  Per-item phase variables
// ---------------------------------------------------------------------------

describe('buildPromptContext — per-item phase variables', () => {
  it('item key contains the parsed opaque data blob (AC-1, AC-4)', async () => {
    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_PER_ITEM,
      item: ITEM_ROW,
      worktreePath: tmpDir,
      git: STUB_GIT,
    });
    // The builder must NOT interpret any named field — it stores the whole parsed object.
    expect(ctx['item']).toEqual(ITEM_DATA_OBJ);
  });

  it('item_id is set from item.id', async () => {
    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_PER_ITEM,
      item: ITEM_ROW,
      worktreePath: tmpDir,
      git: STUB_GIT,
    });
    expect(ctx['item_id']).toBe('feat-001');
  });

  it('item_state contains harness-level columns (not item.data fields)', async () => {
    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_PER_ITEM,
      item: ITEM_ROW,
      worktreePath: tmpDir,
      git: STUB_GIT,
    });
    const itemState = ctx['item_state'] as Record<string, unknown>;
    expect(itemState['status']).toBe('in_progress');
    expect(itemState['current_phase']).toBe('implement');
    expect(itemState['retry_count']).toBe(0);
    expect(itemState['blocked_reason']).toBeNull();
  });

  it('item_state reflects updated retry_count', async () => {
    const retriedItem: ItemRow = { ...ITEM_ROW, retry_count: 3, status: 'awaiting_retry' };
    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_PER_ITEM,
      item: retriedItem,
      worktreePath: tmpDir,
      git: STUB_GIT,
    });
    const itemState = ctx['item_state'] as Record<string, unknown>;
    expect(itemState['retry_count']).toBe(3);
    expect(itemState['status']).toBe('awaiting_retry');
  });

  it('recent_diff is "" when diffFrom is not provided', async () => {
    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_PER_ITEM,
      item: ITEM_ROW,
      worktreePath: tmpDir,
      git: STUB_GIT,
    });
    expect(ctx['recent_diff']).toBe('');
  });

  it('recent_diff calls git.diffRange(diffFrom, diffTo) when provided', async () => {
    let capturedFrom = '';
    let capturedTo = '';
    const git: GitHelper = {
      logRecent: STUB_GIT.logRecent,
      diffRange: async (from: string, to: string) => {
        capturedFrom = from;
        capturedTo = to;
        return 'diff output here';
      },
    };
    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_PER_ITEM,
      item: ITEM_ROW,
      worktreePath: tmpDir,
      git,
      diffFrom: 'abc123',
      diffTo: 'def456',
    });
    expect(capturedFrom).toBe('abc123');
    expect(capturedTo).toBe('def456');
    expect(ctx['recent_diff']).toBe('diff output here');
  });

  it('recent_diff defaults diffTo to HEAD when only diffFrom is given', async () => {
    let capturedTo = '';
    const git: GitHelper = {
      logRecent: STUB_GIT.logRecent,
      diffRange: async (_from: string, to: string) => {
        capturedTo = to;
        return 'diff';
      },
    };
    await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_PER_ITEM,
      item: ITEM_ROW,
      worktreePath: tmpDir,
      git,
      diffFrom: 'abc123',
    });
    expect(capturedTo).toBe('HEAD');
  });
});

// ---------------------------------------------------------------------------
// § 3  AC-6: {{handoff}} from handoff.json entries
// ---------------------------------------------------------------------------

describe('buildPromptContext — AC-6 {{handoff}} from handoff.json', () => {
  it('handoff is "" when handoff.json absent', async () => {
    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_PER_ITEM,
      item: ITEM_ROW,
      worktreePath: tmpDir,
      git: STUB_GIT,
    });
    expect(ctx['handoff']).toBe('');
  });

  it('handoff is "[]" when handoff.json has empty entries array', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'handoff.json'),
      JSON.stringify({ feature: 'feat-001', entries: [] }),
    );
    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_PER_ITEM,
      item: ITEM_ROW,
      worktreePath: tmpDir,
      git: STUB_GIT,
    });
    expect(ctx['handoff']).toBe(JSON.stringify([], null, 2));
  });

  it('handoff contains serialized entries from handoff.json', async () => {
    const entries = [
      {
        phase: 'implement',
        attempt: 0,
        ts: '2026-04-13T00:00:00Z',
        intended_files: ['src/auth/login.ts'],
        deferred_criteria: [],
        known_risks: ['session token format TBD'],
      },
    ];
    fs.writeFileSync(
      path.join(tmpDir, 'handoff.json'),
      JSON.stringify({ feature: 'feat-001', entries }),
    );
    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_PER_ITEM,
      item: ITEM_ROW,
      worktreePath: tmpDir,
      git: STUB_GIT,
    });
    expect(ctx['handoff']).toBe(JSON.stringify(entries, null, 2));
  });

  it('handoff is "[]" when handoff.json has no entries key', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'handoff.json'),
      JSON.stringify({ feature: 'feat-001' }),
    );
    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_PER_ITEM,
      item: ITEM_ROW,
      worktreePath: tmpDir,
      git: STUB_GIT,
    });
    expect(ctx['handoff']).toBe(JSON.stringify([], null, 2));
  });

  it('handoffPath override is used instead of default path', async () => {
    const overridePath = path.join(tmpDir, 'custom-handoff.json');
    const entries = [{ phase: 'review', attempt: 1, ts: '2026-04-14T00:00:00Z' }];
    fs.writeFileSync(overridePath, JSON.stringify({ entries }));
    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_PER_ITEM,
      item: ITEM_ROW,
      worktreePath: tmpDir,
      handoffPath: overridePath,
      git: STUB_GIT,
    });
    expect(ctx['handoff']).toBe(JSON.stringify(entries, null, 2));
  });
});

// ---------------------------------------------------------------------------
// § 4  AC-4 / RC-3: opaque item.data handling
// ---------------------------------------------------------------------------

describe('buildPromptContext — AC-4/RC-3 opaque blob handling', () => {
  it('item data blob with arbitrary field names round-trips correctly', async () => {
    // The builder must handle any JSON shape without caring about field names.
    const arbitraryData = {
      my_custom_field: 'custom value',
      priority: 42,
      tags: ['alpha', 'beta'],
      nested: { sub: 'value' },
    };
    const itemRow: ItemRow = {
      id: 'feat-002',
      data: JSON.stringify(arbitraryData),
      status: 'in_progress',
      current_phase: 'implement',
      retry_count: 0,
      blocked_reason: null,
    };
    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_PER_ITEM,
      item: itemRow,
      worktreePath: tmpDir,
      git: STUB_GIT,
    });
    // The full parsed object is stored — no field stripping.
    expect(ctx['item']).toEqual(arbitraryData);
  });

  it('item.data with boolean and number values is preserved', async () => {
    const data = { active: true, count: 7, ratio: 0.5 };
    const itemRow: ItemRow = {
      ...ITEM_ROW,
      id: 'feat-003',
      data: JSON.stringify(data),
    };
    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_PER_ITEM,
      item: itemRow,
      worktreePath: tmpDir,
      git: STUB_GIT,
    });
    expect(ctx['item']).toEqual(data);
  });

  it('invalid item.data JSON throws SyntaxError', async () => {
    const badItem: ItemRow = { ...ITEM_ROW, data: 'not-json{' };
    await expect(
      buildPromptContext({
        workflow: WORKFLOW,
        stage: STAGE_PER_ITEM,
        item: badItem,
        worktreePath: tmpDir,
        git: STUB_GIT,
      }),
    ).rejects.toThrow(SyntaxError);
  });
});

// ---------------------------------------------------------------------------
// § 5  once-stage: per-item variables are absent
// ---------------------------------------------------------------------------

describe('buildPromptContext — once-stage excludes per-item variables', () => {
  it('item, item_id, item_state, handoff, recent_diff absent for once-stage', async () => {
    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_ONCE,
      worktreePath: tmpDir,
      git: STUB_GIT,
    });
    expect('item' in ctx).toBe(false);
    expect('item_id' in ctx).toBe(false);
    expect('item_state' in ctx).toBe(false);
    expect('handoff' in ctx).toBe(false);
    expect('recent_diff' in ctx).toBe(false);
  });

  it('base variables are present even in once-stage', async () => {
    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_ONCE,
      worktreePath: tmpDir,
      git: STUB_GIT,
    });
    expect('workflow_name' in ctx).toBe(true);
    expect('stage_id' in ctx).toBe(true);
    expect('architecture_md' in ctx).toBe(true);
    expect('git_log_recent' in ctx).toBe(true);
    expect('user_injected_context' in ctx).toBe(true);
  });

  it('per-item stage with no item provided omits per-item variables', async () => {
    // No item passed despite stage.run === 'per-item'
    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_PER_ITEM,
      worktreePath: tmpDir,
      git: STUB_GIT,
      // item: undefined (not passed)
    });
    expect('item' in ctx).toBe(false);
    expect('item_id' in ctx).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// § 6  End-to-end: context feeds assemblePrompt correctly
// ---------------------------------------------------------------------------

describe('buildPromptContext + assemblePrompt — end-to-end', () => {
  it('assembled prompt contains all substituted values', async () => {
    const { assemblePrompt } = await import('../../src/server/prompt/assembler.js');

    fs.writeFileSync(path.join(tmpDir, 'architecture.md'), '# Architecture\n\nmodules here');
    const entries = [{ phase: 'implement', attempt: 0, ts: '2026-04-13T00:00:00Z' }];
    fs.writeFileSync(
      path.join(tmpDir, 'handoff.json'),
      JSON.stringify({ feature: 'feat-001', entries }),
    );

    const ctx = await buildPromptContext({
      workflow: WORKFLOW,
      stage: STAGE_PER_ITEM,
      item: ITEM_ROW,
      worktreePath: tmpDir,
      git: STUB_GIT,
      diffFrom: 'abc123',
      diffTo: 'HEAD',
      userInjectedContext: 'prioritize security',
    });

    const template = `Workflow: {{workflow_name}}
Stage: {{stage_id}}
Item: {{item_id}}
Description: {{item.description}}
Status: {{item_state.status}}
Architecture: {{architecture_md}}
Handoff: {{handoff}}
Git log: {{git_log_recent}}
Diff: {{recent_diff}}
User context: {{user_injected_context}}`;

    const result = assemblePrompt(template, ctx);

    expect(result).toContain('Workflow: add-auth');
    expect(result).toContain('Stage: implementation');
    expect(result).toContain('Item: feat-001');
    expect(result).toContain('Description: User can log in with email and password');
    expect(result).toContain('Status: in_progress');
    expect(result).toContain('# Architecture');
    expect(result).toContain('"phase": "implement"');
    expect(result).toContain('abc123 initial commit');
    expect(result).toContain('diff --git');
    expect(result).toContain('prioritize security');
    // No [MISSING:...] markers — all keys populated
    expect(result).not.toContain('[MISSING:');
  });
});
