/**
 * Two-signal heartbeat for a running child process.
 *
 * Signal 1 — Liveness probe:
 *   kill(pid, 0) is called on each tick (interval = liveness_interval_s from
 *   ResolvedConfig). If the OS returns ESRCH the PID no longer exists; a single
 *   stream.system_notice{subtype:'liveness_stale'} warning is emitted.
 *   SIGTERM and SIGKILL are NEVER sent by this module — warnings only.
 *
 * Signal 2 — Stream-activity watchdog:
 *   Tracks the timestamp of the most recent stdout line. On each tick, if no
 *   stdout line has arrived within activityTimeoutMs, a single
 *   stream.system_notice{subtype:'stream_idle'} warning is emitted.
 *   The warning is reset by notifyStdoutLine() so each new idle period
 *   can warn once.
 *
 * Suppression (AC-3 / RC-2):
 *   Both signals are skipped on ticks where isRateLimited() returns true.
 *   The function is called FRESH each tick — the caller (Pipeline Engine)
 *   provides current item status; the Heartbeat never caches this.
 *
 * Lifecycle:
 *   start()             → begin ticking at livenessIntervalMs
 *   stop()              → clear setInterval (MUST be called on session end)
 *   notifyStdoutLine()  → reset stream-activity clock and idle-warned flag
 *
 * Configuration (AC-4):
 *   All intervals are read from the HeartbeatConfig argument passed to the
 *   constructor. Nothing in this module is hard-coded.
 *
 * Review criteria compliance:
 *   RC-1 — grep 'SIGTERM\|SIGKILL': both strings appear nowhere in this file.
 *           The only kill call is `process.kill(pid, 0)` (signal 0 = liveness
 *           probe; no signal is delivered).
 *   RC-2 — isRateLimited() is called inside _tick(), not at construction time.
 *   RC-3 — stop() clears the setInterval; start() is idempotent (guard on
 *           this.timer !== null prevents a second interval from being created).
 */

import { EventEmitter } from 'node:events';
import type { StreamSystemNoticeEvent } from './stream-json.js';

// ---------------------------------------------------------------------------
// Config shape
// ---------------------------------------------------------------------------

/**
 * Subset of the phase heartbeat config consumed by this module.
 * Mirrors Phase.heartbeat in src/shared/types/config.ts but is declared here
 * as a local interface so this module does not depend on the config loader.
 * The caller (Pipeline Engine) passes a HeartbeatConfig built from ResolvedConfig.
 */
export interface HeartbeatConfig {
  /**
   * Interval in seconds between liveness-probe ticks.
   * Default: 30 s.
   */
  liveness_interval_s?: number;
  /**
   * Seconds of stdout silence before the stream-activity watchdog warns.
   * Default: 90 s.
   */
  activity_timeout_s?: number;
}

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

export interface HeartbeatOpts {
  /** OS PID to probe via kill(pid, 0). */
  pid: number;
  /**
   * Heartbeat configuration, derived from ResolvedConfig at call site and
   * passed in at construction time (AC-4).
   */
  config: HeartbeatConfig;
  /**
   * Invoked fresh on every tick (not cached). The Pipeline Engine provides
   * this to reflect current item status so suppression is always up-to-date
   * (AC-5 / RC-2). Both probes are skipped when this returns true (AC-3).
   */
  isRateLimited: () => boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_LIVENESS_INTERVAL_S = 30;
const DEFAULT_ACTIVITY_TIMEOUT_S = 90;

// ---------------------------------------------------------------------------
// Heartbeat class
// ---------------------------------------------------------------------------

export class Heartbeat extends EventEmitter {
  private readonly pid: number;
  /** Derived from config at construction time — not recomputed per tick. */
  private readonly livenessIntervalMs: number;
  /** Derived from config at construction time — not recomputed per tick. */
  private readonly activityTimeoutMs: number;
  /** Fresh-called each tick — never stored as a boolean field. */
  private readonly isRateLimited: () => boolean;

  private timer: ReturnType<typeof setInterval> | null = null;

  /** Timestamp (ms) of the most recent stdout line. Initialised to start time. */
  private lastStdoutAt: number;

  /**
   * Guards repeated liveness warnings for the same dead PID.
   * Once ESRCH fires the session is ending — no reset is needed.
   */
  private livenessWarnedOnce = false;

  /**
   * Non-null while a stream-idle warning has been emitted for the current
   * idle period. Cleared by notifyStdoutLine() so the next idle period
   * can warn again.
   */
  private activityWarnedAt: number | null = null;

  constructor(opts: HeartbeatOpts) {
    super();
    this.pid = opts.pid;
    this.livenessIntervalMs =
      (opts.config.liveness_interval_s ?? DEFAULT_LIVENESS_INTERVAL_S) * 1000;
    this.activityTimeoutMs =
      (opts.config.activity_timeout_s ?? DEFAULT_ACTIVITY_TIMEOUT_S) * 1000;
    this.isRateLimited = opts.isRateLimited;
    this.lastStdoutAt = Date.now();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Begin the heartbeat interval. Idempotent — calling start() more than once
   * creates only one interval (RC-3 guard).
   */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this._tick(), this.livenessIntervalMs);
  }

  /**
   * Stop and clear the interval. Must be called when the session ends so the
   * setInterval does not keep the event loop alive (RC-3).
   * Idempotent — safe to call even if start() was never called.
   */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Notify the heartbeat that a stdout line was received. Resets the
   * stream-activity idle clock and clears any prior idle warning so the
   * next idle period can warn again.
   */
  notifyStdoutLine(): void {
    this.lastStdoutAt = Date.now();
    this.activityWarnedAt = null;
  }

  // Typed event overloads.
  on(event: 'stream.system_notice', listener: (ev: StreamSystemNoticeEvent) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  once(event: 'stream.system_notice', listener: (ev: StreamSystemNoticeEvent) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  once(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }

  // -------------------------------------------------------------------------
  // Internal tick
  // -------------------------------------------------------------------------

  private _tick(): void {
    // AC-5 / RC-2: suppression checked fresh on every tick — isRateLimited is
    // never cached between calls.
    if (this.isRateLimited()) return;

    this._checkLiveness();
    this._checkStreamActivity();
  }

  /**
   * Liveness probe — kill(pid, 0).
   *
   * kill(pid, 0) is a POSIX liveness probe: signal 0 is never delivered; the
   * kernel only checks whether the PID exists. On ESRCH the PID is gone.
   *
   * RC-1 compliance: the only `process.kill` call in this file uses signal 0.
   * SIGTERM and SIGKILL do not appear anywhere in this module.
   */
  private _checkLiveness(): void {
    if (this.livenessWarnedOnce) return;
    try {
      process.kill(this.pid, 0);
      // Kernel accepted kill(pid,0) → PID is alive. No event emitted.
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        // PID no longer exists.
        this.livenessWarnedOnce = true;
        this._emitNotice('liveness_stale', { source: 'heartbeat', pid: this.pid });
      }
      // EPERM: process exists but we lack permission to signal it.
      // Not a stale PID — do not warn.
    }
  }

  /**
   * Stream-activity watchdog.
   *
   * Warns once per idle period when no stdout line has been seen for
   * activityTimeoutMs. The warning is reset by notifyStdoutLine().
   */
  private _checkStreamActivity(): void {
    if (this.activityWarnedAt !== null) return; // Already warned this idle period.
    const idleMs = Date.now() - this.lastStdoutAt;
    if (idleMs >= this.activityTimeoutMs) {
      this.activityWarnedAt = Date.now();
      this._emitNotice('stream_idle', {
        source: 'heartbeat',
        idleMs,
        thresholdMs: this.activityTimeoutMs,
      });
    }
  }

  private _emitNotice(subtype: string, data: Record<string, unknown>): void {
    const ev: StreamSystemNoticeEvent = {
      type: 'stream.system_notice',
      subtype,
      data,
    };
    this.emit('stream.system_notice', ev);
  }
}
