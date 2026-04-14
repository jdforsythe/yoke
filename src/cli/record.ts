/**
 * yoke record — enable capture mode for the next session.
 *
 * Writes .yoke/record.json to signal to the pipeline engine that the next
 * spawned session should capture its stream-json output to a fixture file.
 * The ScriptedProcessManager then replays that fixture.
 *
 * Usage:
 *   yoke record                     # captures to .yoke/fixtures/<timestamp>.jsonl
 *   yoke record --out fixtures/my-run.jsonl
 *
 * Acceptance criteria:
 *   AC: Wires ScriptedProcessManager capture mode for the next session.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';

// ---------------------------------------------------------------------------
// Re-exports from server layer
// ---------------------------------------------------------------------------
// readRecordMarker and clearRecordMarker live in src/server/process/record-marker.ts
// (the server layer) so the Scheduler can import them without crossing a downward
// layer boundary.  The CLI re-exports them here for backward compatibility with
// existing tests and any external callers.

export type { RecordMarker } from '../server/process/record-marker.js';
export { readRecordMarker, clearRecordMarker } from '../server/process/record-marker.js';

// ---------------------------------------------------------------------------
// Public API (exported for testing)
// ---------------------------------------------------------------------------

export interface RecordOptions {
  /** Directory containing .yoke/ subfolder. Default: process.cwd(). */
  cwd?: string;
  /**
   * Path where captured stream-json will be written during the next session.
   * Default: .yoke/fixtures/<timestamp>.jsonl
   */
  capturePath?: string;
}

export interface RecordResult {
  markerPath: string;
  capturePath: string;
}

/**
 * Enable capture mode for the next session by writing .yoke/record.json.
 *
 * The pipeline engine reads this marker at session-spawn time and switches
 * to capture mode (routing stream-json output to capturePath).
 * The marker is deleted after the session completes.
 *
 * @returns  Paths written.
 */
export function runRecord(opts: RecordOptions = {}): RecordResult {
  const cwd = opts.cwd ?? process.cwd();
  const yokeDir = path.join(cwd, '.yoke');
  const fixturesDir = path.join(yokeDir, 'fixtures');

  const capturePath =
    opts.capturePath ??
    path.join(fixturesDir, `capture-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);

  const markerPath = path.join(yokeDir, 'record.json');

  fs.mkdirSync(yokeDir, { recursive: true });
  fs.mkdirSync(path.dirname(capturePath), { recursive: true });

  const marker = {
    enabled: true as const,
    capturePath: path.resolve(capturePath),
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf8');

  return { markerPath, capturePath: marker.capturePath };
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  program
    .command('record')
    .description('Enable capture mode for the next session (records stream-json to a fixture file)')
    .option(
      '-o, --out <path>',
      'Path for the captured fixture file (default: .yoke/fixtures/<timestamp>.jsonl)',
    )
    .action((opts: { out?: string }) => {
      const result = runRecord({ capturePath: opts.out });
      console.log(`Capture mode enabled.`);
      console.log(`  Marker:  ${result.markerPath}`);
      console.log(`  Capture: ${result.capturePath}`);
      console.log(`Start the next session to begin capturing.`);
    });
}
