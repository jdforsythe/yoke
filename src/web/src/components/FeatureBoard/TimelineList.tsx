/**
 * TimelineList — inline chronological rendering of an item's merged
 * session + prepost-command timeline. Rendered under an item card when
 * the card is expanded via the disclosure caret in FeatureBoard.
 *
 * Row shape is the discriminated union from
 * src/shared/types/timeline.ts. Rows are pre-sorted chronologically by
 * the server; this component does not re-sort.
 *
 * Session rows share formatting helpers with HistoryPane via
 * components/LiveStream/sessionDisplay.ts so both surfaces render
 * sessions identically.
 */

import type {
  ItemTimelineRow,
  ItemTimelinePrepostRow,
} from '@shared/types/timeline';
import {
  relativeTime,
  duration,
  sessionStatusClass,
} from '@/components/LiveStream/sessionDisplay';

interface Props {
  rows: ItemTimelineRow[] | null | undefined;
  onSelectSession: (sessionId: string) => void;
  onOpenPrepostOutput: (row: ItemTimelinePrepostRow) => void;
}

/** Build the action-taken label for a prepost row. */
function prepostActionLabel(action: ItemTimelinePrepostRow['actionTaken']): string {
  if (action === null) return '';
  if (action.goto) return `triggered goto ${action.goto}`;
  if (action.retry === true) return 'retry';
  if (action.fail === true) return 'fail';
  // continue === true or any empty object → no label
  return '';
}

export function TimelineList({ rows, onSelectSession, onOpenPrepostOutput }: Props) {
  if (rows === undefined) {
    return (
      <div className="pl-6 pr-3 py-1.5 text-[10px] text-gray-500">Loading…</div>
    );
  }
  if (rows === null || rows.length === 0) {
    return (
      <div className="pl-6 pr-3 py-1.5 text-[10px] text-gray-500">No history yet</div>
    );
  }

  // Track phase names we have already emitted a description for, so the
  // description renders once per phase group (on the first row of that
  // phase in chronological order) rather than on every attempt.
  const describedPhases = new Set<string>();

  return (
    <ul className="pl-6 pr-3 py-1 space-y-0.5 border-t border-gray-700/30 bg-gray-800/20">
      {rows.map((row) => {
        const showDescription =
          row.phaseDescription != null && !describedPhases.has(row.phase);
        if (showDescription) describedPhases.add(row.phase);

        if (row.kind === 'session') {
          return (
            <li key={`s-${row.id}`}>
              {showDescription && (
                <div
                  data-testid={`timeline-phase-description-${row.phase}`}
                  className="px-1.5 pt-1 text-[10px] text-gray-500 italic"
                >
                  {row.phaseDescription}
                </div>
              )}
              <button
                type="button"
                data-testid={`timeline-session-${row.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectSession(row.id);
                }}
                className="w-full flex items-center gap-1.5 px-1.5 py-1 text-left text-[10px] rounded hover:bg-gray-700/40 transition-colors"
              >
                <span className="text-gray-300 font-medium shrink-0">{row.phase}</span>
                <span className="text-gray-500 shrink-0">· attempt {row.attempt}</span>
                <span
                  className={`px-1 py-0.5 rounded font-medium shrink-0 ${sessionStatusClass(row.status)}`}
                >
                  {row.status}
                </span>
                <span className="text-gray-500 shrink-0">· {relativeTime(row.startedAt)}</span>
                <span className="text-gray-600 shrink-0">
                  · {duration(row.startedAt, row.endedAt)}
                </span>
              </button>
            </li>
          );
        }

        // prepost row
        const actionLabel = prepostActionLabel(row.actionTaken);
        const statusClass =
          row.status === 'ok'
            ? 'bg-green-500/20 text-green-300'
            : 'bg-red-500/20 text-red-300';
        return (
          <li key={`p-${row.id}`}>
            {showDescription && (
              <div
                data-testid={`timeline-phase-description-${row.phase}`}
                className="px-1.5 pt-1 text-[10px] text-gray-500 italic"
              >
                {row.phaseDescription}
              </div>
            )}
            <button
              type="button"
              data-testid={`timeline-prepost-${row.id}`}
              onClick={(e) => {
                e.stopPropagation();
                onOpenPrepostOutput(row);
              }}
              className="w-full flex items-center gap-1.5 px-1.5 py-1 text-left text-[10px] rounded hover:bg-gray-700/40 transition-colors"
            >
              <span className="text-gray-500 shrink-0">[{row.whenPhase}]</span>
              <span className="text-gray-300 font-medium shrink-0">{row.commandName}</span>
              <span className={`px-1 py-0.5 rounded font-medium shrink-0 ${statusClass}`}>
                {row.status}
              </span>
              {actionLabel && (
                <span className="text-orange-300 shrink-0">· {actionLabel}</span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
