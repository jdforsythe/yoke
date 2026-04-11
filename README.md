# Yoke

An open-source, configurable AI agent harness framework that wraps Claude Code to drive long-running, multi-phase software workflows — planning, implementation, review, QA — with state durability, crash recovery, and a live dashboard.

**Status:** planning + design phase. No runnable code yet. Phase α.5 (user decision gate) is complete as of 2026-04-11. The next step is Phase β (architect produces design artifacts). See `docs/idea/runbook.md` for the full build plan.

---

## What Yoke is

- **A harness, not an IDE.** Yoke launches Claude Code (or any configured agent command) in worktrees, captures stream-json output, persists state in SQLite, and enforces phase transitions defined by your config.
- **Command-agnostic.** Each phase declares `command` and `args`; default is `claude`. `jig` (the profile tool) is a recommended but never-required layer. You can scope agent sessions however you like.
- **Hook-neutral.** Claude hooks live in Claude's namespace, owned by you. Yoke ships example templates under `docs/templates/hooks/` — install them if you want them, write your own if you don't.
- **Quality gates are your choice.** Phase acceptance is: agent exited clean + all configured `post:` commands passed + artifact validators passed. Whether you use a Claude Stop hook, Yoke `post:` commands, both, or neither is up to you.
- **Single-user forever.** Binds to 127.0.0.1, no auth, no multi-tenant. Multiple simultaneous instances of the same user are fine.
- **Laptop-primary.** Opt-in `keep_awake: true` spawns `caffeinate -i` (macOS) or `systemd-inhibit` (Linux) as a workflow child so your machine can work overnight on AC power.
- **Dogfoods itself.** The build plan graduates through three tiers: Tier 0 manual shepherding → Tier 0.5 `yoke-v0` shell glue → Tier 1 self-hosted (`yoke start` drives its own development).

---

## Current state

Phase α (plan critique) and Phase α.5 (user decision gate, D50–D61 resolved) are complete. The authoritative plan is `docs/idea/plan-draft3.md`. Nothing in `src/` exists yet.

Design artifacts (Phase β output) will land under `docs/design/`. Research notes (Phase γ output) will land under `docs/research/`. The bootstrap glue script (`yoke-v0`) will be written in Phase γ.4 and used to drive Phase δ implementation until Yoke can self-host.

---

## Repo layout

```
docs/
  idea/
    plan-draft2.md          # original plan (reference only, do not re-litigate)
    plan-draft3.md          # AUTHORITATIVE plan; decisions D1–D61 all resolved
    change-log.md           # D50–D61 decisions with rationale
    runbook.md              # phased build plan — follow this
  agents/                   # agent persona files, cited by runbook prompts
    architect.md
    backend.md
    frontend.md
    qa.md
  critiques/                # Phase α critique observations (4 lenses)
  design/                   # Phase β output (not yet created)
  research/                 # Phase γ output (not yet created)
  templates/hooks/          # opt-in Claude hook example templates (not yet created)
```

---

## How to continue (from any machine)

1. Clone the repo.
2. Read `docs/idea/plan-draft3.md` in full. This is the source of truth for scope, architecture, failure modes, acceptance scenarios, and open questions.
3. Read `docs/idea/change-log.md` §Q to understand why D50, D53, D55, D61 were reframed.
4. Read `docs/idea/runbook.md` — specifically the "Operational Rules" section, then the current phase (start of Phase β as of 2026-04-11).
5. Read the relevant `docs/agents/<role>.md` for the session you are about to run. Persona lives there, not in prompts.
6. Execute the next checklist item in the runbook. Do not skip ahead. Do not silently edit design artifacts by hand — always go through a new agent session so the process stays auditable.

**If a runbook prompt refers to a file that doesn't exist yet** (e.g., `docs/design/architecture.md` before Phase β runs), that's expected. The runbook is a forward-looking plan; earlier phases produce the files later phases read.

---

## Key rules (see runbook.md for the full list)

- **New agent → new session, always.** Agents communicate through files, not shared context.
- **Never silently revise the plan.** If you find a flaw in `plan-draft3.md`, file it via the architect in `change-log.md` — do not sneak fixes into design artifacts.
- **Every empirical assumption gets verified.** Phase γ captures real stream-json, real hook behavior — write the parser after you've looked at the data, not before.
- **Jig is optional.** `command` and `args` are the spawn contract. Never hard-code `jig` or `claude` in the harness.
- **Don't assume hooks.** Yoke phase acceptance does not require any Claude hook to exist. Users who want one install it in their own Claude config.

---

## License

TBD (will be set before the first public release).
