/**
 * StreamJsonParser — tests.
 *
 * Acceptance criteria coverage:
 *   AC-1: Malformed line → parse_error emitted, parser continues.
 *   AC-2: stream.text events carry blockId + textDelta; final:true on content_block_stop.
 *   AC-3: stream.usage carries all four token fields.
 *   AC-4: rate_limit_detected raised when rate_limit_event status !== "allowed"; reset_at extracted.
 *   AC-5: Tested against empirically captured fixture files (not synthetic payloads).
 *   AC-6: stream.tool_result always follows matching stream.tool_use within a session.
 *
 * Review criteria coverage:
 *   RC-1: feedChunk() splits on \n only; tested with 1-byte chunk size.
 *   RC-2: Rate-limit detection pattern matches the empirically verified format from docs/research/.
 *   RC-3: parse_error events are emitted (SQLite persistence is Pipeline Engine's responsibility).
 *   RC-4: No streaming parser library — StreamJsonParser is an EventEmitter with feed/feedChunk.
 *
 * Fixture files (empirically captured, not synthetic):
 *   tests/fixtures/stream-json/capture-default-mode.jsonl — 12 lines, default mode,
 *     thinking + text + 3×tool_use + 3×tool_result, captured 2026-04-12.
 *   tests/fixtures/stream-json/capture-partial-messages.jsonl — 12 lines,
 *     --include-partial-messages mode with stream_event SSE wrappers, captured 2026-04-12.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  StreamJsonParser,
  type StreamJsonEvent,
  type StreamTextEvent,
  type StreamThinkingEvent,
  type StreamToolUseEvent,
  type StreamToolResultEvent,
  type StreamUsageEvent,
  type StreamSystemNoticeEvent,
  type RateLimitDetectedEvent,
  type ParseErrorEvent,
} from '../../src/server/process/stream-json.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'stream-json');

/** Register listeners for all typed events and collect them into an array. */
function collectAllEvents(parser: StreamJsonParser, events: StreamJsonEvent[]): void {
  const push = (ev: StreamJsonEvent): void => { events.push(ev); };
  parser.on('stream.text', push);
  parser.on('stream.thinking', push);
  parser.on('stream.tool_use', push);
  parser.on('stream.tool_result', push);
  parser.on('stream.usage', push);
  parser.on('stream.system_notice', push);
  parser.on('rate_limit_detected', push);
  parser.on('parse_error', push);
}

/** Feed a fixture file line-by-line via feed() and collect all emitted events. */
function parseFixture(filename: string): StreamJsonEvent[] {
  const parser = new StreamJsonParser();
  const events: StreamJsonEvent[] = [];
  collectAllEvents(parser, events);
  const content = readFileSync(join(FIXTURES, filename), 'utf8');
  for (const line of content.split('\n')) {
    parser.feed(line);
  }
  return events;
}

/** Feed a fixture file as fixed-size chunks via feedChunk() + flush(). */
function parseFixtureChunked(filename: string, chunkSize: number): StreamJsonEvent[] {
  const parser = new StreamJsonParser();
  const events: StreamJsonEvent[] = [];
  collectAllEvents(parser, events);
  const content = readFileSync(join(FIXTURES, filename), 'utf8');
  for (let i = 0; i < content.length; i += chunkSize) {
    parser.feedChunk(content.slice(i, i + chunkSize));
  }
  parser.flush();
  return events;
}

/** Feed a raw NDJSON string and collect events. */
function parseLines(ndjson: string): StreamJsonEvent[] {
  const parser = new StreamJsonParser();
  const events: StreamJsonEvent[] = [];
  collectAllEvents(parser, events);
  for (const line of ndjson.split('\n')) {
    parser.feed(line);
  }
  return events;
}

// ---------------------------------------------------------------------------
// 1. Empirical fixture — default mode (AC-5)
// ---------------------------------------------------------------------------

describe('Default mode — capture-default-mode.jsonl (AC-5)', () => {
  let events: StreamJsonEvent[];

  beforeEach(() => {
    events = parseFixture('capture-default-mode.jsonl');
  });

  it('emits stream.system_notice for the system init line', () => {
    const notices = events.filter(
      (e): e is StreamSystemNoticeEvent => e.type === 'stream.system_notice',
    );
    expect(notices.length).toBeGreaterThanOrEqual(1);
    expect(notices[0].subtype).toBe('init');
  });

  it('emits stream.thinking for the thinking content block', () => {
    const thinking = events.filter(
      (e): e is StreamThinkingEvent => e.type === 'stream.thinking',
    );
    expect(thinking.length).toBeGreaterThanOrEqual(1);
    const t = thinking[0];
    expect(t.final).toBe(true);
    expect(typeof t.textDelta).toBe('string');
    expect(t.textDelta.length).toBeGreaterThan(0);
    expect(typeof t.blockId).toBe('number');
  });

  it('emits stream.text for each text content block (final:true)', () => {
    const texts = events.filter((e): e is StreamTextEvent => e.type === 'stream.text');
    // capture-1 has 2 text blocks (L3 and L11)
    expect(texts.length).toBe(2);
    for (const t of texts) {
      expect(t.final).toBe(true);
      expect(typeof t.textDelta).toBe('string');
      expect(t.textDelta.length).toBeGreaterThan(0);
    }
  });

  it('emits stream.tool_use for each tool_use block', () => {
    const toolUses = events.filter(
      (e): e is StreamToolUseEvent => e.type === 'stream.tool_use',
    );
    // capture-1 has 3 Bash tool_use blocks
    expect(toolUses.length).toBe(3);
    for (const tu of toolUses) {
      expect(tu.name).toBe('Bash');
      expect(tu.toolUseId).toMatch(/^toolu_/);
      expect(tu.input).toBeTruthy();
    }
  });

  it('emits stream.tool_result for each tool_result block', () => {
    const results = events.filter(
      (e): e is StreamToolResultEvent => e.type === 'stream.tool_result',
    );
    // capture-1 has 3 tool results
    expect(results.length).toBe(3);
    for (const tr of results) {
      expect(tr.toolUseId).toMatch(/^toolu_/);
    }
  });

  it('emits stream.usage from result event with all four token fields (AC-3)', () => {
    const usages = events.filter((e): e is StreamUsageEvent => e.type === 'stream.usage');
    expect(usages.length).toBe(1);
    const u = usages[0];
    // Empirical values from capture-1 result event
    expect(u.inputTokens).toBe(4);
    expect(u.outputTokens).toBe(685);
    expect(u.cacheCreationInputTokens).toBe(19346);
    expect(u.cacheReadInputTokens).toBe(18637);
  });

  it('stream.tool_result always follows matching stream.tool_use (AC-6)', () => {
    const toolUseMap = new Map<string, number>(); // toolUseId → index in events[]
    const toolResultIds = new Set<string>();

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev.type === 'stream.tool_use') {
        toolUseMap.set(ev.toolUseId, i);
      } else if (ev.type === 'stream.tool_result') {
        toolResultIds.add(ev.toolUseId);
        // Every tool_result must have a preceding tool_use with the same ID.
        expect(toolUseMap.has(ev.toolUseId)).toBe(true);
        // And it must come AFTER the matching tool_use in the event sequence.
        const tuIdx = toolUseMap.get(ev.toolUseId)!;
        expect(i).toBeGreaterThan(tuIdx);
      }
    }
    // All three tool_results are paired.
    expect(toolResultIds.size).toBe(3);
  });

  it('does NOT emit rate_limit_detected when status is "allowed"', () => {
    const rlEvents = events.filter((e) => e.type === 'rate_limit_detected');
    expect(rlEvents.length).toBe(0);
  });

  it('does not emit parse_error for a well-formed fixture', () => {
    const parseErrors = events.filter((e): e is ParseErrorEvent => e.type === 'parse_error');
    expect(parseErrors.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Empirical fixture — partial-messages mode (AC-2, AC-5)
// ---------------------------------------------------------------------------

describe('Partial-messages mode — capture-partial-messages.jsonl (AC-2, AC-5)', () => {
  let events: StreamJsonEvent[];

  beforeEach(() => {
    events = parseFixture('capture-partial-messages.jsonl');
  });

  it('emits stream.system_notice for the system init line', () => {
    const notices = events.filter(
      (e): e is StreamSystemNoticeEvent => e.type === 'stream.system_notice',
    );
    expect(notices.length).toBeGreaterThanOrEqual(1);
    expect(notices[0].subtype).toBe('init');
  });

  it('emits stream.text with final:false for each content_block_delta', () => {
    const texts = events.filter((e): e is StreamTextEvent => e.type === 'stream.text');
    // 3 deltas (final:false) + 1 stop (final:true) = 4 events
    const deltas = texts.filter((t) => !t.final);
    expect(deltas.length).toBe(3);
    for (const d of deltas) {
      expect(d.final).toBe(false);
      expect(d.blockId).toBe(0); // index from content_block_start
    }
    // Verify empirical delta content
    expect(deltas[0].textDelta).toBe('\n\nSilent');
    expect(deltas[1].textDelta).toBe(' print statement\nreveals the hidden truth now—\noff');
    expect(deltas[2].textDelta).toBe(' by one, again');
  });

  it('emits stream.text with final:true and empty delta on content_block_stop (AC-2)', () => {
    const texts = events.filter((e): e is StreamTextEvent => e.type === 'stream.text');
    const finalEvents = texts.filter((t) => t.final);
    expect(finalEvents.length).toBe(1);
    expect(finalEvents[0].textDelta).toBe('');
    expect(finalEvents[0].blockId).toBe(0);
  });

  it('suppresses duplicate stream.text from assistant event in streaming mode', () => {
    // The assistant text event (line 7) arrives before content_block_stop.
    // It must be suppressed — we expect 3 delta + 1 final = 4, not 5.
    const texts = events.filter((e): e is StreamTextEvent => e.type === 'stream.text');
    expect(texts.length).toBe(4);
  });

  it('emits stream.usage from result event with all four token fields (AC-3)', () => {
    const usages = events.filter((e): e is StreamUsageEvent => e.type === 'stream.usage');
    expect(usages.length).toBe(1);
    const u = usages[0];
    // Empirical values from capture-4 result event
    expect(u.inputTokens).toBe(3);
    expect(u.outputTokens).toBe(20);
    expect(u.cacheCreationInputTokens).toBe(6289);
    expect(u.cacheReadInputTokens).toBe(12449);
  });

  it('does not emit stream.tool_use or stream.tool_result (text-only session)', () => {
    expect(events.filter((e) => e.type === 'stream.tool_use').length).toBe(0);
    expect(events.filter((e) => e.type === 'stream.tool_result').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Parse error resilience (AC-1)
// ---------------------------------------------------------------------------

describe('Parse error resilience (AC-1)', () => {
  it('emits parse_error for a malformed JSON line', () => {
    const events = parseLines('{"type":"system","subtype":"init"}\ninvalid{json\n{"type":"result","subtype":"success","usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}');
    const parseErrors = events.filter((e): e is ParseErrorEvent => e.type === 'parse_error');
    expect(parseErrors.length).toBe(1);
    expect(parseErrors[0].line).toBe('invalid{json');
    expect(typeof parseErrors[0].error).toBe('string');
    expect(parseErrors[0].error.length).toBeGreaterThan(0);
  });

  it('continues parsing after a malformed line (does NOT halt)', () => {
    const events = parseLines('{"type":"system","subtype":"init"}\ninvalid{json\n{"type":"result","subtype":"success","usage":{"input_tokens":5,"output_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":30}}');
    // The result event after the bad line must still be processed
    const usages = events.filter((e): e is StreamUsageEvent => e.type === 'stream.usage');
    expect(usages.length).toBe(1);
    expect(usages[0].inputTokens).toBe(5);
  });

  it('emits parse_error for a non-object JSON value (array)', () => {
    const events = parseLines('["not","an","object"]\n{"type":"result","subtype":"success","usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}');
    const parseErrors = events.filter((e): e is ParseErrorEvent => e.type === 'parse_error');
    expect(parseErrors.length).toBe(1);
    expect(parseErrors[0].error).toBe('Parsed value is not a JSON object');
  });

  it('emits parse_error for a non-object JSON value (null)', () => {
    const events = parseLines('null\n{"type":"result","subtype":"success","usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}');
    const parseErrors = events.filter((e): e is ParseErrorEvent => e.type === 'parse_error');
    expect(parseErrors.length).toBe(1);
  });

  it('emits parse_error for a bare string value', () => {
    const events = parseLines('"just a string"\n{"type":"result","subtype":"success","usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}');
    const parseErrors = events.filter((e): e is ParseErrorEvent => e.type === 'parse_error');
    expect(parseErrors.length).toBe(1);
  });

  it('accumulates multiple parse_errors independently', () => {
    const events = parseLines('bad1\nbad2\nbad3');
    const parseErrors = events.filter((e): e is ParseErrorEvent => e.type === 'parse_error');
    expect(parseErrors.length).toBe(3);
    expect(parseErrors[0].line).toBe('bad1');
    expect(parseErrors[1].line).toBe('bad2');
    expect(parseErrors[2].line).toBe('bad3');
  });

  it('silently skips empty lines without emitting parse_error', () => {
    const events = parseLines('\n\n\n{"type":"result","subtype":"success","usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}\n');
    const parseErrors = events.filter((e): e is ParseErrorEvent => e.type === 'parse_error');
    expect(parseErrors.length).toBe(0);
  });

  it('parse_error carries the exact malformed line for consumer diagnostics', () => {
    const events = parseLines('this is not json at all!');
    const pe = events.find((e): e is ParseErrorEvent => e.type === 'parse_error');
    expect(pe).toBeDefined();
    expect(pe!.line).toBe('this is not json at all!');
  });
});

// ---------------------------------------------------------------------------
// 4. Rate limit detection (AC-4, RC-2)
// ---------------------------------------------------------------------------

describe('Rate limit detection (AC-4)', () => {
  // Empirically verified format from docs/research/stream-json-semantics.md §3.6.
  // The observed fields are identical; only `status` is changed to "rejected"
  // since no actual rate-limited capture was obtained in Phase γ.
  const RATE_LIMIT_REJECTED = JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected',
      resetsAt: 1776016800,
      rateLimitType: 'five_hour',
      overageStatus: 'rejected',
      overageDisabledReason: 'org_level_disabled',
      isUsingOverage: false,
    },
    uuid: 'test-uuid',
    session_id: 'test-session',
  });

  const RATE_LIMIT_ALLOWED = JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      resetsAt: 1776016800,
      rateLimitType: 'five_hour',
      overageStatus: 'rejected',
      overageDisabledReason: 'org_level_disabled',
      isUsingOverage: false,
    },
    uuid: 'test-uuid',
    session_id: 'test-session',
  });

  it('emits rate_limit_detected when status is "rejected"', () => {
    const events = parseLines(RATE_LIMIT_REJECTED);
    const rl = events.filter((e): e is RateLimitDetectedEvent => e.type === 'rate_limit_detected');
    expect(rl.length).toBe(1);
  });

  it('extracts reset_at from the resetsAt field (AC-4)', () => {
    const events = parseLines(RATE_LIMIT_REJECTED);
    const rl = events.find((e): e is RateLimitDetectedEvent => e.type === 'rate_limit_detected');
    expect(rl?.resetAt).toBe(1776016800);
  });

  it('does NOT emit rate_limit_detected when status is "allowed" (RC-2)', () => {
    const events = parseLines(RATE_LIMIT_ALLOWED);
    const rl = events.filter((e): e is RateLimitDetectedEvent => e.type === 'rate_limit_detected');
    expect(rl.length).toBe(0);
  });

  it('emits rate_limit_detected without resetAt when resetsAt is absent', () => {
    const noResetAt = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'overloaded' },
    });
    const events = parseLines(noResetAt);
    const rl = events.find((e): e is RateLimitDetectedEvent => e.type === 'rate_limit_detected');
    expect(rl).toBeDefined();
    expect(rl?.resetAt).toBeUndefined();
  });

  it('emits rate_limit_detected for any non-allowed status (e.g., "overloaded")', () => {
    const overloaded = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'overloaded', resetsAt: 9999 },
    });
    const events = parseLines(overloaded);
    const rl = events.filter((e): e is RateLimitDetectedEvent => e.type === 'rate_limit_detected');
    expect(rl.length).toBe(1);
    expect(rl[0].resetAt).toBe(9999);
  });
});

// ---------------------------------------------------------------------------
// 5. Arbitrary chunk sizes (RC-1)
// ---------------------------------------------------------------------------

describe('Arbitrary chunk sizes (RC-1)', () => {
  it('1-byte chunks produce identical events to line-by-line feeding', () => {
    const lineByLine = parseFixture('capture-default-mode.jsonl');
    const chunked = parseFixtureChunked('capture-default-mode.jsonl', 1);
    // Compare event types and key fields (not full object identity)
    expect(chunked.map((e) => e.type)).toEqual(lineByLine.map((e) => e.type));
  });

  it('37-byte chunks (prime, arbitrary) produce identical events', () => {
    const lineByLine = parseFixture('capture-default-mode.jsonl');
    const chunked = parseFixtureChunked('capture-default-mode.jsonl', 37);
    expect(chunked.map((e) => e.type)).toEqual(lineByLine.map((e) => e.type));
  });

  it('splits on \\n (LF) only — a lone \\r inside a value is preserved', () => {
    // JSON with a literal \r inside a string value should parse fine.
    // The line must NOT be split at \r.
    const lineWithCR = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'line1\rline2' }],
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      session_id: 's',
      uuid: 'u',
    });
    const events = parseLines(lineWithCR);
    const texts = events.filter((e): e is StreamTextEvent => e.type === 'stream.text');
    expect(texts.length).toBe(1);
    expect(texts[0].textDelta).toBe('line1\rline2');
  });

  it('partial-messages fixture: 1-byte chunks produce identical events', () => {
    const lineByLine = parseFixture('capture-partial-messages.jsonl');
    const chunked = parseFixtureChunked('capture-partial-messages.jsonl', 1);
    expect(chunked.map((e) => e.type)).toEqual(lineByLine.map((e) => e.type));
  });

  it('feedChunk handles a chunk that spans exactly a \\n boundary', () => {
    const line1 = JSON.stringify({ type: 'system', subtype: 'init', uuid: 'u', session_id: 's' });
    const line2 = JSON.stringify({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    const parser = new StreamJsonParser();
    const events: StreamJsonEvent[] = [];
    parser.on('stream.system_notice', (ev) => events.push(ev));
    parser.on('stream.usage', (ev) => events.push(ev));

    const combined = line1 + '\n' + line2 + '\n';
    // Feed in two chunks: first ends right at the \n after line1
    parser.feedChunk(combined.slice(0, line1.length + 1));
    parser.feedChunk(combined.slice(line1.length + 1));
    parser.flush();

    expect(events.length).toBe(2);
    expect(events[0].type).toBe('stream.system_notice');
    expect(events[1].type).toBe('stream.usage');
  });
});

// ---------------------------------------------------------------------------
// 6. Streaming mode — inline synthetic tests for block tracking
// ---------------------------------------------------------------------------

describe('Streaming mode — block type tracking', () => {
  const STREAM_EVENT = (inner: unknown) =>
    JSON.stringify({ type: 'stream_event', event: inner, session_id: 's', uuid: 'u' });

  const CONTENT_BLOCK_START = (index: number, type: string) =>
    STREAM_EVENT({ type: 'content_block_start', index, content_block: { type } });

  const CONTENT_BLOCK_DELTA_TEXT = (index: number, text: string) =>
    STREAM_EVENT({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });

  const CONTENT_BLOCK_DELTA_THINKING = (index: number, thinking: string) =>
    STREAM_EVENT({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } });

  const CONTENT_BLOCK_STOP = (index: number) =>
    STREAM_EVENT({ type: 'content_block_stop', index });

  it('emits stream.thinking deltas with final:false during block', () => {
    const events = parseLines(
      [
        CONTENT_BLOCK_START(0, 'thinking'),
        CONTENT_BLOCK_DELTA_THINKING(0, 'first thought'),
        CONTENT_BLOCK_DELTA_THINKING(0, 'second thought'),
        CONTENT_BLOCK_STOP(0),
      ].join('\n'),
    );
    const thinking = events.filter((e): e is StreamThinkingEvent => e.type === 'stream.thinking');
    expect(thinking.length).toBe(3); // 2 deltas + 1 final
    expect(thinking[0].textDelta).toBe('first thought');
    expect(thinking[0].final).toBe(false);
    expect(thinking[1].textDelta).toBe('second thought');
    expect(thinking[1].final).toBe(false);
    expect(thinking[2].textDelta).toBe('');
    expect(thinking[2].final).toBe(true);
  });

  it('handles interleaved thinking block (index 0) and text block (index 1)', () => {
    const events = parseLines(
      [
        CONTENT_BLOCK_START(0, 'thinking'),
        CONTENT_BLOCK_START(1, 'text'),
        CONTENT_BLOCK_DELTA_THINKING(0, 'I think...'),
        CONTENT_BLOCK_DELTA_TEXT(1, 'Hello'),
        CONTENT_BLOCK_STOP(0),
        CONTENT_BLOCK_STOP(1),
      ].join('\n'),
    );
    const texts = events.filter((e): e is StreamTextEvent => e.type === 'stream.text');
    const thinkings = events.filter(
      (e): e is StreamThinkingEvent => e.type === 'stream.thinking',
    );
    expect(texts[0].textDelta).toBe('Hello');
    expect(texts[0].blockId).toBe(1);
    expect(thinkings[0].textDelta).toBe('I think...');
    expect(thinkings[0].blockId).toBe(0);
    // Final events
    expect(texts[texts.length - 1].final).toBe(true);
    expect(thinkings[thinkings.length - 1].final).toBe(true);
  });

  it('does NOT emit final for a tool_use content_block_stop', () => {
    const ASSISTANT_TOOL_USE = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_test', name: 'Bash', input: { command: 'ls' } }],
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      session_id: 's',
      uuid: 'u',
    });
    const events = parseLines(
      [
        CONTENT_BLOCK_START(0, 'tool_use'),
        ASSISTANT_TOOL_USE,
        CONTENT_BLOCK_STOP(0),
      ].join('\n'),
    );
    // Only stream.tool_use from the assistant event; no stream.text or stream.thinking from stop
    const toolUses = events.filter((e): e is StreamToolUseEvent => e.type === 'stream.tool_use');
    expect(toolUses.length).toBe(1);
    expect(toolUses[0].toolUseId).toBe('toolu_test');
    const texts = events.filter((e): e is StreamTextEvent => e.type === 'stream.text');
    const thinkings = events.filter(
      (e): e is StreamThinkingEvent => e.type === 'stream.thinking',
    );
    expect(texts.length).toBe(0);
    expect(thinkings.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Unknown / unrecognized event types (forward compatibility)
// ---------------------------------------------------------------------------

describe('Unknown event types', () => {
  it('silently ignores unknown top-level types without emitting parse_error', () => {
    const events = parseLines(
      [
        JSON.stringify({ type: 'future_type_v2', some_field: 'value' }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        }),
      ].join('\n'),
    );
    const parseErrors = events.filter((e): e is ParseErrorEvent => e.type === 'parse_error');
    expect(parseErrors.length).toBe(0);
    const usages = events.filter((e): e is StreamUsageEvent => e.type === 'stream.usage');
    expect(usages.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 8. stream.usage field correctness (AC-3)
// ---------------------------------------------------------------------------

describe('stream.usage field correctness (AC-3)', () => {
  it('maps all four token fields from result.usage', () => {
    const events = parseLines(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 100,
          output_tokens: 200,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 400,
        },
      }),
    );
    const u = events.find((e): e is StreamUsageEvent => e.type === 'stream.usage');
    expect(u?.inputTokens).toBe(100);
    expect(u?.outputTokens).toBe(200);
    expect(u?.cacheCreationInputTokens).toBe(300);
    expect(u?.cacheReadInputTokens).toBe(400);
  });

  it('defaults missing token fields to 0', () => {
    const events = parseLines(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 5 },
      }),
    );
    const u = events.find((e): e is StreamUsageEvent => e.type === 'stream.usage');
    expect(u?.inputTokens).toBe(5);
    expect(u?.outputTokens).toBe(0);
    expect(u?.cacheCreationInputTokens).toBe(0);
    expect(u?.cacheReadInputTokens).toBe(0);
  });
});
