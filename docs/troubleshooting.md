# Troubleshooting

Common errors, with the fix. Search this page (Ctrl/Cmd-F) for the message you saw
on the terminal or the dashboard banner.

If you're stuck after this page, run `yoke doctor` first — it catches most setup
issues. If something here is wrong or missing, please open an issue.

---

## Setup and install

### `claude: command not found`

Yoke spawns `claude` as a subprocess. Install Claude Code per Anthropic's docs and
verify with `claude --version`. If the binary is installed but not on `$PATH`, add
it (or pass an absolute path in your template's `command:` key).

### `Configuration error: ...`

Yoke's configuration loader throws `ConfigLoadError` for any of:

- **`not_found`** — `.yoke/templates/<name>.yml` doesn't exist. Run `yoke init` or
  see [getting-started.md](getting-started.md).
- **`parse_error`** — the YAML didn't parse. Run `yoke doctor` for a clearer
  pointer; most often this is an unquoted `version: 1` (must be `version: "1"`)
  or a tab in YAML indentation.
- **`schema_invalid`** — AJV rejected the template. The error includes the JSON
  Pointer to the offending key. Two recurring causes:
  - **`actions:` map missing the `"*"` wildcard.** Every actions map must include
    `"*"`. Add `"*": continue` for advisory gates or `"*": stop-and-ask` for
    strict ones.
  - **`additionalProperties: false`** — typos like `prompt-template:` (should be
    `prompt_template:`) fail at load time. Diff the failing key against
    [configuration.md](configuration.md).

### `GitRepoRequiredError: <dir>: not a git repository`

`yoke start` requires the config dir to be inside a git repo (we use `git
worktree add` to isolate runs). Either:

```sh
cd /path/to/your/repo
git init
git add . && git commit -m "init"
yoke start
```

or pass a different `--config-dir` that is inside a git repo.

### `EADDRINUSE: address already in use 127.0.0.1:7777`

Something else is already on port 7777. Either find and stop it, or pick a
different port:

```sh
yoke start --port 7800
```

If it's a stale Yoke process, `lsof -i :7777` will find it; `kill <pid>` clears
it. The next `yoke start` will overwrite `.yoke/server.json` with the new port
so `yoke status` and `yoke cancel` keep working.

### `Cannot find module 'better-sqlite3'` (or similar native binding error)

You probably installed dependencies on a different platform / Node version than
you're running. From the Yoke checkout:

```sh
pnpm install --force
# or
pnpm rebuild better-sqlite3
```

---

## ANTHROPIC API access

Yoke does not ship API keys. The `claude` binary uses whatever credentials
you've set up for it.

- **API-key auth:** make sure `ANTHROPIC_API_KEY` is set in your environment
  before `yoke start` (the env var is inherited by spawned `claude`
  subprocesses).
- **Pro/Max OAuth:** run `claude` once interactively to complete the login flow.
- **Rate limits / "usage limit reached":** Yoke uses passive backoff by default
  (`rate_limit.handling: passive`). The agent will sleep and retry; the
  workflow may run slower or pause. Wait for your usage window to reset.

If `claude -p "say hi"` works in your shell, Yoke will work. If it doesn't,
that's the level to debug at.

---

## Prompts and templates

### `[MISSING:foo]` showing up in the agent's prompt

You referenced `{{foo}}` but `foo` isn't in the context for this phase. The
engine produces `[MISSING:<path>]` instead of throwing — the phase still runs,
but the agent sees the marker.

Check:

- The variable name matches the [inventory](prompts.md#variable-inventory).
- For per-item-only variables (`{{item}}`, `{{handoff}}`, etc.), the phase is
  inside a `run: per-item` stage.
- Common typos: `{{ foo }}` (whitespace inside braces — passes through verbatim,
  doesn't render); `{{handoff_entries}}` (use `{{handoff}}`).

### `{{#each ...}}` literally appearing in the assembled prompt

Yoke's engine is **not** Handlebars — only `{{var}}` and `{{var.path}}` are
recognized. Anything else passes through as text. Reference arrays/objects as
single values (`{{item.acceptance_criteria}}`) and let the agent format them.

### Prompt assembly works but the agent ignores half the variables

Two common causes:

- **Massive `{{handoff}}` or `{{recent_diff}}`** — if either is huge, the
  context window pressure pushes earlier instructions out. Trim by archiving
  old handoff entries or by setting `diffFrom`/`diffTo` to a tighter range.
- **Prompt structure** — the agent does best when variables are introduced with
  headings (`## Feature spec`, `## Recent commits`). Bare `{{item}}` in the
  middle of a paragraph reads as noise.

---

## Workflows

### "Template not found" in the dashboard New Workflow modal

The picker calls `GET /api/templates`, which lists `.yoke/templates/*.yml`. If
nothing appears:

- You're running `yoke start` against the wrong directory. Pass `--config-dir`
  explicitly.
- The file is there but isn't `.yml` (must be lowercase yml extension).
- `yoke doctor` will report which templates loaded and which failed validation.

### Workflow stuck in `pending` forever

The scheduler isn't running. Either:

- You started with `--no-scheduler` (a dev flag). Restart without it.
- A previous tick crashed. Check the terminal where `yoke start` is running for
  errors; restart Yoke.

### Workflow stuck in `awaiting_user`

This is intentional — something needs your attention. Open the dashboard, read
the attention banner, and either:

- Click **Continue** to release.
- Run `yoke ack <workflow-id>` from the CLI for the same effect.
- Click **Cancel** if you want to abandon the run.

Common causes: outer retry ladder reached `awaiting_user`; a `stop-and-ask`
action fired; a `goto` hit `max_revisits`; a `needs_approval` stage is gating.

### Workflow finished but no PR opened

- Check `github.enabled: true` is set in the template.
- Check the **GitHub** button in the workflow header. If it says **Create PR**,
  click it and watch for an error message — usually auth (`gh auth login` or
  `export GITHUB_TOKEN=…`).
- The workflow's branch must be pushable to the configured `pr_target_branch`'s
  remote. Yoke pushes to `origin` by default.

### Item stuck in `blocked: depends_on ...`

The dependency hasn't completed. Open the **Feature board**, find the dependency
item, and check its status. If it's `awaiting_user`, attend to it. If you want
to skip the dependency, edit the manifest to remove the `depends_on` entry —
but understand the downstream item will run without the changes the dependency
would have produced.

### `handoff.json` is huge / out of date / invalid JSON

`handoff.json` is opaque to the harness; only your prompts read it. If it's
corrupted (free-form edits by an agent that didn't use the typed writer), the
fix is to:

1. Stop the workflow.
2. Open the worktree (`.worktrees/<workflow>/handoff.json`).
3. Either repair it manually (it's just a JSON file with an `entries` array) or
   reset it to `{ "entries": [] }` and start the next attempt fresh.

To prevent recurrence, make sure every prompt that touches handoff routes
through `scripts/append-handoff-entry.js` (the typed writer pattern) instead of
free-form file edits.

---

## Gates and post-commands

### `prepost gate failed: missing "*" key`

Schema validation should catch this at load time, but if you see it at runtime,
it means a `pre:` or `post:` `actions:` map exists without a `"*"` wildcard.
Add one. See [configuration.md#the-action-grammar](configuration.md#the-action-grammar).

### Gate script not found

The script path you put in `run:` is resolved against the worktree, not the
config dir. Use `scripts/check-foo.js` (relative path, lives in your repo and
gets carried into the worktree by git) rather than absolute paths. Verify with
`yoke doctor`, which checks every referenced script exists.

### Gate script keeps timing out

`timeout_s` defaults to 900 (15 min) per command. For long test suites, bump it:

```yaml
- name: long-tests
  run: ["pnpm", "test:e2e"]
  timeout_s: 1800
  actions: { "0": continue, "*": { retry: { mode: fresh_with_failure_summary, max: 1 } } }
```

A timeout shows up as exit code 143 (128 + SIGTERM 15). If you want to handle
it specifically, add `"143": stop-and-ask`.

---

## Dashboard

### Browser shows "Connection refused" or empty page

- Check the terminal — `yoke start` should print `Yoke dashboard:
  http://127.0.0.1:7777`. If not, it failed to bind.
- If port 7777 is in use, pass `--port <n>` (e.g. `yoke start --port 7800`).
  The error message includes the offending port and the flag hint.
- If the page loads but the workflow list is empty, you're connected to a
  different `.yoke/yoke.db` than you expected. Check `--config-dir`.
- Yoke contributors hacking on the source tree can use `bin/yoke-dev` to run
  the Vite dev server at `http://127.0.0.1:5173/` against an unbundled build.
  End users don't need this; the npm package serves the bundled UI directly.

### Live stream pane is empty

The session may not have started yet (`pending`), or the agent hasn't produced
output yet (cold start, network slow). If it stays empty for more than a
minute, check the terminal for errors and look at `.yoke/logs/*.jsonl` for the
raw stream.

### ReviewPanel shows nothing for a multi-reviewer phase

The autodetect kicks in only after the first `Task` tool_use call. If the
orchestrator never calls `Task`, it stays in the LiveStream view. Pin the
renderer explicitly:

```yaml
phases:
  review:
    ui:
      renderer: review
```

---

## Crashes and recovery

### Yoke crashed mid-workflow

State is durable. Restart `yoke start` and:

- The crash-recovery banner appears in the dashboard listing reconciled
  sessions.
- Workflows whose sessions died get marked `awaiting_user` (or `failed`,
  depending on classifier). Click **Retry** or **Continue**.
- Worktrees on disk are preserved. Inspect them under `.worktrees/<workflow>/`
  if you want to see what state they were in.

### Lost the dashboard URL

Check `.yoke/server.json` in the repo where you ran `yoke start`. It contains
the URL and the PID of the running server.

If the file is missing, `yoke start` already exited; restart it.

---

## When all else fails

- Run `yoke doctor` and read every line.
- Look at `.yoke/logs/<timestamp>-<phase>-<item>.jsonl` for the raw stream-json
  output of the offending session.
- Open the SQLite DB (`.yoke/yoke.db`) read-only with `sqlite3` — every state
  transition is in the `events` table.
- File an issue with the template, the prompt, the failing log lines, and what
  you expected to happen.
