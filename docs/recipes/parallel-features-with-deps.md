# Recipe — Parallel features with dependencies

**Who it's for:** anyone adding multiple features to an existing app where some
features can run in parallel and others depend on prior work.

**The goal:** ship feature A and feature B in parallel, then ship feature C once
both have completed.

**Time:** equal to `max(time(A), time(B)) + time(C)` — Yoke runs A and B in
separate worktrees concurrently and only starts C when both are done.

This is the same template shape as
[plan-build-review](plan-build-review.md), but we hand-author the manifest instead
of having a planner write it.

---

## The dependency model

Items are processed in topological order. An item with `depends_on: ["X", "Y"]` is
held in `blocked` state until both X and Y reach `complete`. The dashboard shows
the dependency hint on the card.

There are no implicit dependencies. If `depends_on` is missing or empty, the item
is eligible immediately.

---

## The template

`.yoke/templates/parallel-build.yml`:

```yaml
version: "1"

template:
  name: parallel-build
  description: "Add multiple features with explicit dependencies; A+B in parallel, then C"

pipeline:
  stages:
    - id: implementation
      run: per-item
      items_from: docs/idea/features.json
      items_list: "$.features"
      items_id: "$.id"
      items_depends_on: "$.depends_on"
      items_display:
        title: "$.description"
        subtitle: "$.category"
      phases: [implement, review]

phases:
  implement:
    command: claude
    args: ["-p", "--output-format", "stream-json", "--verbose",
           "--dangerously-skip-permissions",
           "--model", "claude-sonnet-4-6"]
    prompt_template: prompts/implement.md
    max_outer_retries: 2
    retry_ladder: [continue, fresh_with_failure_summary, awaiting_user]
    post:
      - name: tests
        run: ["pnpm", "test"]
        timeout_s: 300
        actions:
          "0": continue
          "*": { retry: { mode: fresh_with_failure_summary, max: 2 } }

  review:
    command: claude
    args: ["-p", "--output-format", "stream-json", "--verbose",
           "--dangerously-skip-permissions",
           "--model", "claude-sonnet-4-6"]
    prompt_template: prompts/review.md
    post:
      - name: check-verdict
        run: ["node", "scripts/check-review-verdict.js"]
        timeout_s: 10
        actions:
          "0": continue
          "1": { goto: implement, max_revisits: 3 }
          "*": stop-and-ask

worktrees:
  base_dir: .worktrees
  branch_prefix: parallel/
  bootstrap:
    commands: ["pnpm install"]

github:
  enabled: true
  auto_pr: true
  pr_target_branch: main
  auth_order: [env:GITHUB_TOKEN, gh:auth:token]
```

No planning stage — we already have the spec.

---

## The manifest

`docs/idea/features.json`:

```json
{
  "project": "myapp-v2",
  "created": "2026-05-03T00:00:00Z",
  "features": [
    {
      "id": "feat-a-search-index",
      "description": "Build the full-text search index over the posts table",
      "acceptance_criteria": [
        "AC-1: A new src/search/index.ts module exposes buildIndex(posts) and search(query)",
        "AC-2: pnpm test passes including new tests under tests/search/"
      ],
      "review_criteria": [
        "RC-1: index build is incremental — re-running it on the same data is a no-op"
      ],
      "depends_on": [],
      "category": "backend",
      "priority": 1
    },
    {
      "id": "feat-b-export-csv",
      "description": "Add CSV export endpoint for posts",
      "acceptance_criteria": [
        "AC-1: GET /api/posts/export.csv streams a valid CSV of all posts",
        "AC-2: pnpm test covers the new route"
      ],
      "review_criteria": [
        "RC-1: large datasets stream rather than buffering into memory"
      ],
      "depends_on": [],
      "category": "backend",
      "priority": 1
    },
    {
      "id": "feat-c-search-ui",
      "description": "Add a search UI on the posts page that uses the new index and exports results to CSV",
      "acceptance_criteria": [
        "AC-1: A search box on /posts filters live as the user types",
        "AC-2: An Export button downloads the current filter as CSV via the new endpoint",
        "AC-3: pnpm test and pnpm test:e2e both pass"
      ],
      "review_criteria": [
        "RC-1: Search calls debounce so we don't hammer the index on every keystroke"
      ],
      "depends_on": ["feat-a-search-index", "feat-b-export-csv"],
      "category": "frontend",
      "priority": 2
    }
  ]
}
```

`feat-a-search-index` and `feat-b-export-csv` have empty `depends_on` arrays —
they're eligible immediately. `feat-c-search-ui` waits for both.

---

## What you'll see in the dashboard

1. **Workflow start** — three feature cards appear. A and B move to `pending`, then
   `active`. C shows `blocked: depends_on feat-a-search-index, feat-b-export-csv`.
2. **Two live streams** — A and B run in their own worktrees in parallel. The live
   stream pane focuses on whichever item card you click.
3. **A completes** — its card flips to `complete`. C is still blocked (waiting on B).
4. **B completes** — C unblocks and starts. A and B's worktrees may be torn down
   depending on `worktrees.retention`.
5. **C completes** — workflow completes; PR opens with all three branches merged
   into the workflow's branch.

> **Note:** Each item runs in **its own** worktree branched from the workflow
> branch. C inherits the merged work of A and B because the workflow branch
> accumulates their commits. If you need a different merge model (e.g. each item
> against `main`), structure it as separate workflows.

---

## Prompts

Reuse `prompts/implement.md` and `prompts/review.md` from the
[plan-build-review recipe](plan-build-review.md). The variables and structure are
identical.

---

## Tweaks

- **Want strict topological order, no parallelism?** Set every item's `depends_on`
  to include the previous item's id. Items become a chain.
- **Want the planner to write the manifest instead?** Add a `planning` stage and a
  plan phase as in [plan-build-review](plan-build-review.md).
- **Need cross-item context in C?** C's prompt sees `{{git_log_recent}}` and
  `{{recent_diff}}` for the worktree, which already includes A's and B's commits
  by the time C runs.

---

## See also

- [Configuration reference](../configuration.md) — `items_depends_on` details.
- [Prompts guide](../prompts.md) — variables.
- [Recipe — plan-build-review](plan-build-review.md) — when you want a planner to
  write the manifest.
