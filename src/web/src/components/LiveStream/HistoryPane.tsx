/**
 * HistoryPane — renders the list of past sessions for a selected item
 * and loads/displays the log for a chosen session using LiveStreamPane.
 *
 * The live WS subscription is NOT managed here — it stays alive in
 * WorkflowDetailRoute regardless of whether History is active.
 *
 * Log loading: delegated to loadSessionIntoStore in sessionDisplay.ts,
 * which is shared with FeatureBoard's inline timeline so both surfaces
 * drive the render store identically.
 */

import { useState, useCallback, useEffect } from 'react';
import { LiveStreamPane } from './LiveStreamPane';
import {
  relativeTime,
  duration,
  sessionStatusClass,
  loadSessionIntoStore,
} from './sessionDisplay';

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
  /**
   * Optional — when provided, the pane pre-loads and selects this session on
   * mount (or whenever it changes to a non-null value). Used by FeatureBoard's
   * inline timeline so clicking a session row in the list view drives the
   * right-pane selection without extra clicks.
   */
  initialSessionId?: string | null;
}

// ---------------------------------------------------------------------------
// HistoryPane
// ---------------------------------------------------------------------------

export function HistoryPane({ workflowId, sessions, initialSessionId }: Props) {
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
      await loadSessionIntoStore(sessionId, loadedSessions);
      setSelectedSessionId(sessionId);
    } finally {
      setLoadingSessionId(null);
    }
  }, [loadedSessions]);

  // Honour initialSessionId pushed in from the inline timeline. Only selects
  // when the id is present in the sessions list so we don't try to display
  // a session the pane can't find in its own list (it wouldn't highlight).
  useEffect(() => {
    if (!initialSessionId) return;
    if (!sessions.some((s) => s.id === initialSessionId)) return;
    if (initialSessionId === selectedSessionId) return;
    void selectSession(initialSessionId);
    // selectedSessionId intentionally omitted — we only want to react to
    // initialSessionId / sessions-list changes pushed in from the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSessionId, sessions, selectSession]);

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
