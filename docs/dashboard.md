# The dashboard

`yoke start` prints a URL — open it in a browser and you get a single-page React
app served from `127.0.0.1`. This is your control panel: pick a template, watch the
agent, retry an item, open the PR.

> **Note:** Today the dashboard is served by the Vite dev server (`bin/yoke-dev`,
> port 5173). Once the static-bundle work for v0.1.0 lands, `yoke start` will serve
> the bundled UI from the API port (default 7777). The surfaces and behaviors below
> are identical either way.

---

## Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Yoke                                                  [usage  HUD]    │
├─────────────────────────────────────────────────────────────────────────┤
│                  │                                                      │
│ Workflow list    │   Workflow detail                                    │
│ ──────────────   │   ─────────────────                                  │
│ ◉ first-run      │   [Attention banner — when applicable]              │
│   active         │   [Crash recovery banner — first paint after restart]│
│ ○ smoke-test     │                                                      │
│   complete       │   ┌─ Feature board ──────────────────────────────┐  │
│ ○ refactor       │   │ ▢ feat-auth   active  implement   attempt 1 │  │
│   awaiting_user  │   │ ▢ feat-billing pending                       │  │
│                  │   │ ▢ feat-emails  blocked depends_on            │  │
│ + new workflow   │   └──────────────────────────────────────────────┘  │
│                  │                                                      │
│                  │   ┌─ Live stream / Review panel ─────────────────┐  │
│                  │   │ assistant: Reading docs/agents/...           │  │
│                  │   │ tool_use: Read(path=...) ✓                    │  │
│                  │   │ thinking: …                                   │  │
│                  │   └──────────────────────────────────────────────┘  │
│                  │                                                      │
│                  │   [ Cancel ] [ Pause ] [ Continue ] [ Retry ] [PR]  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Surfaces

### Template picker

Before any workflow exists, the **+ new workflow** button opens a modal that lists
every `.yoke/templates/*.yml` file in your repo as a card with its `template.name`
and `template.description`. You pick one, name your workflow, and click **Run**.

If a workflow already exists for the same template name, the modal warns you with a
soft-collision hint — common when iterating on the same template overnight.

### Workflow list (sidebar)

Every workflow you've ever created in this repo, with status and last-updated time.
Filter by status (`active`, `awaiting_user`, `complete`, `cancelled`, `archived`).
The unread-events badge lights up when an item changes state for a workflow you're
not currently viewing.

Click a workflow to open its detail view.

### Feature board

For per-item stages, one card per item, showing:

- The item's display title (`items_display.title` JSONPath, or the raw id).
- Current phase, status, attempt number.
- A "blocked on X" hint if `items_depends_on` is gating it.

Click a card to focus the live stream on that specific item.

### Live stream

Real-time agent output, as the agent emits it via `claude --output-format stream-json`.
You see:

- **Text** the agent prints.
- **Tool calls** with their arguments and results (Bash, Read, Edit, WebFetch, …).
- **Thinking blocks** when the model produces extended reasoning.

Auto-scrolls to follow the stream; scroll up to pause and read; scroll back to
bottom to resume following.

### Review panel

When a phase launches subagents via the `Task` tool, the live stream pane swaps to a
specialized **ReviewPanel** that shows each subagent task as its own card with its
own progress and final result. This is the dashboard's response to multi-reviewer
pipelines (see [recipes/multi-reviewer.md](recipes/multi-reviewer.md)).

You can pin the renderer per phase:

```yaml
phases:
  review:
    ui:
      renderer: review        # force ReviewPanel; default is autodetect
```

### Control matrix

Buttons live in the workflow header and adapt to the current state:

- **Cancel** — kill the running session, mark the workflow `cancelled`. Available
  when status is `active`.
- **Pause** — let the current session finish but don't start the next one. Useful
  when you want to look at the worktree before the next phase touches it.
- **Continue** — release a paused or `awaiting_user` workflow. Equivalent to
  `yoke ack <workflow-id>` from the CLI.
- **Retry** — re-run the failed item with a fresh-with-failure-summary attempt,
  bypassing the outer ladder budget.

### Attention banner

When a workflow enters `awaiting_user` (a `stop-and-ask` action fired, the outer
retry ladder reached its end, a stage with `needs_approval: true` is gating, or a
`max_revisits` limit was hit), an orange banner appears at the top of the workflow
detail view:

> ⚠ feat-auth requires attention: review verdict was FAIL after 3 revisits.
> [ Continue ] [ Dismiss ]

The same notice is also pushed via the OS notification system (macOS native /
browser push) when configured.

### Crash recovery banner

On the first paint after `yoke start` restarts, the dashboard shows a one-time
banner listing any workflows whose state was reconciled on startup ("3 sessions
were marked failed because their PIDs no longer exist"). Click **Dismiss** to clear.

### GitHub button

When `github.enabled: true` and a workflow completes, Yoke pushes the branch and
opens a PR. The button in the workflow header turns into:

- **Open PR #123** — link to the GitHub PR.

If auto-PR fails (auth, network, no remote), the button switches to **Create PR**;
clicking it triggers the create-PR flow on demand and surfaces the error if it
still fails.

### Usage HUD

Top-right corner, when a session is running. Live token usage and rate-limit
headroom from Anthropic's API.

---

## Keyboard shortcuts

The dashboard is a normal React app — most navigation is mouse-driven. Common
shortcuts:

- `j` / `k` — move between workflows in the sidebar.
- `↑` / `↓` — scroll the live stream.
- `Esc` — close any open modal.

---

## Network surface

The dashboard talks to the API via:

- HTTP at `http://127.0.0.1:<port>/api/...` for REST calls.
- WebSocket at `ws://127.0.0.1:<port>/ws` for live frames (workflow updates, stream
  output, attention notices).

Both bind to `127.0.0.1` only. There is no auth and no remote access — this is
intentional. See [SECURITY.md](../SECURITY.md) for the threat model.

---

## See also

- [Getting started](getting-started.md) — first run, end-to-end.
- [Templates guide](templates.md) — what `template_name` shows up where.
- [Troubleshooting](troubleshooting.md) — when the dashboard isn't reachable.
