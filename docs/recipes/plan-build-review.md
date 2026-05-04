# Recipe — Plan + build + review

**Who it's for:** anyone building a real feature where "tests pass" isn't enough
and you want a second agent reading the diff against the acceptance criteria.

**The goal:** plan a small set of features, build each in its own worktree, review
each against acceptance and review criteria, loop back to implement on FAIL.

**Time:** depends entirely on the features — but you can leave it overnight and wake
up to either a PR or a clear list of awaiting-user items.

This is the **default shape** for non-trivial work. See
[templates.md](../templates.md) for the cascade.

---

## Project layout

```
my-project/
├── .yoke/
│   └── templates/
│       └── plan-build-review.yml
├── docs/
│   ├── agents/
│   │   ├── implementer.md
│   │   └── reviewer.md
│   └── idea/
│       └── features.json        # planner writes this
├── prompts/
│   ├── plan.md
│   ├── implement.md
│   └── review.md
└── scripts/
    ├── append-handoff-entry.js
    ├── check-features-json.js
    └── check-review-verdict.js
```

---

## The template

`.yoke/templates/plan-build-review.yml`:

```yaml
version: "1"

template:
  name: plan-build-review
  description: "Plan into features.json, then implement+review per feature with FAIL loop-back"

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
        subtitle: "$.category"
      phases: [implement, review]

phases:
  plan:
    command: claude
    args: ["-p", "--output-format", "stream-json", "--verbose",
           "--dangerously-skip-permissions",
           "--model", "claude-sonnet-4-6"]
    prompt_template: prompts/plan.md
    output_artifacts:
      - path: docs/idea/features.json
        required: true
    max_outer_retries: 2
    post:
      - name: check-features-json
        run: ["node", "scripts/check-features-json.js",
              "docs/idea/features.json"]
        timeout_s: 30
        actions:
          "0": continue
          "1": { retry: { mode: fresh_with_failure_summary, max: 2 } }
          "2": { goto: plan, max_revisits: 3 }
          "*": stop-and-ask

  implement:
    command: claude
    args: ["-p", "--output-format", "stream-json", "--verbose",
           "--dangerously-skip-permissions",
           "--model", "claude-sonnet-4-6"]
    prompt_template: prompts/implement.md
    max_outer_retries: 2
    retry_ladder: [continue, fresh_with_failure_summary, awaiting_user]
    post:
      - name: check-handoff
        run: ["node", "scripts/check-handoff-json.js"]
        timeout_s: 10
        actions: { "0": continue, "*": continue }
      - name: run-tests
        run: ["pnpm", "test"]
        timeout_s: 300
        actions:
          "0": continue
          "*": { retry: { mode: fresh_with_failure_summary, max: 2 } }
      - name: run-typecheck
        run: ["pnpm", "typecheck"]
        timeout_s: 60
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
      - name: check-handoff
        run: ["node", "scripts/check-handoff-json.js"]
        timeout_s: 10
        actions: { "0": continue, "*": continue }
      - name: check-verdict
        run: ["node", "scripts/check-review-verdict.js"]
        timeout_s: 10
        actions:
          "0": continue
          "1": { goto: implement, max_revisits: 3 }
          "*": stop-and-ask

worktrees:
  base_dir: .worktrees
  branch_prefix: pbr/
  bootstrap:
    commands: ["pnpm install"]

github:
  enabled: true
  auto_pr: true
  pr_target_branch: main
  auth_order: [env:GITHUB_TOKEN, gh:auth:token]

runtime:
  keep_awake: true

rate_limit:
  handling: passive
```

---

## Prompts

### `prompts/plan.md`

```
You are the planner. Read `docs/agents/planner.md` if present, otherwise act as
a senior engineer with full context on the project at hand.

State in one sentence what you are about to plan, then proceed.

## Workflow
{{workflow_name}}

## Project context
{{architecture_md}}

## Recent commits
{{git_log_recent}}

## User guidance
{{user_injected_context}}

---

Decompose the project into 3–7 features. Output a single file at
`docs/idea/features.json` with this shape:

  {
    "project": "<short name>",
    "created": "<ISO 8601 date>",
    "features": [
      {
        "id": "feat-<kebab-slug>",
        "description": "<one paragraph>",
        "acceptance_criteria": ["AC-1: ...", "AC-2: ..."],
        "review_criteria": ["RC-1: ..."],
        "depends_on": ["feat-other-id"],
        "category": "<backend|frontend|infra|...>",
        "priority": 1
      }
    ]
  }

Rules:
- Each acceptance criterion must be behaviorally testable.
- Each review criterion must be something a reviewer can check against a diff.
- Features must form a DAG via depends_on (no cycles).
- Order them topologically in the array.
- Stop after the file is written. Do not start implementing.
```

### `prompts/implement.md`

See the canonical example in [prompts.md](../prompts.md). The variables it uses
(`{{workflow_name}}`, `{{item_id}}`, `{{item}}`, `{{item_state}}`, `{{architecture_md}}`,
`{{handoff}}`, `{{git_log_recent}}`, `{{recent_diff}}`, `{{user_injected_context}}`)
are all in the standard inventory.

### `prompts/review.md`

Also from [prompts.md](../prompts.md). Same variable set, plus the explicit
`review-verdict.json` deliverable.

---

## Items manifest seed

If you want the planner to start from a blank slate, seed an empty manifest at
`docs/idea/features.json`:

```json
{
  "project": "<your-project>",
  "created": "2026-05-03T00:00:00Z",
  "needs_more_planning": true,
  "features": []
}
```

The planner overwrites this on its first run. The `check-features-json.js` script
returns exit 2 when `needs_more_planning: true`, which the planner phase's
`post:` action grammar maps to `goto: plan` — the planner re-enters and tries
again.

If you already have features in mind, just write them in directly and the planner
phase will read them, refine them if needed, and otherwise pass through.

---

## Gate scripts

`scripts/check-features-json.js`:

```js
#!/usr/bin/env node
// Exit 0 = ready, 1 = malformed, 2 = needs more planning.
const fs = require('node:fs');
const path = process.argv[2];
let raw;
try { raw = fs.readFileSync(path, 'utf8'); }
catch { console.error(`missing: ${path}`); process.exit(1); }
let json;
try { json = JSON.parse(raw); }
catch (e) { console.error(`bad JSON: ${e.message}`); process.exit(1); }
if (json.needs_more_planning === true) { console.log('needs more planning'); process.exit(2); }
if (!Array.isArray(json.features) || json.features.length === 0) {
  console.error('features array missing or empty'); process.exit(1);
}
for (const f of json.features) {
  if (!f.id || !f.description || !Array.isArray(f.acceptance_criteria)) {
    console.error(`feature missing required fields: ${JSON.stringify(f)}`); process.exit(1);
  }
}
console.log(`ok: ${json.features.length} features`); process.exit(0);
```

`scripts/check-review-verdict.js`:

```js
#!/usr/bin/env node
// Exit 0 = PASS, 1 = FAIL, 2 = malformed/missing.
const fs = require('node:fs');
const file = 'review-verdict.json';
if (!fs.existsSync(file)) { console.error('no review-verdict.json'); process.exit(2); }
let v;
try { v = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) { console.error(`bad JSON: ${e.message}`); process.exit(2); }
if (v.verdict === 'PASS') { console.log('PASS'); process.exit(0); }
if (v.verdict === 'FAIL') {
  console.log(`FAIL: ${(v.blocking_issues || []).length} blocking`); process.exit(1);
}
console.error(`unknown verdict: ${JSON.stringify(v)}`); process.exit(2);
```

`scripts/check-handoff-json.js`:

```js
#!/usr/bin/env node
// Advisory: exit 0 if absent or valid, 1 if malformed.
const fs = require('node:fs');
const file = 'handoff.json';
if (!fs.existsSync(file)) process.exit(0);
try {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(j.entries)) { console.error('entries missing'); process.exit(1); }
  process.exit(0);
} catch (e) { console.error(`bad JSON: ${e.message}`); process.exit(1); }
```

`scripts/append-handoff-entry.js` is the typed writer that prompts call to append
to `handoff.json` without risking JSON corruption from free-form edits. Lift it
from the Yoke repo's `prompts/` examples or write your own — the contract is
"read JSON from stdin, append to `handoff.json#/entries`, exit 0 on success."

---

## What you'll see in the dashboard

1. **Planning stage** — single agent run; live stream shows the planner reading
   `architecture.md`, writing `docs/idea/features.json`, exiting.
2. **Feature board** — each feature appears as a card. Items with unmet `depends_on`
   start in `blocked`; the others run in parallel (each in its own worktree).
3. **Implement → review per feature** — when implement passes its gates, review
   spawns. If review writes `verdict: FAIL`, the action grammar fires
   `goto: implement` and the cycle repeats up to `max_revisits: 3`.
4. **Workflow complete** — when every feature is in state `complete`, the workflow
   completes, the branch is pushed, and the GitHub button links to the PR.

---

## Tweaks

- **Strict typecheck only when you're close to done?** Move the `run-typecheck` gate
  into the review phase instead of implement. Reviewers tend to catch typecheck
  regressions faster than implementers.
- **Want the planner approved by you?** Add `needs_approval: true` to the
  `planning` stage. The workflow halts after planning; you read
  `docs/idea/features.json` and click Continue.
- **Reviewer too lenient?** See [multi-reviewer](multi-reviewer.md) for the
  adversarial subagent pattern.
- **Don't want auto-PR?** Set `github.enabled: false` (or omit the block).

---

## See also

- [Configuration reference](../configuration.md)
- [Prompts guide](../prompts.md)
- [Recipe — parallel-features-with-deps](parallel-features-with-deps.md) for the
  dependency-graph specifics.
- [Recipe — multi-reviewer](multi-reviewer.md) when a single reviewer rubber-stamps.
