# Recipe — Adversarial multi-reviewer

**Who it's for:** anyone shipping code to humans who'll have to maintain it. The
single-reviewer pattern in [plan-build-review](plan-build-review.md) is fine for
internal tools but tends to rubber-stamp on high-stakes work. The fix is to make
the review phase adversarial: launch several reviewer subagents in parallel, each
with a narrow remit, then synthesize their verdicts.

**The goal:** for each feature, after implement, run three reviewers in parallel
— **correctness**, **security**, **simplicity** — and a **synthesizer** that
rolls their verdicts into PASS / FAIL.

**Time:** review phase takes roughly the same wall-clock as a single reviewer
(the subagents run in parallel) but uses 3–4× the tokens. Worth it for code
reviewers will look at, often not for prototypes.

---

## How it works

A single Yoke phase runs one Claude Code session. That session has the `Task`
tool, which lets the agent launch subagents. Yoke detects `Task` tool_use calls
in the live stream and switches to the **ReviewPanel** dashboard renderer
automatically (or you can pin it via `ui.renderer: review`).

The orchestrator agent in this phase:

1. Launches three parallel subagents via `Task`, one per review angle.
2. Each subagent writes its verdict to `reviews/<item_id>/<angle>.json`.
3. After all three return, the orchestrator (acting as synthesizer) reads the
   three files and writes the final `review-verdict.json`.

The post-command gate is the same as the single-reviewer pattern — read the
verdict, exit 0 / 1 / 2.

---

## Project layout (additions to plan-build-review)

```
my-project/
├── .yoke/templates/multi-reviewer.yml
├── .claude/
│   └── agents/                  # Claude Code subagent definitions
│       ├── correctness-reviewer.md
│       ├── security-reviewer.md
│       └── simplicity-reviewer.md
├── prompts/
│   ├── implement.md
│   └── review.md                # the orchestrator/synthesizer prompt
├── reviews/                     # subagent outputs land here, per item
│   └── feat-auth/
│       ├── correctness.json
│       ├── security.json
│       └── simplicity.json
└── scripts/
    └── check-review-verdict.js
```

---

## The template

`.yoke/templates/multi-reviewer.yml`:

```yaml
version: "1"

template:
  name: multi-reviewer
  description: "Implement + 3 parallel reviewer subagents + synthesizer"

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
    ui:
      renderer: review              # pin the ReviewPanel; autodetect would also work
    post:
      - name: subagent-files-present
        run: ["bash", "-c",
              "ls reviews/*/correctness.json reviews/*/security.json reviews/*/simplicity.json >/dev/null 2>&1"]
        timeout_s: 10
        actions:
          "0": continue
          "*": { retry: { mode: fresh_with_failure_summary, max: 1 } }
      - name: check-verdict
        run: ["node", "scripts/check-review-verdict.js"]
        timeout_s: 10
        actions:
          "0": continue
          "1": { goto: implement, max_revisits: 3 }
          "*": stop-and-ask

worktrees:
  base_dir: .worktrees
  branch_prefix: mr/
  bootstrap:
    commands: ["pnpm install"]

github:
  enabled: true
  auto_pr: true
  pr_target_branch: main
  auth_order: [env:GITHUB_TOKEN, gh:auth:token]
```

---

## The orchestrator/synthesizer prompt

`prompts/review.md`:

```
You are the review lead. You will not analyze code yourself; you will dispatch
three reviewer subagents and synthesize their verdicts.

State in one sentence what you are about to coordinate, then proceed.

## Feature spec
{{item}}

## Implementer's handoff
{{handoff}}

## Diff under review
{{recent_diff}}

---

## Step 1: Launch three reviewers in parallel

Use the `Task` tool **three times in a single message** so they run
concurrently. Each subagent definition lives at `.claude/agents/<angle>.md` and
will be loaded automatically.

  Task(subagent_type: "correctness-reviewer", prompt: "<feature spec, diff, AC>")
  Task(subagent_type: "security-reviewer",    prompt: "<feature spec, diff, RC>")
  Task(subagent_type: "simplicity-reviewer",  prompt: "<feature spec, diff>")

Each subagent must write its verdict to:

  reviews/{{item_id}}/correctness.json
  reviews/{{item_id}}/security.json
  reviews/{{item_id}}/simplicity.json

with the shape:

  { "angle": "correctness", "verdict": "PASS"|"FAIL",
    "blocking_issues": ["..."], "non_blocking": ["..."],
    "notes": "..." }

Wait for all three Task calls to return before proceeding.

## Step 2: Synthesize

Read all three files. Synthesis rule:

  - If ANY angle is FAIL with non-empty blocking_issues, the synthesized
    verdict is FAIL.
  - If all three are PASS, synthesized verdict is PASS.
  - If any angle is malformed or missing, synthesized verdict is FAIL with a
    blocking issue naming the broken angle.

Write `review-verdict.json` at the worktree root:

  {"verdict":"PASS","angles":{"correctness":"PASS",...}}

or

  {"verdict":"FAIL","blocking_issues":[
    "[correctness] AC-2 not satisfied: ...",
    "[security] Stored XSS in src/render.ts:42",
    ...
  ],"angles":{...}}

## Step 3: Handoff

If FAIL, append a handoff entry via scripts/append-handoff-entry.js with the
synthesized blocking_issues so the next implement attempt sees them.

Stop after the verdict and (on FAIL) handoff entry are written.
```

---

## Subagent definitions

Each lives at `.claude/agents/<angle>.md` — these are Claude Code subagent files,
not Yoke-specific. The skeleton:

`.claude/agents/correctness-reviewer.md`:

```
---
name: correctness-reviewer
description: Verifies acceptance criteria are met against the diff. Tools: Read, Grep, Glob.
tools: Read, Grep, Glob
---

You are a correctness reviewer. You read diffs against acceptance criteria and
look for behavioral gaps.

## Process

1. Read each acceptance criterion from the spec.
2. For each, find the code change that implements it. Cite file:line.
3. If you can't find evidence, that's a blocking issue.
4. Look for off-by-one, error-path holes, missing input validation that
   AC-N implies.

## Output

Write `reviews/<item_id>/correctness.json` (the orchestrator will pass <item_id>
in the prompt). Shape:

  { "angle": "correctness",
    "verdict": "PASS" | "FAIL",
    "blocking_issues": ["AC-2: no test for the empty-input case"],
    "non_blocking": ["AC-1 implementation could be simpler"],
    "notes": "Spent most attention on the auth path." }

## Anti-patterns to avoid

- Rubber-stamping. If you can't cite evidence, say FAIL.
- Style nitpicks. Leave those to the simplicity reviewer.
- Speculation about future requirements. Stick to the AC.
```

Mirror the same shape for `security-reviewer.md` (look for SQLi, XSS, missing
authz checks, secret leakage) and `simplicity-reviewer.md` (look for needless
abstractions, dead code, opportunities to delete).

---

## Verdict gate

Same `scripts/check-review-verdict.js` as in
[plan-build-review](plan-build-review.md). Reads the synthesized
`review-verdict.json`, exits 0 on PASS, 1 on FAIL, 2 on missing/malformed.

---

## What you'll see in the dashboard

1. **Implement** runs as usual. The live stream pane shows the agent.
2. **Review** starts. The dashboard detects the `Task` calls and swaps to the
   **ReviewPanel** view: three subagent cards, each updating in real time as
   their subagent runs.
3. As each subagent finishes, its card flips to ✓ or ✗ and shows the angle's
   verdict.
4. After the orchestrator synthesizes, the synthesized verdict appears at the
   bottom of the panel.
5. On FAIL, the workflow loops back to `implement` with the blocking issues in
   the handoff. On PASS, the next item starts.

---

## Cost notes

Multi-reviewer is roughly 3.5× the tokens of single-reviewer for review (three
subagents + a synthesizer instead of one reviewer). For code that another human
will review and ship, that's a good trade — three angles catch issues a single
reviewer misses, and the synthesizer prevents one angle from rubber-stamping the
others.

For prototypes and personal projects, single-reviewer is plenty.

---

## Tweaks

- **More angles?** Add `performance-reviewer.md` and a `Task` line. Five is
  usually the practical max — past that, the synthesizer struggles.
- **Different angles per project?** Pick from: correctness, security, simplicity,
  performance, accessibility, API-design, factual-accuracy, methodology. The
  vocabulary should match what your reviewers care about.
- **Want the orchestrator to be a different model?** Set `--model` in the phase
  args to a more capable model for the synthesis step — the subagents inherit
  the orchestrator's model unless overridden in their `.claude/agents/<angle>.md`
  frontmatter.

---

## See also

- [Configuration reference](../configuration.md) — `ui.renderer: review`.
- [Prompts guide](../prompts.md) — variables and `handoff` shape.
- [Recipe — plan-build-review](plan-build-review.md) — single-reviewer baseline.
- [Dashboard guide](../dashboard.md) — ReviewPanel detail.
