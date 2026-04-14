/**
 * Artifact-writes scanner — discovers files written during a session and
 * computes their sha256 fingerprints using a streaming hash.
 *
 * Source: feat-hook-contract spec; docs/design/hook-contract.md §5 (table row
 * "Item manifest diff check | Yoke core | Pipeline Engine after session exit").
 *
 * ## Contract
 *
 *   AC-3  sha256 of every file written by the session recorded in artifact_writes;
 *         computed via streaming hash.
 *   RC-2  sha256 computed with a streaming hash — no large-file buffering into
 *         memory.
 *   RC-4  artifact_writes rows are inserted inside the same db.transaction as the
 *         post-session state transition (enforced by the engine layer, not here).
 *
 * ## Discovery strategy
 *
 *   1. Capture git HEAD before spawning (`captureGitHead`).
 *   2. After session exit, run `git diff <pre-head>..HEAD --name-only` to find
 *      files the session committed.
 *   3. Run `git status --porcelain=v1` to find uncommitted modifications and
 *      new untracked files.
 *   4. For each discovered path that is a regular file, stream-compute sha256.
 *
 *   Deleted files are skipped (they cannot be hashed).
 *   If git is unavailable, the scan returns an empty list (never throws).
 *
 * ## Non-responsibilities
 *
 *   - Does NOT write to SQLite — returns a plain array.
 *   - Does NOT throw — always resolves (errors are swallowed per file).
 *   - Does NOT restrict to declared output_artifacts — scans everything
 *     written in the worktree.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single file-write record: relative path and its sha256 hex digest. */
export interface ArtifactWriteRecord {
  /** Path relative to the worktree root. */
  path: string;
  /** SHA-256 hex digest computed via streaming hash (RC-2). */
  sha256: string;
}

// ---------------------------------------------------------------------------
// captureGitHead — call before spawning the agent session
// ---------------------------------------------------------------------------

/**
 * Return the current git HEAD commit hash in the worktree, or null if git
 * is not available or the worktree has no commits yet.
 *
 * Never throws.
 *
 * @param worktreePath  Absolute path to the worktree root.
 */
export async function captureGitHead(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// scanArtifactWrites — call after the agent session exits
// ---------------------------------------------------------------------------

/**
 * Discover all files written by the session and compute their sha256.
 *
 * @param worktreePath    Absolute path to the worktree root.
 * @param preSessionHead  Git HEAD hash captured before the session (from
 *                        captureGitHead), or null if unavailable.
 * @returns               Array of { path, sha256 } for every file that
 *                        exists and was touched during the session.
 *                        Empty array if git reports no changes or errors.
 */
export async function scanArtifactWrites(
  worktreePath: string,
  preSessionHead: string | null,
): Promise<ArtifactWriteRecord[]> {
  const changedPaths = await findChangedFiles(worktreePath, preSessionHead);
  if (changedPaths.length === 0) return [];

  const records: ArtifactWriteRecord[] = [];
  for (const relPath of changedPaths) {
    const absPath = path.resolve(worktreePath, relPath);
    let sha256: string;
    try {
      sha256 = await computeSha256Streaming(absPath);
    } catch {
      // File deleted, a symlink, or unreadable — skip.
      continue;
    }
    records.push({ path: relPath, sha256 });
  }
  return records;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Collect the set of relative file paths that changed during the session.
 *
 * Sources:
 *   1. `git diff <preHead>..HEAD --name-only` — files committed during session.
 *   2. `git status --porcelain=v1` — staged and working-tree modifications /
 *      new untracked files.
 *
 * Deleted files are excluded from the result.
 */
async function findChangedFiles(
  worktreePath: string,
  preSessionHead: string | null,
): Promise<string[]> {
  const files = new Set<string>();

  // --- Source 1: committed changes since pre-session HEAD ---
  if (preSessionHead) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['diff', '--name-only', '--diff-filter=ACM', `${preSessionHead}..HEAD`],
        { cwd: worktreePath },
      );
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) files.add(trimmed);
      }
    } catch {
      // HEAD didn't change or git failed — safe to skip.
    }
  }

  // --- Source 2: uncommitted changes (staged + working tree) ---
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1'],
      { cwd: worktreePath },
    );
    for (const line of stdout.split('\n')) {
      if (line.length < 3) continue;

      const xy = line.slice(0, 2);
      const rawPath = line.slice(3);

      // Skip deletions: 'D ' (staged delete) or ' D' (working-tree delete).
      // Combined: 'DD', 'AD'.
      if (xy === 'D ' || xy === ' D' || xy === 'DD' || xy === 'AD') continue;

      // Rename entries look like "R  old -> new" — extract the destination.
      if (rawPath.includes(' -> ')) {
        const dest = rawPath.split(' -> ')[1];
        if (dest) files.add(dest.trim());
      } else {
        files.add(rawPath.trim());
      }
    }
  } catch {
    // git unavailable or clean worktree.
  }

  // Filter out empty strings that crept in.
  files.delete('');
  return [...files];
}

/**
 * Compute the SHA-256 digest of a file by streaming its contents through a
 * hash accumulator.  Never buffers the whole file in memory (RC-2).
 *
 * @throws on ENOENT, EACCES, or any fs error.
 */
export async function computeSha256Streaming(absPath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absPath);
    stream.on('data', (chunk: Buffer | string) => { hash.update(chunk); });
    stream.on('end', () => { resolve(hash.digest('hex')); });
    stream.on('error', reject);
  });
}
