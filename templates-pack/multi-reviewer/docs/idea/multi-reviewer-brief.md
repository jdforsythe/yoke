# Multi-Reviewer Workflow Brief

Replace this file with a one-to-three paragraph description of the project or
change you want Yoke to implement and review with three independent reviewer
angles (correctness, security, simplicity).

## What to include

- **Goal**: What the finished work should do or change.
- **Hard constraints**: Things that must be true (tech stack, API contract,
  performance budget, security requirements).
- **Non-goals**: Scope that is explicitly out of bounds for this run.
- **Acceptance criteria** (if you already know them): observable, testable
  outcomes. The planner will derive more from your description, but any you
  list here become anchors the reviewers will check.

## Why three reviewers?

The multi-reviewer template runs three independent Claude Code subagents after
each implement phase:

| Angle | Focus |
|---|---|
| **Correctness** | Every AC/RC has code and test evidence; no logic errors or untested edge cases. |
| **Security** | Input validation, auth boundaries, secret handling, injection risk, least privilege. |
| **Simplicity** | No duplication, over-abstraction, dead code, or YAGNI violations. |

All three must pass before a feature advances. Any single FAIL routes the
feature back to the implementer (up to three revisits). Each reviewer is
independent — they cannot see each other's verdicts.

## Example

> Build a REST API endpoint `POST /api/tokens` that creates a short-lived
> (15-minute) JWT for authenticated users. The endpoint accepts
> `{"username": "...", "password": "..."}`, validates credentials against the
> `users` table, and returns `{"token": "..."}`. The JWT signing key must come
> from the `JWT_SECRET` environment variable — never hard-coded.
>
> All three reviewer angles (correctness, security, simplicity) must pass
> before the feature is considered complete.
>
> **Non-goals**: Refresh tokens, OAuth, or rate limiting are out of scope.

---

*Delete everything above the horizontal rule and replace with your project description.*
