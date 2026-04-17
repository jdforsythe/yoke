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

## Flaky ControlMatrix e2e test

**What.** During the A5-loop fix verification, the full e2e suite failed on first run with one failure in `control-matrix.spec.ts`; passed on re-run and in isolation. Unrelated to the A5 changes.

**Where.** `src/web/e2e/control-matrix.spec.ts`.

**Why deferred.** Flake was investigated enough to rule out A5 as the cause (same test passed on `dashboard` tip before any changes). Real fix requires reproducing the flake — probably a race between a WS frame dispatch and a DOM assertion.

**Fix sketch.** Reproduce locally with `--repeat-each=20` to pin down the race. Likely needs a `page.waitForResponse` or a WS-frame-received wait instead of a timing-dependent assertion. Don't trust CI signal on this spec until fixed.

