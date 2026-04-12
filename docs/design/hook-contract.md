# Quality-Gate Contract

Source: plan-draft3.md §Hooks Integration (D55, D28), §Phase Pre/Post
Commands (D50), §Core Design Principles #2, §Threat Model (D37).

**Important framing.** This document is the Yoke *quality-gate*
contract, not a Yoke hook spec. Yoke does not own a hook directory, does
not install hooks, and does not require any Claude hook to exist. Yoke
accepts phase completion when three conditions are met (plan-draft3
§Hooks Integration):

1. The agent session exited cleanly (`exit 0` AND no stream-json error
   frames).
2. Every configured `post:` command returned success (per the action
   grammar in `schemas/pre-post-action-grammar.md`).
3. Every configured artifact validator passed.

Nothing else. Users choose how much quality gating they want and where
to enforce it. The sections below describe the surfaces Yoke exposes to
interoperate with user-installed Claude hooks *if they exist*.

---

## 1. Optional `.yoke/last-check.json` manifest

This file is a **convention**, not a contract. If a user's Claude Stop
hook chooses to emit it, Yoke will read it and display its contents on
the dashboard. If the file is absent, the harness treats that as
normal: `.yoke/last-check.json` does **not** participate in phase
acceptance.

### Shape (plan-draft3 §Hooks Integration → Optional manifest)

```json
{
  "hook_version": "1",
  "ran_at": "2026-04-11T12:34:56Z",
  "gates": [
    { "name": "typecheck", "ok": true,  "duration_ms": 1203 },
    { "name": "lint",      "ok": true,  "duration_ms": 890 },
    { "name": "test",      "ok": true,  "duration_ms": 5420,
      "test_count": 42, "pass_count": 42 },
    { "name": "build",     "ok": true,  "duration_ms": 8100 }
  ]
}
```

Rules (as enforced by the dashboard renderer only):

- `hook_version` is a string. v1 recognizes `"1"` and renders the
  table; unknown versions render a warning badge and the raw JSON.
- `ran_at` is ISO-8601 UTC.
- `gates` is an array of `{name, ok, duration_ms, ...extras}`. `extras`
  are passed through to the UI verbatim.
- Any shape mismatch is rendered as a plain "manifest malformed"
  warning; no phase-acceptance consequence.

Users who want the manifest to participate in phase acceptance can wire
a `post:` command like:

```yaml
post:
  - name: "require-check-manifest"
    run: ["jq", "-e", ".gates | all(.ok)", ".yoke/last-check.json"]
    actions:
      "0": "continue"
      "*": { fail: { reason: "last-check manifest missing or failing" } }
```

That is user-owned policy, not harness-owned.

---

## 2. Phase acceptance — how `pre:` and `post:` participate

Concrete ordering (mirror of `schemas/pre-post-action-grammar.md` §6):

```
phase_start event
  ├─ worktree ready (bootstrap ok)
  ├─ pre: commands run in order
  │    any non-"continue" action short-circuits per the grammar
  ├─ Prompt Assembler → spawn agent
  ├─ stream-json parse loop until child exits
  ├─ session_ok / session_fail classification
  ├─ artifact validators (ajv) — run regardless of session_ok
  ├─ item manifest diff check (items_from file unchanged, D10)
  └─ post: commands run in order (only if the above all passed)
        each command's exit code → action → state-machine transition
```

A phase is **accepted** (advances to the next phase in the stage, or
marks the item complete if it was the last phase) iff all five stages
succeed (Issue 1). Any `post:` action that is not `continue` diverts
the state machine — see `state-machine-transitions.md`
§post_command_action dispatch.

Yoke does not distinguish "quality gate passed" from "post command
passed." From the harness's point of view, the latter is the formal
mechanism; the former is a render-time convention the user may or may
not have chosen. This applies equally to review phases — the harness
does not parse review output files; pass/fail is driven by `post:`
commands (Issue 4).

---

## 3. Exit code expectations for Claude hooks

Claude Code hook exit code semantics are the user's concern. Yoke does
not interpret a hook's exit code directly; it only interprets the
*agent session's* exit code. For reference (empirically verified,
see `docs/research/hook-semantics.md` for full details):

| Question | Answer |
|---|---|
| Exit 0 on Stop hook: does Claude proceed with session termination? | **Yes.** Session ends with `result.subtype: "success"`. |
| Exit 2 on Stop hook: does Claude feed stderr back and retry? | **Yes.** Stderr injected as `"Stop hook feedback:\n[path]: msg"`. Claude gets another turn. |
| Exit 1 (generic): how does Claude treat it (ignore? block? fatal?) | **Non-blocking error.** Logged, session proceeds normally. |
| Exit on signal / ENOENT: how does Claude report it? | **Non-blocking error.** Same as exit 1. |
| stdin JSON schema delivered to hooks | Common: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`. Stop adds: `stop_hook_active`, `last_assistant_message`. PreToolUse adds: `tool_name`, `tool_input`, `tool_use_id`. |
| stdout JSON schema honored by Claude from hooks | Stop: `{"decision":"block","reason":"..."}`. PreToolUse: `{"hookSpecificOutput":{...,"permissionDecision":"deny\|allow",...}}`. |
| Hook wall-clock timeout enforced by Claude | **Yes.** Default 600s for command hooks. Configurable via `"timeout"` field. Timeout = non-blocking error. |
| Can a Stop hook read the session transcript? | **Yes.** `transcript_path` in stdin points to session `.jsonl` file. |
| Invocation granularity (per-session, per-matcher) | Stop: once per turn end. PreToolUse: once per tool call, filtered by matcher. |

Full research: `docs/research/hook-semantics.md` (Phase γ, 2026-04-12).

---

## 4. What Yoke does NOT do

Explicit non-behaviors (plan-draft3 §Hooks Integration D55, §What Yoke
Does NOT Do, Q-subagent-scoping-in-default-config resolution):

- **Does not install** hooks. `yoke init` may offer an opinionated
  default workflow config on opt-in; no hooks are installed.
- **Does not ship** hook templates. Safety/quality-gate hook examples
  are documented in quick-start/best-practices docs (Phase ε/ζ scope),
  not shipped as files (Q-subagent-scoping resolution).
- **Does not verify** hook integrity or tamper-detect hook files
  unless the user wires a `post:` command to do so (e.g.,
  `sha256sum -c .yoke/hook-checksums`). Harness-enforced checksum
  verification is not part of v1.
- **Does not require** `.yoke/last-check.json` to accept a phase.
- **Does not own** any hook namespace, hook loader, or hook registry.
- **Does not map** exit codes from Claude hooks to Yoke state-machine
  events. The Pipeline Engine only observes the spawned command's
  exit code (which in most setups is `claude` itself, not a hook).
- **Does not aggregate** review results. Pass/fail for a review phase
  is determined by the phase's `post:` commands, not by harness-level
  file parsing (Issue 4).

---

## 5. Interaction model summary

| Layer | Owner | Invoked by | Observed by Yoke as |
|---|---|---|---|
| `pre:` / `post:` shell commands | User (Yoke config) | Yoke Pre/Post Runner | exit code → action |
| Claude Stop hook | User's project | Claude Code runtime | opaque; Yoke sees only final `claude` exit |
| Claude PreToolUse hook | User's project | Claude Code runtime | opaque; may abort agent tool calls |
| Artifact validators | Yoke core | Pipeline Engine after session exit | ajv result |
| Item manifest diff check | Yoke core | Pipeline Engine after session exit | diff vs pre-phase snapshot |
| `.yoke/last-check.json` | User's Stop hook (optional) | User's code | display-only in dashboard |

The harness treats user-owned and Yoke-owned gates identically at
the state-machine level: either the phase is accepted or the
transition table routes to `awaiting_retry` / `awaiting_user`.

---

## 6. Worked example: user with no hooks at all

A user with `safety_mode: yolo` and no Claude hooks runs:

```yaml
phases:
  implement:
    command: claude
    args: ["-p", "--output-format", "stream-json"]
    post:
      - name: "typecheck"
        run: ["pnpm", "typecheck"]
        actions: { "0": "continue", "*": { retry: { mode: "continue", max: 1 } } }
      - name: "test"
        run: ["pnpm", "test"]
        actions: { "0": "continue", "*": { fail: { reason: "tests failing" } } }
```

Yoke acceptance flow:

1. `pnpm typecheck` — exit 0 → continue.
2. `pnpm test` — exit 1 → `fail: {reason: "tests failing"}` → state
   machine follows outer retry ladder.

No Claude Stop hook exists and the harness does not care. The user
chose `post:`-only gating; it is fully supported (plan-draft3
§Core Design Principles #2, D55).

---

## 7. Worked example: user with a Stop hook AND `post:`

Same project, but now the user installs the Stop-quality template
which runs the same checks and writes `.yoke/last-check.json`. Their
config becomes:

```yaml
phases:
  implement:
    command: claude
    args: ["-p", "--output-format", "stream-json"]
    post:
      - name: "require-manifest"
        run: ["jq", "-e", ".gates | all(.ok)", ".yoke/last-check.json"]
        actions:
          "0": "continue"
          "*": { fail: { reason: "manifest missing or not all ok" } }
```

Flow:

1. Claude session runs; the Stop hook runs its own checks and writes
   the manifest. The session exits.
2. Yoke runs `post:` `require-manifest`; `jq` returns 0 → continue.
3. Phase accepted.

Yoke observes the hook exit only through the outcome of the `claude`
process (session_ok) and the content of the file the hook produced.
The harness is agnostic to whether the hook exists.
