# Round 2 Pre-Work

**Status:** pre-01 complete (round-1 merged to master). Next: create `prework/round-2-setup`, drop the config files, run the agent for pre-02/03/04.

---

<!-- ═══════════════════════════════════════════════════════════════════
     USER SECTION — complete these steps, then delete everything from
     here down to the END USER SECTION marker before handing the file
     to the agent.
     ═══════════════════════════════════════════════════════════════════ -->

## [USER] Step 1 — Create the branch

```
git checkout -b prework/round-2-setup
```

## [USER] Step 2 — Create / replace these files

Copy-paste each block below into the named file. `.yoke.yml` already exists (round-1 config) — overwrite it.

### `.yoke.yml` (replace — round-2 pipeline)

```yaml
version: "1"

project:
  name: yoke-round-2

pipeline:
  stages:
    - id: round-2-fixes
      run: per-item
      items_from: docs/idea/fixes-round-2-features.json
      items_list: "$.features"
      items_id: "$.id"
      items_depends_on: "$.depends_on"
      items_display:
        title: "$.id"
        subtitle: "$.category"
      phases:
        - implement
        - review

phases:
  implement:
    command: claude
    args:
      - "-p"
      - "--output-format"
      - "stream-json"
      - "--verbose"
      - "--dangerously-skip-permissions"
      - "--model"
      - "claude-sonnet-4-6"
    prompt_template: prompts/self-host-implement.md
    max_outer_retries: 2
    retry_ladder:
      - continue
      - fresh_with_failure_summary
      - awaiting_user
    post:
      - name: check-handoff
        run: ["node", "scripts/check-handoff-json.js"]
        timeout_s: 10
        actions:
          "0": continue
          "*":
            retry:
              mode: fresh_with_failure_summary
              max: 2
      - name: run-tests
        run: ["pnpm", "test"]
        timeout_s: 300
        actions:
          "0": continue
          "*":
            retry:
              mode: fresh_with_failure_summary
              max: 2
      - name: run-typecheck
        run: ["pnpm", "typecheck"]
        timeout_s: 60
        actions:
          "0": continue
          "*":
            retry:
              mode: fresh_with_failure_summary
              max: 2

  review:
    command: claude
    args:
      - "-p"
      - "--output-format"
      - "stream-json"
      - "--verbose"
      - "--dangerously-skip-permissions"
      - "--model"
      - "claude-sonnet-4-6"
    prompt_template: prompts/self-host-review.md
    post:
      - name: check-handoff
        run: ["node", "scripts/check-handoff-json.js"]
        timeout_s: 10
        actions:
          "0": continue
          "*":
            retry:
              mode: fresh_with_failure_summary
              max: 2
      - name: check-verdict
        run: ["node", "scripts/check-review-verdict.js"]
        timeout_s: 10
        actions:
          "0": continue
          "1":
            goto: implement
            max_revisits: 3
          "*": continue

worktrees:
  base_dir: .worktrees
  branch_prefix: yoke-r2/
  bootstrap:
    commands:
      - "pnpm install"

github:
  enabled: true
  auto_pr: true
  pr_target_branch: master
  auth_order:
    - env:GITHUB_TOKEN
    - gh:auth:token

runtime:
  keep_awake: true

rate_limit:
  handling: passive
```

### `.yoke-round-3.yml` (create new)

```yaml
version: "1"

project:
  name: yoke-round-3

pipeline:
  stages:
    - id: round-3-fixes
      run: per-item
      items_from: docs/idea/fixes-round-3-features.json
      items_list: "$.features"
      items_id: "$.id"
      items_depends_on: "$.depends_on"
      items_display:
        title: "$.id"
        subtitle: "$.category"
      phases:
        - implement
        - review

phases:
  implement:
    command: claude
    args:
      - "-p"
      - "--output-format"
      - "stream-json"
      - "--verbose"
      - "--dangerously-skip-permissions"
      - "--model"
      - "claude-sonnet-4-6"
    prompt_template: prompts/self-host-implement.md
    max_outer_retries: 2
    retry_ladder:
      - continue
      - fresh_with_failure_summary
      - awaiting_user
    post:
      - name: check-handoff
        run: ["node", "scripts/check-handoff-json.js"]
        timeout_s: 10
        actions:
          "0": continue
          "*":
            retry:
              mode: fresh_with_failure_summary
              max: 2
      - name: run-tests
        run: ["pnpm", "test"]
        timeout_s: 300
        actions:
          "0": continue
          "*":
            retry:
              mode: fresh_with_failure_summary
              max: 2
      - name: run-typecheck
        run: ["pnpm", "typecheck"]
        timeout_s: 60
        actions:
          "0": continue
          "*":
            retry:
              mode: fresh_with_failure_summary
              max: 2

  review:
    command: claude
    args:
      - "-p"
      - "--output-format"
      - "stream-json"
      - "--verbose"
      - "--dangerously-skip-permissions"
      - "--model"
      - "claude-sonnet-4-6"
    prompt_template: prompts/self-host-review.md
    post:
      - name: check-handoff
        run: ["node", "scripts/check-handoff-json.js"]
        timeout_s: 10
        actions:
          "0": continue
          "*":
            retry:
              mode: fresh_with_failure_summary
              max: 2
      - name: check-verdict
        run: ["node", "scripts/check-review-verdict.js"]
        timeout_s: 10
        actions:
          "0": continue
          "1":
            goto: implement
            max_revisits: 3
          "*": continue

worktrees:
  base_dir: .worktrees
  branch_prefix: yoke-r3/
  bootstrap:
    commands:
      - "pnpm install"

github:
  enabled: true
  auto_pr: true
  pr_target_branch: master
  auth_order:
    - env:GITHUB_TOKEN
    - gh:auth:token

runtime:
  keep_awake: true

rate_limit:
  handling: passive
```

### `docs/idea/fixes-round-2-features.json` (create new)

See `docs/idea/round-3-fixes.md` for `docs/idea/fixes-round-3-features.json` — create it at the same time.

Content for this file is in the round-2 feature cards below (agent section). Copy from the JSON block in the agent section's preamble, or just let the agent know the manifest needs to exist before it starts (the user creates it, not the agent).

> **Shortcut:** The full JSON for both manifests lives in the original planning doc or can be reconstructed from the feature cards. Create the files now from the JSON in this file's card details section and from `round-3-fixes.md`.

The JSON structure:
```json
{
  "project": "yoke",
  "round": 2,
  "created": "2026-04-20T00:00:00Z",
  "_topological_order": ["r2-01","r2-03","r2-04","r2-05","r2-07","r2-08","r2-09","r2-12","r2-02","r2-06","r2-10","r2-11","r2-13"],
  "features": [ ...cards r2-01 through r2-13... ]
}
```

The 13 feature cards are defined in `docs/idea/round-2-fixes.md`'s card details section below. The agent does not create this file — **you create it now** before running the agent.

## [USER] Step 3 — Commit and open PR

```bash
git add .yoke.yml .yoke-round-3.yml docs/idea/fixes-round-2-features.json docs/idea/fixes-round-3-features.json
git commit -m "chore: add round-2/3 manifests and pipeline configs"
git push -u origin prework/round-2-setup
gh pr create --base master --title "pre-work: items_from plumbing + prompt rewrites for round 2"
```

## [USER] Step 4 — Run the agent

Open a **fresh** Claude Code session on `prework/round-2-setup`.
Delete the USER SECTION (everything above this line), then paste the remainder into the session.

<!-- ═══════════════════════════════════════════════════════════════════
     END USER SECTION — delete everything above this line.
     ═══════════════════════════════════════════════════════════════════ -->

---

# Agent: Stage 1 pre-work for round 2

You are executing Stage 1 pre-work of the round-2 fixes for the Yoke harness on branch `prework/round-2-setup`. Read `docs/idea/round-2-fixes.md` before doing anything else. Do not rely on memory; this file specifies each change with file paths and acceptance criteria.

## Domain vocabulary

PromptContextInputs, PromptAssemblerFn, buildPromptContext, assemblePrompt, handlebars variable (e.g. `{{item.id}}`, `{{stage.items_from}}`, `{{handoff}}`), self-host prompt template, harness-injected handoff entry, diff-check, items_from manifest, acceptance criterion, review criterion, retry ladder (continue → fresh_with_failure_summary → awaiting_user), outer retry, goto action, post-command action grammar, rAF batching, WS frame broadcast, classifier result, fresh-with-failure-summary.

## Your task

Execute three cards in order:

**pre-02** — Plumb `stage.items_from` through the prompt assembler. Replace the hardcoded `"docs/idea/fixes-round-1-features.json"` in both self-host prompts with `{{stage.items_from}}`.

**pre-03** — Rewrite `prompts/self-host-implement.md` using skill-creator principles. Preserve every handlebars variable. Goal: reduce the 1–4 retries per implement observed in round 1.

**pre-04** — Rewrite `prompts/self-host-review.md` using skill-creator principles. Preserve every handlebars variable and the `review-verdict.json` contract enforced by `scripts/check-review-verdict.js`. Goal: fewer false FAILs, clearer citations, no stale-verdict harness loops.

## Methodology for prompt rewrites (pre-03 and pre-04)

Apply skill-creator principles directly — do NOT produce SKILL.md files. Our outputs are standing prompt templates (.md files read and rendered by the harness at run time).

- **Expert vocabulary payload** — salt the prompt with domain-specific terms: acceptance criterion, review criterion, handoff.json, diff-check, items_from manifest, retry ladder, rAF batching, WS frame, classifier result, goto action, stage_complete, phase_advance, fresh_with_failure_summary.
- **Dual register** — every major rule stated as one-line imperative plus one-line "why".
- **Named anti-pattern watchlist** — surface known failure modes by name (see Anti-Patterns section).
- **Progressive disclosure** — reorder: (1) role/task, (2) AC/RC contract, (3) prior failures (handoff), (4) architecture, (5) recent commits, (6) user guidance, (7) instructions + anti-pattern checklist, (8) pre-stop checklist.
- **Pre-stop checklist** — explicit gate items confirmed before stopping.

## Anti-patterns to watch for in YOUR execution

| Name | What it is |
|---|---|
| silent defer | Skipping an AC without adding it to `deferred_criteria` |
| test ellipsis | Adding a code path without a matching test |
| timing-sensitive assert | `page.waitForTimeout(N)` or sleep-based polling in Playwright |
| giant commit | More than ~5 files in one commit |
| mocked-when-integration | Mocking SQLite or Fastify when the RC demands a real instance |
| stale verdict | Leaving `review-verdict.json` from a prior attempt in the worktree |
| typecheck-after-test | Running `pnpm test` without `pnpm typecheck` |

## Pre-stop checklist

1. `pnpm test` passes (full suite)
2. `pnpm typecheck` passes
3. `pnpm --filter web test:e2e` has not regressed
4. pre-02's new tests in `tests/prompt/` are present and green
5. No literal `"fixes-round-1-features.json"` remains in `prompts/` or `src/` (grep must return empty)
6. Every handlebars variable in the old prompts still resolves in the rewritten ones
7. `review-verdict.json` produced by the review prompt passes `scripts/check-review-verdict.js`
8. Commits are small (~5 files) with messages explaining the "why"
9. No modifications to `docs/idea/fixes-round-2-features.json` or any `*.features.json`

## When done

Open a single PR titled `"pre-work: items_from plumbing + prompt rewrites for round 2"`. Body: summary of pre-02/03/04 with links to commits. Do NOT run the round-2 pipeline — that is a separate step after the PR merges.

---

## Card details

### pre-02 — items_from plumbing

**Why.** Prompts currently hardcode `docs/idea/fixes-round-1-features.json`. Every new round requires hand-forking both prompts. The fix threads one optional field through the assembler chain.

**Files to edit:**

- `src/server/prompt/context.ts` — extend `PromptContextInputs.stage` with `itemsFrom?: string`; expose `stage.items_from` (empty string when undefined) in the rendered context.
- `src/server/scheduler/scheduler.ts` — extend `PromptAssemblerFn` opts with `stageItemsFrom?: string`; pass `stageItemsFrom: stage.items_from` at the `assemblePromptFn(...)` call site in `_runSession`.
- `src/cli/start.ts` — receive `stageItemsFrom` in `assemblePromptFn`, pass it as `stage.itemsFrom` into `buildPromptContext`.
- `prompts/self-host-implement.md` and `prompts/self-host-review.md` — replace the literal `docs/idea/fixes-round-1-features.json` with `{{stage.items_from}}`; delete the `<!-- TODO: ... -->` comment blocks.

**Tests:**

- `tests/prompt/context.test.ts` — assert `ctx.stage.items_from` equals the passed-in value and equals `""` when undefined.
- `tests/prompt/assembler.test.ts` — render a template with `{{stage.items_from}}` and assert substitution; add render-smoke cases for both self-host prompt files.

**Acceptance criteria:**

- AC-1: `PromptContextInputs.stage` has `itemsFrom?: string`.
- AC-2: `PromptAssemblerFn` opts include `stageItemsFrom?: string` and the scheduler passes it.
- AC-3: `buildPromptContext` exposes `stage.items_from` in the rendered context.
- AC-4: Both self-host prompts reference `{{stage.items_from}}` instead of a literal path.
- AC-5: No occurrence of `"fixes-round-1-features.json"` in `prompts/` or `src/`.
- AC-6: Tests in `tests/prompt/` cover the new variable.

**Review criteria:**

- RC-1: Template fails loudly if `{{stage.items_from}}` is referenced while undefined for a per-item stage — silent empty-string substitution is a latent bug; pick one behavior and test it.
- RC-2: `stage.items_from` is a string path, not a parsed manifest.
- RC-3: No round-specific manifest path remains anywhere in the tree.

---

### pre-03 — rewrite `prompts/self-host-implement.md`

**Why.** Most round-1 items required 1–4 implement retries due to: missed AC (no test written), handoff entry skipped or malformed, typecheck failure after test success, huge commits, deferred criteria not flagged.

**Constraints (hard):**

- Preserve every handlebars variable: `{{workflow_name}}`, `{{item.id}}`, `{{item.description}}`, `{{item.acceptance_criteria}}`, `{{item.review_criteria}}`, `{{stage.items_from}}`, `{{architecture_md}}`, `{{git_log_recent}}`, `{{user_injected_context}}`, `{{handoff}}`.
- Preserve the handoff append contract (`node scripts/append-handoff-entry.js`).
- Preserve the diff-check guard (do NOT modify the items_from manifest).
- Preserve the `docs/agents/*.md` read step.

**Length target:** no more than 2× the current file length.

**Acceptance criteria:**

- AC-1: File assembles without error against a fixture `PromptContextInputs`; every `{{...}}` resolves.
- AC-2: `tests/prompt/assembler.test.ts` has a render-smoke test against the new file.
- AC-3: Pre-stop checklist is present, enumerated, covers test, typecheck, AC coverage, handoff, diff-check guard.
- AC-4: Named anti-pattern list is present and matches a subset of the Anti-Patterns table above.
- AC-5: `forge:skill-creator` mentioned in the commit message as a methodology reference.

**Review criteria:**

- RC-1: No handlebars variable from the old prompt is dropped.
- RC-2: No round-specific path or feature id appears in the prompt.
- RC-3: Exactly one path for appending to handoff.json (the helper script).
- RC-4: Progressive disclosure ordering — AC/RC before architecture, handoff before recent commits.

---

### pre-04 — rewrite `prompts/self-host-review.md`

**Why.** Round 1's review phase sometimes FAILed on non-blocking omissions and looped the harness. Attempt 4 of `feat-prepost-rendering` shows a stale `review-verdict.json` from attempt 2 causing re-entry even though attempt 3 had already fixed the issue.

**Constraints (hard):**

- Preserve every handlebars variable currently rendered for review phases.
- Preserve the `review-verdict.json` schema (`verdict: "PASS" | "FAIL"`, `feature_id`, `blocking_issues` array when FAIL).
- Preserve the handoff append contract.
- Reviewer MUST NOT modify code — explicit prohibition.

**Content additions:**

- Evidence rubric: every AC/RC verdict cites `file:line` or diff hunk. No verdicts without citations.
- Blocking vs non-blocking rubric: blocking = AC/RC literally unmet, regression, test gap for a named code path; non-blocking = stylistic/minor gap.
- Stale verdict guard: `rm -f review-verdict.json` as the **first** instruction.
- Named anti-pattern watchlist (review-specific subset).
- Pre-stop checklist.

**Acceptance criteria:**

- AC-1: File assembles without error; every `{{...}}` resolves.
- AC-2: Prompt explicitly instructs `rm -f review-verdict.json` before starting.
- AC-3: Evidence rubric present — every AC/RC verdict has a `file:line` citation.
- AC-4: Blocking/non-blocking rubric present.
- AC-5: Prompt explicitly prohibits code modifications.
- AC-6: `tests/prompt/assembler.test.ts` has a render-smoke test against the new file.
- AC-7: A fixture `review-verdict.json` produced by the prompt's example passes `scripts/check-review-verdict.js`.

**Review criteria:**

- RC-1: No change to the `review-verdict.json` schema fields the gate already reads.
- RC-2: Review prompt never instructs the agent to "fix" anything — only to report.
- RC-3: Stale-verdict guard is the very first operational step.

---

## Full anti-patterns table (embed subset into each rewritten prompt)

| Name | What it is | Why it matters |
|---|---|---|
| silent defer | Skipping an AC without adding it to `deferred_criteria` | Hides partial work; reviewer can't tell intended scope |
| test ellipsis | Adding a code path without a matching test | Regressions slip in |
| timing-sensitive assert | `page.waitForTimeout(N)` or sleep-based polling | Flakes under CI load |
| giant commit | More than ~5 files in a single commit | Retries can't bisect |
| mocked-when-integration | Mocking SQLite or Fastify when RC demands real instance | Tests pass locally, fail in prod |
| stale verdict | Leaving `review-verdict.json` from a prior attempt | Gate script reads it, harness loops back needlessly |
| reviewer re-implement | Reviewer writes code instead of reporting | Breaks the phase contract |
| blocking-when-non-blocking | Classifying a trivial gap as blocking | Cheapens the label; harness loops on non-issues |
| typecheck-after-test | Running `pnpm test` but not `pnpm typecheck` | Tests pass with type errors that break `pnpm build` |
| handoff free-form | Editing `handoff.json` directly instead of via helper | Corrupts JSON |
| missing citation | Reviewer states Pass/Fail without a `file:line` reference | Not evidence-based |
