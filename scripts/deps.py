#!/usr/bin/env python3
"""Print the transitive dependency closure for a feature in topological order."""
import json, sys

def main():
    if len(sys.argv) < 2:
        print("Usage: deps.py <feature-id> [features-json-path]")
        sys.exit(1)

    feat_id = sys.argv[1]
    path = sys.argv[2] if len(sys.argv) > 2 else "docs/idea/yoke-features.json"

    try:
        data = json.load(open(path))
    except FileNotFoundError:
        print(f"Features file not found: {path}")
        sys.exit(1)

    by_id = {f["id"]: f for f in data["features"]}

    if feat_id not in by_id:
        print(f"Unknown feature: {feat_id}")
        print(f"Known features: {', '.join(by_id)}")
        sys.exit(1)

    visited = set()
    order = []

    def visit(fid):
        if fid in visited:
            return
        if fid not in by_id:
            print(f"  [missing dep: {fid}]")
            return
        visited.add(fid)
        for dep in by_id[fid].get("depends_on", []):
            visit(dep)
        order.append(fid)

    visit(feat_id)

    print(f"Dependency closure for {feat_id} ({len(order)} feature(s) in build order):\n")
    for i, fid in enumerate(order):
        f = by_id[fid]
        deps = f.get("depends_on", [])
        dep_str = f"  ← {', '.join(deps)}" if deps else ""
        print(f"  {i+1:2}. {fid}  [{f['category']}]{dep_str}")

if __name__ == "__main__":
    main()
