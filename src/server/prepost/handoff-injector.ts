/**
 * Hook-failure handoff injector.
 *
 * When a post-command fires a `fresh_with_failure_summary` retry, or when a
 * goto action redirects back to a prior phase, the scheduler calls
 * injectHookFailure() to append a harness-written entry to handoff.json
 * BEFORE re-spawning the agent.
 *
 * The entry uses the same `blocking_issues` field that review agents write, so
 * implement-phase templates that already handle review failures pick up hook
 * failures too — no template changes required.
 *
 * Design rationale: reuses the existing handoff.json mechanism rather than
 * adding new DB columns, prompt-assembly parameters, or template variables.
 * The agent reads handoff.json directly (via the Read tool) and sees the
 * harness-injected entry alongside any review-phase entries.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Maximum bytes of output to store in a single handoff entry. */
const MAX_ENTRY_OUTPUT_BYTES = 16_384; // 16 KB

/** Parameters for a hook-failure entry. */
export interface HookFailureEntry {
  /** Phase name where the hook ran, e.g. "implement". */
  phase: string;
  /** 1-based attempt number of the session whose hook failed. */
  attempt: number;
  /** Session whose post-command failed. Required by handoff.schema.json. */
  sessionId: string;
  /** Name of the post-command that failed, e.g. "run-typecheck". */
  command: string;
  /** Exit code of the failed command, or null for timeout / spawn errors. */
  exitCode: number | null;
  /** Combined stdout+stderr captured from the command. */
  output: string;
}

/**
 * Appends a hook-failure entry to `<worktreePath>/handoff.json`.
 *
 * The entry has `phase: "<phase>:hook-failure"` and a `blocking_issues` array
 * containing the formatted command output, so the next agent run naturally
 * sees it when reading handoff.json.
 *
 * Safe to call when handoff.json is absent (creates a minimal structure) or
 * when its content is an unexpected shape (falls back to empty entries array).
 * Uses synchronous I/O — the file is small and only one session runs per item.
 *
 * @param worktreePath  Absolute path to the worktree directory.
 * @param entry         Details of the failed hook.
 */
export function injectHookFailure(
  worktreePath: string,
  entry: HookFailureEntry,
): void {
  const handoffPath = path.join(worktreePath, 'handoff.json');

  // Read and parse existing handoff.json, tolerating absence or invalid JSON.
  let existing: { entries?: unknown[]; [key: string]: unknown } = {};
  try {
    const raw = fs.readFileSync(handoffPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as typeof existing;
    }
  } catch {
    // File absent or unparseable — start with an empty object.
  }

  const entries: unknown[] = Array.isArray(existing.entries)
    ? [...existing.entries]
    : [];

  const truncatedOutput = entry.output.slice(0, MAX_ENTRY_OUTPUT_BYTES);
  const truncationNote =
    entry.output.length > MAX_ENTRY_OUTPUT_BYTES
      ? `\n[... truncated — ${entry.output.length - MAX_ENTRY_OUTPUT_BYTES} bytes omitted ...]`
      : '';

  entries.push({
    phase: `${entry.phase}:hook-failure`,
    attempt: entry.attempt,
    session_id: entry.sessionId,
    ts: new Date().toISOString(),
    harness_injected: true,
    command: entry.command,
    exit_code: entry.exitCode,
    blocking_issues: [
      `${entry.command} failed (exit ${entry.exitCode ?? 'null'}):\n${truncatedOutput}${truncationNote}`,
    ],
  });

  const updated = { ...existing, entries };
  fs.writeFileSync(
    handoffPath,
    JSON.stringify(updated, null, 2) + '\n',
    'utf8',
  );
}
