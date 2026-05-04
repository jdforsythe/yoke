# Recipe — One-shot a Python CLI

**Who it's for:** anyone who wants to see Yoke produce something useful in one
session. No items, no review loop, no planning — just a single agent run with a
smoke gate.

**The goal:** scaffold a Python CLI that scrapes a recipe URL and prints a JSON
blob with title, ingredients, instructions, and source URL.

**Time:** five minutes plus however long the agent takes (a few minutes typically).

This recipe links back to [configuration.md](../configuration.md) for the schema
key reference and [prompts.md](../prompts.md) for the variable inventory.

---

## Project layout we'll create

```
recipe-scraper/
├── .yoke/
│   └── templates/
│       └── one-shot.yml
└── prompts/
    └── implement.md
```

---

## The template

Create `.yoke/templates/one-shot.yml`:

```yaml
version: "1"

template:
  name: one-shot
  description: "Single agent session, single deliverable"

pipeline:
  stages:
    - id: build
      run: once
      phases: [implement]

phases:
  implement:
    command: claude
    args: ["-p", "--output-format", "stream-json", "--verbose",
           "--dangerously-skip-permissions",
           "--model", "claude-sonnet-4-6"]
    prompt_template: prompts/implement.md
    max_outer_retries: 1
    post:
      - name: smoke-cli-runs
        run: ["bash", "-c",
              "test -f recipe_scraper/__init__.py && python -m recipe_scraper --help >/dev/null"]
        timeout_s: 30
        actions:
          "0": continue
          "*":
            retry: { mode: fresh_with_failure_summary, max: 1 }
```

Two things to notice:

1. The smoke gate runs `python -m recipe_scraper --help`. If that exits non-zero
   (no module, broken import, missing `__main__`), Yoke retries the agent with a
   fresh session and a summary of what failed.
2. `max_outer_retries: 1` keeps the budget tight. One retry is plenty for a
   smoke-only gate — if it fails twice, you want to look at it yourself.

---

## The prompt

Create `prompts/implement.md`:

```
You are a Python CLI engineer. Build a small, well-tested module from scratch.

State in one sentence what you are about to build, then proceed.

## Goal

Build a Python CLI named `recipe-scraper` that takes a recipe URL on the command
line and prints a JSON object with:

  - title (string)
  - source_url (string)
  - ingredients (array of strings)
  - instructions (array of strings)

## Constraints

- Layout: `recipe_scraper/` package with `__init__.py` and `__main__.py`.
- Entry point: `python -m recipe_scraper <url>` writes JSON to stdout.
- `--help` flag works (use argparse).
- Use `requests` and `beautifulsoup4`. Pin them in `requirements.txt`.
- Handle the common case (recipe sites with structured Schema.org JSON-LD).
- Fall back to a best-effort selector pass when JSON-LD is absent.
- Write at least three pytest tests with mocked HTTP responses.
- Add a one-paragraph README.md explaining install + usage.

## Workflow context

Workflow: {{workflow_name}}
Recent commits in this worktree:
{{git_log_recent}}

## Stop condition

When `python -m recipe_scraper --help` runs cleanly and `pytest` passes, you are
done. Commit your work in small batches with conventional commit messages. Do not
ask for confirmation — proceed and let the harness gate verify.
```

Variables used: `{{workflow_name}}`, `{{git_log_recent}}`. Both come straight from
the standard inventory.

---

## No items manifest needed

`run: once` means there's no `items_from`, no `features.json`, nothing to seed.
Yoke runs the single phase exactly once per workflow.

---

## What you'll see in the dashboard

1. **Workflow list** — your run appears as `pending`, then `active`.
2. **Live stream** — the agent's reasoning, tool calls (file writes, `Bash` runs of
   `pip install`, `pytest`), and final summary.
3. **Workflow status** — `complete` once the smoke gate passes.
4. **GitHub button** — if you set `github.enabled: true`, it opens the auto-created
   PR.

If the smoke gate fails, the workflow goes back to `active` with the prompt
augmented by the failure summary. After the second attempt fails, the workflow
parks in `awaiting_user` and the attention banner appears.

---

## Tweaks

- **Want a review loop?** Add a second phase to the stage and a `prompts/review.md`
  that writes `review-verdict.json`. See [plan-build-review](plan-build-review.md).
- **Want it for any other small project?** Replace the prompt with your own goal
  and the smoke gate with whatever "did it ship?" check makes sense (`cargo run`,
  `node dist/index.js --help`, `make smoke`).
- **Don't want auto-PR?** Drop the `github:` block (this template doesn't include
  one — add it when you're ready).
- **Want to allow more retries?** Bump `max_outer_retries`. Two is a sane default
  if the smoke gate is non-flaky.

---

## See also

- [Configuration reference](../configuration.md) — every key explained.
- [Prompts guide](../prompts.md) — full variable list.
- [Recipe — plan-build-review](plan-build-review.md) — when one-shot stops scaling.
