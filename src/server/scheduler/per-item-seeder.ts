/**
 * Per-item stage seeding (feat-per-item-seeding).
 *
 * When a per-item stage's placeholder item reaches `ready`, the scheduler
 * calls seedPerItemStage() to:
 *
 *   1. Read the items_from manifest file (JSON) from the worktree.
 *   2. Apply items_list (JSONPath) to extract the item array.
 *   3. For each manifest entry:
 *      - Extract stable ID via items_id (JSONPath).
 *      - Collect items_depends_on (JSONPath) — stable IDs → resolved to row IDs.
 *   4. All writes inside a single db.transaction():
 *      - Create real item rows (all seeded as 'pending'; SQLite is the sole
 *        source of truth for completion — the manifest never carries status).
 *      - Update downstream items whose depends_on referenced the placeholder
 *        to reference the full set of real item row IDs instead.
 *      - DELETE the placeholder row.
 *
 * ## Idempotency
 *
 *   The placeholder row is deleted inside the seeding transaction.  If the
 *   transaction commits, the placeholder is gone and the scheduler will never
 *   invoke seeding for it again.  If the transaction rolls back (e.g., SQLITE_BUSY),
 *   the placeholder is still `ready` and seeding retries on the next tick.
 *   SQLite's atomicity guarantees there is no partial-seeded state.
 *
 * ## Dependency chain
 *
 *   The placeholder's original depends_on (e.g., the previous stage's item ID)
 *   is inherited by every real item.  Within-stage ordering from items_depends_on
 *   is resolved to real row IDs via a stableId → rowId map built before any
 *   INSERT.  After seeding, any downstream item that previously depended on the
 *   placeholder now depends on ALL real item row IDs (so the next stage waits
 *   for every seeded item to complete).
 *
 * ## JSONPath evaluation
 *
 *   jsonpath-plus is used for all expressions.  The raw JSONPath result is an
 *   array of matched values.  evalList() unwraps a single-element array that
 *   is itself an array — handling both '$.features' (returns [[...]])
 *   and '$.features[?(@.active)]' (returns [...]) transparently.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { JSONPath } from 'jsonpath-plus';
import type { DbPool } from '../storage/db.js';
import type { Stage } from '../../shared/types/config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SeedResult =
  /** Real items were created; placeholder deleted. */
  | { kind: 'seeded'; count: number }
  /** Fatal seeding error (manifest unreadable, JSONPath failed, etc.). */
  | { kind: 'error'; message: string };

// ---------------------------------------------------------------------------
// JSONPath helpers
// ---------------------------------------------------------------------------

/**
 * Evaluate a JSONPath expression against json and return the result array.
 *
 * Unwraps the result if it is a single-element array whose sole element is
 * itself an array — this handles '$.features' (returns [[...]]) vs
 * '$.features[?(...)]' (returns [...]) transparently.
 */
function evalList(expr: string, json: unknown): unknown[] {
  const result = JSONPath({ path: expr, json: json as object }) as unknown[];
  if (result.length === 1 && Array.isArray(result[0])) {
    return result[0] as unknown[];
  }
  return result;
}

/**
 * Evaluate a JSONPath expression against json and return the first matched
 * value (or undefined).  For scalar extractions like '$.id'.
 */
function evalScalar(expr: string, json: unknown): unknown {
  const result = JSONPath({ path: expr, json: json as object }) as unknown[];
  return result.length > 0 ? result[0] : undefined;
}

/**
 * Walk the within-stage dependency graph and return the first cycle as a list
 * of stable IDs (e.g. `["A", "B", "A"]`), or `null` if the graph is acyclic.
 *
 * Iterative DFS with three colours:
 *   white = unvisited, grey = on the current DFS stack, black = done.
 * Hitting a grey neighbour means we've closed a back-edge — that's a cycle.
 */
function findDependencyCycle(
  records: Array<{ stableId: string; rawDepsStableIds: string[] }>,
): string[] | null {
  const adj = new Map<string, string[]>();
  for (const r of records) adj.set(r.stableId, r.rawDepsStableIds.slice());

  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map<string, number>();
  for (const id of adj.keys()) colour.set(id, WHITE);

  const parent = new Map<string, string | null>();

  function dfs(start: string): string[] | null {
    const stack: Array<{ id: string; iter: number }> = [{ id: start, iter: 0 }];
    colour.set(start, GREY);
    parent.set(start, null);

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) break;
      const neighbours = adj.get(top.id) ?? [];
      if (top.iter >= neighbours.length) {
        colour.set(top.id, BLACK);
        stack.pop();
        continue;
      }
      const next = neighbours[top.iter++];
      if (next === undefined) continue;
      const c = colour.get(next) ?? WHITE;
      if (c === GREY) {
        // Reconstruct the cycle: walk parents from top.id back to next.
        const cycle: string[] = [next];
        let cur: string | null = top.id;
        while (cur !== null && cur !== next) {
          cycle.push(cur);
          cur = parent.get(cur) ?? null;
        }
        cycle.push(next);
        cycle.reverse();
        return cycle;
      }
      if (c === WHITE) {
        colour.set(next, GREY);
        parent.set(next, top.id);
        stack.push({ id: next, iter: 0 });
      }
    }
    return null;
  }

  for (const id of adj.keys()) {
    if (colour.get(id) === WHITE) {
      const found = dfs(id);
      if (found !== null) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// seedPerItemStage — public API
// ---------------------------------------------------------------------------

export interface SeedPerItemStageOpts {
  db: DbPool;
  workflowId: string;
  /** The placeholder item row that is in status='ready'. */
  placeholderItemId: string;
  worktreePath: string;
  stage: Stage;
}

/**
 * Seed real item rows for a per-item stage.  The placeholder item is deleted
 * inside the transaction so this is safe to retry on crash recovery.
 *
 * Returns { kind: 'seeded', count } on success.
 * Returns { kind: 'error', message } if the manifest cannot be read or
 * JSONPath evaluation fails — the caller should log and retry next tick.
 */
export function seedPerItemStage(opts: SeedPerItemStageOpts): SeedResult {
  const { db, workflowId, placeholderItemId, worktreePath, stage } = opts;

  // Validate required per-item stage fields.
  if (!stage.items_from || !stage.items_list || !stage.items_id) {
    return {
      kind: 'error',
      message: `Stage '${stage.id}' is missing required items_from / items_list / items_id`,
    };
  }

  // ---------------------------------------------------------------------------
  // Step 1 — read and parse manifest
  // ---------------------------------------------------------------------------
  const manifestPath = path.resolve(worktreePath, stage.items_from);
  let manifest: unknown;
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    manifest = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'error', message: `Cannot read manifest '${manifestPath}': ${msg}` };
  }

  // ---------------------------------------------------------------------------
  // Step 2 — extract item array via items_list JSONPath
  // ---------------------------------------------------------------------------
  let items: unknown[];
  try {
    items = evalList(stage.items_list, manifest);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'error', message: `items_list JSONPath '${stage.items_list}' failed: ${msg}` };
  }

  // ---------------------------------------------------------------------------
  // Step 3 — build (stableId, rowId, data, rawDepsStableIds) per item.
  // All real items are seeded as 'pending'; SQLite is the sole source of truth
  // for completion.
  // ---------------------------------------------------------------------------

  type ItemRecord = {
    rowId: string;
    stableId: string;
    data: string;        // full manifest entry serialised as JSON
    rawDepsStableIds: string[];  // stable IDs from items_depends_on
  };

  const records: ItemRecord[] = [];
  const stableIdToRowId = new Map<string, string>();

  for (const entry of items) {
    // Extract stable ID.
    let stableId: unknown;
    try {
      stableId = evalScalar(stage.items_id, entry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { kind: 'error', message: `items_id JSONPath '${stage.items_id}' failed: ${msg}` };
    }
    if (typeof stableId !== 'string' || stableId === '') {
      return {
        kind: 'error',
        message: `items_id '${stage.items_id}' did not return a non-empty string for entry: ${JSON.stringify(entry)}`,
      };
    }

    // Detect duplicate stable IDs (config error).
    if (stableIdToRowId.has(stableId)) {
      return { kind: 'error', message: `Duplicate stable ID '${stableId}' in manifest` };
    }

    // Collect items_depends_on stable IDs (within-stage deps).
    let rawDepsStableIds: string[] = [];
    if (stage.items_depends_on) {
      try {
        const depsVal = evalList(stage.items_depends_on, entry);
        rawDepsStableIds = depsVal.filter((x) => typeof x === 'string') as string[];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          kind: 'error',
          message: `items_depends_on JSONPath '${stage.items_depends_on}' failed: ${msg}`,
        };
      }
    }

    // Self-cycle: an item cannot list itself in items_depends_on.  Without
    // this guard the workflow would silently deadlock since the item never
    // satisfies its own dependency.
    if (rawDepsStableIds.includes(stableId)) {
      return {
        kind: 'error',
        message: `Item '${stableId}' depends on itself via items_depends_on; remove the self-reference`,
      };
    }

    const rowId = crypto.randomUUID();
    stableIdToRowId.set(stableId, rowId);
    records.push({
      rowId,
      stableId,
      data: JSON.stringify(entry),
      rawDepsStableIds,
    });
  }

  // ---------------------------------------------------------------------------
  // Step 3b — validate within-stage dependency graph
  //
  // Catches two failure modes that would otherwise produce a silently stuck
  // workflow:
  //   • A dependency on a stable ID that doesn't appear in the manifest
  //     (typo).  Today the deps are silently dropped after stableId→rowId
  //     resolution; the user has no idea why their gate isn't waiting.
  //   • A cycle (A → B → A) in items_depends_on.  Cycles never satisfy and
  //     the workflow stalls forever.
  // ---------------------------------------------------------------------------

  for (const rec of records) {
    for (const dep of rec.rawDepsStableIds) {
      if (!stableIdToRowId.has(dep)) {
        return {
          kind: 'error',
          message: `Item '${rec.stableId}' depends on unknown stable ID '${dep}'; ` +
            `not found in this manifest`,
        };
      }
    }
  }

  const cycle = findDependencyCycle(records);
  if (cycle !== null) {
    return {
      kind: 'error',
      message: `Cycle detected in items_depends_on: ${cycle.join(' → ')}`,
    };
  }

  // ---------------------------------------------------------------------------
  // Step 4 — commit all mutations in a single transaction
  // ---------------------------------------------------------------------------

  const now = new Date().toISOString();
  const firstPhase = stage.phases[0] ?? null;

  db.transaction((writer) => {
    // Read the placeholder's depends_on (inherited prev-stage deps).
    const placeholderRow = writer
      .prepare('SELECT depends_on FROM items WHERE id = ?')
      .get(placeholderItemId) as { depends_on: string | null } | undefined;

    const prevStageDeps: string[] = (() => {
      if (!placeholderRow?.depends_on) return [];
      try {
        return JSON.parse(placeholderRow.depends_on) as string[];
      } catch {
        return [];
      }
    })();

    // Insert all real item rows.
    const insertStmt = writer.prepare(`
      INSERT INTO items
        (id, workflow_id, stage_id, data, status, current_phase,
         depends_on, retry_count, stable_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `);

    for (const rec of records) {
      // Resolve within-stage deps (stable IDs → row IDs).
      const withinStageDeps: string[] = rec.rawDepsStableIds
        .map((sid) => stableIdToRowId.get(sid))
        .filter((id): id is string => id !== undefined);

      // Merge prev-stage deps + within-stage deps.
      const allDeps = [...prevStageDeps, ...withinStageDeps];
      const dependsOn = allDeps.length > 0 ? JSON.stringify(allDeps) : null;

      insertStmt.run(
        rec.rowId,
        workflowId,
        stage.id,
        rec.data,
        'pending',
        firstPhase,
        dependsOn,
        rec.stableId,
        now,
      );
    }

    // Collect real item row IDs for updating downstream deps.
    const realRowIds = records.map((r) => r.rowId);

    // Update downstream items that referenced the placeholder in their depends_on.
    // We replace the placeholder ID with all real item IDs so the next stage waits
    // for every seeded item to complete before starting.
    const downstreamItems = writer
      .prepare(
        `SELECT id, depends_on FROM items
          WHERE workflow_id = ?
            AND id != ?
            AND depends_on IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM json_each(depends_on) WHERE value = ?
            )`,
      )
      .all(workflowId, placeholderItemId, placeholderItemId) as { id: string; depends_on: string }[];

    for (const downstream of downstreamItems) {
      let deps: string[];
      try {
        deps = JSON.parse(downstream.depends_on) as string[];
      } catch {
        continue;
      }
      // Replace the placeholder ID with all real item row IDs.
      const newDeps = deps
        .filter((id) => id !== placeholderItemId)
        .concat(realRowIds);
      writer
        .prepare('UPDATE items SET depends_on = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(newDeps), now, downstream.id);
    }

    // Delete the placeholder item row.
    writer.prepare('DELETE FROM items WHERE id = ?').run(placeholderItemId);
  });

  return { kind: 'seeded', count: records.length };
}
