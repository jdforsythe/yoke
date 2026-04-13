/**
 * yoke cancel <workflowId> — send a cancel control frame.
 *
 * Posts to POST /api/workflows/:id/control with:
 *   { action: "cancel", commandId: "<fresh UUID>" }
 *
 * A fresh commandId is generated per invocation so the endpoint's idempotency
 * key is unique even if the user re-runs the command (RC).
 *
 * Review criteria:
 *   RC: Fresh UUID commandId per invocation.
 *   RC: ECONNREFUSED → clear human-readable message.
 *   RC: No shell-injection risk.
 */

import type { Command } from 'commander';
import { resolveServerUrl } from './status.js';

// ---------------------------------------------------------------------------
// Public API (exported for testing)
// ---------------------------------------------------------------------------

export interface CancelOptions {
  /** Yoke server URL. Default: from .yoke/server.json or 127.0.0.1:7777. */
  serverUrl?: string;
  /**
   * commandId for the control frame. Default: fresh crypto.randomUUID().
   * Exposed for tests so they can assert the exact value sent.
   */
  commandId?: string;
  cwd?: string;
}

export interface CancelResult {
  workflowId: string;
  commandId: string;
  status: number;
  body: unknown;
}

/**
 * Send a cancel control frame to the running Yoke server.
 * Throws on ECONNREFUSED or non-2xx response.
 *
 * @param workflowId  ID of the workflow to cancel.
 * @param opts        Optional overrides for URL, commandId, fetch.
 * @param fetcher     Injectable fetch for tests.
 */
export async function sendCancel(
  workflowId: string,
  opts: CancelOptions = {},
  fetcher: typeof fetch = fetch,
): Promise<CancelResult> {
  const serverUrl = opts.serverUrl ?? resolveServerUrl(undefined, opts.cwd);
  // Fresh UUID per invocation — idempotency key is unique on each call.
  const commandId = opts.commandId ?? crypto.randomUUID();

  const url = `${serverUrl}/api/workflows/${encodeURIComponent(workflowId)}/control`;

  let res: Response;
  try {
    res = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', commandId }),
    });
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

  const body: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(
      `Server returned ${res.status} for cancel request:\n${JSON.stringify(body, null, 2)}`,
    );
  }

  return { workflowId, commandId, status: res.status, body };
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  program
    .command('cancel <workflowId>')
    .description('Cancel a running workflow (sends a control frame with a fresh commandId)')
    .option('--url <url>', 'Yoke server URL (overrides .yoke/server.json and default)')
    .action(async (workflowId: string, opts: { url?: string }) => {
      const serverUrl = opts.url ?? resolveServerUrl(opts.url);

      let result: CancelResult;
      try {
        result = await sendCancel(workflowId, { serverUrl });
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      console.log(
        `Cancelled workflow ${result.workflowId} (commandId: ${result.commandId})`,
      );
    });
}
