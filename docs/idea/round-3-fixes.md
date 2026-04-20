# Round 3 Fixes

**Status:** Runs after round-2 PR merges to master. Round 3 is fully pipeline-driven — no pre-work agent session needed.

---

<!-- ═══════════════════════════════════════════════════════════════════
     USER SECTION — complete these steps between rounds, then delete
     this section.
     ═══════════════════════════════════════════════════════════════════ -->

## [USER] Between-round cleanup (after round-2 merges to master)

```bash
git checkout master && git pull

# Remove round-2 worktrees
git worktree list
# For each yoke-r2/... entry:
# git worktree remove .worktrees/<name>

# Delete round-2 branches
git branch | grep yoke-r2
# Review, then:
git branch | grep yoke-r2 | xargs git branch -D

# Archive round-2 config, activate round-3
mv .yoke.yml .yoke-round-2.yml.done
mv .yoke-round-3.yml .yoke.yml

# Verify
head -5 .yoke.yml  # should show: project.name: yoke-round-3
```

Review `docs/idea/fixes-round-3-features.json` for emergent items from round 2. Add r3-07, r3-08, ... if needed before starting.

## [USER] Run round 3

```bash
yoke start
```

Monitor via dashboard. When complete, merge the round-3 PR to master.

## [USER] After round 3

```bash
git checkout master && git pull
# Clean up worktrees and branches (same pattern as above with yoke-r3/)
# Archive or remove .yoke.yml
```

<!-- ═══════════════════════════════════════════════════════════════════
     END USER SECTION — delete everything above this line.
     ═══════════════════════════════════════════════════════════════════ -->

---

# Round 3 feature cards (reference during pipeline run)

Round 3 is pipeline-driven. The harness runs each card through implement + review phases automatically using `prompts/self-host-implement.md` and `prompts/self-host-review.md`. No manual agent session is needed.

Monitor progress via the dashboard. Use `yoke status` and `yoke ack <workflowId>` if items hit `awaiting_user`.

## r3-01 — tsconfig.build.json project references

**Category:** build | **Priority:** 3

Root `tsconfig.build.json` excludes `src/web` as a JSX config workaround. Fix: scope the root `include` to `src/server, src/cli, src/shared` and drop the exclude, OR switch to TypeScript project references. Document the choice in a top-of-file comment.

AC: no `exclude` of `src/web`; `pnpm build` and `pnpm --filter web build` succeed; `pnpm typecheck` still covers both.
RC: decision documented; no CI regression.

## r3-02 — per-item vs workflow-scoped retry decision

**Category:** ui-behavior | **Priority:** 3

The `/retry` endpoint fires `user_retry` on ALL `awaiting_user` items. Decide: add per-item retry endpoint + UI, or document the workflow-scope decision inline. Either is acceptable.

AC: chosen option implemented and tested; UI label and endpoint scope match.
RC: decision documented near the Retry button in `ControlMatrix.tsx`.

## r3-03 — ReviewPanel phase autodetection

**Category:** ui-behavior | **Priority:** 3

`WorkflowDetailRoute.tsx` hardcodes phase names `review`/`pre_review` to activate `ReviewPanel`. Replace with runtime detection: activate when the block stream contains `Task` tool_use calls. Add optional `phases[name].ui.renderer` config override.

AC: phase named `audit` with Task calls renders ReviewPanel; review phase without Task calls falls back to `LiveStreamPane`; config override works; existing `review-panel.spec.ts` green.
RC: detection is frame-reactive (no polling); override takes precedence.

## r3-04 — stableId fallback in FeatureBoard

**Category:** ui-behavior | **Priority:** 4

FeatureBoard falls back to SQLite UUID when `displayTitle` is absent. Add `stableId` (from seeder's `items_id` JSONPath) to `ItemProjection`; fallback chain: `displayTitle ?? stableId ?? 'Seeding…'`. Migration 0004 adds `items.stable_id` column.

AC: migration exists; seeder writes `stable_id`; fallback chain correct; unit test covers precedence.
RC: migration is forward-only (NULL not empty string for existing rows).

## r3-05 — control-matrix.spec.ts flake fix

**Category:** test-infra | **Priority:** 4

`control-matrix.spec.ts` flakes intermittently (WS frame dispatch vs DOM assertion race). Reproduce with `--repeat-each=20`, root-cause, replace timing-sensitive assertions with frame-received waits.

AC: 20/20 consecutive passes; no `page.waitForTimeout` calls remain.
RC: root cause documented in commit message.

## r3-06 — sentinel (emergent work from round 2)

**Category:** meta | **Priority:** 5

Placeholder. If round-2 surfaces blocking issues not covered by r3-01 through r3-05, add them as r3-07, r3-08, ... before running round 3. Otherwise the reviewer strikes this card as PASS with note "sentinel entry — no implementation required."
