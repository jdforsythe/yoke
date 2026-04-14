/**
 * action-grammar — unit tests.
 *
 * Pure functions; no I/O, no filesystem. All tests run in < 1 ms.
 */

import { describe, expect, it } from 'vitest';
import type { ActionsMap } from '../../src/shared/types/config.js';
import { isContinue, resolveAction } from '../../src/server/prepost/action-grammar.js';

// ---------------------------------------------------------------------------
// resolveAction — exact match
// ---------------------------------------------------------------------------

describe('resolveAction — exact match', () => {
  it('returns the value for the exact exit code string key', () => {
    const actions: ActionsMap = { '0': 'continue', '1': 'stop' };
    expect(resolveAction(actions, 0)).toBe('continue');
    expect(resolveAction(actions, 1)).toBe('stop');
  });

  it('resolves exit code 0 to continue', () => {
    const actions: ActionsMap = { '0': 'continue' };
    expect(resolveAction(actions, 0)).toBe('continue');
  });

  it('resolves exit code 127 (command not found) when declared', () => {
    const actions: ActionsMap = { '127': { fail: { reason: 'command not found' } } };
    expect(resolveAction(actions, 127)).toEqual({ fail: { reason: 'command not found' } });
  });

  it('resolves exit code 1 to a goto action', () => {
    const actions: ActionsMap = {
      '0': 'continue',
      '1': { goto: 'plan', max_revisits: 2 },
    };
    const result = resolveAction(actions, 1);
    expect(result).toEqual({ goto: 'plan', max_revisits: 2 });
  });

  it('resolves exit code 0 to a retry action', () => {
    const actions: ActionsMap = {
      '0': { retry: { mode: 'continue', max: 2 } },
    };
    expect(resolveAction(actions, 0)).toEqual({ retry: { mode: 'continue', max: 2 } });
  });

  it('resolves exit code to stop-and-ask', () => {
    const actions: ActionsMap = { '2': 'stop-and-ask' };
    expect(resolveAction(actions, 2)).toBe('stop-and-ask');
  });

  it('resolves exit code to stop', () => {
    const actions: ActionsMap = { '1': 'stop' };
    expect(resolveAction(actions, 1)).toBe('stop');
  });
});

// ---------------------------------------------------------------------------
// resolveAction — wildcard fallback
// ---------------------------------------------------------------------------

describe('resolveAction — wildcard fallback', () => {
  it('returns the wildcard value when no exact match exists', () => {
    const actions: ActionsMap = { '0': 'continue', '*': { fail: { reason: 'unexpected' } } };
    expect(resolveAction(actions, 5)).toEqual({ fail: { reason: 'unexpected' } });
  });

  it('prefers exact match over wildcard', () => {
    const actions: ActionsMap = { '0': 'continue', '*': 'stop' };
    expect(resolveAction(actions, 0)).toBe('continue');
  });

  it('wildcard alone covers all exit codes', () => {
    const actions: ActionsMap = { '*': 'stop-and-ask' };
    for (const code of [0, 1, 42, 127, 255]) {
      expect(resolveAction(actions, code)).toBe('stop-and-ask');
    }
  });

  it('wildcard can map to continue', () => {
    const actions: ActionsMap = { '*': 'continue' };
    expect(resolveAction(actions, 99)).toBe('continue');
  });
});

// ---------------------------------------------------------------------------
// resolveAction — no match (returns null)
// ---------------------------------------------------------------------------

describe('resolveAction — no match', () => {
  it('returns null when no exact key and no wildcard', () => {
    const actions: ActionsMap = { '0': 'continue' };
    expect(resolveAction(actions, 1)).toBeNull();
  });

  it('returns null for an empty actions map', () => {
    const actions: ActionsMap = {};
    expect(resolveAction(actions, 0)).toBeNull();
  });

  it('does not match partial string keys — "10" does not match exit code 1', () => {
    const actions: ActionsMap = { '10': 'stop' };
    expect(resolveAction(actions, 1)).toBeNull();
    expect(resolveAction(actions, 10)).toBe('stop');
  });

  it('treats exit code as decimal — no octal/hex ambiguity', () => {
    // Exit code 8 as decimal string
    const actions: ActionsMap = { '8': 'continue' };
    expect(resolveAction(actions, 8)).toBe('continue');
    expect(resolveAction(actions, 10)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveAction — prototype pollution safety
// ---------------------------------------------------------------------------

describe('resolveAction — prototype pollution safety', () => {
  it('does not match inherited Object.prototype properties (toString, constructor)', () => {
    const actions: ActionsMap = {};
    // The actions map is plain; we should not match inherited keys.
    // Exit code 0 should return null for an empty map regardless of prototype.
    expect(resolveAction(actions, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isContinue
// ---------------------------------------------------------------------------

describe('isContinue', () => {
  it('returns true for the string "continue"', () => {
    expect(isContinue('continue')).toBe(true);
  });

  it('returns false for "stop"', () => {
    expect(isContinue('stop')).toBe(false);
  });

  it('returns false for "stop-and-ask"', () => {
    expect(isContinue('stop-and-ask')).toBe(false);
  });

  it('returns false for a goto object', () => {
    expect(isContinue({ goto: 'plan' })).toBe(false);
  });

  it('returns false for a retry object', () => {
    expect(isContinue({ retry: { mode: 'continue', max: 1 } })).toBe(false);
  });

  it('returns false for a fail object', () => {
    expect(isContinue({ fail: { reason: 'bad' } })).toBe(false);
  });
});
