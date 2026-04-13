/**
 * record-marker — server-side helpers for reading/clearing the yoke record marker.
 *
 * The marker is written by `yoke record` (CLI) and read/cleared by the Scheduler
 * at session-spawn time to activate fixture-capture mode.
 *
 * These helpers live in the server layer so the Scheduler can import them without
 * crossing a downward layer boundary (server must not import from cli).
 * The CLI's record.ts module re-exports these so the command handler and tests
 * continue to work unchanged.
 *
 * ## Marker file
 *
 * Located at `<cwd>/.yoke/record.json`.  Schema:
 *
 *   {
 *     "enabled": true,
 *     "capturePath": "/absolute/path/to/capture.jsonl",
 *     "createdAt": "2026-04-13T00:00:00.000Z"
 *   }
 *
 * The file is removed by clearRecordMarker() after the session completes so that
 * a subsequent `yoke start` does not re-enter capture mode accidentally.
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecordMarker {
  enabled: true;
  capturePath: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the capture marker from `<cwd>/.yoke/record.json`, if present.
 * Returns null if no marker exists or if it is malformed.
 */
export function readRecordMarker(cwd?: string): RecordMarker | null {
  const markerPath = path.join(cwd ?? process.cwd(), '.yoke', 'record.json');
  if (!fs.existsSync(markerPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as unknown;
    if (
      typeof raw === 'object' &&
      raw !== null &&
      (raw as RecordMarker).enabled === true &&
      typeof (raw as RecordMarker).capturePath === 'string'
    ) {
      return raw as RecordMarker;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Clear the capture marker (called by the Scheduler after a session ends).
 * Not fatal if the marker is already absent.
 */
export function clearRecordMarker(cwd?: string): void {
  const markerPath = path.join(cwd ?? process.cwd(), '.yoke', 'record.json');
  try {
    fs.unlinkSync(markerPath);
  } catch {
    // Not fatal if already absent.
  }
}
