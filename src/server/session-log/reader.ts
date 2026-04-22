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

// ---------------------------------------------------------------------------
// Artifact reader (for prepost stdout/stderr capture files)
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on the number of bytes a single call to readArtifactFile() may
 * return. Applied even when the caller omits `length`, so the endpoint can't
 * OOM on an unbounded request. 64 KiB is 2x the per-stream runner cap
 * (OUTPUT_CAPTURE_LIMIT = 32_768) so a single well-formed capture file
 * always fits in one response.
 */
export const READ_ARTIFACT_MAX_BYTES = 65_536;

/** Result of a single readArtifactFile call. */
export interface ArtifactFile {
  /** File contents decoded as UTF-8, truncated to at most the effective length. */
  content: string;
  /** Actual file size in bytes (stat().size) — not the length of `content`. */
  totalSize: number;
  /** True if the returned `content` is shorter than `totalSize`. */
  truncated: boolean;
}

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

/**
 * Reads a bounded slice of an on-disk artifact file (e.g. a prepost stdout
 * capture) into memory and returns its contents alongside the full file size.
 *
 * Uses a streaming read + byte counter so we never materialise more than
 * the effective cap in memory, regardless of the file's actual size. The
 * read is capped at READ_ARTIFACT_MAX_BYTES (64 KiB) even when the caller
 * passes a larger `length`, so the HTTP endpoint can't be coerced into
 * buffering an unbounded file.
 *
 * Behaviour:
 *   - If `length` is omitted, reads up to min(fileSize, READ_ARTIFACT_MAX_BYTES).
 *   - If `length` is provided, uses min(length, READ_ARTIFACT_MAX_BYTES).
 *   - `offset` is honoured; defaults to 0.
 *   - The returned `totalSize` is always stat().size, so callers can detect
 *     truncation as `truncated === true || totalSize > content.length`.
 *   - Returns null when the file is missing or unreadable (ENOENT, EACCES).
 *
 * @param filePath Absolute path to the artifact file.
 * @param opts.offset First byte to return (default 0).
 * @param opts.length Max bytes to return (capped at READ_ARTIFACT_MAX_BYTES).
 */
export async function readArtifactFile(
  filePath: string,
  opts: { offset?: number; length?: number } = {},
): Promise<ArtifactFile | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const offset = Math.max(0, opts.offset ?? 0);
  const totalSize = stat.size;

  // Effective length: capped at READ_ARTIFACT_MAX_BYTES; if the caller omits
  // length we use the full remaining file from offset, but still capped.
  const requested =
    opts.length !== undefined ? Math.max(0, opts.length) : Math.max(0, totalSize - offset);
  const effective = Math.min(requested, READ_ARTIFACT_MAX_BYTES);

  // Fast path for empty files — stream open/close for zero bytes is wasteful.
  if (effective === 0 || offset >= totalSize) {
    return { content: '', totalSize, truncated: offset < totalSize };
  }

  const end = Math.min(offset + effective, totalSize) - 1;
  const chunks: Buffer[] = [];
  let received = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { start: offset, end });
    stream.on('data', (chunk: string | Buffer) => {
      // We opened the stream without an encoding so chunks arrive as Buffer.
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      received += buf.length;
      chunks.push(buf);
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  const content = Buffer.concat(chunks, received).toString('utf8');
  // Truncation = the returned bytes cover less than the file's total size.
  const truncated = offset + received < totalSize;
  return { content, totalSize, truncated };
}
