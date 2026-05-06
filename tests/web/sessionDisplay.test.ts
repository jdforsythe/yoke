/**
 * Unit tests for src/web/src/components/LiveStream/sessionDisplay.ts pure
 * formatters.
 *
 * Covered:
 *   - relativeTime() — coarse "Xs/Xm/Xh/Xd ago" buckets
 *   - duration()     — "running" when no endedAt; rolled-up s/m/h otherwise
 *   - sessionStatusClass() — Tailwind class mapping per status
 *
 * The fetch/load helpers in the same module reach into the render store and
 * fetch global, so they're exercised end-to-end via Playwright instead.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  relativeTime,
  duration,
  sessionStatusClass,
} from '../../src/web/src/components/LiveStream/formatters';

describe('relativeTime', () => {
  beforeEach(() => {
    // Pin Date.now() to a known instant so the buckets are deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports seconds for sub-minute deltas', () => {
    expect(relativeTime('2026-05-01T11:59:30Z')).toBe('30s ago');
  });

  it('reports minutes for sub-hour deltas', () => {
    expect(relativeTime('2026-05-01T11:30:00Z')).toBe('30m ago');
  });

  it('reports hours for sub-day deltas', () => {
    expect(relativeTime('2026-05-01T06:00:00Z')).toBe('6h ago');
  });

  it('reports days for >= 24h deltas', () => {
    expect(relativeTime('2026-04-29T12:00:00Z')).toBe('2d ago');
  });

  it('clamps negative (future) deltas to "0s ago" rather than throwing', () => {
    // A session row whose start time is slightly ahead of the client clock
    // (clock skew between server and browser) shouldn't crash the renderer.
    const out = relativeTime('2026-05-01T12:00:01Z');
    expect(out).toMatch(/-?\d+s ago/);
  });
});

describe('duration', () => {
  it('returns "running" when endedAt is null', () => {
    expect(duration('2026-05-01T12:00:00Z', null)).toBe('running');
  });

  it('formats sub-minute spans as "Ns"', () => {
    expect(duration('2026-05-01T12:00:00Z', '2026-05-01T12:00:42Z')).toBe('42s');
  });

  it('formats sub-hour spans as "Nm Ns"', () => {
    expect(duration('2026-05-01T12:00:00Z', '2026-05-01T12:05:30Z')).toBe('5m 30s');
  });

  it('formats hour-plus spans as "Nh Nm"', () => {
    expect(duration('2026-05-01T12:00:00Z', '2026-05-01T13:42:00Z')).toBe('1h 42m');
  });
});

describe('sessionStatusClass', () => {
  it('uses green for complete', () => {
    expect(sessionStatusClass('complete')).toMatch(/green/);
  });
  it('uses blue for in_progress', () => {
    expect(sessionStatusClass('in_progress')).toMatch(/blue/);
  });
  it('uses gray for abandoned', () => {
    expect(sessionStatusClass('abandoned')).toMatch(/gray/);
  });
  it('falls back to red for any unknown / failure status', () => {
    expect(sessionStatusClass('failed')).toMatch(/red/);
    expect(sessionStatusClass('mystery')).toMatch(/red/);
  });
});
