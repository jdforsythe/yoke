import { memo } from 'react';
import type { TextBlock } from '@/store/types';

/**
 * Renders a TextBlock — monospace, pre-wrap.
 *
 * Detects fenced code blocks (``` ... ```) and renders them in a distinct
 * code container with a muted background. No dangerouslySetInnerHTML —
 * all text is rendered as plain text nodes inside <code> or <pre> elements.
 *
 * Memoized with stable blockId key so re-renders only fire when the block
 * text actually changes (text delta accumulation).
 */

interface Segment {
  kind: 'text' | 'code';
  lang?: string;
  content: string;
}

/** Split text on fenced code blocks (```lang\n...\n```). */
function parseSegments(raw: string): Segment[] {
  const segments: Segment[] = [];
  const fence = /```(\w*)\n([\s\S]*?)```/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(raw)) !== null) {
    if (match.index > last) {
      segments.push({ kind: 'text', content: raw.slice(last, match.index) });
    }
    segments.push({ kind: 'code', lang: match[1] || undefined, content: match[2] ?? '' });
    last = match.index + match[0].length;
  }
  if (last < raw.length) {
    segments.push({ kind: 'text', content: raw.slice(last) });
  }
  return segments;
}

export const TextBlockRenderer = memo(function TextBlockRenderer({
  block,
}: {
  block: TextBlock;
}) {
  const segments = parseSegments(block.text);

  return (
    <div className="px-4 py-2 text-sm text-gray-100">
      {segments.map((seg, i) =>
        seg.kind === 'code' ? (
          <div key={i} className="my-2 rounded-md overflow-hidden">
            {seg.lang && (
              <div className="px-3 py-1 text-xs text-gray-400 bg-gray-700/80 font-mono border-b border-gray-600">
                {seg.lang}
              </div>
            )}
            <pre className="px-3 py-2 bg-gray-800/80 text-xs text-gray-200 overflow-x-auto whitespace-pre font-mono">
              <code>{seg.content}</code>
            </pre>
          </div>
        ) : (
          <span key={i} className="whitespace-pre-wrap font-mono break-words">
            {seg.content}
          </span>
        ),
      )}
    </div>
  );
});
