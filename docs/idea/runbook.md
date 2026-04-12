# Yoke Build Runbook

Operational playbook for building Yoke, from plan approval to v1 release. Follow the phases in order. Check each box as you complete it. **Read the "Operational rules" section once before starting** — it covers session hygiene, loop-back conditions, and common failure modes.

Legend:
- `[ ]` = pending, `[x]` = complete
- **🛑 GATE** = quality gate; do not advance until all items above are checked
- **⚠ DECISION** = user decision point; don't skip
- **🤖 AGENT** = run a Claude Code session (plain `claude`, optionally via jig if you've set it up, or via yoke-v0/yoke once those exist)
- **👤 USER** = you do this by hand (review, approval, inspection)
- **📝 ARTIFACT** = check this file exists and is non-empty

---

## Operational Rules (read once)

### Session hygiene

- **New agent → new session, always.** Use `/clear` or spawn a fresh session between agents. Yoke's whole model is that agents communicate through files, not shared context. Carrying context between agents cheats the test.
- **Same agent, next feature → new session, always.** Forces the implementer to re-read `features.json`, `handoff.json`, `progress.md` — which is exactly what v1 will do.
- **Same agent, retry on failure within the same phase → use `-c`** (continuation). This is the one case where carrying context is correct. Cap at 3 `-c` attempts before falling back to a fresh session with handoff.json context.
- **Between phases → new session, always.** No exceptions.

### When to loop back

Loop back to an earlier phase when:
- **Architecture issue surfaces during build** → file an amendment to `plan-draft3.md` via the architect (new architect session, with a brief: "implementer discovered X is wrong, proposed fix Y, integrate into plan or escalate"). Do not silently change direction.
- **Research task returns a different answer than plan-draft3 assumes** (e.g., stream-json turns out not to be NDJSON) → architect amends plan, re-validate downstream assumptions.
- **A previously-passed gate fails later** (e.g., Phase δ E2E test reveals the hook contract is wrong) → loop back to phase γ research, then architect amendment.

Do **not** loop back for: agent hallucinations, missing tools, transient command errors, typos in your prompt. Fix in place.

### Claude vs jig invocation syntax

The runbook's default assumption is plain `claude -p < prompt.txt`. Yoke is not jig-dependent (see D55 in change-log.md); jig is a recommended docs-level layer for agent-profile scoping. Throughout:

- `claude -p < prompt.txt` — the baseline. Works without any setup beyond Claude Code itself. Add tool restrictions via `--allowed-tools` / `--disallowed-tools` if you want scoping without jig.
- `jig run <profile> -- -p < prompt.txt` — optional. If you've configured jig profiles, this scopes the Claude session to the named profile's tool set and MCP servers. Use it for the architect/backend/frontend/QA roles if you've set up profiles; skip it and use plain `claude` otherwise.

Either form works anywhere the runbook calls for an agent session.

### Agent personas

Every agent session in this runbook starts with a role identity. Those identities are **not** inlined into prompts — they live in standalone files so they can evolve independently and be cited consistently across phases:

- `docs/agents/architect.md` — cited by Phase β
- `docs/agents/backend.md` — cited by Phase γ (research + yoke-v0), Phase δ (planner + implementer loop)
- `docs/agents/frontend.md` — cited by Phase ε (planner + implementer loop)
- `docs/agents/qa.md` — cited by Phase ζ (planner + implementer loop + acceptance)

When a phase prompt says "Read `docs/agents/<role>.md` in full before proceeding" — that is non-optional. The persona file sets mode, vocabulary, deliverables, decision authority, anti-patterns, and session protocol. Treat it as the first input, before plan-draft3.

If you need to adjust role behavior that applies across multiple sessions, modify the persona file — not the prompt body. Prompt bodies should be task-specific context; persona files should be role-specific identity.

### Artifact locations

All paths are relative to repo root `/Users/jforsythe/dev/ai/yoke/`.

- Idea docs: `docs/idea/` (plan-draft2.md, plan-draft3.md, change-log.md, runbook.md — this file)
- Agent personas: `docs/agents/` (architect.md, backend.md, frontend.md, qa.md)
- Critiques: `docs/critiques/`
- Design (Phase β output): `docs/design/`
- Research (Phase γ output): `docs/research/`
- Prompts (Phase γ.4 output): `prompts/`
- **Hook example templates (opt-in)**: `docs/templates/hooks/`. If you use them, copy into `.claude/hooks/` (or wherever your Claude config expects). Yoke does **not** own a hook directory.
- Jig profiles (if you use jig): wherever jig reads from on your machine (usually `~/.jig/` or `.claude/profiles/`). Optional.
- Implementation: `src/server/`, `src/web/`, `src/cli/`, `src/shared/`, `tests/`
- Logs: `.yoke/logs/`
- SQLite: `.yoke/yoke.db`

---

## Phase α — Plan Revision (COMPLETE)

- [x] α.1 — Run 4 critique passes in parallel (architect, backend, frontend, QA) against plan-draft2.md
- [x] α.2 — Synthesize critiques into `change-log.md` + `plan-draft3.md`
- [x] α.3 — Hand off to user for review

📝 Artifacts:
- `docs/critiques/architect.md` ✓
- `docs/critiques/backend.md` ✓
- `docs/critiques/frontend.md` ✓
- `docs/critiques/qa.md` ✓
- `docs/idea/change-log.md` ✓
- `docs/idea/plan-draft3.md` ✓

---

## Phase α.5 — User Review & Decision Gate (COMPLETE, 2026-04-11)

All 12 open decisions (D50–D61) resolved. Several reframed from the original proposed defaults based on user feedback. Final decisions are recorded in `change-log.md` §Q and baked into `plan-draft3.md`.

- [x] α.5.1 — change log reviewed
- [x] α.5.2 — all decisions made; see resolution summary below
- [x] α.5.3 — plan-draft3 updated; all ⚠ needs-confirm markers removed

### Resolution summary

- [x] **D50 (reframed)** — configurable `pre:` / `post:` shell commands per phase with exit-code action grammar, replaces polyglot runner
- [x] **D51** — sandboxing deferred to v2
- [x] **D52** — v1 single-workflow, parallel → v1.1
- [x] **D53 (reframed)** — phase transitions via `post:` condition commands with `continue` / `goto` / `goto-offset` / `retry` / `stop-and-ask` / `stop` / `fail` + `max_revisits` guards
- [x] **D54** — `architecture.md` is both input and output; planner writes `architecture-proposed.md` when it wants to change an existing one
- [x] **D55 (reframed — major)** — jig is optional docs-only; Claude hooks live in Claude's namespace, owned by user; Yoke ships example templates; quality gating is user's choice of Claude Stop hook and/or Yoke `post:` commands; `.yoke/last-check.json` is an optional convention, not a mandatory contract
- [x] **D56** — review-fail re-implement defaults to fresh, configurable via `on_review_fail: { retry_mode }`
- [x] **D57** — single-user forever, 127.0.0.1, no auth; multiple instances of same user allowed
- [x] **D58** — SQLite forever, stream-json logs 30d/2GB, worktrees on workflow completion, all configurable; remote log forwarding is user's concern
- [x] **D59** — workflow continues non-dependent features; cascade-blocks dependents; terminal state "completed with blocked features"
- [x] **D60** — laptop-primary; opt-in `keep_awake: true` spawns `caffeinate -i` / `systemd-inhibit` as workflow child
- [x] **D61 (reframed)** — passive v1: parse rate-limit from stream, `rate_limited` state, auto-resume after window. v1.1: proactive workflow-wide % pause. v2: active polling. No per-step budgets.

### 🛑 GATE: Plan Approval — PASSED

- [x] plan-draft3.md reflects all decisions
- [x] All ⚠ needs-confirm markers removed
- [x] Architectural impact propagated (jig-optional, pre/post commands, keep_awake, passive rate-limit, optional manifest, command-agnostic spawn)

Advance to Phase β.

---

## Phase β — Core Design (Architect, Tier 0: manual)

The architect translates plan-draft3 into concrete implementable design artifacts. Fresh Claude Code session, read-only tools recommended (Read, Glob, Grep).

### β.1 — Spawn architect session

- [x] `/clear` in your Claude Code session (or open a fresh one)
- [x] Set working directory to repo root
- [x] Run the architect prompt below

**Architect prompt (paste into session or pipe via stdin):**

```
You are the Yoke architect. Before anything else, read docs/agents/architect.md in full — that is your role definition, session protocol, decision authority, and anti-pattern list. Follow it.

Task for this session: translate the approved plan (docs/idea/plan-draft3.md) into concrete, implementable design artifacts.

Read in order:
1. docs/agents/architect.md — your role (non-optional, first)
2. docs/idea/plan-draft3.md — the authoritative plan (supersedes draft2)
3. docs/idea/change-log.md — decisions made and why
4. docs/critiques/architect.md — your own critique from Phase α (your prior observations)
5. docs/critiques/{backend,frontend,qa}.md — skim for issues that affect the design you're producing
6. docs/idea/plan-draft2.md — reference only, do not re-litigate

Critical context from Phase α.5 (read change-log.md §Q before starting):
- Yoke is NOT jig-dependent. Each phase declares `command` and `args` (default `claude`). jig is recommended in docs, never required by harness code.
- Quality gates are the user's choice: Claude Stop hook (project-owned, not Yoke-owned), and/or Yoke `post:` commands (phase-level shell commands with exit-code action grammar). Harness accepts phase completion when: agent exited clean + all `post:` commands passed + artifact validators passed.
- `.yoke/last-check.json` is an OPTIONAL convention, not a mandatory contract. Dashboard displays it if emitted; harness does not require its presence.
- Phase transitions can branch via `post:` command exit codes mapped to actions: `continue`, `goto: <phase>`, `goto-offset: ±N`, `retry: {...}`, `stop-and-ask`, `stop`, `fail: {...}`, all with `max_revisits` loop guards.
- Passive rate-limit handling in v1: detect, `rate_limited` state, auto-resume after window. No proactive pause in v1.
- `keep_awake: true` config opt-in: `caffeinate -i` (macOS) or `systemd-inhibit` (Linux) as workflow child.
- Single-user forever, 127.0.0.1, no auth.

Produce the following artifacts under docs/design/ (create the directory):

1. architecture.md — module boundaries, dependency graph, directory layout for src/, process topology (what runs where), how the Pipeline Engine, (command-agnostic) Process Manager, Pre/Post Command Runner, Worktree Manager, Session Log Store interact. One page max per module. Read `architecture.md` at the repo root if it exists; if present, use it as an input and propose updates to `architecture-proposed.md` instead of overwriting it (per D54).

2. schemas/features.schema.json — JSON Schema for features.json (draft 2020-12), per plan-draft3 §File Contract.

3. schemas/yoke-config.schema.json — JSON Schema for .yoke.yml including: phase graph, phases with `command`/`args`/`pre`/`post`/`on_review_fail`, worktrees, notifications, github, retention, logging, `runtime` (keep_awake), `rate_limit`, ui sections.

4. schemas/review.schema.json — JSON Schema for reviews/feature-N/<angle>.json.

5. schemas/handoff.schema.json — JSON Schema for handoff.json.

6. schemas/sqlite-schema.sql — Final DDL including PRAGMA settings, all tables from plan-draft3 §SQLite Schema, all indexes, schema_migrations bootstrap. Include comments where the plan was ambiguous.

7. state-machine-transitions.md — The full `(from_state, event) → (to_state, side_effects, guard)` table from plan-draft3 §State Machine, expanded with every (state, event) pair the pipeline engine will encounter. Include a test assertion list. Cover the `rate_limited` state and the `pre:` / `post:` command transition events (action outcomes feed this table).

8. schemas/pre-post-action-grammar.md — Full definition of the pre/post command action grammar: what exit codes map to what actions, `max_revisits` semantics, how `goto-offset` resolves against the phase graph, how `retry` interacts with the outer retry ladder, how `fail` composes with artifact validators. Include JSON Schema for the `actions` map.

9. protocol-websocket.md — The full WebSocket envelope: all server→client types, all client→server types, payload schemas for each, sequence rules, subscribe/unsubscribe lifecycle, reconnect/backfill flow. Include a TypeScript type definition block. Add frame types for `prepost.command.started`, `prepost.command.output`, `prepost.command.ended` so the dashboard can render user-configured commands.

10. protocol-stream-json.md — The NDJSON line-buffered parser spec: buffer management, error handling, sanity caps, stderr separation, token usage extraction, rate-limit frame detection. Reference Phase γ research as the source of empirical details — it's OK to mark specific fields "TBD per research".

11. prompt-template-spec.md — The template engine spec: syntax, available variables per phase (feature_spec, architecture_md, progress_md, handoff_entries, git_log_recent, recent_diff, user_injected_context, etc.), undefined-variable behavior, PromptContext builder interface.

12. hook-contract.md — Renamed focus: this is the **quality-gate contract**, not a Yoke hook spec. Covers: (a) the optional `.yoke/last-check.json` manifest shape if a user's Claude Stop hook chooses to emit it, (b) how `pre:` and `post:` commands participate in phase acceptance, (c) example template descriptions under `docs/templates/hooks/`, (d) exit code expectations for Claude hooks (mark TBD where Phase γ research is needed). Yoke does NOT install, manage, or require any Claude hooks.

13. threat-model.md — Expanded from plan-draft3 §Threat Model with specific examples of each attack class and the exact mitigation control flow. Note that enforcement is opt-in — Yoke ships templates, user decides whether to install them.

14. open-questions.md — Anything you cannot resolve from plan-draft3 alone. Each question includes: what you need to know, why it blocks design, what you'd do by default if the user doesn't respond in 24h. If you'd have to guess, write the question instead.

Constraints:
- Do not write code (src/ is for Phase δ). Only design docs, schemas, SQL, type definitions.
- Do not revise plan-draft3 unilaterally. If you find a flaw in the plan, add it to open-questions.md — do NOT silently fix it.
- Cite plan-draft3.md section references in every artifact so reviewers can audit.
- Keep each artifact focused. Aim for 100-400 lines per file.
- Use the existing docs/critiques/ as input — your prior critique covered these issues from the architect lens, don't duplicate.
- Do NOT assume jig exists anywhere in the design. `command` and `args` are the spawn inputs; `jig` is mentioned only in best-practices prose.

When done, print a summary listing every file you created with a one-line description. Stop there. Do not propose next steps.
```

- [x] Let the architect session run to completion
- [ ] If the session exits mid-work: `claude -c` to continue
- [ ] If it fails 3 times: loop back to α.5 (the prompt itself may be wrong), do not keep retrying

### β.2 — Verify architect output

- [x] 📝 `docs/design/architecture.md` exists (or `docs/design/architecture-proposed.md` if an `architecture.md` already existed at repo root)
- [x] 📝 `docs/design/schemas/features.schema.json` exists and is valid JSON
- [x] 📝 `docs/design/schemas/yoke-config.schema.json` exists
- [x] 📝 `docs/design/schemas/review.schema.json` exists
- [x] 📝 `docs/design/schemas/handoff.schema.json` exists
- [x] 📝 `docs/design/schemas/sqlite-schema.sql` exists
- [x] 📝 `docs/design/schemas/pre-post-action-grammar.md` exists
- [x] 📝 `docs/design/state-machine-transitions.md` exists
- [x] 📝 `docs/design/protocol-websocket.md` exists
- [x] 📝 `docs/design/protocol-stream-json.md` exists
- [x] 📝 `docs/design/prompt-template-spec.md` exists
- [x] 📝 `docs/design/hook-contract.md` exists
- [x] 📝 `docs/design/threat-model.md` exists
- [x] 📝 `docs/design/open-questions.md` exists

### β.3 — User review of design

- [x] Read `docs/design/open-questions.md` first — if anything is blocking, resolve now
- [x] Skim every design artifact for obvious wrongness
- [x] Run every schema file through a JSON Schema validator (e.g., `npx ajv-cli@5 compile --spec=draft2020 --validate-formats=false -s docs/design/schemas/features.schema.json`)
- [x] Run the SQLite DDL against an empty in-memory database: `sqlite3 :memory: < docs/design/schemas/sqlite-schema.sql`

### 🛑 GATE: Design Approval

- [x] All 14 design artifacts exist and pass basic syntax checks
- [x] Open questions are resolved (either answered, accepted as-is, or deferred to a later phase with explicit note)
- [x] SQLite DDL runs clean against an empty database
- [x] All JSON Schemas compile
- [x] You've spot-checked at least 3 design artifacts and agree with the architect's choices

**On failure:** loop back to β.1 with a new architect session, brief it with the specific rejection (e.g., "the state machine transitions.md is missing X and Y; fix those and preserve everything else"). Never edit the artifacts by hand — always go through a new agent session so the process stays audit-able.

---

## Phase γ — Empirical Research + yoke-v0 Bootstrap (Backend, Tier 0 → 0.5)

This phase has two parts: (1) verify the load-bearing assumptions before you build anything, (2) write the minimal `yoke-v0` glue script that will drive all of Phase δ.

### γ.1 — Research task: stream-json framing + token events

This is a 🤖 AGENT task, but it's research, not implementation.

- [x] `/clear` / fresh session
- [x] Run this prompt:

```
You are the Yoke backend engineer. Before anything else, read docs/agents/backend.md in full — that is your role definition, session protocol, and anti-pattern list. Pay particular attention to the "skipping empirical verification" anti-pattern; that is the exact failure this session is designed to prevent.

Task for this session: empirical research only (no code). Determine the exact framing and event vocabulary of Claude Code's --output-format stream-json output, so the parser can be written correctly later.

Read docs/design/protocol-stream-json.md to understand what the plan expects before starting.

Then:

1. Run a real Claude Code session and capture its stream-json to a file. Suggested command:
   claude -p "List three ways to reverse a string in Python. For each, write a small test using the Bash tool." --output-format stream-json > /tmp/yoke-capture-1.jsonl 2>&1
   (This triggers text + tool_use + tool_result events.)

2. Analyze /tmp/yoke-capture-1.jsonl:
   - Is it line-delimited? (one JSON object per line, separated by \n)
   - Or concatenated? (JSON objects back-to-back with no separator)
   - Are any objects multi-line?
   - What's the event type vocabulary? List every unique `type` field you see.
   - For each event type, sketch the shape (required fields, nested blocks).
   - Where does token usage appear? What event type, what fields, is it cumulative or delta?

3. Repeat with a longer session that will likely span multiple turns and produce larger events:
   claude -p "Create a 200-line Python script that implements a basic HTTP server with routing, logging, and error handling. Use the Edit tool to write it to /tmp/http_server.py." --output-format stream-json > /tmp/yoke-capture-2.jsonl 2>&1

4. Analyze capture-2 for: max line length, presence of embedded newlines inside strings, JSON escaping used.

5. Verify the `-c` continue semantics with a third test:
   claude -p "Remember the number 42." --output-format stream-json > /tmp/yoke-capture-3a.jsonl
   claude -c -p "What number did I ask you to remember?" --output-format stream-json > /tmp/yoke-capture-3b.jsonl
   - Does -c work across separate invocations?
   - Where is session state stored (~/.claude/? project-local? temp?)
   - Does the response in 3b confirm the model remembers 42?

Write your findings to docs/research/stream-json-semantics.md with exact field names, example payloads (abbreviated if huge), and a recommendation for the parser implementation (NDJSON line-buffered? something else?).

Also write docs/research/continue-semantics.md covering the -c behavior you observed.

Do not write any Yoke code. This is a research deliverable only. Cite the captured files by path so a reader can re-check your work.
```

- [x] 📝 `docs/research/stream-json-semantics.md` exists
- [x] 📝 `docs/research/continue-semantics.md` exists
- [x] 👤 Read both and verify the conclusions are sound
- [x] If stream-json is NOT NDJSON, **loop back to β.1** — architect amends plan-draft3 and protocol-stream-json.md

### γ.2 — Research task: hook exit code semantics

- [x] `/clear` / fresh session
- [x] Run this prompt:

```
You are the Yoke backend engineer. Before anything else, read docs/agents/backend.md in full. Your anti-patterns and session protocol live there.

Task for this session: empirical research only (no code). Determine the exact semantics of Claude Code hooks, specifically Stop and PreToolUse hooks, so the quality-gate contract can be correctly specified. Note: Yoke does NOT own or install Claude hooks (see D55) — this research informs the optional example templates Yoke ships and the quality-gate contract doc, not a Yoke-owned hook directory.

Read docs/design/hook-contract.md first.

Then, in a throwaway directory, set up a test:

1. Create .claude/settings.json (or .claude/hooks.json — check docs) with a Stop hook pointing at a test script.
2. Test these behaviors in sequence, each with a different hook exit behavior:
   a. Exit 0 (success) — does the session end cleanly?
   b. Exit 2 with stderr message — does Claude see the stderr and try again? What does the subsequent turn look like in stream-json?
   c. Exit 1 — what does Claude do? Does the session end in error, or retry?
   d. Exit 127 / ENOENT — what happens when the hook script is missing?
   e. Hook hangs (script sleeps 60 seconds) — is there a built-in timeout?
   f. Hook writes structured JSON to stdout — does Claude Code parse that, and does it override exit codes?
   g. Stdin to hook — what JSON does Claude pass in? Run `cat > /tmp/hook-stdin.json` as the hook body and inspect.

Repeat the exercise for PreToolUse hooks briefly to verify the exit code semantics are the same (or document differences).

Write findings to docs/research/hook-semantics.md. Include:
- Exit code matrix (exit code → Claude behavior) for Stop and PreToolUse
- Hook stdin JSON schema (what Claude passes in)
- Hook stdout JSON contract (if any)
- Default timeout behavior (does Claude kill a hung hook? after how long?)
- File paths for hook configuration (.claude/settings.json vs .claude/hooks.json — confirm current location)
- A recommendation for how to structure the require-passing-checks.sh Stop hook and the safety PreToolUse hook.

Do not write any Yoke code. Research only. Cite your test scripts and captured outputs.
```

- [x] 📝 `docs/research/hook-semantics.md` exists
- [x] 👤 Read and verify
- [x] If findings contradict plan-draft3, **loop back to β.1** for architect amendment

### γ.3 — Research task: jig invocation specifics (OPTIONAL)

Per D55, Yoke does not depend on jig — `command`/`args` per phase is the spawn contract, default `claude`. This research task exists only to inform the **best-practices doc** that mentions jig as a recommended scoping layer. Skip it if you are not personally using jig; you can always add it later. When done, this research does NOT feed into the Process Manager design (which must be jig-agnostic).

- [x] `/clear` / fresh session
- [x] Run this prompt:

```
You are the Yoke backend engineer. Before anything else, read docs/agents/backend.md in full.

Task for this session: empirical research only (no code). Determine how jig (the Claude Code profile tool) behaves when spawned as a child process, so the best-practices doc can describe it accurately. This research is OPTIONAL and does NOT feed the Process Manager design — the Process Manager is command-agnostic by contract (D55). Skip this task entirely if you are not personally using jig.

If jig is not installed or doesn't exist in this environment, write docs/research/jig-semantics.md with a note "jig not available — fallback is direct `claude -p` invocation" and move on.

If jig IS installed:

1. How does `jig run <profile>` resolve profiles? Config file location?
2. Does jig fork its own child or exec claude in place? (check with `jig run <profile> -- claude --version` and look at the process tree)
3. Does jig propagate signals? Test: start a long-running jig command, SIGTERM the jig pid, check if claude child dies.
4. Does jig change the working directory? cwd inside the jig-spawned process vs. the caller's cwd.
5. What's the exit code on profile-not-found? Profile-config-invalid? claude binary not on PATH?
6. Can jig profiles pass --allowed-tools / --disallowed-tools through to claude?
7. How do jig profiles interact with --output-format stream-json? Is the format passed through unchanged, or does jig wrap it?

Write findings to docs/research/jig-semantics.md. This feeds the best-practices guide only — the Process Manager is already command-agnostic by design.

Do not write any Yoke code. Research only.
```

- [x] 📝 `docs/research/jig-semantics.md` exists (optional; may be skipped)
- [x] 👤 Read and note anything worth capturing for the best-practices doc

### γ.4 — Build yoke-v0 (the bootstrap glue)

This is the Tier 0 → 0.5 transition. Write a minimal shell script + prompt template directory so subsequent agent sessions have consistent inputs.

- [x] `/clear` / fresh session
- [x] Run this prompt:

```
You are the Yoke backend engineer. Before anything else, read docs/agents/backend.md in full. This session is an exception to one rule in that file: you are writing shell script + a tiny helper, not TypeScript under src/server/. Everything else in the persona applies — especially "inventing abstractions" and "silently widening scope."

Task for this session: build yoke-v0, the minimal shell-script bootstrap glue that Yoke will dogfood during its own implementation. This is NOT v1 Yoke — it's a ~200-line shell script that assembles prompts and spawns Claude Code sessions with consistent context, so we can drive the Phase δ implementation work before the real pipeline engine exists.

Read first:
- docs/agents/backend.md (role, non-optional)
- docs/idea/plan-draft3.md §Build Order and §Operational Rules
- docs/idea/runbook.md (this file) for how yoke-v0 will be invoked
- docs/design/prompt-template-spec.md for the template engine contract
- docs/research/stream-json-semantics.md for how to capture output
- docs/research/continue-semantics.md for when -c is safe
- docs/research/jig-semantics.md (if present) for invocation mode

Scope of yoke-v0 (deliberately small):

1. A `yoke-v0` bash script at repo root (chmod +x). Subcommands:
   - `yoke-v0 run <phase> <feature-id>` — assembles the prompt for that phase+feature and runs it
   - `yoke-v0 continue <phase> <feature-id>` — same, but with -c
   - `yoke-v0 record <phase> <feature-id> <label>` — captures stream-json for a fixture
   - `yoke-v0 logs <session-id>` — prints a recent session's captured stream-json

2. A `prompts/` directory with minimal templates:
   - `prompts/plan.md`
   - `prompts/implement.md`
   - `prompts/review.md`
   - Each uses {{variable}} substitution per docs/design/prompt-template-spec.md

3. Template assembly: a small bash function (or a Python/Node helper — your choice, but keep dependencies minimal) that reads a template and substitutes variables from:
   - The feature spec (read from docs/idea/yoke-features.json — which will be created in Phase δ.1)
   - architecture.md / plan-draft3.md (cat inline)
   - progress.md (cat or empty)
   - handoff.json entries for this feature (grep by feature_id, or empty)
   - git log -20 --oneline
   - recent diff (git diff HEAD~5..HEAD or empty)

4. Invocation: read `command` and `args` for the phase from `.yoke-v0.yml` (a tiny yaml or json config file yoke-v0 loads); default is `command: claude`, `args: ["-p", "--output-format", "stream-json"]`. Users who want jig put `command: jig`, `args: ["run", "planner", "--", "-p", "--output-format", "stream-json"]`. Capture stdout to `.yoke/logs/<timestamp>-<phase>-<feature-id>.jsonl`. Run any configured `pre:` commands before spawning the agent, and any `post:` commands after the agent exits — exit-code handling in yoke-v0 can be minimal: exit 0 = pass, anything else = fail with a log line (no action grammar in v0; that's a v1 feature).

5. A simple session index: append one line per session to `.yoke/sessions.jsonl` with {ts, phase, feature_id, log_path, exit_code}.

Explicit NON-GOALS for yoke-v0:
- NO state machine — you manage progression by hand
- NO SQLite — just log files
- NO retry logic — if a session fails, you re-run manually
- NO Claude hook installation — if you have Claude hooks installed, they run as usual; yoke-v0 does not install, manage, or validate them
- NO pre/post action grammar — nonzero exit on a pre/post command just logs a warning; no branching
- NO worktree management — run in the repo root or a user-created worktree
- NO dashboard — tail the log file if you want to watch
- NO crash recovery — you're the recovery
- NO rate-limit handling — if a session rate-limits, you re-run manually after the window
- NO `keep_awake` helper — run it yourself with `caffeinate -i -w $$` if you need it

yoke-v0 should be <300 lines total across the script + any helper. If you're writing more than that, stop and simplify.

After writing:
1. Smoke test: create a trivial docs/idea/yoke-features.json with one fake feature, then run `./yoke-v0 run plan yoke-features.json` with a dry prompt that just asks Claude to echo "hello". Verify the log file is captured and the session exits cleanly.
2. Write `docs/runbook-addenda/yoke-v0-usage.md` with exact invocation examples for each subcommand, what env vars are required, and how to recover when things go wrong.

Commit the script, prompts, and usage doc. Print a summary listing every file you created. Stop.
```

- [x] 📝 `yoke-v0` script exists and is executable
- [x] 📝 `prompts/plan.md`, `prompts/implement.md`, `prompts/review.md` exist
- [x] 📝 `docs/runbook-addenda/yoke-v0-usage.md` exists
- [x] 👤 Smoke test: `./yoke-v0 run plan test-feat` on a throwaway feature — verify log is captured
- [x] 👤 Open the captured log and confirm stream-json events are readable

### 🛑 GATE: Phase γ complete

- [x] All 3 research docs exist and were read by the user
- [x] Nothing in research contradicts plan-draft3 (or if it does, an architect amendment landed in β)
- [x] yoke-v0 smoke test passes
- [x] You understand how to invoke yoke-v0 for any phase

**On failure:** isolate which part failed. Research failures → new research session. yoke-v0 failure → new backend session with a specific rejection brief. Never retry the same failing prompt more than 3 times.

---

## Phase δ — Core Engine Implementation (Backend via yoke-v0, Tier 0.5)

This is where Yoke starts building itself. Use `yoke-v0` to drive feature-by-feature implementation of v1's core engine. You are the state machine in this phase — you decide which feature runs next.

### δ.1 — Plan the engine features

- [x] `/clear` / fresh session
- [x] Ask the planner to decompose the v1 core engine (NOT dashboard, NOT QA) into discrete features:

```
You are the Yoke backend engineer, operating in planner mode for this session. Before anything else, read docs/agents/backend.md in full — role, vocabulary, decision authority, anti-patterns. This session produces a features.json only (no code).

Read:
- docs/agents/backend.md (role, non-optional)
- docs/idea/plan-draft3.md §Requirements §Must Have (v1)
- docs/design/architecture.md
- docs/design/state-machine-transitions.md
- docs/design/schemas/sqlite-schema.sql
- docs/design/protocol-websocket.md
- docs/design/hook-contract.md

Produce docs/idea/yoke-features.json — a features.json file conforming to docs/design/schemas/features.schema.json — containing ONLY the core engine features (no dashboard, no QA phase tests beyond unit tests, no release polish). Target 15-25 features.

Each feature must have:
- id, category, description, priority
- depends_on populated with real dependencies (topo-sortable)
- acceptance_criteria — concrete, testable
- review_criteria — what reviewers will check

Core engine scope (group into categories):
- config (yaml parser, ajv-cli validation, version pin)
- db (sqlite setup, WAL, migrations, each table + indexes, transaction wrapper)
- state-machine (transition table, transition fn, unit tests)
- process-mgr (JigProcessManager, ScriptedProcessManager, NDJSON parser, heartbeat, spawn/kill, EPIPE)
- worktree-mgr (create, bootstrap phase, teardown, cleanup)
- prompt-asm (template engine, PromptContext builder)
- pipeline-engine (load config, run phase, advance state, dependency resolution)
- hook-contract (manifest validator, checksum recorder, tamper detector)
- artifact-validators (ajv-cli against features/review/handoff schemas, diff check)
- session-log-store (per-session JSONL, paging endpoint stub)
- fastify-ws (envelope, subscribe/backfill, protocol version check)
- cli (yoke init, start, status, cancel, doctor, record)
- fault-injector (checkpoint seam for tests)
- github-integration (octokit path, gh fallback, auth resolution, push-before-pr)
- notifications (node-notifier + browser-push endpoint stubs)

Do NOT include the React dashboard (that's Phase ε) — only the ws/http server endpoints it will consume. Do NOT include v1.1 or v2 items.

Write to docs/idea/yoke-features.json. Print the resulting topological order. Stop.
```

- [x] 📝 `docs/idea/yoke-features.json` exists and is valid per the schema
- [x] 👤 Validate: `npx ajv-cli@5 validate --spec=draft2020 --validate-formats=false -s docs/design/schemas/features.schema.json -d docs/idea/yoke-features.json`
- [x] 👤 Check topological order — no cycles, dependencies reasonable
- [x] 👤 Manually pick the first 3 features to implement (typically: config parser, db setup, state-machine)

### δ.2 — Implement each feature (loop)

The implement prompt template (`prompts/implement.md`, built in γ.4) must include the line "You are the Yoke backend engineer. Read docs/agents/backend.md in full before proceeding." as the first line of the prompt body. If yoke-v0's template doesn't inject that line, fix the template before starting the loop. Same rule applies when Yoke self-hosts in δ.3 — the prompt template in `.yoke.yml` references `docs/agents/backend.md`.

For each feature in topological order:

- [x] `/clear` / fresh session (if not using `yoke-v0` to drive, otherwise yoke-v0 handles the fresh session)
- [x] Invoke: `./yoke-v0 run implement <feature-id>`
- [x] Watch the stream-json log (in another terminal: `tail -f .yoke/logs/<latest>.jsonl` or just let yoke-v0 print it)
- [x] When the session exits:
  - ✅ **Clean exit + hook manifest OK** → feature done, mark status in yoke-features.json, append to handoff.json, move to next
  - ❌ **Clean exit + tests failing** → this shouldn't happen if the hook is working. If it does, the hook is broken — diagnose before continuing.
  - ❌ **Hook blocked stop, session gave up** → `./yoke-v0 continue implement <feature-id>` once; if still failing, fresh session with handoff.json updated with failure summary; if still failing after that, flag the feature as blocked and skip (mark `awaiting_user`)
  - ❌ **Process died unexpectedly** → check `.yoke/logs/` for the crash, `./yoke-v0 continue` once, else fresh
- [ ] Check implement result: `make last-status PHASE=implement FEATURE=<feature-id>` — look for `Verdict : PASS`; on FAIL, check `make last-output PHASE=implement FEATURE=<feature-id>` for details

- [ ] After each feature: `git status && git diff --stat` — sanity check that only expected files changed
- [ ] After each feature: `./yoke-v0 run review <feature-id>` — review against acceptance and review criteria; if blocking issues found, address then re-implement before moving on
- [ ] Check review result: `make last-status PHASE=review FEATURE=<feature-id>` — `Verdict : PASS` + `Blocking: none` required to proceed; on FAIL run `make last-output PHASE=review FEATURE=<feature-id>` to read the full report
- [ ] After each feature: `pnpm test` (skip until `package.json` exists; once it does, run after every feature)

### δ.3 — Self-hosting checkpoint

At some point during δ, you'll have built:
- config parser
- SQLite store
- state machine
- process manager (at least JigProcessManager)
- worktree manager
- pipeline engine
- prompt assembler
- CLI `yoke start`

As soon as these exist and pass unit tests, **try self-hosting**:

- [ ] Write a minimal `.yoke.yml` at repo root targeting the remaining features
- [ ] Run `./yoke start` on the yoke-features.json
- [ ] If it drives the next feature successfully → graduate to Tier 1 (stop using yoke-v0)
- [ ] If not → fix the bugs, retry until self-hosting works

🛑 **Self-hosting milestone achieved** when `./yoke start` successfully implements at least one feature without human shepherding beyond starting it.

### δ.4 — Complete remaining core engine features under v1 self-hosting

- [ ] Continue through yoke-features.json using Yoke v1 itself
- [ ] Stop hook is now enforcing — trust but verify by spot-checking tests manually on a few features
- [ ] Every blocked feature: debug, unblock, retry — don't let the backlog grow

### 🛑 GATE: Phase δ complete

- [ ] All core engine features in yoke-features.json are `complete` or justified as `blocked`/`deferred`
- [ ] `./yoke start` can drive a workflow from config to completion on a fixture project
- [ ] Unit tests pass: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
- [ ] `yoke doctor` reports no dangling processes
- [ ] SQLite schema migrations run cleanly on an empty DB and on a v0-era DB
- [ ] ScriptedProcessManager replays a captured fixture through the pipeline to a terminal state

---

## Phase ε — Dashboard + Integrations (Frontend via v1 harness, Tier 1)

Now Yoke drives its own frontend build. Use `yoke start` for each feature.

### ε.1 — Plan the dashboard features

- [ ] `/clear` / fresh session
- [ ] Run this prompt (via `yoke start plan docs/idea/dashboard-spec.md` if you have the planner phase wired up, else manually):

```
You are the Yoke frontend engineer, operating in planner mode for this session. Before anything else, read docs/agents/frontend.md in full — role, vocabulary, decision authority, anti-patterns. This session produces a features.json only (no code).

Read:
- docs/agents/frontend.md (role, non-optional)
- docs/idea/plan-draft3.md §Web Dashboard, §Protocol Layer, §Client Render Model, §Requirements
- docs/design/protocol-websocket.md
- docs/design/architecture.md

Produce docs/idea/dashboard-features.json — features.json for the dashboard build only. Scope:

- Scaffold React + Vite + Tailwind app under src/web/
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

Target 12-20 features. Populate depends_on, acceptance_criteria, review_criteria. Topologically sorted. Write to docs/idea/dashboard-features.json. Stop.
```

- [ ] 📝 `docs/idea/dashboard-features.json` exists and validates

### ε.2 — Drive dashboard implementation

The dashboard phase's prompt template must inject "You are the Yoke frontend engineer. Read docs/agents/frontend.md in full before proceeding." as the first line. Configure this in `.yoke.yml` (the dashboard workflow's `prompts.implement` template) before starting the loop.

- [ ] `yoke start dashboard-features.json` (or equivalent) — kicks off the full pipeline with plan already done
- [ ] Watch from the dashboard you're building — **yes, this is recursive; it's fine, use the server API + terminal until the dashboard renders itself**
- [ ] Loop on failures per δ.2 rules

### ε.3 — Manual browser verification

The hook-based gates can't verify UX. After each significant dashboard feature:

- [ ] `pnpm dev` → open the dashboard in a browser
- [ ] Manually exercise the new feature
- [ ] Check the golden path and the top 2-3 edge cases
- [ ] If something looks wrong, open a fresh frontend session with a specific fix brief

### 🛑 GATE: Phase ε complete

- [ ] All dashboard features marked `complete` in dashboard-features.json
- [ ] Full v1 E2E flow runs via the dashboard: start workflow → watch stream → see completion
- [ ] Reconnect mid-stream works without data loss (kill the WS connection in devtools, observe backfill)
- [ ] Manual controls (pause/cancel/skip) all produce correct state transitions
- [ ] Browser push permission flow works on a fresh Chrome profile
- [ ] macOS native notification click deep-links back to the correct workflow

---

## Phase ζ — QA + Release (QA via v1 harness, Tier 1)

### ζ.1 — Plan the QA deliverables

- [ ] `/clear` / fresh session

```
You are the Yoke QA engineer. Before anything else, read docs/agents/qa.md in full — role, vocabulary, decision authority, anti-patterns. This session produces a features.json only (no code, no fixtures yet).

Read:
- docs/agents/qa.md (role, non-optional)
- docs/idea/plan-draft3.md §Testability, §v1 Acceptance, §Failure Modes
- docs/critiques/qa.md — your prior observations
- docs/design/state-machine-transitions.md

Produce docs/idea/qa-features.json — features.json for the QA + release build. Scope:

- `yoke record` mode for capturing fixtures (if not already built in δ)
- Fixture suite: one per row in the Failure Modes table, named per plan-draft3 §Testability fixture list
- FaultInjector tests: one per named checkpoint
- E2E test: scripted happy-path workflow via ScriptedProcessManager
- E2E test: SIGTERM-mid-implement → restart → convergence
- E2E test: `post:` command with `goto` action → phase revisits target, `max_revisits` enforced
- E2E test: malformed features.json → schema error
- E2E test: crash during SQLite write → WAL recovery
- Dashboard smoke tests (Playwright): workflow list, feature board, stream pane, controls, GitHub buttons, notifications
- Validation report generator that runs the v1 Acceptance scenarios and outputs pass/fail per item
- README, config guide, threat model doc, prompt template guide — end-user facing docs, not internal design docs
- CI workflow running the fixture suite

Target 10-15 features. Topo sort. Write to docs/idea/qa-features.json. Stop.
```

- [ ] 📝 `docs/idea/qa-features.json` exists and validates

### ζ.2 — Drive QA implementation

The QA phase's prompt template must inject "You are the Yoke QA engineer. Read docs/agents/qa.md in full before proceeding." as the first line. Configure this in `.yoke.yml` before starting the loop.

- [ ] `yoke start qa-features.json`
- [ ] For each fixture: verify manually that it replays correctly through ScriptedProcessManager
- [ ] For each E2E test: run it locally before accepting completion
- [ ] Loop on failures

### ζ.3 — Run v1 Acceptance

- [ ] Execute the validation report generator
- [ ] 📝 `docs/releases/v1-acceptance-<timestamp>.md` exists with all 15 v1 acceptance scenarios green (per plan-draft3 §v1 Acceptance; scenario 16, parallel workflows, is v1.1)

### 🛑 GATE: v1 Release Candidate

- [ ] All qa-features complete
- [ ] Full CI green
- [ ] Validation report all green
- [ ] `yoke doctor` clean
- [ ] README, config guide, threat model doc exist and are accurate
- [ ] Self-hosting demo runs: check out a fresh copy of yoke, run `yoke init`, run a toy workflow to completion
- [ ] **The whole system has implemented itself from Phase δ onward** — this is the dogfooding success criterion

### ζ.4 — Tag and release

- [ ] 👤 Review the full commit history since Phase δ
- [ ] 👤 Write a CHANGELOG for v1
- [ ] 👤 Tag `v1.0.0`
- [ ] 👤 Publish (npm? GitHub release? both?)

---

## Post-release — Retrospective

- [ ] Run a retrospective agent session: read `.yoke/logs/` across the build, summarize which parts of plan-draft3 turned out to be wrong, which critique items were most load-bearing, and what plan-draft4 should say for a hypothetical v1.1.
- [ ] Archive `plan-draft2.md`, `plan-draft3.md`, `change-log.md`, critiques, research docs under `docs/archive/v1-build/`.
- [ ] Update the top-level README with the "Yoke built itself" story.

---

## Quick reference — decision ladder for common failures

| Symptom | First action | Second action | Third action |
|---|---|---|---|
| Agent session exits with error mid-phase | `./yoke-v0 continue <phase> <id>` or `yoke resume` | Fresh session with handoff.json updated | Mark `awaiting_user`, skip to next feature |
| Configured Claude hook blocking forever | Inspect the user-owned hook script; if buggy, fix it in place | If hook is persistently wrong, disable it in Claude config, note in handoff.json | Loop back to hook-contract.md if the pattern reveals a spec bug |
| `post:` command failing unexpectedly | Run the command manually in the worktree; fix or loosen the assertion | Update the action mapping (e.g., soften `fail` to `retry`) | Remove the command if it was over-specified |
| Worktree dirty after crash | Let recovery auto-stash | Inspect stash, decide keep/drop | `yoke doctor` reports the stash name |
| stream-json parse errors | Check sessions.status_flags; tainted session is flagged | Inspect captured log, file architect amendment if pattern is wrong | Fall back to line-by-line replay from capture |
| Dashboard shows stale state | WS reconnect (refresh page) | Check `pending_attention` — may be real | Restart harness server |
| Feature blocked on dependency | Check `blocked_reason`; resolve the dependency first | Manual "unblock with notes" from dashboard | Remove the `depends_on` entry if it was wrong |
| Architect session keeps proposing scope creep | Refresh with tighter brief citing specific constraints | Break the task into smaller sessions | Do the work yourself and move on |

---

## Estimated wall-clock

Rough sizing (depends heavily on session quality):
- Phase α: done
- Phase α.5: done
- Phase β: 1 architect session, ~30-60 min of Claude time + 30 min of user review
- Phase γ: 3 research sessions + yoke-v0 build, ~2-4 hours total
- Phase δ: **the big one** — 15-25 features × (10-45 min per feature) = 4-20 hours of agent time, plus loop-backs
- Phase ε: 12-20 features × similar cadence = 3-15 hours
- Phase ζ: 10-15 features + acceptance run = 2-8 hours
- Total: plan for a week of focused driving; expect two weeks with loop-backs

Don't optimize for speed. Optimize for letting each phase's gate be meaningful. A green gate you can trust saves more time than a fast gate you have to revisit.
