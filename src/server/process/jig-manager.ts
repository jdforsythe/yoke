/**
 * JigProcessManager — production ProcessManager implementation.
 *
 * Spawns whatever command + args the caller passes via SpawnOpts. There are
 * no 'claude' or 'jig' string constants anywhere in this file; the command
 * comes exclusively from ResolvedConfig via the caller.
 *
 * Process lifecycle:
 *   spawn(opts)
 *     → nodeSpawn(command, args, { detached:true })
 *     → register stdin 'error' handler (EPIPE named failure class)
 *     → child.stdin.end(promptBuffer)   ← one-shot; EPIPE caught above
 *     → readline stdout → emit 'stdout_line' per NDJSON line
 *     → stderr 'data' → cap at 64 KB, emit 'stderr_data' chunks
 *     → child 'exit' → emit 'exit'
 *     → cancel(): SIGTERM(-pgid) → gracePeriodMs → SIGKILL(-pgid)
 *
 * Zombie reap: detached:true + child.unref() — the child runs in its own
 * process group; unref() lets Node.js exit without waiting for it. The OS
 * (init/launchd) adopts and reaps the child if Yoke exits first.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { ProcessError, type ProcessManager, type SpawnHandle, type SpawnOpts } from './manager.js';

/** Maximum stderr bytes buffered before the cap is enforced. */
const STDERR_CAP_BYTES = 64 * 1024; // 64 KB

// ---------------------------------------------------------------------------
// JigSpawnHandle (internal — not exported; callers program to SpawnHandle)
// ---------------------------------------------------------------------------

class JigSpawnHandle extends EventEmitter implements SpawnHandle {
  readonly pid: number;
  /**
   * pgid === pid: with detached:true the child becomes its own process group
   * leader on POSIX. kill(-pgid, sig) delivers sig to every process in the
   * group (child + any sub-children it spawns).
   */
  readonly pgid: number;

  private readonly child: ChildProcess;
  private readonly gracePeriodMs: number;
  private cancelTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(child: ChildProcess, gracePeriodMs: number) {
    super();
    this.child = child;
    this.pid = child.pid!;
    this.pgid = child.pid!;
    this.gracePeriodMs = gracePeriodMs;

    this._wireStdin();
    this._wireStdout();
    this._wireStderr();
    this._wireExit();
  }

  // -------------------------------------------------------------------------
  // Stream wiring
  // -------------------------------------------------------------------------

  /**
   * Register the stdin 'error' handler BEFORE any write is scheduled.
   * Called synchronously from the constructor so the handler is in place
   * before child.stdin.end() runs on the next event-loop tick.
   */
  private _wireStdin(): void {
    this.child.stdin!.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') {
        // EPIPE is the named failure class for "child closed its stdin end
        // before we finished writing the prompt buffer."  This does NOT crash
        // the harness; it is caught here, logged via the 'error' event, and
        // the session continues to its natural exit.
        const pe = new ProcessError(
          'epipe',
          err,
          'EPIPE on stdin write: child closed the pipe before the prompt buffer was fully delivered',
        );
        this.emit('error', pe);
      } else {
        // Any other stdin I/O error (e.g. EBADF) — re-raise as a typed
        // ProcessError so no error is swallowed.
        this.emit('error', new ProcessError('stdin_error', err, `Unexpected stdin error: ${err.message}`));
      }
    });
  }

  /**
   * Line-buffered stdout reader (readline handles the trailing partial-line
   * buffer). Each complete line is emitted as 'stdout_line' for the
   * stream-json parser (process/stream-json.ts) to consume.
   */
  private _wireStdout(): void {
    const rl = createInterface({ input: this.child.stdout!, crlfDelay: Infinity });
    rl.on('line', (line: string) => {
      this.emit('stdout_line', line);
    });
  }

  /**
   * Stderr cap enforced in the stream 'data' handler — not by accumulating
   * all stderr into memory first. Once stderrBytes reaches STDERR_CAP_BYTES,
   * further data events are discarded and 'stderr_cap_reached' is emitted
   * once to allow callers to log a warning.
   */
  private _wireStderr(): void {
    let stderrBytes = 0;
    let capWarned = false;

    this.child.stderr!.on('data', (chunk: Buffer) => {
      if (stderrBytes >= STDERR_CAP_BYTES) {
        // Cap already reached; drop this chunk silently. Warning was already
        // emitted the first time the threshold was crossed.
        return;
      }

      const remaining = STDERR_CAP_BYTES - stderrBytes;
      // Never buffer more than the remaining cap — slice the chunk if needed.
      const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      stderrBytes += slice.length;
      this.emit('stderr_data', slice.toString('utf8'));

      if (!capWarned && stderrBytes >= STDERR_CAP_BYTES) {
        capWarned = true;
        // Emit once; callers (e.g. session log writer) may log a warning.
        this.emit('stderr_cap_reached');
      }
    });
  }

  private _wireExit(): void {
    this.child.on('exit', (code, signal) => {
      // Clear any pending SIGKILL escalation timer — the process already exited.
      if (this.cancelTimer !== null) {
        clearTimeout(this.cancelTimer);
        this.cancelTimer = null;
      }
      this.emit('exit', code, signal as NodeJS.Signals | null);
    });

    this.child.on('error', (err: NodeJS.ErrnoException) => {
      // Spawn-time errors (ENOENT, EACCES) arrive here, NOT on stderr.
      this.emit(
        'error',
        new ProcessError('spawn_failed', err, `Failed to spawn process: ${err.message}`),
      );
    });
  }

  // -------------------------------------------------------------------------
  // Public interface
  // -------------------------------------------------------------------------

  isAlive(): boolean {
    try {
      // kill(pid, 0) is a POSIX liveness probe — no signal is delivered.
      // Throws ESRCH if the PID no longer exists.
      process.kill(this.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async cancel(): Promise<void> {
    if (!this.isAlive()) {
      // Already exited — nothing to do.
      return;
    }

    return new Promise<void>((resolve) => {
      // Step 2 cleanup: if the process exits before the timer fires, cancel
      // the escalation and resolve immediately.
      const onExit = (): void => {
        if (this.cancelTimer !== null) {
          clearTimeout(this.cancelTimer);
          this.cancelTimer = null;
        }
        resolve();
      };

      this.once('exit', onExit as (...args: any[]) => void);

      // Step 1: SIGTERM → entire process group.
      try {
        process.kill(-this.pgid, 'SIGTERM');
      } catch {
        // ESRCH or similar: process group already gone between isAlive() and here.
        this.off('exit', onExit as (...args: any[]) => void);
        resolve();
        return;
      }

      // Step 3 (deferred): if still alive after grace period, escalate to SIGKILL.
      this.cancelTimer = setTimeout(() => {
        this.off('exit', onExit as (...args: any[]) => void);
        try {
          process.kill(-this.pgid, 'SIGKILL');
        } catch {
          // Process group gone between SIGTERM and SIGKILL — that's fine.
        }
        // Resolve after sending SIGKILL. The 'exit' event will still fire
        // shortly for any listeners that need it.
        resolve();
      }, this.gracePeriodMs);
    });
  }
}

// ---------------------------------------------------------------------------
// JigProcessManager (exported)
// ---------------------------------------------------------------------------

/**
 * Production ProcessManager. Spawns whatever command + args the caller
 * provides — reads exclusively from SpawnOpts. No string constants here.
 */
export class JigProcessManager implements ProcessManager {
  async spawn(opts: SpawnOpts): Promise<SpawnHandle> {
    const { command, args, cwd, env, promptBuffer, gracePeriodMs = 10_000 } = opts;

    const child = nodeSpawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Merge caller env over process.env. Never pass undefined as the env
      // option — that is equivalent to inheriting the full environment, which
      // is the intended behaviour here.
      env: env !== undefined ? { ...process.env, ...env } : { ...process.env },
      // detached:true creates a new session + process group for the child
      // (pgid === child.pid on POSIX). This ensures kill(-pgid, signal)
      // delivers the signal to the entire subtree, not just the immediate child.
      detached: true,
    });

    // Construct the handle first — its _wireStdin() call registers the stdin
    // 'error' handler synchronously. EPIPE is asynchronous, so by the time
    // it fires the handler is already in place.
    const handle = new JigSpawnHandle(child, gracePeriodMs);

    // Zombie reap: unref() allows the Node.js event loop to exit without
    // waiting for this child. The OS adopts and reaps the process if Yoke
    // exits first. We still receive 'exit', 'stdout_line', 'stderr_data', and
    // 'error' events — unref() only affects the event-loop exit condition.
    child.unref();

    // One-shot stdin delivery: write the entire prompt buffer then close the
    // pipe. The 'error' handler registered above catches EPIPE if the child
    // closes stdin before we finish writing.
    child.stdin!.end(promptBuffer);

    return handle;
  }
}
