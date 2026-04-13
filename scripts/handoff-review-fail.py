#!/usr/bin/env python3
"""
handoff-review-fail.py — append a review_failure entry to handoff.json.

Reads the most recent review session log, parses blocking issues and non-blocking
observations from the result field, and appends a structured entry to
handoff.json entries[].  The entry lands in {{handoff_entries}} on the next
./yoke-v0 run implement invocation so the re-implementer sees the failure
context without any shared session state.

Usage:
    python3 scripts/handoff-review-fail.py [feature-id]

    feature-id  Optional. If omitted, uses FEATURE env var; if that is also
                unset, infers from the most-recent review log filename.

Exit codes:
    0  entry appended (or verdict was PASS, nothing to do)
    1  error (no log found, no result field, parse failure, etc.)
"""

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

LOG_DIR = Path(".yoke/logs")
HANDOFF_PATH = Path("handoff.json")


# ── Log selection ─────────────────────────────────────────────────────────────

def find_log(feature: str) -> Path:
    pattern = f"*review*{feature}*.jsonl" if feature else "*review*.jsonl"
    logs = sorted(LOG_DIR.glob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
    if not logs:
        sys.exit(f"No review logs found matching '{pattern}' in {LOG_DIR}")
    return logs[0]


# ── Result text extraction ────────────────────────────────────────────────────

def read_result(log_path: Path) -> str:
    with open(log_path) as f:
        lines = [l.strip() for l in f if l.strip()]
    if not lines:
        sys.exit(f"Log is empty: {log_path}")
    obj = json.loads(lines[-1])
    result = obj.get("result", "")
    if not result:
        sys.exit("Last log entry has no 'result' field — session may not have completed cleanly.")
    return result


# ── Section parsing ───────────────────────────────────────────────────────────

def _extract_section(text: str, header_re: str) -> str:
    """Return the body of the first section whose ### heading matches header_re."""
    m = re.search(
        r"###\s+" + header_re + r"\s*\n(.*?)(?=\n---|\n###|\Z)",
        text,
        re.DOTALL | re.IGNORECASE,
    )
    return m.group(1).strip() if m else ""


def _parse_numbered(section: str) -> list[str]:
    """Collect multi-line numbered items (1. ..., 2. ...) into strings."""
    items: list[str] = []
    current: list[str] = []
    for line in section.splitlines():
        stripped = re.sub(r"^\*+|\*+$", "", line)  # strip leading/trailing bold markers
        if re.match(r"^\d+\.\s", stripped):
            line = stripped
            if current:
                items.append(" ".join(current).strip())
            current = [re.sub(r"^\d+\.\s*", "", line)]
        elif current and line.strip():
            current.append(line.strip())
    if current:
        items.append(" ".join(current).strip())
    return [i for i in items if i and i.lower().strip(". ") != "none"]


def _parse_bulleted(section: str) -> list[str]:
    """Collect multi-line bullet items (- ...) into strings."""
    items: list[str] = []
    current: list[str] = []
    for line in section.splitlines():
        if re.match(r"^-\s", line):
            if current:
                items.append(" ".join(current).strip())
            current = [re.sub(r"^-\s*", "", line)]
        elif current and line.strip():
            current.append(line.strip())
    if current:
        items.append(" ".join(current).strip())
    return [i for i in items if i]


def parse_review(result_text: str) -> tuple[bool, list[str], list[str]]:
    """
    Returns (is_fail, blocking_issues, non_blocking_observations).

    is_fail is True when any criterion is FAIL or a non-empty Blocking Issues
    section is present.
    """
    fail_count = len(re.findall(r"\bFAIL\b", result_text))
    blocking_section = _extract_section(result_text, r"Blocking\s+Issues")
    blocking = _parse_numbered(blocking_section)

    nonblocking_section = _extract_section(result_text, r"Non.Blocking\s+Observations?")
    non_blocking = _parse_bulleted(nonblocking_section)

    is_fail = fail_count > 0 or len(blocking) > 0
    return is_fail, blocking, non_blocking


# ── Feature id inference ──────────────────────────────────────────────────────

def infer_feature(log_path: Path) -> str:
    # e.g. 20260413T034624Z-review-feat-pipeline-engine.jsonl
    m = re.search(r"review-(.+)\.jsonl$", log_path.name)
    return m.group(1) if m else "unknown"


# ── handoff.json update ───────────────────────────────────────────────────────

def append_entry(blocking: list[str], non_blocking: list[str], feature: str) -> None:
    if not HANDOFF_PATH.exists():
        sys.exit(f"{HANDOFF_PATH} not found — run from the repo root.")

    with open(HANDOFF_PATH) as f:
        handoff = json.load(f)

    # Attempt = number of prior review entries for this feature
    existing_review = [e for e in handoff.get("entries", []) if e.get("phase") == "review"]
    attempt = len(existing_review)

    entry: dict = {
        "phase": "review",
        "attempt": attempt,
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "verdict": "FAIL",
        "blocking_issues": blocking,
    }
    if non_blocking:
        entry["non_blocking"] = non_blocking

    handoff.setdefault("entries", []).append(entry)

    with open(HANDOFF_PATH, "w") as f:
        json.dump(handoff, f, indent=2)
        f.write("\n")


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    feature = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("FEATURE", "")

    log_path = find_log(feature)
    print(f"Log     : {log_path}")

    result_text = read_result(log_path)
    is_fail, blocking, non_blocking = parse_review(result_text)

    if not is_fail:
        print("Verdict : PASS — nothing to append to handoff.json.")
        return

    if not blocking:
        print("Verdict : FAIL but no Blocking Issues section found.")
        print("          Check the review output manually and add to handoff.json by hand.")
        print(f"          Run:  make last-output PHASE=review FEATURE={feature or '<id>'}")
        sys.exit(1)

    if not feature:
        feature = infer_feature(log_path)

    append_entry(blocking, non_blocking, feature)

    existing_review = [
        e for e in json.load(open(HANDOFF_PATH)).get("entries", [])
        if e.get("phase") == "review"
    ]
    attempt = len(existing_review) - 1  # the one we just wrote

    print(f"Feature : {feature}")
    print(f"Verdict : FAIL (attempt {attempt})")
    print(f"Blocking: {len(blocking)} issue(s)")
    for i, b in enumerate(blocking, 1):
        preview = b[:120] + "..." if len(b) > 120 else b
        print(f"  [{i}] {preview}")
    if non_blocking:
        print(f"Non-blocking: {len(non_blocking)} observation(s)")
    print(f"\nAppended to {HANDOFF_PATH}.")
    print(f"Next:  make run-implement FEATURE={feature}")


if __name__ == "__main__":
    main()
