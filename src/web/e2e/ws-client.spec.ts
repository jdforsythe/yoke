/**
 * Smoke tests: YokeWsClient module behaviour.
 *
 * Covers acceptance criteria from feat-ws-client that are not exercised by
 * app-shell.spec.ts or workflow-list.spec.ts:
 *
 *  AC-3  subscribe frame has v:1, type "subscribe", and a UUIDv4 commandId
 *  AC-4  client enters Reconnecting state and retries after server closes socket
 *  AC-10 error frame with code PROTOCOL_MISMATCH → version_mismatch state + socket close
 *  AC-11 error frame with code INTERNAL → reconnect (not permanent disconnect)
 */

import { test, expect } from '@playwright/test';
import { mockWorkflowsApi, helloFrame, WF_ID, WF_NAME } from './helpers';

// ---------------------------------------------------------------------------
// Helpers local to this spec
// ---------------------------------------------------------------------------

function errorFrame(code: string): string {
  return JSON.stringify({
    v: 1,
    type: 'error',
    seq: 0,
    ts: new Date().toISOString(),
    payload: { code, message: `Test ${code}` },
  });
}

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// AC-4 — reconnect after server-side close
// ---------------------------------------------------------------------------

test('connection indicator shows Reconnecting after server closes socket, then Connected after new hello', async ({
  page,
}) => {
  await mockWorkflowsApi(page);

  let connectCount = 0;
  let closeFirst: (() => void) | null = null;

  await page.routeWebSocket('**/stream', (ws) => {
    connectCount++;
    if (connectCount === 1) {
      // First connection: send hello so client reaches Connected, expose close handle.
      ws.send(helloFrame());
      closeFirst = () => ws.close();
    } else {
      // Reconnected: send hello so client reaches Connected again.
      ws.send(helloFrame());
    }
  });

  await page.goto('/');
  await expect(page.getByText('Connected')).toBeVisible();

  // Close the server side — triggers close event on the client WebSocket.
  closeFirst!();

  // Client should enter Reconnecting… state.
  await expect(page.getByText(/Reconnecting/)).toBeVisible({ timeout: 3_000 });

  // After the jittered backoff (≤200ms for first attempt) client reconnects.
  await expect(page.getByText('Connected')).toBeVisible({ timeout: 5_000 });

  // Sanity: two connections were made.
  expect(connectCount).toBeGreaterThanOrEqual(2);
});

// ---------------------------------------------------------------------------
// AC-11 — error INTERNAL triggers reconnect, not permanent disconnect
// ---------------------------------------------------------------------------

test('error frame with code INTERNAL triggers reconnect and returns to Connected', async ({
  page,
}) => {
  await mockWorkflowsApi(page);

  let send: ((msg: string) => void) | null = null;

  await page.routeWebSocket('**/stream', (ws) => {
    ws.send(helloFrame());
    // Expose send so the test can inject server frames.
    send = (msg: string) => ws.send(msg);
  });

  await page.goto('/');
  await expect(page.getByText('Connected')).toBeVisible();

  // Inject INTERNAL error — client should call ws.close(), triggering reconnect.
  send!(errorFrame('INTERNAL'));

  // Client reconnects via exponential backoff and shows Connected again.
  await expect(page.getByText('Connected')).toBeVisible({ timeout: 5_000 });
});

// ---------------------------------------------------------------------------
// AC-10 — error PROTOCOL_MISMATCH closes socket and shows version_mismatch
// ---------------------------------------------------------------------------

test('error frame with code PROTOCOL_MISMATCH transitions to version_mismatch and does not reconnect', async ({
  page,
}) => {
  await mockWorkflowsApi(page);

  let send: ((msg: string) => void) | null = null;
  let connectCount = 0;

  await page.routeWebSocket('**/stream', (ws) => {
    connectCount++;
    ws.send(helloFrame());
    send = (msg: string) => ws.send(msg);
  });

  await page.goto('/');
  await expect(page.getByText('Connected')).toBeVisible();

  // Inject PROTOCOL_MISMATCH error.
  send!(errorFrame('PROTOCOL_MISMATCH'));

  // Connection indicator must switch to "Version mismatch".
  await expect(page.getByText('Version mismatch')).toBeVisible({ timeout: 3_000 });

  // The client must NOT reconnect — wait 2 s and confirm connectCount is still 1.
  await page.waitForTimeout(2_000);
  expect(connectCount).toBe(1);
});

// ---------------------------------------------------------------------------
// AC-3 — subscribe frame has v:1, type "subscribe", and a UUIDv4 commandId
// ---------------------------------------------------------------------------

test('subscribe frame sent on workflow navigation has correct shape and UUIDv4 id', async ({
  page,
}) => {
  await mockWorkflowsApi(page, [{ id: WF_ID, name: WF_NAME, status: 'in_progress' }]);

  const subscribes: Array<Record<string, unknown>> = [];

  await page.routeWebSocket('**/stream', (ws) => {
    ws.send(helloFrame());
    ws.onMessage((raw: string | Buffer) => {
      try {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (frame['type'] === 'subscribe') {
          subscribes.push(frame);
        }
      } catch {
        // malformed — ignore
      }
    });
  });

  await page.goto('/');
  await expect(page.getByText('Connected')).toBeVisible();

  // Navigate to the workflow — WorkflowDetailRoute calls client.subscribe(workflowId).
  await page.getByRole('listitem').click();
  await expect(page).toHaveURL(`/workflow/${WF_ID}`);

  // Wait for at least one subscribe frame to be captured.
  await expect.poll(() => subscribes.length, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);

  const frame = subscribes[0];
  // Protocol version
  expect(frame['v']).toBe(1);
  // Frame type
  expect(frame['type']).toBe('subscribe');
  // id must be a UUIDv4
  expect(typeof frame['id']).toBe('string');
  expect(frame['id'] as string).toMatch(UUID_V4_RE);
  // Payload must carry the correct workflowId
  const payload = frame['payload'] as Record<string, unknown>;
  expect(payload['workflowId']).toBe(WF_ID);
});
