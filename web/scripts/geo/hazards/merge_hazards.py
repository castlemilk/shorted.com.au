#!/usr/bin/env python3
"""Merge per-state hazard shares into the single artifact `-mode hazards` loads.

    python3 merge_hazards.py --wofs-dir out/wofs --vector-dir out/vector \
        --out web/public/geo/insights/suburb-hazards.json

Output, keyed by sal_code, sorted:

  {
    "sampledCellCount": 1234,            # WOfS valid cells (quality-gate provenance)
    "waterObservedSharePct": 3.2 | null,
    "permanentWaterSharePct": 0.4 | null,
    "floodPlanningSharePct": 12.5 | null, # null = no statutory source for the state
    "bushfireProneSharePct": 40.1 | null
  }

Refuses a partial WOfS state set: a suburb missing from the national raster
pass would otherwise be indistinguishable from one the raster never covered.
Vector layers are per-state by nature — a state without a source simply
contributes null — but a state that HAS a source directory must be complete.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

STATES = ["ACT", "NT", "TAS", "SA", "WA", "VIC", "QLD", "NSW"]
VECTOR_LAYERS = {
    "flood": "floodPlanningSharePct",
    "bushfire": "bushfireProneSharePct",
}


def merge(wofs_dir: Path, vector_dir: Path) -> dict:
    merged: dict[str, dict] = {}
    seen: dict[str, str] = {}
    missing = []
    for st in STATES:
        p = wofs_dir / f"{st}.json"
        if not p.exists():
            missing.append(st)
            continue
        for sal, row in json.loads(p.read_text()).items():
            if sal in merged:
                print(f"COLLISION: SAL{sal} in {seen[sal]} and {st}", file=sys.stderr)
                sys.exit(1)
            merged[sal] = {
                "sampledCellCount": row["sampledCellCount"],
                "waterObservedSharePct": row["waterObservedSharePct"],
                "permanentWaterSharePct": row["permanentWaterSharePct"],
                "floodPlanningSharePct": None,
                "bushfireProneSharePct": None,
            }
            seen[sal] = st
    if missing:
        print(f"REFUSING: missing WOfS states {missing}", file=sys.stderr)
        sys.exit(1)
    for path in sorted(vector_dir.glob("*.json")):
        state_key, layer = path.stem.split("-", 1)  # e.g. nsw-flood
        field = VECTOR_LAYERS.get(layer)
        if field is None:
            print(f"REFUSING: unknown vector layer file {path.name}", file=sys.stderr)
            sys.exit(1)
        for sal, share in json.loads(path.read_text()).items():
            if sal not in merged:
                print(f"REFUSING: {path.name} has SAL {sal} absent from the WOfS pass", file=sys.stderr)
                sys.exit(1)
            if seen[sal] != state_key.upper():
                print(f"REFUSING: {path.name} covers SAL {sal} which belongs to {seen[sal]}", file=sys.stderr)
                sys.exit(1)
            merged[sal][field] = share
    return dict(sorted(merged.items()))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wofs-dir", type=Path, required=True)
    parser.add_argument("--vector-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    merged = merge(args.wofs_dir, args.vector_dir)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(merged, separators=(",", ":")) + "\n")
    water = sum(1 for r in merged.values() if r["waterObservedSharePct"] is not None)
    flood = sum(1 for r in merged.values() if r["floodPlanningSharePct"] is not None)
    fire = sum(1 for r in merged.values() if r["bushfireProneSharePct"] is not None)
    print(f"wrote {args.out}: {len(merged)} suburbs; water {water}, flood {flood}, bushfire {fire}")


if __name__ == "__main__":
    main()
