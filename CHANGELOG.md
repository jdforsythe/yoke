# Changelog

All notable changes to Yoke will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-05-03

First public release.

### Added

- Template-driven workflow engine — multiple `.yoke/templates/*.yml` per
  project, each describing a reusable pipeline shape (phases, stages, gates).
- Phase types: `run: once` (single execution), `run: per_item` (fan-out over a
  manifest), with `depends_on` for dependency graphs between items.
- Default starter templates: brainstorm, plan-build, plan-build-review, and
  cleanup workflows.
- Live dashboard (React + Vite) with:
  - Multi-template picker grid for starting new workflow instances.
  - Workflow list view with `dependsOn` and per-item description surfaced.
  - Live stream-json log view with system messages and rendered prompts.
  - Item timeline expansion (per-item phase history).
  - n8n-style graph canvas (xyflow + elkjs) showing the workflow shape.
  - Stage filter chips and search across stages and timeline rows.
  - Pre / post action stdout / stderr tails in the right pane.
- REST + WebSocket API on `127.0.0.1:7777` for the dashboard and external tools.
- SQLite-backed durability with crash recovery for in-flight workflow
  instances.
- `pre` and `post` action grammar for phase-level gates (tests, linters,
  custom scripts).
- Per-item isolated git worktrees so parallel items don't collide.
- `keep_awake: true` opt-in (uses `caffeinate` on macOS, `systemd-inhibit` on
  Linux) to prevent sleep during long runs.
- `yoke init` to scaffold a starter `.yoke/templates/default.yml`.
- `yoke setup` skill for guided project initialization with Claude.
- JSON Schemas for the config, features manifest, handoff, review, and API
  responses.
- Playwright end-to-end test suite covering dashboard flows.

### Known limitations

- **Single-user only.** The API binds to `127.0.0.1` with no authentication.
  Do not expose it to a network. See [`SECURITY.md`](SECURITY.md).
- **macOS and Linux only.** Windows is not supported. `keep_awake` requires
  `caffeinate` (macOS) or `systemd-inhibit` (Linux).
- **Requires Claude Code CLI.** The default templates spawn `claude`. Yoke is
  command-agnostic, but the shipped templates assume the Claude Code CLI is
  installed and authenticated on your `$PATH`.
- **Node 20+ required.**
- **`--dangerously-skip-permissions` is the default** in shipped templates so
  workflows can run unattended. Read [`SECURITY.md`](SECURITY.md) before
  pointing Yoke at code you don't trust.

[Unreleased]: https://github.com/jdforsythe/yoke/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jdforsythe/yoke/releases/tag/v0.1.0
