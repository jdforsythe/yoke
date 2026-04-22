/**
 * Session Log Writer — append-only per-session JSONL file.
 *
 * Log files live under ~/.yoke/<fingerprint>/logs/<workflowId>/<sessionId>.jsonl.
 * The fingerprint is derived from the configDir so that parallel yoke projects
 * on the same machine never collide (RC-4).
 *
 * The writer holds an open FileHandle opened with O_APPEND | O_CREAT (flag 'a').
 * All writes go through fs.FileHandle.appendFile — no seek, no random access (RC-1).
 *
 * Lifetime: open() on session spawn → writeLine() × N → close() on session end.
 * The file lives in ~/.yoke/, not in the worktree, so it survives worktree
 * teardown and cleanup (AC-3).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DbPool } from '../storage/db.js';

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

/**
 * Log retention is governed by config.retention.stream_json_logs (max_age_days,
 * max_total_bytes). No automatic cleanup runs in the writer — a separate
 * background maintenance task scans ~/.yoke/<fingerprint>/logs/ and prunes
 * files that exceed the retention policy (RC-2). The writer itself is append-only
 * and never deletes or truncates files.
 */

/**
 * Derives a 16-hex-char fingerprint from the config directory absolute path.
 * SHA-256 of the path string, first 16 hex chars.
 * Different configDirs → different fingerprints → no log path collisions (RC-4).
 */
export function makeFingerprint(configDir: string): string {
  return crypto.createHash('sha256').update(configDir).digest('hex').slice(0, 16);
}

/**
 * Constructs the absolute path for a session's JSONL log file.
 *
 * Format: <homeDir>/.yoke/<fingerprint>/logs/<workflowId>/<sessionId>.jsonl
 *
 * @param configDir  Absolute path to the directory containing .yoke.yml.
 * @param workflowId Workflow row ID.
 * @param sessionId  Session row ID.
 * @param homeDir    Override for os.homedir() (tests only).
 */
export function makeSessionLogPath(opts: {
  configDir: string;
  workflowId: string;
  sessionId: string;
  homeDir?: string;
}): string {
  const { configDir, workflowId, sessionId, homeDir = os.homedir() } = opts;
  const fingerprint = makeFingerprint(configDir);
  return path.join(homeDir, '.yoke', fingerprint, 'logs', workflowId, `${sessionId}.jsonl`);
}

/**
 * Constructs the absolute directory path for prepost command stdout/stderr
 * capture files for a given workflow.
 *
 * Format: <homeDir>/.yoke/<fingerprint>/prepost/<workflowId>/
 *
 * Mirrors makeSessionLogPath() so both log families share the same fingerprint
 * scheme (RC-4 — parallel yoke projects on the same machine never collide).
 * The directory is not created here; callers are expected to mkdir -p before
 * opening files inside it.
 *
 * @param configDir  Absolute path to the directory containing .yoke.yml.
 * @param workflowId Workflow row ID.
 * @param homeDir    Override for os.homedir() (tests only).
 */
export function makePrepostOutputDir(opts: {
  configDir: string;
  workflowId: string;
  homeDir?: string;
}): string {
  const { configDir, workflowId, homeDir = os.homedir() } = opts;
  const fingerprint = makeFingerprint(configDir);
  return path.join(homeDir, '.yoke', fingerprint, 'prepost', workflowId);
}

// ---------------------------------------------------------------------------
// SessionLogWriter
// ---------------------------------------------------------------------------

/**
 * Append-only JSONL writer for a single session.
 *
 * Usage:
 *   const writer = new SessionLogWriter(logPath);
 *   await writer.open();          // creates dirs + opens file handle
 *   await writer.writeLine(line); // append one JSONL line
 *   await writer.close();         // flush + close
 */
export class SessionLogWriter {
  private fileHandle: fs.promises.FileHandle | null = null;

  constructor(readonly logPath: string) {}

  /**
   * Creates parent directories (recursive, idempotent) and opens the file
   * for appending (O_APPEND | O_CREAT). Must be called before writeLine().
   *
   * Throws on any I/O error (EACCES, EROFS, etc.).
   */
  async open(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.logPath), { recursive: true });
    this.fileHandle = await fs.promises.open(this.logPath, 'a');
  }

  /**
   * Appends one JSONL line followed by a \n newline.
   * No seek is performed; the 'a' flag guarantees atomic append on POSIX.
   *
   * Throws if open() was not called first.
   * Throws on any I/O write error.
   */
  async writeLine(line: string): Promise<void> {
    if (!this.fileHandle) {
      throw new Error('SessionLogWriter: open() must be called before writeLine()');
    }
    await this.fileHandle.appendFile(line + '\n', { encoding: 'utf8' });
  }

  /**
   * Closes the file handle. Safe to call multiple times; subsequent calls
   * are no-ops (fileHandle is nulled before awaiting close()).
   */
  async close(): Promise<void> {
    const fh = this.fileHandle;
    this.fileHandle = null;
    if (fh) await fh.close();
  }

  /** True after open() and before close(). */
  get isOpen(): boolean {
    return this.fileHandle !== null;
  }
}

// ---------------------------------------------------------------------------
// Session spawn helper — AC-4
// ---------------------------------------------------------------------------

/**
 * Computes the log path, writes sessions.session_log_path in SQLite, creates
 * parent directories, opens the log file for appending, and returns the writer.
 *
 * Call this at session spawn time (before ProcessManager.spawn()):
 *   const { writer, logPath } = await openSessionLog(db, { configDir, workflowId, sessionId });
 *   const handle = await processManager.spawn({ ..., logWriter: writer });
 *
 * Writing sessions.session_log_path BEFORE the writer is opened ensures the
 * HTTP endpoint can serve the path even if the process crashes before the
 * first line is written (AC-4).
 *
 * @param db         DbPool for the SQLite write. The writer updates
 *                   sessions.session_log_path via db.writer directly (not via
 *                   a transaction wrapper — callers that need atomicity with
 *                   other writes should call this inside their own transaction).
 * @param opts.configDir  Absolute path to the directory containing .yoke.yml.
 * @param opts.workflowId Workflow row ID.
 * @param opts.sessionId  Session row ID.
 * @param opts.homeDir    Override for os.homedir() (tests only).
 */
export async function openSessionLog(
  db: DbPool,
  opts: {
    configDir: string;
    workflowId: string;
    sessionId: string;
    homeDir?: string;
  },
): Promise<{ writer: SessionLogWriter; logPath: string }> {
  const logPath = makeSessionLogPath(opts);

  // AC-4: set sessions.session_log_path before opening the file so the HTTP
  // endpoint can serve the path immediately — even if the process hasn't
  // written any lines yet.
  db.writer
    .prepare('UPDATE sessions SET session_log_path = ? WHERE id = ?')
    .run(logPath, opts.sessionId);

  const writer = new SessionLogWriter(logPath);
  await writer.open();
  return { writer, logPath };
}
