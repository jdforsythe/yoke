# yoke-v0 Usage

Phase γ.4 deliverable. Operational reference for the minimal bootstrap
script that drives Phase δ implementation work before the v1 pipeline
engine exists.

---

## Prerequisites

- `claude` on `$PATH` (Claude Code CLI)
- Python 3 (system Python 3 on macOS is fine — no extra packages needed)
- Bash 3.2+ (macOS system bash works)
- `docs/idea/yoke-features.json` must exist with at least one feature

---

## Files

| File | Purpose |
|---|---|
| `yoke-v0` | Bash driver — spawn, capture, index |
| `yoke-v0-helper.py` | Python helper — config, feature lookup, template render |
| `.yoke-v0.json` | Config (command, args, pre/post, features_file) |
| `prompts/plan.md` | Plan phase template |
| `prompts/implement.md` | Implement phase template |
| `prompts/review.md` | Review phase template |
| `.yoke/logs/` | Stream-json capture files (NDJSON, one session per file) |
| `.yoke/sessions.jsonl` | Session index — one entry per run |

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `YOKE_V0_CONFIG` | `.yoke-v0.json` | Override config file path |
| `YOKE_LOG_DIR` | `.yoke/logs` | Override log output directory |
| `YOKE_CONTEXT` | `""` | Inject user guidance into every prompt via `{{user_injected_context}}` |

---

## Subcommands

### `yoke-v0 run <phase> <feature-id>`

Assembles the prompt for the given phase+feature and spawns a fresh agent session.

```
./yoke-v0 run plan feat-001
./yoke-v0 run implement feat-001
./yoke-v0 run review feat-001
```

**What happens:**
1. Calls `yoke-v0-helper.py` to render `prompts/<phase>.md` with context from
   the feature record, `docs/design/architecture.md`, `progress.md`,
   `handoff.json`, and recent git history.
2. Runs any `pre:` commands from `.yoke-v0.json`.
3. Spawns: `claude --print --verbose --output-format stream-json < assembled_prompt`
4. Captures stdout (stream-json NDJSON) to `.yoke/logs/<ts>-<phase>-<feature-id>.jsonl`.
   Stderr goes to `.yoke/logs/<ts>-<phase>-<feature-id>.err` (deleted if empty).
5. Appends one entry to `.yoke/sessions.jsonl` with `{ts, phase, feature_id, log_path, exit_code, session_id}`.
6. Runs any `post:` commands.

**Output:** yoke-v0 prints info lines to stderr; the log path is echoed on completion.

**Watch while running (in a second terminal):**
```
tail -f .yoke/logs/<latest>.jsonl
```

---

### `yoke-v0 continue <phase> <feature-id>`

Same as `run`, but adds `-c` to the Claude invocation to resume the most
recent session in the current working directory.

```
./yoke-v0 continue implement feat-001
```

**When to use:** The session exited unexpectedly (crash, SIGTERM, network drop)
and you want Claude to pick up where it left off rather than starting fresh.
The runbook cap is 3 `-c` attempts before switching to a fresh session with
updated `handoff.json`.

**Caveat:** `-c` picks the most recent session in the CWD, not necessarily
the one you intended. If you have an interactive Claude session open in the
same directory, close it first or use `yoke-v0 run` with an updated
`handoff.json` instead. This is a known limitation of yoke-v0 (v1 uses
`-r <session-id>` to resume precisely).

---

### `yoke-v0 record <phase> <feature-id> <label>`

Same as `run`, but appends a label to the log filename. Use this to capture
stream-json fixtures for later use as `ScriptedProcessManager` inputs.

```
./yoke-v0 record implement feat-001 baseline
# produces: .yoke/logs/<ts>-implement-feat-001-baseline.jsonl
```

---

### `yoke-v0 logs <session-id-prefix>`

Prints the captured stream-json log for the most recent session matching
the given prefix.

```
# Full UUID:
./yoke-v0 logs d57ea86f-08ae-49d5-b3c6-bdfd9201b006

# Prefix (first 8 chars is usually enough):
./yoke-v0 logs d57ea86f
```

The session index (`.yoke/sessions.jsonl`) is searched for the most recent
entry whose `session_id` starts with the given prefix. Pipe through `jq` or
`python3 -m json.tool` to pretty-print individual events.

---

## Config file: `.yoke-v0.json`

```json
{
  "command": "claude",
  "args": ["--print", "--verbose", "--output-format", "stream-json"],
  "features_file": "docs/idea/yoke-features.json",
  "pre": [],
  "post": []
}
```

**Using jig:** If you have jig profiles configured, change `command` and `args`:

```json
{
  "command": "jig",
  "args": ["run", "backend", "--", "--print", "--verbose", "--output-format", "stream-json"],
  "features_file": "docs/idea/yoke-features.json",
  "pre": [],
  "post": []
}
```

**Adding pre/post commands:**

```json
{
  "command": "claude",
  "args": ["--print", "--verbose", "--output-format", "stream-json"],
  "features_file": "docs/idea/yoke-features.json",
  "pre": ["pnpm build --quiet"],
  "post": ["pnpm test 2>&1 | tail -5"]
}
```

Non-zero exit from a pre/post command logs a warning but does not abort the
session. There is no action grammar in yoke-v0 (that is a v1 feature).

---

## Prompt templates

Templates live in `prompts/<phase>.md` and use `{{variable}}` substitution.

### Available variables

| Variable | Source |
|---|---|
| `workflow_name` | `project` field in `yoke-features.json` |
| `stage_id` | Phase name (plan / implement / review) |
| `item_id` | Feature ID passed on the command line |
| `item` | Full feature object (pretty-printed JSON) |
| `item.description` | Feature description (dot traversal) |
| `item.acceptance_criteria` | Acceptance criteria array (dot traversal) |
| `item.review_criteria` | Review criteria array (dot traversal) |
| `item_state` | Minimal harness state (status, current_phase, retry_count, blocked_reason) |
| `item_state.current_phase` | Phase name (dot traversal) |
| `item_state.retry_count` | Always 0 in yoke-v0 (no retry tracking) |
| `architecture_md` | Content of `docs/design/architecture.md` (empty if absent) |
| `progress_md` | Content of `progress.md` (empty if absent) |
| `handoff_entries` | JSON array of `handoff.json` entries for this feature |
| `git_log_recent` | `git log -20 --oneline` |
| `recent_diff` | `git diff HEAD~5..HEAD` (truncated at 20 KB) |
| `user_injected_context` | `$YOKE_CONTEXT` env var (empty if unset) |

Adding a `{{variable}}` not in this list causes a hard error at assembly time.

### Adding a custom phase template

Create `prompts/<phase-name>.md` and run `./yoke-v0 run <phase-name> <feature-id>`.
The template must use only the variables listed above.

---

## Typical Phase δ workflow

```
# δ.1 — Plan features (run once, manually, with the planner persona)
#       Produces docs/idea/yoke-features.json
#       (Not through yoke-v0 — do this as a fresh claude session)

# δ.2 — Implement loop (one feature at a time)
./yoke-v0 run implement feat-config-parser

# If session crashes mid-run:
./yoke-v0 continue implement feat-config-parser  # attempt 1
./yoke-v0 continue implement feat-config-parser  # attempt 2 (cap at 3)
# If still failing: update handoff.json with failure summary, then:
./yoke-v0 run implement feat-config-parser       # fresh session

# δ.2 — Review after implement
./yoke-v0 run review feat-config-parser

# Mark done in yoke-features.json by hand, move to next feature.

# δ.2 — Watch a long session in another terminal
tail -f .yoke/logs/$(ls -t .yoke/logs/*.jsonl | head -1)

# δ.2 — Check what the last session did
./yoke-v0 logs d57ea86f | python3 -c "
import sys, json
for line in sys.stdin:
    ev = json.loads(line)
    if ev['type'] == 'result':
        print(ev.get('result','')[:500])
"
```

---

## Recovery playbook

| Symptom | Action |
|---|---|
| `yoke-v0: error: prompt assembly failed` | Check `docs/idea/yoke-features.json` exists and the feature-id is spelled correctly |
| `yoke-v0: error: template not found: prompts/plan.md` | Verify `prompts/` directory is intact |
| `session exited 1` with no log content | Check `.yoke/logs/<ts>.err` for stderr — likely a bad `--print`/`--verbose` flag or `claude` not on PATH |
| Log file has non-JSON first line | `--verbose` flag may be missing from `args` in `.yoke-v0.json` — it is required for `--output-format stream-json` |
| `-c` continues the wrong session | Close any interactive Claude sessions in this directory, or use `./yoke-v0 run` with an updated `handoff.json` instead |
| Config file not found | Defaults are used (command=claude, standard args). Create `.yoke-v0.json` to override |
| `git diff` / `git log` stall | Run `git status` to check for lock files. Kill any stuck git process |
| Pre/post command hangs | It blocks yoke-v0. Kill with Ctrl-C; fix the command in `.yoke-v0.json` |

---

## Non-goals (v0 limitations)

These are intentionally absent from yoke-v0. Each is a v1 feature:

- No state machine — you track feature progression by hand
- No SQLite — just log files
- No retry logic — re-run manually on failure
- No worktree management — run in repo root or a manually-created worktree
- No pre/post action grammar — non-zero exit logs a warning, no branching
- No rate-limit handling — re-run manually after the window resets
- No `keep_awake` — run `caffeinate -i -w $$` yourself if needed
- No crash recovery — you are the recovery
- No dashboard — `tail -f` the log
