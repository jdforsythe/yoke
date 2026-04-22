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
import * as fs from 'node:fs';
import * as path from 'node:path';
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
  /**
   * Combined stdout+stderr captured during execution, truncated to
   * OUTPUT_CAPTURE_LIMIT bytes.  Used by the scheduler to inject failure
   * context into handoff.json for fresh_with_failure_summary retries.
   * NOT persisted to SQLite — writePrepostRun() in the engine ignores this field.
   */
  output: string;
  /**
   * Absolute path to the captured stdout file, or null if no output directory
   * was provided or the process failed to spawn and produced no bytes.
   * Persisted to `prepost_runs.stdout_path` by writePrepostRun() in the engine.
   * Contents are capped at OUTPUT_CAPTURE_LIMIT bytes per the truncation policy
   * documented at the file open site in _runOneCommand().
   */
  stdoutPath: string | null;
  /**
   * Absolute path to the captured stderr file, or null (see stdoutPath).
   * Persisted to `prepost_runs.stderr_path`.
   */
  stderrPath: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default per-command wall-clock timeout (plan-draft3 §Phase Pre/Post Commands). */
export const DEFAULT_TIMEOUT_S = 15 * 60;

/**
 * Maximum bytes of combined stdout+stderr to capture per command.
 * Used by the scheduler to inject failure context into handoff.json for
 * fresh_with_failure_summary retries; NOT stored in SQLite.
 */
export const OUTPUT_CAPTURE_LIMIT = 32_768;

/**
 * Grace period between SIGTERM and SIGKILL when the timeout fires.
 * Matches the process manager's production default (10 s) per RC-5.
 */
const SIGKILL_GRACE_MS = 10_000;

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
  /**
   * Absolute path to the directory where per-command stdout/stderr capture
   * files should be written. Typically produced via
   * makePrepostOutputDir({ configDir, workflowId }) from session-log/writer.ts
   * so captures share the same ~/.yoke/<fingerprint>/ tree as session logs.
   *
   * When omitted, the runner still executes commands normally but returns
   * { stdoutPath: null, stderrPath: null } on every record — useful in tests
   * that only care about action resolution, and for the unusual case where
   * the caller has not yet set up the output tree.
   *
   * File-naming policy (Option B, chosen over per-row UUIDs): files are named
   * `<startedAtIso>-<when>-<sanitizedCommandName>.stdout.log` / `.stderr.log`,
   * where the ISO timestamp is rendered with ':' → '-' to stay filename-safe
   * and the command name is coerced to [A-Za-z0-9_-]+ to prevent path
   * injection. Uniqueness within (workflowId, item) is achieved via the
   * millisecond-precision timestamp; callers can expect at most one run per
   * command per millisecond.
   */
  outputDir?: string;
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
// Output-file naming helpers (see RunCommandsOpts.outputDir for policy)
// ---------------------------------------------------------------------------

/**
 * Coerce an arbitrary command name to a filename-safe token: ASCII letters,
 * digits, underscore, and hyphen.  Anything else collapses to '_'.  Empty
 * results fall back to 'cmd' so we never emit a zero-length stem.
 */
function _sanitizeCommandName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : 'cmd';
}

/**
 * Build `{stdoutPath, stderrPath}` for a given command within an output dir.
 * See RunCommandsOpts.outputDir for the naming policy (Option B, timestamp-
 * based).  Colons in the ISO timestamp are replaced with '-' so the filename
 * is portable across filesystems (Windows, in particular, rejects ':' in
 * filenames).
 */
function _makeOutputPaths(
  outputDir: string,
  startedAtIso: string,
  when: 'pre' | 'post',
  commandName: string,
): { stdoutPath: string; stderrPath: string } {
  const safeTs = startedAtIso.replace(/:/g, '-');
  const safeName = _sanitizeCommandName(commandName);
  const stem = `${safeTs}-${when}-${safeName}`;
  return {
    stdoutPath: path.join(outputDir, `${stem}.stdout.log`),
    stderrPath: path.join(outputDir, `${stem}.stderr.log`),
  };
}

/**
 * Open a write-stream that accepts writes until OUTPUT_CAPTURE_LIMIT bytes
 * have been committed, after which further writes are silently dropped (the
 * underlying pipe is NOT backpressured — we keep reading from the child to
 * avoid deadlock; we just stop persisting past the cap).
 *
 * Truncation policy: each file is capped at OUTPUT_CAPTURE_LIMIT bytes, the
 * same cap as the in-memory `output` buffer.  This prevents a pathological
 * prepost command from consuming unbounded disk space.  Files that hit the
 * cap are left truncated — there is no trailing marker; callers that need to
 * know whether truncation occurred should compare file size against the cap.
 *
 * TODO: retention / rotation policy — prepost output files are never pruned
 * by this module.  A separate maintenance task (to be implemented later)
 * should sweep ~/.yoke/<fingerprint>/prepost/ and apply the same retention
 * policy used for session logs.  Out of scope for F3.
 */
function _openCappedWriteStream(filePath: string): {
  write: (chunk: Buffer | string) => void;
  close: () => Promise<void>;
  bytesWritten: () => number;
} {
  const stream = fs.createWriteStream(filePath, { flags: 'w', encoding: 'utf8' });
  // Swallow errors: if the disk write fails, we keep reading from the child to
  // avoid deadlocking stdio; the in-memory `output` capture still gets the
  // bytes for fresh_with_failure_summary context.
  stream.on('error', () => {});
  let written = 0;
  return {
    write: (chunk: Buffer | string): void => {
      if (written >= OUTPUT_CAPTURE_LIMIT) return;
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      const remaining = OUTPUT_CAPTURE_LIMIT - written;
      const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
      stream.write(slice);
      written += slice.length;
    },
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        stream.end(() => resolve());
      });
    },
    bytesWritten: () => written,
  };
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
  const { worktreePath, logWriter, when, env: callerEnv, outputDir } = opts;
  const timeoutMs = (cmd.timeout_s ?? DEFAULT_TIMEOUT_S) * 1_000;
  const startTs = Date.now();
  const startedAt = new Date(startTs).toISOString();

  // Bounded combined output capture (stdout+stderr interleaved as emitted).
  // Populated throughout the promise below; read after await to build the record.
  let outputBuf = '';

  // Per-stream capped on-disk capture (see _openCappedWriteStream doc block for
  // truncation + retention policy).  Opened lazily after mkdirp succeeds; if
  // outputDir is omitted we leave both null and the record's paths stay null.
  let stdoutStream: ReturnType<typeof _openCappedWriteStream> | null = null;
  let stderrStream: ReturnType<typeof _openCappedWriteStream> | null = null;
  let plannedStdoutPath: string | null = null;
  let plannedStderrPath: string | null = null;
  if (outputDir) {
    const paths = _makeOutputPaths(outputDir, startedAt, when, cmd.name);
    plannedStdoutPath = paths.stdoutPath;
    plannedStderrPath = paths.stderrPath;
    try {
      await fs.promises.mkdir(outputDir, { recursive: true });
      stdoutStream = _openCappedWriteStream(paths.stdoutPath);
      stderrStream = _openCappedWriteStream(paths.stderrPath);
    } catch {
      // mkdir / open failure: proceed without on-disk capture. The record's
      // paths will resolve to null in the finaliser below.
      stdoutStream = null;
      stderrStream = null;
      plannedStdoutPath = null;
      plannedStderrPath = null;
    }
  }

  /** Flush + close both capture streams.  Safe to call multiple times. */
  const closeOutputStreams = async (): Promise<void> => {
    const s1 = stdoutStream;
    const s2 = stderrStream;
    stdoutStream = null;
    stderrStream = null;
    if (s1) await s1.close();
    if (s2) await s2.close();
  };

  /**
   * Remove any on-disk files the runner opened but never wrote to — used on
   * spawn-failure paths to avoid leaving zero-byte orphans behind.  Failures
   * here are swallowed (unlink is best-effort).
   */
  const cleanupEmptyOutputFiles = async (): Promise<void> => {
    for (const p of [plannedStdoutPath, plannedStderrPath]) {
      if (!p) continue;
      try {
        const st = await fs.promises.stat(p);
        if (st.size === 0) await fs.promises.unlink(p);
      } catch {
        // File missing / inaccessible — nothing to clean up.
      }
    }
  };

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
    await closeOutputStreams();
    await cleanupEmptyOutputFiles();
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
        output: '',
        stdoutPath: null,
        stderrPath: null,
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
    await closeOutputStreams();
    await cleanupEmptyOutputFiles();
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
        output: '',
        stdoutPath: null,
        stderrPath: null,
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

    // stdout: raw 'data' listener feeds the on-disk capture (byte-accurate),
    // while a readline layered on top emits line-oriented JSONL frames.
    // We read from BOTH — Node.js multiplexes 'data' events across all
    // listeners, so the child pipe does not block as long as at least one
    // consumer is draining.
    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutStream?.write(chunk);
    });
    const rl = createReadline({ input: child.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => {
      writeFrame({ type: 'prepost.command.stdout', name: cmd.name, when, text: line });
      console.log(`[prepost:${cmd.name}] ${line}`);
      if (outputBuf.length < OUTPUT_CAPTURE_LIMIT) outputBuf += line + '\n';
    });

    // stderr: buffered by line for cleaner frames; remainder flushed on close.
    let stderrBuf = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrStream?.write(chunk);
      stderrBuf += chunk.toString('utf8');
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() ?? '';
      for (const line of lines) {
        writeFrame({ type: 'prepost.command.stderr', name: cmd.name, when, text: line });
        console.error(`[prepost:${cmd.name}] ${line}`);
        if (outputBuf.length < OUTPUT_CAPTURE_LIMIT) outputBuf += line + '\n';
      }
    });
    child.stderr!.on('close', () => {
      if (stderrBuf) {
        writeFrame({ type: 'prepost.command.stderr', name: cmd.name, when, text: stderrBuf });
        console.error(`[prepost:${cmd.name}] ${stderrBuf}`);
        if (outputBuf.length < OUTPUT_CAPTURE_LIMIT) outputBuf += stderrBuf + '\n';
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
    // Capture byte counts BEFORE closing — closeOutputStreams() nulls the
    // stream references.
    const stdoutBytes = stdoutStream?.bytesWritten() ?? 0;
    const stderrBytes = stderrStream?.bytesWritten() ?? 0;
    await closeOutputStreams();
    // Spawn-error: only surface path if the stream actually received bytes
    // (ENOENT on the binary never writes anything, but e.g. EACCES mid-way
    // through spawn setup could).
    const spawnStdoutPath = plannedStdoutPath && stdoutBytes > 0 ? plannedStdoutPath : null;
    const spawnStderrPath = plannedStderrPath && stderrBytes > 0 ? plannedStderrPath : null;
    // Clean up zero-byte orphan files so spawn failures don't litter the
    // output tree.
    if (spawnStdoutPath === null && spawnStderrPath === null) {
      await cleanupEmptyOutputFiles();
    }
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
        output: outputBuf.slice(0, OUTPUT_CAPTURE_LIMIT),
        stdoutPath: spawnStdoutPath,
        stderrPath: spawnStderrPath,
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
    const stdoutBytesT = stdoutStream?.bytesWritten() ?? 0;
    const stderrBytesT = stderrStream?.bytesWritten() ?? 0;
    await closeOutputStreams();
    // Timeout: the child ran (possibly with output) before being killed.
    // Surface paths for any bytes that were captured; keep null otherwise
    // and unlink the empty files so we don't accumulate stubs for e.g.
    // commands that hang before producing a single byte.
    const timeoutStdoutPath = plannedStdoutPath && stdoutBytesT > 0 ? plannedStdoutPath : null;
    const timeoutStderrPath = plannedStderrPath && stderrBytesT > 0 ? plannedStderrPath : null;
    if (timeoutStdoutPath === null && timeoutStderrPath === null) {
      await cleanupEmptyOutputFiles();
    }
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
        output: outputBuf.slice(0, OUTPUT_CAPTURE_LIMIT),
        stdoutPath: timeoutStdoutPath,
        stderrPath: timeoutStderrPath,
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
  await closeOutputStreams();

  // Successful-run policy: paths are non-null whenever outputDir was
  // provided, even for commands that produced no bytes. Empty files are
  // fine — F4's endpoint will serve them as `{ content: "" }` with a 200.
  const exitStdoutPath = plannedStdoutPath;
  const exitStderrPath = plannedStderrPath;

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
        output: outputBuf.slice(0, OUTPUT_CAPTURE_LIMIT),
        stdoutPath: exitStdoutPath,
        stderrPath: exitStderrPath,
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
    output: outputBuf.slice(0, OUTPUT_CAPTURE_LIMIT),
    stdoutPath: exitStdoutPath,
    stderrPath: exitStderrPath,
  };

  if (isContinue(action)) {
    return { kind: 'continue_next', record };
  }

  return { kind: 'action', command: cmd.name, action, record };
}
