# Yoke — Claude collaboration notes

## Branching & PRs

- **Never commit or push directly to `master`.** All changes ship via PR.
- Default workflow: branch off `master`, commit, push the branch, open a PR.
- Don't merge PRs autonomously — leave that to the user (or the user-triggered merge tooling).

## Release flow (release-drafter)

The repo uses [release-drafter] to maintain a single draft GitHub Release that
accumulates merged PRs. Publishing the draft creates the `v*.*.*` tag, which
fires `release.yml` (npm publish + Release update).

[release-drafter]: https://github.com/release-drafter/release-drafter

**Version bump is computed from PR labels.** Every PR opened by Claude must
carry exactly one version-bump label so the draft resolves a sensible next
version. Default is `patch` if no label is set, but be explicit.

### Label cheat sheet

Pick the highest-precedence label that applies. Major > minor > patch.

| Bump  | Labels (any one)                                          | Use when                                           |
| ----- | --------------------------------------------------------- | -------------------------------------------------- |
| major | `breaking`, `major`                                       | API/CLI/config break, removed feature, schema break |
| minor | `feature`, `enhancement`, `minor`                         | New user-visible capability, additive API change   |
| patch | `fix`, `bug`, `patch`, `chore`, `ci`, `docs`, `documentation`, `dependencies` | Bug fix, refactor, infra, docs, dep bumps |

Special labels:

- `skip-changelog` / `no-release` — exclude the PR from release notes entirely
  (use for trivial PRs like "fix a typo in CLAUDE.md").

### When opening a PR

After `gh pr create`, attach the appropriate label:

```bash
gh pr edit <number> --add-label <label>
```

Or pass it at creation time:

```bash
gh pr create --label feature --title "..." --body "..."
```

If unsure which label fits, default to the conservative side (`patch` over
`minor`, `minor` over `major`) and call out the choice in the PR body so the
user can override.

### Categories in the draft

The draft groups PRs into sections by label. Section title comes from the
**first** matching category in `.github/release-drafter.yml`:

1. Breaking Changes — `breaking`, `major`
2. Features — `feature`, `enhancement`, `minor`
3. Bug Fixes — `fix`, `bug`
4. Maintenance — `chore`, `ci`, `dependencies`
5. Documentation — `docs`, `documentation`

A PR with both `feature` and `chore` lands under Features (first match wins).
