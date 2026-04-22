# WebSocket Protocol

Source: plan-draft3.md §Protocol Layer, §Client Render Model, §Web
Dashboard (D17, D18, D19, D20, D42, D49, D50).

Single multiplexed socket per client. Server binds 127.0.0.1 (D57).
Protocol version is pinned in every frame (`v: 1`); mismatches are
refused at `hello` exchange. There is no authentication (D57).

---

## 1. Envelope

### Server → client

```ts
interface ServerFrame {
  v: 1;
  type: ServerFrameType;
  workflowId?: string;  // absent on "hello", "pong", "notice" (global)
  sessionId?: string;   // absent on workflow-scope frames
  seq: number;          // monotonic per session; 0 on non-session frames
  ts: string;           // ISO-8601 UTC
  payload: unknown;     // type-specific; see §2
}
```

`seq` rules:
- Per-session: starts at 1 for the first frame carrying that
  `sessionId`, increments by 1, never skips.
- Non-session frames use `seq: 0`.
- Backfill replays preserve original `seq`.

### Client → server

```ts
interface ClientFrame {
  v: 1;
  type: ClientFrameType;
  id: string;    // client-generated commandId (uuid); idempotency key
  payload: unknown;
}
```

---

## 2. Server frame types

```ts
type ServerFrameType =
  | "hello"
  | "workflow.snapshot"
  | "workflow.update"
  | "workflow.index.update"
  | "item.state"
  | "item.data"
  | "stage.started"
  | "stage.complete"
  | "session.started"
  | "session.ended"
  | "stream.text"
  | "stream.thinking"
  | "stream.tool_use"
  | "stream.tool_result"
  | "stream.usage"
  | "stream.system_notice"
  | "prepost.command.started"
  | "prepost.command.output"
  | "prepost.command.ended"
  | "notice"
  | "error"
  | "pong"
  | "backfill.truncated";
```

### 2.1 `hello`
Sent once on connect before any other frame.

```ts
interface HelloPayload {
  serverVersion: string;   // yoke server semver
  protocolVersion: 1;
  capabilities: string[];  // e.g. ["backfill", "keepalive", "prepost"]
  heartbeatIntervalMs: number;
}
```

Client MUST disconnect if `protocolVersion !== 1`.

### 2.2 `workflow.snapshot`
A full workflow state dump, sent in response to `subscribe`. Includes
item rows (with state and data separated per Issue 3), stage info,
live session rows, `recoveryState` if set, `githubState`.

```ts
interface WorkflowSnapshotPayload {
  workflow: {
    id: string;
    name: string;
    status: string;        // state-machine label
    currentStage: string | null;  // stage id (Issue 1)
    createdAt: string;
    recoveryState?: RecoveryState | null;
    githubState?: GithubState | null;
  };
  stages: StageProjection[];         // ordered stage list (Issue 1)
  items: ItemProjection[];           // item state + display fields (Issue 2, 3)
  activeSessions: SessionProjection[];
  pendingAttention: PendingAttention[];
}

interface StageProjection {
  id: string;
  run: "once" | "per-item";
  phases: string[];
  status: "pending" | "in_progress" | "complete" | "blocked";
  needsApproval: boolean;
}

interface ItemProjection {
  id: string;
  stageId: string;
  state: ItemStateProjection;        // harness state (Issue 3)
  displayTitle: string | null;       // resolved from items_display config
  displaySubtitle: string | null;
  displayDescription: string | null; // resolved from items_display.description
  stableId: string | null;           // manifest items_id (per-item) or null (once)
  dependsOn: string[];               // stable IDs of deps; row UUIDs as fallback
}

interface ItemStateProjection {
  status: string;
  currentPhase: string | null;
  retryCount: number;
  blockedReason: string | null;
}
```

Item user data (the opaque blob) is NOT included in the snapshot by
default — it can be large. The dashboard requests it on demand via
`item.data` frames when the user opens an item detail view (Issue 3).

### 2.3 `workflow.update` / `item.state` / `item.data`
`workflow.update`: partial updates for changed workflow-level fields.

`item.state` (replaces `feature.update`): carries the item ID and
changed harness-state fields only (status, currentPhase, retryCount,
blockedReason). Does NOT include user data (Issue 3).

```ts
interface ItemStatePayload {
  itemId: string;
  stageId: string;
  state: Partial<ItemStateProjection>;
}
```

`item.data`: carries the opaque user data blob for a specific item.
Sent on demand when the dashboard requests it, not pushed automatically.

```ts
interface ItemDataPayload {
  itemId: string;
  data: unknown;  // opaque JSON blob from items.data (Issue 2)
}
```

### 2.3a `stage.started` / `stage.complete` (Issue 1)

```ts
interface StageStartedPayload {
  stageId: string;
  run: "once" | "per-item";
  itemCount?: number;  // for per-item stages
}
interface StageCompletePayload {
  stageId: string;
  nextStageId: string | null;
  needsApproval: boolean;  // whether next stage requires approval
  itemSummary?: {
    complete: number;
    blocked: number;
    abandoned: number;
  };
}
```

### 2.4 `workflow.index.update`
Lightweight update for the sidebar list — id, name, status,
`updatedAt`, `unreadEvents` — never contains stream content. Sent to
every connected client regardless of subscription (§Subscription model).

### 2.5 `session.started` / `session.ended`

```ts
interface SessionStartedPayload {
  sessionId: string;
  phase: string;
  attempt: number;
  startedAt: string;
  parentSessionId?: string | null;
}
interface SessionEndedPayload {
  sessionId: string;
  endedAt: string;
  exitCode: number | null;
  statusFlags: Record<string, number | boolean>;
  reason: "ok" | "fail" | "cancelled" | "rate_limited" | "tainted";
}
```

### 2.6 `stream.*` — normalized render model (D18)

Server emits **normalized** events, not raw stream-json. See
`protocol-stream-json.md` for the parser that produces these.

```ts
interface StreamText {
  sessionId: string;
  blockId: string;           // stable per content block
  textDelta: string;         // accumulates on client
  final?: boolean;           // true on content_block_stop
}
interface StreamThinking {
  sessionId: string;
  blockId: string;
  textDelta: string;
  final?: boolean;
}
interface StreamToolUse {
  sessionId: string;
  toolUseId: string;
  name: string;
  input: unknown;
  status: "pending" | "running";
}
interface StreamToolResult {
  sessionId: string;
  toolUseId: string;
  status: "ok" | "error";
  output: unknown;
}
interface StreamUsage {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  rawUsage: unknown;
}
interface StreamSystemNotice {
  sessionId?: string;
  severity: "info" | "warn" | "error";
  source:
    | "harness"
    | "stderr"
    | "heartbeat"
    | "rate_limit"
    | "hook"
    | "recovery";
  message: string;
  extra?: unknown;
}
```

### 2.7 `prepost.command.*` (D50 frame additions)

```ts
interface PrepostCommandStarted {
  runId: number;              // prepost_runs.id
  phase: string;
  when: "pre" | "post";
  name: string;
  argv: string[];
  startedAt: string;
}
interface PrepostCommandOutput {
  runId: number;
  stream: "stdout" | "stderr";
  chunk: string;              // UTF-8; caller truncates per render model
}
interface PrepostCommandEnded {
  runId: number;
  exitCode: number;
  action: unknown;            // ResolvedAction from pre-post-action-grammar.md
  endedAt: string;
}
```

Frames for `post:` commands are rendered in the live pane as
`SystemNotice` rows, left-rule-accented, per D50 ("same rendering path
as SystemNotice").

### 2.8 `notice` / `error`

```ts
interface NoticePayload {
  severity: "info" | "requires_attention";
  kind: string;
  message: string;
  persistedAttentionId?: number;
}
interface ErrorPayload {
  code: string;    // "PROTOCOL_MISMATCH", "SUBSCRIPTION_LIMIT", ...
  message: string;
  commandId?: string;
}
```

### 2.9 `pong`
Response to `ping`, carries the `id` of the ping frame.

### 2.10 `backfill.truncated`

```ts
interface BackfillTruncatedPayload {
  workflowId: string;
  sinceSeq: number;
  minAvailableSeq: number;
  httpFetchUrl: string;       // GET /api/sessions/:id/log?sinceSeq=...&limit=...
}
```

---

## 3. Client frame types

```ts
type ClientFrameType =
  | "subscribe"
  | "unsubscribe"
  | "control"
  | "ack"
  | "ping";

interface SubscribePayload {
  workflowId: string;
  sinceSeq?: number;
}
interface UnsubscribePayload {
  workflowId: string;
}
interface ControlPayload {
  workflowId: string;
  action:
    | "pause"
    | "resume"
    | "cancel"
    | "skip"
    | "rerun-phase"
    | "inject-context"
    | "unblock"
    | "retry"
    | "approve-stage";       // Issue 1: approve a stage with needs_approval
  itemId?: string;            // renamed from featureId (Issue 2)
  stageId?: string;           // for approve-stage action (Issue 1)
  extra?: unknown;            // e.g. inject-context text
}
interface AckPayload {
  lastAppliedSeq: number;
  sessionId: string;
}
interface PingPayload {
  clientTs: string;
}
```

Server is idempotent on `ClientFrame.id`: a repeated id within 5 min
returns the previous response.

---

## 4. Lifecycle

```
client → ws:/stream
server → hello                             (seq=0)
client → subscribe { workflowId, sinceSeq? }
server → workflow.snapshot                 (seq=0)
server → (backfill frames)                 (seq=original)
   ...  or ...
server → backfill.truncated                (seq=0)
         then snapshot only, no replay
server → (live frames)                     (seq++)
client → ack { lastAppliedSeq }            (opportunistic)
client → unsubscribe { workflowId }
server → (stops sending workflow-scoped frames)
```

- Multiple subscriptions are interleaved on one socket. `workflowId`
  discriminates.
- Subscription cap is 4 concurrent streaming workflows per client
  (plan-draft3 §Subscription model). Extras receive only
  `workflow.index.update` and must fall back to polled snapshots.
- `ack` is advisory; the server never waits for it. Its purpose is to
  trim retained backfill buffers when all subscribers have acknowledged
  past a seq.

---

## 5. Reconnect / backfill flow

1. Client reconnects and sends `subscribe { workflowId, sinceSeq: N }`.
2. Server loads session log index and computes the earliest retained
   seq for each active session.
3. If `N ≥ earliestRetained − 1`, server replays frames `N+1..latest`
   in original order with original `seq`, then switches to live.
4. Else server emits `backfill.truncated` with a URL to page the full
   log. Client fetches HTTP, merges into its virtualized list, then
   switches to live.
5. Dedupe: client keeps a `(sessionId, seq)` high-water mark and drops
   anything `seq <= lastApplied` (plan-draft3 §Backfill on reconnect).

---

## 6. Sequence rules & invariants

- `stream.text` deltas for a given `blockId` always increase in seq
  until one of them has `final: true`; thereafter no new delta arrives
  for that block.
- `stream.tool_result` always arrives after the matching
  `stream.tool_use` for the same `toolUseId`. If a reconnect drops the
  `tool_use`, the client MUST treat an orphan `tool_result` as an
  error and request a snapshot.
- `prepost.command.ended` always follows `prepost.command.started`
  with the same `runId`. A dropped start invalidates the run row — the
  client requests a snapshot.
- `session.ended` is the terminal frame for a given `sessionId`; no
  `stream.*` frame for that session may arrive afterward.

---

## 7. HTTP companion endpoints

Used by backfill and by flows the WS doesn't carry:

| Method + path | Purpose |
|---|---|
| `GET /api/workflows?status=&q=&before=&limit=` | keyset pagination (D47) |
| `GET /api/workflows/:id/timeline` | merged SQLite events + JSONL (§Obs, D34) |
| `GET /api/sessions/:id/log?sinceSeq=&limit=` | paged stream-json fetch (D48a) |
| `GET /api/workflows/:id/usage?groupBy=feature|phase|profile|session` | token aggregates |
| `GET /api/workflows/:id/usage/timeseries?bucket=hour|day` | usage timeseries |
| `POST /api/workflows/:id/control` | idempotent manual control (mirrors WS `control`) |
| `POST /api/workflows/:id/attention/:attentionId/ack` | clear pending attention |

All endpoints bind 127.0.0.1 (D57).

---

## 8. TypeScript type definition block (authoritative)

```ts
export type ServerFrameType =
  | "hello"
  | "workflow.snapshot"
  | "workflow.update"
  | "workflow.index.update"
  | "item.state"
  | "item.data"
  | "stage.started"
  | "stage.complete"
  | "session.started"
  | "session.ended"
  | "stream.text"
  | "stream.thinking"
  | "stream.tool_use"
  | "stream.tool_result"
  | "stream.usage"
  | "stream.system_notice"
  | "prepost.command.started"
  | "prepost.command.output"
  | "prepost.command.ended"
  | "notice"
  | "error"
  | "pong"
  | "backfill.truncated";

export type ClientFrameType =
  | "subscribe"
  | "unsubscribe"
  | "control"
  | "ack"
  | "ping";

export interface ServerFrame<T = unknown> {
  v: 1;
  type: ServerFrameType;
  workflowId?: string;
  sessionId?: string;
  seq: number;
  ts: string;
  payload: T;
}

export interface ClientFrame<T = unknown> {
  v: 1;
  type: ClientFrameType;
  id: string;
  payload: T;
}

export interface RecoveryState {
  recoveredAt: string;
  priorStatus: string;
  resumeMethod: "continue" | "fresh";
  uncommittedChanges: boolean;
  lastKnownSessionId: string | null;
}

export interface GithubState {
  status:
    | "disabled"
    | "unconfigured"
    | "idle"
    | "creating"
    | "created"
    | "failed";
  prNumber?: number;
  prUrl?: string;
  prState?: "open" | "merged" | "closed";
  error?: string;
  lastCheckedAt?: string;
}

export interface PendingAttention {
  id: number;
  kind: string;
  payload: unknown;
  createdAt: string;
}
```

---

## 9. Error handling

- Server closes the socket with code 4001 on protocol version mismatch.
- Server closes with 4002 on subscription cap exceeded after sending
  `error { code: "SUBSCRIPTION_LIMIT" }`.
- Malformed client frame → `error { code: "BAD_FRAME" }`, socket stays
  open.
- Server-side fatal → `error { code: "INTERNAL" }` then close.
- Client SHOULD reconnect with exponential backoff capped at 30 s and
  resume with `subscribe { sinceSeq }` for any active workflow.
