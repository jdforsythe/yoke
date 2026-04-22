# Plan: Nomenclature Consistency

Implements the "Nomenclature" item from `future-work.md` (§99–108): align the
dashboard with the config's `stage` / `phase` / `session` vocabulary, and
restructure the list view so each item row expands into a chronological
timeline of sessions (with retries) and pre/post-command failure rows.

---

## Pre-flight clarification

A codebase sweep turned up **no UI surface that labels stages "Templates"**.
Every `Template*` / "Templates" reference in `src/web/**` targets the
pipeline-template picker (YAML files under `.yoke/templates/`), which is
correctly named and out of scope for this plan.

The future-work note was almost certainly triggered by the fact that the
default pipeline template's first stage has `id: "templates"`
(`.yoke/templates/default.yml`), and `FeatureBoard` renders the raw stage id
as an uppercased group header (`FeatureBoard.tsx:450`). A user reading
"TEMPLATES" at the top of the stage column associates it with the picker
screen rather than with "a stage whose id happens to be 'templates'".

The remaining nomenclature debt is:

1. filter-bar labels that say "category" instead of "stage";
2. stage group header that renders a bare id with no "Stage" framing;
3. a list view that stops at the item level (no session drill-down in the
   list itself — sessions are only visible via the right-pane `HistoryPane`
   after selecting an item);
4. a search box limited to `displayTitle` / `displaySubtitle`.

---

## Current-state map

| Surface | Location | Current | Action |
|---|---|---|---|
| Filter `aria-label` | `FeatureBoard.tsx:398` | `"Filter by category"` | rename → `"Filter by stage"` |
| Filter default option | `FeatureBoard.tsx:400` | `"All categories"` | rename → `"All stages"` |
| State var | `FeatureBoard.tsx:103,143,395-396` | `categoryFilter` | rename → `stageFilter` (internal) |
| Stage group header | `FeatureBoard.tsx:445-451` | raw `{stage.id}` | prefix with `"STAGE · "` label chip |
| Search placeholder | `FeatureBoard.tsx:376` | `"Search items…"` | keep (per spec) |
| Search scope | `fuzzyMatch` `FeatureBoard.tsx:41-48` | title + subtitle only | extend to stage id + phase name + session id |
| List depth | `FeatureBoard.tsx:429-457` | stops at item card | add expand → timeline (sessions + pre/post rows) |
| Section aria | `FeatureBoard.tsx:415` | `"Items"` | keep |
| Template picker / `/api/templates` / `TemplateSummaryItem` | various | `"Templates"` | keep (legitimate pipeline-template domain) |

The data model on disk already uses the right words end-to-end: `Stage`
(`src/shared/types/config.ts:107`), `Phase` (:82), `sessions` table
(`docs/design/schemas/sqlite-schema.sql:77`), `prepost_runs` table (:173).
No schema or shared-type renames are needed.

---

## Work items

### N-1 — Filter label rename

**Scope:** purely cosmetic; one file, two lines, one state-variable rename.

**Files**

- `src/web/src/components/FeatureBoard/FeatureBoard.tsx`
  - line 398: `aria-label="Filter by category"` → `aria-label="Filter by stage"`
  - line 400: `<option value="all">All categories</option>` → `<option value="all">All stages</option>`
  - lines 103, 143, 395–396: rename the `categoryFilter` state binding to
    `stageFilter` for code-reading consistency. The DOM `<select>` `value`
    attribute stays an internal token; no public API change.

**Tests to update**

- `src/web/e2e/workflow-detail.spec.ts` — any selector matching
  `"Filter by category"` / `"All categories"`.
- `tests/web/components/FeatureBoard/*.test.tsx` if any assertion targets
  those strings.

---

### N-2 — Stage group-header framing

**Scope:** make the header read unambiguously as "a stage whose id is X"
rather than a lone word that collides with "Templates".

**Files**

- `src/web/src/components/FeatureBoard/FeatureBoard.tsx:445-451` —
  render a small muted `"STAGE"` chip next to the existing `{stage.id}`.
  Keep the id visible (useful for config authors debugging). Example:

  ```
  ┌─────────────────────────────────────┐
  │ STAGE · templates                    │
  ├─────────────────────────────────────┤
  │ fix-camelcase-api     ● in_progress │
  │ fix-auth-timeout      ○ pending     │
  └─────────────────────────────────────┘
  ```

**Out of scope for this plan (flagged as follow-on):** adding a
`description?: string` field on `Stage` (`src/shared/types/config.ts:107`)
plus schema update, so stage groupings could show a human-readable subtitle
under the id. Worth doing once; not required for this refactor.

---

### N-3 — Item-row expansion → timeline

The substantive change. Today the list view stops at the item card and the
only way to see sessions is to click an item and look at `HistoryPane` in
the right pane. The spec wants sessions visible inside the list, including
retry sessions and failure rows for post-commands that triggered a goto.

#### Data shape

Introduce an `ItemTimelineRow` discriminated union (new shared type in
`src/shared/types/ws.ts` — colocated with `SessionProjection`):

```ts
export type ItemTimelineRow =
  | {
      kind: 'session';
      id: string;
      phase: string;
      attempt: number;
      status: string;              // 'complete' | 'in_progress' | 'failed' | 'abandoned'
      startedAt: string;
      endedAt: string | null;
      exitCode: number | null;
      parentSessionId: string | null;
    }
  | {
      kind: 'prepost';
      id: string;
      whenPhase: 'pre' | 'post';
      commandName: string;
      phase: string;
      status: 'ok' | 'fail';
      exitCode: number | null;
      actionTaken: { goto?: string; retry?: boolean; fail?: boolean; continue?: boolean } | null;
      startedAt: string;
      endedAt: string | null;
      stdoutPath: string | null;
      stderrPath: string | null;
    };
```

Rationale: a single array ordered by `startedAt` (ties broken by insertion
order) lets the UI render sessions and their trailing pre/post rows
interleaved naturally, which matches the "failure row describing that it
triggered a goto implement" UX from the spec.

#### Server endpoint

- New route `GET /api/workflows/:workflowId/items/:itemId/timeline` in
  `src/server/api/server.ts`. (The earlier `GET /api/items/:id/sessions`
  endpoint was retired in F5 — HistoryPane now consumes session rows
  straight off the `/timeline` response.)
- Implementation joins `sessions` and `prepost_runs` filtered by `item_id`,
  emits a single list ordered by `started_at`. Session `attempt` comes from
  the row's explicit `attempt` column where available, otherwise from
  `items.retry_count` (see `src/server/pipeline/retry-items.ts:99`,
  `src/server/pipeline/control-executor.ts:236`). The existing
  `ws.ts:367` hardcoded-zero TODO does **not** block the timeline endpoint;
  that TODO is for the WS `session.started` frame, which this endpoint
  doesn't rely on.
- `HistoryPane` now consumes session rows directly from the
  `/timeline` response (filtered to `kind === 'session'` in
  `WorkflowDetailRoute`). The old `/sessions` endpoint was removed in F5
  — no deprecation shim was kept.

#### UI: expand / collapse

- `src/web/src/components/FeatureBoard/FeatureBoard.tsx`,
  `renderItemCard` — add a disclosure caret on the left of the card.
  Click toggles an `expanded: Set<string>` state keyed by itemId.
- On first expand, fetch `/timeline` (lazy; cached per-item like the
  existing `itemDataCache` pattern at :54). No prefetch on snapshot load
  — large workflows would otherwise issue hundreds of requests.
- On expand, render timeline rows indented under the item:
  - **session row** — `{phase} · attempt {n} · {status} · {relativeTime} · {duration}`, clickable; click loads the session log in the right pane (reuse `loadHistoricalSession` from `@/store/renderStore` — same call `HistoryPane.tsx:121` makes today).
  - **prepost row** — `[{whenPhase}] {commandName} · {status} · {actionLabel}` where `actionLabel` renders `actionTaken` as human text ("triggered goto implement", "retry", "fail", or blank for `continue`). Click opens stdout/stderr if the paths are non-null (small new viewer; or reuse the text-rendering path of `LiveStreamPane` if plumbable — decide during implementation, not in this plan).
- Keep j/k navigation at the item level. Space toggles expand/collapse
  on the focused item. Enter still selects (unchanged behavior). Document
  this in the component's top-of-file comment block.

#### Live updates

`WorkflowDetailRoute` already observes WS frames for session lifecycle
(`src/web/src/routes/WorkflowDetailRoute.tsx` in its frame handler). When
a `session.started` or `session.ended` arrives for an item currently in
the `expanded` set, invalidate that item's cached timeline entry so the
next render issues a fresh fetch. Implement as an exported
`invalidateItemTimeline(itemId)` helper next to the existing
`invalidateItemData` (`FeatureBoard.tsx:62`).

---

### N-4 — Extend search scope

**Scope:** the placeholder text stays `"Search items…"`, but the filter
matches more fields.

**Files**

- `src/web/src/components/FeatureBoard/FeatureBoard.tsx:41-48` (`fuzzyMatch`)
  and :140–147 (`flatFiltered`).

**Matching rules (case-insensitive substring):**

- item `displayTitle` / `displaySubtitle` — already covered.
- `stage.id` of the item's stage (look up in the `stages` array by
  `item.stageId`).
- For each timeline row owned by the item **that is currently loaded into
  the timeline cache** — `phase`, session id, prepost `commandName`.

If a search hit lives only under an unexpanded item (e.g. a phase name
matched via already-cached timeline data), auto-add that item to the
`expanded` set so the hit is visible. Not expanding rows whose timeline
isn't cached is a deliberate compromise — the alternative is issuing a
fleet of timeline fetches on every keystroke.

Explicitly out of scope: searching log content. The spec calls this out.

---

### N-5 — Tests

**Component (Vitest + Testing Library):**

- FeatureBoard filter label — assert `aria-label="Filter by stage"` and
  `"All stages"` option present; rename any existing `"category"`
  assertion.
- FeatureBoard expand/collapse — click caret → fetch fires once → timeline
  rows render in chronological order. Mock the `/timeline` endpoint.
- FeatureBoard prepost-failure row — given a `kind:'prepost'` row with
  `actionTaken:{goto:'implement'}` and `status:'fail'`, assert the rendered
  text contains "triggered goto implement".
- FeatureBoard search extension — query matches stage id, query matches
  phase name in cached timeline, auto-expand triggers.

**Server (Vitest):**

- `tests/server/api/timeline.test.ts` — seed sessions + prepost_runs for an
  item, assert chronological ordering, filter by `item_id`, action_taken
  JSON passes through to the response unchanged.

**E2E (Playwright):**

- New `src/web/e2e/real/item-timeline.spec.ts` — expand an item → click a
  session row → log loads in right pane. Separate test: expand an item
  whose last phase had a failing post-command → click the prepost row →
  stdout viewer shows captured output.
- Update `src/web/e2e/workflow-detail.spec.ts` selectors impacted by N-1.

---

## Delivery order

1. **N-1** filter rename + **N-2** header chip → one PR, small and
   independently landable.
2. **N-3** timeline endpoint + expand UI → one PR (largest).
3. **N-4** search extension → depends on N-3's cache.
4. Tests land with the PR that introduces each change (N-5 rows are
   distributed across PRs, not a tail PR).

---

## Acceptance criteria

1. No filter-bar string uses the word "category"; both the `aria-label`
   and the default option read "stage"/"stages".
2. Each stage group header in the list view renders as a framed label
   (e.g. `STAGE · templates`) rather than a bare uppercased id.
3. Each item card is expandable; expansion reveals a chronologically
   ordered list of sessions for that item, labelled by phase and attempt
   number, with trailing pre/post rows describing any failure-triggered
   action ("triggered goto implement", "retry", etc.).
4. Search bar placeholder stays `"Search items…"`. Queries match item
   title/subtitle, the owning stage id, and any phase / session id / prepost
   command name present in cached timeline data. Matches hidden under
   unexpanded items auto-expand their row.
5. Log-content search remains explicitly unsupported.
6. Existing e2e specs pass after selector updates; new timeline specs
   cover expand-click-log and expand-click-prepost flows.

---

## Out of scope

- Renaming the default template's stage id `"templates"` — config-level,
  affects live workflows, belongs in a dedicated migration note.
- Graph view (separate future-work item at `future-work.md` §Graph View).
- `depends_on` surfacing in the list view (separate future-work item).
- Adding `description` / `label` fields to `Stage` or `Phase` in the
  config schema — flagged as a follow-on that would enhance N-2.
- ~~Retiring `/sessions` once `HistoryPane` is migrated — follow-on cleanup.~~ (Done in F5.)
