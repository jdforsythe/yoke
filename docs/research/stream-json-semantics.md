# stream-json Empirical Semantics

Phase γ research deliverable. Answers the TBD questions from
`docs/design/protocol-stream-json.md` §10 and fills the event
classification table in §3.

Captured 2026-04-12 using Claude Code 2.1.104 with model
`claude-opus-4-6`.

---

## 1. Framing

**Verdict: strictly NDJSON.** One JSON object per LF-terminated line.

| Property | Observed |
|---|---|
| Delimiter | `0x0a` (`\n`) only — no CRLF, no bare CR |
| Multi-line objects | None. Every line parses independently via `JSON.parse` |
| Embedded newlines in values | JSON-escaped as `\n` within string fields |
| Trailing LF on last line | Yes, always present |
| Max line length observed | ~8.9 KB (a `tool_use` event carrying a 200-line Python file via the Write tool) |

**Parser recommendation:** `readline.createInterface({ input: child.stdout,
crlfDelay: Infinity })` is correct. The 16 MB sanity cap from the spec is
generous but fine to keep. No need for a hand-rolled splitter.

**`--verbose` is required.** `--output-format stream-json` with `--print`
produces a validation error unless `--verbose` is passed. The error is
written to stdout (not stderr), which means a parser that doesn't pass
`--verbose` will see a non-JSON error string as the first "line".

Capture files for verification:
- `/tmp/yoke-capture-1.jsonl` — 12 lines, 14 KB, tool_use session (3 Bash calls)
- `/tmp/yoke-capture-2.jsonl` — 7 lines, 28 KB, large Write tool session
- `/tmp/yoke-capture-3a.jsonl` — 11 lines, 14 KB, simple text + memory writes
- `/tmp/yoke-capture-4.jsonl` — 12 lines, with `--include-partial-messages`
- `/tmp/yoke-capture-5.jsonl` — with `--include-hook-events`

---

## 2. Event type vocabulary

### 2.1 Default mode (no special flags)

Five event types. Every event has `type`, `uuid`, `session_id` fields.

| `type` | `subtype` | When emitted | Count per session |
|---|---|---|---|
| `system` | `init` | First event, before any API call | Exactly 1 |
| `assistant` | — | After each API response, one event per content block | 1+ per API call |
| `user` | — | After each tool execution (tool_result) | 1 per tool_use |
| `rate_limit_event` | — | After the final API call in a turn | 1 per session (observed) |
| `result` | `success` | Last event | Exactly 1 |

The `result` event `subtype` is `success` in all captures. Error
subtype not observed; the `is_error` boolean field exists (always
`false` in captures).

### 2.2 With `--include-partial-messages`

Adds one additional top-level event type:

| `type` | When emitted |
|---|---|
| `stream_event` | During API streaming, wrapping Anthropic SSE events |

The `stream_event` envelope has structure:

```json
{
  "type": "stream_event",
  "event": { "type": "<anthropic-sse-type>", ... },
  "session_id": "...",
  "parent_tool_use_id": null,
  "uuid": "..."
}
```

Observed SSE event types inside `event.type`:

| SSE type | Description |
|---|---|
| `message_start` | Initial message with empty `content[]`, has input-token usage |
| `content_block_start` | Block header with `index` and `content_block.type` |
| `content_block_delta` | Incremental content delta |
| `content_block_stop` | Marks end of a content block by `index` |
| `message_delta` | Final delta with `stop_reason` and cumulative usage |
| `message_stop` | Marks end of the message |

Delta subtypes observed in `content_block_delta.delta.type`:
- `text_delta` — `{ "type": "text_delta", "text": "..." }`
- `thinking_delta` expected but not captured (thinking was too short to chunk)
- `input_json_delta` expected for tool_use blocks (not captured)

**Recommendation for Yoke:** Use `--include-partial-messages` for the live
streaming UI (realtime text rendering). Use the default mode events
(`assistant`, `user`) for state tracking and persistence. Both are emitted
in the same stream when the flag is set — the `stream_event` deltas
arrive first, then the complete `assistant` event.

### 2.3 With `--include-hook-events`

Adds two `system` subtypes:

| `type` | `subtype` | Shape |
|---|---|---|
| `system` | `hook_started` | `{ hook_id, hook_name, hook_event }` |
| `system` | `hook_response` | `{ hook_id, hook_name, hook_event, exit_code, outcome, stdout, stderr, output }` |

**Recommendation for Yoke:** Use `--include-hook-events` to observe
pre/post command hooks and their outcomes. The `hook_id` field correlates
started/response pairs.

---

## 3. Event shapes (abbreviated examples from captures)

### 3.1 `system` (subtype: `init`)

```json
{
  "type": "system",
  "subtype": "init",
  "cwd": "/Users/jforsythe/dev/ai/yoke",
  "session_id": "313ccbb6-6dd1-41d0-bbdc-106762a34a7d",
  "model": "claude-opus-4-6",
  "tools": ["Bash", "Edit", "Read", "Write", "..."],
  "mcp_servers": [{"name": "...", "status": "connected"}],
  "permissionMode": "default",
  "claude_code_version": "2.1.104",
  "agents": ["general-purpose", "Explore", "Plan", "..."],
  "skills": ["commit", "simplify", "..."],
  "plugins": [{"name": "...", "path": "...", "source": "..."}],
  "slash_commands": ["..."],
  "apiKeySource": "none",
  "output_style": "default",
  "fast_mode_state": "off",
  "uuid": "..."
}
```

### 3.2 `assistant` — text content block

```json
{
  "type": "assistant",
  "message": {
    "model": "claude-opus-4-6",
    "id": "msg_01ErXEnQw5F6Ss6qnhPzDMNh",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "text",
        "text": "Here are three ways to reverse a string..."
      }
    ],
    "stop_reason": null,
    "stop_sequence": null,
    "stop_details": null,
    "usage": { "input_tokens": 3, "output_tokens": 31, "..." : "..." },
    "context_management": null
  },
  "parent_tool_use_id": null,
  "session_id": "...",
  "uuid": "..."
}
```

### 3.3 `assistant` — thinking content block

```json
{
  "type": "assistant",
  "message": {
    "...": "same envelope as text",
    "content": [
      {
        "type": "thinking",
        "thinking": "The user wants three ways to reverse...",
        "signature": "EpgCClkIDBgCKkB5tSxs..."
      }
    ]
  },
  "parent_tool_use_id": null,
  "session_id": "...",
  "uuid": "..."
}
```

### 3.4 `assistant` — tool_use content block

```json
{
  "type": "assistant",
  "message": {
    "...": "same envelope",
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_01HMu1oJ9D65uiLtzxm9eeYa",
        "name": "Bash",
        "input": {
          "command": "python3 -c \"...\"",
          "description": "Test string reversal via slicing"
        },
        "caller": { "type": "direct" }
      }
    ]
  },
  "parent_tool_use_id": null,
  "session_id": "...",
  "uuid": "..."
}
```

### 3.5 `user` — tool_result

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "tool_use_id": "toolu_01HMu1oJ9D65uiLtzxm9eeYa",
        "type": "tool_result",
        "content": "Slicing: \"hello world\" -> \"dlrow olleh\" ✓\n[rerun: b1]",
        "is_error": false
      }
    ]
  },
  "parent_tool_use_id": null,
  "session_id": "...",
  "uuid": "...",
  "timestamp": "2026-04-12T13:37:06.297Z",
  "tool_use_result": {
    "stdout": "Slicing: \"hello world\" -> \"dlrow olleh\" ✓",
    "stderr": "",
    "interrupted": false,
    "isImage": false,
    "noOutputExpected": false
  }
}
```

### 3.6 `rate_limit_event`

```json
{
  "type": "rate_limit_event",
  "rate_limit_info": {
    "status": "allowed",
    "resetsAt": 1776016800,
    "rateLimitType": "five_hour",
    "overageStatus": "rejected",
    "overageDisabledReason": "org_level_disabled",
    "isUsingOverage": false
  },
  "uuid": "...",
  "session_id": "..."
}
```

**Rate limit observations:**
- `status` is `"allowed"` in all captures; presumably `"rejected"` when rate-limited.
- `resetsAt` is a Unix timestamp (seconds).
- `rateLimitType` was `"five_hour"` in all captures.
- No separate "rate limit error frame" was observed. The rate limit
  event appears to be an informational status, not an error. Whether
  Claude Code emits a different event when actually rate-limited (status
  = "rejected") is untested — would require hitting the rate limit.

### 3.7 `result` (subtype: `success`)

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 18907,
  "duration_api_ms": 18741,
  "num_turns": 4,
  "result": "All three pass. Summary: ...",
  "stop_reason": "end_turn",
  "session_id": "...",
  "total_cost_usd": 0.147376,
  "usage": {
    "input_tokens": 4,
    "cache_creation_input_tokens": 19346,
    "cache_read_input_tokens": 18637,
    "output_tokens": 685,
    "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
    "service_tier": "standard",
    "cache_creation": {
      "ephemeral_1h_input_tokens": 19346,
      "ephemeral_5m_input_tokens": 0
    },
    "inference_geo": "",
    "iterations": [
      {
        "input_tokens": 1,
        "output_tokens": 141,
        "cache_read_input_tokens": 18637,
        "cache_creation_input_tokens": 709,
        "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 709 },
        "type": "message"
      }
    ],
    "speed": "standard"
  },
  "modelUsage": {
    "claude-opus-4-6": {
      "inputTokens": 4,
      "outputTokens": 685,
      "cacheReadInputTokens": 18637,
      "cacheCreationInputTokens": 19346,
      "webSearchRequests": 0,
      "costUSD": 0.147376,
      "contextWindow": 200000,
      "maxOutputTokens": 64000
    }
  },
  "permission_denials": [],
  "terminal_reason": "completed",
  "fast_mode_state": "off",
  "uuid": "..."
}
```

---

## 4. Token usage semantics

### 4.1 Per-event vs cumulative

| Source | Semantics |
|---|---|
| `assistant.message.usage` | Per-API-call usage. All content blocks from the same API call share identical values. |
| `result.usage` | Session-cumulative totals |
| `result.usage.iterations[]` | Per-API-call breakdown (but observed incomplete — see §4.3) |
| `result.modelUsage` | Per-model cumulative totals (keyed by model name, camelCase fields) |
| `stream_event` `message_delta.usage` | Cumulative for the current API call, includes `iterations[]` |

### 4.2 Usage fields

Fields on `assistant.message.usage`:

| Field | Type | Notes |
|---|---|---|
| `input_tokens` | number | Input tokens for this API call |
| `output_tokens` | number | Output tokens for this API call |
| `cache_creation_input_tokens` | number | Tokens written to prompt cache |
| `cache_read_input_tokens` | number | Tokens read from prompt cache |
| `cache_creation.ephemeral_5m_input_tokens` | number | 5-min cache tier |
| `cache_creation.ephemeral_1h_input_tokens` | number | 1-hour cache tier |
| `service_tier` | string | `"standard"` observed |
| `inference_geo` | string | `"not_available"` or empty |

Additional fields on `result.usage`:

| Field | Type | Notes |
|---|---|---|
| `server_tool_use.web_search_requests` | number | |
| `server_tool_use.web_fetch_requests` | number | |
| `iterations[]` | array | Per-API-call breakdown |
| `speed` | string | `"standard"` observed |

Additional fields on `result.modelUsage.<model>`:

| Field | Type | Notes |
|---|---|---|
| `costUSD` | number | Computed cost for this model |
| `contextWindow` | number | Model context window (200000) |
| `maxOutputTokens` | number | Model max output (64000) |
| `webSearchRequests` | number | |

### 4.3 Iterations array caveat

In capture 1, a session with 2 API calls (4 turns) had only 1 entry in
`iterations[]`. The entry matched the LAST API call's usage, not the
first. The cumulative `result.usage` totals were correct (sum of both
calls). This suggests `iterations[]` may be incomplete or may only
report the final API call.

**Recommendation for Yoke:** Use `result.usage` for session totals. Use
`result.modelUsage` for per-model breakdown and cost. Do not rely on
`iterations[]` for per-call breakdown — it may be incomplete. For
per-turn usage, accumulate from per-`assistant`-event
`message.usage.output_tokens` (grouping by `message.id` to avoid
double-counting content blocks from the same API call).

### 4.4 Usage is NOT delta across turns

The usage on `assistant` events from the same API call is identical (not
cumulative deltas). This was verified: lines 2-8 in capture 1 all shared
`message.id = msg_01ErXEnQw5F6Ss6qnhPzDMNh` and had identical
`usage.input_tokens = 3, usage.output_tokens = 31`.

---

## 5. Content block emission model

A single API response can contain multiple content blocks (e.g.,
thinking + text + tool_use + tool_use + tool_use). Claude Code emits
these as **separate `assistant` events**, each containing exactly ONE
content block. All share the same `message.id`.

For tool_use blocks within a multi-tool response, Claude Code executes
tools **sequentially**: emit tool_use → run tool → emit tool_result →
emit next tool_use → run tool → emit tool_result → etc.

This means:
- `message.id` identifies API call boundaries
- Multiple `assistant` events with the same `message.id` are from the same API response
- `user` (tool_result) events are interleaved between `assistant` (tool_use) events from the same message

### 5.1 `stop_reason`

On `assistant` events: always `null` (in default mode without partial messages).

On `result` event: `"end_turn"` for normal completion.

With `--include-partial-messages`: `stop_reason` appears in the
`message_delta` SSE event as `delta.stop_reason`.

### 5.2 `content_block_stop` boundaries

Observed reliably in `--include-partial-messages` mode as `stream_event`
with `event.type = "content_block_stop"` and `event.index` matching the
content block's index.

In default mode (without partial messages), block boundaries are implicit:
each `assistant` event IS a complete block.

---

## 6. Tool use / tool result correlation

| Field | Location | Format |
|---|---|---|
| Tool use ID | `assistant.message.content[0].id` | `"toolu_01HMu1oJ9D65uiLtzxm9eeYa"` |
| Tool name | `assistant.message.content[0].name` | `"Bash"`, `"Write"`, etc. |
| Tool input | `assistant.message.content[0].input` | Object (tool-specific) |
| Tool caller | `assistant.message.content[0].caller` | `{ "type": "direct" }` |
| Result link | `user.message.content[0].tool_use_id` | Matches the tool use ID |
| Result content | `user.message.content[0].content` | String (tool stdout + Claude Code annotations) |
| Result error | `user.message.content[0].is_error` | Boolean |
| Structured result | `user.tool_use_result` | `{ stdout, stderr, interrupted, isImage, noOutputExpected }` |

The `tool_use_result` top-level field on `user` events provides
structured tool output separate from the API-format `content` field.
This is the preferred source for the parser since it separates
stdout/stderr.

---

## 7. `parent_tool_use_id`

Present on every `assistant` and `user` event. Value is `null` for
top-level events. Expected to be non-null for subagent tool calls
(Agent tool), though this was not tested. This field enables Yoke to
track nested agent hierarchies.

---

## 8. Parser implementation recommendations

1. **Line reader:** `readline.createInterface` with the child's stdout.
   16 MB sanity cap is fine but unlikely to be hit.

2. **Dispatch hierarchy:**
   ```
   event.type →
     "system"           → event.subtype → "init" | "hook_started" | "hook_response"
     "assistant"        → event.message.content[0].type → "thinking" | "text" | "tool_use"
     "user"             → tool result (extract from message + tool_use_result)
     "rate_limit_event" → rate limit status
     "stream_event"     → event.event.type → (Anthropic SSE types)
     "result"           → session complete
   ```

3. **API call grouping:** Use `assistant.message.id` to group content blocks
   from the same API response.

4. **Recommended flags for spawning Claude Code:**
   ```
   claude --verbose -p <prompt> \
     --output-format stream-json \
     --include-partial-messages \
     --include-hook-events
   ```
   - `--verbose`: required for stream-json
   - `--include-partial-messages`: enables realtime text streaming to UI
   - `--include-hook-events`: enables hook lifecycle tracking

5. **Usage extraction:** Read from `result.usage` for session totals.
   For live tracking, accumulate `output_tokens` from `assistant` events,
   deduplicating by `message.id`.

6. **stderr:** Keep as a separate stream. Not part of the NDJSON output.
   The `--verbose` error message goes to stdout, not stderr.

---

## 9. Open questions (not answered by this research)

1. **Error result shape.** The `result` event `subtype` was `"success"` in
   all captures. The error subtype (e.g., when the model refuses, when the
   session hits max budget, or when the process crashes) is unknown. The
   `is_error` field exists but was always `false`.

2. **Rate-limited session behavior.** The `rate_limit_event.rate_limit_info.status`
   was always `"allowed"`. What the stream looks like when actually
   rate-limited (status = "rejected") is untested.

3. **`context_management` field.** Present on all `assistant.message` objects,
   always `null` in captures. May contain compression/context-window
   management data for long sessions.

4. **Subagent `parent_tool_use_id`.** Expected to be non-null for Agent
   tool calls but not verified. A capture using the Agent tool would
   confirm.

5. **`iterations[]` completeness.** The per-call breakdown in
   `result.usage.iterations[]` appeared incomplete (1 entry for a 2-call
   session). Needs further investigation.
