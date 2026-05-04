---
name: yoke-setup-forge
description: |
  Forge-aware yoke setup. Takes a team blueprint produced by forge's
  mission-planner skill (topology + roles + artifact chain + quality gates)
  together with agent definitions from forge's agent-creator (7-component
  format) and turns them into a complete, schema-valid yoke configuration:
  `.yoke/templates/<name>.yml`, mustache prompts under `prompts/`, persona
  files under `docs/agents/`, Claude Code subagents under `.claude/agents/`
  for parallel review angles, gate scripts under `scripts/`, and a starter
  items manifest. Maps each of the four topologies (sequential-pipeline,
  parallel-independent, centralized-coordinator, hierarchical) onto yoke's
  stage/phase/Task-tool primitives with correct handoff wiring between
  every role in the blueprint.

  Use this skill when the user has run (or wants to run) forge's
  mission-planner and needs the output wired into a runnable yoke workflow,
  when they say "turn this blueprint into a yoke template," "convert my
  agent team to yoke," "run this mission through yoke," or when the
  conversation already contains a team blueprint with YAML frontmatter
  (goal / domain / topology / agent_count). Also triggers when Mission
  Planner delegates yoke-harness wiring back to the user.

  Do NOT use for building a yoke workflow from a free-text description
  with no blueprint (use yoke-setup). Do NOT use to modify an existing
  mission-planner blueprint (re-run mission-planner). For agent persona
  design in isolation (no yoke), use forge's agent-creator.
---

# Yoke Setup (Forge-Aware)

Turns a forge team blueprint into a runnable yoke pipeline. Every agent in
the blueprint becomes either its own phase, a Claude Code subagent launched
by a parent phase, or a merged responsibility — chosen by the topology. The
artifact chain becomes handoff entries + typed output files; quality gates
become `post:` commands.

---

## Expert Vocabulary Payload

**Forge Interop:** team blueprint, mission-planner output, topology frontmatter, agent-definition 7-component format, artifact chain, quality gate, RACI boundary, 45% threshold, cascade pattern (L0–L3), `./library/` loading, usage-log, Conway's Law

**Topology Mapping:** sequential-pipeline → stage+phases, parallel-independent → Task-tool fanout with synthesis phase, centralized-coordinator → coordinator phase + subagent workers, hierarchical → lead phase + delegated subagents, artifact handoff format, blackboard file

**Yoke Harness Binding:** `.yoke/templates/<name>.yml`, `run: once` vs `run: per-item`, opaque items (Issue 2), mustache `{{var}}` / `{{item.field}}` only, `handoff_entries`, `append-handoff-entry.js`, typed output artifact + `output_artifacts.schema`, user-owned review aggregation (Issue 4), `post:` action grammar with required `"*"` wildcard, `retry_ladder`, `max_revisits` loop guard, worktree bootstrap

**Subagent Orchestration:** Claude Code `Task` tool, `.claude/agents/<name>.md` subagent files, review-lead pattern, parallel verdict aggregation, synthesis verdict JSON, adversarial framing, MAST FM-3.1 rubber-stamp prevention

**Artifact Types:** PRD, Architecture Decision Record (Michael Nygard), system design document, implementation + tests, test results report, review verdict, synthesis verdict, handoff entry (prose note + intended_files + deferred_criteria + blocking_issues)

---

## Anti-Pattern Watchlist

### One-Phase-Per-Role Reflex
- **Detection:** Blueprint has 4 roles → you generate 4 `run: once` phases in a linear stage. No use of the Task tool. No item manifest. No retry loop.
- **Why it fails:** Yoke's value is per-item iteration + retry + review feedback. Blindly collapsing every blueprint role into its own phase produces a single-shot waterfall that can't recover from any one role's failure without re-running everything upstream. It also wastes the `per-item` stage mechanism when the work is naturally decomposable.
- **Resolution:** Split by run-semantics. `run: once` phases for one-shot planning/architecture roles whose deliverable is a single document (PRD, Architecture Doc). `run: per-item` stage for roles that repeat per work unit (implementer, QA). Use the Task tool for parallel reviewers inside a single phase, not separate phases.

### Topology Ignored
- **Detection:** Blueprint says `topology: parallel-independent` but the generated yoke template has a sequential stage with the agents as linear phases.
- **Why it fails:** The topology is the core design decision. Misrepresenting it loses the parallelism and forces agents to block on dependencies that don't exist in the original design.
- **Resolution:** Map each topology deliberately (see Behavioral Instructions Phase 3). If you cannot express the topology cleanly in yoke primitives, explicitly tell the user which compromises you're making and why.

### Synthesis Forgotten
- **Detection:** Blueprint is `parallel-independent` with 3 workers, but the yoke template has no synthesis phase and no post-command that aggregates the parallel artifacts.
- **Why it fails:** Parallel-independent topology requires a synthesis step by definition. Without it, yoke has 3 disconnected artifacts and no next-stage input.
- **Resolution:** Either (a) add a synthesis phase after the parallel fanout, or (b) wire a `post:` command on the parallel phase that reduces the N artifacts into one canonical handoff entry.

### Blueprint Quality Gate Dropped
- **Detection:** Blueprint lists "PRD must be reviewed by user before architecture begins" but the generated template has no `needs_approval: true` and no gate.
- **Resolution:** Every blueprint quality gate maps to one of: `needs_approval: true` on the next stage (pauses for user), or a `post:` command with `stop-and-ask` on failure, or a reviewer phase with a verdict gate. Preserve the intent, don't drop it.

### Persona Rebuild
- **Detection:** The user already has agent definitions from agent-creator, and you regenerate personas from scratch instead of using what they wrote.
- **Resolution:** Load the agent-creator output verbatim into `docs/agents/<role>.md` and adapt only the Interaction Model section to reference yoke-specific handoff paths (handoff.json, append-handoff-entry.js, {{item}} variables). Never rewrite a curated persona.

### Blueprint Anti-Patterns Lost
- **Detection:** The team blueprint's "Anti-Patterns to Guard Against" section is nowhere in the generated template.
- **Resolution:** Propagate blueprint anti-patterns into the prompt templates of the relevant phases ("Do not introduce [pattern]"). This is where they do useful work at runtime.

### All anti-patterns from `yoke-setup.md` apply here
- In particular: Handlebars syntax, root `.yoke.yml`, missing `"*"` wildcard, rubber-stamp review gate, invented prompt variables, free-form `handoff.json` edits, flattery/bare personas. This skill inherits those without reciting them.

---

## Behavioral Instructions

### Phase 1: Ingest the Blueprint

1. Scan the current conversation (or a file path the user supplies) for a team blueprint matching the mission-planner schema. Expected frontmatter:
   ```yaml
   goal: "..."
   domain: software | marketing | security | operations | custom
   complexity: single-agent | team
   topology: sequential-pipeline | parallel-independent | centralized-coordinator | hierarchical
   agent_count: N
   estimated_cost_tier: low | medium | high
   ```
   Expected body sections: Roles, Artifact Chain, Quality Gates, Topology (rationale), Anti-Patterns to Guard Against.

2. IF no blueprint is present: tell the user this skill needs one, and suggest invoking forge's mission-planner first. Do not fabricate a blueprint.

3. IF `complexity: single-agent`: produce one `run: once` phase + one persona + one prompt template, skip the rest. Yoke is still useful for session lifecycle and worktree isolation, but no pipeline is needed.

4. Look for agent definitions in `./library/agents/<name>.md`, `.claude/agents/<name>.md`, or inline in the conversation. Each should follow the 7-component format from `agent-creator`. IF only the blueprint's one-line role descriptions exist: note which roles need agent-creator expansion before prompts can be authored.

OUTPUT: ingested blueprint summary (topology, roles, artifact chain, gates, anti-patterns) plus inventory of existing agent definitions vs roles still needing expansion.

WAIT if any role lacks an agent definition — offer to expand them via agent-creator before proceeding.

### Phase 2: Topology Mapping

5. Apply the topology mapping rules. This is the core translation.

   **sequential-pipeline → stage with ordered phases OR multiple `run: once` stages**
   - If each role's deliverable is a single one-shot document (PRD, architecture, test report): use multiple `run: once` stages in sequence, one phase per stage. Put blueprint quality gates between stages as `needs_approval: true`.
   - If a role repeats per work unit (implementer producing code per feature, QA reviewing per feature): put it inside a `run: per-item` stage. Preceding one-shot roles (e.g. planner, architect) remain in their own `run: once` stages before the per-item stage.
   - Example — SaaS blueprint (PM → Architect → Engineer → QA):
     - Stage `planning` (`run: once`, phases: `[prd]`) — PM writes PRD.
     - Stage `architecture` (`run: once`, phases: `[design]`, `needs_approval: true`) — Architect writes architecture.
     - Stage `implementation` (`run: per-item`, phases: `[implement, qa]`) — Engineer implements each feature, QA reviews each.

   **parallel-independent → one phase with Task-tool fanout + synthesis phase**
   - The parallel workers become Claude Code subagents at `.claude/agents/<worker>.md`. The parent phase's prompt instructs the agent to launch all workers in parallel via the Task tool.
   - Add a `synthesis` phase after the parallel phase OR a `post:` reducer that writes a single synthesized artifact.
   - Example — Marketing Campaign (Writer || Social || Analyst, synthesized by Strategist):
     - Stage `campaign` (`run: once`, phases: `[fanout, synthesis]`). `fanout` launches 3 subagents in parallel; `synthesis` reads their outputs and writes the final asset bundle.

   **centralized-coordinator → coordinator phase with Task-tool workers, iterated**
   - One `run: per-item` stage where the phase is the coordinator. Workers are `.claude/agents/<worker>.md` subagents.
   - Each worker subagent writes a typed artifact to a known path; the coordinator reads them, re-plans if needed, and signals completion via `handoff.json` + `review-verdict.json`.
   - `post:` on the coordinator phase reads the verdict and either marks the item complete or loops back for another coordinator pass.

   **hierarchical → lead phase that delegates via Task tool, followed by lead-review**
   - Structurally similar to coordinator, but the lead is expected to produce a final integrated artifact. Represent as `run: per-item` stage with phases `[delegate, integrate]`. Lead subagents live in `.claude/agents/`.

6. For every topology, confirm the items manifest shape:
   - `parallel-independent` where "items" are independent workstreams → no manifest; the fanout is inside a single phase.
   - `sequential-pipeline` with a repeating per-item role → manifest at `docs/idea/<workflow>-features.json` (or a schema the user chose).
   - `centralized-coordinator` / `hierarchical` with a backlog → manifest; the coordinator/lead iterates per item.

7. Present the topology-to-yoke diagram to the user and name each mapping choice with its rationale.

WAIT for approval or adjustments.

### Phase 3: Artifact Chain → Handoff Wiring

8. The blueprint's artifact chain is:
   ```
   Role A → Artifact X (format) → Role B → Artifact Y (format) → Role C → ...
   ```
   Translate each arrow into one of three wiring mechanisms:

   **a. Typed file in the worktree** — for large, structured artifacts (PRD, architecture doc, code). Declare under `phases.<name>.output_artifacts: [{ path, schema?, required: true }]`. The artifact validator runs before `post:` commands.

   **b. handoff.json entry** — for cross-phase narrative + metadata per item. The producing role's prompt ends with a typed-writer block:
   ```bash
   cat <<'JSON' | node scripts/append-handoff-entry.js
   { "phase": "<phase>", "attempt": <n>, "session_id": "...", "ts": "...",
     "note": "<one-paragraph narrative>",
     "intended_files": [...], "deferred_criteria": [...],
     "known_risks": [...] }
   JSON
   ```
   The consuming role reads `{{handoff_entries}}` in its prompt.

   **c. Review verdict file** — for reviewer outputs. One-reviewer model: `review-verdict.json` with `{verdict, blocking_issues, notes}`. Multi-reviewer: `reviews/<item-id>/<angle>.json` conforming to `review.schema.json` + a synthesizer post-command.

9. For each chain edge, pick the mechanism based on artifact size + reuse:
    - Single long-form doc consumed by one downstream role: typed file.
    - Short status + metadata consumed by multiple later roles: handoff entry.
    - Pass/fail decision with issue list: review verdict.

10. Map blueprint quality gates to yoke mechanisms:
    - "Must be reviewed by user before [next step]" → `needs_approval: true` on the next stage.
    - "Must pass [specific criteria]" → `post:` command with `actions: { "0": continue, "*": { fail: {...} } }` or a `retry` branch.
    - "Must show all critical AC passing" → reviewer phase + `check-review-verdict.js` gate with `{ "1": { goto: <prior-phase>, max_revisits: N } }`.

### Phase 4: Persona Placement

11. For each role in the blueprint:
    - IF an agent-creator definition exists in the conversation or library: write it verbatim to `docs/agents/<role>.md` (or `.claude/agents/<role>.md` if the role is a Claude Code subagent under a parent phase — typically parallel-independent workers or multi-angle reviewers).
    - IF only the blueprint's one-line role description exists: generate a full 7-component persona following the rules in `docs/design` → use the same persona rules as yoke-setup.md Phase 5 (identity <50 tokens, real job title, 15–30 vocabulary terms in 3–5 clusters, IF/THEN SOP, anti-pattern watchlist with 5+ patterns).
    - Always adapt the Interaction Model section to reference yoke specifics: handoff.json paths, append-handoff-entry.js, `{{item}}` / `{{handoff_entries}}` variables, review-verdict.json, the Task tool for subagent coordination.

12. Propagate the blueprint's team-level "Anti-Patterns to Guard Against" into each relevant persona's anti-pattern watchlist, plus into the prompt template of the role responsible for preventing that pattern.

### Phase 5: Prompt Templates

13. Author `prompts/<phase>.md` per phase. Follow the yoke-setup.md rules: mustache only (`{{var}}`, `{{dotted.path}}`), no loops/conditionals, no invented variables. Standard per-item variables: `item`, `item_id`, `item_state`, `handoff_entries`, `recent_diff`, plus always-available `workflow_name`, `architecture_md`, `git_log_recent`, `user_injected_context`.

14. Topology-specific prompt patterns:

    **Sequential-pipeline phase prompt** — standard shape: role + read-this-persona + context slice + deliverable + handoff writer block. The upstream phase's handoff entry + output artifact is the downstream phase's input.

    **Parallel-independent fanout phase prompt** — the parent phase's prompt must:
    - Enumerate each worker subagent by `.claude/agents/<name>` file path and by the context it needs.
    - Instruct the agent to call `Task` for each worker IN PARALLEL (single message with multiple tool uses).
    - Specify each worker's required output path (e.g. `outputs/<phase>/<worker>.md`).
    - Explicitly tell the parent agent: "Do not do the workers' jobs yourself. Only dispatch and wait."

    **Parallel-independent synthesis phase prompt** — read each worker's output file, reconcile, produce the unified artifact, append a single handoff entry.

    **Centralized-coordinator phase prompt** — the coordinator prompt lists available subagents, the decision rules for when to dispatch which subagent, and the completion condition. Write a verdict file when the coordinator judges the item complete.

    **Hierarchical lead prompt** — similar to coordinator but explicitly integrative: the lead produces the final artifact by composing subagent outputs.

15. Multi-angle review prompt (any topology with parallel reviewers) — ensures MAST FM-3.1 rubber-stamp prevention:
    ```
    You are the review lead for item {{item_id}}.

    ## Review angles
    Launch the following reviewer subagents IN PARALLEL via the Task tool.
    Each must write `reviews/{{item_id}}/<angle>.json` with this shape:
      { "item_id": "...", "reviewer": "<angle>", "verdict": "pass" | "fail",
        "acceptance_criteria_verdicts": [{ "criterion": "...", "pass": bool, "notes": "..." }],
        "review_criteria_verdicts": [{ "criterion": "...", "pass": bool, "notes": "..." }],
        "additional_issues": [{ "severity": "low|medium|high|critical", "category": "...", "description": "...", "file": "...", "line": N, "suggestion": "..." }] }
    (This is yoke's review.schema.json shape, embedded here so projects
    without the yoke schema file can still validate downstream.)

    - correctness: .claude/agents/reviewer-correctness.md
    - security: .claude/agents/reviewer-security.md
    - simplicity: .claude/agents/reviewer-simplicity.md

    ## Synthesis
    After all verdicts are in:
    1. If ANY reviewer verdict is "fail": overall verdict is FAIL.
    2. Collect all additional_issues; deduplicate by (category, file, line).
    3. Write review-verdict.json at the worktree root:
       { "verdict": "PASS" | "FAIL",
         "blocking_issues": [...],
         "notes": "<one-line summary>" }
    4. Append a review handoff entry via scripts/append-handoff-entry.js.
    ```
    Each reviewer subagent persona under `.claude/agents/` must carry the adversarial-framing SOP step: "Identify at least one issue. If none, cite specific evidence justifying clearance."

### Phase 6: Compose the Template YAML

16. Build `.yoke/templates/<workflow-slug>.yml` reflecting the topology mapping from Phase 2. Apply all the yoke-setup.md rules: `version: "1"`, `template: { name, description }`, stage array, phases map, `"*"` wildcard on every `actions` map, `command: claude` with stream-json args.

17. Wire output artifacts from Phase 3. The planner-equivalent phase gets `output_artifacts: [{ path: <manifest>, schema: <features.schema.json>, required: true }]`. The architecture phase (if present) gets `output_artifacts: [{ path: docs/architecture.md, required: true }]` (schema optional for free-form markdown).

18. Wire quality gates from Phase 3. `needs_approval: true` on stages that follow a human-review gate. `post:` commands with appropriate `retry` / `goto` / `fail` branches for automated gates.

19. For parallel-independent and coordinator/hierarchical topologies: the parent phase spawns subagents via the Task tool from inside the prompt, so the phase itself is a normal `claude -p` invocation. The subagent files at `.claude/agents/<name>.md` must exist in the worktree. Ensure `worktrees.bootstrap.commands` preserves them (no `rm -rf`).

### Phase 7: Gate Scripts & Starter Manifest

20. Emit the same canonical scripts as yoke-setup.md: `scripts/append-handoff-entry.js`, `scripts/check-handoff-json.js`, `scripts/check-review-verdict.js`, and `scripts/check-features-json.js` when there is a manifest to validate.

21. For synthesis post-commands (parallel-independent): generate a small node script `scripts/synthesize-<phase>.js` that reads the per-worker outputs and writes the unified artifact. Return exit 0 on success, 1 on missing/invalid worker output → wired to `retry` or `goto` on failure.

22. Write the starter items manifest at the path declared in `items_from`, matching the shape the planner-role prompt expects.

### Phase 8: Propagate Anti-Patterns + Rationale

23. For every anti-pattern in the blueprint's "Anti-Patterns to Guard Against" list, add a one-line guard to the relevant prompt file ("Do not [pattern]; if tempted, [resolution]") AND to the relevant persona's anti-pattern watchlist. This is the primary value of this skill over yoke-setup.md alone — the blueprint's domain knowledge does not get lost in translation.

24. For every topology rationale sentence in the blueprint, add it as a comment at the top of `.yoke/templates/<slug>.yml` (YAML `#` comments) so future readers understand why the shape is what it is.

### Phase 9: Present and Write

25. Summarize in a table: each blueprint role → its yoke placement (phase name, file path, subagent or not), each artifact chain edge → its mechanism (typed file / handoff entry / review verdict), each quality gate → its yoke wiring (`needs_approval` / `post:` / verdict gate).

26. Also present: pipeline text diagram, file list with one-line descriptions, anti-pattern propagation map, library-usage log entry content (for forge's `usage-log.jsonl`).

27. WAIT for explicit approval.

28. Write every file in one batch. After writing:
    - Append a usage record to `./library/usage-log.jsonl` (forge convention): `{ "ts": "...", "skill": "yoke-setup-forge", "blueprint_goal": "...", "topology": "...", "agent_count": N, "modifications": [...] }`.
    - Remind the user to `chmod +x scripts/*.sh` if any shell scripts were emitted, and to `pnpm add -D ajv ajv-formats` (or equivalent) if schema-validating gates were used.
    - Remind them to `yoke doctor` before `yoke start`.

---

## Output Format

### File set (superset of yoke-setup)

| Path | Purpose |
|---|---|
| `.yoke/templates/<slug>.yml` | Topology-shaped yoke config, with rationale comments at the top |
| `prompts/<phase>.md` | Mustache prompt per phase, topology-aware (fanout / synthesis / coordinator / lead) |
| `docs/agents/<role>.md` | Each blueprint role's persona (verbatim from agent-creator when available) |
| `.claude/agents/<worker>.md` | Claude Code subagent — one per parallel worker / reviewer angle / delegated lead child |
| `docs/idea/<workflow>-features.json` | Items manifest, when a per-item stage is used |
| `scripts/append-handoff-entry.js` | Typed handoff writer |
| `scripts/check-handoff-json.js`, `scripts/check-review-verdict.js`, `scripts/check-features-json.js` | Standard gates |
| `scripts/synthesize-<phase>.js` | Parallel-independent synthesis reducer, when applicable |
| `./library/usage-log.jsonl` | Forge usage log entry (append) |

### Topology → yoke shape cheat sheet

| Blueprint topology | Yoke shape |
|---|---|
| sequential-pipeline (4 roles, all one-shot) | 4 stages, each `run: once`, one phase each; `needs_approval: true` on user-review gates |
| sequential-pipeline (plan-once + repeated work) | N `run: once` stages for the upstream roles, then one `run: per-item` stage with the repeating roles as phases |
| parallel-independent (3 workers + synthesis) | 1 stage, phases `[fanout, synthesis]`; workers under `.claude/agents/`; `fanout` prompt launches Task calls in parallel |
| centralized-coordinator | 1 `run: per-item` stage, one coordinator phase; workers under `.claude/agents/`; `post:` on coordinator reads verdict and decides complete-vs-loop |
| hierarchical | Same as coordinator but with an additional `integrate` phase (or a lead-review phase) that composes subagent outputs into the final artifact |

### Persona mapping rules

- Roles whose whole job is ONE phase → `docs/agents/<role>.md` (loaded via "Read this file first" in the phase prompt).
- Roles that are workers under a parent phase (parallel-independent, coordinator children, hierarchical children, review-angle reviewers) → `.claude/agents/<role>.md` (loaded by the Task tool when the parent spawns them).
- Never duplicate a persona in both locations. The Task tool finds `.claude/agents/`; phase prompts reference `docs/agents/` explicitly.

### Canonical parallel-independent template stanza

```yaml
version: "1"
# Topology: parallel-independent with synthesis
# Rationale: the three content streams (blog, social, analytics) have no
# data dependencies between them; Strategist synthesizes after.
template:
  name: launch-campaign
  description: "Forge marketing campaign blueprint"

pipeline:
  stages:
    - id: campaign
      run: once
      phases: [fanout, synthesis]

phases:
  fanout:
    command: claude
    args: ["-p","--output-format","stream-json","--verbose","--dangerously-skip-permissions","--model","claude-sonnet-4-6"]
    prompt_template: prompts/fanout.md
    max_outer_retries: 2
    post:
      - name: check-worker-outputs
        run: ["node","scripts/check-worker-outputs.js"]
        timeout_s: 30
        actions:
          "0": continue
          "1": { retry: { mode: fresh_with_failure_summary, max: 2 } }
          "*": stop-and-ask

  synthesis:
    command: claude
    args: ["-p","--output-format","stream-json","--verbose","--dangerously-skip-permissions","--model","claude-sonnet-4-6"]
    prompt_template: prompts/synthesis.md
    output_artifacts:
      - path: outputs/campaign/final-brief.md
        required: true
    post:
      - name: check-handoff
        run: ["node","scripts/check-handoff-json.js"]
        actions: { "0": continue, "*": continue }
```

`prompts/fanout.md` body sketch:
```
You are the campaign strategist. Read `docs/agents/strategist.md` first.

State in one sentence what you are about to dispatch, then proceed.

## Campaign brief
{{user_injected_context}}

## Architecture
{{architecture_md}}

## Your only job in this phase
Dispatch the three workers IN PARALLEL via the Task tool. Do not write
content yourself.

- Launch `.claude/agents/writer.md` with context:
  "Write 3 blog posts matching the campaign brief. Output path: outputs/campaign/writer.md"
- Launch `.claude/agents/social.md` with context:
  "Produce a 30-day social schedule with platform-specific copy. Output path: outputs/campaign/social.md"
- Launch `.claude/agents/analyst.md` with context:
  "Define KPIs, tracking setup, and measurement framework. Output path: outputs/campaign/analyst.md"

Wait for all three. Stop when every output file exists and is non-empty.
```

---

## Examples

### BAD — Flattening a parallel-independent blueprint into a sequence

Blueprint:
```yaml
topology: parallel-independent
agent_count: 4
```
Roles: Strategist (synthesis), Writer, Social, Analyst.

BAD output:
```yaml
pipeline:
  stages:
    - id: writer
      run: once
      phases: [writer]
    - id: social
      run: once
      phases: [social]
    - id: analyst
      run: once
      phases: [analyst]
    - id: synthesis
      run: once
      phases: [synthesis]
```

Problems: throws away parallelism (each stage blocks on the last); no Task-tool fanout; no shared context between the three workers; the Strategist's synthesis role is demoted to a trailing phase with no view of the blueprint's actual topology rationale.

### GOOD — Mapping parallel-independent correctly

```yaml
pipeline:
  stages:
    - id: campaign
      run: once
      phases: [fanout, synthesis]   # Strategist dispatches in fanout, synthesizes in synthesis
```

Workers in `.claude/agents/writer.md`, `.claude/agents/social.md`, `.claude/agents/analyst.md`. The `fanout` prompt tells Strategist to launch all three via Task tool in parallel. The `synthesis` prompt reads the three output files and produces `outputs/campaign/final-brief.md` with `output_artifacts` validation. Quality gate "campaign brief must be approved" maps to `needs_approval: true` on the `campaign` stage.

---

## Questions This Skill Answers

- "I have a team blueprint from mission-planner — wire it into yoke"
- "Turn this forge blueprint into a yoke template"
- "Convert my agent team to a runnable yoke workflow"
- "Mission-planner said parallel-independent — how does that become yoke?"
- "Take these agent-creator personas and yoke them together"
- "Map this artifact chain to yoke's handoff system"
- "Run this mission through yoke"
- "I ran mission-planner, now what?"
- "Generate the yoke config for this sequential pipeline"
- "How do I do a parallel review in yoke?"
- "Wire a coordinator agent to yoke"
- "Translate quality gates from my blueprint into yoke post commands"
- "Hook up forge's team blueprint to yoke's harness"
