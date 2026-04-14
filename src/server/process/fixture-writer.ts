/**
 * FixtureWriter — captures a live session's stream-json output to a JSONL
 * fixture file for later replay by ScriptedProcessManager.
 *
 * ## Wire-up contract (AC-2)
 *
 * The orchestration layer (Scheduler._runSession) calls this module when
 * `.yoke/record.json` is present at session-spawn time:
 *
 *   1. Construct:  new FixtureWriter(marker.capturePath)
 *   2. Open:       writer.open()                    // writes version header
 *   3. Tee events: handle.on('stdout_line', l => writer.appendStdout(l))
 *                  handle.on('stderr_data', c => writer.appendStderr(c))
 *   4. Close:      writer.close(exitCode)            // writes exit record
 *   5. Clear marker: clearRecordMarker(configDir)
 *
 * ## Output format (matches ScriptedProcessManager fixture format, version 1)
 *
 *   { "type": "header", "version": 1 }
 *   { "type": "stdout", "line": "<raw stream-json line>" }
 *   { "type": "stderr", "chunk": "<stderr text>" }
 *   ...
 *   { "type": "exit", "code": 0 }
 *
 * ## Implementation notes
 *
 * Writes are synchronous (fs.appendFileSync) so event ordering is preserved
 * without any async buffering.  FixtureWriter is only active in capture mode
 * (not on the hot path in production), so the synchronous cost is acceptable.
 *
 * Stderr is capped at stderrCapBytes (default 64 KiB) matching the scheduler's
 * own accumulator so the fixture faithfully represents what the classifier saw.
 */

import fs from 'node:fs';
import path from 'node:path';
import { CURRENT_FIXTURE_VERSION } from './scripted-manager.js';

// ---------------------------------------------------------------------------
// FixtureWriter
// ---------------------------------------------------------------------------

export interface FixtureWriterOpts {
  /** Absolute path for the captured JSONL fixture file. */
  capturePath: string;
  /**
   * Maximum bytes of stderr to capture (same cap as the scheduler accumulator).
   * Default: 65 536 (64 KiB).
   */
  stderrCapBytes?: number;
}

/**
 * Captures a live session's events to a JSONL fixture file.
 *
 * All writes are synchronous so fixture record ordering matches event emission
 * ordering exactly — a malformed or re-ordered fixture would produce replay
 * events in the wrong order, breaking downstream tests.
 */
export class FixtureWriter {
  private readonly capturePath: string;
  private readonly stderrCapBytes: number;
  private stderrBytesSeen = 0;
  private opened = false;
  private closed = false;

  constructor(opts: FixtureWriterOpts) {
    this.capturePath = opts.capturePath;
    this.stderrCapBytes = opts.stderrCapBytes ?? 65_536;
  }

  /**
   * Creates parent directories and writes the version header line.
   * Must be called before appendStdout/appendStderr/close().
   * Throws on I/O error (EACCES, EROFS, etc.).
   */
  open(): void {
    if (this.opened) {
      throw new Error('FixtureWriter: open() already called');
    }
    fs.mkdirSync(path.dirname(this.capturePath), { recursive: true });
    // Truncate / create the file and write the header.
    fs.writeFileSync(
      this.capturePath,
      JSON.stringify({ type: 'header', version: CURRENT_FIXTURE_VERSION }) + '\n',
      { encoding: 'utf8', flag: 'w' },
    );
    this.opened = true;
  }

  /**
   * Appends a stdout_line event record to the fixture.
   * No-op if called after close().
   */
  appendStdout(line: string): void {
    if (!this.opened || this.closed) return;
    fs.appendFileSync(
      this.capturePath,
      JSON.stringify({ type: 'stdout', line }) + '\n',
      'utf8',
    );
  }

  /**
   * Appends a stderr_data event record to the fixture, up to stderrCapBytes.
   * Chunks that would exceed the cap are silently dropped (matching the
   * scheduler's accumulator behaviour so replay faithfully represents what
   * the classifier actually received).
   */
  appendStderr(chunk: string): void {
    if (!this.opened || this.closed) return;
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    if (this.stderrBytesSeen + chunkBytes > this.stderrCapBytes) return;
    this.stderrBytesSeen += chunkBytes;
    fs.appendFileSync(
      this.capturePath,
      JSON.stringify({ type: 'stderr', chunk }) + '\n',
      'utf8',
    );
  }

  /**
   * Writes the exit record and marks the writer as closed.
   * Subsequent calls to appendStdout/appendStderr are no-ops.
   * Safe to call multiple times — subsequent calls are no-ops.
   *
   * @param exitCode  Process exit code; null if killed by a signal.
   */
  close(exitCode: number | null): void {
    if (!this.opened || this.closed) return;
    this.closed = true;
    fs.appendFileSync(
      this.capturePath,
      JSON.stringify({ type: 'exit', code: exitCode ?? -1 }) + '\n',
      'utf8',
    );
  }

  /** True after open() and before close(). */
  get isOpen(): boolean {
    return this.opened && !this.closed;
  }
}
