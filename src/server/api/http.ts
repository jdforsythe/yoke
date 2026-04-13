/**
 * Yoke HTTP API server (Node.js built-in http).
 *
 * This module will be migrated to Fastify when the full HTTP + WS server is
 * scaffolded. For now it uses Node's built-in http module so that no new
 * package dependency is required for this feature.
 *
 * Implemented routes (all read-only — AC-6):
 *
 *   GET /api/sessions/:id/log?sinceSeq=N&limit=M
 *     Returns frames N+1..N+M from the session's JSONL log file.
 *     Reads directly from the JSONL file on disk (RC-3).
 *     SQLite is used only to look up sessions.session_log_path.
 *
 *     200 { entries: string[], nextSeq: number, hasMore: boolean }
 *     200 { entries: [], nextSeq: 0, hasMore: false } — session exists but
 *         no log yet (session_log_path is null or file not yet created).
 *     404 { error: "session not found" } — no sessions row with that id.
 *
 * No write or delete paths are exposed.
 */

import * as http from 'http';
import type { DbPool } from '../storage/db.js';
import { readLogPage } from '../session-log/reader.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function parseIntParam(value: string | null, defaultValue: number): number {
  if (value === null || value === '') return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

// ---------------------------------------------------------------------------
// Route: GET /api/sessions/:id/log
// ---------------------------------------------------------------------------

/** Pattern matching /api/sessions/<id>/log exactly. */
const SESSION_LOG_PATTERN = /^\/api\/sessions\/([^/]+)\/log$/;

interface SessionRow {
  session_log_path: string | null;
}

async function handleSessionLog(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: DbPool,
  sessionId: string,
  query: URLSearchParams,
): Promise<void> {
  const sinceSeq = Math.max(0, parseIntParam(query.get('sinceSeq'), 0));
  const limit = Math.max(1, parseIntParam(query.get('limit'), 100));

  const row = db
    .reader()
    .prepare('SELECT session_log_path FROM sessions WHERE id = ?')
    .get(sessionId) as SessionRow | undefined;

  if (!row) {
    writeJson(res, 404, { error: 'session not found' });
    return;
  }

  if (!row.session_log_path) {
    // Session exists but log path not yet set — no entries yet.
    writeJson(res, 200, { entries: [], nextSeq: sinceSeq, hasMore: false });
    return;
  }

  const page = await readLogPage(row.session_log_path, sinceSeq, limit);
  if (!page) {
    // Path stored in SQLite but file not yet created (session just spawned).
    writeJson(res, 200, { entries: [], nextSeq: sinceSeq, hasMore: false });
    return;
  }

  writeJson(res, 200, page);
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Creates the Yoke HTTP server.
 *
 * @param db  DbPool opened by the caller. The server uses db.reader() for
 *            all SELECT queries; no writes are performed.
 */
export function createHttpServer(db: DbPool): http.Server {
  return http.createServer(async (req, res) => {
    // new URL() (non-deprecated) for URL parsing; base is required but ignored
    // for path/query extraction on relative request URLs.
    const reqUrl = new URL(req.url ?? '/', 'http://localhost');
    const pathname = reqUrl.pathname;

    const sessionLogMatch = SESSION_LOG_PATTERN.exec(pathname);
    if (req.method === 'GET' && sessionLogMatch) {
      const sessionId = decodeURIComponent(sessionLogMatch[1]);
      try {
        await handleSessionLog(req, res, db, sessionId, reqUrl.searchParams);
      } catch {
        writeJson(res, 500, { error: 'internal error' });
      }
      return;
    }

    writeJson(res, 404, { error: 'not found' });
  });
}
