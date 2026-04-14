#!/usr/bin/env python3
"""
Post-planner gate: validates docs/idea/dashboard-features.json.

Exit 0  → file exists, valid JSON, passes structural schema, needs_more_planning is false.
Exit 1  → file missing, invalid JSON, or fails required structure.
Exit 2  → file is valid but planner set needs_more_planning: true (more planning needed).

On any non-zero exit the .yoke.yml action grammar loops back to the planner phase.
"""
import json
import os
import sys

FEATURES_PATH = "docs/idea/dashboard-features.json"
REQUIRED_FEATURE_FIELDS = {"id", "description", "acceptance_criteria", "review_criteria", "depends_on"}

# --- existence check ---
if not os.path.exists(FEATURES_PATH):
    print(
        f"ERROR: {FEATURES_PATH} was not written by the planner session.\n"
        "The planner prompt requires writing this file before stopping.",
        file=sys.stderr,
    )
    sys.exit(1)

# --- JSON parse ---
try:
    with open(FEATURES_PATH, encoding="utf-8") as f:
        data = json.load(f)
except json.JSONDecodeError as exc:
    print(f"ERROR: {FEATURES_PATH} is not valid JSON: {exc}", file=sys.stderr)
    sys.exit(1)

# --- needs_more_planning flag ---
if data.get("needs_more_planning") is True:
    print(
        f"INFO: {FEATURES_PATH} has needs_more_planning:true — routing back to planner.",
        file=sys.stderr,
    )
    sys.exit(2)

# --- structural validation ---
errors = []

if not isinstance(data.get("project"), str) or not data["project"].strip():
    errors.append('missing or empty "project" string')

if not isinstance(data.get("created"), str) or not data["created"].strip():
    errors.append('missing or empty "created" string')

features = data.get("features")
if not isinstance(features, list) or len(features) == 0:
    errors.append('"features" must be a non-empty array')
else:
    for i, feat in enumerate(features):
        if not isinstance(feat, dict):
            errors.append(f"features[{i}] is not an object")
            continue
        missing = REQUIRED_FEATURE_FIELDS - feat.keys()
        if missing:
            feat_id = feat.get("id", f"index {i}")
            errors.append(f'feature "{feat_id}" missing required fields: {sorted(missing)}')
        for list_field in ("acceptance_criteria", "review_criteria", "depends_on"):
            val = feat.get(list_field)
            if val is not None and not isinstance(val, list):
                feat_id = feat.get("id", f"index {i}")
                errors.append(f'feature "{feat_id}" field "{list_field}" must be an array')

if errors:
    print(f"ERROR: {FEATURES_PATH} failed structural validation:", file=sys.stderr)
    for err in errors:
        print(f"  • {err}", file=sys.stderr)
    sys.exit(1)

print(f"OK: {FEATURES_PATH} is valid ({len(features)} feature(s)).")
sys.exit(0)
