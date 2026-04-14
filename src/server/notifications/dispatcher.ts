/**
 * Notification dispatcher — feat-notifications.
 *
 * Two severity modes:
 *   info              → console.log only; no native notification (AC-2).
 *   requires_attention → reads pending_attention row at emission time (AC-5);
 *                        fires node-notifier on macOS (AC-1); no notification
 *                        without a corresponding DB row (AC-4).
 *
 * Design invariants:
 *   RC-1  pending_attention is the source of truth; notification is a side
 *         effect of inserting the row, not the source.
 *   RC-3  node-notifier is gracefully skipped on non-macOS or when the native
 *         binary is unavailable — no crash.
 *   RC-4  Dispatcher reads the pending_attention row before firing; if the row
 *         is absent, no notification is emitted.
 */

import type { DbPool } from '../storage/db.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type NotificationSeverity = 'info' | 'requires_attention';

/**
 * Injectable notifier function. Used to decouple tests from the OS notification
 * system. In production, this defaults to a node-notifier wrapper loaded via
 * dynamic import (macOS only, RC-3).
 */
export type NotifierFn = (opts: {
  title: string;
  message: string;
  open: string;
}) => void;

export interface NotificationDispatcherDeps {
  db: DbPool;
  /**
   * Base URL for deep-link construction, e.g. "http://127.0.0.1:7777".
   * Used to build the workflow-specific URL included in requires_attention
   * notifications.
   */
  baseUrl: string;
  /**
   * Injectable notifier. If provided, this is used instead of dynamically
   * importing node-notifier. Primarily for testing — avoids firing real OS
   * notifications.
   */
  notifier?: NotifierFn;
}

export interface DispatchOpts {
  severity: NotificationSeverity;
  /** Human-readable message describing the notification. */
  message: string;
  /** Workflow ID — used for DB reads and deep-link URL construction. */
  workflowId: string;
  /**
   * The pending_attention row ID inserted by the engine.
   * Required for requires_attention; absent for info.
   * If omitted or if the row is not found in SQLite, no native notification
   * is emitted (AC-4 enforcement).
   */
  pendingAttentionRowId?: number;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatches a notification according to severity.
 *
 * For 'info': logs to console only (AC-2).
 * For 'requires_attention': reads the pending_attention row from SQLite at
 *   emission time (AC-5), then fires node-notifier on macOS with the workflow
 *   name and a deep-link URL (AC-1). If the row is absent, no notification is
 *   emitted (AC-4). Gracefully skips node-notifier on non-macOS or when the
 *   native binary is unavailable (RC-3).
 */
export async function dispatchNotification(
  deps: NotificationDispatcherDeps,
  opts: DispatchOpts,
): Promise<void> {
  if (opts.severity === 'info') {
    // AC-2: info severity → console only, no native notification.
    console.log(`[yoke] ${opts.workflowId}: ${opts.message}`);
    return;
  }

  // requires_attention path.

  // AC-4: no notification without a pendingAttentionRowId provided.
  if (opts.pendingAttentionRowId == null) {
    return;
  }

  // AC-5: read pending_attention at emission time from SQLite (not in-memory).
  const row = deps.db.reader().prepare(
    'SELECT id, workflow_id, kind FROM pending_attention WHERE id = ?',
  ).get(opts.pendingAttentionRowId) as {
    id: number;
    workflow_id: string;
    kind: string;
  } | undefined;

  // AC-4: row must exist before any notification is emitted.
  if (!row) {
    return;
  }

  // Read workflow name from DB for the notification title.
  const wfRow = deps.db.reader().prepare(
    'SELECT name FROM workflows WHERE id = ?',
  ).get(opts.workflowId) as { name: string } | undefined;
  const workflowName = wfRow?.name ?? opts.workflowId;

  const deepLinkUrl = `${deps.baseUrl}/workflows/${opts.workflowId}`;
  const title = `Yoke: ${workflowName}`;
  const message = opts.message;

  // Always log to console (visible in terminal and CI).
  console.log(`[yoke] attention required — ${title}: ${message} (${deepLinkUrl})`);

  // RC-3: skip native notification on non-macOS.
  if (process.platform !== 'darwin') {
    return;
  }

  // Use injected notifier (tests) or load node-notifier dynamically (production).
  const notifyFn: NotifierFn | null = deps.notifier ?? await loadNodeNotifier();
  if (!notifyFn) {
    // RC-3: gracefully skip when node-notifier binary is unavailable.
    return;
  }

  try {
    notifyFn({ title, message, open: deepLinkUrl });
  } catch {
    // RC-3: gracefully skip if the underlying binary call fails.
  }
}

// ---------------------------------------------------------------------------
// Internal: dynamic node-notifier loader
// ---------------------------------------------------------------------------

/**
 * Attempts to dynamically import node-notifier and wraps its notify function.
 * Returns null on import failure (package not installed, binary missing).
 * RC-3: no crash on missing dependency.
 *
 * The module name is constructed at runtime so TypeScript does not try to
 * statically resolve the type (the package is an optional dependency).
 */
async function loadNodeNotifier(): Promise<NotifierFn | null> {
  try {
    // Construct the module name at runtime to prevent tsc from emitting a
    // TS2307 "cannot find module" error for an optional dependency.
    const pkgName = 'node' + '-notifier';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import(pkgName) as {
      default: { notify(opts: { title: string; message: string; open?: string }): void };
    };
    return (notifyOpts) => {
      mod.default.notify(notifyOpts);
    };
  } catch {
    // Import failure (not installed, native module missing, etc.) — skip.
    return null;
  }
}
