#!/usr/bin/env python3
"""
Print the session_log_path of the most recent session from .yoke/yoke.db.

Optional env filters:
  FEATURE=<stage_id>   restrict to a specific feature stage
  PHASE=implement|review  restrict to a specific phase
"""
import os, sqlite3, sys

db = os.path.join(os.getcwd(), ".yoke", "yoke.db")
if not os.path.exists(db):
    print(f"No DB at {db}", file=sys.stderr)
    sys.exit(1)

feature = os.environ.get("FEATURE", "")
phase   = os.environ.get("PHASE", "")

where = "session_log_path IS NOT NULL"
if feature:
    where += f" AND stage = '{feature}'"
if phase:
    where += f" AND phase = '{phase}'"

conn = sqlite3.connect(db)
row = conn.execute(
    f"SELECT session_log_path FROM sessions WHERE {where} ORDER BY started_at DESC LIMIT 1"
).fetchone()

if not row or not row[0]:
    desc = "".join([f" for {feature}" if feature else "", f" phase={phase}" if phase else ""])
    print(f"No session logs found{desc}", file=sys.stderr)
    sys.exit(1)

print(row[0], end="")
