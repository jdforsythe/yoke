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
  ├─ features.json diff check (plan-draft3 §File Contract D10)
  └─ post: commands run in order (only if the above all passed)
        each command's exit code → action → state-machine transition
```

A phase is **accepted** (moves to the next state-machine state per the
transition table) iff all five stages succeed. Any `post:` action that
is not `continue` diverts the state machine — see
`state-machine-transitions.md` §post_command_action dispatch.

Yoke does not distinguish "quality gate passed" from "post command
passed." From the harness's point of view, the latter is the formal
mechanism; the former is a render-time convention the user may or may
not have chosen.

---

## 3. Example templates (ship under `docs/templates/hooks/`)

Yoke ships example hook templates users can copy into their Claude
hook directory. They are never installed by the harness; `yoke init`
offers them on opt-in and never overwrites user files. The set:

### 3.1 `PreToolUse-safety` (plan-draft3 §Threat Model, §Hooks)

A PreToolUse hook denying:
- Writes outside `${YOKE_WORKTREE_PATH}` (env injected by the harness).
- Reads of `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.netrc`, `~/.gnupg`.
- A curated Bash deny-list: `curl ... | sh`, `wget ... | sh`,
  `rm -rf /`, `chmod -R 777`, writes to `/etc/`.

The template is parameterized by the config flag `safety_mode: strict |
default | yolo`:
- `strict` adds a network egress allowlist and denies Bash `sudo`.
- `default` ships the deny list above.
- `yolo` scaffolds nothing.

**Templates are files, not code.** They are shell scripts living in
`docs/templates/hooks/`. Users copy, edit, or ignore.

### 3.2 `Stop-quality` (emits `.yoke/last-check.json`)

A Stop hook that project-type-detects (node / python / rust / …) and
runs typecheck/lint/test/build, writing the manifest shape in §1 on
success. Exit code semantics (see §4) are the user's responsibility.

### 3.3 Descriptions (what the template READMEs contain)

Each template directory ships a `README.md` describing:
- What the template does.
- Required environment it expects (`YOKE_WORKTREE_PATH`,
  `YOKE_WORKFLOW_ID`, `YOKE_FEATURE_ID` — these are guaranteed by the
  Process Manager's env propagation).
- Exit code expectations (TBD per Phase γ research, see §4).
- Where to copy the file into the user's Claude hook directory.
- How to customize or disable.

Template READMEs do **not** claim the hook is "installed" by Yoke —
they explain the copy-paste workflow explicitly.

---

## 4. Exit code expectations for Claude hooks (TBD per research)

Claude Code hook exit code semantics are the user's concern. Yoke does
not interpret a hook's exit code directly; it only interprets the
*agent session's* exit code. But for the example templates to be
correct, we need to know:

| Question | Answer |
|---|---|
| Exit 0 on Stop hook: does Claude proceed with session termination? | **TBD — Phase γ research** |
| Exit 2 on Stop hook: does Claude feed stderr back and retry? | **TBD — assumed yes per plan-draft3** |
| Exit 1 (generic): how does Claude treat it (ignore? block? fatal?) | **TBD — Phase γ research** |
| Exit on signal: how does Claude report it? | **TBD — Phase γ research** |
| stdin JSON schema delivered to hooks | **TBD — Phase γ research** |
| stdout JSON schema honored by Claude from hooks | **TBD — Phase γ research** |
| Hook wall-clock timeout enforced by Claude | **TBD — Phase γ research** |
| Can a Stop hook read the session transcript? | **TBD — Phase γ research** |
| Invocation granularity (per-session, per-matcher) | **TBD — Phase γ research** |

These are marked as research tasks in `docs/research/hook-semantics.md`
(produced during Phase γ per the runbook). The example templates ship
with comments pointing at that research document so updates don't
require template changes.

---

## 5. What Yoke does NOT do

Explicit non-behaviors (plan-draft3 §Hooks Integration D55, §What Yoke
Does NOT Do):

- **Does not install** hooks. `yoke init` may offer to copy example
  templates on opt-in; the user decides whether to accept.
- **Does not update** hooks between releases. If a template changes,
  the user re-runs `yoke init` and reviews a diff before accepting.
- **Does not verify** hook integrity or tamper-detect hook files
  unless the user wires a `post:` command to do so (e.g.,
  `sha256sum -c .yoke/hook-checksums`). Harness-enforced checksum
  verification is not part of v1.
- **Does not require** `.yoke/last-check.json` to accept a phase.
- **Does not own** any hook namespace, hook loader, or hook registry.
- **Does not map** exit codes from Claude hooks to Yoke state-machine
  events. The Pipeline Engine only observes the spawned command's
  exit code (which in most setups is `claude` itself, not a hook).

---

## 6. Interaction model summary

| Layer | Owner | Invoked by | Observed by Yoke as |
|---|---|---|---|
| `pre:` / `post:` shell commands | User (Yoke config) | Yoke Pre/Post Runner | exit code → action |
| Claude Stop hook | User's project | Claude Code runtime | opaque; Yoke sees only final `claude` exit |
| Claude PreToolUse hook | User's project | Claude Code runtime | opaque; may abort agent tool calls |
| Artifact validators | Yoke core | Pipeline Engine after session exit | ajv result |
| `features.json` diff check | Yoke core | Pipeline Engine after session exit | diff vs pre-phase snapshot |
| `.yoke/last-check.json` | User's Stop hook (optional) | User's code | display-only in dashboard |

The harness treats user-owned and Yoke-owned gates identically at
the state-machine level: either the phase is accepted or the
transition table routes to `awaiting_retry` / `awaiting_user`.

---

## 7. Worked example: user with no hooks at all

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

## 8. Worked example: user with a Stop hook AND `post:`

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
