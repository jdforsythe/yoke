# Contributing to Yoke

Thanks for your interest in Yoke. This is currently a single-maintainer project,
so please read this guide before sending a large change — it will save us both
time.

## Status & scope of contributions

Yoke is in early public release. The maintainer (@jdforsythe) is happy to accept:

- **Bug fixes** — small, focused PRs with a test that demonstrates the bug.
- **Recipes** — new entries under `docs/recipes/` showing real workflows.
- **Templates** — additions to `templates-pack/` that unlock a new use case.
- **Documentation** — clearer wording, fixed typos, missing examples.
- **Cross-platform fixes** — anything that makes Yoke work better on a platform
  the maintainer doesn't use daily.

Please **open an issue first** before starting work on:

- **Architecture changes** — anything that touches the state machine, the
  process supervisor, the executor abstraction, or the WebSocket protocol.
- **New executor types** — Yoke currently shells out to a configured `command`.
  A plugin system / pluggable executors is out of scope for v0.1.x.
- **New CLI commands or top-level config keys** — these are part of the public
  surface and need design discussion first.
- **Dependency additions** — Yoke aims for a small dependency footprint.

## Local development

Requirements:

- Node.js 20+
- pnpm 9+
- git
- macOS or Linux (Windows is not currently supported)
- Claude Code CLI (`claude`) on your `$PATH` if you want to run end-to-end

Setup:

```sh
git clone https://github.com/jdforsythe/yoke.git
cd yoke
pnpm install
```

Common commands:

```sh
pnpm test          # unit + integration tests (vitest)
pnpm typecheck     # tsc on the server + the web package
pnpm test:coverage # tests with coverage report
pnpm build         # tsc build of the server
```

### Running the dual-server dev flow

`bin/yoke-dev` runs the API server and the Vite dev server side by side so you
can iterate on either the backend or the dashboard with hot reload:

```sh
bin/yoke-dev
```

The dashboard will be on Vite's port (printed in the banner) and will proxy
WebSocket + REST traffic to the API server.

For a single-process flow that mirrors what end users get, run `bin/yoke start`
from a directory that has `.yoke/templates/<name>.yml`.

### End-to-end tests

The dashboard has Playwright tests that boot a real backend:

```sh
pnpm --filter web test:e2e
```

These can be slow on first run because Playwright downloads browsers. They are
run in CI on every PR (see `.github/workflows/e2e.yml`).

## Commit & branch conventions

Commit messages follow Conventional Commits-ish prefixes used in the existing
log — examples:

```
feat(dashboard): surface dependsOn + description in list view
fix(web): two real-backend Playwright failures surfaced by new CI
docs(future-work): mark completed items + add cleanup testing gaps
test(api): cover hydrateGraph branches to restore coverage gate
chore(t-10): append handoff.json entry
refactor(server): retire /sessions endpoint
```

Use `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `merge`. Scope is
optional but encouraged. Keep the subject under 72 characters.

Branch names tend to be either topic-named (`graph-view`, `auto-forge`) or
prefixed (`yoke-templates/<topic>`, `claude/<topic>` for agent-driven branches).
There is no strict rule — pick something descriptive.

## Filing issues

Use the appropriate template under
[`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/):

- **Bug report** — for things that are broken.
- **Feature request** — for things that are missing.
- **Question** — for "how do I…" — but please check `docs/faq.md` and
  `docs/troubleshooting.md` first.

Security-sensitive issues should follow [`SECURITY.md`](SECURITY.md), not the
public issue tracker.

## Pull requests

1. Fork and branch from `master`.
2. Make your change. Add or update tests.
3. Run `pnpm test`, `pnpm typecheck`, and (if the dashboard changed)
   `pnpm --filter web test:e2e`.
4. Open a PR against `master`. Fill out the PR template.
5. CI must be green before review.
6. The maintainer will review when time allows. Small PRs land faster.

By contributing, you agree that your contributions will be licensed under the
MIT License (see [`LICENSE`](LICENSE)).
