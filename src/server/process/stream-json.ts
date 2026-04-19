/**
 * Stream-JSON NDJSON parser.
 *
 * Consumes Claude Code `--output-format stream-json` stdout lines and emits
 * typed events. Each line is parsed independently — a malformed line emits
 * `parse_error` and does NOT halt the parser.
 *
 * Two streaming modes are supported transparently:
 *
 *   Default mode (no --include-partial-messages):
 *     `assistant` events carry complete content blocks. The parser emits
 *     stream.text / stream.thinking / stream.tool_use with final:true immediately.
 *
 *   Partial-messages mode (--include-partial-messages):
 *     `stream_event` SSE wrappers arrive before the complete `assistant` event.
 *     The parser emits incremental stream.text / stream.thinking deltas with
 *     final:false, then a final (empty-delta) event on content_block_stop.
 *     `assistant` events for text/thinking blocks are suppressed to avoid
 *     duplicates; tool_use events are still emitted from `assistant`.
 *
 * Empirical basis: docs/research/stream-json-semantics.md, captured
 * 2026-04-12 with Claude Code 2.1.104 / claude-opus-4-6.
 *
 * Usage:
 *   const parser = new StreamJsonParser();
 *   parser.on('stream.text', ev => { ... });
 *   handle.on('stdout_line', line => parser.feed(line));
 */

import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Event type definitions
// ---------------------------------------------------------------------------

/** Incremental text delta from a text content block. */
export interface StreamTextEvent {
  type: 'stream.text';
  /** Content block index (from stream_event) or sequential counter (default mode). */
  blockId: number;
  /** The text delta for this event. Empty string on the final (content_block_stop) event. */
  textDelta: string;
  /**
   * true on the last event for a block:
   *   - Partial mode: fired when content_block_stop arrives.
   *   - Default mode: always true (single complete event per block).
   */
  final: boolean;
}

/** Incremental thinking delta from a thinking content block. */
export interface StreamThinkingEvent {
  type: 'stream.thinking';
  blockId: number;
  textDelta: string;
  final: boolean;
}

/** Complete tool_use content block, emitted from the full `assistant` event. */
export interface StreamToolUseEvent {
  type: 'stream.tool_use';
  /** Anthropic tool_use ID (`toolu_...`). */
  toolUseId: string;
  name: string;
  input: unknown;
}

/**
 * Tool result from a `user` event following a stream.tool_use.
 * AC: stream.tool_result always follows matching stream.tool_use within a session.
 */
export interface StreamToolResultEvent {
  type: 'stream.tool_result';
  /** Matches the toolUseId of the preceding stream.tool_use. */
  toolUseId: string;
  content: string;
  isError: boolean;
}

/**
 * Session-cumulative token usage, emitted from the `result` event.
 * Carries all four token fields required by the acceptance criteria.
 */
export interface StreamUsageEvent {
  type: 'stream.usage';
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** Informational system event (init, hook_started, hook_response). */
export interface StreamSystemNoticeEvent {
  type: 'stream.system_notice';
  subtype: string;
  data: unknown;
}

/**
 * Rate limit detected: `rate_limit_event.rate_limit_info.status !== "allowed"`.
 *
 * Empirical note: no actual `status="rejected"` frame was captured during
 * Phase γ research. The detection pattern matches the observed format from
 * docs/research/stream-json-semantics.md §3.6 with the status field inverted.
 */
export interface RateLimitDetectedEvent {
  type: 'rate_limit_detected';
  /** Unix timestamp (seconds) when the window resets, if present in the frame. */
  resetAt?: number;
}

/**
 * Emitted when a stdout line cannot be parsed as JSON or is not a JSON object.
 * The consumer (Pipeline Engine) is responsible for incrementing
 * sessions.status_flags.parse_errors in SQLite — this event carries the
 * information needed to do so.
 */
export interface ParseErrorEvent {
  type: 'parse_error';
  line: string;
  error: string;
}

export type StreamJsonEvent =
  | StreamTextEvent
  | StreamThinkingEvent
  | StreamToolUseEvent
  | StreamToolResultEvent
  | StreamUsageEvent
  | StreamSystemNoticeEvent
  | RateLimitDetectedEvent
  | ParseErrorEvent;

// ---------------------------------------------------------------------------
// StreamJsonParser
// ---------------------------------------------------------------------------

/**
 * NDJSON line-buffered stream-json parser.
 *
 * Feed data via `feedChunk(data)` (arbitrary byte chunks) or `feed(line)` (one
 * complete newline-stripped line). Use `flush()` when the stream ends to
 * process any remaining partial line.
 */
export class StreamJsonParser extends EventEmitter {
  /**
   * Partial-line accumulation buffer for feedChunk(). Splits on LF only —
   * no CRLF, no bare CR (matches research finding: delimiter is 0x0a only).
   */
  private _lineBuf = '';

  /**
   * true once any `stream_event` line has been processed. Used to switch
   * between default-mode and partial-messages-mode `assistant` handling.
   */
  private _seenStreamEvent = false;

  /**
   * Tracks content block types in partial-messages mode.
   * key = content block index; value = block type.
   */
  private _blockTypes = new Map<number, 'text' | 'thinking' | 'tool_use'>();

  /**
   * Sequential block ID counter for default mode (no stream_event flow).
   * Incremented each time a text or thinking block is emitted from an
   * `assistant` event.
   */
  private _nextBlockId = 0;

  // -------------------------------------------------------------------------
  // Public feed interface
  // -------------------------------------------------------------------------

  /**
   * Feed a chunk of raw stdout data. Splits on LF (`\n`) and processes each
   * complete line independently. Partial lines are buffered until the next LF.
   * No assumption is made about chunk size — a chunk may contain zero, one, or
   * many complete lines.
   */
  feedChunk(data: string): void {
    this._lineBuf += data;
    const parts = this._lineBuf.split('\n');
    // The last element is either an incomplete line or empty (trailing \n).
    this._lineBuf = parts.pop() ?? '';
    for (const line of parts) {
      this.feed(line);
    }
  }

  /**
   * Flush any remaining data in the line buffer. Call after the stream ends
   * to ensure the final partial line (if any) is processed.
   */
  flush(): void {
    if (this._lineBuf.trim()) {
      this.feed(this._lineBuf);
      this._lineBuf = '';
    }
  }

  /**
   * Process a single complete stdout line (already split at LF).
   * Empty lines are silently skipped.
   * A malformed line emits `parse_error` and returns — processing continues.
   */
  feed(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch (err) {
      this._emitParseError(line, err instanceof Error ? err.message : String(err));
      return;
    }

    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      this._emitParseError(line, 'Parsed value is not a JSON object');
      return;
    }

    this._dispatch(obj as Record<string, unknown>);
  }

  // -------------------------------------------------------------------------
  // Typed event overloads
  // -------------------------------------------------------------------------

  on(event: 'stream.text', listener: (ev: StreamTextEvent) => void): this;
  on(event: 'stream.thinking', listener: (ev: StreamThinkingEvent) => void): this;
  on(event: 'stream.tool_use', listener: (ev: StreamToolUseEvent) => void): this;
  on(event: 'stream.tool_result', listener: (ev: StreamToolResultEvent) => void): this;
  on(event: 'stream.usage', listener: (ev: StreamUsageEvent) => void): this;
  on(event: 'stream.system_notice', listener: (ev: StreamSystemNoticeEvent) => void): this;
  on(event: 'rate_limit_detected', listener: (ev: RateLimitDetectedEvent) => void): this;
  on(event: 'parse_error', listener: (ev: ParseErrorEvent) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  once(event: 'stream.text', listener: (ev: StreamTextEvent) => void): this;
  once(event: 'stream.thinking', listener: (ev: StreamThinkingEvent) => void): this;
  once(event: 'stream.tool_use', listener: (ev: StreamToolUseEvent) => void): this;
  once(event: 'stream.tool_result', listener: (ev: StreamToolResultEvent) => void): this;
  once(event: 'stream.usage', listener: (ev: StreamUsageEvent) => void): this;
  once(event: 'stream.system_notice', listener: (ev: StreamSystemNoticeEvent) => void): this;
  once(event: 'rate_limit_detected', listener: (ev: RateLimitDetectedEvent) => void): this;
  once(event: 'parse_error', listener: (ev: ParseErrorEvent) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  once(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  private _dispatch(obj: Record<string, unknown>): void {
    const type = obj['type'] as string | undefined;
    switch (type) {
      case 'system':
        this._handleSystem(obj);
        break;
      case 'assistant':
        this._handleAssistant(obj);
        break;
      case 'user':
        this._handleUser(obj);
        break;
      case 'stream_event':
        this._seenStreamEvent = true;
        this._handleStreamEvent(obj);
        break;
      case 'rate_limit_event':
        this._handleRateLimitEvent(obj);
        break;
      case 'result':
        this._handleResult(obj);
        break;
      // Unknown top-level types are silently ignored (forward compatibility).
    }
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  private _handleSystem(obj: Record<string, unknown>): void {
    const ev: StreamSystemNoticeEvent = {
      type: 'stream.system_notice',
      subtype: typeof obj['subtype'] === 'string' ? obj['subtype'] : '',
      data: obj,
    };
    this.emit('stream.system_notice', ev);
  }

  private _handleAssistant(obj: Record<string, unknown>): void {
    const msg = obj['message'];
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return;
    const msgObj = msg as Record<string, unknown>;

    const content = msgObj['content'];
    if (!Array.isArray(content)) return;

    for (const block of content as unknown[]) {
      if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
      const b = block as Record<string, unknown>;
      const blockType = b['type'] as string | undefined;

      if (blockType === 'text') {
        if (this._seenStreamEvent) {
          // Partial-messages mode: already emitted via stream_event deltas.
          // Suppress to avoid duplicate stream.text events.
          continue;
        }
        // Default mode: emit the complete text block as a single final event.
        const ev: StreamTextEvent = {
          type: 'stream.text',
          blockId: this._nextBlockId++,
          textDelta: typeof b['text'] === 'string' ? b['text'] : '',
          final: true,
        };
        this.emit('stream.text', ev);
      } else if (blockType === 'thinking') {
        if (this._seenStreamEvent) {
          continue; // Same suppression as text.
        }
        const ev: StreamThinkingEvent = {
          type: 'stream.thinking',
          blockId: this._nextBlockId++,
          textDelta: typeof b['thinking'] === 'string' ? b['thinking'] : '',
          final: true,
        };
        this.emit('stream.thinking', ev);
      } else if (blockType === 'tool_use') {
        // tool_use is always emitted from the complete `assistant` event,
        // in both default and partial-messages mode. The input is fully
        // assembled here (streaming input_json_delta is not exposed).
        const ev: StreamToolUseEvent = {
          type: 'stream.tool_use',
          toolUseId: typeof b['id'] === 'string' ? b['id'] : '',
          name: typeof b['name'] === 'string' ? b['name'] : '',
          input: b['input'],
        };
        this.emit('stream.tool_use', ev);
      }
      // Other block types (e.g. image) are silently ignored.
    }
  }

  private _handleUser(obj: Record<string, unknown>): void {
    const msg = obj['message'];
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return;
    const msgObj = msg as Record<string, unknown>;

    const content = msgObj['content'];
    if (!Array.isArray(content)) return;

    for (const block of content as unknown[]) {
      if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
      const b = block as Record<string, unknown>;
      if (b['type'] !== 'tool_result') continue;

      const raw = b['content'];
      const contentStr =
        typeof raw === 'string' ? raw : raw !== null && raw !== undefined ? JSON.stringify(raw) : '';
      const ev: StreamToolResultEvent = {
        type: 'stream.tool_result',
        toolUseId: typeof b['tool_use_id'] === 'string' ? b['tool_use_id'] : '',
        content: contentStr,
        isError: b['is_error'] === true,
      };
      this.emit('stream.tool_result', ev);
    }
  }

  private _handleStreamEvent(obj: Record<string, unknown>): void {
    const event = obj['event'];
    if (event === null || typeof event !== 'object' || Array.isArray(event)) return;
    const ev = event as Record<string, unknown>;

    const evType = ev['type'] as string | undefined;
    const index = typeof ev['index'] === 'number' ? ev['index'] : undefined;

    switch (evType) {
      case 'content_block_start': {
        if (index === undefined) break;
        const cb = ev['content_block'];
        if (cb === null || typeof cb !== 'object' || Array.isArray(cb)) break;
        const cbObj = cb as Record<string, unknown>;
        const cbType = cbObj['type'] as string | undefined;
        if (cbType === 'text' || cbType === 'thinking' || cbType === 'tool_use') {
          this._blockTypes.set(index, cbType);
        }
        break;
      }

      case 'content_block_delta': {
        if (index === undefined) break;
        const delta = ev['delta'];
        if (delta === null || typeof delta !== 'object' || Array.isArray(delta)) break;
        const d = delta as Record<string, unknown>;
        const deltaType = d['type'] as string | undefined;

        if (deltaType === 'text_delta') {
          const textEv: StreamTextEvent = {
            type: 'stream.text',
            blockId: index,
            textDelta: typeof d['text'] === 'string' ? d['text'] : '',
            final: false,
          };
          this.emit('stream.text', textEv);
        } else if (deltaType === 'thinking_delta') {
          const thinkEv: StreamThinkingEvent = {
            type: 'stream.thinking',
            blockId: index,
            textDelta: typeof d['thinking'] === 'string' ? d['thinking'] : '',
            final: false,
          };
          this.emit('stream.thinking', thinkEv);
        }
        // input_json_delta: tool_use input streaming — not emitted here.
        // The complete tool_use is emitted from the assistant event instead.
        break;
      }

      case 'content_block_stop': {
        if (index === undefined) break;
        const blockType = this._blockTypes.get(index);
        this._blockTypes.delete(index);

        if (blockType === 'text') {
          // Emit final marker with empty delta.
          const finalEv: StreamTextEvent = {
            type: 'stream.text',
            blockId: index,
            textDelta: '',
            final: true,
          };
          this.emit('stream.text', finalEv);
        } else if (blockType === 'thinking') {
          const finalEv: StreamThinkingEvent = {
            type: 'stream.thinking',
            blockId: index,
            textDelta: '',
            final: true,
          };
          this.emit('stream.thinking', finalEv);
        }
        // tool_use stop: no event — the tool_use was already emitted from assistant.
        break;
      }

      // message_start, message_delta, message_stop: informational — not exposed.
    }
  }

  private _handleRateLimitEvent(obj: Record<string, unknown>): void {
    const info = obj['rate_limit_info'];
    if (info === null || typeof info !== 'object' || Array.isArray(info)) return;
    const infoObj = info as Record<string, unknown>;

    // status="allowed" is the normal case (observed in all Phase γ captures).
    // Any other status (expected: "rejected") indicates active rate limiting.
    if (infoObj['status'] === 'allowed') return;

    const ev: RateLimitDetectedEvent = {
      type: 'rate_limit_detected',
    };
    // resetsAt is a Unix timestamp (seconds) when present.
    if (typeof infoObj['resetsAt'] === 'number') {
      ev.resetAt = infoObj['resetsAt'] as number;
    }
    this.emit('rate_limit_detected', ev);
  }

  private _handleResult(obj: Record<string, unknown>): void {
    const usage = obj['usage'];
    if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return;
    const u = usage as Record<string, unknown>;

    const ev: StreamUsageEvent = {
      type: 'stream.usage',
      inputTokens: typeof u['input_tokens'] === 'number' ? u['input_tokens'] : 0,
      outputTokens: typeof u['output_tokens'] === 'number' ? u['output_tokens'] : 0,
      cacheCreationInputTokens:
        typeof u['cache_creation_input_tokens'] === 'number'
          ? u['cache_creation_input_tokens']
          : 0,
      cacheReadInputTokens:
        typeof u['cache_read_input_tokens'] === 'number' ? u['cache_read_input_tokens'] : 0,
    };
    this.emit('stream.usage', ev);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private _emitParseError(line: string, error: string): void {
    const ev: ParseErrorEvent = { type: 'parse_error', line, error };
    this.emit('parse_error', ev);
  }
}
