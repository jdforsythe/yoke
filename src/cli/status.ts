/**
 * yoke status — poll GET /api/workflows and print a table.
 *
 * Columns: id (truncated), name, status, current_stage, active sessions.
 *
 * Server URL discovery order:
 *   1. --url flag
 *   2. .yoke/server.json in cwd (written by yoke start)
 *   3. Default http://127.0.0.1:7777
 *
 * Review criteria:
 *   RC: ECONNREFUSED → clear human-readable message (not a raw stack trace).
 *   RC: No shell-injection risk (no child_process here).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowRow {
  id: string;
  name: string;
  status: string;
  current_stage: string | null;
  active_sessions: number;
}

interface WorkflowsResponse {
  workflows: WorkflowRow[];
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Server URL discovery
// ---------------------------------------------------------------------------

/**
 * Resolve server URL from options, .yoke/server.json, or default.
 * @param explicitUrl  Value from --url flag (may be undefined).
 * @param cwd          Working directory to search for server.json.
 */
export function resolveServerUrl(explicitUrl?: string, cwd?: string): string {
  if (explicitUrl) return explicitUrl;

  const serverJson = path.join(cwd ?? process.cwd(), '.yoke', 'server.json');
  if (fs.existsSync(serverJson)) {
    try {
      const info = JSON.parse(fs.readFileSync(serverJson, 'utf8')) as { url?: string };
      if (info.url) return info.url;
    } catch {
      // Malformed server.json — fall through to default.
    }
  }

  return 'http://127.0.0.1:7777';
}

// ---------------------------------------------------------------------------
// HTTP fetch helper
// ---------------------------------------------------------------------------

/**
 * Fetches GET /api/workflows from the running Yoke server.
 * Converts ECONNREFUSED to a human-readable error.
 *
 * @param serverUrl  Base URL of the running server.
 * @param fetcher    Injectable fetch for tests (default: global fetch).
 */
export async function fetchWorkflows(
  serverUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<WorkflowsResponse> {
  let res: Response;
  try {
    res = await fetcher(`${serverUrl}/api/workflows?limit=100`);
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

  if (!res.ok) {
    throw new Error(`Server returned ${res.status}: ${await res.text()}`);
  }

  return res.json() as Promise<WorkflowsResponse>;
}

// ---------------------------------------------------------------------------
// Table formatter
// ---------------------------------------------------------------------------

/** Pad string to width, truncating with … if too long. */
function col(s: string, width: number): string {
  const str = s ?? '';
  if (str.length > width) return str.slice(0, width - 1) + '…';
  return str.padEnd(width);
}

/**
 * Format workflow rows as a plain-text table.
 * Exported so tests can assert on table structure.
 */
export function formatWorkflowTable(workflows: WorkflowRow[]): string {
  const ID_W = 10;
  const NAME_W = 24;
  const STATUS_W = 18;
  const STAGE_W = 20;
  const SESS_W = 8;

  const header =
    col('ID', ID_W) +
    '  ' +
    col('NAME', NAME_W) +
    '  ' +
    col('STATUS', STATUS_W) +
    '  ' +
    col('STAGE', STAGE_W) +
    '  ' +
    col('SESSIONS', SESS_W);

  const sep = '-'.repeat(header.length);

  if (workflows.length === 0) {
    return [header, sep, '(no workflows)'].join('\n');
  }

  const rows = workflows.map((w) =>
    [
      col(w.id.slice(0, ID_W), ID_W),
      '  ',
      col(w.name, NAME_W),
      '  ',
      col(w.status, STATUS_W),
      '  ',
      col(w.current_stage ?? '—', STAGE_W),
      '  ',
      String(w.active_sessions ?? 0).padStart(SESS_W),
    ].join(''),
  );

  return [header, sep, ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  program
    .command('status')
    .description('Poll workflow state and print a table')
    .option('--url <url>', 'Yoke server URL (overrides .yoke/server.json and default)')
    .action(async (opts: { url?: string }) => {
      const serverUrl = resolveServerUrl(opts.url);

      let data: WorkflowsResponse;
      try {
        data = await fetchWorkflows(serverUrl);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      console.log(formatWorkflowTable(data.workflows));
      if (data.hasMore) {
        console.log('(more workflows not shown — use the dashboard for full list)');
      }
    });
}
