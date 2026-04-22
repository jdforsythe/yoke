# Future Work

Running log of known-but-deferred items: things we noticed during active work, decided not to fix in the current round, and don't want to lose. Distinct from feature manifests (which drive execution) and `change-log.md` (archival). Append new entries at the bottom; mark resolved entries with `~~strikethrough~~` and a brief note rather than deleting so we retain the history.

Each entry should answer: **what** is deferred, **where** in the codebase it lives, **why** it was deferred, and **what** the fix would look like.

---

## ~~Prompt templating for manifest path~~

~~**What.** `prompts/self-host-implement.md` and `prompts/self-host-review.md` hardcode `docs/idea/fixes-round-1-features.json` as the manifest the agent reads for item metadata. A TODO comment in each prompt flags the follow-up.~~

~~**Where.** `prompts/self-host-implement.md` (lines ~9, ~35), `prompts/self-host-review.md` (lines ~9, ~77).~~

~~**Why deferred.** Proper fix requires threading `items_from` through the assembler pipeline: `PromptContextInputs.stage` (in `src/server/prompt/context.ts:142`) currently exposes only `{ id, run }`; the scheduler's `PromptAssemblerFn` (`src/server/scheduler/scheduler.ts:101-102`) passes just `stageId`/`stageRun`. Plumbing the field end-to-end touches `PromptAssemblerFn`, `PromptContextInputs`, `buildPromptContext`, the scheduler call site (~line 955), and `src/cli/start.ts`. Deeper than the blocking-fixes round warranted.~~

~~**Fix sketch.** Extend `PromptContextInputs.stage` to include `itemsFrom?: string`. Plumb through `buildPromptContext`, the scheduler, and `start.ts`'s `assemblePromptFn`. Replace the hardcoded paths in both prompts with `{{stage.items_from}}`. Add a test in `tests/prompt/` that asserts the variable renders.~~

**Implemented (pre-02).** `PromptContextInputs.stage` now carries `itemsFrom?: string`; the scheduler passes `stage.items_from` through `assemblePromptFn`; `buildPromptContext` projects it as `stage.items_from`. Both prompts use `{{stage.items_from}}`. Covered by `tests/prompt/context.test.ts` (§ 6) and `tests/prompt/assembler.test.ts` (§ 8).

---

## ~~`tsconfig.build.json` excludes `src/web`~~

~~**What.** The root build now ignores the web workspace.~~

~~**Where.** `tsconfig.build.json` — added `src/web` to the `exclude` array during the cancel-executor work.~~

~~**Why deferred.** Pre-existing break on the `dashboard` branch — `pnpm build` from the root tried to compile `src/web/**/*.tsx` using the root tsconfig, which has no JSX config. The web workspace has its own `src/web/tsconfig.json` exercised via `pnpm --filter web typecheck`. The exclude was a workaround to make `pnpm build` pass during blocking fixes; not caused by any of the round's work.~~

~~**Fix sketch.** Two options: (1) switch to TypeScript project references so the root build composes the server and web workspaces correctly, or (2) explicitly scope the root tsconfig's `include` to `src/server`, `src/cli`, `src/shared` and drop the `exclude` line. Option (2) is the smaller change.~~

**Implemented (r3-01).** Took Option 2 — root `tsconfig.build.json` scopes `include` to `src/server/**/*`, `src/cli/**/*`, `src/shared/**/*` and drops the `src/web` exclude workaround. Web workspace continues to build independently via `pnpm --filter web build`.

---

## ~~Pause / resume control actions not implemented~~

~~**What.** The UI `ControlMatrix` surfaces pause and resume buttons, but the server-side `controlExecutor` only accepts `cancel`. Any pause/resume request returns `invalid_action` with status 400.~~

~~**Where.** `src/server/pipeline/control-executor.ts` (the switch over `action`), `src/web/src/components/ControlMatrix/ControlMatrix.tsx` (the buttons).~~

~~**Why deferred.** Cancel was the blocking safety primitive for running workflows through the dashboard. Pause/resume needs a design decision about what "paused" means at the state-machine level — there's no `paused` state in the `State` union today, and retry-ladder timers, rate-limit windows, and in-flight sessions all interact with pause semantics.~~

~~**Fix sketch.** Either (a) add a `paused` workflow status (workflow-scope, not item-scope) that makes the scheduler skip ticking the workflow; resume flips it back. Or (b) hide the buttons in ControlMatrix until a real design lands. (b) is the right interim move to avoid user confusion.~~

**Implemented in templates refactor t-06.** pause/continue are workflow-scoped: pause sets `workflows.paused_at = now()`, continue clears it. The scheduler tick skips workflows where `paused_at IS NOT NULL` (via the `idx_workflows_paused_at` index added by migration 0005). Scheduler startup automatically pauses all non-terminal workflows so no workflow auto-resumes after a server restart. See `src/server/pipeline/control-executor.ts` and `tests/pipeline/control-executor.test.ts`.

---

## ~~Item cards show UUID instead of stable id when `displayTitle` is missing~~

~~**What.** When an item's `displayTitle` is null (e.g. the placeholder row a per-item stage starts with, or any item whose manifest lacks the configured `items_display.title` JSONPath), FeatureBoard renders the opaque row UUID. The user-facing identifier should be the stable `items_id` extracted from the manifest (e.g. `fix-camelcase-api`), not a UUID.~~

~~**Where.** `src/web/src/components/FeatureBoard/FeatureBoard.tsx:286` — `{item.displayTitle ?? item.id}`. The `item.id` is the SQLite row UUID.~~

~~**Why deferred.** Shown up while running the fixes-round-1 workflow — the placeholder item displayed a UUID before seeding completed. Fixing properly means surfacing the manifest's stable id (items_id result) as a separate field on `ItemProjection` so the UI has something meaningful to fall back to; right now the stable id isn't threaded through to the projection.~~

~~**Fix sketch.** Add `stableId: string | null` to `ItemProjection` (shared type), populate it from the seeder when items are created, and update FeatureBoard fallback chain to `item.displayTitle ?? item.stableId ?? item.id`. For placeholder rows before seeding, render a neutral label like "Seeding…" or the stage id rather than a UUID.~~

**Implemented (r3-04).** `ItemProjection` carries `stableId: string | null`; FeatureBoard resolves display names via `resolveItemDisplayName` (`src/web/src/components/FeatureBoard/displayName.ts`) using the fallback chain `displayTitle ?? stableId ?? 'Seeding…' | item.id` (per-item placeholders show "Seeding…", once-stage falls through to the UUID). Covered by `tests/web/featureBoard-stable-id.test.ts`.

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

## ~~Prompt shown at top of session logs~~

~~The session logs, when you choose a stage and they show in the right pane, need the initial prompt (with replacements injected) that was sent to the session for context (and debugging, to ensure replacements worked).~~

**Implemented.** Scheduler broadcasts a new `stream.initial_prompt` frame per session (`src/server/scheduler/scheduler.ts`) and writes the rendered prompt as the first JSONL log line. Reducer prepends an `InitialPromptBlock` to the session's block list; `InitialPromptRenderer` (`src/web/src/components/LiveStream/InitialPromptRenderer.tsx`) renders it collapsed-by-default with a char count and copy button. Covered by `tests/web/reducer.test.ts` and `tests/scheduler/scheduler.test.ts`.

## ~~Nomenclature~~

~~In the dashboard, the stages are called "Templates", and the search says "Search items...". In the config we call them "stages" and they have "phases" which will correspond 1:1 with agent sessions.~~

~~We need to be consistent with the naming.~~

~~The list view should be grouped/categorized by "stage" and the list items will remain 1:1 with stages, but should expand to show the individual phases/sessions (sessions is probably best here because if it goes through retries we want to be able to see *all* the sessions; so they should be labelled by the phase and ordered chronologically, and include rows for failures, like post command logs on failure with a failure row and describing that it triggered a goto implement, for instance).~~

~~The search can still say "Search items..." and should search the stages and phases/sessions (title/id/description, not log content).~~

**Implemented (phases 1–7 + nomenclature follow-ups + F1–F5).** Category filter renamed to "Filter by stage" with "All stages" sentinel; FeatureBoard groups by `stageId` with a STAGE chip header; item rows expand into a phase/session timeline served by `GET /api/workflows/:wf/items/:item/timeline`; search extends across stages and cached timeline rows (phase/command/id). Default template stage renamed `templates → bootstrap` (F1); `Stage` / `Phase` schemas gained optional `description` (F2); prepost stdout/stderr now stream to disk with persisted `stdout_path` / `stderr_path` (F3) and serve via `/api/workflows/:wf/prepost-run/:runId/:stream` into the right-pane (F4); the `/api/workflows/:wf/sessions` endpoint was retired in favor of `/timeline` and `HistoryPane` migrated with it (F5). Covered by `tests/api/item-timeline.test.ts`, `tests/api/snapshot-*.test.ts`, `tests/api/prepost-*.test.ts`, `tests/pipeline/engine.test.ts` (F3 persistence), `tests/web/fuzzyMatch.test.ts`, and e2e `stage-history.spec.ts` / `prepost-rendering.spec.ts`.

## ~~Graph View~~

~~We have a dashboard with a workflow list. When a workflow is selected, we show a list of sessions, and when a session is selected we show the logs. These are all in panes/panels.~~

~~We want a secondary view of the workflow. It should be similar in layout to something like n8n - an active box-and-arrow workflow diagram. Similar to the list dashboard view, we'd show which are in-progress/complete/pending by color and tag. a button or selecting a session could show the logs in a pane to the right (same way we do now, but hide it if none are selected). clicking outside a session on the "canvas" would de-select. with this diagram, we could easily show the topological dependency order, the stages with the phases/sessions, pre/post commands, and goto arrows (e.g. dotted if they're not "continue") to visualize the entire pipeline config for the user. This should provide all the same functionality as the session list view. The diagram should update with what *actually* happened - for instance if a review fails and it needs to goto the implement, that should *add* a new implement/review/post command stage to the canvas with an arrow showing the goto, or if it's clean enough just an arrow back and a second session in the existing stage/phase. This is an example based on our default pipeline config, but it should work for any config. Essentially the diagram starts as a visualization of the configured pipeline but updates in real time with the progress to become a diagram of what *actually* happened, and when it's finished, all optional paths that didn't get touched (gotos that didn't happen, etc) get removed, so it can be stored as a permanent artifact. it should be serializable as JSON so it can be stored in the db with a reference to the workflow id, so when viewing old workflows it can be loaded, or when continuing paused workflows it can be loaded and continued.~~

**Implemented (graph PR 1/2/3 + follow-up sweep).** New `src/server/graph/` module (`builder`, `derive`, `apply`, `prune`, `persist`, `events`, `ids`) projects a `WorkflowGraph` (nodes: stage/item/phase/session/prepost; edges: sequence/dependency/retry/goto/prepost) and persists it to `workflows.graph_state` via migration `0006_graph_state.sql`. Scheduler diffs graph state on every tick and emits a `graph.update` patch frame; `workflow.snapshot` carries the full graph on reconnect. Web store `graphStore.ts` caches per-workflow graphs (LRU, max 8); `GraphPane` renders the canvas with `@xyflow/react` + `elkjs` layout off the main thread, sharing selection state with the list view via URL (`?view=graph`). Session clicks route to the existing LiveStreamPane; non-session clicks open a `NodeSummaryPanel` in the right pane. `pruneUntraveled` runs at `workflow_status:completed` to strip un-traveled optional branches before the graph is frozen with `finalizedAt`. Covered by `tests/graph/*.test.ts` (apply/builder/derive/persist/prune), `tests/web/graphLayout.test.ts` / `graphPaneSelection.test.ts` / `graphStore.test.ts`, and e2e `graph-view.spec.ts`.

## ~~List view depends_on~~

~~We should add some information in the list view from the depends_on (so e.g. if my concurrency limit is 4, why are only 2 sessions working? i need to see the blockers to understand). the list view and the graph view need to show the description for the session/feature config.~~

**Implemented.** `ItemProjection` now carries `dependsOn` (stable IDs) and `displayDescription` (from `items_display.description` JSONPath). FeatureBoard renders a "Waiting on: …" line for pending/blocked items with unmet deps, and a description line under the title. `blockedReason` UUIDs are translated to stable IDs at render time. Graph view consumption is deferred to that work item. See `src/server/api/ws.ts buildSnapshot` and `src/web/src/components/FeatureBoard/FeatureBoard.tsx`.

---

# Cleanup — testing gaps for recently-completed work

Found while auditing the strikethrough items above. Each is a narrow coverage gap; nothing here blocks shipping but each is cheap to fix and worth picking up as a single pipeline before tackling the remaining pending items.

## cl-01. `InitialPromptRenderer` has no direct UI coverage

**What.** The server-side (`stream.initial_prompt` broadcast + JSONL write) and the reducer (block insertion order vs. `session.started`) are tested, but the React component itself has no unit or e2e test. The toggle expand/collapse, `{N} chars` count formatting, and copy-to-clipboard button — all advertised behaviour — are asserted nowhere.

**Where.** `src/web/src/components/LiveStream/InitialPromptRenderer.tsx` (testids `initial-prompt-toggle`, `initial-prompt-copy`, `initial-prompt-body`).

**Fix sketch.** Add a Playwright spec alongside `stream-pane.spec.ts` that mocks a WS session, sends `stream.initial_prompt`, and asserts: (1) the collapsed toggle appears at the top of the stream with the char count, (2) clicking toggles the body's visibility, (3) the copy button writes to `navigator.clipboard`. No unit test needed if the e2e covers these — but a small vitest+jsdom alternative is fine if wiring an e2e is noisy.

## cl-02. `NodeSummaryPanel` body contents and prepost-output fetch are untested

**What.** `graph-view.spec.ts` asserts the panel appears/disappears but never inspects its contents. None of the body variants (`StageBody` / `ItemBody` / `PhaseBody` / `PrePostBody`) have row-level assertions, and the `PrepostOutputSection` fetch — with its loading / 404 `No output captured` / HTTP-error / success / cache-hit states — has zero coverage despite being the one piece of non-trivial logic in the panel.

**Where.** `src/web/src/components/GraphPane/NodeSummaryPanel.tsx`.

**Fix sketch.** Two tests: (1) extend `graph-view.spec.ts` (or add a sibling) to click each non-session node kind and assert the expected rows render (`stage` / `item` / `phase` / `prepost`); (2) a vitest unit test against `PrepostOutputSection` that uses `fetch` mocks to cover loading → success, 404 → "No output captured" (check `data-testid="prepost-stdout-error"`), HTTP 5xx → generic error, and a cache-hit assertion by re-mounting with the same `runId`/`stream` and verifying no second `fetch` call. Export of `__clearNodeSummaryOutputCache` already exists for test isolation.

## cl-03. Graph pruning + finalization has no integration coverage

**What.** `pruneUntraveled` has unit tests and `applyEvent(workflow_status:completed)` sets `finalizedAt` in isolation, but the wired-up flow — scheduler diff → prune → persist → emit `graph.update` with `finalizedAt` and `removeNodeIds` for un-traveled branches — is not covered end-to-end. A regression in `scheduler.ts` around line 2477 (`pruneUntraveled(nextGraph)`) would not be caught by existing tests.

**Where.** `src/server/scheduler/scheduler.ts` (graph diff+prune+persist block), `src/server/graph/prune.ts`.

**Fix sketch.** Add a scheduler-level integration test that drives a workflow to completion along one branch (say `implement → review[pass]`) without triggering the `review[fail] → goto implement` branch, then asserts: (a) the persisted `workflows.graph_state` has `finalizedAt != null`, (b) no configured goto-target phase nodes remain for the un-traveled branch, (c) the final `graph.update` broadcast carried `removeNodeIds` / `removeEdgeIds` for the pruned configured-only nodes. Piggyback on the existing scheduler test harness.

## cl-04. `?view=graph` URL round-trip and tab toggle not covered

**What.** The graph-view e2e specs always navigate with `?view=graph` already in the URL — they don't exercise the user flipping between the List and Graph tabs, nor do they verify the URL is updated when the tab changes (and vice versa on refresh). `WorkflowDetailRoute.tsx:103-104` advertises URL-synced state but no test asserts that contract.

**Where.** `src/web/src/routes/WorkflowDetailRoute.tsx` (tabs block near line 655, `viewParam` read at 103–104).

**Fix sketch.** A single Playwright test: start on `/workflow/:id` (no query), click the Graph tab, assert URL becomes `...?view=graph` AND the canvas renders; click List, assert the query param is cleared AND FeatureBoard reappears; reload on `?view=graph` and assert the Graph tab is active. Keep it in `graph-view.spec.ts` so the mocks are already set up.

## cl-05. Prepost stdout/stderr right-pane (F4) rendering-path has e2e but no content assertions

**What.** `prepost-rendering.spec.ts` covers the `prepost.command.*` live-frame render path. The separate F4 path — clicking a completed prepost row and rendering its tail from `/api/workflows/:wf/prepost-run/:runId/:stream` into the right pane — has HTTP-level tests (`prepost-by-run.test.ts`, `prepost-artifact.test.ts`) but no UI-level test that asserts the fetched stdout/stderr actually renders in `PrepostOutputPane` (or in the graph's `NodeSummaryPanel` — see cl-02).

**Where.** `src/web/src/components/LiveStream/PrepostOutputPane.tsx`.

**Fix sketch.** Extend `prepost-rendering.spec.ts` (or add a spec) that seeds a completed prepost row in the timeline, clicks it, and asserts the fetched tail renders with the expected byte-size header and truncation marker when applicable. Shares fixtures with cl-02's `PrepostOutputSection` test.