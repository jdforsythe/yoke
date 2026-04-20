/**
 * Real-backend Playwright spec for test-e2e-full-suite — error boundary.
 *
 * Forces a render-time exception in WorkflowDetailRoute by intercepting the WS
 * message stream and corrupting the first workflow.snapshot frame: setting
 * `stages = null` causes FeatureBoard's `stages.map(...)` to throw a TypeError
 * during React render, which React Router's errorElement on the
 * /workflow/:workflowId route catches via RouteErrorBoundary.
 *
 * Asserts:
 *   - RouteErrorBoundary message "Something went wrong rendering this workflow."
 *   - The sidebar (WorkflowList) stays navigable after the render crash
 */

import { test, expect } from '../fixtures/realBackend.js';
import { randomUUID } from 'node:crypto';

test('error-boundary: corrupt WS frame causes RouteErrorBoundary, sidebar stays navigable', async ({
  page,
  backend,
}) => {
  const wfId = `wf-err-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  // Seed a workflow so the server sends a real workflow.snapshot frame.
  backend.db.writer
    .prepare(
      `INSERT INTO workflows (id, name, spec, pipeline, config, status, created_at, updated_at)
       VALUES (?, ?, '{}', '{}', '{}', 'pending', ?, ?)`,
    )
    .run(wfId, 'Error Boundary Workflow', now, now);

  // Intercept WS messages BEFORE page.goto() so the init script is in place
  // when the browser creates the WebSocket connection. This script runs AFTER the
  // fixture's OverrideWS init script (which rewrites the /stream URL to the real
  // backend port), so `globalThis.WebSocket` here is already OverrideWS.
  // InterceptWS extends OverrideWS and wraps each registered `message` listener.
  // When the first workflow.snapshot arrives, it sets stages = null before the
  // app's frame handler sees it, causing FeatureBoard.stages.map() to throw.
  await page.addInitScript(() => {
    const OrigWS = globalThis.WebSocket;
    class InterceptWS extends OrigWS {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        let corrupted = false;
        const origAddEventListener = this.addEventListener.bind(this);
        // Shadow addEventListener so we can wrap the 'message' listener.
        (this as unknown as Record<string, unknown>)['addEventListener'] = (
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | AddEventListenerOptions,
        ) => {
          if (type !== 'message' || corrupted) {
            origAddEventListener(type, listener, options);
            return;
          }
          const fn =
            typeof listener === 'function' ? listener : listener.handleEvent.bind(listener);
          origAddEventListener(
            'message',
            (event: Event) => {
              if (corrupted) { fn(event); return; }
              const msgEvent = event as MessageEvent;
              try {
                const data = JSON.parse(msgEvent.data as string) as {
                  type?: string;
                  payload?: Record<string, unknown>;
                };
                if (data.type === 'workflow.snapshot' && data.payload) {
                  corrupted = true;
                  // null stages causes FeatureBoard.stages.map() → TypeError
                  data.payload['stages'] = null;
                  const patched = new MessageEvent('message', {
                    data: JSON.stringify(data),
                    origin: msgEvent.origin,
                    lastEventId: msgEvent.lastEventId,
                  });
                  fn(patched);
                  return;
                }
              } catch {
                /* fall through to original handler */
              }
              fn(event);
            },
            options,
          );
        };
      }
    }
    globalThis.WebSocket = InterceptWS as typeof WebSocket;
  });

  await page.goto(`/workflow/${wfId}`);

  // RouteErrorBoundary renders when WorkflowDetailRoute throws during render.
  await expect(
    page.getByText('Something went wrong rendering this workflow.'),
  ).toBeVisible({ timeout: 8000 });

  // The "← Back to workflow list" link in RouteErrorBoundary navigates to "/".
  // This proves the AppShell (sidebar) is still alive and functional.
  await page.getByRole('link', { name: /back to workflow list/i }).click();
  await expect(page.getByText('Error Boundary Workflow')).toBeVisible({ timeout: 3000 });
});
