# Future Work

Running log of known-but-deferred items: things we noticed during active work, decided not to fix in the current round, and don't want to lose. Distinct from feature manifests (which drive execution) and `change-log.md` (archival). Append new entries at the bottom; mark resolved entries with `~~strikethrough~~` and a brief note rather than deleting so we retain the history.

Each entry should answer: **what** is deferred, **where** in the codebase it lives, **why** it was deferred, and **what** the fix would look like.

---

## Prompt templating for manifest path

**What.** `prompts/self-host-implement.md` and `prompts/self-host-review.md` hardcode `docs/idea/fixes-round-1-features.json` as the manifest the agent reads for item metadata. A TODO comment in each prompt flags the follow-up.

**Where.** `prompts/self-host-implement.md` (lines ~9, ~35), `prompts/self-host-review.md` (lines ~9, ~77).

**Why deferred.** Proper fix requires threading `items_from` through the assembler pipeline: `PromptContextInputs.stage` (in `src/server/prompt/context.ts:142`) currently exposes only `{ id, run }`; the scheduler's `PromptAssemblerFn` (`src/server/scheduler/scheduler.ts:101-102`) passes just `stageId`/`stageRun`. Plumbing the field end-to-end touches `PromptAssemblerFn`, `PromptContextInputs`, `buildPromptContext`, the scheduler call site (~line 955), and `src/cli/start.ts`. Deeper than the blocking-fixes round warranted.

**Fix sketch.** Extend `PromptContextInputs.stage` to include `itemsFrom?: string`. Plumb through `buildPromptContext`, the scheduler, and `start.ts`'s `assemblePromptFn`. Replace the hardcoded paths in both prompts with `{{stage.items_from}}`. Add a test in `tests/prompt/` that asserts the variable renders.

---

## `tsconfig.build.json` excludes `src/web`

**What.** The root build now ignores the web workspace.

**Where.** `tsconfig.build.json` — added `src/web` to the `exclude` array during the cancel-executor work.

**Why deferred.** Pre-existing break on the `dashboard` branch — `pnpm build` from the root tried to compile `src/web/**/*.tsx` using the root tsconfig, which has no JSX config. The web workspace has its own `src/web/tsconfig.json` exercised via `pnpm --filter web typecheck`. The exclude was a workaround to make `pnpm build` pass during blocking fixes; not caused by any of the round's work.

**Fix sketch.** Two options: (1) switch to TypeScript project references so the root build composes the server and web workspaces correctly, or (2) explicitly scope the root tsconfig's `include` to `src/server`, `src/cli`, `src/shared` and drop the `exclude` line. Option (2) is the smaller change.

---

## Pause / resume control actions not implemented

**What.** The UI `ControlMatrix` surfaces pause and resume buttons, but the server-side `controlExecutor` only accepts `cancel`. Any pause/resume request returns `invalid_action` with status 400.

**Where.** `src/server/pipeline/control-executor.ts` (the switch over `action`), `src/web/src/components/ControlMatrix/ControlMatrix.tsx` (the buttons).

**Why deferred.** Cancel was the blocking safety primitive for running workflows through the dashboard. Pause/resume needs a design decision about what "paused" means at the state-machine level — there's no `paused` state in the `State` union today, and retry-ladder timers, rate-limit windows, and in-flight sessions all interact with pause semantics.

**Fix sketch.** Either (a) add a `paused` workflow status (workflow-scope, not item-scope) that makes the scheduler skip ticking the workflow; resume flips it back. Or (b) hide the buttons in ControlMatrix until a real design lands. (b) is the right interim move to avoid user confusion.

---

## Item cards show UUID instead of stable id when `displayTitle` is missing

**What.** When an item's `displayTitle` is null (e.g. the placeholder row a per-item stage starts with, or any item whose manifest lacks the configured `items_display.title` JSONPath), FeatureBoard renders the opaque row UUID. The user-facing identifier should be the stable `items_id` extracted from the manifest (e.g. `fix-camelcase-api`), not a UUID.

**Where.** `src/web/src/components/FeatureBoard/FeatureBoard.tsx:286` — `{item.displayTitle ?? item.id}`. The `item.id` is the SQLite row UUID.

**Why deferred.** Shown up while running the fixes-round-1 workflow — the placeholder item displayed a UUID before seeding completed. Fixing properly means surfacing the manifest's stable id (items_id result) as a separate field on `ItemProjection` so the UI has something meaningful to fall back to; right now the stable id isn't threaded through to the projection.

**Fix sketch.** Add `stableId: string | null` to `ItemProjection` (shared type), populate it from the seeder when items are created, and update FeatureBoard fallback chain to `item.displayTitle ?? item.stableId ?? item.id`. For placeholder rows before seeding, render a neutral label like "Seeding…" or the stage id rather than a UUID.

---

## Flaky ControlMatrix e2e test

**What.** During the A5-loop fix verification, the full e2e suite failed on first run with one failure in `control-matrix.spec.ts`; passed on re-run and in isolation. Unrelated to the A5 changes.

**Where.** `src/web/e2e/control-matrix.spec.ts`.

**Why deferred.** Flake was investigated enough to rule out A5 as the cause (same test passed on `dashboard` tip before any changes). Real fix requires reproducing the flake — probably a race between a WS frame dispatch and a DOM assertion.

**Fix sketch.** Reproduce locally with `--repeat-each=20` to pin down the race. Likely needs a `page.waitForResponse` or a WS-frame-received wait instead of a timing-dependent assertion. Don't trust CI signal on this spec until fixed.

---

## Interactive "brainstorm" stage type

**What.** A new stage kind whose executor is an interactive conversation with an agent rather than a one-shot headless subprocess. Intended to sit upstream of the existing `plan` → `build` flow: the user and a brainstorm agent discuss what to build, the transcript/summary is written to a file (e.g. `brainstorm.md` in the worktree), and the downstream plan stage picks it up as input. Deferred after the templates refactor because the pipeline-template machinery is the prerequisite — with templates, the user can compose brainstorm→plan→build pipelines (or skip straight to plan-→build, or build-only) just by choosing which template to load.

**Where.** New code: a new `run:` variant in `docs/design/schemas/yoke-config.schema.json` (today only `once` / `per-item`); a new executor path alongside `src/server/scheduler/scheduler.ts` that doesn't spawn `claude -p`; new WS frame types in `src/server/api/frames.ts` for chat I/O; a new chat component in `src/web/src/components/`. Handoff contract between stages stays file-based (same pattern as `features.json` today).

**Why deferred.** The current phase executor always shells out to `claude -p --output-format stream-json --verbose --dangerously-skip-permissions` (see `.yoke/templates/*.yml` phase definitions and `src/server/process/jig-manager.ts`). There is no interactive mode. Adding one is a meaningful scope: choice of UX surface (web chat vs embedded pty/xterm.js vs CLI-only), stream-json input/output wiring, stage-completion semantics (how does the user signal "done"?), and how transcripts become the handoff artifact. Deferred until the templating refactor lands so the interactive stage can be composed into templates rather than bolted onto a single auto-loaded `.yoke.yml`.

**Fix sketch.**

1. Add a `run: conversation` (or similar) stage variant with fields for the transcript output path (e.g. `transcript_out: brainstorm.md`) and the "done" signal mechanism.
2. Pick a UX surface. Three realistic options:
   - **File-first (ship-fastest)**: stage pauses, UI shows "edit `.yoke/workflows/<id>/brainstorm.md` then click Done." User edits in their own editor. Zero new chat UI.
   - **Web chat**: spawn `claude` with `--input-format stream-json`, pipe WS messages to stdin, stream responses back as new chat frames. Reuses most session/log infra.
   - **Embedded pty (xterm.js)**: browser terminal attached to a claude pty. Simplest runtime, odd UX next to the rest of the dashboard.
3. Stage completes when the user clicks Done in the UI (or writes the transcript file in file-first mode). Stage's output file becomes the downstream plan stage's input.
4. Sketch sibling templates for the common entry points rather than making one template handle "skip-to-stage":
   - `brainstorm-plan-build.yml` (full flow)
   - `plan-build.yml` (you already have the idea, want features.json generated)
   - `build-only.yml` (you already have features.json)
5. Pre-requisites before starting: the templates refactor (this document's companion plan) must be landed so the picker UI exists to select between these sibling templates.

**Context (so this is picked up cleanly later).** Design conversation 2026-04-21 established: templates are static YAML, workflows are DB instances with user-supplied names and UUIDs (no template-based dedup), server startup pauses in-flight workflows rather than auto-resuming, and `.yoke.yml` at repo root is fully replaced by `.yoke/templates/*.yml`. The brainstorm stage was extracted from that conversation as a future-work item once templates are in place.

