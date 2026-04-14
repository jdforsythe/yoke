# stream-json Parser Spec (NDJSON)

Source: plan-draft3.md §Protocol Layer → stream-json parsing (D15, D16),
§Rate-limit handling (D61), §Failure Modes table rows for malformed
stream-json and line > 16 MB.

This document defines the line-buffered NDJSON reader that consumes the
stdout of a spawned agent command. **Framing is asserted** as NDJSON —
one JSON object per `\n`-terminated line — and the assertion itself is
the Phase γ research task; this spec marks specific fields TBD where
empirical verification is required before implementation.

The parser is command-agnostic. It runs against the stdout of whatever
`spawn(phase.command, phase.args)` launched (plan-draft3 §Process
Management, D55). It does not assume Claude Code specifically; any
command whose stdout is NDJSON with compatible event shapes can drive
the normalized render model. In practice, v1 depends on Claude Code's
stream-json shape.

---

## 1. Buffer management

```ts
interface LineReader {
  feed(chunk: Buffer): void;   // invoked from child.stdout 'data'
  close(): void;               // child.stdout 'end'
}
```

Implementation contract:

1. Maintain a growing `Buffer` of unprocessed bytes.
2. On each chunk, append to the buffer, then scan for `0x0a` (`\n`).
3. For every complete line up to the last newline:
   - Slice the bytes, UTF-8 decode them, emit a `LineEvent`.
4. Carry the tail (after the last newline) forward.
5. Never call `JSON.parse` on raw `'data'` chunks (plan-draft3 explicit).

Preferred implementation: `readline.createInterface({ input:
child.stdout, crlfDelay: Infinity })`. A hand-rolled splitter is
acceptable if readline's line-length limit becomes a blocker; both
paths MUST apply the sanity caps in §4.

---

## 2. Parse pipeline

```
stdout bytes
  └─▶ LineReader.feed()
        └─▶ for each complete line:
              ├─ sanity cap check (§4)
              ├─ JSON.parse
              │   ├─ ok → classify + emit normalized frame
              │   └─ fail → bump sessions.status_flags.parse_errors,
              │             write an `events` row, skip line
              └─ stop-loss: if parse_errors > configured threshold in
                             <N seconds, raise session_fail
                             (classifier=transient) and let the
                             retry ladder decide
```

Output of the pipeline is the normalized render model in
`protocol-websocket.md` §2.6 (StreamText, StreamThinking, StreamToolUse,
StreamToolResult, StreamUsage, StreamSystemNotice). The parser writes
these into the Session Log Store and emits them as WS frames in the
same code path.

---

## 3. Event classification

The parser dispatches on a wire event `type` field. The exact values
are **TBD per Phase γ research** (see runbook Phase γ task
"capture real Claude Code behavior: stream-json framing, token usage
events, rate-limit frames"). The table below is the intended mapping;
any field marked `TBD` is filled in from `docs/research/stream-json.md`
before Phase δ implementation.

| Wire event class | Normalized frame | Extraction notes |
|---|---|---|
| text content delta (`content_block_delta` or equivalent, TBD) | `StreamText` | `textDelta` from the event's text field; `blockId` from the parent content_block index |
| thinking content delta | `StreamThinking` | same shape as text |
| content_block_stop | close out `StreamText` / `StreamThinking` block | emit `final: true` on the last frame for that `blockId` |
| tool_use start | `StreamToolUse` status=`running` | `name`, `input`, `toolUseId` |
| tool_use complete | — | no emission (the matching tool_result is the observable event) |
| tool_result | `StreamToolResult` | `toolUseId`, `output`, `status` |
| usage delta (message_delta / message_stop, TBD) | `StreamUsage` | all four token columns + opaque `raw_usage` |
| rate_limit error frame (TBD) | `StreamSystemNotice{source: "rate_limit"}` | parse `reset_at`; raise `rate_limit_detected` event |
| generic error frame | `StreamSystemNotice{source: "harness", severity: "error"}` | routed to state machine per classifier |
| session start / end meta | `session.started` / `session.ended` | top-level WS frames |

Any wire event whose `type` is unrecognized is logged at level `warn`
and dropped from the render model (never crashes the parser).

---

## 4. Sanity caps

Enforced in the LineReader before `JSON.parse`:

| Cap | Value | Behavior on breach |
|---|---|---|
| Max line length | 16 MB | Truncate the line, set `sessions.status_flags.tainted = true`, emit a `StreamSystemNotice{severity: "warn", source: "harness"}` |
| Max buffered bytes between newlines | 16 MB | Same as above |
| Max parse errors per minute | Configurable, default 10 | Emit `session_fail` with classifier `transient`; state machine routes through retry ladder |
| Max total bytes per session | From `retention.stream_json_logs.max_total_bytes` | Truncate persisted log, keep streaming to UI, flag session `tainted` |
| Max events in WS backfill buffer | `10_000` per session (mirror of D41 client cap) | Older events only available via `GET /api/sessions/:id/log` |

---

## 5. stderr handling

**stderr is a separate stream** (plan-draft3 §stream-json parsing):

- `child.stderr.on('data', capture)` → per-session stderr file at
  `.yoke/logs/<session-id>.stderr`.
- Each chunk is scanned line-by-line for known patterns (auth
  failure, ENOENT, spawn error) and routed to
  `StreamSystemNotice{source: "stderr"}`.
- Chunks are never fed into the JSON line reader.
- stderr has its own cap (1 MB default); exceeding caps truncates and
  flags `status_flags.stderr_truncated = true`.
- ENOENT on child spawn arrives as a `'error'` event on the
  ChildProcess, not in stderr — the parser is unrelated; it's handled
  by Process Manager's spawn-error path.

---

## 6. Token usage extraction

Token usage columns on the `sessions` row (plan-draft3 §SQLite Schema,
D16):

- `input_tokens`
- `output_tokens`
- `cache_creation_input_tokens`
- `cache_read_input_tokens`
- `raw_usage` (opaque JSON escape hatch)

Rules:

1. The parser treats usage events as **cumulative for the session it
   is parsing**, not deltas. If Phase γ research shows Claude emits
   deltas, the parser converts to cumulative by accumulating in-parser
   and writing the total to SQLite; `raw_usage` preserves the original.
2. On `-c` continuation, the resumed session row has
   `parent_session_id = <prior session>`. Per-feature totals are
   computed by summing across a session chain in SQL:
   `WITH RECURSIVE chain AS (...)`.
3. Exact event carrying usage: **TBD per Phase γ research**.
4. On session end, a final usage snapshot is written inside the same
   transaction as the session-ended event, so `GET /api/workflows/:id
   /usage` always sees a consistent total.

---

## 7. Rate-limit frame detection (D61)

Trigger: a wire event whose type indicates rate-limit exhaustion. The
parser's response:

1. Extract `reset_at` if present; otherwise use the exponential-backoff
   default (start at 60 s, double per occurrence within a 30-minute
   window, cap at 30 minutes).
2. Emit `StreamSystemNotice{source: "rate_limit", severity: "warn"}`
   with the reset timestamp.
3. Raise a `rate_limit_detected` state-machine event.
4. Suppress heartbeat stall warnings for the duration of the
   `rate_limited` state (plan-draft3 §Heartbeat + §State Machine row
   9).
5. Do NOT kill the child process; the session may still be mid-stream
   and Claude Code's own retry semantics are TBD. The Pipeline Engine
   handles resumption via a fresh session after the window (D61 v1
   passive path).

The exact wire shape of the rate-limit frame is **TBD per Phase γ
research** and filled into `docs/research/stream-json.md` before
Phase δ.

---

## 8. Persistence path

Every parsed line is written to the Session Log Store alongside the
normalized frame:

```
.yoke/logs/<session-id>.jsonl        ← raw NDJSON lines, 1:1 with stdout
.yoke/logs/<session-id>.stderr       ← per-chunk stderr capture
.yoke/logs/<session-id>.meta.json    ← per-session index:
                                        {firstSeq, lastSeq, parseErrors,
                                         tainted, truncated, usage}
```

The raw JSONL is the source of truth for replay; the normalized frame
stream is a projection. `yoke record` mode captures these files
verbatim as fixtures (plan-draft3 §Testability D32).

---

## 9. Error handling summary

| Condition | Recorded as | State-machine effect |
|---|---|---|
| unparsable line | `events.event_type = "stream.parse_error"` + status_flags bump | none (unless threshold breached) |
| line > 16 MB | `events.event_type = "stream.line_truncated"` + `tainted` flag | none |
| stderr > 1 MB | `events.event_type = "stream.stderr_truncated"` | none |
| child crashed mid-line | final parse error on the tail | `session_fail` via Process Manager exit path |
| rate-limit frame detected | `events.event_type = "stream.rate_limit_detected"` | raise `rate_limit_detected` |
| usage event in unknown shape | log raw to `raw_usage`, zero the four columns for that emission | none |

All events respect the structured log schema (plan-draft3 §Observability
D34): `{ts, workflow_id, feature_id, phase, session_id, attempt,
event_type, level, message, extra}`.

---

## 10. What Phase γ research must answer

Before Phase δ starts, `docs/research/stream-json.md` must fill in:

1. **Framing empirical check** — is Claude Code stream-json strictly
   NDJSON? Any multi-line events? Any CRLF cases?
2. **Event type inventory** — the full set of `type` values emitted
   for a typical implement session and the minimal subset used in
   review sessions.
3. **Usage event shape** — which event carries token usage, whether
   it is delta or cumulative, and whether `-c` resumption double-counts.
4. **Rate-limit frame shape** — which event indicates rate limiting,
   whether it carries a reset timestamp, whether it coexists with a
   session exit or precedes one.
5. **tool_use / tool_result correlation** — the exact field name
   linking a result to its originating use (`tool_use_id` assumed).
6. **content_block boundaries** — whether `content_block_stop` is
   reliably emitted, or whether the parser must infer block closure
   from message boundaries.

Until then, the parser ships with these as pluggable table lookups
referenced from `docs/research/stream-json.md` so a spec update does
not require a code change.
