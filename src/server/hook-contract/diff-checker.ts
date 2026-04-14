/**
 * Diff-checker — items_from pre-phase snapshot and post-session comparison.
 *
 * Source: feat-hook-contract spec; docs/design/hook-contract.md §2.
 *
 * ## Contract
 *
 *   AC-1  diff_check_fail raised when items_from has any non-whitespace change
 *         between pre-phase snapshot and post-session state.  Diff summary
 *         included in the result.
 *   AC-2  diff_check_ok raised when the file is unchanged (non-whitespace
 *         content identical).
 *   RC-1  Pre-phase snapshot is taken BEFORE the agent session spawns, not
 *         from git history.
 *
 * ## Non-responsibilities
 *
 *   - Does NOT raise state-machine events.  Returns a typed result; the
 *     caller (scheduler) fires the event.
 *   - Does NOT interact with SQLite.
 *   - Does NOT throw — always returns a typed DiffCheckResult.
 *   - Does NOT check when items_from is undefined; returns { kind: 'skip' }.
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Pre-session snapshot of the items_from file content.
 * null  — file did not exist (or items_from not configured) when snapshot was taken.
 * string — raw file content at snapshot time.
 */
export type DiffSnapshot = string | null;

export type DiffCheckResult =
  /** items_from not configured, or snapshot was null and file still absent. */
  | { kind: 'skip' }
  /** Non-whitespace content identical — file unchanged. */
  | { kind: 'ok' }
  /** Non-whitespace content differs — diff summary describes the change. */
  | { kind: 'fail'; diffSummary: string };

// ---------------------------------------------------------------------------
// takeSnapshot — call before spawning the agent session (RC-1)
// ---------------------------------------------------------------------------

/**
 * Read the current content of the items_from file for a given stage.
 *
 * Returns null if `itemsFromPath` is undefined OR the file does not exist.
 * Never throws.
 *
 * @param worktreePath  Absolute path to the worktree root.
 * @param itemsFromPath Path to the items_from file, relative to worktreePath.
 *                      If undefined, returns null immediately.
 */
export function takeSnapshot(worktreePath: string, itemsFromPath: string | undefined): DiffSnapshot {
  if (!itemsFromPath) return null;

  const absPath = path.resolve(worktreePath, itemsFromPath);
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    // File absent or unreadable — treat as "not present before session".
    return null;
  }
}

// ---------------------------------------------------------------------------
// checkDiff — call after the agent session exits (RC-1)
// ---------------------------------------------------------------------------

/**
 * Compare the post-session state of the items_from file against the
 * pre-session snapshot.
 *
 * Whitespace-only changes are ignored; only changes to non-whitespace
 * content trigger diff_check_fail (AC-1).
 *
 * @param snapshot      Value returned by takeSnapshot before spawn.
 * @param worktreePath  Absolute path to the worktree root.
 * @param itemsFromPath Relative path to the items_from file (same value
 *                      passed to takeSnapshot).  If undefined, returns skip.
 */
export function checkDiff(
  snapshot: DiffSnapshot,
  worktreePath: string,
  itemsFromPath: string | undefined,
): DiffCheckResult {
  if (!itemsFromPath) return { kind: 'skip' };

  // If the file didn't exist before the session...
  if (snapshot === null) {
    // Try to read current state.
    const absPath = path.resolve(worktreePath, itemsFromPath);
    let current: string;
    try {
      current = fs.readFileSync(absPath, 'utf8');
    } catch {
      // Still absent — no change.
      return { kind: 'skip' };
    }
    // File was created during the session: that is a non-whitespace change
    // (unless the new file is entirely whitespace, which would be unusual).
    const stripped = stripWhitespace(current);
    if (stripped.length === 0) {
      return { kind: 'skip' };
    }
    const lineCount = current.split('\n').length;
    return {
      kind: 'fail',
      diffSummary: `items_from file created during session (${lineCount} line${lineCount !== 1 ? 's' : ''})`,
    };
  }

  // File existed before the session — compare against current content.
  const absPath = path.resolve(worktreePath, itemsFromPath);
  let current: string;
  try {
    current = fs.readFileSync(absPath, 'utf8');
  } catch {
    // File was deleted during the session.
    return {
      kind: 'fail',
      diffSummary: 'items_from file deleted during session',
    };
  }

  const snapshotStripped = stripWhitespace(snapshot);
  const currentStripped = stripWhitespace(current);

  if (snapshotStripped === currentStripped) {
    return { kind: 'ok' };
  }

  // Build a minimal diff summary: line-count delta + character delta.
  const beforeLines = snapshot.split('\n').length;
  const afterLines = current.split('\n').length;
  const deltaLines = afterLines - beforeLines;
  const deltaChars = currentStripped.length - snapshotStripped.length;

  const parts: string[] = [
    `lines: ${beforeLines} → ${afterLines} (${deltaLines >= 0 ? '+' : ''}${deltaLines})`,
    `non-whitespace chars: ${snapshotStripped.length} → ${currentStripped.length} (${deltaChars >= 0 ? '+' : ''}${deltaChars})`,
  ];

  return {
    kind: 'fail',
    diffSummary: parts.join('; '),
  };
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/** Remove all whitespace characters from a string. */
function stripWhitespace(s: string): string {
  return s.replace(/\s+/g, '');
}
