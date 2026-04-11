# Frontend Critique — plan-draft2.md

## Accept (already correct)
- React + Vite + Tailwind stack — sensible, fast dev loop, no SSR complications for a localhost dashboard.
- Fastify + `ws` on the server side — simple, well-typed, pairs cleanly with a Vite dev server via proxy.
- "No arbitrary timeouts, user watches the stream" — correct product instinct; the UI's job is to make that stream legible enough that the user can actually exercise judgment.
- Fire-and-forget notifications that never block workflow progress — correct failure posture; UI should mirror this (notification errors go to a toast/log, never to a modal).
- Persisting every state transition to SQLite before it takes effect — gives the UI a reliable source of truth to reconcile against after reconnect.
- GitHub integration as "auto with manual fallback button" — the right pattern; the dashboard always has an escape hatch.
- Token usage framed as observability, not management — keeps the UI from needing budget-enforcement modals and lets us render it as passive telemetry.

## Challenge (propose revision)

### WebSocket protocol is entirely unspecified
**Issue:** The plan says "forward stream-json chunks to dashboard via WebSocket" and stops there. There is no message envelope, no versioning, no type discriminator, no sequence numbers, no subscription model, no heartbeat/ping frame, no server→client vs client→server schema, no error frame. "Stream-json chunks" is also ambiguous — is the harness passing raw upstream bytes through, re-wrapping each chunk, or batching? This single gap blocks almost every other UI decision: reconnect, backfill, ordering, multi-workflow fanout, and rendering all depend on an envelope that does not yet exist.
**Impact:** The client cannot be built without guessing. Guesses will collide with server behavior and force a rewrite. We also cannot write a type-safe client (zod/valibot validation at the boundary) without a schema. Debugging a misbehaving stream with no envelope and no seq numbers is miserable.
**Proposed change:** Define a concrete envelope before Phase 2 starts, something like:
- Every server→client frame: `{ v: 1, type, workflowId, sessionId?, seq: monotonic_per_session, ts, payload }`.
- Types (minimum): `hello`, `workflow.snapshot`, `workflow.update`, `feature.update`, `session.started`, `session.ended`, `stream.chunk`, `stream.tool_use`, `stream.tool_result`, `stream.text`, `stream.thinking`, `stream.usage`, `notice`, `error`, `pong`.
- Every client→server frame: `{ v: 1, type, id, payload }` with types `subscribe`, `unsubscribe`, `control` (pause/resume/cancel/skip/rerun/inject), `ack`, `ping`.
- Per-session monotonic `seq` so the client can detect gaps and request backfill.
- Explicit `hello` from server with protocol version; client refuses to connect on mismatch instead of silently rendering garbage.

### Render model for stream-json chunks is undefined
**Issue:** stream-json emits heterogeneous events — `message_start`, `content_block_start`/`delta`/`stop` for text, `tool_use`, `tool_result`, `thinking`, `message_delta` with usage, final `result`. The plan treats these as one undifferentiated "live output." Each type needs a distinct UI treatment, and text blocks arrive as deltas that must be concatenated in place, not as independent log lines.
**Impact:** A naive "append each chunk as a line" renderer will explode into thousands of 3-character fragments, destroy scrollback usability, and make tool_use / tool_result pairing invisible. Users will not be able to tell "the agent is editing a file" from "the agent is thinking" from "the agent printed text."
**Proposed change:** Define a client-side normalized event model separate from the wire format:
- `TextBlock` (mutable, accumulates deltas until `content_block_stop`, then frozen)
- `ToolCall` (tool name, input JSON, status = pending|running|ok|error, collapsible input/output, linked to its `tool_result` by `tool_use_id`)
- `ThinkingBlock` (collapsed by default, rendered in a muted treatment)
- `SystemNotice` (session start/end, retries, hook failures, rate-limit detections)
- `UsageUpdate` (not rendered inline; feeds the usage HUD)
Reducer converts wire frames into this model. Virtualized list renders only the normalized events, not raw deltas.

### Virtualization is assumed but not scoped
**Issue:** "Live streaming agent output" with stream-json over a long implementation session is easily 5–20k events (deltas, tool calls, tool results with large payloads). The plan does not mention virtualization, variable-height measurement, sticky-to-bottom behavior, or scrollback retention.
**Impact:** Without virtualization, React reconciliation dies around a few thousand nodes, especially with code blocks and syntax highlighting. With virtualization but without variable-height support, code/tool output collapses to wrong heights and jumps on scroll.
**Proposed change:** Commit to `@tanstack/react-virtual` (variable-size, supports measure-on-mount, works well with sticky-to-bottom). Requirements to spec:
- Follow-tail mode that auto-scrolls only while the user is within N pixels of the bottom; detaches as soon as the user scrolls up; reattaches via a "Jump to latest" pill.
- Chunked text rendering — don't re-render an entire growing text block on every delta; render as a stable component whose text ref mutates, or buffer deltas in a 16ms rAF flush.
- Hard cap on in-memory events per session (e.g. 10k); older events paged from the server log on scroll-up.
- Persistent scroll position across tab switches between workflows.

### Backfill and catch-up after disconnect are not specified
**Issue:** WebSockets will drop (laptop sleep, network hiccup, server restart). The plan has no story for "what does the client do when it reconnects mid-session." Do we replay from seq 0? From last seen seq? From a snapshot? The harness already persists session logs to disk, but the UI has no documented path to them.
**Impact:** On every reconnect the user either (a) loses history, (b) sees duplicates, or (c) sees out-of-order events. Any of these makes the live pane untrustworthy, which defeats the whole "user judges progress from the stream" model.
**Proposed change:**
- On connect, client sends `subscribe { workflowId, sinceSeq? }` per session of interest.
- Server responds with `workflow.snapshot` (current state, features, active sessions) + a bounded backfill of stream events after `sinceSeq` from the stored session log, then switches to live.
- If `sinceSeq` is older than the server's retained buffer, server responds with `backfill.truncated` and an HTTP URL the client can fetch to page the full log into the virtualizer.
- Client dedupes by `(sessionId, seq)`; drops anything with seq <= lastApplied.

### Subscription model for multi-workflow monitoring is missing
**Issue:** The plan says parallel workflows are a v1 must-have and implies the dashboard shows live output for all of them. But there is no description of the subscription model — does the socket fan out every workflow's stream to every client, or does the client subscribe per-workflow? What happens when the user opens 3 workflow panes — 3 sockets, or 1 multiplexed socket?
**Impact:** Broadcasting everything wastes bandwidth and forces every client to filter. Per-workflow sockets multiply reconnect logic. Unclear subscription semantics also make the "watch 3 workflows at once" UX undefined.
**Proposed change:** Single multiplexed socket per client. Explicit `subscribe`/`unsubscribe` by `workflowId`. Server only sends frames for subscribed workflows plus a lightweight global `workflow.index.update` frame for the sidebar list. Document a cap (e.g. max 4 concurrent streaming subscriptions) and degrade extras to polled snapshots — rendering 4 fully-live virtualized panes is already aggressive.

### "Inject context" has no state model
**Issue:** The plan lists "Inject context: add notes included in the next agent prompt" as a control but does not say whether this splices into the currently-running session (impossible via stdin after the prompt has been piped and closed), queues for the next session of this feature, queues for the next phase, or only for the next workflow. It also does not say how the injection is surfaced in the UI (pending badge? editable until consumed? audit log?).
**Impact:** Users will expect the injection to affect what they're watching. When it silently waits for the next session, they'll think the feature is broken and retry/cancel.
**Proposed change:** Commit to "queue for next session of this feature, shown as a pending chip on the feature card with 'edit' / 'cancel' actions until consumed, then shown as an immutable annotation in the session that consumed it." If we ever want live injection, it requires Claude Code support for mid-session stdin — note that as out of scope, explicitly.

### Manual control state machine is not defined
**Issue:** Pause, resume, cancel, skip, re-run phase, inject context — the plan lists the buttons but never defines (a) which controls are valid in which workflow/feature/session states, (b) what each transitions to, (c) what the UI does during the in-flight RPC (optimistic? pending?), (d) confirmation semantics (cancel is destructive), (e) idempotency (double-click).
**Impact:** Buttons will be shown enabled when the action is invalid; users will double-click and get two re-runs; cancel will race with natural completion. This is the most common category of dashboard bugs.
**Proposed change:** Specify a control matrix keyed on workflow.status × feature.status × session.status producing `{ allowed, requiresConfirm, optimisticState }`. Every control RPC carries a client-generated `commandId`; server is idempotent on it. UI shows pending state until the server echoes back a state-transition frame; no optimistic mutation of workflow state (optimistic is fine for cosmetics like disabling the button).

### Feature board does not scale to 50+ features
**Issue:** Plan shows a feature list but gives no affordances for scale: no search, no grouping, no filtering by status, no collapsing by category, no keyboard navigation, no deep-linking. With 50+ features spanning 4-5 categories, a flat list becomes unusable within the first real workflow.
**Impact:** The user cannot find the feature they care about without scrolling. The "watch the agent implement feat-037" use case is the core loop — if it takes 10 seconds to locate feat-037, the product feels broken.
**Proposed change:**
- Group-by `category` (from features.json) with collapsible sections; persist collapse state in localStorage per workflow.
- Status filter chips (pending/in_progress/review/complete/blocked) with counts.
- Text search over id + description, fuzzy.
- Deep link `/workflows/:id/features/:featureId` so a notification click lands on the right card.
- Sticky header with the currently-streaming feature pinned, regardless of filter state.
- `j`/`k` keyboard nav between features.

### Browser push notifications require machinery the plan ignores
**Issue:** The plan lists "browser push" as a must-have but does not mention the Permissions API, the Notifications API permission grant flow, or a service worker (required for push when the tab is not focused, and required for true Web Push if ever going beyond localhost). It also does not specify what happens when the user denies permission.
**Impact:** On first run the dashboard will try to show a notification and either silently no-op or throw. Users on hardened browsers (default-deny) will never see a notification.
**Proposed change:**
- Explicit permission-request UX: a one-time banner on first visit with "Enable notifications" button (must be from a user gesture; the spec forbids auto-prompting).
- Register a service worker and use `registration.showNotification` so notifications survive tab blur; plain `new Notification` does not reliably fire in background tabs in Chrome.
- If permission is denied, fall back to an in-app toast + a persistent bell badge. Never retry the prompt.
- Document that true OS-level push when the browser is closed is out of scope for v1 localhost; recommend macOS native for that case.

### macOS native notifications cannot reach a closed browser tab
**Issue:** The plan lists `node-notifier` as a notification mechanism, but node-notifier runs on the server. If the user has closed the tab (or the laptop is locked), the server firing a native notification works — but the plan talks about it as a UI feature alongside browser push, blurring responsibility. There is no story for "user clicks the macOS notification — what opens?"
**Impact:** Users will expect clicking the notification to deep-link into the workflow; without plumbing, it does nothing, or opens a new tab to `/`.
**Proposed change:** Make notification dispatch strictly server-side (node-notifier runs on the harness). The notification carries a URL like `http://localhost:3456/workflows/:id?focus=feat-037`. Clicking opens/focuses a tab at that deep link. The browser-push mechanism is only used while the tab is open and is effectively a redundant in-app toast — document that overlap explicitly so we don't double-notify.

### Token usage data model is unspecified
**Issue:** The plan says usage is stored per session and then lists aggregations "per feature, per phase, per profile, trends" without defining how the UI asks for them or what shape it receives. Per-feature aggregation is non-trivial because a single feature spans multiple sessions across multiple phases, including retries.
**Impact:** The UI will either compute aggregations client-side over all sessions (fine up to ~100 sessions, painful beyond), or it will need ad-hoc endpoints added mid-build.
**Proposed change:** Define REST endpoints up front:
- `GET /api/workflows/:id/usage?groupBy=feature|phase|profile|session`
- `GET /api/workflows/:id/usage/timeseries?bucket=hour|day`
Server computes aggregations from the `sessions` table. UI renders:
- HUD in the header: current session live counter (updated from `stream.usage` frames), with cache-hit ratio.
- Per-feature drawer: breakdown across plan/implement/review/retries.
- Workflow summary card: totals.
Clarify that "trends over time" is cross-workflow and can be deferred to v1.1 behind a separate route.

### Crash recovery surface is undefined
**Issue:** The plan describes the server's recovery logic but says nothing about what the dashboard shows. "Surface the recovered state in the dashboard" is the entire UI spec.
**Impact:** After a crash the user opens the dashboard and sees workflow cards that look normal. They have no idea the workflow was recovered, what was lost, whether the current session is a resumed `-c` or a fresh retry, or whether there were uncommitted changes.
**Proposed change:** Introduce a first-class `recoveryState` on workflows: `{ recoveredAt, priorStatus, resumeMethod: 'continue'|'fresh', uncommittedChanges: bool, lastKnownSessionId }`. Render a dismissible banner on affected workflow cards: "Recovered from crash at 09:12 — resumed session via -c. Worktree had uncommitted changes." Keep the banner until the user acknowledges it; persist acknowledgement server-side so it doesn't reappear on reconnect.

### Review phase "live output" for a fan-out orchestrator is unspecified
**Issue:** Review is one orchestrator session that spawns subagents. Stream-json from the orchestrator shows `tool_use` calls invoking subagents (via the Task tool in Claude Code's model), and the subagent output comes back as nested `tool_result` — it is not a parallel stream of 4 independent review agents. The plan's "live streaming output" section treats this as if it were a single linear feed.
**Impact:** The UI will either (a) render the whole review as one opaque "Task is running…" line, or (b) try to synthesize parallel panes from data that arrives serialized in the orchestrator's stream. Both are bad defaults.
**Proposed change:** Special-case review rendering:
- Detect `Task` tool_use in the orchestrator stream; render each as a collapsible "subagent" row with the subagent name, status, and an expandable child pane showing that subagent's own text/tool events parsed from the `tool_result`.
- Show a "review angles" summary strip at the top of the review panel (security / complexity / best-practices / acceptance) with per-angle status dots that light up as each subagent returns.
- Accept that subagents run sequentially inside one orchestrator session — don't promise true parallel live panes for review.

### Workflow history list is undefined
**Issue:** "Workflow list" is one bullet. No pagination, filtering, sorting, archival, or retention. This is fine for 5 workflows and broken for 500.
**Impact:** As users actually adopt the harness, the list becomes a scroll-forever drawer with no way to find last Tuesday's "add-auth" run.
**Proposed change:**
- Server: `GET /api/workflows?status=&q=&before=&limit=` with keyset pagination on `created_at`.
- UI: filter bar (status, date range, name query), sort by created/updated, archive toggle (hides `completed`/`failed` older than 30 days by default), per-row "star" for pinning, link to the stored artifacts directory.

### GitHub button states are not enumerated
**Issue:** "Create PR button / View PR button / Create Issue button" — three states total. Real life has: no repo configured, `gh` not installed, no auth, auto-PR succeeded, auto-PR failed (with reason), PR created but merged, PR created and closed, PR created by user manually outside the harness, rate limited, network error. Loading and error UX is not mentioned.
**Impact:** The button will show "Create PR" after one has already been created manually, or spin forever on a silent failure.
**Proposed change:** Define `githubState` per workflow: `{ status: 'disabled'|'unconfigured'|'idle'|'creating'|'created'|'failed', prNumber?, prUrl?, prState?: 'open'|'merged'|'closed', error?, lastCheckedAt }`. Poll `gh pr view` (or cache from creation result) every N seconds while visible; render as a state-tagged button with spinner/error tooltip/success variant. Provide a "Retry" action when `failed` with the stderr from the last `gh` invocation visible in a disclosure.

### Multi-workflow simultaneous streaming UX is hand-waved
**Issue:** Parallel workflows are a v1 requirement. The plan implies the user can watch several streams at once but doesn't say how — split pane, tabs, grid, PiP? Keyboard switching? Audio ping per workflow?
**Impact:** The user ends up with one big sidebar and one big output pane, constantly clicking to swap contexts, losing scroll position, and missing events on the inactive workflows.
**Proposed change:** Default: one "focused" workflow fills the output pane with full virtualized history. Secondary active workflows render as compact "preview strips" (last N events, 200px tall, auto-scroll) along the right side — pickable to promote to focus. Unread-event badge on the sidebar for workflows that have new events since last viewed. Hard cap ~4 preview strips.

### Session log storage and log viewer punted to v1.1 contradicts the streaming model
**Issue:** "Session log storage and searchable log viewer" is listed as Should Have (v1.1), but backfill-on-reconnect and "scroll up to see earlier events" both require reading from stored logs. Without stored logs in v1, a reconnect loses history permanently.
**Impact:** The v1 dashboard will appear broken every time the user reopens a tab, because the live pane will only show events received since the current socket connected.
**Proposed change:** Move "stream-json capture to disk per session + HTTP endpoint to page it" into v1 must-have. The search UI can stay in v1.1, but the storage + fetch endpoint is a dependency of the core streaming experience.

### No spec for stderr / hook failures / harness-level messages in the live pane
**Issue:** The plan captures stderr for error detection but doesn't say whether stderr (or harness-level events like "retry 2/3", "Stop hook blocked completion", "rate limit detected") appear in the same live pane the user is watching. These are exactly the events the user most needs to see to decide whether the agent is stuck.
**Impact:** The user watches a silent pane while the harness is actively retrying or while the Stop hook is screaming about failing tests — the most important signal is invisible.
**Proposed change:** Define a `SystemNotice` event stream that the server emits over the same WebSocket, interleaved into the live pane with a distinct visual treatment (left-rule accent, icon, severity color). Sources: harness state transitions, stderr lines matching known patterns, hook exit-code-2 messages, retry counter changes, heartbeat loss, rate-limit detection. Filterable via a toolbar toggle so users can hide them when noisy.

### Copy / export / share of live output is missing
**Issue:** Nothing in the plan addresses "I want to copy the last tool call's output" or "save this session's log to a file" or "share this URL with a teammate." These are basic expectations for a debugging surface.
**Impact:** Users will screenshot the pane or hand-copy text out of devtools. They will ask for the feature within the first week.
**Proposed change:** Per-event "copy" affordance on hover; per-session "Download log" button that fetches the stored stream-json from the server; per-workflow shareable deep link. These are small but should be in v1.

## Questions (need user input)
- Is the dashboard strictly localhost single-user, or do we need to plan for multi-user access (auth, per-user notification state, concurrent controllers)? This changes whether we need any auth at all on the WebSocket and REST endpoints and whether control commands need an actor identity.
- What is the target for concurrent streaming workflows the UI must support well? The plan says "parallel" without a number. 2 changes nothing; 4 needs preview strips; 8+ forces us to reconsider virtualizer count and socket fanout.
- Does jig (the upstream wrapper) pass stream-json events through identically to Claude Code's native format, or does it add/rename/wrap anything? The client normalizer depends on this being stable.
- For "inject context," is the expectation that it applies to the next session of the same feature only, the next session in the workflow regardless of feature, or persists as a workflow-level preamble until cleared?
- Should the dashboard expose the underlying artifact files (features.json, progress.md, reviews/feature-N/) as a read-only file browser? It is not mentioned but is the natural fallback when the live pane is not enough.
- For crash recovery, do you want the dashboard to require explicit user acknowledgement ("Resume" / "Discard") before the harness auto-resumes with `-c`, or should resume happen automatically with only a banner? This is a significant UX divergence.
- What is the retention policy for stored stream-json logs — keep forever, keep N days, keep until workflow archived? Affects both disk planning and whether the log viewer needs to handle "log unavailable" states.
- Is there an expectation of dark mode / light mode parity, or is dark-only acceptable for v1? Syntax highlighting theming in the tool output rendering is the main cost here.
- Does the user want hotkeys for control actions (pause, cancel, next feature, jump-to-latest), or are click-only controls fine for v1?
- For notifications, what events are notification-worthy by default — workflow completion and failure are obvious, but what about per-feature completion, blocked features, rate-limit pauses, hook failures? The notification level `completions_and_errors` in the config needs concrete mapping.
