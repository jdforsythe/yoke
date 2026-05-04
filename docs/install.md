# Installing Yoke

Three install paths: the **npm** path is the recommended one once v0.1.0 is published;
the **manual** path uses a tarball; the **dev** path is for hacking on Yoke itself.

---

## System requirements

| | Required | Notes |
|---|---|---|
| Node.js | 20.x or newer | Yoke uses native ES modules and `node:test`-era APIs. Node 18 may run but is unsupported. |
| git | 2.20 or newer | For `git worktree add`, used to isolate every workflow run. |
| sqlite3 | bundled | Yoke uses `better-sqlite3`, which ships its own native binary. |
| Claude Code CLI | latest | Yoke spawns `claude` per phase. Install per Anthropic's docs and verify with `claude --version`. |
| ANTHROPIC API access | yes | Either an `ANTHROPIC_API_KEY` env var or a Claude Pro / Max subscription that the `claude` binary uses. Yoke ships **no** keys and makes no API calls itself. |

### Platform notes

- **macOS** — fully supported. `keep_awake: true` uses `caffeinate -i`.
- **Linux** — fully supported. `keep_awake: true` uses `systemd-inhibit`.
- **Windows** — not officially supported in v0.1.0. WSL2 should work; native PowerShell
  is untested. The `keep_awake` option is a no-op on Windows. (See [§14 of the
  pre-release todos](pre-public-release-todos.md) for the deferred-work list.)

---

## Path A — npm (recommended, when available)

```sh
npm install -g yoke
yoke --version
```

> **Note:** The npm package is being prepared for v0.1.0. Until it lands, use Path B
> (manual tarball from a release) or Path C (dev install). See the changelog for the
> first release that publishes to npm.

---

## Path B — Manual tarball

Download `yoke-<version>.tgz` from the [GitHub releases page](https://github.com/jdforsythe/yoke/releases),
then:

```sh
npm install -g ./yoke-<version>.tgz
yoke --version
```

> **Note:** Releases will start at v0.1.0. No tagged release exists yet.

---

## Path C — Dev install (current default)

This is the path you'll use until the published npm package lands, and the path Yoke
contributors use day-to-day.

```sh
git clone https://github.com/jdforsythe/yoke.git
cd yoke
pnpm install
```

You now have two ways to run:

```sh
# Production-style: API server only at :7777, run from any directory
./bin/yoke start --config-dir /path/to/your/project

# Dev-style: API at :7777 + dashboard at :5173, runs both with auto-reload
./bin/yoke-dev start --config-dir /path/to/your/project
```

`bin/yoke` is a thin shell wrapper that invokes `tsx` against `src/cli/index.ts` —
fine for development. Once the v0.1.0 build pipeline lands, the published package
will ship a compiled JS bin instead.

If you'd like the CLI on your `$PATH`:

```sh
npm link              # from inside the cloned repo
yoke --version
```

`npm link` puts a `yoke` shim in your global bin directory pointing back at the
checkout. Useful if you're modifying Yoke and want changes reflected immediately.

---

## Configuring Claude

Yoke calls `claude` as a subprocess. It uses whatever credentials Claude itself uses
— there is no separate Yoke-side login.

**Check first**:

```sh
claude --version
claude -p --output-format stream-json --verbose "say hi"
```

If those work, Yoke will work. If they don't:

- Install Claude Code: see Anthropic's official install instructions.
- Set `ANTHROPIC_API_KEY` if you're using API-key auth.
- Run `claude` once interactively to complete OAuth if you're on Pro/Max.

The default `args` in scaffolded templates use `--dangerously-skip-permissions` so
the agent can run tool calls without per-call approval. Yoke only does this inside
isolated git worktrees — your main checkout is never modified — but it's still your
call. You can remove the flag from any template if you'd rather approve each tool
call interactively (the trade-off is the run can no longer be unattended).

---

## Verify with `yoke doctor`

Once you have a `yoke` binary on your path and a project directory with a
`.yoke/templates/<name>.yml` file:

```sh
cd /path/to/your/project
yoke doctor
```

`yoke doctor` checks:

- Node and git versions.
- SQLite is loadable.
- Every template under `.yoke/templates/` parses against `schemas/yoke-config.schema.json`.
- Every `prompt_template` referenced exists on disk.
- Every script referenced from `pre:` / `post:` actions is found.

Non-zero exit means something's wrong; the message will say what.

---

## Where Yoke writes things

| Path | Contents |
|---|---|
| `.yoke/templates/*.yml` | Your templates (committed to git) |
| `.yoke/yoke.db` | SQLite database for workflow state. Don't commit. |
| `.yoke/logs/*.jsonl` | Per-session stream-json captures. Don't commit. |
| `.yoke/server.json` | Runtime discovery file for `yoke status`/`cancel`. Removed on clean shutdown. |
| `.worktrees/<workflow>/` | Isolated git worktrees (one per workflow). Don't commit. |

Add the following to `.gitignore`:

```
.yoke/yoke.db
.yoke/yoke.db-*
.yoke/logs/
.yoke/server.json
.worktrees/
```

`.yoke/templates/` and your `prompts/` and `scripts/` directories are the
user-authored surface and **should** be committed.

---

## Next

- [Getting started](getting-started.md) — five-minute first workflow.
- [Configuration reference](configuration.md).
- [Troubleshooting](troubleshooting.md) when an install dies on a corner case.
