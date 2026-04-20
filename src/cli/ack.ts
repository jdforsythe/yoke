/**
 * yoke ack <workflowId> — retry all awaiting_user items in a workflow.
 *
 * POSTs to POST /api/workflows/:id/retry which fires the 'user_retry'
 * state-machine event on every item currently stuck in 'awaiting_user'.
 * The scheduler picks up the resulting 'in_progress' items on its next tick
 * and spawns new sessions.
 *
 * Typical use: a session exits unexpectedly (network timeout, API error) and
 * the classifier marks it 'unknown', routing the item to awaiting_user. Run
 * this command with the workflow ID printed in the scheduler log to resume.
 *
 * Review criteria:
 *   RC: Fresh UUID commandId per invocation (N/A — retry has no idempotency key).
 *   RC: ECONNREFUSED → clear human-readable message.
 *   RC: No shell-injection risk.
 *   RC: 'none_awaiting' is not an error — print informational message, exit 0.
 */

import type { Command } from 'commander';
import { resolveServerUrl } from './status.js';
import type { RetryItemsResult } from '../server/api/server.js';

// ---------------------------------------------------------------------------
// Public API (exported for testing)
// ---------------------------------------------------------------------------

export interface AckOptions {
  /** Yoke server URL. Default: from .yoke/server.json or 127.0.0.1:7777. */
  serverUrl?: string;
  cwd?: string;
}

export interface AckResult {
  workflowId: string;
  status: number;
  body: RetryItemsResult;
}

/**
 * POST /api/workflows/:id/retry and return structured result.
 * Throws on ECONNREFUSED or non-2xx (except 404).
 *
 * @param workflowId  Workflow UUID to retry.
 * @param opts        Optional overrides for URL and cwd.
 * @param fetcher     Injectable fetch for tests.
 */
export async function sendAck(
  workflowId: string,
  opts: AckOptions = {},
  fetcher: typeof fetch = fetch,
): Promise<AckResult> {
  const serverUrl = opts.serverUrl ?? resolveServerUrl(undefined, opts.cwd);
  const url = `${serverUrl}/api/workflows/${encodeURIComponent(workflowId)}/retry`;

  let res: Response;
  try {
    res = await fetcher(url, { method: 'POST' });
  } catch (err: unknown) {
    const isConnRefused =
      (err as { code?: string }).code === 'ECONNREFUSED' ||
      (err as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED' ||
      String(err).includes('ECONNREFUSED');
    if (isConnRefused) {
      throw new Error(
        `Cannot connect to Yoke server at ${serverUrl}.\n` +
          `Make sure the server is running: yoke start`,
      );
    }
    throw err;
  }

  const body = (await res.json().catch(() => null)) as RetryItemsResult;

  if (!res.ok) {
    throw new Error(
      `Server returned ${res.status} for retry request:\n${JSON.stringify(body, null, 2)}`,
    );
  }

  return { workflowId, status: res.status, body };
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  program
    .command('ack <workflowId>')
    .description(
      'Retry all awaiting-user items in a workflow (resumes after unexpected session exit)',
    )
    .option('--url <url>', 'Yoke server URL (overrides .yoke/server.json and default)')
    .action(async (workflowId: string, opts: { url?: string }) => {
      const serverUrl = opts.url ?? resolveServerUrl(opts.url);

      let result: AckResult;
      try {
        result = await sendAck(workflowId, { serverUrl });
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      const { body } = result;

      if (body.status === 'none_awaiting') {
        console.log(`No awaiting-user items found for workflow ${workflowId}`);
        return;
      }

      if (body.status === 'retried') {
        for (const item of body.items) {
          const phase = item.phase ? `/${item.phase}` : '';
          console.log(`Retried: ${item.stageId}${phase} (item ${item.itemId})`);
        }
        console.log(`Resumed ${body.items.length} item(s) in workflow ${workflowId}`);
      }
    });
}
