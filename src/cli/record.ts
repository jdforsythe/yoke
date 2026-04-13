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
// Types
// ---------------------------------------------------------------------------

export interface RecordMarker {
  enabled: true;
  capturePath: string;
  createdAt: string;
}

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

  const marker: RecordMarker = {
    enabled: true,
    capturePath: path.resolve(capturePath),
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf8');

  return { markerPath, capturePath: marker.capturePath };
}

/**
 * Read the capture marker from .yoke/record.json, if present.
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
 * Clear the capture marker (called by the pipeline engine after a session).
 */
export function clearRecordMarker(cwd?: string): void {
  const markerPath = path.join(cwd ?? process.cwd(), '.yoke', 'record.json');
  try {
    fs.unlinkSync(markerPath);
  } catch {
    // Not fatal if already absent.
  }
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
