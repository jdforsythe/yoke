/**
 * Phase 5 — timeline refetch on session lifecycle.
 *
 * The route layer (WorkflowDetailRoute) calls invalidateItemTimeline(...) from
 * its session.started / session.ended handlers when the target item is
 * currently expanded in the FeatureBoard. This test exercises the cache-level
 * contract that that behaviour relies on:
 *
 *   1. fetchItemTimeline caches the result so a second call for the same
 *      (workflowId, itemId) does NOT re-issue the network request.
 *   2. invalidateItemTimeline drops the cached entry so the NEXT
 *      fetchItemTimeline call re-issues the network request.
 *   3. Invalidating item A does not disturb item B's cached entry.
 *   4. getCachedTimeline reports undefined for un-fetched / invalidated
 *      entries (→ FeatureBoard treats this as "needs fetch"), null for
 *      fetched-but-error entries, and the row array for successful fetches.
 *
 * The vitest workspace is configured `environment: 'node'` with no
 * react-testing-library set up (see vitest.config.ts — include only `.test.ts`,
 * no DOM env), so we exercise the cache module directly rather than mounting
 * a React component tree. The behavioural chain is:
 *
 *   WS frame → invalidateItemTimeline(w, i) → getCachedTimeline returns
 *   undefined → FeatureBoard's fetch effect observes `undefined` and
 *   re-issues fetchItemTimeline → network call → cache repopulated.
 *
 * Step 3 (the effect re-firing) is covered by inspection of FeatureBoard's
 * existing lazy-fetch effect; this test covers the module-level cache
 * behaviour that is the pivot of the phase 5 change.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchItemTimeline,
  getCachedTimeline,
  invalidateItemTimeline,
  clearItemTimelineCache,
} from '../../src/web/src/components/FeatureBoard/timelineCache';
import type { ItemTimelineRow } from '../../src/shared/types/timeline';

// ---------------------------------------------------------------------------
// Helpers — stub global fetch with a response whose shape matches
// ItemTimelineResponse. We use vi.fn() so we can assert call counts.
// ---------------------------------------------------------------------------

type FetchCall = [input: unknown, init?: unknown];
interface FakeFetch {
  (input: unknown, init?: unknown): Promise<Response>;
  mock: { calls: FetchCall[] };
  mockReset: () => void;
}

function makeRow(id: string, attempt = 1): ItemTimelineRow {
  return {
    kind: 'session',
    id,
    phase: 'implement',
    attempt,
    status: 'complete',
    startedAt: '2026-04-22T00:00:00.000Z',
    endedAt: '2026-04-22T00:01:00.000Z',
    exitCode: 0,
    parentSessionId: null,
  };
}

/**
 * Install a mock fetch that returns { rows } for every call. Returns the
 * mock so tests can assert call counts / arguments.
 */
function installMockFetch(rowsByCall: ItemTimelineRow[][]): FakeFetch {
  let callIndex = 0;
  const fn = vi.fn(async (_input: unknown, _init?: unknown) => {
    const rows = rowsByCall[callIndex] ?? rowsByCall[rowsByCall.length - 1] ?? [];
    callIndex += 1;
    return {
      ok: true,
      json: async () => ({ rows }),
    } as unknown as Response;
  });
  globalThis.fetch = fn;
  return fn as unknown as FakeFetch;
}

const W = 'workflow-42';
const A = 'item-A';
const B = 'item-B';

beforeEach(() => {
  clearItemTimelineCache();
});

afterEach(() => {
  // Restore fetch so cross-test pollution does not occur.
  // @ts-expect-error — test-scoped teardown.
  delete globalThis.fetch;
});

// ---------------------------------------------------------------------------
// 1. First fetch populates the cache; second read is cache-hit.
// ---------------------------------------------------------------------------

describe('fetchItemTimeline caches results', () => {
  it('a second fetch for the same (workflowId, itemId) does not re-issue the network call', async () => {
    const fetchMock = installMockFetch([[makeRow('s1')]]);

    const first = await fetchItemTimeline(W, A);
    expect(first).toEqual([makeRow('s1')]);
    expect(fetchMock.mock.calls).toHaveLength(1);

    const second = await fetchItemTimeline(W, A);
    expect(second).toEqual([makeRow('s1')]);
    // Critical: no additional network call issued.
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it('getCachedTimeline returns the cached array after a successful fetch', async () => {
    installMockFetch([[makeRow('s1')]]);
    expect(getCachedTimeline(W, A)).toBeUndefined();
    await fetchItemTimeline(W, A);
    expect(getCachedTimeline(W, A)).toEqual([makeRow('s1')]);
  });
});

// ---------------------------------------------------------------------------
// 2. Invalidation drops the entry and forces a refetch.
// ---------------------------------------------------------------------------

describe('invalidateItemTimeline forces a refetch on next read', () => {
  it('after invalidation, fetchItemTimeline re-issues the network call', async () => {
    const fetchMock = installMockFetch([[makeRow('s1')], [makeRow('s2', 2)]]);

    await fetchItemTimeline(W, A);
    expect(fetchMock.mock.calls).toHaveLength(1);

    // Simulate a WS session-lifecycle frame for an expanded item.
    invalidateItemTimeline(W, A);

    // The synchronous cache read now reports "needs fetch" — this is what
    // FeatureBoard's lazy-fetch effect observes and acts on.
    expect(getCachedTimeline(W, A)).toBeUndefined();

    const refetched = await fetchItemTimeline(W, A);
    expect(refetched).toEqual([makeRow('s2', 2)]);
    // Critical: a second network call was issued, proving the cache was cleared.
    expect(fetchMock.mock.calls).toHaveLength(2);
  });

  it('invalidating item A does not disturb item B cached entry', async () => {
    const fetchMock = installMockFetch([[makeRow('a')], [makeRow('b')]]);

    await fetchItemTimeline(W, A);
    await fetchItemTimeline(W, B);
    expect(fetchMock.mock.calls).toHaveLength(2);

    invalidateItemTimeline(W, A);

    // B remains cached.
    expect(getCachedTimeline(W, B)).toEqual([makeRow('b')]);
    // Reading B does not trigger a fetch — this proves that a
    // session-lifecycle frame for item A does NOT cause a refetch of item B.
    await fetchItemTimeline(W, B);
    expect(fetchMock.mock.calls).toHaveLength(2);

    // A, on the other hand, is reported as needs-fetch.
    expect(getCachedTimeline(W, A)).toBeUndefined();
  });

  it('invalidating an item that was never fetched is a no-op', () => {
    // Collapsed items have no cache entry. Invalidation of a never-fetched
    // itemId should not throw and should not create a spurious entry.
    expect(() => invalidateItemTimeline(W, 'never-fetched')).not.toThrow();
    expect(getCachedTimeline(W, 'never-fetched')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Error-path caching (so a 404 for an item does not refetch loop) is
//    distinguishable from "needs fetch" post-invalidation.
// ---------------------------------------------------------------------------

describe('cache state machine: undefined vs null', () => {
  it('a failed fetch is cached as null; invalidation drops the null entry too', async () => {
    // First call: return !ok so the cache stores null.
    const fetchMock = vi.fn(async () => ({ ok: false } as unknown as Response));
    globalThis.fetch = fetchMock;

    const res = await fetchItemTimeline(W, A);
    expect(res).toBeNull();
    expect(getCachedTimeline(W, A)).toBeNull(); // distinguishes from undefined

    // A second read does NOT refetch (null is cached to prevent 404-loop).
    await fetchItemTimeline(W, A);
    expect(fetchMock.mock.calls).toHaveLength(1);

    // A session-lifecycle frame invalidates even the null entry, so the
    // next read sees 'undefined' (needs-fetch).
    invalidateItemTimeline(W, A);
    expect(getCachedTimeline(W, A)).toBeUndefined();
  });
});
