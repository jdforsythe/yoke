# Templates

A template is a reusable pipeline shape, stored at `.yoke/templates/<name>.yml`. One
template can spawn many workflow instances, each with its own name and isolated git
worktree. This page covers the anatomy of a template and the four pipeline shapes
you'll reach for most often.

For the full key-by-key reference, see [configuration.md](configuration.md).

---

## Anatomy

```
.yoke/
└── templates/
    ├── one-shot.yml          ← one shape: build it in a single session
    ├── plan-build.yml        ← another shape: plan, then per-feature build
    └── plan-build-review.yml ← another shape: + review loop with FAIL gate
prompts/
├── implement.md
├── plan.md
└── review.md
scripts/
├── append-handoff-entry.js
├── check-features-json.js
├── check-handoff-json.js
└── check-review-verdict.js
docs/
├── idea/
│   └── features.json         ← per-item manifest
└── agents/
    ├── implementer.md        ← persona files referenced by prompts
    └── reviewer.md
```

The dashboard scans `.yoke/templates/` on every reload and renders one card per
template. You can mix shapes in the same repo — pick which one to run from the
picker.

---

## The four shapes

### Shape 1 — One-shot (L0)

One stage, one phase, one prompt. The agent runs once, produces the artifact, you
ship it. No review, no items.

```yaml
version: "1"
template:
  name: one-shot
  description: "Single agent session, single output"

pipeline:
  stages:
    - id: build
      run: once
      phases: [implement]

phases:
  implement:
    command: claude
    args: ["-p", "--output-format", "stream-json", "--verbose",
           "--dangerously-skip-permissions"]
    prompt_template: prompts/implement.md
    post:
      - name: smoke
        run: ["bash", "-c", "test -f README.md"]
        actions:
          "0": continue
          "*": { fail: { reason: "expected README.md was not produced" } }
```

**When to pick:** the work fits in one Claude session, you don't need a review loop,
and "did it write the file?" is the only gate that matters. Recipe scrapers, small
scripts, prototypes.

**See:** [recipes/one-shot.md](recipes/one-shot.md).

---

### Shape 2 — Plan + build (L1.5)

Two stages: a one-time planner emits a `features.json` manifest, then a per-item
stage builds each feature. No review.

```yaml
version: "1"
template:
  name: plan-build
  description: "Planner emits features.json; each feature builds in its own worktree"

pipeline:
  stages:
    - id: planning
      run: once
      phases: [plan]

    - id: build
      run: per-item
      items_from: docs/idea/features.json
      items_list: "$.features"
      items_id: "$.id"
      items_depends_on: "$.depends_on"
      phases: [implement]

phases:
  plan:
    command: claude
    args: ["-p", "--output-format", "stream-json", "--verbose",
           "--dangerously-skip-permissions"]
    prompt_template: prompts/plan.md
    output_artifacts:
      - path: docs/idea/features.json
        required: true
    post:
      - name: features-present
        run: ["test", "-s", "docs/idea/features.json"]
        actions:
          "0": continue
          "*": { retry: { mode: fresh_with_failure_summary, max: 2 } }

  implement:
    command: claude
    args: ["-p", "--output-format", "stream-json", "--verbose",
           "--dangerously-skip-permissions"]
    prompt_template: prompts/implement.md
    post:
      - name: tests
        run: ["pnpm", "test"]
        actions:
          "0": continue
          "*": { retry: { mode: fresh_with_failure_summary, max: 2 } }
```

**When to pick:** you have a fuzzy goal you want broken into pieces, but each piece
is small enough that "tests pass" is sufficient evidence of correctness. Internal
tooling, batch refactors, content batches.

---

### Shape 3 — Plan + build + review (L2)

The default shape for non-trivial work. Adds a review phase that loops back to
implement on FAIL.

```yaml
version: "1"
template:
  name: plan-build-review
  description: "Plan, then per-feature implement+review with FAIL loop-back"

pipeline:
  stages:
    - id: planning
      run: once
      phases: [plan]

    - id: implementation
      run: per-item
      items_from: docs/idea/features.json
      items_list: "$.features"
      items_id: "$.id"
      items_depends_on: "$.depends_on"
      items_display:
        title: "$.description"
      phases: [implement, review]

phases:
  plan:
    command: claude
    args: ["-p", "--output-format", "stream-json", "--verbose",
           "--dangerously-skip-permissions"]
    prompt_template: prompts/plan.md
    output_artifacts:
      - path: docs/idea/features.json
        required: true
    post:
      - name: features-present
        run: ["test", "-s", "docs/idea/features.json"]
        actions: { "0": continue, "*": { retry: { mode: fresh_with_failure_summary, max: 2 } } }

  implement:
    command: claude
    args: ["-p", "--output-format", "stream-json", "--verbose",
           "--dangerously-skip-permissions"]
    prompt_template: prompts/implement.md
    post:
      - name: tests
        run: ["pnpm", "test"]
        actions: { "0": continue, "*": { retry: { mode: fresh_with_failure_summary, max: 2 } } }

  review:
    command: claude
    args: ["-p", "--output-format", "stream-json", "--verbose",
           "--dangerously-skip-permissions"]
    prompt_template: prompts/review.md
    post:
      - name: check-verdict
        run: ["node", "scripts/check-review-verdict.js"]
        actions:
          "0": continue
          "1": { goto: implement, max_revisits: 3 }
          "*": stop-and-ask
```

**When to pick:** "tests pass" is necessary but not sufficient. You want a second
agent reading the diff against the acceptance criteria. This is the recommended
default for any code that another human will eventually maintain.

**See:** [recipes/plan-build-review.md](recipes/plan-build-review.md).

---

### Shape 4 — Brainstorm + plan + build + review (L3)

For idea-stage projects: the user writes a paragraph in `docs/brainstorm.md`, a
brainstorm phase fleshes it into a structured plan, the planner decomposes that into
features, and per-item implement+review takes over.

The brainstorm template that ships in this repo (`.yoke/templates/brainstorm.yml`)
is the canonical example.

```yaml
version: "1"
template:
  name: brainstorm-plan-build-review
  description: "Take an idea from sketch to PR via plan + per-feature implement+review"

pipeline:
  stages:
    - id: brainstorm
      run: once
      phases: [brainstorm]

    - id: planning
      run: once
      phases: [plan]

    - id: build
      run: per-item
      items_from: docs/idea/features.json
      items_list: "$.features"
      items_id: "$.id"
      items_depends_on: "$.depends_on"
      phases: [implement, review]

phases:
  brainstorm:
    command: claude
    args: ["-p", "--output-format", "stream-json", "--verbose",
           "--dangerously-skip-permissions"]
    prompt_template: prompts/brainstorm.md
    output_artifacts:
      - path: docs/brainstorm.md
        required: true
    post:
      - name: brainstorm-present
        run: ["test", "-s", "docs/brainstorm.md"]
        actions: { "0": continue, "*": { retry: { mode: fresh_with_failure_summary, max: 2 } } }

  plan:
    command: claude
    args: ["-p", "--output-format", "stream-json", "--verbose",
           "--dangerously-skip-permissions"]
    prompt_template: prompts/plan.md
    output_artifacts:
      - path: docs/idea/features.json
        required: true
    post:
      - name: features-present
        run: ["test", "-s", "docs/idea/features.json"]
        actions: { "0": continue, "*": { retry: { mode: fresh_with_failure_summary, max: 2 } } }

  implement:
    command: claude
    args: ["-p", "--output-format", "stream-json", "--verbose",
           "--dangerously-skip-permissions"]
    prompt_template: prompts/implement.md
    post:
      - name: tests
        run: ["pnpm", "test"]
        actions: { "0": continue, "*": { retry: { mode: fresh_with_failure_summary, max: 2 } } }

  review:
    command: claude
    args: ["-p", "--output-format", "stream-json", "--verbose",
           "--dangerously-skip-permissions"]
    prompt_template: prompts/review.md
    post:
      - name: check-verdict
        run: ["node", "scripts/check-review-verdict.js"]
        actions:
          "0": continue
          "1": { goto: implement, max_revisits: 3 }
          "*": stop-and-ask
```

**When to pick:** the user can describe the goal in a paragraph but can't itemize it
yet. The brainstorm phase turns the paragraph into a structured spec; the planner
turns the spec into work units. Costs more tokens than Shape 3; pays for itself when
the upfront thinking actually changes the architecture.

---

## Picking a shape

Apply the cascade — escalate only when the simpler shape demonstrably fails:

| Goal | Try first |
|---|---|
| "Write me a script that does X." | **Shape 1** |
| "Build feature A and feature B." | **Shape 2** if A and B are independent and small |
| "Build feature A, B, C — get them right the first time." | **Shape 3** |
| "I have an idea, no spec." | **Shape 4** |

Multi-template repos are fine. A common pattern:

- `plan-build-review.yml` for normal feature work.
- `fix-only.yml` for bug-hunt loops on existing code.
- `polish.yml` for documentation / cleanup passes.

The dashboard picker shows all of them; pick which to run per workflow instance.

---

## Multiple templates per repo

Drop more than one file into `.yoke/templates/`:

```
.yoke/templates/
├── plan-build-review.yml
├── fix-only.yml
└── docs-pass.yml
```

`yoke start` discovers all of them. The picker shows one card per file. Each
workflow instance is bound to the template that created it; they don't share state.

---

## See also

- [Configuration reference](configuration.md) — every key, explained.
- [Prompts guide](prompts.md) — what variables you can reference.
- [Recipe gallery](recipes/) — copy-pasteable end-to-end shapes.
