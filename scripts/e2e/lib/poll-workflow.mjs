#!/usr/bin/env node
/**
 * Poll GET /api/workflows until the target workflow reaches a terminal status.
 *
 * CLI flags:
 *   --port <N>            Yoke server port (required)
 *   --workflow-id <id>    Workflow id to watch (required)
 *   --timeout <seconds>   Max wait time (default 300)
 *   --interval <ms>       Poll interval in ms (default 1500)
 *
 * Exit codes:
 *   0  completed (success)
 *   3  completed_with_blocked
 *   4  abandoned
 *   5  timed out
 *   1  bad arguments or unexpected error
 */

// ---------------------------------------------------------------------------
// Arg parsing (no external deps)
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

function flag(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

const port = flag('--port');
const workflowId = flag('--workflow-id');
const timeoutSec = parseInt(flag('--timeout') ?? '300', 10);
const intervalMs = parseInt(flag('--interval') ?? '1500', 10);

if (!port || !workflowId) {
  console.error('Usage: poll-workflow.mjs --port <N> --workflow-id <id> [--timeout <s>] [--interval <ms>]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Terminal status mapping
// ---------------------------------------------------------------------------
const TERMINAL = {
  completed: 0,
  completed_with_blocked: 3,
  abandoned: 4,
};

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------
const url = `http://127.0.0.1:${port}/api/workflows?limit=50`;
const deadline = Date.now() + timeoutSec * 1000;

async function tick() {
  let data;
  try {
    const res = await globalThis.fetch(url);
    if (!res.ok) {
      console.error(`[poll] HTTP ${res.status} from ${url}`);
      return null;
    }
    data = await res.json();
  } catch (err) {
    console.error(`[poll] Fetch error: ${err.message}`);
    return null;
  }

  const workflows = data?.workflows ?? [];
  const row = workflows.find((w) => w.id === workflowId);

  if (!row) {
    // Workflow may not be inserted yet — keep polling
    console.log(`[poll] ${new Date().toISOString()} status=<not_found>`);
    return null;
  }

  const status = row.status ?? 'unknown';
  const stage = row.current_stage ?? '-';
  console.log(`[poll] ${new Date().toISOString()} status=${status} stage=${stage}`);

  if (status in TERMINAL) {
    return TERMINAL[status];
  }
  return null; // still running
}

async function main() {
  while (true) {
    const result = await tick();
    if (result !== null) {
      process.exit(result);
    }

    if (Date.now() >= deadline) {
      console.error(`[poll] Timed out after ${timeoutSec}s waiting for workflow ${workflowId}`);
      process.exit(5);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

main().catch((err) => {
  console.error(`[poll] Fatal: ${err.message}`);
  process.exit(1);
});
