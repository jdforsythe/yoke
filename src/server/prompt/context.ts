/**
 * PromptContext builder — assembles the context object fed to assemblePrompt().
 *
 * Responsibilities (feat-prompt-asm, prompt-template-spec.md §4):
 *   1. Read architecture.md and progress.md from the worktree (or "" if absent).
 *   2. Parse item.data as an opaque JSON blob (AC-4: no named field access).
 *   3. Project item_state from harness-state columns (status, current_phase,
 *      retry_count, blocked_reason).
 *   4. Read handoff.json and serialize its entries array as the {{handoff}} value.
 *   5. Call git.logRecent(20) for {{git_log_recent}}.
 *   6. Call git.diffRange(from, to) for {{recent_diff}} when refs are provided.
 *   7. Return a fully-populated PromptContext; every key that appears in a
 *      standard template is present (optional keys use "" for absent content).
 *
 * Non-responsibilities:
 *   - Does NOT apply state-machine transitions.
 *   - Does NOT spawn processes.
 *   - Does NOT write to SQLite.
 *
 * I/O lives here (RC-1): fs.readFileSync calls for architecture.md, progress.md,
 * and handoff.json are in this file, not in assembler.ts.
 *
 * Review criteria compliance:
 *   RC-3  item.data is parsed as an opaque blob; no harness-level field names
 *         are accessed inside this module beyond what template vars reference.
 *         The parsed object is stored whole under the "item" key.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { PromptContext } from './engine.js';

// ---------------------------------------------------------------------------
// Row projections — typed wrappers over SQLite rows
// ---------------------------------------------------------------------------

/**
 * Projection of the columns from the `workflows` table that the context
 * builder reads. The caller is responsible for querying SQLite and producing
 * this plain object.
 */
export interface WorkflowRow {
  id: string;
  name: string;
  current_stage: string | null;
}

/**
 * Projection of the columns from the `items` table that the context builder
 * reads.
 *
 * `data` is an opaque JSON blob. The builder parses it and stores the whole
 * parsed object under the "item" key in PromptContext. No named fields within
 * `data` are accessed by the builder (AC-4, RC-3).
 */
export interface ItemRow {
  id: string;
  data: string;              // opaque JSON blob from SQLite TEXT column
  status: string;
  current_phase: string | null;
  retry_count: number;
  blocked_reason: string | null;
}

// ---------------------------------------------------------------------------
// ItemStateProjection — harness-tracked state surfaced to templates
// ---------------------------------------------------------------------------

/**
 * Harness-level state fields exposed as {{item_state}} in templates (Issue 3,
 * prompt-template-spec.md §3.2). These are the *harness* columns, not the
 * opaque item.data fields.
 *
 * Templates access these via:
 *   {{item_state}}                → full JSON object
 *   {{item_state.status}}         → string
 *   {{item_state.current_phase}}  → string or [MISSING:...] if null
 *   {{item_state.retry_count}}    → JSON-serialized number
 *   {{item_state.blocked_reason}} → string or [MISSING:...] if null
 */
export interface ItemStateProjection {
  status: string;
  current_phase: string | null;
  retry_count: number;
  blocked_reason: string | null;
}

// ---------------------------------------------------------------------------
// HandoffFile — typed shape of handoff.json
// ---------------------------------------------------------------------------

/**
 * Parsed shape of handoff.json written by previous phase sessions.
 * The entries array is the canonical handoff payload; the rest is metadata.
 */
export interface HandoffEntry {
  phase: string;
  attempt: number;
  ts: string;
  [key: string]: unknown;
}

export interface HandoffFile {
  feature?: string;
  entries?: HandoffEntry[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// GitHelper — injected abstraction for git operations (no shell in assembler)
// ---------------------------------------------------------------------------

/**
 * Git helper interface injected into the context builder.
 *
 * The builder calls these functions; the implementation uses execFileAsync('git').
 * Injecting as a plain object enables unit testing without a real git repository.
 */
export interface GitHelper {
  /**
   * Returns the last `n` commits formatted for prompt injection.
   * Equivalent to: git log --oneline -n <n>
   */
  logRecent(n: number): Promise<string>;

  /**
   * Returns the diff between two git refs.
   * Equivalent to: git diff <from> <to>
   * Returns "" if either ref is absent.
   */
  diffRange(from: string, to: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// PromptContextInputs — caller-supplied inputs to buildPromptContext()
// ---------------------------------------------------------------------------

export interface PromptContextInputs {
  /** Workflow row from SQLite. */
  workflow: WorkflowRow;
  /** Current stage configuration (id and run mode). */
  stage: { id: string; run: 'once' | 'per-item' };
  /** Item row from SQLite. Present only in per-item stage phases. */
  item?: ItemRow;
  /** Absolute path to the worktree directory. */
  worktreePath: string;
  /**
   * Absolute path to architecture.md.
   * Defaults to <worktreePath>/architecture.md if not provided.
   */
  architectureMdPath?: string;
  /**
   * Absolute path to progress.md.
   * Defaults to <worktreePath>/progress.md if not provided.
   */
  progressMdPath?: string;
  /**
   * Absolute path to handoff.json.
   * Defaults to <worktreePath>/handoff.json if not provided.
   */
  handoffPath?: string;
  /** Injected git helper. */
  git: GitHelper;
  /**
   * Start git ref for recent_diff. If absent, recent_diff is "".
   */
  diffFrom?: string;
  /**
   * End git ref for recent_diff. Defaults to "HEAD" when diffFrom is present.
   */
  diffTo?: string;
  /**
   * User-injected context string (D43). Empty string if none.
   */
  userInjectedContext?: string;
}

// ---------------------------------------------------------------------------
// buildPromptContext — public builder
// ---------------------------------------------------------------------------

/**
 * Builds a PromptContext ready for assemblePrompt().
 *
 * The returned context is fully populated: every standard template variable
 * has a value. Optional content (architecture.md, handoff.json, etc.) uses
 * "" when the file is absent.
 *
 * AC-4/RC-3: item.data is parsed as an opaque blob and stored whole under
 * ctx["item"]. The builder does not access any named fields within item.data.
 *
 * @throws {SyntaxError} if item.data is not valid JSON (caller should treat
 *   this as a configuration error — the item manifest must contain valid JSON).
 */
export async function buildPromptContext(inputs: PromptContextInputs): Promise<PromptContext> {
  const {
    workflow,
    stage,
    item,
    worktreePath,
    git,
    userInjectedContext = '',
  } = inputs;

  // ---------------------------------------------------------------------------
  // Read architecture.md (or "")
  // ---------------------------------------------------------------------------
  const archPath = inputs.architectureMdPath ?? path.join(worktreePath, 'architecture.md');
  const architecture_md = readFileOrEmpty(archPath);

  // ---------------------------------------------------------------------------
  // Call git.logRecent(20) for {{git_log_recent}}
  // ---------------------------------------------------------------------------
  const git_log_recent = await git.logRecent(20);

  // ---------------------------------------------------------------------------
  // Base context — available in all phases
  // ---------------------------------------------------------------------------
  const ctx: PromptContext = {
    workflow_name: workflow.name,
    stage_id: stage.id,
    architecture_md,
    git_log_recent,
    user_injected_context: userInjectedContext,
  };

  // ---------------------------------------------------------------------------
  // Per-item phase variables (stage.run === 'per-item' with an item present)
  // ---------------------------------------------------------------------------
  if (stage.run === 'per-item' && item !== undefined) {
    // AC-4/RC-3: parse item.data as an opaque blob — no named field access.
    // The entire parsed object is stored under "item"; the template engine
    // handles field access via dot traversal ({{item.description}}, etc.).
    const parsedItemData = JSON.parse(item.data) as Record<string, unknown>;

    // Project harness-level state (Issue 3). These are the columns from the
    // items table, NOT from item.data — the distinction is important (AC-1).
    const item_state: ItemStateProjection = {
      status: item.status,
      current_phase: item.current_phase,
      retry_count: item.retry_count,
      blocked_reason: item.blocked_reason,
    };

    // Read progress.md (or "")
    const progressPath = inputs.progressMdPath ?? path.join(worktreePath, 'progress.md');
    const progress_md = readFileOrEmpty(progressPath);

    // Read handoff.json and serialize entries (AC-6: {{handoff}})
    const handoffPath = inputs.handoffPath ?? path.join(worktreePath, 'handoff.json');
    const handoff = readHandoffEntries(handoffPath);

    // Compute recent_diff if refs are provided (or "")
    let recent_diff = '';
    if (inputs.diffFrom) {
      const diffTo = inputs.diffTo ?? 'HEAD';
      recent_diff = await git.diffRange(inputs.diffFrom, diffTo);
    }

    Object.assign(ctx, {
      item_id: item.id,
      item: parsedItemData,
      item_state: item_state as unknown as Record<string, unknown>,
      progress_md,
      handoff,
      recent_diff,
    });
  }

  return ctx;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Reads a UTF-8 text file and returns its contents, or "" if the file does
 * not exist. Other errors (permission denied, I/O error) are re-thrown.
 */
function readFileOrEmpty(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      return '';
    }
    throw err;
  }
}

/**
 * Reads handoff.json and returns the entries array as a pretty-printed JSON
 * string (AC-6: {{handoff}} variable).
 *
 * The "most-recent handoff entries" are all entries from the current
 * handoff.json file (the file is rewritten each workflow run, so reading it
 * gives the up-to-date state).
 *
 * Returns "" if the file is absent (no handoff entries yet).
 * Returns "[]" if the file exists but has no entries array.
 *
 * @throws {SyntaxError} if the file exists but is not valid JSON.
 */
function readHandoffEntries(filePath: string): string {
  const raw = readFileOrEmpty(filePath);
  if (raw === '') {
    return '';
  }
  const parsed = JSON.parse(raw) as HandoffFile;
  const entries = parsed.entries ?? [];
  return JSON.stringify(entries, null, 2);
}
