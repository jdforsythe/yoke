#!/usr/bin/env python3
"""
Post-review gate: reads review-verdict.json from the worktree root.

Exit 0  → verdict is PASS; continue to next stage.
Exit 1  → verdict is FAIL; .yoke.yml action grammar loops back to implement.

The review agent is expected to write review-verdict.json before exiting.
If the file is absent or malformed, the gate fails (exit 1) so a re-implement
fires rather than silently promoting broken work.
"""
import json
import os
import sys

VERDICT_PATH = "review-verdict.json"

if not os.path.exists(VERDICT_PATH):
    print(
        f"ERROR: {VERDICT_PATH} was not written by the review session.\n"
        "The review prompt requires writing this file with "
        '{"verdict": "PASS"} or {"verdict": "FAIL", "blocking_issues": [...]}.',
        file=sys.stderr,
    )
    sys.exit(1)

try:
    with open(VERDICT_PATH, encoding="utf-8") as f:
        data = json.load(f)
except json.JSONDecodeError as exc:
    print(f"ERROR: {VERDICT_PATH} is not valid JSON: {exc}", file=sys.stderr)
    sys.exit(1)

verdict = data.get("verdict", "")

if verdict == "PASS":
    print(f"Review verdict: PASS — feature complete.")
    sys.exit(0)

issues = data.get("blocking_issues", [])
print(f"Review verdict: {verdict or 'FAIL'} — {len(issues)} blocking issue(s):", file=sys.stderr)
for issue in issues:
    print(f"  • {issue}", file=sys.stderr)
sys.exit(1)
