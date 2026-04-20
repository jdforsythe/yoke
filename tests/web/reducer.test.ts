/**
 * Unit tests for the normalized render-model reducer.
 *
 * Covers all 10 acceptance criteria from feat-render-reducer:
 *  AC-1  stream.text deltas accumulate into a single TextBlock.text string
 *  AC-2  TextBlock with final:true is frozen; subsequent deltas dropped
 *  AC-3  stream.tool_use creates ToolCall pending; stream.tool_result updates status
 *  AC-4  Orphan tool_result sets needsSnapshot
 *  AC-5  session.ended freezes session; subsequent stream frames rejected
 *  AC-6  stream.system_notice produces SystemNotice with correct severity and source
 *  AC-7  10,000-block cap; block 10,001 evicts oldest; sentinel prepended
 *  AC-8  stream.usage updates per-session usage accumulator
 *  AC-9  stage.started produces SystemNotice info/harness with stage ID, run mode, item count
 *  AC-10 stage.complete produces SystemNotice info showing stage ID, next stage, needsApproval, summary
 */

import { describe, it, expect } from 'vitest';
import {
  applyFrame,
  createInitialState,
  getSessionBlocks,
  getSessionUsage,
  MAX_BLOCKS,
} from '../../src/web/src/store/reducer';
import type { RenderModelState, TextBlock, ToolCallBlock, ThinkingBlock, SystemNoticeBlock } from '../../src/web/src/store/types';
import type { ServerFrame } from '../../src/web/src/ws/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkFrame<T>(
  type: string,
  payload: T,
  opts: { sessionId?: string; seq?: number } = {},
): ServerFrame {
  return {
    v: 1,
    type: type as ServerFrame['type'],
    sessionId: opts.sessionId,
    seq: opts.seq ?? 0,
    ts: new Date().toISOString(),
    payload,
  };
}

const SID = 'sess-abc';

/** Initialise a session via session.started so downstream frames have a home. */
function startSession(
  state: RenderModelState,
  sessionId: string = SID,
  phase = 'implement',
): RenderModelState {
  return applyFrame(
    state,
    mkFrame('session.started', { sessionId, phase, attempt: 1, startedAt: new Date().toISOString() }),
  );
}

// ---------------------------------------------------------------------------
// AC-1 — text delta accumulation
// ---------------------------------------------------------------------------

describe('AC-1: stream.text delta accumulation', () => {
  it('accumulates deltas with the same blockId into a single TextBlock.text', () => {
    let state = createInitialState();
    state = startSession(state);

    state = applyFrame(state, mkFrame('stream.text', { sessionId: SID, blockId: 'b1', textDelta: 'Hello' }, { sessionId: SID }));
    state = applyFrame(state, mkFrame('stream.text', { sessionId: SID, blockId: 'b1', textDelta: ', world' }, { sessionId: SID }));

    const blocks = getSessionBlocks(state, SID);
    const textBlock = blocks.find(b => b.type === 'text') as TextBlock | undefined;

    expect(textBlock).toBeDefined();
    expect(textBlock!.text).toBe('Hello, world');
  });

  it('creates separate TextBlocks for different blockIds', () => {
    let state = createInitialState();
    state = startSession(state);

    state = applyFrame(state, mkFrame('stream.text', { sessionId: SID, blockId: 'b1', textDelta: 'A' }, { sessionId: SID }));
    state = applyFrame(state, mkFrame('stream.text', { sessionId: SID, blockId: 'b2', textDelta: 'B' }, { sessionId: SID }));

    const blocks = getSessionBlocks(state, SID);
    const textBlocks = blocks.filter(b => b.type === 'text') as TextBlock[];

    expect(textBlocks).toHaveLength(2);
    expect(textBlocks.map(b => b.text).sort()).toEqual(['A', 'B']);
  });
});

// ---------------------------------------------------------------------------
// AC-2 — frozen TextBlock drops further deltas
// ---------------------------------------------------------------------------

describe('AC-2: TextBlock frozen on final:true', () => {
  it('marks the block frozen when final:true is received', () => {
    let state = createInitialState();
    state = startSession(state);

    state = applyFrame(state, mkFrame('stream.text', { sessionId: SID, blockId: 'b1', textDelta: 'Hi', final: true }, { sessionId: SID }));

    const blocks = getSessionBlocks(state, SID);
    const textBlock = blocks.find(b => b.type === 'text') as TextBlock | undefined;

    expect(textBlock!.frozen).toBe(true);
  });

  it('drops subsequent deltas after final:true (text not concatenated)', () => {
    let state = createInitialState();
    state = startSession(state);

    state = applyFrame(state, mkFrame('stream.text', { sessionId: SID, blockId: 'b1', textDelta: 'Hi', final: true }, { sessionId: SID }));
    state = applyFrame(state, mkFrame('stream.text', { sessionId: SID, blockId: 'b1', textDelta: ' extra' }, { sessionId: SID }));

    const blocks = getSessionBlocks(state, SID);
    const textBlock = blocks.find(b => b.type === 'text') as TextBlock | undefined;

    expect(textBlock!.text).toBe('Hi');
  });
});

// ---------------------------------------------------------------------------
// AC-3 — ToolCall creation and result matching
// ---------------------------------------------------------------------------

describe('AC-3: stream.tool_use / stream.tool_result', () => {
  it('creates a ToolCallBlock with status pending on stream.tool_use', () => {
    let state = createInitialState();
    state = startSession(state);

    state = applyFrame(state, mkFrame(
      'stream.tool_use',
      { sessionId: SID, toolUseId: 'tu1', name: 'bash', input: { cmd: 'ls' }, status: 'pending' },
      { sessionId: SID },
    ));

    const blocks = getSessionBlocks(state, SID);
    const toolBlock = blocks.find(b => b.type === 'tool_call') as ToolCallBlock | undefined;

    expect(toolBlock).toBeDefined();
    expect(toolBlock!.status).toBe('pending');
    expect(toolBlock!.name).toBe('bash');
    expect(toolBlock!.toolUseId).toBe('tu1');
  });

  it('updates ToolCallBlock to ok status with output on matching stream.tool_result', () => {
    let state = createInitialState();
    state = startSession(state);

    state = applyFrame(state, mkFrame('stream.tool_use', { sessionId: SID, toolUseId: 'tu1', name: 'bash', input: {}, status: 'pending' }, { sessionId: SID }));
    state = applyFrame(state, mkFrame('stream.tool_result', { sessionId: SID, toolUseId: 'tu1', status: 'ok', output: 'file.txt' }, { sessionId: SID }));

    const blocks = getSessionBlocks(state, SID);
    const toolBlock = blocks.find(b => b.type === 'tool_call') as ToolCallBlock | undefined;

    expect(toolBlock!.status).toBe('ok');
    expect(toolBlock!.output).toBe('file.txt');
  });

  it('updates ToolCallBlock to error status on stream.tool_result with status error', () => {
    let state = createInitialState();
    state = startSession(state);

    state = applyFrame(state, mkFrame('stream.tool_use', { sessionId: SID, toolUseId: 'tu2', name: 'read_file', input: {}, status: 'running' }, { sessionId: SID }));
    state = applyFrame(state, mkFrame('stream.tool_result', { sessionId: SID, toolUseId: 'tu2', status: 'error', output: 'not found' }, { sessionId: SID }));

    const blocks = getSessionBlocks(state, SID);
    const toolBlock = blocks.find(b => b.type === 'tool_call') as ToolCallBlock | undefined;

    expect(toolBlock!.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// AC-4 — orphan tool_result sets needsSnapshot
// ---------------------------------------------------------------------------

describe('AC-4: orphan stream.tool_result sets needsSnapshot', () => {
  it('sets needsSnapshot when tool_result arrives without a preceding tool_use', () => {
    let state = createInitialState();
    state = startSession(state);

    state = applyFrame(state, mkFrame(
      'stream.tool_result',
      { sessionId: SID, toolUseId: 'no-such-tool', status: 'ok', output: null },
      { sessionId: SID },
    ));

    const session = state.sessions.get(SID);
    expect(session!.needsSnapshot).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-5 — session.ended freezes session
// ---------------------------------------------------------------------------

describe('AC-5: session.ended freezes session', () => {
  it('marks the session frozen after session.ended', () => {
    let state = createInitialState();
    state = startSession(state);

    state = applyFrame(state, mkFrame('session.ended', {
      sessionId: SID,
      endedAt: new Date().toISOString(),
      exitCode: 0,
      statusFlags: {},
      reason: 'ok',
    }));

    const session = state.sessions.get(SID);
    expect(session!.frozen).toBe(true);
  });

  it('rejects subsequent stream.text frames after session.ended', () => {
    let state = createInitialState();
    state = startSession(state);

    // Add one text block before ending.
    state = applyFrame(state, mkFrame('stream.text', { sessionId: SID, blockId: 'b1', textDelta: 'before' }, { sessionId: SID }));

    // End session.
    state = applyFrame(state, mkFrame('session.ended', {
      sessionId: SID,
      endedAt: new Date().toISOString(),
      exitCode: 0,
      statusFlags: {},
      reason: 'ok',
    }));

    const blockCountAfterEnd = getSessionBlocks(state, SID).length;

    // Attempt to push another text frame — must be rejected.
    state = applyFrame(state, mkFrame('stream.text', { sessionId: SID, blockId: 'b2', textDelta: 'after' }, { sessionId: SID }));

    expect(getSessionBlocks(state, SID)).toHaveLength(blockCountAfterEnd);
  });

  it('rejects stream.tool_use frames after session.ended', () => {
    let state = createInitialState();
    state = startSession(state);

    state = applyFrame(state, mkFrame('session.ended', {
      sessionId: SID, endedAt: new Date().toISOString(), exitCode: 0, statusFlags: {}, reason: 'ok',
    }));

    const before = getSessionBlocks(state, SID).length;

    state = applyFrame(state, mkFrame('stream.tool_use', { sessionId: SID, toolUseId: 'tu99', name: 'x', input: {}, status: 'pending' }, { sessionId: SID }));

    expect(getSessionBlocks(state, SID)).toHaveLength(before);
  });
});

// ---------------------------------------------------------------------------
// AC-6 — stream.system_notice severity and source mapping
// ---------------------------------------------------------------------------

describe('AC-6: stream.system_notice produces SystemNotice with correct severity/source', () => {
  it('produces a SystemNotice with the severity from the frame', () => {
    let state = createInitialState();
    state = startSession(state);

    state = applyFrame(state, mkFrame('stream.system_notice', {
      sessionId: SID,
      severity: 'warn',
      source: 'rate_limit',
      message: 'Rate limit hit',
    }, { sessionId: SID }));

    const blocks = getSessionBlocks(state, SID);
    const notice = blocks.find(b => b.type === 'system_notice' && (b as SystemNoticeBlock).source === 'rate_limit') as SystemNoticeBlock | undefined;

    expect(notice).toBeDefined();
    expect(notice!.severity).toBe('warn');
    expect(notice!.message).toBe('Rate limit hit');
  });

  it('produces a SystemNotice with source harness for severity error', () => {
    let state = createInitialState();
    state = startSession(state);

    state = applyFrame(state, mkFrame('stream.system_notice', {
      sessionId: SID,
      severity: 'error',
      source: 'harness',
      message: 'Fatal error',
    }, { sessionId: SID }));

    const blocks = getSessionBlocks(state, SID);
    const notice = blocks.find(b => b.type === 'system_notice' && (b as SystemNoticeBlock).source === 'harness') as SystemNoticeBlock | undefined;

    expect(notice).toBeDefined();
    expect(notice!.severity).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// AC-7 — 10,000-block cap and truncated sentinel
// ---------------------------------------------------------------------------

describe('AC-7: 10,000-block cap with sentinel on eviction', () => {
  it('MAX_BLOCKS is 10,000', () => {
    expect(MAX_BLOCKS).toBe(10_000);
  });

  it('evicts the oldest block when the cap is exceeded and prepends a truncated_sentinel', () => {
    let state = createInitialState();
    state = startSession(state);

    // Fill the ring exactly to capacity.
    for (let i = 0; i < MAX_BLOCKS; i++) {
      state = applyFrame(state, mkFrame(
        'stream.text',
        { sessionId: SID, blockId: `b${i}`, textDelta: `t${i}`, final: true },
        { sessionId: SID },
      ));
    }

    // One block beyond the cap — must evict the oldest.
    state = applyFrame(state, mkFrame(
      'stream.text',
      { sessionId: SID, blockId: `b${MAX_BLOCKS}`, textDelta: 'overflow', final: true },
      { sessionId: SID },
    ));

    const session = state.sessions.get(SID)!;
    expect(session._evictedCount).toBeGreaterThan(0);

    const blocks = getSessionBlocks(state, SID);
    // Sentinel must be first.
    expect(blocks[0].type).toBe('truncated_sentinel');
    // The overflowed block must be present.
    const last = blocks[blocks.length - 1] as TextBlock;
    expect(last.text).toBe('overflow');
  });

  it('does not exceed the cap in the live ring (sentinel is prepended, not counted)', () => {
    let state = createInitialState();
    state = startSession(state);

    for (let i = 0; i <= MAX_BLOCKS; i++) {
      state = applyFrame(state, mkFrame(
        'stream.text',
        { sessionId: SID, blockId: `b${i}`, textDelta: `t${i}`, final: true },
        { sessionId: SID },
      ));
    }

    const session = state.sessions.get(SID)!;
    // The ring itself never holds more than MAX_BLOCKS entries.
    expect(session._ring.length).toBeLessThanOrEqual(MAX_BLOCKS);
  });
});

// ---------------------------------------------------------------------------
// AC-8 — stream.usage accumulator
// ---------------------------------------------------------------------------

describe('AC-8: stream.usage updates per-session usage accumulator', () => {
  it('stores token counts accessible via getSessionUsage', () => {
    let state = createInitialState();
    state = startSession(state);

    state = applyFrame(state, mkFrame('stream.usage', {
      sessionId: SID,
      inputTokens: 100,
      outputTokens: 200,
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 25,
      rawUsage: {},
    }, { sessionId: SID }));

    const usage = getSessionUsage(state, SID);
    expect(usage).not.toBeNull();
    expect(usage!.inputTokens).toBe(100);
    expect(usage!.outputTokens).toBe(200);
    expect(usage!.cacheCreationInputTokens).toBe(50);
    expect(usage!.cacheReadInputTokens).toBe(25);
  });

  it('overwrites (does not add) the usage on a second stream.usage frame', () => {
    let state = createInitialState();
    state = startSession(state);

    state = applyFrame(state, mkFrame('stream.usage', { sessionId: SID, inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, rawUsage: {} }, { sessionId: SID }));
    state = applyFrame(state, mkFrame('stream.usage', { sessionId: SID, inputTokens: 200, outputTokens: 80, cacheCreationInputTokens: 10, cacheReadInputTokens: 5, rawUsage: {} }, { sessionId: SID }));

    const usage = getSessionUsage(state, SID);
    expect(usage!.inputTokens).toBe(200);
    expect(usage!.outputTokens).toBe(80);
  });

  it('returns null for a session that has not received a usage frame', () => {
    const state = createInitialState();
    expect(getSessionUsage(state, 'nonexistent')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-9 — stage.started SystemNotice
// ---------------------------------------------------------------------------

describe('AC-9: stage.started produces SystemNotice', () => {
  it('produces a SystemNotice with severity info and source harness containing stage ID', () => {
    let state = createInitialState();
    state = startSession(state);

    state = applyFrame(state, mkFrame('stage.started', {
      stageId: 'my-stage',
      run: 'per-item',
      itemCount: 42,
    }));

    const blocks = getSessionBlocks(state, SID);
    const notice = blocks.find(b => b.type === 'system_notice') as SystemNoticeBlock | undefined;
    const stageNotice = blocks
      .filter((b): b is SystemNoticeBlock => b.type === 'system_notice')
      .find(n => n.message.includes('my-stage'));

    expect(stageNotice).toBeDefined();
    expect(stageNotice!.severity).toBe('info');
    expect(stageNotice!.source).toBe('harness');
    expect(stageNotice!.message).toContain('my-stage');
    expect(stageNotice!.message).toContain('per-item');
    expect(stageNotice!.message).toContain('42');
  });

  it('omits item count when stage.started has no itemCount', () => {
    let state = createInitialState();
    state = startSession(state);

    state = applyFrame(state, mkFrame('stage.started', { stageId: 'once-stage', run: 'once' }));

    const blocks = getSessionBlocks(state, SID);
    const stageNotice = blocks
      .filter((b): b is SystemNoticeBlock => b.type === 'system_notice')
      .find(n => n.message.includes('once-stage'));

    expect(stageNotice).toBeDefined();
    expect(stageNotice!.message).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// AC-10 — stage.complete SystemNotice
// ---------------------------------------------------------------------------

describe('AC-10: stage.complete produces SystemNotice', () => {
  it('produces a SystemNotice with severity info showing stage ID, next stage, needsApproval', () => {
    let state = createInitialState();
    state = startSession(state);

    state = applyFrame(state, mkFrame('stage.complete', {
      stageId: 'stage-1',
      nextStageId: 'stage-2',
      needsApproval: true,
      itemSummary: { complete: 5, blocked: 1, abandoned: 0 },
    }));

    const blocks = getSessionBlocks(state, SID);
    const notice = blocks
      .filter((b): b is SystemNoticeBlock => b.type === 'system_notice')
      .find(n => n.message.includes('stage-1'));

    expect(notice).toBeDefined();
    expect(notice!.severity).toBe('info');
    expect(notice!.source).toBe('harness');
    expect(notice!.message).toContain('stage-1');
    expect(notice!.message).toContain('stage-2');
    expect(notice!.message).toContain('approval');
    // item summary counts
    expect(notice!.message).toContain('5');
    expect(notice!.message).toContain('1');
  });

  it('indicates final stage when nextStageId is null', () => {
    let state = createInitialState();
    state = startSession(state);

    state = applyFrame(state, mkFrame('stage.complete', {
      stageId: 'final-stage',
      nextStageId: null,
      needsApproval: false,
    }));

    const blocks = getSessionBlocks(state, SID);
    const notice = blocks
      .filter((b): b is SystemNoticeBlock => b.type === 'system_notice')
      .find(n => n.message.includes('final-stage'));

    expect(notice).toBeDefined();
    expect(notice!.message).toContain('final');
  });
});

// ---------------------------------------------------------------------------
// Reducer purity — returned state must be a new object reference
// ---------------------------------------------------------------------------

describe('reducer purity', () => {
  it('returns a new RenderModelState reference on each mutation', () => {
    let state = createInitialState();
    const s0 = state;
    state = startSession(state);
    expect(state).not.toBe(s0);
  });

  it('returns the same reference when the frame has no effect (unknown type)', () => {
    const state = createInitialState();
    const next = applyFrame(state, mkFrame('pong', { clientTs: '' }));
    // Unknown/no-op types return the same state object.
    expect(next).toBe(state);
  });

  it('stream.system_notice produces the same blockId when called twice with the same frame (determinism)', () => {
    const state0 = createInitialState();
    const state = startSession(state0);
    const frame = mkFrame('stream.system_notice', {
      sessionId: SID,
      severity: 'info',
      source: 'harness',
      message: 'test determinism',
    }, { sessionId: SID, seq: 42 });

    const s1 = applyFrame(state, frame);
    const s2 = applyFrame(state, frame);

    const blocks1 = getSessionBlocks(s1, SID).filter(b => b.type === 'system_notice' && b.blockId.startsWith('notice-'));
    const blocks2 = getSessionBlocks(s2, SID).filter(b => b.type === 'system_notice' && b.blockId.startsWith('notice-'));

    expect(blocks1.length).toBeGreaterThan(0);
    expect(blocks1.map(b => b.blockId)).toEqual(blocks2.map(b => b.blockId));
  });
});

// ---------------------------------------------------------------------------
// session.started — synthesises SystemNotice
// ---------------------------------------------------------------------------

describe('session.started', () => {
  it('creates an initial SystemNotice block with session info', () => {
    let state = createInitialState();
    state = startSession(state);

    const blocks = getSessionBlocks(state, SID);
    expect(blocks.length).toBeGreaterThan(0);

    const notice = blocks[0] as SystemNoticeBlock;
    expect(notice.type).toBe('system_notice');
    expect(notice.message).toContain('implement');
  });

  it('stores the phase on the session', () => {
    let state = createInitialState();
    state = startSession(state, SID, 'review');
    expect(state.sessions.get(SID)!.phase).toBe('review');
  });
});

// ---------------------------------------------------------------------------
// stream.thinking — delta accumulation (same shape as text)
// ---------------------------------------------------------------------------

describe('stream.thinking', () => {
  it('accumulates thinking deltas into a ThinkingBlock', () => {
    let state = createInitialState();
    state = startSession(state);

    state = applyFrame(state, mkFrame('stream.thinking', { sessionId: SID, blockId: 'th1', textDelta: 'Think' }, { sessionId: SID }));
    state = applyFrame(state, mkFrame('stream.thinking', { sessionId: SID, blockId: 'th1', textDelta: 'ing...' }, { sessionId: SID }));

    const blocks = getSessionBlocks(state, SID);
    const thinkBlock = blocks.find(b => b.type === 'thinking') as ThinkingBlock | undefined;

    expect(thinkBlock!.text).toBe('Thinking...');
    expect(thinkBlock!.collapsed).toBe(true);
  });
});
