/**
 * FaultInjector — checkpoint seam for crash-recovery test coverage.
 *
 * Injects deterministic faults at named checkpoints inside the scheduler
 * so the crash-recovery test suite can exercise every restart projection
 * path without manual intervention (plan-draft3 §Testability, §Crash Recovery).
 *
 * ## Design constraints (RC-1 through RC-4)
 *
 *   RC-1  Zero production code changes beyond injection call-sites.
 *         No global state mutation — the injector holds per-instance state only.
 *   RC-2  Checkpoints are a named string union (not positional) so test
 *         authors can target specific failure points by name.
 *   RC-3  check() is synchronous — no sleep() hacks needed to trigger paths.
 *   RC-4  FaultInjector is injected via constructor parameter into Scheduler;
 *         this module performs NO process.env lookup — the caller decides
 *         whether to construct a NoopFaultInjector or an ActiveFaultInjector
 *         (typically based on YOKE_FAULT_INJECT in the entry point, not here).
 *
 * ## Production path (AC-1)
 *
 *   The Scheduler constructor defaults to a NoopFaultInjector when no
 *   faultInjector is provided in SchedulerOpts.  NoopFaultInjector.check()
 *   is an empty function with zero overhead.
 *
 * ## Test path
 *
 *   Tests construct an ActiveFaultInjector with the set of checkpoints to
 *   arm, pass it to the Scheduler, and observe that:
 *     - 'bootstrap_ok' → triggers the bootstrap_fail recovery path (AC-2).
 *     - 'session_ok'   → triggers the crash-recovery restart path (AC-3).
 *
 * ## Usage
 *
 *   ```ts
 *   // Production (no-op):
 *   const fi = new NoopFaultInjector();
 *
 *   // Test (armed):
 *   const fi = new ActiveFaultInjector(['session_ok']);
 *
 *   // At each checkpoint in the scheduler:
 *   this.faultInjector.check('bootstrap_ok');  // throws FaultInjectionError if armed
 *   ```
 */

// ---------------------------------------------------------------------------
// Checkpoint names (RC-2: string union, not positional)
// ---------------------------------------------------------------------------

/**
 * Named checkpoints where fault injection can be triggered.
 *
 * Each name corresponds to a well-defined point in the session lifecycle:
 *
 *   bootstrap_ok        After worktree bootstrap commands succeed, before the
 *                       bootstrap_ok state transition is committed to SQLite.
 *   session_ok          After session exits 0, all artifact validators pass,
 *                       and all post commands pass, before the session_ok
 *                       state transition is committed.
 *   artifact_validators After artifact validators pass, before post commands run.
 *   post_commands_ok    After post commands complete, before session_ok is committed.
 */
export type Checkpoint =
  | 'bootstrap_ok'
  | 'session_ok'
  | 'artifact_validators'
  | 'post_commands_ok';

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Thrown synchronously by ActiveFaultInjector.check() when the named
 * checkpoint is armed.  The caller (Scheduler) catches this and routes
 * the item to the appropriate recovery state.
 */
export class FaultInjectionError extends Error {
  public readonly checkpoint: Checkpoint;

  constructor(checkpoint: Checkpoint) {
    super(`FaultInjector: fault injected at checkpoint '${checkpoint}'`);
    this.name = 'FaultInjectionError';
    this.checkpoint = checkpoint;
  }
}

// ---------------------------------------------------------------------------
// FaultInjector interface
// ---------------------------------------------------------------------------

/**
 * The single abstraction injected into the Scheduler.
 *
 * Two implementations exist:
 *   NoopFaultInjector   — production; check() is a no-op.
 *   ActiveFaultInjector — test; check() throws when the checkpoint is armed.
 */
export interface FaultInjector {
  /**
   * Called at a named checkpoint in the session lifecycle.
   *
   * @throws {FaultInjectionError} when the checkpoint is armed (ActiveFaultInjector).
   */
  check(checkpoint: Checkpoint): void;
}

// ---------------------------------------------------------------------------
// NoopFaultInjector — production implementation (AC-1: zero overhead)
// ---------------------------------------------------------------------------

/**
 * No-op implementation used in production.
 *
 * check() is an empty function — no branches, no allocations, no overhead.
 * The scheduler defaults to this when no faultInjector is supplied in opts.
 */
export class NoopFaultInjector implements FaultInjector {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  check(_checkpoint: Checkpoint): void {
    // intentionally empty — zero overhead in the production path (AC-1)
  }
}

// ---------------------------------------------------------------------------
// ActiveFaultInjector — test implementation
// ---------------------------------------------------------------------------

/**
 * Test implementation that throws FaultInjectionError at armed checkpoints.
 *
 * Constructed with an iterable of Checkpoint names to arm.  Every call to
 * check() with an armed name throws synchronously (RC-3: no sleep hacks).
 *
 * Example:
 *   const fi = new ActiveFaultInjector(['session_ok', 'artifact_validators']);
 *   fi.check('session_ok');        // throws FaultInjectionError
 *   fi.check('bootstrap_ok');      // no-op (not armed)
 */
export class ActiveFaultInjector implements FaultInjector {
  private readonly armed: ReadonlySet<Checkpoint>;

  constructor(armed: Iterable<Checkpoint>) {
    this.armed = new Set(armed);
  }

  check(checkpoint: Checkpoint): void {
    if (this.armed.has(checkpoint)) {
      throw new FaultInjectionError(checkpoint);
    }
  }
}
