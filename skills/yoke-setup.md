---
name: yoke-setup
description: |
  Guided project setup for the Yoke harness. Produces a complete, schema-valid
  `.yoke/templates/<name>.yml`, mustache prompt files under `prompts/`, gate
  scripts under `scripts/`, agent persona files under `docs/agents/`, and a
  starter item manifest (e.g. `docs/idea/features.json`) that together run
  with `yoke start`. Enforces current yoke conventions: multi-template
  discovery, `{{var}}` / `{{item.field}}` substitution (NOT Handlebars),
  opaque items, user-owned review aggregation, and `post:` action grammar
  with the required `"*"` wildcard.

  Use this skill when the user wants to set up yoke, scaffold a workflow,
  design a pipeline, configure a template, build agents for yoke, or says
  "help me wire this up to run with yoke" — even if they don't say
  "template." Also triggers for phrases like "plan + implement + review
  loop," "multi-agent workflow," "feature-driven build," and "turn this
  idea into a yoke workflow."

  Do NOT use for editing an already-working yoke template (edit the YAML
  directly), for generic agent persona design with no yoke wiring
  (use forge's agent-creator), or for team composition without yoke
  (use forge's mission-planner). For forge team blueprints that need yoke
  wiring, use yoke-setup-forge instead.
---

# Yoke Setup

Interactive setup that turns a project description into a complete,
schema-valid yoke configuration. Ships working files — not placeholders.

---

## Expert Vocabulary Payload

**Yoke Config & Lifecycle:** template config, `.yoke/templates/<name>.yml`, stage vs phase, `run: once`, `run: per-item`, items manifest, JSONPath (`items_list`, `items_id`, `items_depends_on`), `items_display`, opaque item data (Issue 2), worktree isolation, bootstrap commands, auto-PR, `keep_awake`

**Phase Execution:** prompt template, mustache assembler, `{{var}}` substitution, `{{item.field}}` dot traversal, PromptContext, `handoff_entries`, `recent_diff`, `architecture_md`, `user_injected_context`, `output_artifacts`, artifact validator, `retry_ladder` (`continue`, `fresh_with_failure_summary`, `fresh_with_diff`, `awaiting_user`), `max_outer_retries`

**Pre/Post Action Grammar:** exit-code → action map, `"*"` wildcard (required), `continue`, `stop-and-ask`, `stop`, `goto` + `max_revisits`, `goto-offset`, `retry: {mode, max}`, `fail: {reason}`, validator short-circuit, loop guard

**Handoff Contract:** `handoff.json`, append-only entries, `append-handoff-entry.js` typed writer, `item_id` stability, `intended_files`, `deferred_criteria`, `blocking_issues`, `non_blocking`, `verdict` (`PASS` / `FAIL`), review-verdict.json

**Agent Design (Yoke-Specific):** `docs/agents/<role>.md` persona, "Read this file first" prompt pattern, single reviewer vs multi-angle subagent review, review-lead orchestration via `Task` tool (Claude Code subagents at `.claude/agents/`), adversarial framing, MAST FM-3.1 rubber-stamp prevention

**Planning Science:** 45% threshold (DeepMind), cascade pattern (L0 single → L1 tools → L2 worker+reviewer → L3 pipeline), sequential dependency, tool density, 15-year practitioner test, flattery ban list, role-task alignment

---

## Anti-Pattern Watchlist

### Handlebars Syntax in Prompts
- **Detection:** Prompt templates contain `{{#each ...}}`, `{{#if ...}}`, `{{> partial}}`, or whitespace inside braces like `{{ foo }}`.
- **Why it fails:** Yoke's prompt engine is a minimal Mustache-style variable substituter (`prompt-template-spec.md` §10). Anything beyond `{{identifier}}` / `{{dotted.path}}` throws `PromptTemplateError` at assembly time, killing the phase before the agent runs.
- **Resolution:** Pass arrays/objects as whole values (`{{item.acceptance_criteria}}` serializes the array as JSON) and let the agent render them. If you need bullet output, pre-format the strings in the manifest.

### Old `.yoke.yml` Layout
- **Detection:** Generating a root-level `.yoke.yml` file, using `project.name` as the top-level identity key, or writing a single template per repo.
- **Why it fails:** Yoke discovers templates under `.yoke/templates/*.yml` (README §Template structure). A root `.yoke.yml` is not loaded. The top-level identity key is `template:` with `name` + optional `description`, shown in the dashboard picker.
- **Resolution:** Always write to `.yoke/templates/<kebab-name>.yml`. Use `template.name` and `template.description`. Generate multiple templates when the project has genuinely different workflow shapes (e.g. `plan-build.yml` + `fix-only.yml`).

### Missing `"*"` Wildcard in Actions Map
- **Detection:** A `pre:` or `post:` command's `actions:` map has only specific exit codes (`"0"`, `"1"`) with no `"*"` entry.
- **Why it fails:** AJV config validation rejects the template at load time (`yoke-config.schema.json#/$defs/actionsMap`). The user sees a startup error, not a runtime fail.
- **Resolution:** Every `actions:` map must include `"*"`. Use `"*": continue` for advisory gates or `"*": { fail: { reason: "..." } }` for strict gates.

### Rubber-Stamp Review Gate
- **Detection:** A review phase exists but no `post:` command enforces the verdict. The pipeline advances regardless of what the reviewer wrote.
- **Why it fails:** The yoke harness does not read `review-verdict.json` or reviewer output on its own (Issue 4). Pass/fail lives in user-owned post commands. Without a gate, the review phase is decorative.
- **Resolution:** Always attach a `post:` command that reads the review artifact and exits non-zero on FAIL, with `actions: { "1": { goto: implement, max_revisits: 3 }, "*": continue }`. The review-verdict.json pattern (PASS/FAIL + blocking_issues) is the canonical contract.

### Invented Prompt Variables
- **Detection:** Prompt template references `{{item.score}}`, `{{reviewer_verdict}}`, `{{features}}`, or any variable not in the standard inventory.
- **Why it fails:** Unknown variables are a hard assembly error (`prompt-template-spec.md` §2). The prompt never reaches the agent.
- **Resolution:** Stick to documented variables: `workflow_name`, `stage_id`, `architecture_md`, `git_log_recent`, `user_injected_context`; per-item: `item`, `item_id`, `item_state` (fields: `status`, `current_phase`, `retry_count`, `blocked_reason`), `handoff_entries`, `recent_diff`; once-stage: `items_summary`. Custom fields live inside `{{item.*}}` via the manifest.

### Free-Form `handoff.json` Edits in Prompts
- **Detection:** Prompt tells the agent to "write handoff.json" or "add an entry to handoff.json" without referencing `scripts/append-handoff-entry.js`.
- **Resolution:** Every phase that writes a handoff entry must pipe the entry through the typed writer. Off-by-one brackets from free-form edits poison every future session for that item (prompt assembly throws on parse).

### Flattery / Bare Personas
- **Detection:** `docs/agents/<role>.md` uses "world-class," "expert," "senior/best," or is a single line like "You are a product manager."
- **Why it fails:** Superlatives route to motivational text clusters (Ranjan 2024). Bare titles activate the broadest, shallowest knowledge. Both degrade output.
- **Resolution:** Real job title + primary responsibility + reporting/collaboration context, under 50 tokens. Then a vocabulary payload of 15–30 terms in 3–5 clusters, each passing the 15-year practitioner test. Zero superlatives.

### Premature Pipeline
- **Detection:** User's goal fits in one sentence, has no parallel workstreams, no genuinely different expertise across subtasks, and you still design a 3+ phase pipeline.
- **Why it fails:** A 3-agent pipeline costs roughly 3.5× tokens for 2.3× output (DeepMind). The user pays more and waits longer.
- **Resolution:** Apply the cascade. L0 single agent → L1 agent + tools → L2 worker + reviewer → L3 full pipeline. Only escalate when the lower level demonstrably fails.

---

## Behavioral Instructions

### Phase 1: Intake

1. Scan the user's request against the anti-pattern watchlist. IF a match is detected (e.g. they ask for `.yoke.yml`, Handlebars syntax, or a 5-phase pipeline for a one-file script): name the pattern and course-correct before asking anything else.

2. Read existing state in parallel when present: `.yoke/templates/` (any existing templates), `package.json`, root `README.md`, `docs/` for architecture or idea files, `CLAUDE.md`. Summarize what's there in one sentence.

3. Ask the user (skip any question already answered):
   a. **Goal** — one-paragraph description of the project / workflow.
   b. **Lifecycle** — one-off build vs long-lived workflow that runs repeatedly on new items.
   c. **Tech / constraints** — language, framework, domain rules, test commands to wire into `post:`.
   d. **Stakes** — internal prototype / team tool / published artifact / regulated data. Drives reviewer intensity.

WAIT for the user's response before proceeding.

### Phase 2: Cascade Assessment

4. Classify the goal against the cascade:
   - **L0 — single agent:** One clear artifact, no review loop warranted. Offer a single `run: once` phase with one prompt. Example: "write a recipe scraper."
   - **L1 — agent + tools:** Needs external data or file I/O but no review. Still one phase; wire tools via agent args or MCP.
   - **L2 — worker + reviewer:** Minimum viable yoke pipeline. Two phases (`implement` + `review`) in a single stage. This is the recommended default for most real work.
   - **L3 — plan + implement + review:** Planner decomposes into a `features.json` items manifest; implement + review run per-item; post-review failure loops back to implement.

5. IF L0 or L1: present the single agent + prompt + one-phase template and skip to Phase 8. Offer L2 as an option — the review safety net often pays for itself.

6. IF L2 or L3: state the reasoning in one sentence and proceed.

WAIT for user confirmation before proceeding.

### Phase 3: Pipeline Design

7. Lay out stages and phases. Canonical L3 shape:
   - **Stage `planning`** — `run: once`, `phases: [plan]`. Planner writes the items manifest file (default: `docs/idea/features.json`).
   - **Stage `implementation`** — `run: per-item`, `phases: [implement, review]`. Implement writes code + handoff entry; review writes verdict + handoff entry; post-command on review loops back to implement on FAIL.

8. Decide optional additions based on the domain:
   - **Architecture stage** (software, high stakes): `run: once` after planning, before implementation. Set `needs_approval: true` so the user signs off on the architecture document before per-item work begins.
   - **Build/test gate**: usually lives as a `post:` command on `implement` (e.g. `pnpm test`, `pnpm typecheck`), not as a separate phase.
   - **Polish stage** (content, docs): `run: once` at the end, consolidating across all items.

9. For each `run: per-item` stage, pick the manifest convention:
   - Default: `docs/idea/<workflow>-features.json` with `features.schema.json` shape (fields: `id`, `description`, `acceptance_criteria`, `review_criteria`, `depends_on`, optional `category`, `priority`).
   - Any other shape is fine as long as `items_list`, `items_id`, and optionally `items_depends_on` can traverse it (items are opaque to the harness, Issue 2).

10. Present the pipeline as a text diagram. WAIT for approval.

### Phase 4: Review Strategy

11. Match review intensity to stakes:
    - **Single reviewer (default):** One review phase, one `review-verdict.json`, one post-command gate. Works for internal tools, prototypes, personal projects. See `prompts/review.md` in the yoke repo for the canonical shape.
    - **Multi-angle via subagents (high stakes):** The review phase launches 2–5 reviewer subagents in parallel via the `Task` tool. Each writes `reviews/<item-id>/<angle>.json` conforming to `review.schema.json`. A post-command synthesizer reads them and decides PASS/FAIL. Reviewer angles live as Claude Code subagent files in `.claude/agents/<angle>.md`.

12. IF multi-angle, pick angles from the domain/stakes matrix:
    - Software web app: correctness, security, simplicity. Add performance and accessibility for public-facing or high-stakes.
    - Software CLI / library: correctness, simplicity. Add API-design for libraries, security for CLIs handling secrets.
    - Content / docs: grammar-prose, factual-accuracy, reader-experience.
    - Research: methodology, statistical-validity.
    - Low-stakes projects: one reviewer is plenty.

### Phase 5: Agent Personas

13. For each role the pipeline needs (planner, implementer, reviewer — and optionally each reviewer angle as a Claude Code subagent), generate a persona file at `docs/agents/<role>.md` using the 7-component format (identity, vocabulary, deliverables, decision authority, SOP, anti-patterns, interaction model).

14. Rules — applied to every persona:
    - Identity under 50 tokens. Real job title. No superlatives.
    - 15–30 vocabulary terms in 3–5 clusters. Include framework originators (e.g. `hexagonal architecture (Cockburn)`). Consultant-speak banned.
    - SOP: numbered imperative steps with IF/THEN. Every implementer SOP must include: read `handoff.json`, write code in small commits, append handoff entry via `scripts/append-handoff-entry.js`. Every reviewer SOP must include: verify each AC and RC, flag at least one issue or explicitly justify clearance (MAST FM-3.1 guard).
    - Anti-pattern watchlist: 5–10 named patterns. Reviewer personas MUST include Rubber-Stamp Approval.

15. Prompts reference personas via a "Read this file first" line (not a CLI flag):
    ```
    You are the [role]. Read `docs/agents/<role>.md` in full before proceeding.
    State in one sentence what you are about to do, then proceed.
    ```

### Phase 6: Prompt Templates (Mustache, not Handlebars)

16. Author one file per phase under `prompts/<phase>.md`. Syntax rules (from `docs/design/prompt-template-spec.md`):
    - Only `{{identifier}}` and `{{dotted.path}}` are supported.
    - No whitespace inside braces. No loops, conditionals, partials, escapes.
    - Unknown variables → hard error. Stay inside the standard inventory below unless you know the context builder provides a phase-specific extra.

17. Standard variables available in every phase: `workflow_name`, `stage_id`, `architecture_md`, `git_log_recent`, `user_injected_context`.

18. Per-item phase variables: `item` (full opaque object, JSON-serialized at top level; dot-traversal for fields), `item_id`, `item_state.status | .current_phase | .retry_count | .blocked_reason`, `handoff_entries` (pretty-JSON array), `recent_diff`.

19. Once-stage variable: `items_summary` (all items + current states).

20. Every prompt must include:
    - Role assignment + "read `docs/agents/<role>.md`" line.
    - One-sentence declaration requirement ("State in one sentence what you are about to do").
    - The relevant slice of context (`{{item}}`, `{{architecture_md}}`, `{{handoff_entries}}`, etc.).
    - Explicit deliverable and stop condition.
    - For implement/review: the typed handoff-writer block (see Output Format below).
    - For review: write `review-verdict.json` with `{"verdict":"PASS"}` or `{"verdict":"FAIL","blocking_issues":[...]}`.

### Phase 7: Compose the Template YAML

21. Write `.yoke/templates/<workflow-slug>.yml`. Top level: `version: "1"`, `template: { name, description }`, `pipeline.stages[]`, `phases: {...}`. Optional top-level: `worktrees`, `github`, `runtime`, `rate_limit`, `safety_mode`.

22. For each phase:
    - `command: claude`
    - `args: ["-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--model", "<model-id>"]` (only include `--dangerously-skip-permissions` with the user's explicit awareness; yoke runs in isolated worktrees so this is the common choice).
    - `prompt_template: prompts/<phase>.md`
    - `max_outer_retries: 2` (sane default). `retry_ladder: [continue, fresh_with_failure_summary, awaiting_user]` is the common default.
    - `post:` array with at least one gate that includes `"*"`.
    - For phases that produce a validated file, add `output_artifacts: [{ path, schema, required: true }]`. Artifact validators run before `post:` commands.

23. The planner phase's `post:` must validate the features manifest and distinguish "invalid" from "needs more planning." Recommended shape:
    ```yaml
    post:
      - name: check-features-json
        run: ["node", "scripts/check-features-json.js", "docs/idea/<workflow>-features.json"]
        timeout_s: 30
        actions:
          "0": continue
          "1": { retry: { mode: fresh_with_failure_summary, max: 2 } }
          "2": { goto: plan, max_revisits: 3 }
          "*": stop-and-ask
    ```

24. The review phase's `post:` gate loops back on FAIL:
    ```yaml
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
    ```

### Phase 8: Gate Scripts

25. Generate scripts under `scripts/` as needed. Prefer the three canonical helpers, mirrored from the yoke repo so they work without yoke-internal paths:
    - `scripts/append-handoff-entry.js` — typed stdin → handoff.json append with schema validation. REQUIRED whenever any phase writes a handoff entry.
    - `scripts/check-handoff-json.js` — advisory validator; exit 0 on absent-or-valid, 1 on malformed. Wire with `{ "0": continue, "*": continue }` so it logs but doesn't block.
    - `scripts/check-review-verdict.js` — reads `review-verdict.json`, exits 0 on PASS, 1 on FAIL / missing / malformed. Wire with `{ "0": continue, "1": { goto: implement, max_revisits: 3 }, "*": stop-and-ask }`.

26. If the user is using ajv for schema validation in scripts, add `ajv` and `ajv-formats` to their `package.json` dev dependencies. Otherwise fall back to `jq`-based gates:
    ```yaml
    - name: check-needs-more-planning
      run: ["jq", "-e", ".needs_more_planning != true", "docs/idea/features.json"]
      actions:
        "0": continue
        "1": { goto: plan, max_revisits: 3 }
        "*": stop-and-ask
    ```

27. Common test/typecheck post-commands on the implement phase:
    ```yaml
    - name: run-tests
      run: ["pnpm", "test"]
      timeout_s: 300
      actions:
        "0": continue
        "*": { retry: { mode: fresh_with_failure_summary, max: 2 } }
    ```
    Replace `pnpm test` with the user's actual test command. Wire `pnpm typecheck`, `cargo test`, `pytest -x`, etc. the same way.

### Phase 9: Items Manifest

28. For L3 pipelines, generate the initial manifest at the path referenced by `items_from`. Two shapes:
    - **Empty planner seed** (when user's description is high-level): `{ "project": "<name>", "created": "<ISO>", "needs_more_planning": true, "features": [] }`. Planner populates on first run; the post-plan gate loops until `needs_more_planning` is false.
    - **Pre-seeded** (when user gave enough detail): 3–7 items, each with `id` (kebab-case like `feat-<slug>`), `description`, `depends_on` array, `acceptance_criteria` (≥1), `review_criteria` (≥1), optional `category` / `priority`.

29. Every acceptance criterion must be behaviorally testable. Every review criterion must be something a reviewer can concretely check against the diff.

### Phase 10: Present and Write

30. Summarize what will be written: file paths, one-line description each, pipeline diagram, persona list, review strategy, which gate scripts.

31. WAIT for explicit approval.

32. Write every file in one batch. After writing:
    - Remind the user to `chmod +x scripts/*.sh` if any shell scripts were generated.
    - Remind them to `pnpm add -D ajv ajv-formats` (or equivalent) if gate scripts use ajv.
    - Remind them to run `yoke doctor` to validate the template before `yoke start`.
    - Note the workflow name (`template.name`) they'll see in the dashboard picker.

---

## Output Format

### File set

| Path | Purpose |
|---|---|
| `.yoke/templates/<slug>.yml` | Schema-valid template config (one or more) |
| `prompts/<phase>.md` | Mustache prompt template per phase |
| `docs/agents/<role>.md` | Persona file loaded by the prompt's "read this first" line |
| `.claude/agents/<angle>.md` | Reviewer subagent (only when multi-angle review is chosen) |
| `docs/idea/<workflow>-features.json` | Items manifest (for per-item stages) |
| `scripts/append-handoff-entry.js` | Typed handoff writer (whenever any phase touches handoff.json) |
| `scripts/check-handoff-json.js` | Advisory handoff validator |
| `scripts/check-review-verdict.js` | Review PASS/FAIL gate |
| `scripts/check-features-json.js` | Planner output validator (L3 only) |

### Canonical implement-phase prompt skeleton

```
You are the [role]. Read `docs/agents/<role>.md` in full before proceeding.

State in one sentence what you are about to build, then proceed.

You are implementing feature **{{item_id}}** for workflow **{{workflow_name}}**.

## Feature spec
{{item}}

## Current state
Phase: {{item_state.current_phase}} | Attempt: {{item_state.retry_count}}

## Architecture
{{architecture_md}}

## Handoff entries for this feature
{{handoff_entries}}

## Recent commits
{{git_log_recent}}

## Recent diff
{{recent_diff}}

## User guidance
{{user_injected_context}}

---

[domain-specific implementation rules here]

When done, append a handoff entry via the typed writer — never edit
`handoff.json` directly:

```bash
cat <<'JSON' | node scripts/append-handoff-entry.js
{
  "phase": "implement",
  "attempt": <retry_count + 1>,
  "session_id": "<value of $YOKE_SESSION_ID>",
  "ts": "<ISO 8601 timestamp>",
  "note": "<one-paragraph: what was built, what tests cover it, what is deferred>",
  "intended_files": ["<files modified>"],
  "deferred_criteria": ["<any AC/RC consciously deferred with reason>"],
  "known_risks": ["<risks for the reviewer>"]
}
JSON
```

Stop after the writer returns exit 0.
```

### Canonical review-phase prompt skeleton

Same header block as implement. Deliverables section:

```
Review the implementation against the acceptance and review criteria in
{{item}}. For each criterion, cite specific evidence from {{recent_diff}}
or the code. Report blocking issues and non-blocking observations.

Write `review-verdict.json` at the worktree root:
  {"verdict":"PASS"}
or
  {"verdict":"FAIL","blocking_issues":["..."],"notes":"..."}

If FAIL, also append a handoff entry with phase "review", verdict "FAIL",
and the same blocking issues, via scripts/append-handoff-entry.js.

Do not re-implement. Stop after the verdict file and handoff entry are
written.
```

### Canonical L3 template stanza

```yaml
version: "1"
template:
  name: my-workflow
  description: "Plan, implement per-feature with review loop"

pipeline:
  stages:
    - id: planning
      run: once
      phases: [plan]
    - id: implementation
      run: per-item
      items_from: docs/idea/my-workflow-features.json
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
    args: ["-p","--output-format","stream-json","--verbose","--dangerously-skip-permissions","--model","claude-sonnet-4-6"]
    prompt_template: prompts/plan.md
    output_artifacts:
      - path: docs/idea/my-workflow-features.json
        # schema: optional — copy features.schema.json from the yoke repo
        # into your project (e.g. schemas/features.schema.json) to enable
        # AJV validation here.
        required: true
    max_outer_retries: 2
    post:
      - name: check-features-json
        run: ["node","scripts/check-features-json.js","docs/idea/my-workflow-features.json"]
        timeout_s: 30
        actions:
          "0": continue
          "1": { retry: { mode: fresh_with_failure_summary, max: 2 } }
          "2": { goto: plan, max_revisits: 3 }
          "*": stop-and-ask

  implement:
    command: claude
    args: ["-p","--output-format","stream-json","--verbose","--dangerously-skip-permissions","--model","claude-sonnet-4-6"]
    prompt_template: prompts/implement.md
    max_outer_retries: 2
    retry_ladder: [continue, fresh_with_failure_summary, awaiting_user]
    post:
      - name: check-handoff
        run: ["node","scripts/check-handoff-json.js"]
        timeout_s: 10
        actions: { "0": continue, "*": continue }
      - name: run-tests
        run: ["pnpm","test"]
        timeout_s: 300
        actions:
          "0": continue
          "*": { retry: { mode: fresh_with_failure_summary, max: 2 } }

  review:
    command: claude
    args: ["-p","--output-format","stream-json","--verbose","--dangerously-skip-permissions","--model","claude-sonnet-4-6"]
    prompt_template: prompts/review.md
    post:
      - name: check-handoff
        run: ["node","scripts/check-handoff-json.js"]
        timeout_s: 10
        actions: { "0": continue, "*": continue }
      - name: check-verdict
        run: ["node","scripts/check-review-verdict.js"]
        timeout_s: 10
        actions:
          "0": continue
          "1": { goto: implement, max_revisits: 3 }
          "*": stop-and-ask

worktrees:
  base_dir: .worktrees
  branch_prefix: my-workflow/
  bootstrap:
    commands: ["pnpm install"]

runtime:
  keep_awake: true

rate_limit:
  handling: passive
```

---

## Examples

### BAD — Handlebars syntax + root `.yoke.yml` + missing wildcard

```yaml
# .yoke.yml  <-- wrong path; yoke will not load this
version: "1"
project:      # <-- wrong top-level key
  name: my-proj
pipeline:
  stages:
    - id: impl
      run: per-item
      phases: [implement, review]
phases:
  review:
    post:
      - name: gate
        run: ["node","check.js"]
        actions:
          "0": continue     # <-- missing "*"; AJV rejects at load
```

```
# prompts/implement.md.hbs  <-- wrong: .hbs is a hint you're using Handlebars
## Acceptance
{{#each item.acceptance_criteria}}   # <-- hard assembly error
- {{this}}
{{/each}}
```

Problems: wrong config location; wrong top-level key; missing `"*"` wildcard fails schema validation; `{{#each}}` fails prompt assembly; `.hbs` extension suggests engine misunderstanding.

### GOOD — current yoke conventions

```yaml
# .yoke/templates/my-workflow.yml
version: "1"
template:
  name: my-workflow
  description: "Plan + implement + review loop"
pipeline:
  stages:
    - id: implementation
      run: per-item
      items_from: docs/idea/features.json
      items_list: "$.features"
      items_id: "$.id"
      items_display: { title: "$.description" }
      phases: [implement, review]
phases:
  review:
    command: claude
    args: ["-p","--output-format","stream-json","--verbose","--dangerously-skip-permissions","--model","claude-sonnet-4-6"]
    prompt_template: prompts/review.md
    post:
      - name: check-verdict
        run: ["node","scripts/check-review-verdict.js"]
        actions:
          "0": continue
          "1": { goto: implement, max_revisits: 3 }
          "*": stop-and-ask
```

```
# prompts/implement.md  (plain .md; mustache only)
You are the backend engineer. Read `docs/agents/backend.md` before proceeding.

## Feature
{{item}}

## Acceptance criteria
{{item.acceptance_criteria}}   # agent parses the JSON array inline

## Handoff history
{{handoff_entries}}
```

Every rule holds: `.yoke/templates/` path, `template:` root, `"*"` wildcard present, mustache-only syntax, canonical variables only, persona file referenced via read-this-first line.

---

## Questions This Skill Answers

- "Set up yoke for this project"
- "Create a yoke template"
- "Scaffold a yoke workflow"
- "Wire up a plan/implement/review pipeline"
- "Design a yoke pipeline for [goal]"
- "Turn this into a yoke workflow"
- "I ran `yoke init` — now what?"
- "Help me write the prompts for my yoke phases"
- "What should my features.json look like?"
- "Add a review stage to my yoke template"
- "Build the post-command gates for this workflow"
- "My yoke template fails validation, fix it"
- "Convert my ad-hoc scripts to a yoke workflow"
- "Give me a multi-reviewer setup for high-stakes code"
