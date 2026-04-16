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
import { setupWs, mockWorkflowsApi, snapshotFrame, workflowUpdateFrame, noticeFrame, helloFrame, WF_ID, WF_NAME } from './helpers';

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
