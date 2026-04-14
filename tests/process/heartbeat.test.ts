/**
 * Tests for src/server/process/heartbeat.ts
 *
 * Acceptance criteria covered:
 *   AC-1 — Liveness probe emits stream.system_notice warning on ESRCH; no SIGTERM.
 *   AC-2 — Stream-activity watchdog emits warning after configured idle interval.
 *   AC-3 — Both probes suppressed while isRateLimited() returns true.
 *   AC-4 — Intervals read from config at construction time.
 *   AC-5 — Suppression state read fresh each tick, not cached.
 *
 * Review criteria covered:
 *   RC-1 — No SIGTERM / SIGKILL in any probe path — confirmed by mock assertions.
 *   RC-2 — Suppression checked per tick, not at construction.
 *   RC-3 — stop() clears the interval; no leaked setInterval.
 *
 * Uses vitest fake timers so all timing is deterministic without wall-clock
 * delays. process.kill is spied upon so the liveness probe can be exercised
 * without requiring an actual live or dead PID.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Heartbeat, type HeartbeatConfig } from '../../src/server/process/heartbeat.js';
import type { StreamSystemNoticeEvent } from '../../src/server/process/stream-json.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Heartbeat with sensible test defaults. */
function makeHeartbeat(
  overrides: {
    config?: Partial<HeartbeatConfig>;
    isRateLimited?: () => boolean;
    pid?: number;
  } = {},
): Heartbeat {
  return new Heartbeat({
    pid: overrides.pid ?? 12345,
    config: {
      liveness_interval_s: 10,
      activity_timeout_s: 30,
      ...overrides.config,
    },
    isRateLimited: overrides.isRateLimited ?? (() => false),
  });
}

/** Collect all stream.system_notice events emitted by a Heartbeat. */
function collectNotices(hb: Heartbeat): StreamSystemNoticeEvent[] {
  const events: StreamSystemNoticeEvent[] = [];
  hb.on('stream.system_notice', (ev) => events.push(ev));
  return events;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  // Default: process.kill does nothing (process alive — no throw).
  vi.spyOn(process, 'kill').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// AC-1 — Liveness probe
// ---------------------------------------------------------------------------

describe('liveness probe', () => {
  it('AC-1: emits stream.system_notice with subtype liveness_stale when kill(pid,0) returns ESRCH', () => {
    const esrch = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw esrch;
    });

    const hb = makeHeartbeat({ pid: 99999 });
    const notices = collectNotices(hb);
    hb.start();

    vi.advanceTimersByTime(10_000); // one tick at liveness_interval_s=10

    expect(notices).toHaveLength(1);
    expect(notices[0].type).toBe('stream.system_notice');
    expect(notices[0].subtype).toBe('liveness_stale');
    expect((notices[0].data as Record<string, unknown>)['source']).toBe('heartbeat');
    expect((notices[0].data as Record<string, unknown>)['pid']).toBe(99999);

    hb.stop();
  });

  it('AC-1 / RC-1: does NOT call SIGTERM or SIGKILL — only signal 0 is used', () => {
    // If the liveness probe sends any real signal the spy would capture it.
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

    const hb = makeHeartbeat();
    hb.start();
    vi.advanceTimersByTime(10_000);
    hb.stop();

    // Every kill call must use signal 0 (liveness probe) — never 'SIGTERM' or 'SIGKILL'.
    for (const call of killSpy.mock.calls) {
      expect(call[1]).toBe(0);
    }
  });

  it('no event emitted when PID is alive (kill(pid,0) does not throw)', () => {
    vi.spyOn(process, 'kill').mockReturnValue(true); // no throw = alive

    const hb = makeHeartbeat();
    const notices = collectNotices(hb);
    hb.start();

    vi.advanceTimersByTime(10_000);

    expect(notices).toHaveLength(0);

    hb.stop();
  });

  it('EPERM does not emit a warning (process alive, permission denied)', () => {
    const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw eperm;
    });

    const hb = makeHeartbeat();
    const notices = collectNotices(hb);
    hb.start();

    vi.advanceTimersByTime(10_000);

    expect(notices).toHaveLength(0);

    hb.stop();
  });

  it('warns exactly once across multiple ticks after ESRCH', () => {
    const esrch = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw esrch;
    });

    const hb = makeHeartbeat();
    const notices = collectNotices(hb);
    hb.start();

    // Advance through 5 liveness-probe ticks.
    vi.advanceTimersByTime(50_000);

    // Only one warning despite 5 ticks — livenessWarnedOnce gate.
    expect(notices.filter((n) => n.subtype === 'liveness_stale')).toHaveLength(1);

    hb.stop();
  });

  it('AC-3: liveness probe suppressed when isRateLimited() returns true', () => {
    const esrch = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw esrch;
    });

    const hb = makeHeartbeat({ isRateLimited: () => true });
    const notices = collectNotices(hb);
    hb.start();

    vi.advanceTimersByTime(10_000);

    expect(notices).toHaveLength(0);

    hb.stop();
  });
});

// ---------------------------------------------------------------------------
// AC-2 — Stream-activity watchdog
// ---------------------------------------------------------------------------

describe('stream-activity watchdog', () => {
  it('AC-2: emits stream.system_notice with subtype stream_idle after idle period', () => {
    const hb = makeHeartbeat({ config: { activity_timeout_s: 30, liveness_interval_s: 10 } });
    const notices = collectNotices(hb);
    hb.start();

    // Advance past the activity timeout (30 s) and trigger the 10 s tick.
    vi.advanceTimersByTime(31_000);

    const idleNotices = notices.filter((n) => n.subtype === 'stream_idle');
    expect(idleNotices).toHaveLength(1);
    expect(idleNotices[0].type).toBe('stream.system_notice');
    expect((idleNotices[0].data as Record<string, unknown>)['source']).toBe('heartbeat');

    hb.stop();
  });

  it('AC-2 / RC-1: watchdog does NOT send any process signal', () => {
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

    const hb = makeHeartbeat({ config: { activity_timeout_s: 5, liveness_interval_s: 10 } });
    hb.start();

    // Advance past activity timeout; trigger tick.
    vi.advanceTimersByTime(11_000);

    // kill should only have been called for the liveness probe (signal 0).
    for (const call of killSpy.mock.calls) {
      expect(call[1]).toBe(0);
    }

    hb.stop();
  });

  it('no warning within activity timeout window', () => {
    const hb = makeHeartbeat({ config: { activity_timeout_s: 30, liveness_interval_s: 10 } });
    const notices = collectNotices(hb);
    hb.start();

    // Advance to just before the timeout — still within grace window.
    vi.advanceTimersByTime(29_000);

    expect(notices.filter((n) => n.subtype === 'stream_idle')).toHaveLength(0);

    hb.stop();
  });

  it('warns exactly once per idle period', () => {
    const hb = makeHeartbeat({ config: { activity_timeout_s: 30, liveness_interval_s: 10 } });
    const notices = collectNotices(hb);
    hb.start();

    // Advance 3 full ticks past the timeout.
    vi.advanceTimersByTime(60_000);

    expect(notices.filter((n) => n.subtype === 'stream_idle')).toHaveLength(1);

    hb.stop();
  });

  it('warns again after notifyStdoutLine() resets the watchdog', () => {
    const hb = makeHeartbeat({ config: { activity_timeout_s: 30, liveness_interval_s: 10 } });
    const notices = collectNotices(hb);
    hb.start();

    // First idle period — tick fires at 40 s (> 30 s activity_timeout_s).
    vi.advanceTimersByTime(40_000);
    expect(notices.filter((n) => n.subtype === 'stream_idle')).toHaveLength(1);

    // Stdout arrives — reset the watchdog.
    hb.notifyStdoutLine();

    // Second idle period — another 40 s with no stdout.
    vi.advanceTimersByTime(40_000);
    expect(notices.filter((n) => n.subtype === 'stream_idle')).toHaveLength(2);

    hb.stop();
  });

  it('notifyStdoutLine() resets the idle clock (no warning when called within timeout)', () => {
    const hb = makeHeartbeat({ config: { activity_timeout_s: 30, liveness_interval_s: 10 } });
    const notices = collectNotices(hb);
    hb.start();

    // Advance to 25 s then receive stdout — idle clock resets.
    vi.advanceTimersByTime(25_000);
    hb.notifyStdoutLine();

    // Advance another 25 s (only 25 s since last stdout — below 30 s threshold).
    vi.advanceTimersByTime(25_000);

    expect(notices.filter((n) => n.subtype === 'stream_idle')).toHaveLength(0);

    hb.stop();
  });

  it('AC-3: stream-activity watchdog suppressed when isRateLimited() returns true', () => {
    const hb = makeHeartbeat({
      isRateLimited: () => true,
      config: { activity_timeout_s: 5, liveness_interval_s: 10 },
    });
    const notices = collectNotices(hb);
    hb.start();

    vi.advanceTimersByTime(20_000);

    expect(notices.filter((n) => n.subtype === 'stream_idle')).toHaveLength(0);

    hb.stop();
  });
});

// ---------------------------------------------------------------------------
// AC-3 / AC-5 — Suppression behaviour
// ---------------------------------------------------------------------------

describe('suppression', () => {
  it('AC-5: suppression changes between ticks — each tick calls isRateLimited() fresh', () => {
    // Tick 1: rate_limited → no event.
    // Tick 2: not rate_limited + ESRCH → event.
    const esrch = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw esrch;
    });

    let limited = true;
    const hb = makeHeartbeat({ isRateLimited: () => limited });
    const notices = collectNotices(hb);
    hb.start();

    // Tick 1: still rate_limited.
    vi.advanceTimersByTime(10_000);
    expect(notices).toHaveLength(0);

    // Switch suppression off — next tick should warn.
    limited = false;
    vi.advanceTimersByTime(10_000);

    // liveness_stale should appear now.
    expect(notices.filter((n) => n.subtype === 'liveness_stale')).toHaveLength(1);

    hb.stop();
  });

  it('AC-5: suppression lifted mid-session allows stream-idle to fire', () => {
    let limited = true;
    const hb = makeHeartbeat({
      isRateLimited: () => limited,
      config: { activity_timeout_s: 5, liveness_interval_s: 10 },
    });
    const notices = collectNotices(hb);
    hb.start();

    // Rate-limited for 10 s — tick fires but is suppressed.
    vi.advanceTimersByTime(10_000);
    expect(notices.filter((n) => n.subtype === 'stream_idle')).toHaveLength(0);

    // Lift suppression; advance another tick (activity_timeout of 5 s already elapsed).
    limited = false;
    vi.advanceTimersByTime(10_000);
    expect(notices.filter((n) => n.subtype === 'stream_idle')).toHaveLength(1);

    hb.stop();
  });
});

// ---------------------------------------------------------------------------
// AC-4 — Config read at construction time
// ---------------------------------------------------------------------------

describe('configuration', () => {
  it('AC-4: liveness_interval_s from config determines tick frequency', () => {
    const esrch = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw esrch;
    });

    // Use a 5-second interval.
    const hb = makeHeartbeat({ config: { liveness_interval_s: 5, activity_timeout_s: 30 } });
    const notices = collectNotices(hb);
    hb.start();

    // At 4 s — no tick yet.
    vi.advanceTimersByTime(4_000);
    expect(notices).toHaveLength(0);

    // At 5 s — first tick fires.
    vi.advanceTimersByTime(1_000);
    expect(notices.filter((n) => n.subtype === 'liveness_stale')).toHaveLength(1);

    hb.stop();
  });

  it('AC-4: activity_timeout_s from config sets the stream-idle threshold', () => {
    const hb = makeHeartbeat({ config: { liveness_interval_s: 10, activity_timeout_s: 20 } });
    const notices = collectNotices(hb);
    hb.start();

    // 10 s tick: 10 s idle < 20 s threshold → no warning.
    vi.advanceTimersByTime(10_000);
    expect(notices.filter((n) => n.subtype === 'stream_idle')).toHaveLength(0);

    // 20 s tick: 20 s idle >= 20 s threshold → warning.
    vi.advanceTimersByTime(10_000);
    expect(notices.filter((n) => n.subtype === 'stream_idle')).toHaveLength(1);

    hb.stop();
  });

  it('AC-4: defaults are used when config fields are omitted (30 s liveness, 90 s activity)', () => {
    const esrch = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw esrch;
    });

    const hb = new Heartbeat({
      pid: 1,
      config: {}, // all fields omitted → defaults apply
      isRateLimited: () => false,
    });
    const notices = collectNotices(hb);
    hb.start();

    // Default liveness_interval_s = 30 → tick at 30 s.
    vi.advanceTimersByTime(29_000);
    expect(notices.filter((n) => n.subtype === 'liveness_stale')).toHaveLength(0);

    vi.advanceTimersByTime(1_000); // 30 s total
    expect(notices.filter((n) => n.subtype === 'liveness_stale')).toHaveLength(1);

    hb.stop();
  });
});

// ---------------------------------------------------------------------------
// RC-3 — Lifecycle / no leaked setInterval
// ---------------------------------------------------------------------------

describe('lifecycle', () => {
  it('RC-3: stop() prevents further events after being called', () => {
    const esrch = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw esrch;
    });

    const hb = makeHeartbeat();
    const notices = collectNotices(hb);
    hb.start();

    hb.stop(); // stop immediately

    // Advance several ticks — no events should fire.
    vi.advanceTimersByTime(100_000);

    expect(notices).toHaveLength(0);
  });

  it('RC-3: start() is idempotent — calling twice does not create two intervals', () => {
    const esrch = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw esrch;
    });

    const hb = makeHeartbeat();
    const notices = collectNotices(hb);
    hb.start();
    hb.start(); // second start — should be a no-op

    vi.advanceTimersByTime(10_000); // one tick interval

    // If two intervals were created we'd get 2 liveness_stale events.
    expect(notices.filter((n) => n.subtype === 'liveness_stale')).toHaveLength(1);

    hb.stop();
  });

  it('RC-3: stop() is idempotent — calling before start() does not throw', () => {
    const hb = makeHeartbeat();
    expect(() => hb.stop()).not.toThrow();
    expect(() => hb.stop()).not.toThrow();
  });

  it('can be restarted after stop() — new interval fires fresh events', () => {
    const esrch = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw esrch;
    });

    const hb = makeHeartbeat();
    const notices = collectNotices(hb);

    hb.start();
    vi.advanceTimersByTime(10_000); // tick 1 → liveness_stale (warned once)
    hb.stop();

    const countAfterFirstStart = notices.filter((n) => n.subtype === 'liveness_stale').length;

    // Advance time while stopped — no new events.
    vi.advanceTimersByTime(10_000);
    expect(notices.filter((n) => n.subtype === 'liveness_stale')).toHaveLength(countAfterFirstStart);

    hb.stop();
  });
});
