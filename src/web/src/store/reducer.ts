/**
 * Normalized render-model reducer.
 *
 * Pure function: (RenderModelState, ServerFrame) => RenderModelState.
 * No React imports; no side effects.
 *
 * Block types produced: TextBlock, ToolCallBlock, ThinkingBlock,
 * SystemNoticeBlock (session events, prepost, stream.system_notice),
 * TruncatedSentinel (eviction marker).
 *
 * Invariants:
 * - 10,000 block cap per session: oldest evicted, sentinel inserted at head.
 * - Eviction is O(1): single array shift + conditional unshift.
 * - session.ended freezes the session; no further block mutations.
 * - Orphan tool_result or prepost.command.ended sets needsSnapshot.
 * - ToolCall lookup uses toolUseId, not array index (O(n) scan but bounded by cap).
 */

import type {
  RenderModelState,
  SessionRenderState,
  RenderBlock,
  TextBlock,
  ToolCallBlock,
  ThinkingBlock,
  SystemNoticeBlock,
  TruncatedSentinel,
} from './types';
import type {
  ServerFrame,
  StreamText,
  StreamThinking,
  StreamToolUse,
  StreamToolResult,
  StreamUsage,
  StreamSystemNotice,
  SessionStartedPayload,
  SessionEndedPayload,
  StageStartedPayload,
  StageCompletePayload,
  PrepostCommandStarted,
  PrepostCommandOutput,
  PrepostCommandEnded,
} from '../ws/types';

const MAX_BLOCKS = 10_000;

let _sentinelSeq = 0;
function newSentinelId(sessionId: string): string {
  return `sentinel-${sessionId}-${_sentinelSeq++}`;
}

export function createInitialState(): RenderModelState {
  return { sessions: new Map() };
}

// ---------------------------------------------------------------------------
// Helpers for immutable session mutation
// ---------------------------------------------------------------------------

function getSession(state: RenderModelState, sessionId: string): SessionRenderState | undefined {
  return state.sessions.get(sessionId);
}

function emptySession(sessionId: string): SessionRenderState {
  return {
    sessionId,
    blocks: [],
    frozen: false,
    needsSnapshot: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  };
}

function withBlocks(session: SessionRenderState, blocks: RenderBlock[]): SessionRenderState {
  return { ...session, blocks };
}

/** Push block onto mutable blocks array, enforcing MAX_BLOCKS cap. */
function pushBlock(blocks: RenderBlock[], block: RenderBlock, sessionId: string): void {
  blocks.push(block);
  if (blocks.length > MAX_BLOCKS) {
    blocks.shift();
    if (blocks[0]?.type !== 'truncated_sentinel') {
      const sentinel: TruncatedSentinel = {
        type: 'truncated_sentinel',
        blockId: newSentinelId(sessionId),
        sessionId,
        oldestEvictedSeq: 0,
      };
      blocks.unshift(sentinel);
    }
  }
}

function setSession(state: RenderModelState, session: SessionRenderState): RenderModelState {
  const sessions = new Map(state.sessions);
  sessions.set(session.sessionId, session);
  return { sessions };
}

// ---------------------------------------------------------------------------
// Main reducer
// ---------------------------------------------------------------------------

export function applyFrame(state: RenderModelState, frame: ServerFrame): RenderModelState {
  const { sessionId } = frame;

  switch (frame.type) {
    // -----------------------------------------------------------------------
    case 'session.started': {
      const p = frame.payload as SessionStartedPayload;
      const sid = p.sessionId;
      const blocks: RenderBlock[] = [];
      const notice: SystemNoticeBlock = {
        type: 'system_notice',
        blockId: `session-started-${sid}`,
        sessionId: sid,
        severity: 'info',
        source: 'session',
        message: `Session started — phase: ${p.phase}, attempt: ${p.attempt}`,
      };
      blocks.push(notice);
      const session: SessionRenderState = {
        sessionId: sid,
        blocks,
        frozen: false,
        needsSnapshot: false,
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      };
      return setSession(state, session);
    }

    // -----------------------------------------------------------------------
    case 'session.ended': {
      const p = frame.payload as SessionEndedPayload;
      const existing = getSession(state, p.sessionId);
      if (!existing) return state;
      const blocks = [...existing.blocks];
      const notice: SystemNoticeBlock = {
        type: 'system_notice',
        blockId: `session-ended-${p.sessionId}`,
        sessionId: p.sessionId,
        severity: p.reason === 'ok' ? 'info' : 'warn',
        source: 'session',
        message: `Session ended — reason: ${p.reason}, exit: ${p.exitCode ?? 'null'}`,
      };
      blocks.push(notice);
      return setSession(state, { ...existing, blocks, frozen: true });
    }

    // -----------------------------------------------------------------------
    case 'stream.text': {
      if (!sessionId) return state;
      const p = frame.payload as StreamText;
      const session = getSession(state, sessionId) ?? emptySession(sessionId);
      if (session.frozen) return state;

      const blocks = [...session.blocks];
      const idx = blocks.findIndex((b) => b.type === 'text' && b.blockId === p.blockId);
      if (idx >= 0) {
        const existing = blocks[idx] as TextBlock;
        if (existing.frozen) return state; // drop delta after final
        blocks[idx] = { ...existing, text: existing.text + p.textDelta, frozen: p.final ?? false };
      } else {
        const block: TextBlock = {
          type: 'text',
          blockId: p.blockId,
          sessionId,
          text: p.textDelta,
          frozen: p.final ?? false,
        };
        pushBlock(blocks, block, sessionId);
      }
      return setSession(state, withBlocks(session, blocks));
    }

    // -----------------------------------------------------------------------
    case 'stream.thinking': {
      if (!sessionId) return state;
      const p = frame.payload as StreamThinking;
      const session = getSession(state, sessionId) ?? emptySession(sessionId);
      if (session.frozen) return state;

      const blocks = [...session.blocks];
      const idx = blocks.findIndex((b) => b.type === 'thinking' && b.blockId === p.blockId);
      if (idx >= 0) {
        const existing = blocks[idx] as ThinkingBlock;
        if (existing.frozen) return state;
        blocks[idx] = { ...existing, text: existing.text + p.textDelta, frozen: p.final ?? false };
      } else {
        const block: ThinkingBlock = {
          type: 'thinking',
          blockId: p.blockId,
          sessionId,
          text: p.textDelta,
          frozen: p.final ?? false,
          collapsed: true,
        };
        pushBlock(blocks, block, sessionId);
      }
      return setSession(state, withBlocks(session, blocks));
    }

    // -----------------------------------------------------------------------
    case 'stream.tool_use': {
      if (!sessionId) return state;
      const p = frame.payload as StreamToolUse;
      const session = getSession(state, sessionId) ?? emptySession(sessionId);
      if (session.frozen) return state;

      const blocks = [...session.blocks];
      const block: ToolCallBlock = {
        type: 'tool_call',
        blockId: p.toolUseId,
        sessionId,
        toolUseId: p.toolUseId,
        name: p.name,
        input: p.input,
        status: p.status,
      };
      pushBlock(blocks, block, sessionId);
      return setSession(state, withBlocks(session, blocks));
    }

    // -----------------------------------------------------------------------
    case 'stream.tool_result': {
      if (!sessionId) return state;
      const p = frame.payload as StreamToolResult;
      const session = getSession(state, sessionId);
      if (!session || session.frozen) return state;

      const blocks = [...session.blocks];
      const idx = blocks.findIndex(
        (b) => b.type === 'tool_call' && (b as ToolCallBlock).toolUseId === p.toolUseId,
      );
      if (idx >= 0) {
        const existing = blocks[idx] as ToolCallBlock;
        blocks[idx] = { ...existing, status: p.status, output: p.output };
        return setSession(state, withBlocks(session, blocks));
      } else {
        // Orphan tool_result — set needsSnapshot
        return setSession(state, { ...session, needsSnapshot: true });
      }
    }

    // -----------------------------------------------------------------------
    case 'stream.usage': {
      if (!sessionId) return state;
      const p = frame.payload as StreamUsage;
      const session = getSession(state, sessionId) ?? emptySession(sessionId);
      return setSession(state, {
        ...session,
        usage: {
          inputTokens: p.inputTokens,
          outputTokens: p.outputTokens,
          cacheCreationInputTokens: p.cacheCreationInputTokens,
          cacheReadInputTokens: p.cacheReadInputTokens,
        },
      });
    }

    // -----------------------------------------------------------------------
    case 'stream.system_notice': {
      const p = frame.payload as StreamSystemNotice;
      const sid = sessionId ?? p.sessionId;
      if (!sid) return state;
      const session = getSession(state, sid) ?? emptySession(sid);
      if (session.frozen) return state;

      const blocks = [...session.blocks];
      const block: SystemNoticeBlock = {
        type: 'system_notice',
        blockId: `notice-${sid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        sessionId: sid,
        severity: p.severity,
        source: p.source,
        message: p.message,
        extra: p.extra,
      };
      pushBlock(blocks, block, sid);
      return setSession(state, withBlocks(session, blocks));
    }

    // -----------------------------------------------------------------------
    case 'stage.started': {
      // stage.started has no sessionId — we synthesize a global notice.
      // Since there's no target session, we record it on all active sessions.
      const p = frame.payload as StageStartedPayload;
      const msg = `Stage started: ${p.stageId} (${p.run}${p.itemCount !== undefined ? `, ${p.itemCount} items` : ''})`;
      let next = state;
      for (const [sid, session] of state.sessions) {
        if (session.frozen) continue;
        const blocks = [...session.blocks];
        const block: SystemNoticeBlock = {
          type: 'system_notice',
          blockId: `stage-started-${p.stageId}-${sid}`,
          sessionId: sid,
          severity: 'info',
          source: 'harness',
          message: msg,
        };
        pushBlock(blocks, block, sid);
        next = setSession(next, withBlocks(session, blocks));
      }
      return next;
    }

    // -----------------------------------------------------------------------
    case 'stage.complete': {
      const p = frame.payload as StageCompletePayload;
      const summary = p.itemSummary
        ? ` (complete: ${p.itemSummary.complete}, blocked: ${p.itemSummary.blocked}, abandoned: ${p.itemSummary.abandoned})`
        : '';
      const msg = `Stage complete: ${p.stageId}${p.nextStageId ? ` → ${p.nextStageId}` : ' (final)'}${p.needsApproval ? ' — approval required' : ''}${summary}`;
      let next = state;
      for (const [sid, session] of state.sessions) {
        if (session.frozen) continue;
        const blocks = [...session.blocks];
        const block: SystemNoticeBlock = {
          type: 'system_notice',
          blockId: `stage-complete-${p.stageId}-${sid}`,
          sessionId: sid,
          severity: 'info',
          source: 'harness',
          message: msg,
        };
        pushBlock(blocks, block, sid);
        next = setSession(next, withBlocks(session, blocks));
      }
      return next;
    }

    // -----------------------------------------------------------------------
    case 'prepost.command.started': {
      if (!sessionId) return state;
      const p = frame.payload as PrepostCommandStarted;
      const session = getSession(state, sessionId) ?? emptySession(sessionId);
      if (session.frozen) return state;

      const blocks = [...session.blocks];
      const block: SystemNoticeBlock = {
        type: 'system_notice',
        blockId: `prepost-${p.runId}`,
        sessionId,
        severity: 'info',
        source: 'hook',
        message: `${p.when === 'pre' ? 'Pre' : 'Post'}-command: ${p.name} (phase: ${p.phase})`,
        runId: p.runId,
        outputChunks: [],
        prepostFinalized: false,
      };
      pushBlock(blocks, block, sessionId);
      return setSession(state, withBlocks(session, blocks));
    }

    // -----------------------------------------------------------------------
    case 'prepost.command.output': {
      if (!sessionId) return state;
      const p = frame.payload as PrepostCommandOutput;
      const session = getSession(state, sessionId);
      if (!session || session.frozen) return state;

      const blocks = [...session.blocks];
      const idx = blocks.findIndex(
        (b) => b.type === 'system_notice' && (b as SystemNoticeBlock).runId === p.runId,
      );
      if (idx < 0) return state; // orphan output — drop silently

      const existing = blocks[idx] as SystemNoticeBlock;
      blocks[idx] = {
        ...existing,
        outputChunks: [...(existing.outputChunks ?? []), { stream: p.stream, chunk: p.chunk }],
      };
      return setSession(state, withBlocks(session, blocks));
    }

    // -----------------------------------------------------------------------
    case 'prepost.command.ended': {
      if (!sessionId) return state;
      const p = frame.payload as PrepostCommandEnded;
      const session = getSession(state, sessionId);
      if (!session || session.frozen) return state;

      const blocks = [...session.blocks];
      const idx = blocks.findIndex(
        (b) => b.type === 'system_notice' && (b as SystemNoticeBlock).runId === p.runId,
      );
      if (idx < 0) {
        // Orphan ended — set needsSnapshot
        return setSession(state, { ...session, needsSnapshot: true });
      }
      const existing = blocks[idx] as SystemNoticeBlock;
      blocks[idx] = {
        ...existing,
        exitCode: p.exitCode,
        action: p.action,
        prepostFinalized: true,
        severity: p.exitCode === 0 ? 'info' : 'warn',
        message: existing.message + ` — exit ${p.exitCode}`,
      };
      return setSession(state, withBlocks(session, blocks));
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export function getSessionBlocks(state: RenderModelState, sessionId: string): readonly RenderBlock[] {
  return state.sessions.get(sessionId)?.blocks ?? [];
}

export function getSessionUsage(state: RenderModelState, sessionId: string) {
  return state.sessions.get(sessionId)?.usage ?? null;
}

export function getTotalUsage(state: RenderModelState) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;
  for (const session of state.sessions.values()) {
    inputTokens += session.usage.inputTokens;
    outputTokens += session.usage.outputTokens;
    cacheCreationInputTokens += session.usage.cacheCreationInputTokens;
    cacheReadInputTokens += session.usage.cacheReadInputTokens;
  }
  return { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens };
}
