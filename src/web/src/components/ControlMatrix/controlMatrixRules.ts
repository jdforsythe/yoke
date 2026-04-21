import type { State } from '../../../../shared/types/states';
import type { WorkflowStatus } from '../../../../shared/types/workflow';
import type { ControlPayload, ItemProjection, StageProjection } from '../../ws/types';

export interface ControlCtx {
  workflowStatus: string;
  items: ItemProjection[];
  selectedItem: ItemProjection | null;
  activeSessionId: string | null;
  activeStage: StageProjection | null;
}

type RuleFn = (ctx: ControlCtx) => boolean;

// ---------------------------------------------------------------------------
// Exhaustive lookup tables.
// Record<Union, T> causes a TS compile error when a value is added to or
// removed from WorkflowStatus or State — no switch statement needed.
// ---------------------------------------------------------------------------

const TERMINAL_WF: Record<WorkflowStatus, boolean> = {
  pending: false,
  in_progress: false,
  pending_stage_approval: false,
  completed: true,
  completed_with_blocked: true,
  abandoned: true,
};

const RETRY_ELIGIBLE: Record<State, boolean> = {
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

const SKIP_ELIGIBLE: Record<State, boolean> = {
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

const UNBLOCK_ELIGIBLE: Record<State, boolean> = {
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

const RERUN_ELIGIBLE: Record<State, boolean> = {
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

// ---------------------------------------------------------------------------
// Rules
// All RULES entries reference only values from WorkflowStatus and State.
// ---------------------------------------------------------------------------

export const RULES: Record<ControlPayload['action'], RuleFn> = {
  pause: (ctx) => ctx.workflowStatus === 'in_progress',
  resume: (ctx) => ctx.workflowStatus === 'paused',
  cancel: (ctx) => !(TERMINAL_WF[ctx.workflowStatus as WorkflowStatus] ?? false),
  skip: (ctx) =>
    !!ctx.selectedItem &&
    (SKIP_ELIGIBLE[ctx.selectedItem.state.status as State] ?? false),
  retry: (ctx) =>
    ctx.items.some((item) => RETRY_ELIGIBLE[item.state.status as State] ?? false),
  unblock: (ctx) =>
    !!ctx.selectedItem &&
    (UNBLOCK_ELIGIBLE[ctx.selectedItem.state.status as State] ?? false),
  'inject-context': (ctx) => !!ctx.activeSessionId,
  'rerun-phase': (ctx) =>
    !!ctx.selectedItem &&
    (RERUN_ELIGIBLE[ctx.selectedItem.state.status as State] ?? false),
  'approve-stage': (ctx) =>
    !!ctx.activeStage &&
    ctx.activeStage.needsApproval &&
    ctx.activeStage.status === 'complete',
};

// ---------------------------------------------------------------------------
// Supported actions — only these render in the UI.
// Adding a new action is a one-line change here; the truth table test in
// tests/web/controlMatrix.test.ts will catch any missing RULES entry.
// ---------------------------------------------------------------------------

export const SUPPORTED_ACTIONS: Set<ControlPayload['action']> = new Set([
  'pause',
  'resume',
  'cancel',
  'skip',
  'retry',
  'unblock',
  'inject-context',
  'rerun-phase',
  'approve-stage',
]);
