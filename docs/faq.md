# FAQ

Honest answers. If your question isn't here, see [troubleshooting.md](troubleshooting.md)
or open an issue.

---

### Do I have to use Claude?

Today, effectively yes. Yoke spawns whatever you put in `phases.<name>.command`,
but the runtime parses the **stream-json** output format Claude Code produces.
Other agent CLIs that emit a compatible stream would work; today none of them do
out of the box. Adapter work is on the future-work list, not in v0.1.0.

If you have a CLI that produces a different streaming format, you can wrap it in
a shim that translates to stream-json — but that's user-territory engineering,
not a documented integration point.

---

### Does Yoke run my code?

Indirectly, yes. The agent runs whatever tool calls it decides to (Bash, Read,
Edit, WebFetch, …). Your `pre:` and `post:` commands also run as subprocesses.
Yoke doesn't compile or interpret your project's code itself — it just spawns
the agent and your gates.

Two safety layers worth knowing:

1. Every workflow runs in an isolated git worktree. Your main checkout is never
   modified.
2. The default `args` include `--dangerously-skip-permissions`, which lets the
   agent run tool calls without per-call confirmation. Drop the flag from your
   templates if you want to approve each tool use; the trade-off is the workflow
   can no longer run unattended.

---

### Is this safe?

Mostly. Yoke is a single-user, local-only harness — it binds to `127.0.0.1`,
has no auth, no telemetry, and doesn't ship credentials. The agent runs in an
isolated git worktree, so a misbehaving session can't damage your main checkout.

But Yoke runs autonomous code-writing sessions on your machine, and the agent
can do anything you can do (file system, network, shell). The realistic threats
are not "Yoke leaks data to a SaaS" but "the agent runs an `rm -rf` it
shouldn't" or "the agent leaks a secret it found in `.env`."

Mitigations:
- Keep secrets out of worktrees (Yoke does no env-var stripping).
- Review the agent's tool calls in the live stream pane.
- Use `safety_mode: strict` and a hooks template that vetoes dangerous
  operations (the schema field is advisory; the actual hook policy lives in
  your project).
- Don't run Yoke against a repo with a `.env` file you don't want the agent to
  read.

See [SECURITY.md](../SECURITY.md) for the full threat model.

---

### Why local-only? Why no hosted dashboard?

Single-user, local-only is a deliberate scope limit:

- Your code stays on your machine.
- No auth surface to attack.
- No multi-tenant edge cases to design around.
- The dashboard is a tool, not a product.

Hosted, multi-user Yoke is a different product with a different threat model
and a different deployment story. It's explicitly out of scope for v0.1.0.

---

### How do I add my team's CI gates?

`post:` commands. They run after the agent exits cleanly and before the phase
is considered complete:

```yaml
post:
  - name: lint
    run: ["pnpm", "lint"]
    actions: { "0": continue, "*": { retry: { mode: fresh_with_failure_summary, max: 2 } } }
  - name: typecheck
    run: ["pnpm", "typecheck"]
    actions: { "0": continue, "*": { retry: { mode: fresh_with_failure_summary, max: 2 } } }
  - name: test
    run: ["pnpm", "test"]
    timeout_s: 600
    actions: { "0": continue, "*": { retry: { mode: fresh_with_failure_summary, max: 2 } } }
  - name: security-audit
    run: ["./scripts/audit.sh"]
    actions: { "0": continue, "1": { fail: { reason: "security audit failed" } }, "*": continue }
```

The action grammar is rich enough for most real CI matrices. See
[configuration.md](configuration.md#pre--post-commands).

---

### What does it cost?

Yoke itself is free, MIT-licensed, runs on your laptop. The cost is whatever
your Anthropic API or Pro/Max usage runs to. A multi-feature plan-build-review
overnight on a real codebase typically lands in the dollars-to-low-tens range —
varies wildly with model, prompt size, and how many retry loops fire.

The multi-reviewer pattern uses 3–4× the tokens of single-reviewer for the
review phase. Worth it for code humans will maintain; usually not for
prototypes.

---

### Can I run Yoke without internet?

Yoke itself runs offline (it's a local Fastify server + SQLite). The `claude`
binary needs internet to talk to Anthropic. So in practice no, unless you've
got a self-hosted model serving the same stream-json shape.

---

### How do I stop a runaway workflow?

Three options:

- **Dashboard:** click **Cancel** in the workflow header.
- **CLI:** `yoke cancel <workflow-id>`.
- **Nuclear:** `Ctrl-C` the `yoke start` process. All in-flight sessions are
  killed. State is preserved; the workflows resume on the next `yoke start`
  (you can mark them cancelled then).

---

### My workflow keeps looping between implement and review. What gives?

The reviewer is finding something the implementer can't fix. After
`max_revisits: 3` (the default for `goto: implement`), Yoke parks the workflow
in `awaiting_user` so you can intervene. Read the latest verdict and the
handoff entries — if the reviewer is being unreasonable, edit the spec; if the
implementer is missing context, add it to `architecture.md` or
`user_injected_context`.

This is the system working as intended — Yoke surfaces the conflict to you
instead of silently shipping FAIL.

---

### Can I have multiple workflows running in parallel?

Yes. Each workflow gets its own git worktree, its own row in SQLite, its own
session. The scheduler runs them concurrently, respecting per-item
`depends_on` within a workflow. The number of parallel sessions is limited by
your machine and your Anthropic rate limit, not by Yoke.

---

### Can I run Yoke in CI?

You can, but it's not what Yoke is designed for. Yoke is built for
laptop-style "leave it running overnight" workflows. CI typically wants
single-shot, deterministic runs without a UI. If you really want a CI run,
spawn `claude` directly without Yoke and skip the harness — it will be
simpler.

---

### How do I migrate from an older `.yoke.yml` layout?

If you have a root-level `.yoke.yml` from before the templates refactor, move
it to `.yoke/templates/<name>.yml` and rename the top-level `project:` key to
`template:`. Run `yoke doctor` to surface any other schema differences. The
templates layout has been the only supported shape since the refactor.

---

### Does Yoke send any data to Anthropic / GitHub / anyone?

Yoke doesn't, no. The agent (`claude`) sends prompts to Anthropic per its own
configuration. The GitHub integration only fires when `github.enabled: true`
and only does what it advertises (push branch, open PR using your token).
There is no telemetry, no analytics, no phone-home.

---

### Where do I file a bug?

[GitHub issues](https://github.com/jdforsythe/yoke/issues). Include the
template, the prompt, the failing log line from `.yoke/logs/`, and what you
expected. Security issues: see [SECURITY.md](../SECURITY.md).

---

### Where do I find more recipes?

[docs/recipes/](recipes/). Six end-to-end examples cover the common shapes —
one-shot, plan+build+review, parallel-with-deps, marketing pipeline, creative
writing, multi-reviewer. PRs adding more are welcome.
