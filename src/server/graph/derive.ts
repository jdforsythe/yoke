/**
 * deriveFromHistory — one-shot rebuild of the graph from durable tables.
 *
 * Called when `workflows.graph_state` is NULL on first subscribe.  Replays
 * an equivalent GraphEvent stream in chronological order over the
 * configured graph, so the output matches what an incremental applyEvent
 * stream would have produced for the same history.
 */

import type {
  WorkflowGraph,
  ResolvedAction,
} from '../../shared/types/graph.js';
import type { ActionValue, Pipeline, Phase } from '../../shared/types/config.js';
import type { GraphEvent } from './events.js';
import { buildConfiguredGraph } from './builder.js';
import { applyEvent, applyPatch } from './apply.js';

export interface HistoryItemRow {
  id: string;
  stageId: string;
  stableId: string | null;
  status: string;
  currentPhase: string | null;
  dependsOn: string[] | null;
}

export interface HistorySessionRow {
  id: string;
  itemId: string | null;
  stage: string;
  phase: string;
  attempt: number;
  parentSessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
}

export interface HistoryPrepostRow {
  stage: string;
  phase: string;
  itemId: string | null;
  sessionId: string | null;
  when: 'pre' | 'post';
  commandName: string;
  startedAt: string;
  endedAt: string | null;
  actionTaken: ActionValue | null;
}

export interface DeriveInput {
  workflowId: string;
  pipeline: Pipeline;
  phases: Record<string, Phase>;
  items: HistoryItemRow[];
  sessions: HistorySessionRow[];
  prepostRuns: HistoryPrepostRow[];
  workflowStatus?: string;
}

export function deriveFromHistory(input: DeriveInput): WorkflowGraph {
  let graph = buildConfiguredGraph(input.workflowId, {
    pipeline: input.pipeline,
    phases: input.phases,
  });

  for (const ev of buildEventStream(input)) {
    graph = applyPatch(graph, applyEvent(graph, ev));
  }

  return graph;
}

function buildEventStream(input: DeriveInput): GraphEvent[] {
  const events: GraphEvent[] = [];

  // Group items by stage so per-item stages emit a single item_seeded event.
  const itemsByStage = new Map<string, HistoryItemRow[]>();
  for (const it of input.items) {
    const list = itemsByStage.get(it.stageId) ?? [];
    list.push(it);
    itemsByStage.set(it.stageId, list);
  }

  // Once-stages don't get item nodes in the graph, so any session/prepost row
  // in storage that carries an itemId for a once-stage would otherwise produce
  // a runtime phase node parented to a non-existent item — leaving the phase
  // orphaned at layout time and causing ELK to throw "Referenced shape does
  // not exist" for edges referencing it. Normalize itemId to null here so the
  // runtime phase id collapses onto the configured `phase:<stage>:_:<phase>`.
  const onceStages = new Set(
    input.pipeline.stages.filter((s) => s.run === 'once').map((s) => s.id),
  );
  const normalizeItemId = (stageId: string, itemId: string | null): string | null =>
    onceStages.has(stageId) ? null : itemId;

  for (const stage of input.pipeline.stages) {
    if (stage.run !== 'per-item') continue;
    const rows = itemsByStage.get(stage.id);
    if (!rows || rows.length === 0) continue;
    const stableToItem = new Map<string, string>();
    for (const r of rows) if (r.stableId) stableToItem.set(r.stableId, r.id);
    events.push({
      kind: 'item_seeded',
      stageId: stage.id,
      items: rows.map((r) => ({
        itemId: r.id,
        stableId: r.stableId,
        dependsOn: r.dependsOn?.filter((dep) => stableToItem.has(dep)) ?? [],
      })),
    });
  }

  const interleaved: Array<{ ts: string; seq: number; event: GraphEvent }> = [];

  for (let i = 0; i < input.sessions.length; i++) {
    const s = input.sessions[i];
    interleaved.push({
      ts: s.startedAt,
      seq: i * 2,
      event: {
        kind: 'session_started',
        stageId: s.stage,
        itemId: normalizeItemId(s.stage, s.itemId),
        phase: s.phase,
        sessionId: s.id,
        attempt: s.attempt,
        parentSessionId: s.parentSessionId,
        startedAt: s.startedAt,
      },
    });
    if (s.endedAt) {
      interleaved.push({
        ts: s.endedAt,
        seq: i * 2 + 1,
        event: {
          kind: 'session_ended',
          sessionId: s.id,
          endedAt: s.endedAt,
          exitCode: s.exitCode,
        },
      });
    }
  }

  for (let i = 0; i < input.prepostRuns.length; i++) {
    const p = input.prepostRuns[i];
    if (!p.endedAt) continue;
    interleaved.push({
      ts: p.endedAt,
      seq: 1_000_000 + i,
      event: {
        kind: 'prepost_ended',
        stageId: p.stage,
        itemId: normalizeItemId(p.stage, p.itemId),
        phase: p.phase,
        when: p.when,
        commandName: p.commandName,
        prepostRunId: prepostRunId(p.sessionId, p.when, p.commandName, p.startedAt),
        actionTaken: actionValueToResolved(p.actionTaken),
      },
    });
  }

  interleaved.sort((a, b) => {
    if (a.ts < b.ts) return -1;
    if (a.ts > b.ts) return 1;
    return a.seq - b.seq;
  });
  for (const ev of interleaved) events.push(ev.event);

  for (const it of input.items) {
    events.push({
      kind: 'item_state',
      stageId: it.stageId,
      itemId: it.id,
      status: it.status,
      currentPhase: it.currentPhase,
    });
  }

  if (input.workflowStatus) {
    events.push({ kind: 'workflow_status', status: input.workflowStatus });
  }

  return events;
}

export function prepostRunId(
  sessionId: string | null,
  when: 'pre' | 'post',
  commandName: string,
  startedAt: string,
): string {
  return `run:${sessionId ?? '_'}:${when}:${commandName}:${startedAt}`;
}

function actionValueToResolved(v: ActionValue | null): ResolvedAction | null {
  if (v === null) return null;
  if (v === 'continue') return { kind: 'continue' };
  if (v === 'stop-and-ask') return { kind: 'stop-and-ask' };
  if (v === 'stop') return { kind: 'stop' };
  if (typeof v === 'object' && 'goto' in v) {
    return { kind: 'goto', goto: v.goto, maxRevisits: v.max_revisits };
  }
  if (typeof v === 'object' && 'retry' in v) {
    return { kind: 'retry', retry: { mode: v.retry.mode, max: v.retry.max } };
  }
  if (typeof v === 'object' && 'fail' in v) {
    return { kind: 'fail', failReason: v.fail.reason };
  }
  return null;
}
