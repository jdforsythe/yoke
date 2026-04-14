/**
 * Session Log Reader — paged JSONL file reader for the HTTP endpoint.
 *
 * Reads directly from the .jsonl file on disk (RC-3).
 * SQLite stores only the path pointer (sessions.session_log_path).
 *
 * Paging model:
 *   sinceSeq — number of lines to skip from the start of the file (0-based count).
 *   limit     — max lines to return per page, clamped to [1, MAX_PAGE_SIZE].
 *
 * The caller uses nextSeq from one response as sinceSeq in the next request
 * to page through the file in order.
 */

import * as fs from 'fs';
import * as readline from 'readline';

/** Hard cap on lines returned per page. */
export const MAX_PAGE_SIZE = 1000;

/** Result of a single paged read. */
export interface LogPage {
  /** Raw JSONL lines in original (append) order, no trailing newline. */
  entries: string[];
  /** Pass as sinceSeq in the next request to continue from here. */
  nextSeq: number;
  /** True if the file contains more lines beyond this page. */
  hasMore: boolean;
}

/**
 * Reads a page of lines from a session JSONL log file.
 *
 * Reads the file via a streaming readline interface — no full-file buffer
 * in memory (RC-3, file is never loaded into SQLite).
 *
 * @param logPath  Absolute path to the session .jsonl file.
 * @param sinceSeq Lines to skip from the beginning (0 = start at line 1).
 * @param limit    Max lines to return. Clamped to [1, MAX_PAGE_SIZE].
 *
 * @returns LogPage if the file is readable; null if the file does not exist
 *          or cannot be accessed (ENOENT, EACCES, etc.).
 */
export async function readLogPage(
  logPath: string,
  sinceSeq: number,
  limit: number,
): Promise<LogPage | null> {
  // Fast existence / readability check — returns null on any access error.
  try {
    await fs.promises.access(logPath, fs.constants.R_OK);
  } catch {
    return null;
  }

  const clampedLimit = Math.min(Math.max(1, limit), MAX_PAGE_SIZE);
  // Collect one extra line to cheaply detect whether more lines follow.
  const toCollect = clampedLimit + 1;

  const entries: string[] = [];
  let lineNum = 0;

  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(logPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      lineNum++;
      // Skip the first sinceSeq lines.
      if (lineNum <= sinceSeq) return;
      // Collect up to toCollect lines (clampedLimit + 1 probe line).
      if (entries.length < toCollect) {
        entries.push(line);
      }
    });

    rl.on('close', resolve);

    // Propagate stream errors; close readline first to avoid double-resolve.
    stream.on('error', (err) => {
      rl.close();
      reject(err);
    });
    rl.on('error', reject);
  });

  const hasMore = entries.length > clampedLimit;
  // Remove the extra probe line so callers receive at most clampedLimit entries.
  if (hasMore) entries.pop();

  return {
    entries,
    nextSeq: sinceSeq + entries.length,
    hasMore,
  };
}
