# Round 3 Fixes

**Status:** Runs after round-2 PR merges to master. Round 3 is fully pipeline-driven — no pre-work agent session needed.

---

<!-- ═══════════════════════════════════════════════════════════════════
     USER SECTION — complete these steps between rounds, then delete
     this section.
     ═══════════════════════════════════════════════════════════════════ -->

## [USER] Create `docs/idea/fixes-round-3-features.json` (do this during round-2 pre-work)

Create this file on the `prework/round-2-setup` branch along with the round-2 manifest.

```json
{
  "project": "yoke",
  "round": 3,
  "created": "2026-04-20T00:00:00Z",
  "_topological_order": [
    "r3-01",
    "r3-02",
    "r3-03",
    "r3-04",
    "r3-05",
    "r3-06"
  ],
  "features": [
    {
      "id": "r3-01",
      "category": "build",
      "priority": 3,
      "depends_on": [],
      "description": "Root tsconfig.build.json excludes src/web as a workaround for a JSX config conflict. Proper fix: switch to TypeScript project references so the root build composes server + web workspaces correctly, OR scope the root tsconfig's include to src/server, src/cli, src/shared and drop the exclude line entirely. Option 2 is the smaller change and is acceptable. The chosen approach must be documented in a comment at the top of tsconfig.build.json.",
      "acceptance_criteria": [
        "No `exclude` of src/web in tsconfig.build.json",
        "pnpm build succeeds from repo root",
        "pnpm --filter web build still succeeds",
        "pnpm typecheck still covers both server and web",
        "tsconfig.build.json has a top-of-file comment documenting the chosen approach"
      ],
      "review_criteria": [
        "Decision (project references vs scoped include) documented",
        "No regression in CI jobs that consume these build commands"
      ]
    },
    {
      "id": "r3-02",
      "category": "ui-behavior",
      "priority": 3,
      "depends_on": [],
      "description": "The current POST /api/workflows/:id/retry endpoint is workflow-scoped — it fires user_retry on ALL awaiting_user items in the workflow. Round 2's r2-07 aligned the UI's retry button to this scope. If per-item retry UX is desired, add POST /api/workflows/:id/items/:itemId/retry and a per-item UI entry point. Otherwise, document the workflow-scope decision inline so future contributors don't re-litigate. This card captures the decision.",
      "acceptance_criteria": [
        "Either option implemented and tested end-to-end",
        "UI label and server endpoint scope match",
        "tests/api/ covers the chosen path"
      ],
      "review_criteria": [
        "Decision documented in a comment near the Retry button definition in ControlMatrix.tsx"
      ]
    },
    {
      "id": "r3-03",
      "category": "ui-behavior",
      "priority": 3,
      "depends_on": [],
      "description": "src/web/src/routes/WorkflowDetailRoute.tsx hardcodes activeSessionPhase === 'review' || 'pre_review' to activate ReviewPanel. Open-source users with phases named qa, audit, verify, etc. don't get the ReviewPanel. Replace with runtime detection: examine the active session's block stream for Task tool_use calls (ReviewPanel's whole purpose is rendering these as subagent rows). Optional config override: add phases[name].ui.renderer = 'review' | 'stream' to docs/design/schemas/yoke-config.schema.json so a user can pin the renderer explicitly.",
      "acceptance_criteria": [
        "A phase named 'audit' that produces Task tool_use calls renders ReviewPanel",
        "A review phase without Task calls falls back to LiveStreamPane",
        "Unit test on the selector predicate (tests/web/reviewPanelDetection.test.ts)",
        "Existing review-panel.spec.ts still green",
        "docs/design/schemas/yoke-config.schema.json documents the optional override"
      ],
      "review_criteria": [
        "Detection reacts within one frame of the first Task tool_use arriving — no polling",
        "Explicit config override takes precedence over autodetection",
        "Schema update is backwards-compatible (optional field)"
      ]
    },
    {
      "id": "r3-04",
      "category": "ui-behavior",
      "priority": 4,
      "depends_on": [],
      "description": "src/web/src/components/FeatureBoard/FeatureBoard.tsx falls back `item.displayTitle ?? item.id` where item.id is a SQLite UUID. Fallback should be the stable id extracted by the seeder from items_id JSONPath. Add stableId: string | null to ItemProjection; populate from src/server/scheduler/per-item-seeder.ts (and null for once-stage placeholders in ingest). Fallback chain: displayTitle ?? stableId ?? 'Seeding…' for placeholders or ?? item.id if truly nothing available. Add items.stable_id TEXT column via migration 0004.",
      "acceptance_criteria": [
        "Migration 0004_item_stable_id.sql adds stable_id column with a partial index",
        "Seeder writes stable_id when seeding per-item rows",
        "ItemProjection carries stableId",
        "FeatureBoard fallback chain is displayTitle ?? stableId ?? 'Seeding…' for placeholders, ?? item.id otherwise",
        "Unit test asserts the precedence order"
      ],
      "review_criteria": [
        "Migration is forward-only; existing items without stable_id have NULL, not empty string",
        "Once-stage placeholders render 'Seeding…' or stage id, never the UUID"
      ]
    },
    {
      "id": "r3-05",
      "category": "test-infra",
      "priority": 4,
      "depends_on": [],
      "description": "src/web/e2e/control-matrix.spec.ts failed intermittently during round 1 verification. The flake was ruled out as unrelated to that round's changes but never root-caused. Reproduce with `pnpm --filter web test:e2e control-matrix.spec.ts --repeat-each=20`; identify the race (likely a WS frame dispatch vs DOM assertion); replace timing-dependent assertions with page.waitForResponse or WS-frame-received waits.",
      "acceptance_criteria": [
        "Spec passes 20/20 consecutive runs locally",
        "No page.waitForTimeout(N) calls remain in the spec"
      ],
      "review_criteria": [
        "Root cause identified and documented in the commit message or handoff note"
      ]
    },
    {
      "id": "r3-06",
      "category": "meta",
      "priority": 5,
      "depends_on": [],
      "description": "Placeholder for issues surfaced during round-2 pipeline execution that are not critical but should be tracked. Do not implement speculatively — this is a sentinel entry. When round-2 completes, triage emergent issues; if any rise to the level of a card, add them to this manifest under a new id (r3-07, r3-08, ...) and re-run round 3.",
      "acceptance_criteria": [
        "This card is explicitly struck (verdict PASS with note 'sentinel entry — no implementation required') by the reviewer if no emergent work exists, OR it is converted into one-or-more concrete cards with AC/RC before round 3 executes"
      ],
      "review_criteria": [
        "Sentinel treatment is acceptable only if the round-2 execution review confirms no emergent blocking work"
      ]
    }
  ]
}
```

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
