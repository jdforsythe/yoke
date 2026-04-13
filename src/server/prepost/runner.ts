/**
 * Pre/Post Command Runner — executes pre/post command arrays for a phase.
 *
 * Responsibilities:
 *   - Spawn each PrePostCommand in declared order with shell:false.
 *   - Enforce per-command wall-clock timeout (default DEFAULT_TIMEOUT_S = 15 min).
 *   - Stream stdout/stderr to the session log as prepost.command.* frames (AC-2).
 *   - Resolve exit code → action via action-grammar.ts.
 *   - Stop on the first non-continue action and return it to the caller.
 *   - Return { kind: 'complete' } when all commands complete with "continue".
 *
 * Non-responsibilities:
 *   - Action execution (goto, retry, stop, fail) — done by the Pipeline Engine.
 *   - Any SQLite write — Pipeline Engine is the sole SQLite mutator.
 *   - Spawning the agent session command — that is ProcessManager's job.
 *
 * Frame format written to the session log (JSONL):
 *   {"type":"prepost.command.start","name":"<n>","when":"pre|post","cmd":[...],"ts":"<iso>"}
 *   {"type":"prepost.command.stdout","name":"<n>","when":"pre|post","text":"<line>"}
 *   {"type":"prepost.command.stderr","name":"<n>","when":"pre|post","text":"<chunk>"}
 *   {"type":"prepost.command.exit","name":"<n>","when":"pre|post","exit_code":<n>,"elapsed_ms":<n>}
 *   {"type":"prepost.command.exit","name":"<n>","when":"pre|post","exit_code":null,"elapsed_ms":<n>,"timed_out":true}
 *
 * Log writes are serialised via a promise chain (_writeQueue) so frames arrive
 * in emission order even though writeLine() is async. The chain is always
 * drained before the function returns, so callers see a fully-flushed log.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { createInterface as createReadline } from 'node:readline';
import type { ActionValue, PrePostCommand } from '../../shared/types/config.js';
import type { SessionLogWriter } from '../session-log/writer.js';
import { isContinue, resolveAction } from './action-grammar.js';

// ---------------------------------------------------------------------------
// Per-command execution record (persisted to prepost_runs by the engine)
// ---------------------------------------------------------------------------

/**
 * One row's worth of data for `prepost_runs`.  The runner populates a record
 * for every command it executes, regardless of outcome (continue / action /
 * timeout / spawn_failed / unhandled_exit).  The pipeline engine inserts these
 * into SQLite inside the same db.transaction() as the corresponding state
 * transition (AC-6, RC-4).
 */
export interface PrePostRunRecord {
  /** Value of PrePostCommand.name. */
  commandName: string;
  /** Full argv-form run array as passed to spawn. */
  argv: string[];
  /** Whether this was a pre- or post-phase command. */
  when: 'pre' | 'post';
  /** ISO timestamp at spawn start (or attempted spawn start). */
  startedAt: string;
  /** ISO timestamp when the command closed / errored / timed out. */
  endedAt: string;
  /** Numeric exit code, or null for timeout / spawn failure. */
  exitCode: number | null;
  /** The resolved ActionValue, or null if no action matched (unhandled exit, timeout, error). */
  actionTaken: ActionValue | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default per-command wall-clock timeout (plan-draft3 §Phase Pre/Post Commands). */
export const DEFAULT_TIMEOUT_S = 15 * 60;

/**
 * Grace period between SIGTERM and SIGKILL when the timeout fires.
 * Kept short (5 s) because pre/post commands must not stall the pipeline.
 */
const SIGKILL_GRACE_MS = 5_000;

// ---------------------------------------------------------------------------
// Public result type
// ---------------------------------------------------------------------------

export type RunCommandsResult =
  /** All commands completed with the "continue" action. */
  | { kind: 'complete'; runs: PrePostRunRecord[] }
  /** A command produced a non-continue action. Pipeline Engine must execute it. */
  | { kind: 'action'; command: string; action: ActionValue; runs: PrePostRunRecord[] }
  /** A command exceeded its wall-clock timeout. */
  | { kind: 'timeout'; command: string; runs: PrePostRunRecord[] }
  /** A command could not be spawned (ENOENT, bad run array, etc.). */
  | { kind: 'spawn_failed'; command: string; error: Error; runs: PrePostRunRecord[] }
  /** A command exited with a code not declared in its actions map. */
  | { kind: 'unhandled_exit'; command: string; exitCode: number; runs: PrePostRunRecord[] };

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RunCommandsOpts {
  /** Array of pre: or post: commands from the phase config. */
  commands: PrePostCommand[];
  /** Absolute path to the worktree directory (CWD for each command). */
  worktreePath: string;
  /**
   * Open session log writer. The runner appends prepost.command.* frames to it.
   * Caller must have already called writer.open() before passing it here.
   * The runner does NOT close the writer — the same writer is shared with the
   * Process Manager for the agent session.
   */
  logWriter: SessionLogWriter;
  /** Whether these are pre- or post-commands (recorded in frame metadata). */
  when: 'pre' | 'post';
  /**
   * Additional environment variables merged over process.env (then over cmd.env).
   * Mirrors the env injection contract of JigProcessManager.
   */
  env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Runs an array of pre/post commands sequentially.
 *
 * Stops after the first non-continue action (or error) and returns the result.
 * All log frames are flushed before returning.  Every command that runs
 * produces a PrePostRunRecord in `result.runs`; the pipeline engine persists
 * these to `prepost_runs` inside the same transaction as the state transition.
 *
 * @param opts  Runner options — see RunCommandsOpts.
 * @returns     RunCommandsResult indicating how the command array concluded.
 */
export async function runCommands(opts: RunCommandsOpts): Promise<RunCommandsResult> {
  const runs: PrePostRunRecord[] = [];

  for (const cmd of opts.commands) {
    const { record, ...outcome } = await _runOneCommand(cmd, opts);
    runs.push(record);

    if (outcome.kind === 'continue_next') continue;

    // Non-continue outcome — assemble the full result and return.
    if (outcome.kind === 'action') {
      return { kind: 'action', command: outcome.command, action: outcome.action, runs };
    }
    if (outcome.kind === 'timeout') {
      return { kind: 'timeout', command: outcome.command, runs };
    }
    if (outcome.kind === 'spawn_failed') {
      return { kind: 'spawn_failed', command: outcome.command, error: outcome.error, runs };
    }
    // unhandled_exit
    return { kind: 'unhandled_exit', command: outcome.command, exitCode: outcome.exitCode, runs };
  }

  return { kind: 'complete', runs };
}

// ---------------------------------------------------------------------------
// Internal single-command runner
// ---------------------------------------------------------------------------

/**
 * Internal result — adds 'continue_next' sentinel for the loop, and always
 * carries the PrePostRunRecord so the outer loop can accumulate them.
 */
type OneCommandResult =
  | { kind: 'continue_next'; record: PrePostRunRecord }
  | { kind: 'action'; command: string; action: ActionValue; record: PrePostRunRecord }
  | { kind: 'timeout'; command: string; record: PrePostRunRecord }
  | { kind: 'spawn_failed'; command: string; error: Error; record: PrePostRunRecord }
  | { kind: 'unhandled_exit'; command: string; exitCode: number; record: PrePostRunRecord };

async function _runOneCommand(
  cmd: PrePostCommand,
  opts: RunCommandsOpts,
): Promise<OneCommandResult> {
  const { worktreePath, logWriter, when, env: callerEnv } = opts;
  const timeoutMs = (cmd.timeout_s ?? DEFAULT_TIMEOUT_S) * 1_000;
  const startTs = Date.now();
  const startedAt = new Date(startTs).toISOString();

  // Serialised write queue — ensures frames arrive in emission order.
  let _writeQueue: Promise<void> = Promise.resolve();
  const writeFrame = (frame: Record<string, unknown>): void => {
    _writeQueue = _writeQueue.then(() => logWriter.writeLine(JSON.stringify(frame))).catch(() => {});
  };

  // Merge environment: process.env < caller extras < command-specific env.
  const mergedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(callerEnv ?? {}),
    ...(cmd.env ?? {}),
  };

  // Guard: a pre/post command must have at least one element in its run array.
  const [command, ...args] = cmd.run;
  if (!command) {
    return {
      kind: 'spawn_failed',
      command: cmd.name,
      error: new Error(`prepost command '${cmd.name}': run array is empty`),
      record: {
        commandName: cmd.name,
        argv: cmd.run,
        when,
        startedAt,
        endedAt: new Date().toISOString(),
        exitCode: null,
        actionTaken: null,
      },
    };
  }

  // Pre-spawn frame.
  writeFrame({
    type: 'prepost.command.start',
    name: cmd.name,
    when,
    cmd: cmd.run,
    ts: new Date().toISOString(),
  });

  // Spawn with shell:false (RC-1: no hidden /bin/sh -c invocation).
  let child: ReturnType<typeof nodeSpawn>;
  try {
    child = nodeSpawn(command, args, {
      cwd: worktreePath,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: mergedEnv,
      detached: true,
    });
  } catch (err) {
    // Synchronous spawn failure — only happens if command is not a string, etc.
    return {
      kind: 'spawn_failed',
      command: cmd.name,
      error: err instanceof Error ? err : new Error(String(err)),
      record: {
        commandName: cmd.name,
        argv: cmd.run,
        when,
        startedAt,
        endedAt: new Date().toISOString(),
        exitCode: null,
        actionTaken: null,
      },
    };
  }

  // Allow Node.js to exit without waiting for the child.
  child.unref();

  // Outcome promise — resolves once the child closes (all I/O drained).
  type Outcome =
    | { type: 'close'; code: number | null }
    | { type: 'spawn_error'; err: Error }
    | { type: 'timeout' };

  const outcome = await new Promise<Outcome>((resolve) => {
    let resolved = false;
    const settle = (o: Outcome): void => {
      if (!resolved) {
        resolved = true;
        resolve(o);
      }
    };

    // Wall-clock timeout.
    const pgid = child.pid;
    const timeoutId = setTimeout(() => {
      // SIGTERM first; SIGKILL after grace period if still alive.
      if (pgid !== undefined) {
        try {
          process.kill(-pgid, 'SIGTERM');
        } catch {
          // Process already gone between spawn and timeout — acceptable.
        }
        setTimeout(() => {
          try {
            process.kill(-pgid, 'SIGKILL');
          } catch {
            // Process already gone — acceptable.
          }
        }, SIGKILL_GRACE_MS);
      }
      settle({ type: 'timeout' });
    }, timeoutMs);

    // stdout: line-buffered, one frame per line.
    const rl = createReadline({ input: child.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => {
      writeFrame({ type: 'prepost.command.stdout', name: cmd.name, when, text: line });
    });

    // stderr: buffered by line for cleaner frames; remainder flushed on close.
    let stderrBuf = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() ?? '';
      for (const line of lines) {
        writeFrame({ type: 'prepost.command.stderr', name: cmd.name, when, text: line });
      }
    });
    child.stderr!.on('close', () => {
      if (stderrBuf) {
        writeFrame({ type: 'prepost.command.stderr', name: cmd.name, when, text: stderrBuf });
        stderrBuf = '';
      }
    });

    // Async spawn error (ENOENT, EACCES, etc.) — fires instead of / before 'close'.
    child.on('error', (err: Error) => {
      clearTimeout(timeoutId);
      settle({ type: 'spawn_error', err });
    });

    // 'close' fires after the child process exits AND all stdio streams are
    // drained — guarantees all stdout/stderr events have already fired.
    child.on('close', (code) => {
      clearTimeout(timeoutId);
      settle({ type: 'close', code });
    });
  });

  // Drain all pending log writes before writing the exit frame.
  await _writeQueue;

  if (outcome.type === 'spawn_error') {
    return {
      kind: 'spawn_failed',
      command: cmd.name,
      error: outcome.err,
      record: {
        commandName: cmd.name,
        argv: cmd.run,
        when,
        startedAt,
        endedAt: new Date().toISOString(),
        exitCode: null,
        actionTaken: null,
      },
    };
  }

  const elapsedMs = Date.now() - startTs;
  const endedAt = new Date(startTs + elapsedMs).toISOString();

  if (outcome.type === 'timeout') {
    writeFrame({
      type: 'prepost.command.exit',
      name: cmd.name,
      when,
      exit_code: null,
      elapsed_ms: elapsedMs,
      timed_out: true,
    });
    await _writeQueue;
    return {
      kind: 'timeout',
      command: cmd.name,
      record: {
        commandName: cmd.name,
        argv: cmd.run,
        when,
        startedAt,
        endedAt,
        exitCode: null,
        actionTaken: null,
      },
    };
  }

  // Normal exit.
  const exitCode = outcome.code ?? -1;
  writeFrame({
    type: 'prepost.command.exit',
    name: cmd.name,
    when,
    exit_code: exitCode,
    elapsed_ms: elapsedMs,
  });
  await _writeQueue;

  const action = resolveAction(cmd.actions, exitCode);
  if (action === null) {
    return {
      kind: 'unhandled_exit',
      command: cmd.name,
      exitCode,
      record: {
        commandName: cmd.name,
        argv: cmd.run,
        when,
        startedAt,
        endedAt,
        exitCode,
        actionTaken: null,
      },
    };
  }

  const record: PrePostRunRecord = {
    commandName: cmd.name,
    argv: cmd.run,
    when,
    startedAt,
    endedAt,
    exitCode,
    actionTaken: action,
  };

  if (isContinue(action)) {
    return { kind: 'continue_next', record };
  }

  return { kind: 'action', command: cmd.name, action, record };
}
