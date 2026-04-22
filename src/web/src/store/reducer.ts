/**
 * Normalized render-model reducer.
 *
 * Pure function: (RenderModelState, ServerFrame) => RenderModelState.
 * No React imports; no side effects.
 *
 * Block types produced: TextBlock, ToolCallBlock, ThinkingBlock,
 * SystemNoticeBlock (session events, prepost, stream.system_notice),
 * TruncatedSentinel (eviction marker prepended by getSessionBlocks when
 * _evictedCount > 0).
 *
 * Invariants:
 * - 10,000 block cap per session. Eviction is O(1) — BlockRing advances a
 *   head pointer; NO Array.shift() or physical element moves.
 * - _blockMap maps blockId → physical ring index for O(1) lookup (TextBlock
 *   delta accumulation, ToolCall result matching keyed on toolUseId since
 *   ToolCallBlock.blockId === toolUseId).
 * - Stale _blockMap entries (evicted slots) are detected via ring.isLive().
 * - session.ended freezes the session; no further block mutations.
 * - Orphan tool_result or prepost.command.ended sets needsSnapshot.
 */

import { BlockRing } from './blockRing';
import type {
  RenderModelState,
  SessionRenderState,
  RenderBlock,
  TextBlock,
  ToolCallBlock,
  ThinkingBlock,
  SystemNoticeBlock,
  InitialPromptBlock,
  TruncatedSentinel,
} from './types';
import type {
  ServerFrame,
  StreamInitialPrompt,
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

export const MAX_BLOCKS = 10_000;

// ---------------------------------------------------------------------------
// Sentinel factory (stable blockId per session)
// ---------------------------------------------------------------------------

export function createSentinel(sessionId: string): TruncatedSentinel {
  return {
    type: 'truncated_sentinel',
    blockId: `sentinel-${sessionId}`,
    sessionId,
    oldestEvictedSeq: 0,
  };
}

// ---------------------------------------------------------------------------
// Session factory / helpers
// ---------------------------------------------------------------------------

export function createInitialState(): RenderModelState {
  return { sessions: new Map() };
}

function emptySession(sessionId: string): SessionRenderState {
  return {
    sessionId,
    phase: null,
    _ring: new BlockRing(MAX_BLOCKS),
    _blockMap: new Map(),
    _evictedCount: 0,
    _prependedBlocks: [],
    frozen: false,
    needsSnapshot: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  };
}

function getSession(state: RenderModelState, sessionId: string): SessionRenderState | undefined {
  return state.sessions.get(sessionId);
}

function setSession(state: RenderModelState, session: SessionRenderState): RenderModelState {
  const sessions = new Map(state.sessions);
  sessions.set(session.sessionId, session);
  return { sessions };
}

/**
 * Push a block onto the session's ring.
 *
 * Clones the ring (O(MAX_BLOCKS)) and the blockMap, pushes the new block
 * (O(1) ring operation), and registers it in the blockMap. Returns the
 * updated session.
 *
 * Eviction is O(1) — the ring advances its head pointer; no physical array
 * element is moved. _evictedCount is incremented whenever a block is lost.
 */
function pushBlock(session: SessionRenderState, block: RenderBlock): SessionRenderState {
  const ring = session._ring.clone();
  const { physIdx, evicted } = ring.push(block);

  const blockMap = new Map(session._blockMap);
  // Register the new block's physical index for O(1) future lookups.
  blockMap.set(block.blockId, physIdx);

  // If a block was evicted, its blockMap entry is now stale — remove it.
  if (evicted !== null) {
    blockMap.delete(evicted.blockId);
  }

  return {
    ...session,
    _ring: ring,
    _blockMap: blockMap,
    _evictedCount: evicted !== null ? session._evictedCount + 1 : session._evictedCount,
  };
}

/**
 * Look up a block by blockId. Returns the physical index and current block,
 * or null if the block has been evicted or never existed.
 *
 * O(1) — uses the _blockMap, not a linear scan.
 */
function findBlock(
  session: SessionRenderState,
  blockId: string,
): { physIdx: number; block: RenderBlock } | null {
  const physIdx = session._blockMap.get(blockId);
  if (physIdx === undefined) return null;
  if (!session._ring.isLive(physIdx)) return null;
  const block = session._ring.getPhys(physIdx);
  if (block === null) return null;
  // Validate that the slot hasn't been recycled for a different block.
  if (block.blockId !== blockId) return null;
  return { physIdx, block };
}

/**
 * Update a block in-place (by physical index) after cloning the ring.
 */
function updateBlock(
  session: SessionRenderState,
  physIdx: number,
  updated: RenderBlock,
): SessionRenderState {
  const ring = session._ring.clone();
  ring.setPhys(physIdx, updated);
  return { ...session, _ring: ring };
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
      const notice: SystemNoticeBlock = {
        type: 'system_notice',
        blockId: `session-started-${sid}`,
        sessionId: sid,
        severity: 'info',
        source: 'session',
        message: `Session started — phase: ${p.phase}, attempt: ${p.attempt}`,
      };
      // Preserve _prependedBlocks from any pre-existing session (e.g. a
      // stream.initial_prompt that arrived before session.started in historical
      // replay). Ring/blockMap are still reset because session.started marks a
      // fresh run.
      const existing = getSession(state, sid);
      const base: SessionRenderState = {
        ...emptySession(sid),
        _prependedBlocks: existing?._prependedBlocks ?? [],
      };
      const session = pushBlock({ ...base, phase: p.phase }, notice);
      return setSession(state, session);
    }

    // -----------------------------------------------------------------------
    case 'session.ended': {
      const p = frame.payload as SessionEndedPayload;
      const existing = getSession(state, p.sessionId);
      if (!existing) return state;
      const notice: SystemNoticeBlock = {
        type: 'system_notice',
        blockId: `session-ended-${p.sessionId}`,
        sessionId: p.sessionId,
        severity: p.reason === 'ok' ? 'info' : 'warn',
        source: 'session',
        message: `Session ended — reason: ${p.reason}, exit: ${p.exitCode ?? 'null'}`,
      };
      const updated = pushBlock(existing, notice);
      return setSession(state, { ...updated, frozen: true });
    }

    // -----------------------------------------------------------------------
    case 'stream.initial_prompt': {
      const p = frame.payload as StreamInitialPrompt;
      const sid = sessionId ?? p.sessionId;
      if (!sid) return state;
      const session = getSession(state, sid) ?? emptySession(sid);
      const blockId = `initial-prompt-${sid}`;
      // Idempotent: historical replay fetches the same log page multiple times.
      if (session._prependedBlocks.some((b) => b.blockId === blockId)) return state;
      const block: InitialPromptBlock = {
        type: 'initial_prompt',
        blockId,
        sessionId: sid,
        prompt: p.prompt,
        assembledAt: p.assembledAt,
      };
      const updated: SessionRenderState = {
        ...session,
        _prependedBlocks: [block, ...session._prependedBlocks],
      };
      return setSession(state, updated);
    }

    // -----------------------------------------------------------------------
    case 'stream.text': {
      if (!sessionId) return state;
      const p = frame.payload as StreamText;
      const session = getSession(state, sessionId) ?? emptySession(sessionId);
      if (session.frozen) return state;

      const found = findBlock(session, p.blockId);
      if (found) {
        const existing = found.block as TextBlock;
        if (existing.frozen) return state; // drop delta after final
        const updated: TextBlock = {
          ...existing,
          text: existing.text + p.textDelta,
          frozen: p.final ?? false,
        };
        return setSession(state, updateBlock(session, found.physIdx, updated));
      } else {
        const block: TextBlock = {
          type: 'text',
          blockId: p.blockId,
          sessionId,
          text: p.textDelta,
          frozen: p.final ?? false,
        };
        return setSession(state, pushBlock(session, block));
      }
    }

    // -----------------------------------------------------------------------
    case 'stream.thinking': {
      if (!sessionId) return state;
      const p = frame.payload as StreamThinking;
      const session = getSession(state, sessionId) ?? emptySession(sessionId);
      if (session.frozen) return state;

      const found = findBlock(session, p.blockId);
      if (found) {
        const existing = found.block as ThinkingBlock;
        if (existing.frozen) return state;
        const updated: ThinkingBlock = {
          ...existing,
          text: existing.text + p.textDelta,
          frozen: p.final ?? false,
        };
        return setSession(state, updateBlock(session, found.physIdx, updated));
      } else {
        const block: ThinkingBlock = {
          type: 'thinking',
          blockId: p.blockId,
          sessionId,
          text: p.textDelta,
          frozen: p.final ?? false,
          collapsed: true,
        };
        return setSession(state, pushBlock(session, block));
      }
    }

    // -----------------------------------------------------------------------
    case 'stream.tool_use': {
      if (!sessionId) return state;
      const p = frame.payload as StreamToolUse;
      const session = getSession(state, sessionId) ?? emptySession(sessionId);
      if (session.frozen) return state;

      const block: ToolCallBlock = {
        type: 'tool_call',
        // blockId === toolUseId — required for O(1) Map lookup in tool_result.
        blockId: p.toolUseId,
        sessionId,
        toolUseId: p.toolUseId,
        name: p.name,
        input: p.input,
        status: p.status,
      };
      return setSession(state, pushBlock(session, block));
    }

    // -----------------------------------------------------------------------
    case 'stream.tool_result': {
      if (!sessionId) return state;
      const p = frame.payload as StreamToolResult;
      const session = getSession(state, sessionId);
      if (!session || session.frozen) return state;

      // O(1) lookup via _blockMap (toolUseId === blockId for ToolCallBlock).
      const found = findBlock(session, p.toolUseId);
      if (found) {
        const existing = found.block as ToolCallBlock;
        const updated: ToolCallBlock = { ...existing, status: p.status, output: p.output };
        return setSession(state, updateBlock(session, found.physIdx, updated));
      } else {
        // Orphan tool_result — set needsSnapshot.
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

      const block: SystemNoticeBlock = {
        type: 'system_notice',
        blockId: `notice-${sid}-${frame.seq}`,
        sessionId: sid,
        severity: p.severity,
        source: p.source,
        message: p.message,
        extra: p.extra,
      };
      return setSession(state, pushBlock(session, block));
    }

    // -----------------------------------------------------------------------
    case 'stage.started': {
      // stage.started has no sessionId — broadcast to all active sessions.
      const p = frame.payload as StageStartedPayload;
      const msg = `Stage started: ${p.stageId} (${p.run}${p.itemCount !== undefined ? `, ${p.itemCount} items` : ''})`;
      let next = state;
      for (const [sid, session] of state.sessions) {
        if (session.frozen) continue;
        const block: SystemNoticeBlock = {
          type: 'system_notice',
          blockId: `stage-started-${p.stageId}-${sid}`,
          sessionId: sid,
          severity: 'info',
          source: 'harness',
          message: msg,
        };
        next = setSession(next, pushBlock(session, block));
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
        const block: SystemNoticeBlock = {
          type: 'system_notice',
          blockId: `stage-complete-${p.stageId}-${sid}`,
          sessionId: sid,
          severity: 'info',
          source: 'harness',
          message: msg,
        };
        next = setSession(next, pushBlock(session, block));
      }
      return next;
    }

    // -----------------------------------------------------------------------
    case 'prepost.command.started': {
      if (!sessionId) return state;
      const p = frame.payload as PrepostCommandStarted;
      const session = getSession(state, sessionId) ?? emptySession(sessionId);
      if (session.frozen) return state;

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
      return setSession(state, pushBlock(session, block));
    }

    // -----------------------------------------------------------------------
    case 'prepost.command.output': {
      if (!sessionId) return state;
      const p = frame.payload as PrepostCommandOutput;
      const session = getSession(state, sessionId);
      if (!session || session.frozen) return state;

      const found = findBlock(session, `prepost-${p.runId}`);
      if (!found) return state; // orphan output — drop silently

      const existing = found.block as SystemNoticeBlock;
      const updated: SystemNoticeBlock = {
        ...existing,
        outputChunks: [...(existing.outputChunks ?? []), { stream: p.stream, chunk: p.chunk }],
      };
      return setSession(state, updateBlock(session, found.physIdx, updated));
    }

    // -----------------------------------------------------------------------
    case 'prepost.command.ended': {
      if (!sessionId) return state;
      const p = frame.payload as PrepostCommandEnded;
      const session = getSession(state, sessionId);
      if (!session || session.frozen) return state;

      const found = findBlock(session, `prepost-${p.runId}`);
      if (!found) {
        // Orphan ended — set needsSnapshot.
        return setSession(state, { ...session, needsSnapshot: true });
      }
      const existing = found.block as SystemNoticeBlock;
      const updated: SystemNoticeBlock = {
        ...existing,
        exitCode: p.exitCode,
        action: p.action,
        prepostFinalized: true,
        severity: p.exitCode === 0 ? 'info' : 'warn',
      };
      return setSession(state, updateBlock(session, found.physIdx, updated));
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/**
 * Materialise the live blocks for a session.
 *
 * If blocks have been evicted (_evictedCount > 0), a TruncatedSentinel is
 * prepended to signal that older content is available via the HTTP log API.
 *
 * O(n) — only call at render time.
 */
export function getSessionBlocks(state: RenderModelState, sessionId: string): readonly RenderBlock[] {
  const session = state.sessions.get(sessionId);
  if (!session) return [];
  const ringBlocks = session._ring.toArray();
  const prepended = session._prependedBlocks;
  if (session._evictedCount > 0) {
    // Order: sentinel → prepended (already-loaded earlier content) → ring.
    // Sentinel stays at index 0 so LiveStreamPane.loadEarlier can find it via
    // blocks[0].type === 'truncated_sentinel'.
    return [createSentinel(session.sessionId), ...prepended, ...ringBlocks];
  }
  return [...prepended, ...ringBlocks];
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
