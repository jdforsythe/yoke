# Recipe — Marketing pipeline

**Who it's for:** marketers, founders, indie hackers who want to generate a
batch of ad copy with consistent brand voice and review each variant before
shipping.

**The goal:** for each customer persona, generate five ad variants. Each variant
is reviewed against a brand-voice rubric. FAIL routes back to the writer for a
rewrite.

**Time:** a few minutes per persona, run in parallel across personas.

This recipe shows that Yoke isn't just for code — anything you'd want a
plan/build/review loop on works the same way. No tests, no PRs, no `pnpm test`.
The "gates" are scripts that read the agent's output and decide pass / fail.

---

## Project layout

```
campaign/
├── .yoke/templates/marketing.yml
├── docs/
│   ├── personas.json            # the items manifest
│   ├── brand-voice.md           # rules the reviewer enforces
│   └── agents/
│       ├── copywriter.md
│       └── brand-reviewer.md
├── prompts/
│   ├── write.md
│   └── review.md
├── output/                      # writer drops files here, one dir per persona
└── scripts/
    └── check-brand-verdict.js
```

---

## The template

`.yoke/templates/marketing.yml`:

```yaml
version: "1"

template:
  name: marketing-pipeline
  description: "Per-persona ad variants with a brand-voice review loop"

pipeline:
  stages:
    - id: copy
      run: per-item
      items_from: docs/personas.json
      items_list: "$.personas"
      items_id: "$.id"
      items_display:
        title: "$.id"
        subtitle: "$.role"
        description: "$.summary"
      phases: [write, review]

phases:
  write:
    command: claude
    args: ["-p", "--output-format", "stream-json", "--verbose",
           "--dangerously-skip-permissions",
           "--model", "claude-sonnet-4-6"]
    prompt_template: prompts/write.md
    max_outer_retries: 2
    retry_ladder: [continue, fresh_with_failure_summary, awaiting_user]
    post:
      - name: variants-present
        run: ["bash", "-c",
              "ls output/${YOKE_ITEM_ID}/variant-*.md 2>/dev/null | wc -l | grep -qE '^[[:space:]]*5[[:space:]]*$'"]
        timeout_s: 10
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
      - name: check-brand-verdict
        run: ["node", "scripts/check-brand-verdict.js"]
        timeout_s: 10
        actions:
          "0": continue
          "1": { goto: write, max_revisits: 3 }
          "*": stop-and-ask

worktrees:
  base_dir: .worktrees
  branch_prefix: copy/
  bootstrap:
    commands: []
```

> **Note:** `YOKE_ITEM_ID` is illustrative — Yoke does not currently inject this
> as an env var on `post:` commands. If your gate needs the item id, encode it in
> your prompt deliverable (e.g. write `output/<id>/manifest.json`) and have the
> gate script read that. A simpler workaround for the variant count check above:
> have your prompt drop a single file `output/variants.json` with the variants
> array, and validate that file has length 5.

For the simpler approach, replace the gate with:

```yaml
- name: variants-present
  run: ["node", "-e",
        "const v=JSON.parse(require('fs').readFileSync('output/variants.json','utf8'));process.exit(Array.isArray(v)&&v.length===5?0:1)"]
  actions:
    "0": continue
    "*": { retry: { mode: fresh_with_failure_summary, max: 2 } }
```

And have the writer prompt produce `output/variants.json`.

---

## The personas manifest

`docs/personas.json`:

```json
{
  "campaign": "spring-2026-launch",
  "personas": [
    {
      "id": "persona-cto",
      "role": "CTO at a 50-person SaaS company",
      "summary": "Pragmatic, time-poor, allergic to hype.",
      "pain_points": ["uptime risk during deploys", "team velocity"],
      "channels": ["LinkedIn", "Hacker News"]
    },
    {
      "id": "persona-indie",
      "role": "Solo indie hacker",
      "summary": "Cost-sensitive, ships nights and weekends, loves self-hosted.",
      "pain_points": ["recurring SaaS bills", "yak shaving on infra"],
      "channels": ["Twitter/X", "newsletter"]
    },
    {
      "id": "persona-eng-mgr",
      "role": "Engineering manager at a 200-person company",
      "summary": "Optimizing for team output and morale.",
      "pain_points": ["onboarding velocity", "incident response"],
      "channels": ["LinkedIn", "Lenny's Newsletter sponsorship"]
    }
  ]
}
```

---

## The prompts

### `prompts/write.md`

```
You are the copywriter. Read `docs/agents/copywriter.md` before proceeding.

State in one sentence what you are about to write, then proceed.

## Persona
{{item}}

## Brand voice
{{architecture_md}}

(That's `architecture.md` at the worktree root; we use it here as the brand-voice
rules document. Place your rules there.)

## Previous attempts and reviewer feedback
{{handoff}}

## Task

Write **five** distinct ad variants for the persona above. Each variant should:

  - be 30–60 words
  - lead with the pain point, not the product
  - end with one concrete next action ("Start a 14-day trial", "See the demo")
  - vary the angle: cost, time, risk, team, story

Output: a single file at `output/variants.json`:

  [
    { "angle": "cost",  "headline": "...", "body": "...", "cta": "..." },
    { "angle": "time",  ... },
    ...
  ]

When done, append a handoff entry via scripts/append-handoff-entry.js with the
variants generated and any tradeoffs noted.

Stop after the file is written.
```

### `prompts/review.md`

```
You are the brand voice reviewer. Read `docs/agents/brand-reviewer.md` before
proceeding.

State in one sentence what you are about to verify, then proceed.

## Persona
{{item}}

## Brand voice rules
{{architecture_md}}

## Variants under review
(read `output/variants.json` from the worktree root)

## Implementer's handoff
{{handoff}}

---

For each variant, check:

  - Does it match the brand voice rules?
  - Is it the right length?
  - Does the CTA make sense for this persona's channels?
  - Does it avoid hype words and superlatives?

Write `review-verdict.json` at the worktree root:

  {"verdict":"PASS"}

or

  {"verdict":"FAIL","blocking_issues":["variant 2: hype word 'revolutionary'", ...]}

If FAIL, also append a handoff entry naming the specific variants and the rule
each one breaks. Do not rewrite anything.

Stop after the verdict file is written.
```

---

## Reviewer gate

`scripts/check-brand-verdict.js`:

```js
#!/usr/bin/env node
const fs = require('node:fs');
const file = 'review-verdict.json';
if (!fs.existsSync(file)) { console.error('no verdict'); process.exit(2); }
const v = JSON.parse(fs.readFileSync(file, 'utf8'));
if (v.verdict === 'PASS') process.exit(0);
if (v.verdict === 'FAIL') { console.log((v.blocking_issues || []).join('\n')); process.exit(1); }
process.exit(2);
```

---

## What you'll see in the dashboard

1. Three persona cards on the **Feature board** (one per persona).
2. They run in parallel — one worktree per persona.
3. **Live stream** shows the copywriter producing variants, then the reviewer
   reading the brand-voice rules and the variants file, then writing a verdict.
4. On FAIL, the workflow loops back to `write` for that persona with the
   reviewer's blocking issues in the handoff.
5. After three FAIL → write loops, the persona parks in `awaiting_user` and
   surfaces an attention banner so you can read the dispute.
6. When all three are PASS, the workflow completes. The output is in
   `<worktree>/output/variants.json` for each persona — copy it back to your repo
   if you don't want to merge the worktree branches.

---

## Tweaks

- **More variants?** Change "five" to whatever in the prompt and the gate.
- **More reviewer angles** (e.g. compliance + brand)? See
  [multi-reviewer](multi-reviewer.md).
- **One reviewer for all personas?** Run with `run: once` and a single `write`
  phase that produces variants for all personas, then a single `review` phase.
  Loses parallelism; gains one consistent reviewer pass.
- **Different output format?** Markdown, HTML, JSON — Yoke doesn't care. The
  reviewer gate just needs a file to read and an exit code to return.

---

## See also

- [Configuration reference](../configuration.md)
- [Prompts guide](../prompts.md)
- [Recipe — creative-writing](creative-writing.md) for a similar non-coding shape
  with chapters instead of personas.
