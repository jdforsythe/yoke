/**
 * Process Manager — interface and shared types.
 *
 * ProcessManager is the single abstraction the Pipeline Engine uses to start
 * a child process. Two implementations exist:
 *   JigProcessManager   — production: spawns whatever command + args the
 *                         caller supplies (always from ResolvedConfig).
 *   ScriptedProcessManager — replays recorded stream-json JSONL fixtures
 *                            (testability seam, see §Testability in plan-draft3).
 *
 * Callers program to ProcessManager + SpawnHandle. They never import from
 * jig-manager.ts directly so ScriptedProcessManager is a drop-in replacement.
 */

import type { SessionLogWriter } from '../session-log/writer.js';

// ---------------------------------------------------------------------------
// Typed error class
// ---------------------------------------------------------------------------

/** Discriminated failure kinds raised by the process lifecycle. */
export type ProcessErrorKind = 'epipe' | 'spawn_failed' | 'stdin_error';

/**
 * A named process-lifecycle failure, distinct from generic Node.js errors.
 *
 * Every catch block in process management code either handles a specific
 * ProcessErrorKind or re-raises as ProcessError — no swallowed errors.
 */
export class ProcessError extends Error {
  constructor(
    public readonly kind: ProcessErrorKind,
    public readonly cause: unknown,
    message?: string,
  ) {
    super(message ?? kind);
    this.name = 'ProcessError';
  }
}

// ---------------------------------------------------------------------------
// SpawnOpts
// ---------------------------------------------------------------------------

/**
 * Options passed to ProcessManager.spawn(). Command and args MUST come from
 * ResolvedConfig — never hard-coded strings.
 */
export interface SpawnOpts {
  /** Executable path or name — sourced from ResolvedConfig.phases[p].command. */
  command: string;
  /** Argument vector — sourced from ResolvedConfig.phases[p].args. */
  args: string[];
  /** Absolute working directory for the child process. */
  cwd: string;
  /** Additional environment variables merged over process.env. */
  env?: Record<string, string>;
  /** Prompt content written once to child stdin then the pipe is closed. */
  promptBuffer: string | Buffer;
  /**
   * Milliseconds to wait for the process to exit after SIGTERM before
   * escalating to SIGKILL. Production default: 10 000 ms.
   * Exposed so tests can use a much shorter value.
   */
  gracePeriodMs?: number;
  /**
   * Optional session log writer. If provided, each stdout line is appended to
   * the writer via writeLine() — verbatim stream-json line copy (AC-1).
   * The caller must have already called writer.open() before passing it here.
   * The writer is closed (and all pending writes flushed) before the 'exit'
   * event fires on the returned SpawnHandle.
   */
  logWriter?: SessionLogWriter;
}

// ---------------------------------------------------------------------------
// SpawnHandle
// ---------------------------------------------------------------------------

/**
 * Handle to a running child process returned by ProcessManager.spawn().
 *
 * Typed event signatures are declared via overloaded `on`/`once` so callers
 * get type-checked listener parameters. The concrete implementations are
 * EventEmitter subclasses; the interface does not import EventEmitter so
 * ScriptedProcessManager may use any backing mechanism.
 */
export interface SpawnHandle {
  /** OS PID of the child process. */
  readonly pid: number;

  /**
   * Process group ID. With detached:true the child is its own pgid leader,
   * so pgid === pid on POSIX.
   * `process.kill(-pgid, signal)` sends the signal to the entire group.
   */
  readonly pgid: number;

  /**
   * Liveness probe: `process.kill(pid, 0)`.
   * Returns true if the OS reports the process is alive, false if it has
   * exited or was never started successfully.
   */
  isAlive(): boolean;

  /**
   * Cancel the running child with SIGTERM → SIGKILL escalation:
   *   1. `process.kill(-pgid, 'SIGTERM')` — signal entire process group.
   *   2. Wait up to `gracePeriodMs`.
   *   3. If still alive, `process.kill(-pgid, 'SIGKILL')`.
   * Resolves after SIGKILL is sent (or immediately if the process is already
   * dead). Does NOT wait for the 'exit' event to fire.
   */
  cancel(): Promise<void>;

  // Typed event listeners.
  /** Raw stdout line delivered by the line-buffered reader (one NDJSON object). */
  on(event: 'stdout_line', listener: (line: string) => void): this;
  /** Chunk of stderr text (capped; see 'stderr_cap_reached'). */
  on(event: 'stderr_data', listener: (chunk: string) => void): this;
  /** Emitted once when accumulated stderr reaches the 64 KB cap. */
  on(event: 'stderr_cap_reached', listener: () => void): this;
  /** Process exited — code is null if killed by a signal. */
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  /** Typed process-lifecycle error (EPIPE, spawn_failed, stdin_error). */
  on(event: 'error', listener: (err: ProcessError) => void): this;

  once(event: 'stdout_line', listener: (line: string) => void): this;
  once(event: 'stderr_data', listener: (chunk: string) => void): this;
  once(event: 'stderr_cap_reached', listener: () => void): this;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(event: 'error', listener: (err: ProcessError) => void): this;

  /** Remove a previously registered listener. */
  off(event: string, listener: (...args: any[]) => void): this;
}

// ---------------------------------------------------------------------------
// ProcessManager interface
// ---------------------------------------------------------------------------

/**
 * The single abstraction the Pipeline Engine uses to start a child process.
 * Both JigProcessManager (production) and ScriptedProcessManager (test replay)
 * implement this interface; no JigProcessManager-specific methods are exposed.
 */
export interface ProcessManager {
  spawn(opts: SpawnOpts): Promise<SpawnHandle>;
}
