# Installing Yoke

Three install paths: the **npm** path is the recommended one for most users;
the **manual** path uses a tarball from a GitHub release; the **dev** path is for
hacking on Yoke itself.

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
- **Windows** — not officially supported. WSL2 should work; native PowerShell
  is untested. The `keep_awake` option is a no-op on Windows.

---

## Path A — npm (recommended)

```sh
npm install -g @jdforsythe/yoke
yoke --version
```

---

## Path B — Manual tarball

Download `yoke-<version>.tgz` from the [GitHub releases page](https://github.com/jdforsythe/yoke/releases),
then:

```sh
npm install -g ./yoke-<version>.tgz
yoke --version
```

---

## Path C — Dev install

This path is for Yoke contributors hacking on the source tree.

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

`bin/yoke` is a thin shell wrapper that prefers the compiled `dist/cli/index.js`
when present and falls back to running `tsx` against `src/cli/index.ts` for
in-checkout development. The published npm package ships the compiled JS bin.

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
