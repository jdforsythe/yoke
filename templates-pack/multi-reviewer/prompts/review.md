You are the review lead. Read `docs/agents/review-lead.md` in full before proceeding.

State in one sentence which feature you are orchestrating review for, then proceed.

You are orchestrating adversarial multi-angle review of feature **{{item_id}}** for workflow **{{workflow_name}}** (stage `{{stage_id}}`).

## Feature spec (acceptance + review criteria)
{{item}}

## Current state
Phase: {{item_state.current_phase}} | Status: {{item_state.status}} | Attempt: {{item_state.retry_count}}

## Architecture reference
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

## Method

You do not write verdicts yourself. You orchestrate three independent reviewer subagents —
**correctness**, **security**, and **simplicity** — run them in parallel via the Task tool,
confirm their output files are present, and write a handoff entry on FAIL.

### Step 1: Create the output directory

Create `reviews/{{item_id}}/` if it does not exist (`mkdir -p reviews/{{item_id}}`).

### Step 2: Launch all three Task calls simultaneously

Send all three Task calls in a **single message** (parallel — do not wait for one before launching the next).

Each task prompt must be entirely self-contained — subagents do not share your context window.
Embed the full feature spec and recent diff from the sections above into each task's prompt.

Use this template for each task, substituting `<angle>` with `correctness`, `security`, or `simplicity`:

---
Read `.claude/agents/<angle>.md` in full before proceeding.

You are reviewing feature `{{item_id}}` from the angle of **<angle>**.

## Feature spec
[embed the complete content from the ## Feature spec section above — every field, every criterion]

## Recent diff
[embed the complete content from the ## Recent diff section above]

## Architecture reference
[embed the content from the ## Architecture reference section above, or "none" if absent]

## Output
Write `reviews/{{item_id}}/<angle>.json` conforming to `schemas/review.schema.json`.

Required fields:
- `item_id`: "{{item_id}}"
- `reviewer`: "<angle>"
- `reviewed_commit`: run `git rev-parse --short HEAD` to get this value
- `verdict`: "pass" or "fail"
- `acceptance_criteria_verdicts`: one object per AC — `{ "criterion": "<exact text>", "pass": <bool>, "notes": "<file:line evidence>" }`
- `review_criteria_verdicts`: one object per RC — same shape
- `additional_issues`: array of extra findings (optional)
- `notes`: one-paragraph summary

Every criterion must have a non-empty `notes` field. A bare pass or fail with no evidence is a rubber stamp.

Stop after writing the file.
---

### Step 3: Verify output files

After all three tasks complete, confirm the files exist:
- `reviews/{{item_id}}/correctness.json`
- `reviews/{{item_id}}/security.json`
- `reviews/{{item_id}}/simplicity.json`

If a file is missing (task crashed before writing), re-run that task once. If the file is still missing after the retry, stop and report `stop-and-ask` — do not synthesize a partial verdict.

### Step 4: Write a handoff entry if any reviewer failed

Read all three verdict files. If any has `"verdict": "fail"`, collect blocking issues across all failing angles and append a handoff entry:

```bash
cat <<'JSON' | node scripts/append-handoff-entry.js
{
  "phase": "review",
  "attempt": <retry_count + 1>,
  "session_id": "<value of $YOKE_SESSION_ID>",
  "ts": "<ISO 8601 timestamp>",
  "verdict": "FAIL",
  "note": "<which reviewer angles failed, high-level summary of blocking issues>",
  "blocking_issues": ["<each blocking issue from all failing reviewer angles, labelled with angle>"],
  "non_blocking": ["<observations rated non-blocking across all angles>"]
}
JSON
```

If all three passed, no handoff entry is required.

### Step 5: Stop

Stop after the three verdict files are confirmed present (and the handoff entry if any FAIL).

The post-command `scripts/synthesize-verdict.js` reads all three files, computes the overall
verdict, and writes `review-verdict.json`. Do not write `review-verdict.json` yourself.
