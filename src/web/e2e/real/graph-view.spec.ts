/**
 * Real-backend Playwright spec for the Graph View.
 *
 * Boots a real Fastify + SQLite server (via the realBackend fixture), seeds a
 * workflow whose pipeline includes a review phase with a post-command `goto`
 * back to `implement`, then seeds the DB rows that represent a completed
 * 2-cycle goto loop (two implement sessions, two review sessions, two prepost
 * runs).  Asserts that hydrateGraph produces a graph with both runtime
 * prepost nodes, both retry-linked implement sessions, and at least one
 * dotted goto edge — i.e. the full derive → snapshot → graphStore → layout
 * pipeline survives a realistic history.
 */

import { test, expect } from '../fixtures/realBackend.js';
import type { BackendHandle } from '../fixtures/realBackend.js';
import { randomUUID } from 'node:crypto';

const PIPELINE = JSON.stringify({
  stages: [{ id: 'work', run: 'once', phases: ['implement', 'review'] }],
  phases: {
    implement: {
      command: 'echo',
      args: [],
      prompt_template: 'prompt.md',
    },
    review: {
      command: 'echo',
      args: [],
      prompt_template: 'prompt.md',
      post: [
        {
          name: 'check-verdict',
          run: ['bash', '-c', 'true'],
          actions: { '0': 'continue', '1': { goto: 'implement', max_revisits: 3 } },
        },
      ],
    },
  },
});

function seedWorkflow(
  db: BackendHandle['db'],
  opts: { id: string; name: string; status: string },
): void {
  const now = new Date().toISOString();
  db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', ?, '{}', ?, ?, ?)`,
    )
    .run(opts.id, opts.name, PIPELINE, opts.status, now, now);
}

function seedSession(
  db: BackendHandle['db'],
  opts: {
    id: string;
    workflowId: string;
    phase: string;
    startedAt: string;
    endedAt: string;
    exitCode: number;
    parentSessionId?: string | null;
  },
): void {
  db.writer
    .prepare(
      `INSERT INTO sessions
       (id, workflow_id, item_id, parent_session_id, stage, phase, agent_profile,
        started_at, ended_at, exit_code, status)
       VALUES (?, ?, NULL, ?, 'work', ?, 'default', ?, ?, ?, 'complete')`,
    )
    .run(
      opts.id,
      opts.workflowId,
      opts.parentSessionId ?? null,
      opts.phase,
      opts.startedAt,
      opts.endedAt,
      opts.exitCode,
    );
}

function seedPrepostRun(
  db: BackendHandle['db'],
  opts: {
    workflowId: string;
    sessionId: string;
    startedAt: string;
    endedAt: string;
    commandName: string;
    actionTaken: unknown;
  },
): void {
  db.writer
    .prepare(
      `INSERT INTO prepost_runs
         (session_id, workflow_id, item_id, stage, phase, when_phase,
          command_name, argv, started_at, ended_at, exit_code, action_taken)
       VALUES (?, ?, NULL, 'work', 'review', 'post', ?, '[]', ?, ?, 1, ?)`,
    )
    .run(
      opts.sessionId,
      opts.workflowId,
      opts.commandName,
      opts.startedAt,
      opts.endedAt,
      JSON.stringify(opts.actionTaken),
    );
}

test.describe('Graph View — real backend', () => {
  test('two-cycle goto loop hydrates with stacked sessions, two prepost runs, and a dotted goto edge', async ({
    page,
    backend,
  }) => {
    const wfId = `wf-graph-goto-${randomUUID().slice(0, 8)}`;
    seedWorkflow(backend.db, { id: wfId, name: 'Graph Goto Loop', status: 'in_progress' });

    // Cycle 1.
    seedSession(backend.db, {
      id: 's1', workflowId: wfId, phase: 'implement',
      startedAt: '2026-04-22T10:00:00Z', endedAt: '2026-04-22T10:01:00Z', exitCode: 0,
    });
    seedSession(backend.db, {
      id: 's2', workflowId: wfId, phase: 'review',
      startedAt: '2026-04-22T10:02:00Z', endedAt: '2026-04-22T10:03:00Z', exitCode: 0,
    });
    seedPrepostRun(backend.db, {
      workflowId: wfId, sessionId: 's2',
      startedAt: '2026-04-22T10:02:30Z', endedAt: '2026-04-22T10:03:00Z',
      commandName: 'check-verdict',
      actionTaken: { kind: 'goto', goto: 'implement', maxRevisits: 3 },
    });

    // Cycle 2 — after the goto back to implement.
    seedSession(backend.db, {
      id: 's3', workflowId: wfId, phase: 'implement', parentSessionId: 's1',
      startedAt: '2026-04-22T10:04:00Z', endedAt: '2026-04-22T10:05:00Z', exitCode: 0,
    });
    seedSession(backend.db, {
      id: 's4', workflowId: wfId, phase: 'review', parentSessionId: 's2',
      startedAt: '2026-04-22T10:06:00Z', endedAt: '2026-04-22T10:07:00Z', exitCode: 0,
    });
    seedPrepostRun(backend.db, {
      workflowId: wfId, sessionId: 's4',
      startedAt: '2026-04-22T10:06:30Z', endedAt: '2026-04-22T10:07:00Z',
      commandName: 'check-verdict',
      actionTaken: { kind: 'goto', goto: 'implement', maxRevisits: 3 },
    });

    await page.goto(`/workflow/${wfId}?view=graph`);

    // Graph pane renders once the workflow.snapshot (carrying hydrated graph)
    // arrives and the layout completes.
    await expect(page.getByTestId('graph-pane')).toBeVisible({ timeout: 10_000 });

    // Four session nodes (2 implement + 2 review) stack under their phase
    // without the review phase duplicating.
    await expect(page.getByTestId('graph-node-session')).toHaveCount(4);

    // Both runtime prepost nodes materialized from the two prepost_runs rows.
    await expect(page.getByTestId('graph-node-prepost')).toHaveCount(2);

    // At least one goto edge renders with a dashed stroke — xyflow emits
    // edges under `g.react-flow__edge` with a nested `path.react-flow__edge-path`
    // whose style carries the stroke-dasharray.
    const dashedPaths = page.locator(
      'g.react-flow__edge path.react-flow__edge-path[style*="stroke-dasharray"]',
    );
    expect(await dashedPaths.count()).toBeGreaterThanOrEqual(1);
  });
});
