/**
 * LiveStreamPane — virtualized, variable-height stream output viewer.
 *
 * Uses @tanstack/react-virtual with measureElement for accurate row heights.
 * Follow-tail auto-scrolls when within 50 px of the bottom; detaches on
 * upscroll > 50 px; shows a "Jump to latest" pill when detached.
 *
 * Scroll position is persisted in a module-level Map keyed by sessionId so
 * switching tabs and back restores the previous position without re-rendering.
 *
 * Text deltas are rAF-batched in the render store; this component simply
 * reads blocks via useSyncExternalStore and virtualizes them.
 */

import { useRef, useEffect, useState, useCallback, memo } from 'react';
import { useSyncExternalStore } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { subscribe, getSnapshot, getSessionBlocks } from '@/store/renderStore';
import type { RenderBlock } from '@/store/types';
import { TextBlockRenderer } from './TextBlockRenderer';
import { ToolCallRenderer } from './ToolCallRenderer';
import { ThinkingBlockRenderer } from './ThinkingBlockRenderer';
import { SystemNoticeRenderer } from './SystemNoticeRenderer';

// ---------------------------------------------------------------------------
// Scroll-position cache (module-level, survives re-mounts)
// ---------------------------------------------------------------------------

const scrollPositionCache = new Map<string, number>();

// ---------------------------------------------------------------------------
// Block router (memoized)
// ---------------------------------------------------------------------------

const BlockRouter = memo(function BlockRouter({
  block,
  onLoadEarlier,
}: {
  block: RenderBlock;
  onLoadEarlier?: () => void;
}) {
  switch (block.type) {
    case 'text':
      return <TextBlockRenderer block={block} />;
    case 'tool_call':
      return <ToolCallRenderer block={block} />;
    case 'thinking':
      return <ThinkingBlockRenderer block={block} />;
    case 'system_notice':
      return <SystemNoticeRenderer block={block} />;
    case 'truncated_sentinel':
      return (
        <div className="px-4 py-3 flex justify-center">
          <button
            onClick={onLoadEarlier}
            className="text-xs text-blue-400 hover:text-blue-300 underline"
          >
            Load earlier messages…
          </button>
        </div>
      );
    default:
      return null;
  }
});

// ---------------------------------------------------------------------------
// LiveStreamPane
// ---------------------------------------------------------------------------

interface Props {
  sessionId: string;
  workflowId: string;
}

export function LiveStreamPane({ sessionId, workflowId }: Props) {
  // Subscribe to the store; read only this session's blocks.
  const model = useSyncExternalStore(subscribe, getSnapshot);
  const blocks = getSessionBlocks(model, sessionId);

  const parentRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const prevCountRef = useRef(0);
  const [detached, setDetached] = useState(false);

  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 72,
    measureElement: (el) => el.getBoundingClientRect().height,
    overscan: 8,
  });

  // Follow-tail: auto-scroll when new blocks arrive and user is at bottom.
  useEffect(() => {
    if (blocks.length === prevCountRef.current) return;
    prevCountRef.current = blocks.length;
    if (atBottomRef.current && !detached && blocks.length > 0) {
      virtualizer.scrollToIndex(blocks.length - 1, { align: 'end' });
    }
  }, [blocks.length, detached, virtualizer]);

  // Restore scroll position when sessionId changes.
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const saved = scrollPositionCache.get(sessionId);
    if (saved !== undefined) {
      el.scrollTop = saved;
    }
    return () => {
      // Save position on unmount / session switch.
      if (parentRef.current) {
        scrollPositionCache.set(sessionId, parentRef.current.scrollTop);
      }
    };
  }, [sessionId]);

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    atBottomRef.current = nearBottom;
    setDetached(!nearBottom);
  }, []);

  function jumpToLatest() {
    if (blocks.length > 0) {
      virtualizer.scrollToIndex(blocks.length - 1, { align: 'end' });
    }
    atBottomRef.current = true;
    setDetached(false);
  }

  async function loadEarlier() {
    // Fetch from HTTP session log store and prepend blocks.
    // The store will handle prepend; the virtualizer will re-measure.
    const session = model.sessions.get(sessionId);
    if (!session) return;
    const sentinel = session.blocks[0];
    if (!sentinel || sentinel.type !== 'truncated_sentinel') return;
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/log?workflowId=${encodeURIComponent(workflowId)}&before=${sentinel.oldestEvictedSeq}&limit=100`,
      );
      if (!res.ok) return;
      // The server sends frames in the response; dispatch them.
      // (Server response shape: { entries: string[] })
      const data = (await res.json()) as { entries?: string[] };
      if (!data.entries) return;
      const { dispatch: dispatchFrame } = await import('@/store/renderStore');
      for (const raw of data.entries) {
        try {
          const frame = JSON.parse(raw) as import('@/ws/types').ServerFrame;
          dispatchFrame(frame);
        } catch {
          // Skip malformed entry.
        }
      }
    } catch {
      // Network error — silently ignore.
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="relative flex flex-col h-full">
      <div
        ref={parentRef}
        className="flex-1 overflow-y-auto"
        onScroll={handleScroll}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: 'relative',
          }}
        >
          {virtualItems.map((vItem) => {
            const block = blocks[vItem.index];
            if (!block) return null;
            return (
              <div
                key={vItem.key}
                data-index={vItem.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${vItem.start}px)`,
                }}
              >
                <BlockRouter block={block} onLoadEarlier={loadEarlier} />
              </div>
            );
          })}
        </div>
      </div>

      {detached && (
        <button
          onClick={jumpToLatest}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-blue-600 hover:bg-blue-500 text-white text-xs px-3 py-1.5 rounded-full shadow-lg transition-colors z-10"
        >
          Jump to latest ↓
        </button>
      )}
    </div>
  );
}
