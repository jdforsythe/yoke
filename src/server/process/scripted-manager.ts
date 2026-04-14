/**
 * ScriptedProcessManager — testability seam for the ProcessManager interface.
 *
 * Replays a recorded stream-json fixture file instead of spawning a real child
 * process. Enables deterministic testing of the Pipeline Engine and the
 * session lifecycle without running a real agent.
 *
 * ## Fixture format (JSONL, one JSON object per line)
 *
 * Header (must be first non-blank line when present):
 *   { "type": "header", "version": 1 }
 *
 * Records (in emission order):
 *   { "type": "stdout", "line": "<raw stream-json line>" }
 *   { "type": "stderr", "chunk": "<stderr text>" }
 *   { "type": "exit",   "code": 0 }
 *
 * The header is optional for backward compatibility with fixtures written
 * before versioning was introduced. If the header is present and `version`
 * is not a recognised value, parseFixture() throws so the caller can surface
 * the mismatch rather than silently replaying unexpected records.
 *
 * Fixtures that omit the header are treated as version 1.
 *
 * ## Failure-mode fixtures (tests/fixtures/scripted-manager/)
 *
 * One fixture exists per failure-mode row from plan-draft3 §D35:
 *   session-ok.jsonl            — clean exit (exit 0), happy path
 *   nonzero-exit-transient.jsonl — exit 1 + transient-pattern stderr (ECONNRESET)
 *   nonzero-exit-permanent.jsonl — exit 1 + permanent-pattern stderr (module not found)
 *   rate-limit-mid-stream.jsonl  — rate_limit_event mid-stream, then exit 0
 *
 * ## Notes
 *
 * The manager emits events in fixture order. An implicit exit(0) is appended
 * if the fixture file ends without an exit record. All events are emitted
 * asynchronously (setImmediate) to match real process semantics and allow
 * callers to register listeners synchronously after spawn() returns.
 *
 * The ScriptedSpawnHandle uses a deterministic fake pid derived from the
 * fixture path hash so multiple concurrent handles have distinct pids.
 *
 * yoke record writes a .yoke/record.json marker; the pipeline engine reads
 * the marker at session-spawn time and uses this manager in capture mode.
 * This module implements replay only — capture mode is wired by the
 * orchestration layer, not by this module.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createInterface } from 'node:readline';
import { ProcessError, type ProcessManager, type SpawnHandle, type SpawnOpts } from './manager.js';

// ---------------------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------------------

/** The only recognised fixture schema version. */
export const CURRENT_FIXTURE_VERSION = 1;

type FixtureRecord =
  | { type: 'stdout'; line: string }
  | { type: 'stderr'; chunk: string }
  | { type: 'exit'; code: number };

// ---------------------------------------------------------------------------
// ScriptedSpawnHandle
// ---------------------------------------------------------------------------

/**
 * A SpawnHandle that replays fixture records as typed events.
 * All event emissions are deferred via setImmediate so listeners registered
 * synchronously after spawn() returns receive all events.
 */
class ScriptedSpawnHandle extends EventEmitter implements SpawnHandle {
  readonly pid: number;
  readonly pgid: number;

  private _alive = true;

  constructor(pid: number) {
    super();
    this.pid = pid;
    this.pgid = pid;
  }

  isAlive(): boolean {
    return this._alive;
  }

  async cancel(): Promise<void> {
    this._alive = false;
    // Emit synthetic exit as if SIGTERM killed the process.
    setImmediate(() => this.emit('exit', null, 'SIGTERM'));
  }

  /**
   * Replay the fixture records, emitting typed events asynchronously.
   * Resolves when all records have been emitted.
   */
  async replay(records: FixtureRecord[]): Promise<void> {
    return new Promise((resolve) => {
      let i = 0;
      const emit = () => {
        if (!this._alive || i >= records.length) {
          if (this._alive) {
            // No explicit exit record — emit implicit exit(0).
            this._alive = false;
            this.emit('exit', 0, null);
          }
          resolve();
          return;
        }

        const rec = records[i++];
        if (rec.type === 'stdout') {
          this.emit('stdout_line', rec.line);
        } else if (rec.type === 'stderr') {
          this.emit('stderr_data', rec.chunk);
        } else if (rec.type === 'exit') {
          this._alive = false;
          this.emit('exit', rec.code, null);
          resolve();
          return;
        }
        setImmediate(emit);
      };
      setImmediate(emit);
    });
  }

  // Typed event overloads — satisfy SpawnHandle interface.
  // The implementation signature uses `any` so the overloads can co-exist
  // with EventEmitter's broader string signature (TS2394 workaround).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: 'stdout_line', listener: (line: string) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: 'stderr_data', listener: (chunk: string) => void): this;
  on(event: 'stderr_cap_reached', listener: () => void): this;
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  on(event: 'error', listener: (err: ProcessError) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  once(event: 'stdout_line', listener: (line: string) => void): this;
  once(event: 'stderr_data', listener: (chunk: string) => void): this;
  once(event: 'stderr_cap_reached', listener: () => void): this;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(event: 'error', listener: (err: ProcessError) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  once(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.off(event, listener);
  }
}

// ---------------------------------------------------------------------------
// ScriptedProcessManager
// ---------------------------------------------------------------------------

export interface ScriptedManagerOptions {
  /**
   * Path to the JSONL fixture file to replay.
   * Each line must be a JSON object matching FixtureRecord.
   */
  fixturePath: string;
  /**
   * Fake PID to assign to the spawned handle.
   * Default: a deterministic value derived from the fixture path.
   */
  fakePid?: number;
}

/**
 * Parse a JSONL fixture file into an array of FixtureRecord objects.
 *
 * If the first non-blank line is a header record (`{ "type": "header",
 * "version": N }`), the version is validated against CURRENT_FIXTURE_VERSION
 * and an error is thrown for any unrecognised value. Fixtures without a header
 * are accepted as-is (treated as version 1).
 *
 * Blank lines and malformed JSON are silently skipped. Lines with an
 * unrecognised record type are also skipped.
 */
export function parseFixture(fixturePath: string): FixtureRecord[] {
  const raw = fs.readFileSync(fixturePath, 'utf8');
  const records: FixtureRecord[] = [];
  let headerChecked = false;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      // Skip malformed lines.
      continue;
    }

    if (
      typeof obj !== 'object' ||
      obj === null ||
      !('type' in obj)
    ) continue;

    const rec = obj as Record<string, unknown>;

    // Check for version header on the first non-blank parseable line.
    if (!headerChecked) {
      headerChecked = true;
      if (rec.type === 'header') {
        if (rec.version !== CURRENT_FIXTURE_VERSION) {
          throw new Error(
            `Unsupported fixture version: ${String(rec.version)} (expected ${CURRENT_FIXTURE_VERSION})`,
          );
        }
        continue; // Header consumed; not added to records.
      }
      // First line is not a header — treat as headerless (version 1).
    }

    if (rec.type === 'stdout' && typeof rec.line === 'string') {
      records.push({ type: 'stdout', line: rec.line });
    } else if (rec.type === 'stderr' && typeof rec.chunk === 'string') {
      records.push({ type: 'stderr', chunk: rec.chunk });
    } else if (rec.type === 'exit' && typeof rec.code === 'number') {
      records.push({ type: 'exit', code: rec.code });
    }
    // Unknown types are silently skipped.
  }

  return records;
}

/**
 * Derive a deterministic fake PID from a fixture path string.
 * Avoids collisions between concurrently running scripted handles.
 */
function deriveFakePid(fixturePath: string): number {
  let hash = 0;
  for (let i = 0; i < fixturePath.length; i++) {
    hash = (hash * 31 + fixturePath.charCodeAt(i)) | 0;
  }
  // Keep in the range 90000–99999 to avoid real PID collisions.
  return 90000 + (Math.abs(hash) % 10000);
}

/**
 * ProcessManager implementation that replays a recorded JSONL fixture.
 *
 * spawn() returns a handle immediately. The handle begins replaying records
 * on the next event-loop tick so callers can register listeners synchronously.
 * The replay runs to completion without waiting for acknowledgment — this
 * matches the real process manager where stdout lines arrive whenever the
 * child writes them.
 */
export class ScriptedProcessManager implements ProcessManager {
  private readonly fixturePath: string;
  private readonly fakePid: number;

  constructor(opts: ScriptedManagerOptions) {
    this.fixturePath = opts.fixturePath;
    this.fakePid = opts.fakePid ?? deriveFakePid(opts.fixturePath);
  }

  async spawn(_opts: SpawnOpts): Promise<SpawnHandle> {
    const records = parseFixture(this.fixturePath);
    const handle = new ScriptedSpawnHandle(this.fakePid);
    // Start replay on the next tick — callers register listeners synchronously
    // after spawn() returns before any events fire.
    void handle.replay(records);
    return handle;
  }
}
