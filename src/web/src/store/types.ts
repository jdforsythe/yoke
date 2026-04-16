/**
 * Normalized render-model block types.
 *
 * These are the client-side render primitives produced by the reducer.
 * They are NOT the wire protocol types — those live in ws/types.ts.
 */

import type { BlockRing } from './blockRing';

export interface TextBlock {
  readonly type: 'text';
  readonly blockId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly frozen: boolean;
}

export interface ToolCallBlock {
  readonly type: 'tool_call';
  /** blockId === toolUseId for stable keying */
  readonly blockId: string;
  readonly sessionId: string;
  readonly toolUseId: string;
  readonly name: string;
  readonly input: unknown;
  readonly status: 'pending' | 'running' | 'ok' | 'error';
  readonly output?: unknown;
}

export interface ThinkingBlock {
  readonly type: 'thinking';
  readonly blockId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly frozen: boolean;
  /** Collapsed by default; toggled by the renderer */
  readonly collapsed: boolean;
}

export interface PrepostOutputChunk {
  readonly stream: 'stdout' | 'stderr';
  readonly chunk: string;
}

export interface SystemNoticeBlock {
  readonly type: 'system_notice';
  readonly blockId: string;
  readonly sessionId: string | null;
  readonly severity: 'info' | 'warn' | 'error' | 'requires_attention';
  readonly source: string;
  readonly message: string;
  readonly extra?: unknown;
  /** For prepost.command.* frames */
  readonly runId?: number;
  readonly outputChunks?: readonly PrepostOutputChunk[];
  readonly exitCode?: number;
  readonly action?: unknown;
  readonly prepostFinalized?: boolean;
}

export interface TruncatedSentinel {
  readonly type: 'truncated_sentinel';
  readonly blockId: string;
  readonly sessionId: string;
  /** Seq of the oldest evicted block (0 if unknown) */
  readonly oldestEvictedSeq: number;
}

export type RenderBlock =
  | TextBlock
  | ToolCallBlock
  | ThinkingBlock
  | SystemNoticeBlock
  | TruncatedSentinel;

export interface SessionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

export interface SessionRenderState {
  readonly sessionId: string;
  /** Phase label from SessionStartedPayload.phase (e.g. 'implement', 'review'). */
  readonly phase: string | null;

  /**
   * Ring buffer of live blocks.
   * O(1) amortized push/eviction (no Array.shift).
   * Materialise for rendering via getSessionBlocks().
   */
  readonly _ring: BlockRing;

  /**
   * Maps blockId (and toolUseId, since ToolCallBlock.blockId === toolUseId)
   * → physical index in _ring's backing array.
   * Provides O(1) lookup for TextBlock delta accumulation and ToolCall result
   * matching without linear scans.
   *
   * Entries for evicted blocks become stale. Callers must validate with
   * _ring.isLive(physIdx) before trusting an entry.
   */
  readonly _blockMap: ReadonlyMap<string, number>;

  /**
   * Total number of blocks evicted so far (for sentinel detection).
   * When > 0, getSessionBlocks() prepends a TruncatedSentinel.
   */
  readonly _evictedCount: number;

  /**
   * Blocks loaded from the HTTP log endpoint ("Load earlier messages").
   * Rendered between the sentinel and the ring content so they appear
   * at the top of the stream without a scroll jump.
   */
  readonly _prependedBlocks: readonly RenderBlock[];

  readonly frozen: boolean;
  /** True when an orphan tool_result or prepost.ended arrived without a prior start */
  readonly needsSnapshot: boolean;
  readonly usage: SessionUsage;
}

export interface RenderModelState {
  readonly sessions: ReadonlyMap<string, SessionRenderState>;
}
