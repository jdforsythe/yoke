/**
 * Truth table tests for ControlMatrix RULES and SUPPORTED_ACTIONS.
 *
 * Iterates every ControlPayload['action'] × every State value and asserts
 * rule output matches the expected table below. This means:
 *  - Adding a new State to the union → update the RETRY_TRUTH_TABLE (or it
 *    will throw on the Record key lookup in controlMatrixRules.ts at typecheck
 *    time).
 *  - Adding a new action to SUPPORTED_ACTIONS → add a truth table entry
 *    here; the loop will catch it.
 */

import { describe, it, expect } from 'vitest';
import { STATE_VALUES } from '../../src/shared/types/states';
import type { State } from '../../src/shared/types/states';
import type { ControlPayload, ItemProjection, StageProjection } from '../../src/web/src/ws/types';
import { RULES, SUPPORTED_ACTIONS } from '../../src/web/src/components/ControlMatrix/controlMatrixRules';
import type { ControlCtx } from '../../src/web/src/components/ControlMatrix/controlMatrixRules';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(status: string): ItemProjection {
  return {
    id: 'item-1',
    stageId: 'stage-1',
    state: { status, currentPhase: null, retryCount: 0, blockedReason: null },
    displayTitle: null,
    displaySubtitle: null,
    stableId: null,
  };
}

function makeCtx(itemState: State, overrides: Partial<ControlCtx> = {}): ControlCtx {
  const item = makeItem(itemState);
  return {
    workflowStatus: 'in_progress',
    items: [item],
    selectedItem: item,
    activeSessionId: 'session-1',
    activeStage: {
      id: 'stage-1',
      run: 'once',
      phases: ['main'],
      status: 'in_progress',
      needsApproval: false,
    } as StageProjection,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Truth tables
// Each table is keyed by State value; true means the rule returns true
// given: workflowStatus='in_progress', selectedItem with that state,
//        items=[that item], activeSessionId='session-1',
//        activeStage={status:'in_progress', needsApproval:false}.
// ---------------------------------------------------------------------------

const CANCEL_TRUTH: Record<State, boolean> = {
  pending: true,
  ready: true,
  bootstrapping: true,
  bootstrap_failed: true,
  in_progress: true,
  awaiting_retry: true,
  rate_limited: true,
  awaiting_user: true,
  blocked: true,
  complete: true,
  abandoned: true,
};

const RETRY_TRUTH: Record<State, boolean> = {
  pending: false,
  ready: false,
  bootstrapping: false,
  bootstrap_failed: false,
  in_progress: false,
  awaiting_retry: true,
  rate_limited: false,
  awaiting_user: true,
  blocked: false,
  complete: false,
  abandoned: false,
};

const PAUSE_TRUTH: Record<State, boolean> = {
  pending: true,
  ready: true,
  bootstrapping: true,
  bootstrap_failed: true,
  in_progress: true,
  awaiting_retry: true,
  rate_limited: true,
  awaiting_user: true,
  blocked: true,
  complete: true,
  abandoned: true,
};

const RESUME_TRUTH: Record<State, boolean> = {
  pending: false,
  ready: false,
  bootstrapping: false,
  bootstrap_failed: false,
  in_progress: false,
  awaiting_retry: false,
  rate_limited: false,
  awaiting_user: false,
  blocked: false,
  complete: false,
  abandoned: false,
};

const SKIP_TRUTH: Record<State, boolean> = {
  pending: false,
  ready: false,
  bootstrapping: false,
  bootstrap_failed: false,
  in_progress: true,
  awaiting_retry: false,
  rate_limited: false,
  awaiting_user: false,
  blocked: true,
  complete: false,
  abandoned: false,
};

const UNBLOCK_TRUTH: Record<State, boolean> = {
  pending: false,
  ready: false,
  bootstrapping: false,
  bootstrap_failed: false,
  in_progress: false,
  awaiting_retry: false,
  rate_limited: false,
  awaiting_user: false,
  blocked: true,
  complete: false,
  abandoned: false,
};

// inject-context depends on activeSessionId (always 'session-1' in our ctx)
const INJECT_TRUTH: Record<State, boolean> = {
  pending: true,
  ready: true,
  bootstrapping: true,
  bootstrap_failed: true,
  in_progress: true,
  awaiting_retry: true,
  rate_limited: true,
  awaiting_user: true,
  blocked: true,
  complete: true,
  abandoned: true,
};

const RERUN_TRUTH: Record<State, boolean> = {
  pending: false,
  ready: false,
  bootstrapping: false,
  bootstrap_failed: false,
  in_progress: false,
  awaiting_retry: false,
  rate_limited: false,
  awaiting_user: false,
  blocked: false,
  complete: true,
  abandoned: true,
};

// approve-stage: activeStage.needsApproval=false and status='in_progress' → always false
const APPROVE_STAGE_TRUTH: Record<State, boolean> = {
  pending: false,
  ready: false,
  bootstrapping: false,
  bootstrap_failed: false,
  in_progress: false,
  awaiting_retry: false,
  rate_limited: false,
  awaiting_user: false,
  blocked: false,
  complete: false,
  abandoned: false,
};

const ACTION_TRUTH_TABLE: Record<ControlPayload['action'], Record<State, boolean>> = {
  cancel: CANCEL_TRUTH,
  retry: RETRY_TRUTH,
  pause: PAUSE_TRUTH,
  resume: RESUME_TRUTH,
  skip: SKIP_TRUTH,
  unblock: UNBLOCK_TRUTH,
  'inject-context': INJECT_TRUTH,
  'rerun-phase': RERUN_TRUTH,
  'approve-stage': APPROVE_STAGE_TRUTH,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SUPPORTED_ACTIONS', () => {
  it('contains exactly cancel and retry', () => {
    expect(SUPPORTED_ACTIONS.has('cancel')).toBe(true);
    expect(SUPPORTED_ACTIONS.has('retry')).toBe(true);
    expect(SUPPORTED_ACTIONS.size).toBe(2);
  });

  it('RULES contains an entry for every action in ACTION_TRUTH_TABLE', () => {
    for (const action of Object.keys(ACTION_TRUTH_TABLE) as ControlPayload['action'][]) {
      expect(RULES).toHaveProperty(action);
    }
  });
});

describe('RULES truth table — action × State', () => {
  for (const action of Object.keys(ACTION_TRUTH_TABLE) as ControlPayload['action'][]) {
    describe(`action: ${action}`, () => {
      for (const state of STATE_VALUES) {
        const expected = ACTION_TRUTH_TABLE[action][state];
        it(`state "${state}" → ${expected}`, () => {
          const ctx = makeCtx(state);
          expect(RULES[action](ctx)).toBe(expected);
        });
      }
    });
  }
});

describe('retry visibility — any item in awaiting_user or awaiting_retry', () => {
  it('returns true when at least one item is awaiting_user (others not)', () => {
    const ctx: ControlCtx = {
      workflowStatus: 'in_progress',
      items: [makeItem('in_progress'), makeItem('awaiting_user'), makeItem('complete')],
      selectedItem: makeItem('in_progress'),
      activeSessionId: null,
      activeStage: null,
    };
    expect(RULES.retry(ctx)).toBe(true);
  });

  it('returns true when at least one item is awaiting_retry (others not)', () => {
    const ctx: ControlCtx = {
      workflowStatus: 'in_progress',
      items: [makeItem('pending'), makeItem('awaiting_retry')],
      selectedItem: null,
      activeSessionId: null,
      activeStage: null,
    };
    expect(RULES.retry(ctx)).toBe(true);
  });

  it('returns false when no items are awaiting_user or awaiting_retry', () => {
    const ctx: ControlCtx = {
      workflowStatus: 'in_progress',
      items: [makeItem('in_progress'), makeItem('complete'), makeItem('blocked')],
      selectedItem: null,
      activeSessionId: null,
      activeStage: null,
    };
    expect(RULES.retry(ctx)).toBe(false);
  });

  it('returns false when items array is empty', () => {
    const ctx: ControlCtx = {
      workflowStatus: 'in_progress',
      items: [],
      selectedItem: null,
      activeSessionId: null,
      activeStage: null,
    };
    expect(RULES.retry(ctx)).toBe(false);
  });
});

describe('cancel visibility — terminal workflow statuses', () => {
  it('returns false for completed', () => {
    const ctx = makeCtx('complete', { workflowStatus: 'completed' });
    expect(RULES.cancel(ctx)).toBe(false);
  });

  it('returns false for completed_with_blocked', () => {
    const ctx = makeCtx('complete', { workflowStatus: 'completed_with_blocked' });
    expect(RULES.cancel(ctx)).toBe(false);
  });

  it('returns false for abandoned', () => {
    const ctx = makeCtx('complete', { workflowStatus: 'abandoned' });
    expect(RULES.cancel(ctx)).toBe(false);
  });

  it('returns true for pending', () => {
    const ctx = makeCtx('pending', { workflowStatus: 'pending' });
    expect(RULES.cancel(ctx)).toBe(true);
  });

  it('returns true for pending_stage_approval', () => {
    const ctx = makeCtx('pending', { workflowStatus: 'pending_stage_approval' });
    expect(RULES.cancel(ctx)).toBe(true);
  });
});
