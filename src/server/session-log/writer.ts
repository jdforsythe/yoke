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

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

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
