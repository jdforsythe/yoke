/**
 * Unit tests for src/server/fault/injector.ts.
 *
 * Coverage:
 *   AC-1  NoopFaultInjector is zero overhead — check() never throws.
 *   AC-5  Checkpoint names are the exported string union values; tests
 *         reference them by name (not positionally).
 *   RC-2  ActiveFaultInjector throws only at armed checkpoints.
 *   RC-3  check() is synchronous — no async behaviour.
 *   RC-4  FaultInjector is a plain interface; no env lookup inside the class.
 */

import { describe, it, expect } from 'vitest';
import {
  NoopFaultInjector,
  ActiveFaultInjector,
  FaultInjectionError,
} from '../../src/server/fault/injector.js';
import type { Checkpoint } from '../../src/server/fault/injector.js';

// All named checkpoints — exhaustive enumeration (AC-5, RC-2).
const ALL_CHECKPOINTS: Checkpoint[] = [
  'bootstrap_ok',
  'session_ok',
  'artifact_validators',
  'post_commands_ok',
];

// ---------------------------------------------------------------------------
// NoopFaultInjector — production no-op
// ---------------------------------------------------------------------------

describe('NoopFaultInjector', () => {
  it('check() never throws for any checkpoint (AC-1)', () => {
    const fi = new NoopFaultInjector();
    for (const cp of ALL_CHECKPOINTS) {
      expect(() => fi.check(cp)).not.toThrow();
    }
  });

  it('check() returns undefined (zero return value overhead)', () => {
    const fi = new NoopFaultInjector();
    expect(fi.check('bootstrap_ok')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ActiveFaultInjector — test implementation
// ---------------------------------------------------------------------------

describe('ActiveFaultInjector', () => {
  it('throws FaultInjectionError at each armed checkpoint individually (RC-2)', () => {
    for (const target of ALL_CHECKPOINTS) {
      const fi = new ActiveFaultInjector([target]);
      expect(() => fi.check(target)).toThrow(FaultInjectionError);
    }
  });

  it('does not throw at unarmed checkpoints (RC-2)', () => {
    // Arm only 'session_ok'; all other checkpoints must be no-ops.
    const fi = new ActiveFaultInjector(['session_ok']);
    const unarmed = ALL_CHECKPOINTS.filter((cp) => cp !== 'session_ok');
    for (const cp of unarmed) {
      expect(() => fi.check(cp)).not.toThrow();
    }
  });

  it('can arm multiple checkpoints simultaneously', () => {
    const fi = new ActiveFaultInjector(['bootstrap_ok', 'artifact_validators']);
    expect(() => fi.check('bootstrap_ok')).toThrow(FaultInjectionError);
    expect(() => fi.check('artifact_validators')).toThrow(FaultInjectionError);
    expect(() => fi.check('session_ok')).not.toThrow();
    expect(() => fi.check('post_commands_ok')).not.toThrow();
  });

  it('arming zero checkpoints results in no-op for all (edge case)', () => {
    const fi = new ActiveFaultInjector([]);
    for (const cp of ALL_CHECKPOINTS) {
      expect(() => fi.check(cp)).not.toThrow();
    }
  });

  it('accepts any Iterable (Set, Array, generator)', () => {
    // Set input
    const fiSet = new ActiveFaultInjector(new Set<Checkpoint>(['session_ok']));
    expect(() => fiSet.check('session_ok')).toThrow(FaultInjectionError);

    // Generator input
    function* gen(): Generator<Checkpoint> { yield 'bootstrap_ok'; }
    const fiGen = new ActiveFaultInjector(gen());
    expect(() => fiGen.check('bootstrap_ok')).toThrow(FaultInjectionError);
  });
});

// ---------------------------------------------------------------------------
// FaultInjectionError
// ---------------------------------------------------------------------------

describe('FaultInjectionError', () => {
  it('has the correct name and checkpoint property (AC-5)', () => {
    const err = new FaultInjectionError('session_ok');
    expect(err).toBeInstanceOf(FaultInjectionError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('FaultInjectionError');
    expect(err.checkpoint).toBe('session_ok');
  });

  it('message includes the checkpoint name', () => {
    const err = new FaultInjectionError('bootstrap_ok');
    expect(err.message).toContain('bootstrap_ok');
  });

  it('is distinguishable from a plain Error (instanceof guard)', () => {
    const faultErr = new FaultInjectionError('post_commands_ok');
    const plainErr = new Error('something else');
    expect(faultErr instanceof FaultInjectionError).toBe(true);
    expect(plainErr instanceof FaultInjectionError).toBe(false);
  });
});
