/**
 * Phase 6 — FeatureBoard search extension.
 *
 * Unit tests for fuzzyMatch (src/web/src/components/FeatureBoard/fuzzyMatch.ts),
 * the client-side predicate behind the FeatureBoard search box. Phase 6 widens
 * the set of searchable fields beyond displayTitle/displaySubtitle:
 *
 *   - the owning stage id
 *   - phase name of any cached timeline row
 *   - session id of any cached timeline row
 *   - commandName of any cached prepost row
 *
 * The "cached-only" trade-off is deliberate: typing in the search box does
 * NOT trigger fetches for collapsed items, so timeline-row matches only
 * succeed when the caller supplies an already-populated rows array. This
 * test suite pins down that behaviour so a future refactor does not
 * accidentally start fetching on every keystroke, and does not accidentally
 * extend search into log content (explicitly out of scope).
 *
 * The vitest workspace uses environment 'node' (see vitest.config.ts) so we
 * exercise the predicate as a pure function rather than mounting a React
 * tree. fuzzyMatch lives in a sibling module precisely so these tests do not
 * drag in React / react-router-dom / the rest of FeatureBoard.tsx.
 */

import { describe, it, expect } from 'vitest';
import { fuzzyMatch } from '../../src/web/src/components/FeatureBoard/fuzzyMatch';
import type { ItemProjection } from '../../src/web/src/ws/types';
import type { ItemTimelineRow } from '../../src/shared/types/timeline';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<ItemProjection> = {}): ItemProjection {
  return {
    id: 'item-1',
    stageId: 'implement',
    state: {
      status: 'pending',
      currentPhase: null,
      retryCount: 0,
      blockedReason: null,
    },
    displayTitle: 'Widget',
    displaySubtitle: 'subtitle',
    stableId: 'widget-slug',
    ...overrides,
  };
}

function sessionRow(overrides: Partial<ItemTimelineRow> = {}): ItemTimelineRow {
  return {
    kind: 'session',
    id: 'sess-abc',
    phase: 'implement',
    attempt: 1,
    status: 'complete',
    startedAt: '2026-04-22T00:00:00.000Z',
    endedAt: '2026-04-22T00:01:00.000Z',
    exitCode: 0,
    parentSessionId: null,
    ...(overrides as object),
  } as ItemTimelineRow;
}

function prepostRow(
  commandName: string,
  overrides: Partial<ItemTimelineRow> = {},
): ItemTimelineRow {
  return {
    kind: 'prepost',
    id: 'pp-xyz',
    whenPhase: 'post',
    commandName,
    phase: 'review',
    status: 'ok',
    exitCode: 0,
    actionTaken: null,
    startedAt: '2026-04-22T00:02:00.000Z',
    endedAt: '2026-04-22T00:03:00.000Z',
    stdoutPath: null,
    stderrPath: null,
    ...(overrides as object),
  } as ItemTimelineRow;
}

// ---------------------------------------------------------------------------
// 1. Match via stage id
// ---------------------------------------------------------------------------

describe('match via stage id', () => {
  it('matches when the query is a substring of the stage id', () => {
    const item = makeItem({
      displayTitle: 'Unrelated',
      displaySubtitle: 'nothing',
      stageId: 'review',
    });
    expect(fuzzyMatch(item, 'review', 'review', undefined)).toBe(true);
    // Partial substring also matches.
    expect(fuzzyMatch(item, 'revi', 'review', undefined)).toBe(true);
  });

  it('does not match when the query matches neither title/subtitle nor stage', () => {
    const item = makeItem({
      displayTitle: 'Widget',
      displaySubtitle: 'subtitle',
      stageId: 'implement',
    });
    expect(fuzzyMatch(item, 'verify', 'implement', undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Match via phase name when cached rows are provided
// ---------------------------------------------------------------------------

describe('match via timeline row phase name (cached)', () => {
  it('matches when a cached session row has a phase containing the query', () => {
    const item = makeItem({
      displayTitle: 'Unrelated',
      displaySubtitle: 'nothing',
      stageId: 'implement',
    });
    const rows: ItemTimelineRow[] = [sessionRow({ phase: 'verify' })];
    expect(fuzzyMatch(item, 'verify', 'implement', rows)).toBe(true);
  });

  it('matches when a cached prepost row has a phase containing the query', () => {
    const item = makeItem({
      displayTitle: 'Unrelated',
      displaySubtitle: 'nothing',
      stageId: 'implement',
    });
    const rows: ItemTimelineRow[] = [prepostRow('lint', { phase: 'review' })];
    expect(fuzzyMatch(item, 'review', 'implement', rows)).toBe(true);
  });

  it('matches when a cached session row id contains the query', () => {
    const item = makeItem({
      displayTitle: 'Unrelated',
      displaySubtitle: 'nothing',
      stageId: 'implement',
    });
    const rows: ItemTimelineRow[] = [sessionRow({ id: 'sess-deadbeef' })];
    expect(fuzzyMatch(item, 'deadbeef', 'implement', rows)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Match via prepost commandName
// ---------------------------------------------------------------------------

describe('match via prepost commandName (cached)', () => {
  it('matches when a cached prepost row commandName contains the query', () => {
    const item = makeItem({
      displayTitle: 'Unrelated',
      displaySubtitle: 'nothing',
      stageId: 'implement',
    });
    const rows: ItemTimelineRow[] = [prepostRow('typecheck')];
    expect(fuzzyMatch(item, 'typecheck', 'implement', rows)).toBe(true);
  });

  it('does NOT use commandName on session rows (they have no commandName field)', () => {
    // Guard against a regression where commandName matching falls through to
    // session rows. A session row with id 'typecheck' would still match via
    // row.id — so we construct a session-only fixture with a benign id.
    const item = makeItem({
      displayTitle: 'Unrelated',
      displaySubtitle: 'nothing',
      stageId: 'implement',
    });
    const rows: ItemTimelineRow[] = [sessionRow({ id: 'sess-abc', phase: 'implement' })];
    // 'typecheck' appears nowhere; no match.
    expect(fuzzyMatch(item, 'typecheck', 'implement', rows)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. No match via phase name when cached rows are undefined (cache miss)
// ---------------------------------------------------------------------------

describe('cached-only trade-off: no match when rows are missing', () => {
  it('returns false when the phase would match but cachedRows is undefined', () => {
    const item = makeItem({
      displayTitle: 'Unrelated',
      displaySubtitle: 'nothing',
      stageId: 'implement',
    });
    expect(fuzzyMatch(item, 'verify', 'implement', undefined)).toBe(false);
  });

  it('returns false when the phase would match but cachedRows is null (fetched-but-failed)', () => {
    const item = makeItem({
      displayTitle: 'Unrelated',
      displaySubtitle: 'nothing',
      stageId: 'implement',
    });
    expect(fuzzyMatch(item, 'verify', 'implement', null)).toBe(false);
  });

  it('returns false when the commandName would match but cachedRows is undefined', () => {
    const item = makeItem({
      displayTitle: 'Unrelated',
      displaySubtitle: 'nothing',
      stageId: 'implement',
    });
    expect(fuzzyMatch(item, 'typecheck', 'implement', undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Log content is not searched — matching only happens on the
//    specified fields.
// ---------------------------------------------------------------------------

describe('log content is not searched', () => {
  it('does not match fields outside the documented allow-list', () => {
    // Construct an item whose only occurrence of the query string is in
    // fields NOT in the search allow-list: stableId, exitCode, status,
    // attempt, actionTaken, stdoutPath, and the item.state fields. If any
    // of those matched we would have a regression (and a likely log-content
    // fan-out next).
    const item = makeItem({
      id: 'item-plain',
      stageId: 'implement',
      displayTitle: 'Widget',
      displaySubtitle: 'subtitle',
      stableId: 'logneedle-slug',
      state: {
        status: 'logneedle-status',
        currentPhase: 'logneedle-phase',
        retryCount: 0,
        blockedReason: 'logneedle-reason',
      },
    });
    const rows: ItemTimelineRow[] = [
      sessionRow({
        id: 'sess-plain',
        phase: 'implement',
        status: 'logneedle-status',
      }),
      prepostRow('lint', {
        id: 'pp-plain',
        phase: 'review',
        stdoutPath: '/tmp/logneedle.log',
        stderrPath: '/tmp/logneedle.err',
        actionTaken: { goto: 'logneedle-goto' },
      }),
    ];
    expect(fuzzyMatch(item, 'logneedle', 'implement', rows)).toBe(false);

    // Sanity: the same query DOES match if placed in an allow-listed field.
    const matching: ItemTimelineRow[] = [
      sessionRow({ id: 'sess-plain', phase: 'logneedle' }),
    ];
    expect(fuzzyMatch(item, 'logneedle', 'implement', matching)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Case-insensitive match across every searchable field.
// ---------------------------------------------------------------------------

describe('case-insensitive match', () => {
  it('matches regardless of query casing vs displayTitle casing', () => {
    const item = makeItem({ displayTitle: 'ReviewPanel', stageId: 'implement' });
    expect(fuzzyMatch(item, 'REVIEW', 'implement', undefined)).toBe(true);
    expect(fuzzyMatch(item, 'review', 'implement', undefined)).toBe(true);
    expect(fuzzyMatch(item, 'ReViEw', 'implement', undefined)).toBe(true);
  });

  it('matches regardless of query casing vs stage id casing', () => {
    const item = makeItem({
      displayTitle: 'Unrelated',
      displaySubtitle: 'nothing',
      stageId: 'Verify',
    });
    expect(fuzzyMatch(item, 'VERIFY', 'Verify', undefined)).toBe(true);
    expect(fuzzyMatch(item, 'verify', 'Verify', undefined)).toBe(true);
  });

  it('matches regardless of query casing vs cached phase / commandName', () => {
    const item = makeItem({
      displayTitle: 'Unrelated',
      displaySubtitle: 'nothing',
      stageId: 'implement',
    });
    const rows: ItemTimelineRow[] = [
      sessionRow({ phase: 'Verify' }),
      prepostRow('Typecheck'),
    ];
    expect(fuzzyMatch(item, 'VERIFY', 'implement', rows)).toBe(true);
    expect(fuzzyMatch(item, 'typecheck', 'implement', rows)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Empty-query no-op: documented behaviour (matches everything).
// ---------------------------------------------------------------------------

describe('empty query is a no-op filter', () => {
  it('returns true for any item when query is empty', () => {
    const item = makeItem();
    expect(fuzzyMatch(item, '', 'implement', undefined)).toBe(true);
    expect(fuzzyMatch(item, '', 'implement', null)).toBe(true);
    expect(fuzzyMatch(item, '', 'implement', [])).toBe(true);
  });
});
