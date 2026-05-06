# Getting started

A five-minute walkthrough: install Yoke, scaffold a workflow, run it, watch the
dashboard, ship a PR.

This page assumes you have a git repository to point Yoke at and Claude Code already
installed and authenticated. If not, see [install.md](install.md) first.

---

## 1. Install

```sh
npm install -g @jdforsythe/yoke
yoke --version
```

---

## 2. Pick a project

Yoke runs against any git repo. For your first run, pick something small that you
don't mind a robot writing to — a fresh empty repo is ideal.

```sh
mkdir -p ~/code/recipe-scraper
cd ~/code/recipe-scraper
git init
echo "# recipe scraper" > README.md
git add . && git commit -m "init"
```

You'll need `ANTHROPIC_API_KEY` set, or you'll need a Claude Pro/Max subscription
that authorises `claude` from the CLI. Yoke does **not** ship API keys; the agent
uses whatever credentials you've already given the `claude` binary. If `claude --version`
works in your shell, you're set.

---

## 3. Scaffold a workflow

The fastest path is `yoke setup` — a guided session that writes the template, the
prompts, the gate scripts, and an items manifest for you.

```sh
yoke setup
```

`yoke setup` drops you into a Claude Code session with the `yoke-setup` skill
pre-loaded — Claude asks five questions and writes the template, prompts, and
gate scripts for you. Requires `claude` on your `$PATH`; if it's missing, Yoke
prints an install hint and exits non-zero.

If you want to start by hand, `yoke init` drops a stub:

```sh
yoke init
```

```
Initialized yoke project:
  created /Users/you/code/recipe-scraper/.yoke/templates/default.yml

Next steps:
  1. Edit .yoke/templates/default.yml to configure your workflow.
  2. Run: yoke start
  3. Open the dashboard URL shown in the terminal.
  4. Pick a template, name your workflow, and click Run.
```

The stub is single-phase and minimal — fine for hello-world, but it doesn't have a
prompt file yet. Either edit it yourself (see the
[one-shot recipe](recipes/one-shot.md)) or rerun `yoke setup` for the guided path.

---

## 4. Validate

Before you start the engine, make sure the template parses and your prerequisites are
in order:

```sh
yoke doctor
```

Expected output:

```
yoke doctor
  ✓ node 20.x.y
  ✓ git 2.x.y
  ✓ sqlite ok
  ✓ .yoke/templates/default.yml schema-valid
```

If `yoke doctor` reports missing pieces (no Claude binary, no git, schema errors),
fix them now. See [troubleshooting.md](troubleshooting.md) for the common cases.

---

## 5. Start the engine

```sh
yoke start
```

```
Yoke dashboard: http://127.0.0.1:7777
```

Open that URL in your browser. You'll land on the **Workflow list** with a
**Templates** picker on the left. Your `default` template is one of the cards.

---

## 6. Run your first workflow

In the dashboard:

1. Click your template card.
2. Give the workflow a name (e.g. `first-run`).
3. Click **Run**.

A row appears in the sidebar with status **pending**. Within a tick of the scheduler,
it transitions to **active** and the **Live stream** pane lights up with the agent's
output — text, tool calls, thinking blocks.

When the agent exits cleanly:

1. Yoke runs each `post:` command.
2. If they all pass, the phase completes.
3. If a phase has `output_artifacts`, those are validated against their schemas first.
4. The next phase (or item, or stage) starts automatically.

When the whole workflow completes and you've configured `github: enabled: true`,
Yoke pushes the branch and opens a PR. The **GitHub** button in the workflow header
turns into a link to it.

---

## 7. What just happened

- Yoke created an isolated git worktree under `.worktrees/` so your main checkout was
  untouched.
- It assembled the prompt by interpolating `{{workflow_name}}`, `{{architecture_md}}`,
  and any other variables your template uses (full list:
  [prompts.md](prompts.md)).
- It spawned `claude` with the configured args, captured the stream-json output to
  `.yoke/logs/`, and persisted every event to `.yoke/yoke.db`.
- The state machine moved through `pending → active → ok → complete` (or paused at
  `awaiting_user` if a gate script said so).

If you closed your laptop mid-run, Yoke would resume the in-flight item on the next
`yoke start`. State is durable.

---

## Next steps

- **[Configuration reference](configuration.md)** — every key in the template,
  explained.
- **[Templates guide](templates.md)** — pick the right pipeline shape for your job.
- **[Prompts guide](prompts.md)** — what variables you can reference and how.
- **Recipes** — copy-pasteable end-to-end examples:
  - [One-shot](recipes/one-shot.md)
  - [Plan + build + review](recipes/plan-build-review.md)
  - [Parallel features with dependencies](recipes/parallel-features-with-deps.md)
  - [Marketing pipeline](recipes/marketing-pipeline.md)
  - [Creative writing](recipes/creative-writing.md)
  - [Multi-reviewer](recipes/multi-reviewer.md)
- **[Troubleshooting](troubleshooting.md)** and **[FAQ](faq.md)** when something goes
  sideways.
