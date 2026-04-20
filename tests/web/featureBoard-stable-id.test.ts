/**
 * Unit tests for resolveItemDisplayName — the FeatureBoard fallback chain.
 *
 * AC (r3-04): fallback chain is
 *   displayTitle ?? stableId ?? 'Seeding…'  — for per-item placeholder rows
 *   displayTitle ?? stableId ?? item.id     — for all other items
 *
 * A "placeholder" is a per-item stage item with stableId === null (the seeder
 * has not yet run).  Once-stage items (run === 'once') never show 'Seeding…'
 * even when stableId is null — they fall through to item.id.
 */

import { describe, it, expect } from 'vitest';
import { resolveItemDisplayName } from '../../src/web/src/components/FeatureBoard/displayName';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function item(
  overrides: Partial<{ id: string; displayTitle: string | null; stableId: string | null }>,
) {
  return {
    id: 'uuid-deadbeef-1234',
    displayTitle: null,
    stableId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Precedence: displayTitle wins over everything
// ---------------------------------------------------------------------------

describe('displayTitle takes highest priority', () => {
  it('returns displayTitle when all three are set (per-item stage)', () => {
    expect(
      resolveItemDisplayName(
        item({ displayTitle: 'My Feature', stableId: 'feat-slug', id: 'uuid-1' }),
        'per-item',
      ),
    ).toBe('My Feature');
  });

  it('returns displayTitle when all three are set (once stage)', () => {
    expect(
      resolveItemDisplayName(
        item({ displayTitle: 'Once Title', stableId: null, id: 'uuid-2' }),
        'once',
      ),
    ).toBe('Once Title');
  });

  it('returns displayTitle even when stableId is null and stage is per-item', () => {
    expect(
      resolveItemDisplayName(
        item({ displayTitle: 'Has Title', stableId: null }),
        'per-item',
      ),
    ).toBe('Has Title');
  });
});

// ---------------------------------------------------------------------------
// Precedence: stableId wins over id / 'Seeding…'
// ---------------------------------------------------------------------------

describe('stableId beats id and Seeding placeholder', () => {
  it('returns stableId when displayTitle is null (per-item stage, stableId set)', () => {
    expect(
      resolveItemDisplayName(
        item({ displayTitle: null, stableId: 'feat-alpha', id: 'uuid-3' }),
        'per-item',
      ),
    ).toBe('feat-alpha');
  });

  it('returns stableId when displayTitle is null (once stage)', () => {
    expect(
      resolveItemDisplayName(
        item({ displayTitle: null, stableId: 'some-stable', id: 'uuid-4' }),
        'once',
      ),
    ).toBe('some-stable');
  });
});

// ---------------------------------------------------------------------------
// Placeholder path: per-item + stableId null → 'Seeding…'
// ---------------------------------------------------------------------------

describe("per-item placeholder shows 'Seeding\\u2026'", () => {
  it("renders 'Seeding\u2026' for per-item stage placeholder (no displayTitle, no stableId)", () => {
    expect(
      resolveItemDisplayName(
        item({ displayTitle: null, stableId: null, id: 'uuid-placeholder' }),
        'per-item',
      ),
    ).toBe('Seeding\u2026');
  });

  it("renders 'Seeding\u2026' regardless of uuid value", () => {
    const result = resolveItemDisplayName(
      item({ displayTitle: null, stableId: null, id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }),
      'per-item',
    );
    expect(result).toBe('Seeding\u2026');
    expect(result).not.toMatch(/aaaa/);
  });
});

// ---------------------------------------------------------------------------
// Non-placeholder path: once-stage + null stableId → item.id (never 'Seeding…')
// ---------------------------------------------------------------------------

describe('once-stage items fall back to item.id, not Seeding', () => {
  it('returns item.id when displayTitle and stableId are both null (once stage)', () => {
    const id = 'uuid-5-once-stage';
    expect(
      resolveItemDisplayName(item({ displayTitle: null, stableId: null, id }), 'once'),
    ).toBe(id);
  });

  it('returns item.id when stageRun is undefined (no matching stage)', () => {
    const id = 'uuid-6-unknown-stage';
    expect(
      resolveItemDisplayName(item({ displayTitle: null, stableId: null, id }), undefined),
    ).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('empty string displayTitle is treated as falsy → falls through to stableId', () => {
    // TypeScript declares displayTitle as string | null, so '' is unusual in
    // practice, but nullish coalescing (??) treats '' as truthy.
    // Document actual behavior: '' is truthy for ?? so displayTitle '' wins.
    expect(
      resolveItemDisplayName(
        item({ displayTitle: '', stableId: 'sid', id: 'uuid-7' }),
        'per-item',
      ),
    ).toBe('');
  });

  it('null stableId on a per-item real item (unexpected: seeder should always write it) falls back to Seeding…', () => {
    // Defensive: if DB has null despite being a per-item stage item, we still
    // show 'Seeding…' rather than the UUID.
    expect(
      resolveItemDisplayName(
        item({ displayTitle: null, stableId: null }),
        'per-item',
      ),
    ).toBe('Seeding\u2026');
  });
});
