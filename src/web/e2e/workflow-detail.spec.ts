/**
 * Smoke tests: WorkflowDetailRoute and child components.
 *
 * Covers:
 *  - Loading state before snapshot arrives
 *  - Workflow header (name, status chip, back button)
 *  - CrashRecoveryBanner — rendered when recoveryState is non-null
 *  - CrashRecoveryBanner — Cancel confirmation dialog
 *  - AttentionBanner — pending attention items
 *  - GithubButton — hidden when disabled, shows PR link when created
 *  - FeatureBoard — items grouped by stage, fuzzy search
 *  - ControlMatrix — Pause/Cancel for in_progress workflow with active session
 *  - ControlMatrix — Cancel confirmation dialog (destructive action)
 */

import { test, expect } from '@playwright/test';
import type { WebSocketRoute } from '@playwright/test';
import { setupWs, mockWorkflowsApi, snapshotFrame, workflowUpdateFrame, noticeFrame, helloFrame, itemStateFrame, WF_ID, WF_NAME } from './helpers';

test.beforeEach(async ({ page }) => {
  await mockWorkflowsApi(page, [{ id: WF_ID, name: WF_NAME, status: 'in_progress' }]);
});

// ---------------------------------------------------------------------------
// Loading / snapshot arrival
// ---------------------------------------------------------------------------

test('shows loading placeholder before snapshot arrives', async ({ page }) => {
  // Send hello but no snapshot.
  await setupWs(page);
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByText(/Connecting to workflow/)).toBeVisible();
});

test('renders workflow header after snapshot', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame());
  });
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByRole('heading', { level: 1, name: WF_NAME })).toBeVisible();
  // Status chip — there may be multiple "in_progress" texts; find in header area
  await expect(page.getByText('in_progress').first()).toBeVisible();
});

test('back button navigates to workflow list', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame());
  });
  await page.goto(`/workflow/${WF_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: WF_NAME })).toBeVisible();

  await page.getByRole('button', { name: 'Back to workflow list' }).click();
  await expect(page).toHaveURL('/');
});

// ---------------------------------------------------------------------------
// CrashRecoveryBanner
// ---------------------------------------------------------------------------

test('CrashRecoveryBanner renders when recoveryState is non-null', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        workflow: {
          recoveryState: {
            recoveredAt: new Date().toISOString(),
            priorStatus: 'in_progress',
            resumeMethod: 'continue',
            uncommittedChanges: false,
            lastKnownSessionId: 'sess-abc',
          },
        },
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  const banner = page.getByRole('alert');
  await expect(banner).toBeVisible();
  await expect(banner.getByText('Workflow recovered from crash')).toBeVisible();
  await expect(banner.getByText('continue')).toBeVisible(); // resumeMethod
  await expect(page.getByRole('button', { name: 'Acknowledge & Resume' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel Workflow' })).toBeVisible();
});

test('CrashRecoveryBanner shows uncommittedChanges warning', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        workflow: {
          recoveryState: {
            recoveredAt: new Date().toISOString(),
            priorStatus: 'in_progress',
            resumeMethod: 'continue',
            uncommittedChanges: true,
            lastKnownSessionId: null,
          },
        },
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByText(/stashed uncommitted changes/)).toBeVisible();
});

test('CrashRecoveryBanner Cancel opens confirmation dialog', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        workflow: {
          recoveryState: {
            recoveredAt: new Date().toISOString(),
            priorStatus: 'in_progress',
            resumeMethod: 'fresh',
            uncommittedChanges: false,
            lastKnownSessionId: null,
          },
        },
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  await page.getByRole('button', { name: 'Cancel Workflow' }).click();

  const dialog = page.getByRole('dialog', { name: 'Confirm cancellation' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Keep workflow' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Yes, cancel' })).toBeVisible();
});

test('CrashRecoveryBanner Acknowledge & Resume shows optimistic spinner and sends control frame (AC-3, RC-3)', async ({
  page,
}) => {
  const sentMessages: string[] = [];

  await page.routeWebSocket('**/stream', (ws: WebSocketRoute) => {
    ws.send(helloFrame());
    ws.onMessage((msg: string | Buffer) => {
      const raw = msg.toString();
      sentMessages.push(raw);
      try {
        const f = JSON.parse(raw) as { type: string };
        if (f.type === 'subscribe') {
          ws.send(
            snapshotFrame({
              workflow: {
                recoveryState: {
                  recoveredAt: new Date().toISOString(),
                  priorStatus: 'in_progress',
                  resumeMethod: 'continue',
                  uncommittedChanges: false,
                  lastKnownSessionId: null,
                },
              },
            }),
          );
        }
      } catch {
        // malformed — ignore
      }
    });
  });

  await page.goto(`/workflow/${WF_ID}`);
  await expect(page.getByRole('button', { name: 'Acknowledge & Resume' })).toBeVisible();

  await page.getByRole('button', { name: 'Acknowledge & Resume' }).click();

  // AC-3: button transitions to spinner text and is disabled
  await expect(page.getByRole('button', { name: 'Resuming…' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resuming…' })).toBeDisabled();

  // RC-3: resume method is passed through to the control frame (not hardcoded)
  const controlFrames = sentMessages
    .map((s) => {
      try {
        return JSON.parse(s) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((f): f is Record<string, unknown> => f?.type === 'control');
  expect(controlFrames.length).toBeGreaterThan(0);
  const ctrl = controlFrames[0] as { payload: { action: string; extra?: { resumeMethod?: string } } };
  expect(ctrl.payload.action).toBe('resume');
  expect(ctrl.payload.extra?.resumeMethod).toBe('continue');
});

test('CrashRecoveryBanner disappears when workflow.update clears recoveryState (AC-5)', async ({
  page,
}) => {
  let capturedWs: WebSocketRoute | null = null;

  await page.routeWebSocket('**/stream', (ws: WebSocketRoute) => {
    capturedWs = ws;
    ws.send(helloFrame());
    ws.onMessage((msg: string | Buffer) => {
      try {
        const f = JSON.parse(msg.toString()) as { type: string };
        if (f.type === 'subscribe') {
          ws.send(
            snapshotFrame({
              workflow: {
                recoveryState: {
                  recoveredAt: new Date().toISOString(),
                  priorStatus: 'paused',
                  resumeMethod: 'fresh',
                  uncommittedChanges: false,
                  lastKnownSessionId: null,
                },
              },
            }),
          );
        }
      } catch {
        // malformed — ignore
      }
    });
  });

  await page.goto(`/workflow/${WF_ID}`);

  // Banner visible initially
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText('Workflow recovered from crash')).toBeVisible();

  // Server clears recovery state via workflow.update
  capturedWs!.send(workflowUpdateFrame({ recoveryState: null }));

  // AC-5: banner is gone after server clears state (no dismiss button needed)
  await expect(page.getByRole('alert')).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// AttentionBanner
// ---------------------------------------------------------------------------

test('AttentionBanner renders pending attention items', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        pendingAttention: [
          {
            id: 1,
            kind: 'awaiting_user_retry',
            payload: 'Please review and retry',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  const banner = page.getByRole('region', { name: 'Attention required' });
  await expect(banner).toBeVisible();
  await expect(banner.getByText('awaiting_user_retry')).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Acknowledge' })).toBeVisible();
});

test('AttentionBanner is hidden when pendingAttention is empty', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ pendingAttention: [] }));
  });
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByRole('heading', { level: 1, name: WF_NAME })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Attention required' })).not.toBeVisible();
});

test('AttentionBanner: notice frame with requires_attention adds item in real-time (AC-2)', async ({
  page,
}) => {
  let capturedWs: WebSocketRoute | null = null;

  await page.routeWebSocket('**/stream', (ws: WebSocketRoute) => {
    capturedWs = ws;
    ws.send(helloFrame());
    ws.onMessage((msg: string | Buffer) => {
      try {
        const f = JSON.parse(msg.toString()) as { type: string };
        if (f.type === 'subscribe') {
          ws.send(snapshotFrame({ pendingAttention: [] }));
        }
      } catch {
        // ignore
      }
    });
  });

  await page.goto(`/workflow/${WF_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: WF_NAME })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Attention required' })).not.toBeVisible();

  capturedWs!.send(
    noticeFrame({
      severity: 'requires_attention',
      kind: 'bootstrap_failed',
      message: 'Bootstrap stage failed',
      persistedAttentionId: 99,
    }),
  );

  const banner = page.getByRole('region', { name: 'Attention required' });
  await expect(banner).toBeVisible();
  await expect(banner.getByText('bootstrap_failed')).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Acknowledge' })).toBeVisible();
});

test('AttentionBanner: Acknowledge shows spinner then hides item after POST (AC-3)', async ({
  page,
}) => {
  let resolveAck: () => void = () => {};
  const ackLatch = new Promise<void>((r) => {
    resolveAck = r;
  });

  // Registered after beforeEach's general /api/workflows** mock → takes priority.
  await page.route(`**/workflows/${WF_ID}/attention/1/ack`, async (route) => {
    await ackLatch;
    await route.fulfill({ status: 200, body: '' });
  });

  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        pendingAttention: [
          {
            id: 1,
            kind: 'awaiting_user_retry',
            payload: null,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
  });

  await page.goto(`/workflow/${WF_ID}`);

  const banner = page.getByRole('region', { name: 'Attention required' });
  await expect(banner.getByRole('button', { name: 'Acknowledge' })).toBeVisible();

  await banner.getByRole('button', { name: 'Acknowledge' }).click();

  // Spinner visible while ack is in-flight (AC-3)
  await expect(banner.getByRole('button', { name: 'Acknowledging…' })).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Acknowledging…' })).toBeDisabled();

  // Release the deferred response
  resolveAck();

  // Item disappears after ack POST succeeds (optimistic removal)
  await expect(banner).not.toBeVisible();
});

test('AttentionBanner: item removed when workflow.update clears pendingAttention (AC-4)', async ({
  page,
}) => {
  let capturedWs: WebSocketRoute | null = null;

  await page.routeWebSocket('**/stream', (ws: WebSocketRoute) => {
    capturedWs = ws;
    ws.send(helloFrame());
    ws.onMessage((msg: string | Buffer) => {
      try {
        const f = JSON.parse(msg.toString()) as { type: string };
        if (f.type === 'subscribe') {
          ws.send(
            snapshotFrame({
              pendingAttention: [
                {
                  id: 5,
                  kind: 'revisit_limit',
                  payload: null,
                  createdAt: new Date().toISOString(),
                },
              ],
            }),
          );
        }
      } catch {
        // ignore
      }
    });
  });

  await page.goto(`/workflow/${WF_ID}`);

  const banner = page.getByRole('region', { name: 'Attention required' });
  await expect(banner).toBeVisible();
  await expect(banner.getByText('revisit_limit')).toBeVisible();

  capturedWs!.send(workflowUpdateFrame({ pendingAttention: [] }));

  await expect(banner).not.toBeVisible();
});

test('AppShell bell badge count reflects pending attention items (AC-5/AC-6)', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        pendingAttention: [
          {
            id: 1,
            kind: 'awaiting_user_retry',
            payload: null,
            createdAt: new Date().toISOString(),
          },
          {
            id: 2,
            kind: 'bootstrap_failed',
            payload: null,
            createdAt: new Date(Date.now() + 1000).toISOString(),
          },
        ],
      }),
    );
  });

  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByRole('region', { name: 'Attention required' })).toBeVisible();

  // Bell badge should show count = 2
  const bell = page.getByRole('button', { name: 'Notifications' });
  await expect(bell.locator('span').filter({ hasText: '2' })).toBeVisible();
});

test('AttentionBanner: ?attention=<id> deep-link clears URL param and highlights item', async ({
  page,
}) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        pendingAttention: [
          {
            id: 1,
            kind: 'awaiting_user_retry',
            payload: 'Review required',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
  });

  await page.goto(`/workflow/${WF_ID}?attention=1`);

  const banner = page.getByRole('region', { name: 'Attention required' });
  await expect(banner).toBeVisible();

  // URL param should be consumed and cleared from the address bar
  await expect(page).not.toHaveURL(/attention=/);

  // The targeted item should have data-highlight=true while the 2s pulse runs
  const item = page.locator('#attention-item-1');
  await expect(item).toHaveAttribute('data-highlight', 'true');
});

// ---------------------------------------------------------------------------
// GithubButton
// ---------------------------------------------------------------------------

test('GithubButton is hidden when githubState.status is disabled', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        workflow: { githubState: { status: 'disabled' } },
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByRole('heading', { level: 1, name: WF_NAME })).toBeVisible();
  // No link or button for GitHub should exist
  await expect(page.getByRole('link', { name: /PR #/ })).not.toBeVisible();
  await expect(page.getByText('GitHub ⚙')).not.toBeVisible();
});

test('GithubButton shows unconfigured hint when status is unconfigured', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        workflow: { githubState: { status: 'unconfigured' } },
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByText('GitHub ⚙')).toBeVisible();
});

test('GithubButton shows PR link with open badge when status is created', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        workflow: {
          githubState: {
            status: 'created',
            prNumber: 42,
            prUrl: 'https://github.com/test/repo/pull/42',
            prState: 'open',
          },
        },
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  const link = page.getByRole('link', { name: /PR #42/ });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', 'https://github.com/test/repo/pull/42');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(link.getByText('open')).toBeVisible();
});

test('GithubButton shows spinner when status is creating', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        workflow: { githubState: { status: 'creating' } },
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByText('Creating PR…')).toBeVisible();
});

test('GithubButton shows error text when status is failed', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        workflow: {
          githubState: { status: 'failed', error: 'Push guard: unpushed commits' },
        },
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByText(/Push guard: unpushed commits/)).toBeVisible();
});

test('GithubButton shows idle ready indicator when status is idle', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        workflow: { githubState: { status: 'idle' } },
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByText('GitHub')).toBeVisible();
  await expect(page.getByRole('link', { name: /PR #/ })).not.toBeVisible();
});

test('GithubButton shows PR link with merged badge when prState is merged (AC-5)', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        workflow: {
          githubState: {
            status: 'created',
            prNumber: 7,
            prUrl: 'https://github.com/test/repo/pull/7',
            prState: 'merged',
          },
        },
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  const link = page.getByRole('link', { name: /PR #7/ });
  await expect(link).toBeVisible();
  await expect(link.getByText('merged')).toBeVisible();
});

test('GithubButton shows PR link with closed badge when prState is closed (AC-5)', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        workflow: {
          githubState: {
            status: 'created',
            prNumber: 9,
            prUrl: 'https://github.com/test/repo/pull/9',
            prState: 'closed',
          },
        },
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  const link = page.getByRole('link', { name: /PR #9/ });
  await expect(link).toBeVisible();
  await expect(link.getByText('closed')).toBeVisible();
});

test('GithubButton updates in real-time when workflow.update patches githubState (AC-7)', async ({
  page,
}) => {
  let capturedWs: WebSocketRoute | null = null;

  await page.routeWebSocket('**/stream', (ws: WebSocketRoute) => {
    capturedWs = ws;
    ws.send(helloFrame());
    ws.onMessage((msg: string | Buffer) => {
      try {
        const f = JSON.parse(msg.toString()) as { type: string };
        if (f.type === 'subscribe') {
          ws.send(snapshotFrame({ workflow: { githubState: { status: 'idle' } } }));
        }
      } catch {
        // malformed — ignore
      }
    });
  });

  await page.goto(`/workflow/${WF_ID}`);
  await expect(page.getByText('GitHub')).toBeVisible();
  await expect(page.getByRole('link', { name: /PR #/ })).not.toBeVisible();

  // Server sends a workflow.update that transitions githubState to created
  capturedWs!.send(
    workflowUpdateFrame({
      githubState: {
        status: 'created',
        prNumber: 55,
        prUrl: 'https://github.com/test/repo/pull/55',
        prState: 'open',
      },
    }),
  );

  await expect(page.getByRole('link', { name: /PR #55/ })).toBeVisible();
  await expect(page.getByText('open')).toBeVisible();
});

test('GithubButton lastCheckedAt renders as a relative timestamp title attribute (AC-8)', async ({
  page,
}) => {
  const checkedAt = new Date(Date.now() - 5 * 60 * 1_000).toISOString(); // 5 min ago

  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        workflow: {
          githubState: {
            status: 'created',
            prNumber: 3,
            prUrl: 'https://github.com/test/repo/pull/3',
            prState: 'open',
            lastCheckedAt: checkedAt,
          },
        },
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  const link = page.getByRole('link', { name: /PR #3/ });
  await expect(link).toBeVisible();
  // title attribute is the tooltip; contains "Last checked:" prefix.
  await expect(link).toHaveAttribute('title', /Last checked:/);
});

// ---------------------------------------------------------------------------
// FeatureBoard
// ---------------------------------------------------------------------------

test('FeatureBoard renders items grouped by stage', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        items: [
          {
            id: 'item-1',
            stageId: 'stage-1',
            displayTitle: 'Alpha Feature',
            displaySubtitle: 'First item',
            state: { status: 'pending', currentPhase: null, retryCount: 0, blockedReason: null },
          },
          {
            id: 'item-2',
            stageId: 'stage-1',
            displayTitle: 'Beta Feature',
            displaySubtitle: null,
            state: { status: 'in_progress', currentPhase: 'implement', retryCount: 0, blockedReason: null },
          },
        ],
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByText('Alpha Feature')).toBeVisible();
  await expect(page.getByText('Beta Feature')).toBeVisible();
  // Stage group header (data-testid avoids matching hidden <option> in category dropdown)
  await expect(page.getByTestId('stage-header').filter({ hasText: 'stage-1' })).toBeVisible();
});

test('FeatureBoard search filters items', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        items: [
          {
            id: 'item-1',
            stageId: 'stage-1',
            displayTitle: 'Alpha Feature',
            displaySubtitle: null,
            state: { status: 'pending', currentPhase: null, retryCount: 0, blockedReason: null },
          },
          {
            id: 'item-2',
            stageId: 'stage-1',
            displayTitle: 'Beta Feature',
            displaySubtitle: null,
            state: { status: 'pending', currentPhase: null, retryCount: 0, blockedReason: null },
          },
        ],
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByText('Alpha Feature')).toBeVisible();
  await expect(page.getByText('Beta Feature')).toBeVisible();

  // Type in the FeatureBoard search (the second search input — first is WorkflowList sidebar)
  const searches = page.getByPlaceholder('Search items…');
  await searches.fill('Alpha');

  await expect(page.getByText('Alpha Feature')).toBeVisible();
  await expect(page.getByText('Beta Feature')).not.toBeVisible();
});

test('FeatureBoard shows retryCount badge when > 0', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        items: [
          {
            id: 'item-1',
            stageId: 'stage-1',
            displayTitle: 'Retried Feature',
            displaySubtitle: null,
            state: { status: 'failed', currentPhase: null, retryCount: 3, blockedReason: null },
          },
        ],
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByText('retry 3')).toBeVisible();
});

// ---------------------------------------------------------------------------
// ControlMatrix
// ---------------------------------------------------------------------------

test('ControlMatrix shows Pause and Cancel for in_progress workflow with active session', async ({
  page,
}) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        activeSessions: [
          {
            sessionId: 'sess-1',
            phase: 'implement',
            attempt: 1,
            startedAt: new Date().toISOString(),
            parentSessionId: null,
          },
        ],
      }),
    );
  });
  // Also need a session.started frame so the render store has the session
  // (WorkflowDetailRoute dispatches session.started to the render store)
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Inject context' })).toBeVisible();
});

test('ControlMatrix Cancel button shows confirmation dialog', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        activeSessions: [
          {
            sessionId: 'sess-1',
            phase: 'implement',
            attempt: 1,
            startedAt: new Date().toISOString(),
            parentSessionId: null,
          },
        ],
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  await page.getByRole('button', { name: 'Cancel' }).click();

  const dialog = page.getByRole('dialog', { name: 'Confirm action' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Cancel this workflow/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeVisible();
});

test('ControlMatrix Resume shown for paused workflow, Pause hidden', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        workflow: { status: 'paused' },
        activeSessions: [
          {
            sessionId: 'sess-1',
            phase: 'implement',
            attempt: 1,
            startedAt: new Date().toISOString(),
            parentSessionId: null,
          },
        ],
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause' })).not.toBeVisible();
});

test('ControlMatrix not rendered when no active session', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [] }));
  });
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByRole('heading', { level: 1, name: WF_NAME })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause' })).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// FeatureBoard — extended AC coverage
// ---------------------------------------------------------------------------

test('FeatureBoard shows blockedReason warning icon with tooltip (AC-2)', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        items: [
          {
            id: 'item-1',
            stageId: 'stage-1',
            displayTitle: 'Blocked Feature',
            displaySubtitle: null,
            state: { status: 'blocked', currentPhase: null, retryCount: 0, blockedReason: 'Dependency failed' },
          },
        ],
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  const warning = page.locator('[title="Dependency failed"]');
  await expect(warning).toBeVisible();
  await expect(warning).toHaveText('⚠');
});

test('FeatureBoard item.state frame updates card status in real-time (AC-3)', async ({ page }) => {
  let capturedWs: WebSocketRoute | null = null;

  await page.routeWebSocket('**/stream', (ws: WebSocketRoute) => {
    capturedWs = ws;
    ws.send(helloFrame());
    ws.onMessage((msg: string | Buffer) => {
      try {
        const f = JSON.parse(msg.toString()) as { type: string };
        if (f.type === 'subscribe') {
          ws.send(
            snapshotFrame({
              items: [
                {
                  id: 'item-1',
                  stageId: 'stage-1',
                  displayTitle: 'Feature One',
                  displaySubtitle: null,
                  state: { status: 'pending', currentPhase: null, retryCount: 0, blockedReason: null },
                },
              ],
            }),
          );
        }
      } catch {
        // malformed — ignore
      }
    });
  });

  await page.goto(`/workflow/${WF_ID}`);
  await expect(page.getByText('Feature One')).toBeVisible();
  await expect(page.locator('.bg-gray-500\\/20').filter({ hasText: 'pending' })).toBeVisible();

  capturedWs!.send(itemStateFrame({ itemId: 'item-1', state: { status: 'complete', currentPhase: null } }));

  await expect(page.locator('.bg-green-500\\/20').filter({ hasText: 'complete' })).toBeVisible();
  await expect(page.locator('.bg-gray-500\\/20').filter({ hasText: 'pending' })).not.toBeVisible();
});

test('FeatureBoard status filter hides non-matching items (AC-5)', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        items: [
          {
            id: 'item-1',
            stageId: 'stage-1',
            displayTitle: 'Alpha Feature',
            displaySubtitle: null,
            state: { status: 'pending', currentPhase: null, retryCount: 0, blockedReason: null },
          },
          {
            id: 'item-2',
            stageId: 'stage-1',
            displayTitle: 'Beta Feature',
            displaySubtitle: null,
            state: { status: 'complete', currentPhase: null, retryCount: 0, blockedReason: null },
          },
        ],
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByText('Alpha Feature')).toBeVisible();
  await expect(page.getByText('Beta Feature')).toBeVisible();

  await page.getByRole('combobox', { name: 'Filter by status' }).selectOption('pending');

  await expect(page.getByText('Alpha Feature')).toBeVisible();
  await expect(page.getByText('Beta Feature')).not.toBeVisible();
});

test('FeatureBoard category filter hides non-matching stage groups (AC-5)', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        stages: [
          { id: 'stage-a', run: 'once', phases: ['implement'], status: 'in_progress', needsApproval: false },
          { id: 'stage-b', run: 'once', phases: ['implement'], status: 'pending', needsApproval: false },
        ],
        items: [
          {
            id: 'item-1',
            stageId: 'stage-a',
            displayTitle: 'Stage A Feature',
            displaySubtitle: null,
            state: { status: 'pending', currentPhase: null, retryCount: 0, blockedReason: null },
          },
          {
            id: 'item-2',
            stageId: 'stage-b',
            displayTitle: 'Stage B Feature',
            displaySubtitle: null,
            state: { status: 'pending', currentPhase: null, retryCount: 0, blockedReason: null },
          },
        ],
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByText('Stage A Feature')).toBeVisible();
  await expect(page.getByText('Stage B Feature')).toBeVisible();

  await page.getByRole('combobox', { name: 'Filter by category' }).selectOption('stage-a');

  await expect(page.getByText('Stage A Feature')).toBeVisible();
  await expect(page.getByText('Stage B Feature')).not.toBeVisible();
});

test('FeatureBoard deep-link /item/:itemId scrolls to and highlights target item (AC-6)', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        items: [
          {
            id: 'item-deep',
            stageId: 'stage-1',
            displayTitle: 'Linked Feature',
            displaySubtitle: null,
            state: { status: 'pending', currentPhase: null, retryCount: 0, blockedReason: null },
          },
        ],
      }),
    );
  });

  await page.goto(`/workflow/${WF_ID}/item/item-deep`);
  await expect(page.getByText('Linked Feature')).toBeVisible();

  // Deep-link useLayoutEffect sets data-highlight="true" after items render
  const card = page.locator('#item-item-deep');
  await expect(card).toHaveAttribute('data-highlight', 'true');
});

test('FeatureBoard j/k keyboard navigation moves focus ring and Enter selects item (AC-7)', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        items: [
          {
            id: 'item-1',
            stageId: 'stage-1',
            displayTitle: 'First Item',
            displaySubtitle: null,
            state: { status: 'pending', currentPhase: null, retryCount: 0, blockedReason: null },
          },
          {
            id: 'item-2',
            stageId: 'stage-1',
            displayTitle: 'Second Item',
            displaySubtitle: null,
            state: { status: 'pending', currentPhase: null, retryCount: 0, blockedReason: null },
          },
        ],
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);
  await expect(page.getByText('First Item')).toBeVisible();

  const listbox = page.getByRole('listbox', { name: 'Items' });
  await listbox.focus();

  // j moves aria-activedescendant to first item
  await listbox.press('j');
  await expect(listbox).toHaveAttribute('aria-activedescendant', 'item-item-1');

  // j again moves to second item
  await listbox.press('j');
  await expect(listbox).toHaveAttribute('aria-activedescendant', 'item-item-2');

  // k moves back to first
  await listbox.press('k');
  await expect(listbox).toHaveAttribute('aria-activedescendant', 'item-item-1');

  // Enter selects the focused item (aria-selected becomes true)
  await listbox.press('Enter');
  await expect(page.locator('#item-item-1')).toHaveAttribute('aria-selected', 'true');
});

test('FeatureBoard pins in_progress item to top of its stage group (AC-8)', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        items: [
          {
            id: 'item-first-pending',
            stageId: 'stage-1',
            displayTitle: 'Pending Item',
            displaySubtitle: null,
            state: { status: 'pending', currentPhase: null, retryCount: 0, blockedReason: null },
          },
          {
            id: 'item-streaming',
            stageId: 'stage-1',
            displayTitle: 'Active Item',
            displaySubtitle: null,
            state: { status: 'in_progress', currentPhase: 'implement', retryCount: 0, blockedReason: null },
          },
        ],
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByText('Active Item')).toBeVisible();

  // Streaming indicator (pulsing dot) is visible on the active item
  const activeCard = page.locator('#item-item-streaming');
  await expect(activeCard.locator('[aria-label="Streaming"]')).toBeVisible();

  // Active item should be first among the item cards (pinned to top of group)
  const cards = page.locator('[role="option"]');
  const firstText = await cards.first().textContent();
  expect(firstText).toContain('Active Item');
});

test('FeatureBoard fetches and renders item.data in collapsible JSON tree on selection (AC-9)', async ({
  page,
}) => {
  // Register specific item data route — takes priority over the general workflows mock (LIFO).
  await page.route(`**/items/item-1/data`, (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ featureFlag: 'experiment-x', target: 'premium' }),
    });
  });

  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        items: [
          {
            id: 'item-1',
            stageId: 'stage-1',
            displayTitle: 'Data Feature',
            displaySubtitle: null,
            state: { status: 'pending', currentPhase: null, retryCount: 0, blockedReason: null },
          },
        ],
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);
  await expect(page.getByText('Data Feature')).toBeVisible();

  // Click on the item to select it and trigger item.data fetch
  await page.locator('#item-item-1').click();

  // "Show data" toggle button should appear after fetch completes
  const showBtn = page.getByRole('button', { name: /Show data/ });
  await expect(showBtn).toBeVisible();

  // Expand the JSON tree
  await showBtn.click();
  await expect(page.getByText(/featureFlag/)).toBeVisible();
});

test('FeatureBoard item.data is cached; re-selection after deselect does not refetch (AC-10)', async ({
  page,
}) => {
  let item1FetchCount = 0;

  await page.route(`**/items/item-1/data`, async (route) => {
    item1FetchCount++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ key: 'cached-value' }),
    });
  });
  // Explicit route for item-2 so it doesn't fall through to the general mock.
  await page.route(`**/items/item-2/data`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await setupWs(page, (ws) => {
    ws.send(
      snapshotFrame({
        items: [
          {
            id: 'item-1',
            stageId: 'stage-1',
            displayTitle: 'Cached Feature',
            displaySubtitle: null,
            state: { status: 'pending', currentPhase: null, retryCount: 0, blockedReason: null },
          },
          {
            id: 'item-2',
            stageId: 'stage-1',
            displayTitle: 'Other Feature',
            displaySubtitle: null,
            state: { status: 'pending', currentPhase: null, retryCount: 0, blockedReason: null },
          },
        ],
      }),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);
  await expect(page.getByText('Cached Feature')).toBeVisible();

  // First selection — triggers fetch
  await page.locator('#item-item-1').click();
  await expect(page.getByRole('button', { name: /Show data/ })).toBeVisible();
  expect(item1FetchCount).toBe(1);

  // Select item-2 to deselect item-1
  await page.locator('#item-item-2').click();

  // Re-select item-1 — must serve from cache (no second fetch)
  await page.locator('#item-item-1').click();
  await expect(page.getByRole('button', { name: /Show data/ })).toBeVisible();

  expect(item1FetchCount).toBe(1);
});

test('FeatureBoard item.data cache is invalidated on item.state frame (RC-7)', async ({ page }) => {
  let item1FetchCount = 0;
  let capturedWs: WebSocketRoute | null = null;

  await page.route(`**/items/item-1/data`, async (route) => {
    item1FetchCount++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ version: item1FetchCount }),
    });
  });
  await page.route(`**/items/item-2/data`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.routeWebSocket('**/stream', (ws: WebSocketRoute) => {
    capturedWs = ws;
    ws.send(helloFrame());
    ws.onMessage((msg: string | Buffer) => {
      try {
        const f = JSON.parse(msg.toString()) as { type: string };
        if (f.type === 'subscribe') {
          ws.send(
            snapshotFrame({
              items: [
                {
                  id: 'item-1',
                  stageId: 'stage-1',
                  displayTitle: 'Versioned Feature',
                  displaySubtitle: null,
                  state: { status: 'pending', currentPhase: null, retryCount: 0, blockedReason: null },
                },
                {
                  id: 'item-2',
                  stageId: 'stage-1',
                  displayTitle: 'Other Feature',
                  displaySubtitle: null,
                  state: { status: 'pending', currentPhase: null, retryCount: 0, blockedReason: null },
                },
              ],
            }),
          );
        }
      } catch {
        // malformed — ignore
      }
    });
  });

  await page.goto(`/workflow/${WF_ID}`);
  await expect(page.getByText('Versioned Feature')).toBeVisible();

  // Select item-1 → first fetch
  await page.locator('#item-item-1').click();
  await expect(page.getByRole('button', { name: /Show data/ })).toBeVisible();
  expect(item1FetchCount).toBe(1);

  // Select item-2 to deselect item-1
  await page.locator('#item-item-2').click();

  // Send item.state frame for item-1 → invalidates its cache entry
  capturedWs!.send(itemStateFrame({ itemId: 'item-1', state: { status: 'complete' } }));
  await expect(page.locator('#item-item-1').locator('.bg-green-500\\/20')).toBeVisible();

  // Re-select item-1 — cache was invalidated, so a fresh fetch must fire
  await page.locator('#item-item-1').click();
  await expect(page.getByRole('button', { name: /Show data/ })).toBeVisible();

  expect(item1FetchCount).toBe(2);
});
