# Security Policy

## Threat model

Yoke is designed for **single-user, local-only** operation. Specifically:

- The API server binds to `127.0.0.1` only. It is not exposed on a network
  interface and has no authentication.
- Yoke spawns Claude Code (or any configured `command`) with
  `--dangerously-skip-permissions` by default in the shipped templates. This
  means agent runs can read, write, and execute anything the user running Yoke
  can.
- Each workflow item runs in an isolated git worktree under the project. The
  worktree is the unit of isolation — it is **not** a sandbox or a container.

If you want a hardened multi-tenant deployment, Yoke is not the right tool.

## In-scope vulnerabilities

We treat the following as security issues and will prioritize fixes:

- **Worktree escape** — an agent run, via the configured workflow, that can
  modify files outside its assigned worktree by exploiting Yoke's path handling
  (e.g. via crafted artifact paths, log paths, manifest entries, or template
  fields).
- **Log / stream injection** — input from agent stdout / stream-json that, when
  rendered in the dashboard, escapes containment (XSS in the React UI,
  WebSocket frame smuggling, control-character injection into terminals).
- **GitHub token mishandling** — leaks of `GITHUB_TOKEN` or other secrets into
  logs, the dashboard, persisted SQLite rows, or worktree files. Tokens read
  from the environment should never appear in artifacts or rendered output.
- **Arbitrary command execution via config** — a hand-crafted
  `.yoke/templates/*.yml`, `features.json`, or `pre`/`post` action that breaks
  out of the documented action grammar (e.g. shell injection via unquoted
  variable expansion in our action runner).
- **State corruption via unauthenticated WebSocket / REST input** — malformed
  client frames or REST bodies that can corrupt persisted state, crash the
  server in a way that loses work, or write to paths the user did not intend.

## Out of scope

These are explicit non-goals and **not** vulnerabilities:

- Multi-user authentication or authorization. Yoke has none and is not intended
  to be exposed to other users.
- Hardened sandboxing of the agent process. Yoke deliberately runs the agent
  with broad permissions inside a worktree; the trust boundary is the user's
  laptop, not the worktree.
- Network exposure. Binding to `0.0.0.0`, reverse proxies, or putting the
  dashboard on the public internet is not a supported configuration. Issues
  that require this setup will be closed.
- Denial of service against the local API by the local user (the user can
  always `Ctrl-C` Yoke).
- Supply-chain risk in transitively installed dependencies — please report
  these upstream to the relevant package.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security problems.

Use one of:

1. **GitHub Security Advisory** — preferred. From the repository, go to
   **Security → Advisories → Report a vulnerability**. This creates a private
   discussion thread.
2. **Email** — `jdforsythe@gmail.com`. Put `[yoke-security]` in the subject
   line.

Please include:

- Yoke version (`yoke --version`).
- A clear description of the issue and its impact.
- Reproduction steps or a proof-of-concept.
- Any suggested fix or mitigation.

You should expect an initial acknowledgement within a week. Yoke is a
single-maintainer project; please be patient with response times. Once a fix is
ready and released, the advisory will be published and credit will be given
unless you request otherwise.
