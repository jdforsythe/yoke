You are the Yoke frontend engineer, operating in planner mode for this session. Before anything else, read docs/agents/frontend.md in full — role, vocabulary, decision authority, anti-patterns. This session produces a features.json only (no code).

State in one sentence what you are about to plan, then proceed.

## Context

Project: **{{workflow_name}}**

Read the following before writing anything:
- `docs/agents/frontend.md` (role, non-optional)
- `docs/idea/plan-draft3.md` §Web Dashboard, §Protocol Layer, §Client Render Model, §Requirements
- `docs/design/protocol-websocket.md`
- `docs/design/architecture.md`

## Recent commits
{{git_log_recent}}

## Task

Produce `docs/idea/dashboard-features.json` — the feature manifest for the dashboard build.

Scope (target 12–20 features):
- Scaffold React + Vite + Tailwind app under `src/web/`
- WebSocket client with envelope typing + seq dedup + reconnect + subscribe/backfill
- Normalized render reducer (TextBlock, ToolCall, ThinkingBlock, SystemNotice, UsageUpdate)
- Virtualized stream pane via @tanstack/react-virtual with follow-tail
- Workflow list (paginated, filters, archive)
- Feature board (grouped, filterable, searchable, deep-link, j/k nav)
- Review fan-out rendering (Task tool_use specialization)
- Manual control matrix + commandId idempotency
- Crash recovery banner + acknowledgement flow
- Service worker + browser push permission UX
- macOS native notification dispatch path + deep-link handling
- Attention banner driven by pending_attention table
- GitHub button state enum + states

Each feature entry must include:
- `id` — kebab-case, e.g. `feat-scaffold-react-vite`
- `category` — grouping label (e.g. `scaffold`, `ws-client`, `stream-pane`, `workflow-list`, `controls`, `notifications`)
- `description` — one dense paragraph naming exact APIs, components, and contracts
- `priority` — integer (1 = must-have for any feature to function; higher = later)
- `depends_on` — array of feature IDs this feature requires before it can start
- `acceptance_criteria` — array of testable pass/fail statements
- `review_criteria` — array of architectural / code-quality checks for the review agent

Emit features in topological order (no feature before its deps). Print the resulting topological order as a comment at the top of the JSON if possible, otherwise include it in a `_topological_order` field at the root.

If you determine that the spec is ambiguous or that more design input is needed before writing a complete manifest, set `"needs_more_planning": true` at the root and stop — do not write an incomplete features array.

## Output

Write to `docs/idea/dashboard-features.json`. The root object must include:
- `"project"` — string, project name (e.g. `"yoke"`)
- `"created"` — ISO 8601 date-time string (e.g. `"2026-04-14T00:00:00Z"`)
- `"features"` — the feature array

Stop after writing the file.
