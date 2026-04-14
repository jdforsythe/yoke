#!/usr/bin/env python3
"""Print all session logs from .yoke/yoke.db, newest first."""
import os, sqlite3, sys

db = os.path.join(os.getcwd(), ".yoke", "yoke.db")
if not os.path.exists(db):
    print(f"No DB at {db}", file=sys.stderr)
    sys.exit(1)

conn = sqlite3.connect(db)
rows = conn.execute(
    "SELECT started_at, stage, phase, status, session_log_path "
    "FROM sessions WHERE session_log_path IS NOT NULL "
    "ORDER BY started_at DESC LIMIT 30"
).fetchall()

if not rows:
    print("No session logs in DB")
    sys.exit(0)

for r in rows:
    ts, stage, phase, status, log = r
    print(f"{ts}  {stage:<35} {phase:<12} {status:<12} {log}")
