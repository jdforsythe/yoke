/**
 * HistoryPane — renders the list of past sessions for a selected item
 * and loads/displays the log for a chosen session using LiveStreamPane.
 *
 * The live WS subscription is NOT managed here — it stays alive in
 * WorkflowDetailRoute regardless of whether History is active.
 *
 * Log loading: fetches all pages of /api/sessions/:id/log, collects the
 * raw ServerFrames, and calls loadHistoricalSession() once so the store
 * is mutated in a single atomic step (one re-render, no flicker).
 */

import { useState, useCallback } from 'react';
import { loadHistoricalSession } from '@/store/renderStore';
import { LiveStreamPane } from './LiveStreamPane';
import type { ServerFrame } from '@/ws/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ItemSession {
  id: string;
  phase: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
}

interface Props {
  itemId: string;
  workflowId: string;
  sessions: ItemSession[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function duration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return 'running';
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function sessionStatusClass(status: string): string {
  switch (status) {
    case 'complete': return 'bg-green-500/20 text-green-300';
    case 'in_progress': return 'bg-blue-500/20 text-blue-300';
    case 'abandoned': return 'bg-gray-500/20 text-gray-400';
    default: return 'bg-red-500/20 text-red-300';
  }
}

// ---------------------------------------------------------------------------
// Fetch all pages of a session log and return parsed ServerFrames
// ---------------------------------------------------------------------------

async function fetchAllLogFrames(sessionId: string): Promise<ServerFrame[]> {
  const frames: ServerFrame[] = [];
  let sinceSeq = 0;
  let hasMore = true;
  const limit = 100;
  let pageCount = 0;
  const maxPages = 20; // cap at 2000 frames

  while (hasMore && pageCount < maxPages) {
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/log?sinceSeq=${sinceSeq}&limit=${limit}`,
    );
    if (!res.ok) break;
    const data = (await res.json()) as { entries?: string[]; nextSeq?: number; hasMore?: boolean };
    for (const raw of data.entries ?? []) {
      try {
        frames.push(JSON.parse(raw) as ServerFrame);
      } catch {
        // skip malformed entry
      }
    }
    hasMore = data.hasMore ?? false;
    sinceSeq = data.nextSeq ?? sinceSeq + limit;
    pageCount++;
  }

  return frames;
}

// ---------------------------------------------------------------------------
// HistoryPane
// ---------------------------------------------------------------------------

export function HistoryPane({ workflowId, sessions }: Props) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [loadedSessions] = useState(() => new Set<string>());

  const selectSession = useCallback(async (sessionId: string) => {
    if (loadedSessions.has(sessionId)) {
      setSelectedSessionId(sessionId);
      return;
    }
    setLoadingSessionId(sessionId);
    try {
      const frames = await fetchAllLogFrames(sessionId);
      loadHistoricalSession(sessionId, frames);
      loadedSessions.add(sessionId);
      setSelectedSessionId(sessionId);
    } finally {
      setLoadingSessionId(null);
    }
  }, [loadedSessions]);

  if (sessions.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        No past sessions for this item.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Session list */}
      <div className="shrink-0 border-b border-gray-700 overflow-y-auto max-h-40">
        {sessions.map((s) => {
          const isSelected = s.id === selectedSessionId;
          const isLoading = s.id === loadingSessionId;
          return (
            <button
              key={s.id}
              onClick={() => void selectSession(s.id)}
              disabled={isLoading}
              data-testid={`history-session-${s.id}`}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-gray-700 transition-colors ${
                isSelected ? 'bg-gray-700' : ''
              } ${isLoading ? 'opacity-60 cursor-wait' : ''}`}
            >
              <span
                className={`px-1.5 py-0.5 rounded text-xs font-medium shrink-0 ${sessionStatusClass(s.status)}`}
              >
                {s.status}
              </span>
              <span className="text-gray-300 font-medium shrink-0">{s.phase}</span>
              <span className="text-gray-500 shrink-0">{relativeTime(s.startedAt)}</span>
              <span className="text-gray-600 shrink-0">· {duration(s.startedAt, s.endedAt)}</span>
              {isLoading && (
                <span className="ml-auto text-gray-500 shrink-0">Loading…</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Log view */}
      <div className="flex-1 min-h-0">
        {selectedSessionId ? (
          <LiveStreamPane sessionId={selectedSessionId} workflowId={workflowId} />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500 text-sm">
            Select a session above to view its log.
          </div>
        )}
      </div>
    </div>
  );
}
