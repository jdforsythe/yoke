/**
 * Smoke tests: LiveStreamPane and block renderers.
 *
 * Covers:
 *  - TextBlock rendering from stream.text frames
 *  - ThinkingBlock collapsed by default, expands on click (AC-6)
 *  - ToolCallRenderer: name, status badge, expand to show JSON (AC-7)
 *  - ToolCallRenderer: status updates when tool_result arrives (AC-7)
 *  - SystemNotice block rendered from stream.system_notice
 *  - session.started / session.ended create system notices in pane
 *  - Follow-tail: new blocks remain visible as they arrive (AC-3)
 *  - Upscroll detaches follow-tail; Jump to latest pill appears (AC-4)
 *  - Jump to latest re-engages follow-tail and hides pill (AC-5)
 */

import { test, expect } from '@playwright/test';
import type { WebSocketRoute } from '@playwright/test';
import {
  setupWs,
  mockWorkflowsApi,
  snapshotFrame,
  helloFrame,
  WF_ID,
  sessionStartedFrame,
  sessionEndedFrame,
  streamTextFrame,
  streamThinkingFrame,
  streamToolUseFrame,
  streamToolResultFrame,
  streamSystemNoticeFrame,
} from './helpers';

// ---------------------------------------------------------------------------
// Shared test session constants
// ---------------------------------------------------------------------------

const SESS = 'sess-stream-test-1';

function makeActiveSession() {
  return {
    sessionId: SESS,
    phase: 'implement',
    attempt: 1,
    startedAt: new Date().toISOString(),
    parentSessionId: null,
  };
}

test.beforeEach(async ({ page }) => {
  await mockWorkflowsApi(page, [{ id: WF_ID, name: 'Test Workflow', status: 'in_progress' }]);
});

// ---------------------------------------------------------------------------
// TextBlock rendering
// ---------------------------------------------------------------------------

test('stream pane renders TextBlock content from stream.text frame', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
    ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
    ws.send(streamTextFrame(SESS, 'blk-1', 'Hello from the stream', 3, true));
  });
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByText('Hello from the stream')).toBeVisible();
});

test('stream pane renders fenced code block with language header', async ({ page }) => {
  const code = '```typescript\nconst x = 1;\n```';
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
    ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
    ws.send(streamTextFrame(SESS, 'blk-code', code, 3, true));
  });
  await page.goto(`/workflow/${WF_ID}`);

  // Language label rendered above code block
  await expect(page.getByText('typescript')).toBeVisible();
  await expect(page.getByText('const x = 1;')).toBeVisible();
});

// ---------------------------------------------------------------------------
// ThinkingBlock (AC-6)
// ---------------------------------------------------------------------------

test('ThinkingBlock renders collapsed by default (AC-6)', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
    ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
    ws.send(streamThinkingFrame(SESS, 'think-1', 'This is a deep thought\nsecond line', 3, true));
  });
  await page.goto(`/workflow/${WF_ID}`);

  // Collapsed: button shows "Thinking… (N lines)" with aria-expanded=false
  const thinkBtn = page.getByRole('button', { name: /Thinking…/ });
  await expect(thinkBtn).toBeVisible();
  await expect(thinkBtn).toHaveAttribute('aria-expanded', 'false');

  // Content must NOT be visible while collapsed
  await expect(page.getByText('This is a deep thought')).not.toBeVisible();
});

test('ThinkingBlock expands inline when clicked without disrupting layout (AC-6)', async ({
  page,
}) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
    ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
    ws.send(streamThinkingFrame(SESS, 'think-2', 'Expanded thinking content', 3, true));
  });
  await page.goto(`/workflow/${WF_ID}`);

  const thinkBtn = page.getByRole('button', { name: /Thinking…/ });
  await expect(thinkBtn).toBeVisible();

  await thinkBtn.click();

  await expect(thinkBtn).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Expanded thinking content')).toBeVisible();
});

// ---------------------------------------------------------------------------
// ToolCallBlock (AC-7)
// ---------------------------------------------------------------------------

test('ToolCallRenderer shows tool name and running badge (AC-7)', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
    ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
    ws.send(
      streamToolUseFrame(SESS, 'tool-use-1', 'ReadFile', { path: '/src/main.ts' }, 3, 'running'),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByText('ReadFile')).toBeVisible();
  await expect(page.getByText('running')).toBeVisible();
});

test('ToolCallRenderer is collapsed by default with input preview (AC-7)', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
    ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
    ws.send(
      streamToolUseFrame(
        SESS,
        'tool-preview',
        'WriteFile',
        { path: '/out.txt', content: 'preview test' },
        3,
        'running',
      ),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  // Collapsed: aria-expanded=false; input preview snippet visible
  const toolBtn = page.getByRole('button', { name: /WriteFile/ });
  await expect(toolBtn).toHaveAttribute('aria-expanded', 'false');
  // Input preview is truncated JSON shown below the header
  await expect(page.getByText(/\/out\.txt/)).toBeVisible();
});

test('ToolCallRenderer expands to show full input JSON tree (AC-7)', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
    ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
    ws.send(
      streamToolUseFrame(
        SESS,
        'tool-expand',
        'BashTool',
        { command: 'npm test', cwd: '/repo' },
        3,
        'running',
      ),
    );
  });
  await page.goto(`/workflow/${WF_ID}`);

  const toolBtn = page.getByRole('button', { name: /BashTool/ });
  await toolBtn.click();

  await expect(toolBtn).toHaveAttribute('aria-expanded', 'true');
  // "Input" section heading and JSON content
  await expect(page.getByText('Input')).toBeVisible();
  await expect(page.getByText(/npm test/)).toBeVisible();
  await expect(page.getByText(/\/repo/)).toBeVisible();
});

test('ToolCallRenderer shows ok badge when stream.tool_result arrives (AC-7)', async ({
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
          ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
          ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
          ws.send(
            streamToolUseFrame(SESS, 'tool-result-ok', 'GrepTool', { pattern: 'TODO' }, 3, 'running'),
          );
        }
      } catch {
        // malformed — ignore
      }
    });
  });

  await page.goto(`/workflow/${WF_ID}`);
  await expect(page.getByText('GrepTool')).toBeVisible();
  await expect(page.getByText('running')).toBeVisible();

  capturedWs!.send(streamToolResultFrame(SESS, 'tool-result-ok', 'ok', 'src/main.ts:42: TODO fix', 4));

  await expect(page.getByText('ok')).toBeVisible();
  await expect(page.getByText('running')).not.toBeVisible();
});

test('ToolCallRenderer shows error badge when stream.tool_result is error (AC-7)', async ({
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
          ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
          ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
          ws.send(
            streamToolUseFrame(SESS, 'tool-result-err', 'RunTests', { suite: 'unit' }, 3, 'running'),
          );
        }
      } catch {
        // malformed — ignore
      }
    });
  });

  await page.goto(`/workflow/${WF_ID}`);
  await expect(page.getByText('RunTests')).toBeVisible();

  capturedWs!.send(streamToolResultFrame(SESS, 'tool-result-err', 'error', 'Tests failed: 3 errors', 4));

  await expect(page.getByText('error')).toBeVisible();
});

test('ToolCallRenderer shows Result section when expanded after tool_result (AC-7)', async ({
  page,
}) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
    ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
    ws.send(streamToolUseFrame(SESS, 'tool-with-result', 'ListFiles', { dir: '/src' }, 3, 'running'));
    ws.send(streamToolResultFrame(SESS, 'tool-with-result', 'ok', ['a.ts', 'b.ts'], 4));
  });
  await page.goto(`/workflow/${WF_ID}`);

  const toolBtn = page.getByRole('button', { name: /ListFiles/ });
  await expect(toolBtn).toBeVisible();
  await toolBtn.click();

  await expect(page.getByText('Result')).toBeVisible();
  await expect(page.getByText(/a\.ts/)).toBeVisible();
});

// ---------------------------------------------------------------------------
// SystemNotice block
// ---------------------------------------------------------------------------

test('SystemNotice block renders from stream.system_notice with info severity', async ({
  page,
}) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
    ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
    ws.send(streamSystemNoticeFrame(SESS, 'info', 'harness', 'Pipeline stage started', 3));
  });
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByText('Pipeline stage started')).toBeVisible();
});

test('SystemNotice block renders warn severity from stream.system_notice', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
    ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
    ws.send(streamSystemNoticeFrame(SESS, 'warn', 'rate_limit', 'Rate limit hit — pausing', 3));
  });
  await page.goto(`/workflow/${WF_ID}`);

  await expect(page.getByText('Rate limit hit — pausing')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Session lifecycle notices
// ---------------------------------------------------------------------------

test('session.started creates a SystemNotice in the pane', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
    ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
  });
  await page.goto(`/workflow/${WF_ID}`);

  // Reducer inserts: "Session started — phase: implement, attempt: 1"
  await expect(page.getByText(/Session started/)).toBeVisible();
  await expect(page.getByText(/implement/)).toBeVisible();
});

test('session.ended creates a SessionEnded SystemNotice in the pane', async ({ page }) => {
  let capturedWs: WebSocketRoute | null = null;

  await page.routeWebSocket('**/stream', (ws: WebSocketRoute) => {
    capturedWs = ws;
    ws.send(helloFrame());
    ws.onMessage((msg: string | Buffer) => {
      try {
        const f = JSON.parse(msg.toString()) as { type: string };
        if (f.type === 'subscribe') {
          ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
          ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
        }
      } catch {
        // malformed — ignore
      }
    });
  });

  await page.goto(`/workflow/${WF_ID}`);
  await expect(page.getByText(/Session started/)).toBeVisible();

  capturedWs!.send(sessionEndedFrame(SESS, 'ok', 0, 99));

  // Reducer inserts: "Session ended — reason: ok, exit: 0"
  await expect(page.getByText(/Session ended/)).toBeVisible();
});

// ---------------------------------------------------------------------------
// Follow-tail behavior (AC-3)
// ---------------------------------------------------------------------------

test('Follow-tail: newly arriving blocks remain visible as they arrive (AC-3)', async ({
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
          ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
          ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
          // Pre-fill enough blocks to overflow the container
          for (let i = 1; i <= 25; i++) {
            ws.send(streamTextFrame(SESS, `preload-${i}`, `Preload line ${i}`, 2 + i, true));
          }
        }
      } catch {
        // malformed — ignore
      }
    });
  });

  await page.goto(`/workflow/${WF_ID}`);
  // Wait for pre-filled blocks to settle (follow-tail should have scrolled to last)
  await expect(page.getByText('Preload line 25')).toBeVisible();

  // Send a new block live — follow-tail must keep it in view
  capturedWs!.send(streamTextFrame(SESS, 'live-1', 'Live stream block', 28, true));

  await expect(page.getByText('Live stream block')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Upscroll detach + Jump to latest (AC-4, AC-5)
// ---------------------------------------------------------------------------

test('Upscroll detaches follow-tail and shows Jump to latest pill (AC-4)', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
    ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
    // Send enough blocks to make the scroll container overflow
    for (let i = 1; i <= 30; i++) {
      ws.send(
        streamTextFrame(
          SESS,
          `scroll-blk-${i}`,
          `Scroll test line ${i} — some content to create measurable height in the container`,
          2 + i,
          true,
        ),
      );
    }
  });

  await page.goto(`/workflow/${WF_ID}`);

  // Follow-tail should have scrolled to the last block
  await expect(page.getByText('Scroll test line 30')).toBeVisible();

  // Pill must NOT be visible at bottom
  await expect(page.getByRole('button', { name: /Jump to latest/ })).not.toBeVisible();

  // Programmatically scroll to the top of the stream container
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="stream-scroll-container"]');
    if (el && el.scrollHeight > el.clientHeight + 50) {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  });

  // Jump to latest pill must appear (follow-tail detached)
  await expect(page.getByRole('button', { name: /Jump to latest/ })).toBeVisible();
});

test('Clicking Jump to latest re-engages follow-tail and hides pill (AC-5)', async ({ page }) => {
  await setupWs(page, (ws) => {
    ws.send(snapshotFrame({ activeSessions: [makeActiveSession()] }));
    ws.send(sessionStartedFrame(SESS, 'implement', 1, 2));
    for (let i = 1; i <= 30; i++) {
      ws.send(
        streamTextFrame(
          SESS,
          `jump-blk-${i}`,
          `Jump test line ${i} — enough content to overflow the stream pane viewport`,
          2 + i,
          true,
        ),
      );
    }
  });

  await page.goto(`/workflow/${WF_ID}`);
  await expect(page.getByText('Jump test line 30')).toBeVisible();

  // Scroll to top to detach follow-tail
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="stream-scroll-container"]');
    if (el && el.scrollHeight > el.clientHeight + 50) {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  });

  const pill = page.getByRole('button', { name: /Jump to latest/ });
  await expect(pill).toBeVisible();

  // Click the pill — re-engages follow-tail
  await pill.click();

  // Pill disappears; follow-tail is re-engaged
  await expect(pill).not.toBeVisible();

  // Last block is visible again (scrolled back to bottom)
  await expect(page.getByText('Jump test line 30')).toBeVisible();
});
