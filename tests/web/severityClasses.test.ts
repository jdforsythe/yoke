/**
 * Unit tests for severityClasses — the severity → Tailwind palette mapping
 * used by SystemNoticeRenderer.
 *
 * Background: a past bug caused the dashboard to white-screen when a
 * SystemNoticeBlock arrived with a severity outside the declared union
 * (the switch had no default branch and returned undefined). These tests
 * lock in the post-fix contract: every declared severity AND any unknown
 * value must return a non-empty, fully-populated palette.
 */

import { describe, it, expect } from 'vitest';
import { severityClasses } from '../../src/web/src/components/LiveStream/severityClasses';
import type { SystemNoticeBlock } from '../../src/web/src/store/types';

const KNOWN_SEVERITIES: Array<SystemNoticeBlock['severity']> = [
  'info',
  'warn',
  'error',
  'requires_attention',
];

function assertPalette(palette: unknown): asserts palette is {
  border: string;
  bg: string;
  text: string;
} {
  expect(palette).toBeDefined();
  expect(palette).not.toBeNull();
  expect(typeof palette).toBe('object');
  const p = palette as Record<string, unknown>;
  expect(typeof p.border).toBe('string');
  expect(typeof p.bg).toBe('string');
  expect(typeof p.text).toBe('string');
  expect((p.border as string).length).toBeGreaterThan(0);
  expect((p.bg as string).length).toBeGreaterThan(0);
  expect((p.text as string).length).toBeGreaterThan(0);
}

describe('severityClasses', () => {
  for (const severity of KNOWN_SEVERITIES) {
    it(`returns a non-empty palette for severity "${severity}"`, () => {
      const palette = severityClasses(severity);
      assertPalette(palette);
    });
  }

  it('returns the fallback (info) palette for an unknown severity without throwing', () => {
    // Deliberately bypass the type system — simulates a frame with a new or
    // malformed severity value slipping through at runtime.
    const run = () => severityClasses('unknown' as unknown as SystemNoticeBlock['severity']);
    expect(run).not.toThrow();
    const palette = run();
    assertPalette(palette);
    // Fallback must match the `info` palette (documented contract).
    expect(palette).toEqual(severityClasses('info'));
  });

  it('returns a palette even when severity is undefined', () => {
    const run = () => severityClasses(undefined as unknown as SystemNoticeBlock['severity']);
    expect(run).not.toThrow();
    const palette = run();
    assertPalette(palette);
  });
});
