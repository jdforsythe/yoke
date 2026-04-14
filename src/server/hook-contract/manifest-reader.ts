/**
 * Manifest reader — optional .yoke/last-check.json reader.
 *
 * Source: feat-hook-contract spec; docs/design/hook-contract.md §1.
 *
 * ## Contract
 *
 *   AC-4  Absence of .yoke/last-check.json is treated as normal; returns
 *         { kind: 'absent' } without raising any event.
 *   AC-5  A malformed manifest returns { kind: 'malformed' }.  The caller
 *         must emit stream.system_notice{source:"hook", severity:"warn"} and
 *         MUST NOT affect phase acceptance.
 *   AC-6  hook_version !== "1" returns { kind: 'unknown_version', rawJson }.
 *         The caller renders a warning badge and passes through the raw JSON.
 *   RC-3  Manifest validation does NOT block phase acceptance — display-only
 *         by contract.  The caller is responsible for enforcing this.
 *
 * ## Non-responsibilities
 *
 *   - Does NOT broadcast WS frames.  Returns a typed result; the caller
 *     (scheduler) decides how to broadcast.
 *   - Does NOT affect the state machine.
 *   - Does NOT throw — always returns a typed ManifestResult.
 *   - Does NOT install or verify Claude hook files.
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single gate entry in a hook_version "1" manifest. */
export interface ManifestGate {
  name: string;
  ok: boolean;
  duration_ms: number;
  /** Extra fields are passed through verbatim (AC-6 passthrough semantics). */
  [key: string]: unknown;
}

/** Validated hook_version "1" manifest. */
export interface LastCheckManifest {
  hook_version: '1';
  ran_at: string;
  gates: ManifestGate[];
}

export type ManifestResult =
  /** File absent — normal case, no event needed (AC-4). */
  | { kind: 'absent' }
  /**
   * File present but shape is invalid (bad JSON, missing required fields,
   * gates not an array, etc.).  Caller must emit a warn notice (AC-5).
   */
  | { kind: 'malformed'; detail: string }
  /**
   * File present, valid JSON object, but hook_version is not "1".
   * Caller must render a warning badge and pass rawJson through (AC-6).
   */
  | { kind: 'unknown_version'; hookVersion: unknown; rawJson: string }
  /** File present, valid, hook_version === "1". */
  | { kind: 'ok'; manifest: LastCheckManifest };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MANIFEST_RELATIVE_PATH = '.yoke/last-check.json';

// ---------------------------------------------------------------------------
// readLastCheckManifest
// ---------------------------------------------------------------------------

/**
 * Read and validate the optional .yoke/last-check.json manifest in the
 * worktree.
 *
 * Never throws.  Returns a discriminated union; the caller is responsible
 * for all display and warning dispatch (RC-3: result never blocks acceptance).
 *
 * @param worktreePath  Absolute path to the worktree root.
 */
export function readLastCheckManifest(worktreePath: string): ManifestResult {
  const absPath = path.resolve(worktreePath, MANIFEST_RELATIVE_PATH);

  // --- Read file ---
  let rawContent: string;
  try {
    rawContent = fs.readFileSync(absPath, 'utf8');
  } catch {
    // ENOENT or unreadable — normal (AC-4).
    return { kind: 'absent' };
  }

  // --- Parse JSON ---
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch (err) {
    return {
      kind: 'malformed',
      detail: `JSON parse error: ${(err as Error).message}`,
    };
  }

  // --- Must be a plain object ---
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'malformed', detail: 'manifest root must be a JSON object' };
  }

  const obj = parsed as Record<string, unknown>;

  // --- hook_version field required ---
  if (!('hook_version' in obj)) {
    return { kind: 'malformed', detail: 'missing field: hook_version' };
  }

  // --- Unknown version → warning badge + raw passthrough (AC-6) ---
  if (obj['hook_version'] !== '1') {
    return {
      kind: 'unknown_version',
      hookVersion: obj['hook_version'],
      rawJson: rawContent,
    };
  }

  // --- Validate required v1 fields ---
  if (typeof obj['ran_at'] !== 'string') {
    return { kind: 'malformed', detail: 'missing or non-string field: ran_at' };
  }

  if (!Array.isArray(obj['gates'])) {
    return { kind: 'malformed', detail: 'missing or non-array field: gates' };
  }

  // --- Validate each gate ---
  for (let i = 0; i < (obj['gates'] as unknown[]).length; i++) {
    const gate = (obj['gates'] as unknown[])[i];
    if (typeof gate !== 'object' || gate === null) {
      return { kind: 'malformed', detail: `gates[${i}] must be an object` };
    }
    const g = gate as Record<string, unknown>;
    if (typeof g['name'] !== 'string') {
      return { kind: 'malformed', detail: `gates[${i}].name must be a string` };
    }
    if (typeof g['ok'] !== 'boolean') {
      return { kind: 'malformed', detail: `gates[${i}].ok must be a boolean` };
    }
    if (typeof g['duration_ms'] !== 'number') {
      return { kind: 'malformed', detail: `gates[${i}].duration_ms must be a number` };
    }
  }

  return {
    kind: 'ok',
    manifest: {
      hook_version: '1',
      ran_at: obj['ran_at'] as string,
      gates: obj['gates'] as ManifestGate[],
    },
  };
}
