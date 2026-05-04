/**
 * Demo fixture — typed shape consumed by scripts/demo/seed.ts.
 *
 * Timestamps are integer offsets in seconds from "now" (negative = past,
 * 0 = now, positive = future). The seeder resolves them into ISO strings
 * against a single Date.now() baseline so a freshly-seeded DB is always
 * internally consistent.
 *
 * Nothing here imports production scheduler code — we describe rows directly
 * in the shape the migrations expect. The web UI is what we're capturing,
 * and the WS-projected snapshot is derived from these rows.
 */

import type { State } from '../../src/shared/types/states.js';
import type { WorkflowStatus } from '../../src/shared/types/workflow.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Timestamp offset in seconds from the seed-time "now". Negative = past. */
export type OffsetSec = number;

export interface DemoStage {
  id: string;
  description?: string;
  run: 'once' | 'per-item';
  phases: string[];
  /** items_from etc only matter for per-item stages — copied from template. */
  items_from?: string;
  items_list?: string;
  items_id?: string;
  items_display?: { title?: string; subtitle?: string; description?: string };
}

export interface DemoPhase {
  description?: string;
  command: string;
  args: string[];
  prompt_template: string;
  ui?: { renderer?: 'review' | 'stream' };
}

export interface DemoItem {
  /** Row UUID. Stable across re-seeds so screenshot URLs don't drift. */
  id: string;
  stageId: string;
  stableId: string | null;
  status: State;
  currentPhase: string | null;
  /** Item-data JSON used by the FeatureBoard's items_display path resolution. */
  data: Record<string, unknown>;
  dependsOn?: string[];
  blockedReason?: string | null;
  updatedAtOffset: OffsetSec;
}

export interface DemoSession {
  id: string;
  itemId: string | null;
  stage: string;
  phase: string;
  status: 'running' | 'ended';
  startedAtOffset: OffsetSec;
  endedAtOffset?: OffsetSec;
  exitCode?: number | null;
  /** When set, seeder writes this JSONL to the session log path and updates the row. */
  logFrames?: DemoLogFrame[];
}

export interface DemoLogFrame {
  v: 1;
  type: string;
  sessionId: string;
  seq: number;
  ts: string; // ISO; seeder may rewrite to be relative to baseline
  payload: unknown;
}

export interface DemoPendingAttention {
  workflowId: string;
  kind: string;
  payload: unknown;
  createdAtOffset: OffsetSec;
}

export interface DemoWorkflow {
  id: string;
  name: string;
  templateName: string;
  status: WorkflowStatus;
  currentStage: string | null;
  /** Frozen workflow when set — scheduler will not pick it up. */
  pausedAtOffset?: OffsetSec | null;
  archivedAtOffset?: OffsetSec | null;
  createdAtOffset: OffsetSec;
  updatedAtOffset: OffsetSec;
  /** Pipeline stage list — serialized as `pipeline` column JSON. */
  stages: DemoStage[];
  /** Phase definitions — serialized into the `pipeline` column alongside stages. */
  phases: Record<string, DemoPhase>;
  items: DemoItem[];
  sessions: DemoSession[];
  github?: {
    state: 'disabled' | 'unconfigured' | 'idle' | 'creating' | 'created' | 'failed';
    prNumber?: number;
    prUrl?: string;
    prState?: 'open' | 'merged' | 'closed';
  };
  worktreePath?: string;
  branchName?: string;
}

export interface DemoFixture {
  workflows: DemoWorkflow[];
  pendingAttention: DemoPendingAttention[];
}

// ---------------------------------------------------------------------------
// Stable IDs (so re-seeding leaves screenshot URLs untouched)
// ---------------------------------------------------------------------------

export const RUNNING_WORKFLOW_ID = '11111111-1111-4111-8111-111111111111';
export const ARCHIVED_OAUTH_WORKFLOW_ID = '22222222-2222-4222-8222-222222222222';
export const ARCHIVED_REFACTOR_WORKFLOW_ID = '33333333-3333-4333-8333-333333333333';

const PLAN_ITEM_ID = 'a0000000-0000-4000-8000-000000000001';
const FEAT_VERIFY_ID = 'b0000000-0000-4000-8000-000000000001';
const FEAT_OUTBOX_ID = 'b0000000-0000-4000-8000-000000000002';
const FEAT_IDEMPOTENCY_ID = 'b0000000-0000-4000-8000-000000000003';
const FEAT_BACKFILL_ID = 'b0000000-0000-4000-8000-000000000004';

export const RUNNING_IN_PROGRESS_ITEM_ID = FEAT_IDEMPOTENCY_ID;

const SESSION_PLAN = 'c0000000-0000-4000-8000-000000000001';
const SESSION_VERIFY_IMPL = 'c0000000-0000-4000-8000-000000000010';
const SESSION_VERIFY_REVIEW = 'c0000000-0000-4000-8000-000000000011';
const SESSION_OUTBOX_IMPL = 'c0000000-0000-4000-8000-000000000020';
const SESSION_OUTBOX_REVIEW = 'c0000000-0000-4000-8000-000000000021';
export const RUNNING_SESSION_ID = 'c0000000-0000-4000-8000-000000000030';

// ---------------------------------------------------------------------------
// Plan/build stage definitions for the running workflow
// ---------------------------------------------------------------------------

const PLAN_BUILD_STAGES: DemoStage[] = [
  {
    id: 'plan',
    description: 'Run-once planner. Produces docs/idea/features.json.',
    run: 'once',
    phases: ['plan'],
  },
  {
    id: 'build',
    description: 'Per-item implement+review loop.',
    run: 'per-item',
    phases: ['implement', 'review'],
    items_from: 'docs/idea/features.json',
    items_list: '$.features',
    items_id: '$.id',
    items_display: { title: '$.title', description: '$.description' },
  },
];

const PLAN_BUILD_PHASES: Record<string, DemoPhase> = {
  plan: {
    description: 'Plan the feature set.',
    command: 'echo',
    args: ['demo: plan'],
    prompt_template: 'prompts/plan.md',
  },
  implement: {
    description: 'Implement one feature.',
    command: 'echo',
    args: ['demo: implement'],
    prompt_template: 'prompts/implement.md',
  },
  review: {
    description: 'Review the implementation.',
    command: 'echo',
    args: ['demo: review'],
    prompt_template: 'prompts/review.md',
  },
};

// ---------------------------------------------------------------------------
// Live JSONL transcript for the in-progress session
// ---------------------------------------------------------------------------

const LOG_BASE_TS_OFFSET = -180; // first frame ~3 minutes ago

function frame(seq: number, type: string, payload: unknown, tsOffsetSec: number): DemoLogFrame {
  return {
    v: 1,
    type,
    sessionId: RUNNING_SESSION_ID,
    seq,
    ts: new Date(Date.now() + tsOffsetSec * 1000).toISOString(),
    payload,
  };
}

const RUNNING_LOG_FRAMES: DemoLogFrame[] = [
  frame(1, 'stream.initial_prompt', {
    sessionId: RUNNING_SESSION_ID,
    prompt:
      '# Implement: Idempotency on retry\n\n' +
      'You are working on the "Add billing webhooks" workflow.\n' +
      'Implement deduplication so that retried Stripe webhook deliveries do\n' +
      'not double-process. Persist a (event_id, processed_at) row and short-\n' +
      'circuit when the row already exists.\n\n' +
      'Files to consider:\n' +
      '  - src/server/billing/webhook.ts\n' +
      '  - src/server/storage/migrations/0007_webhook_dedup.sql (new)\n',
    assembledAt: new Date(Date.now() + LOG_BASE_TS_OFFSET * 1000).toISOString(),
  }, LOG_BASE_TS_OFFSET),

  frame(2, 'stream.text', {
    sessionId: RUNNING_SESSION_ID,
    blockId: 'tx-1',
    textDelta:
      "I'll start by reading the existing webhook handler so I understand the current control flow.",
    final: true,
  }, LOG_BASE_TS_OFFSET + 4),

  frame(3, 'stream.tool_use', {
    sessionId: RUNNING_SESSION_ID,
    toolUseId: 'tu-read-1',
    name: 'Read',
    input: { file_path: '/repo/src/server/billing/webhook.ts' },
    status: 'running',
  }, LOG_BASE_TS_OFFSET + 6),

  frame(4, 'stream.tool_result', {
    sessionId: RUNNING_SESSION_ID,
    toolUseId: 'tu-read-1',
    status: 'ok',
    output:
      'export async function handleWebhook(req, res) {\n' +
      '  const sig = req.headers["stripe-signature"];\n' +
      '  const event = stripe.webhooks.constructEvent(req.rawBody, sig, secret);\n' +
      '  await persistOutbox(event);\n' +
      '  res.status(200).end();\n' +
      '}\n',
  }, LOG_BASE_TS_OFFSET + 9),

  frame(5, 'stream.text', {
    sessionId: RUNNING_SESSION_ID,
    blockId: 'tx-2',
    textDelta:
      'Good — the handler already verifies the signature and persists to the outbox. ' +
      'I need to insert a dedup check between signature verification and outbox write.',
    final: true,
  }, LOG_BASE_TS_OFFSET + 12),

  frame(6, 'stream.thinking', {
    sessionId: RUNNING_SESSION_ID,
    blockId: 'th-1',
    textDelta:
      'The cleanest place to enforce idempotency is at the SQL layer with a UNIQUE ' +
      'constraint on event_id, then catch SQLITE_CONSTRAINT and short-circuit. ' +
      "That way two concurrent deliveries can't race past an in-process check.",
    final: true,
  }, LOG_BASE_TS_OFFSET + 14),

  frame(7, 'stream.text', {
    sessionId: RUNNING_SESSION_ID,
    blockId: 'tx-3',
    textDelta:
      "Plan: (1) add migration 0007 with `webhook_dedup(event_id PRIMARY KEY, processed_at)`, " +
      '(2) wrap the insert in a try/catch keyed on UNIQUE violation, (3) return 200 on duplicate ' +
      'so Stripe stops retrying.',
    final: true,
  }, LOG_BASE_TS_OFFSET + 18),

  frame(8, 'stream.text', {
    sessionId: RUNNING_SESSION_ID,
    blockId: 'tx-4',
    textDelta: "Writing the migration first.",
    final: true,
  }, LOG_BASE_TS_OFFSET + 22),

  frame(9, 'stream.tool_use', {
    sessionId: RUNNING_SESSION_ID,
    toolUseId: 'tu-edit-1',
    name: 'Edit',
    input: {
      file_path: '/repo/src/server/storage/migrations/0007_webhook_dedup.sql',
      old_string: '',
      new_string:
        '-- Migration 0007 — webhook idempotency table\n' +
        'CREATE TABLE webhook_dedup (\n' +
        '  event_id     TEXT PRIMARY KEY,\n' +
        '  processed_at TEXT NOT NULL\n' +
        ');\n',
    },
    status: 'running',
  }, LOG_BASE_TS_OFFSET + 24),

  frame(10, 'stream.text', {
    sessionId: RUNNING_SESSION_ID,
    blockId: 'tx-5',
    textDelta:
      'Migration written. Now patching the handler to check for the existing event ' +
      'before persisting to the outbox.',
    final: true,
  }, LOG_BASE_TS_OFFSET + 30),

  frame(11, 'stream.text', {
    sessionId: RUNNING_SESSION_ID,
    blockId: 'tx-6',
    textDelta:
      "I'm using ON CONFLICT DO NOTHING on the dedup table — that gives us an atomic " +
      'check-and-insert without a separate SELECT round-trip. The handler then inspects ' +
      '`changes()` to know whether this delivery was new or a duplicate.',
    final: true,
  }, LOG_BASE_TS_OFFSET + 38),
];

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

export const FIXTURE: DemoFixture = {
  workflows: [
    // ---------------------------------------------------------------------
    // Running workflow — the one shown in most screenshots.
    // ---------------------------------------------------------------------
    {
      id: RUNNING_WORKFLOW_ID,
      name: 'Add billing webhooks',
      templateName: 'plan-build-review',
      status: 'in_progress',
      currentStage: 'build',
      pausedAtOffset: -2, // frozen so the scheduler ignores it
      createdAtOffset: -3600,
      updatedAtOffset: -30,
      stages: PLAN_BUILD_STAGES,
      phases: PLAN_BUILD_PHASES,
      worktreePath: '/repo/.worktrees/add-billing-webhooks',
      branchName: 'yoke/add-billing-webhooks',
      github: {
        state: 'created',
        prNumber: 42,
        prUrl: 'https://github.com/jdforsythe/yoke/pull/42',
        prState: 'open',
      },
      items: [
        {
          id: PLAN_ITEM_ID,
          stageId: 'plan',
          stableId: null,
          status: 'complete',
          currentPhase: 'plan',
          data: {},
          updatedAtOffset: -3500,
        },
        {
          id: FEAT_VERIFY_ID,
          stageId: 'build',
          stableId: 'verify-stripe-signature',
          status: 'complete',
          currentPhase: 'review',
          data: {
            id: 'verify-stripe-signature',
            title: 'Verify Stripe signature',
            description:
              'Validate the stripe-signature header against the webhook secret before any side effects.',
          },
          dependsOn: [PLAN_ITEM_ID],
          updatedAtOffset: -2400,
        },
        {
          id: FEAT_OUTBOX_ID,
          stageId: 'build',
          stableId: 'persist-event-to-outbox',
          status: 'complete',
          currentPhase: 'review',
          data: {
            id: 'persist-event-to-outbox',
            title: 'Persist event to outbox',
            description:
              'Append every verified event to a durable outbox table for downstream replay.',
          },
          dependsOn: [FEAT_VERIFY_ID],
          updatedAtOffset: -1500,
        },
        {
          id: FEAT_IDEMPOTENCY_ID,
          stageId: 'build',
          stableId: 'idempotency-on-retry',
          status: 'in_progress',
          currentPhase: 'implement',
          data: {
            id: 'idempotency-on-retry',
            title: 'Idempotency on retry',
            description:
              'Deduplicate retried webhook deliveries using a (event_id, processed_at) table.',
          },
          dependsOn: [FEAT_OUTBOX_ID],
          updatedAtOffset: -30,
        },
        {
          id: FEAT_BACKFILL_ID,
          stageId: 'build',
          stableId: 'backfill-old-events',
          status: 'pending',
          currentPhase: 'implement',
          data: {
            id: 'backfill-old-events',
            title: 'Backfill old events',
            description:
              'One-shot script to backfill the outbox from the last 30 days of Stripe history.',
          },
          dependsOn: [FEAT_IDEMPOTENCY_ID],
          updatedAtOffset: -3500,
        },
      ],
      sessions: [
        {
          id: SESSION_PLAN,
          itemId: PLAN_ITEM_ID,
          stage: 'plan',
          phase: 'plan',
          status: 'ended',
          startedAtOffset: -3580,
          endedAtOffset: -3510,
          exitCode: 0,
        },
        {
          id: SESSION_VERIFY_IMPL,
          itemId: FEAT_VERIFY_ID,
          stage: 'build',
          phase: 'implement',
          status: 'ended',
          startedAtOffset: -3000,
          endedAtOffset: -2700,
          exitCode: 0,
        },
        {
          id: SESSION_VERIFY_REVIEW,
          itemId: FEAT_VERIFY_ID,
          stage: 'build',
          phase: 'review',
          status: 'ended',
          startedAtOffset: -2680,
          endedAtOffset: -2400,
          exitCode: 0,
        },
        {
          id: SESSION_OUTBOX_IMPL,
          itemId: FEAT_OUTBOX_ID,
          stage: 'build',
          phase: 'implement',
          status: 'ended',
          startedAtOffset: -2300,
          endedAtOffset: -1900,
          exitCode: 0,
        },
        {
          id: SESSION_OUTBOX_REVIEW,
          itemId: FEAT_OUTBOX_ID,
          stage: 'build',
          phase: 'review',
          status: 'ended',
          startedAtOffset: -1880,
          endedAtOffset: -1500,
          exitCode: 0,
        },
        {
          id: RUNNING_SESSION_ID,
          itemId: FEAT_IDEMPOTENCY_ID,
          stage: 'build',
          phase: 'implement',
          status: 'running',
          startedAtOffset: -180,
          logFrames: RUNNING_LOG_FRAMES,
        },
      ],
    },

    // ---------------------------------------------------------------------
    // Archived: Add OAuth flow (one-shot, completed)
    // ---------------------------------------------------------------------
    {
      id: ARCHIVED_OAUTH_WORKFLOW_ID,
      name: 'Add OAuth flow',
      templateName: 'one-shot',
      status: 'completed',
      currentStage: 'build',
      archivedAtOffset: -2 * 86400,
      createdAtOffset: -3 * 86400,
      updatedAtOffset: -2 * 86400 - 3600,
      stages: [
        {
          id: 'build',
          description: 'Single agent session implements the whole change.',
          run: 'once',
          phases: ['implement', 'test'],
        },
      ],
      phases: {
        implement: {
          command: 'echo',
          args: ['demo: implement'],
          prompt_template: 'prompts/implement.md',
        },
        test: {
          command: 'echo',
          args: ['demo: test'],
          prompt_template: 'prompts/test.md',
        },
      },
      items: Array.from({ length: 7 }, (_, i) => ({
        id: `d0000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
        stageId: 'build',
        stableId: `oauth-step-${i + 1}`,
        status: 'complete' as State,
        currentPhase: 'test',
        data: { id: `oauth-step-${i + 1}`, title: `OAuth step ${i + 1}` },
        updatedAtOffset: -2 * 86400 - 3600,
      })),
      sessions: [],
    },

    // ---------------------------------------------------------------------
    // Archived: Refactor session log (multi-reviewer, completed_with_blocked)
    // ---------------------------------------------------------------------
    {
      id: ARCHIVED_REFACTOR_WORKFLOW_ID,
      name: 'Refactor session log',
      templateName: 'multi-reviewer',
      status: 'completed_with_blocked',
      currentStage: 'build',
      archivedAtOffset: -2 * 86400,
      createdAtOffset: -4 * 86400,
      updatedAtOffset: -2 * 86400 - 7200,
      stages: [
        {
          id: 'build',
          description: 'Implement, then fan out to three reviewer subagents.',
          run: 'per-item',
          phases: ['implement', 'reviewers'],
          items_from: 'docs/idea/features.json',
          items_list: '$.features',
          items_id: '$.id',
          items_display: { title: '$.title' },
        },
      ],
      phases: {
        implement: {
          command: 'echo',
          args: ['demo: implement'],
          prompt_template: 'prompts/implement.md',
        },
        reviewers: {
          command: 'echo',
          args: ['demo: multi-reviewer'],
          prompt_template: 'prompts/multi_reviewer.md',
          ui: { renderer: 'review' },
        },
      },
      items: [
        {
          id: 'e0000000-0000-4000-8000-000000000001',
          stageId: 'build',
          stableId: 'extract-writer-class',
          status: 'complete',
          currentPhase: 'reviewers',
          data: { id: 'extract-writer-class', title: 'Extract SessionLogWriter class' },
          updatedAtOffset: -2 * 86400 - 7200,
        },
        {
          id: 'e0000000-0000-4000-8000-000000000002',
          stageId: 'build',
          stableId: 'add-fingerprint-fn',
          status: 'complete',
          currentPhase: 'reviewers',
          data: { id: 'add-fingerprint-fn', title: 'Add makeFingerprint helper' },
          updatedAtOffset: -2 * 86400 - 7200,
        },
        {
          id: 'e0000000-0000-4000-8000-000000000003',
          stageId: 'build',
          stableId: 'wire-into-spawn',
          status: 'blocked',
          currentPhase: 'implement',
          data: { id: 'wire-into-spawn', title: 'Wire writer into ProcessManager.spawn' },
          blockedReason: 'reviewer disagreed on close() ordering — needs human triage',
          updatedAtOffset: -2 * 86400 - 7200,
        },
      ],
      sessions: [],
    },
  ],

  pendingAttention: [
    {
      workflowId: RUNNING_WORKFLOW_ID,
      kind: 'revisit_limit',
      payload: {
        itemId: RUNNING_IN_PROGRESS_ITEM_ID,
        stageId: 'build',
        phase: 'implement',
        reason: 'review→implement loop hit max_revisits=3 for "Idempotency on retry"',
      },
      createdAtOffset: -45,
    },
  ],
};
