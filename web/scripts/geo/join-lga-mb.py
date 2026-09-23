#!/usr/bin/env python3
"""Build the suburb -> council bridge from ABS mesh-block allocation files.

Replaces join-lga.mjs, which tested whether each suburb's centroid (computed
from heavily simplified topojson) fell inside a generalised LGA polygon. That
put 220 suburbs (416k residents) in the wrong council -- Broken Hill in
"Unincorporated NSW", Truganina in Melton, Deniliquin in Murray River -- and
left 20 coastal suburbs (Kingsgrove, Malabar ...) with no council at all.

No geometry is needed to do this exactly. ABS builds both SAL_2021 and LGA_2024
from the same 368,286 ASGS 2021 mesh blocks, so a mesh block belongs to exactly
one suburb and exactly one council, and a suburb's council shares are the sum
of its mesh blocks. Weighting (program decision 3):

  persons (Mesh Block Counts 2021, usual residents)
  -> dwellings, when the suburb has no residents at all
  -> area (AREA_ALBERS_SQKM), when it has neither

Inputs (ABS, CC BY 4.0), staged OUTSIDE git -- raw inputs are never committed:
  ASGS Ed.3 allocation files
    https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs/edition-3-july-2021-june-2026/access-and-downloads/allocation-files/SAL_2021_AUST.xlsx
    .../allocation-files/LGA_2024_AUST.xlsx
  Census 2021 Mesh Block Counts
    https://www.abs.gov.au/census/guide-census-data/mesh-block-counts/2021/Mesh%20Block%20Counts%2C%202021.xlsx
  Optional, for council centroids: the generalised LGA_2024 boundary that
  fetch-abs-lga.mjs writes (abs-lga.geojson).

Outputs (committed, deterministic -- keys sorted, fixed rounding):
  suburb-lga.json  {sal: {"lga": code, "share": 0.9731,
                          "overlaps": [{"lga": code, "share": 0.9731}, ...]}}
      `overlaps` lists every council holding >= 1% of the suburb's weight,
      dominant first (share desc, then code asc). It is OMITTED when the
      dominant council is the only one above 1% -- the loader treats a missing
      list as [{"lga": lga, "share": share}] -- which keeps the artifact close
      to its old size for the 14.5k single-council suburbs.
      Shares are NOT renormalised after the 1% cut, so they stay true
      population shares and sum to slightly under 1 for a straddler.
  lga-facts.json   {lga: {"name", "displayName", "state", "stateCode", "kind",
                          "areaSqkm", "dwellings", "centroidLat", "centroidLon"}}

Install once: python3 -m pip install openpyxl
Run from the repository root (about a minute; openpyxl streams 55 MB of xlsx):
  python3 web/scripts/geo/join-lga-mb.py \
    --staging /Volumes/gamma-systems-2/shorted-council/abs \
    --suburbs-dir web/public/geo/suburbs \
    --out-dir web/public/geo/insights
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Iterable, Iterator, Optional

OVERLAP_MIN_SHARE = 0.01
STRADDLE_SHARE = 0.95
SHARE_DP = 4

# ABS STATE_NAME_2021 -> our state code. "Other Territories" (Christmas Island,
# Cocos (Keeling) Islands, Jervis Bay, Norfolk Island) is a real ABS state
# level with real councils, so it gets a code (program decision 4). "Outside
# Australia" is one pseudo-area with no state by definition and keeps ''.
STATE_CODES = {
    "New South Wales": "NSW",
    "Victoria": "VIC",
    "Queensland": "QLD",
    "South Australia": "SA",
    "Western Australia": "WA",
    "Tasmania": "TAS",
    "Northern Territory": "NT",
    "Australian Capital Territory": "ACT",
    "Other Territories": "OT",
}

# ABS disambiguates names that recur across states with a state suffix
# ("Campbelltown (NSW)", "Bayside (Vic.)"). Only these exact suffixes are cut:
# no other parenthetical occurs in an LGA_2024 name.
STATE_SUFFIX_RE = re.compile(r"\s*\((?:NSW|Vic\.|Qld|SA|WA|Tas\.|NT|ACT|OT)\)$")

# Non-geographic ABS codes: <state>9499 "No usual address", <state>9799
# "Migratory - Offshore - Shipping", and ZZZZZ "Outside Australia". Pinned by
# CODE, never by label.
PSEUDO_SUFFIXES = ("9499", "9799")
OUTSIDE_AUSTRALIA = "ZZZZZ"


def classify_kind(code: str, name: str) -> str:
    """council | unincorporated | pseudo -- mirrored by lgaKind in lga.go."""
    if code == OUTSIDE_AUSTRALIA or (len(code) == 5 and code[1:] in PSEUDO_SUFFIXES):
        return "pseudo"
    if name.lower().startswith("unincorp"):
        return "unincorporated"
    return "council"


def display_name(name: str) -> str:
    return STATE_SUFFIX_RE.sub("", name).strip()


# ---------------------------------------------------------------- reading ---


def _rows(path: Path, header_first_cell: str) -> Iterator[tuple]:
    """Yield data rows from every sheet whose header row starts with
    header_first_cell. Mesh Block Counts splits states across 'Table N' and
    'Table N.M' sheets under banner rows, so the header is searched for."""
    import openpyxl  # imported lazily so the pure functions test without it

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        for ws in wb.worksheets:
            header = None
            for row in ws.iter_rows(values_only=True):
                if header is None:
                    if row and row[0] == header_first_cell:
                        header = [str(c).strip() if c is not None else "" for c in row]
                    continue
                if not row or row[0] is None:
                    continue
                yield dict(zip(header, row))
    finally:
        wb.close()


def read_allocation(path: Path, code_col: str, name_col: str) -> dict[str, tuple]:
    """MB_CODE_2021 -> (code, name, state_name, area_sqkm)."""
    out = {}
    for r in _rows(path, "MB_CODE_2021"):
        mb = str(r["MB_CODE_2021"]).strip()
        if not mb.isalnum():
            continue  # copyright footer
        out[mb] = (
            str(r[code_col]).strip(),
            str(r[name_col]).strip(),
            str(r["STATE_NAME_2021"]).strip(),
            float(r.get("AREA_ALBERS_SQKM") or 0.0),
        )
    return out


def read_mb_counts(path: Path) -> dict[str, tuple[int, int]]:
    """MB_CODE_2021 -> (persons, dwellings) from Census 2021 Mesh Block Counts."""
    out = {}
    for r in _rows(path, "MB_CODE_2021"):
        mb = str(r["MB_CODE_2021"]).strip()
        if not mb.isdigit():
            continue  # footer / notes rows
        out[mb] = (int(r.get("Person") or 0), int(r.get("Dwelling") or 0))
    return out


def read_spine(suburbs_dir: Path) -> set[str]:
    """SAL codes the committed suburb boundaries render (the suburb spine)."""
    sals: set[str] = set()
    for f in sorted(suburbs_dir.glob("*.topojson")):
        topo = json.loads(f.read_text())
        obj = topo["objects"][next(iter(topo["objects"]))]
        sals.update(str(g["id"]) for g in obj["geometries"] if g.get("id") is not None)
    return sals


# ---------------------------------------------------------------- the join ---


def weight_basis(persons: float, dwellings: float) -> str:
    if persons > 0:
        return "persons"
    if dwellings > 0:
        return "dwellings"
    return "area"


def suburb_shares(parts: dict[str, list[float]]) -> tuple[str, list[tuple[str, float]]]:
    """parts: lga -> [persons, dwellings, area] summed over the suburb's mesh
    blocks. Returns (basis, [(lga, share)]) over ALL councils, share desc then
    code asc, so the dominant council is first and ties break deterministically."""
    persons = sum(p[0] for p in parts.values())
    dwellings = sum(p[1] for p in parts.values())
    basis = weight_basis(persons, dwellings)
    idx = {"persons": 0, "dwellings": 1, "area": 2}[basis]
    total = sum(p[idx] for p in parts.values())
    if total <= 0:
        # A suburb of zero-area mesh blocks: split evenly rather than divide by 0.
        shares = [(lga, 1.0 / len(parts)) for lga in parts]
    else:
        shares = [(lga, p[idx] / total) for lga, p in parts.items()]
    shares.sort(key=lambda s: (-s[1], s[0]))
    return basis, shares


def bridge_entry(shares: list[tuple[str, float]]) -> dict:
    dominant, dom_share = shares[0]
    kept = [
        {"lga": lga, "share": round(share, SHARE_DP)}
        for lga, share in shares
        if share >= OVERLAP_MIN_SHARE
    ]
    entry = {"lga": dominant, "share": round(dom_share, SHARE_DP)}
    if len(kept) > 1:
        entry["overlaps"] = kept
    return entry


def build_bridge(
    sal_alloc: dict[str, tuple],
    lga_alloc: dict[str, tuple],
    counts: dict[str, tuple[int, int]],
) -> tuple[dict[str, dict], dict[str, str], list[str]]:
    """Returns ({sal: entry}, {sal: basis}, mesh blocks missing an LGA)."""
    parts: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0, 0.0]))
    unallocated = []
    for mb, (sal, _name, _state, area) in sal_alloc.items():
        lga_row = lga_alloc.get(mb)
        if lga_row is None:
            unallocated.append(mb)
            continue
        persons, dwellings = counts.get(mb, (0, 0))
        acc = parts[sal][lga_row[0]]
        acc[0] += persons
        acc[1] += dwellings
        acc[2] += area
    bridge, bases = {}, {}
    for sal, by_lga in parts.items():
        basis, shares = suburb_shares(by_lga)
        bridge[sal] = bridge_entry(shares)
        bases[sal] = basis
    return bridge, bases, sorted(unallocated)


def polygon_centroid(geometry: Optional[dict]) -> Optional[tuple[float, float]]:
    """Area-weighted centroid (lat, lon) of a GeoJSON Polygon/MultiPolygon.
    Longitude is scaled by cos(mean latitude) so the weighting is close to
    equal-area at council scale; holes subtract through the signed area."""
    if not geometry or not geometry.get("coordinates"):
        return None
    polys = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
    lats = [pt[1] for poly in polys for ring in poly for pt in ring]
    if not lats:
        return None
    k = math.cos(math.radians(sum(lats) / len(lats)))
    a_sum = cx_sum = cy_sum = 0.0
    for poly in polys:
        for ring in poly:
            for (x0, y0), (x1, y1) in zip(ring, ring[1:]):
                x0k, x1k = x0 * k, x1 * k
                cross = x0k * y1 - x1k * y0
                a_sum += cross
                cx_sum += (x0k + x1k) * cross
                cy_sum += (y0 + y1) * cross
    if abs(a_sum) < 1e-15:
        return None
    # Outer rings and holes carry opposite winding, so their signed areas net
    # out whatever orientation the source used; only the overall sign flips.
    lon = cx_sum / (3.0 * a_sum) / k
    lat = cy_sum / (3.0 * a_sum)
    return round(lat, 5), round(lon, 5)


def build_facts(
    lga_alloc: dict[str, tuple],
    counts: dict[str, tuple[int, int]],
    centroids: dict[str, tuple[float, float]],
) -> dict[str, dict]:
    agg: dict[str, dict] = {}
    for mb, (code, name, state, area) in lga_alloc.items():
        f = agg.setdefault(code, {"name": name, "state": state, "area": 0.0, "dwellings": 0})
        f["area"] += area
        f["dwellings"] += counts.get(mb, (0, 0))[1]
    facts = {}
    for code, f in agg.items():
        kind = classify_kind(code, f["name"])
        centroid = centroids.get(code)
        # A pseudo-area has no land and no dwellings: absent, never zero.
        geographic = kind != "pseudo"
        facts[code] = {
            "name": f["name"],
            "displayName": display_name(f["name"]),
            "state": f["state"],
            "stateCode": STATE_CODES.get(f["state"], ""),
            "kind": kind,
            "areaSqkm": round(f["area"], 1) if geographic and f["area"] > 0 else None,
            "dwellings": f["dwellings"] if geographic else None,
            "centroidLat": centroid[0] if centroid else None,
            "centroidLon": centroid[1] if centroid else None,
        }
    return facts


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")


def main(argv: Optional[Iterable[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--staging", required=True, type=Path)
    ap.add_argument("--suburbs-dir", default=Path("web/public/geo/suburbs"), type=Path)
    ap.add_argument("--out-dir", default=Path("web/public/geo/insights"), type=Path)
    args = ap.parse_args(list(argv) if argv is not None else None)

    st = args.staging
    print("reading SAL_2021 allocation ...", file=sys.stderr)
    sal_alloc = read_allocation(st / "SAL_2021_AUST.xlsx", "SAL_CODE_2021", "SAL_NAME_2021")
    print("reading LGA_2024 allocation ...", file=sys.stderr)
    lga_alloc = read_allocation(st / "LGA_2024_AUST.xlsx", "LGA_CODE_2024", "LGA_NAME_2024")
    print("reading Mesh Block Counts 2021 ...", file=sys.stderr)
    counts = read_mb_counts(st / "Mesh Block Counts, 2021.xlsx")

    centroids: dict[str, tuple[float, float]] = {}
    geo = st / "abs-lga.geojson"
    if geo.exists():
        for feat in json.loads(geo.read_text())["features"]:
            c = polygon_centroid(feat.get("geometry"))
            if c:
                centroids[str(feat["properties"]["lga_code_2024"])] = c

    bridge, bases, unallocated = build_bridge(sal_alloc, lga_alloc, counts)
    facts = build_facts(lga_alloc, counts, centroids)

    spine = read_spine(args.suburbs_dir)
    out = {}
    pseudo_dropped, not_in_alloc = [], sorted(spine - bridge.keys())
    for sal in sorted(spine & bridge.keys()):
        entry = bridge[sal]
        if facts[entry["lga"]]["kind"] == "pseudo":
            pseudo_dropped.append(sal)  # "No usual address" SALs have no council
            continue
        out[sal] = entry

    write_json(args.out_dir / "suburb-lga.json", out)
    write_json(args.out_dir / "lga-facts.json", facts)

    straddle = sum(1 for e in out.values() if e["share"] < STRADDLE_SHARE)
    basis_counts = defaultdict(int)
    for sal in out:
        basis_counts[bases[sal]] += 1
    print(
        f"mesh blocks: {len(sal_alloc)} SAL-allocated, {len(lga_alloc)} LGA-allocated, "
        f"{len(unallocated)} SAL MBs without an LGA; counts for {len(counts)}\n"
        f"bridge: {len(out)} suburbs (spine {len(spine)}; {len(pseudo_dropped)} pseudo SALs dropped; "
        f"{len(not_in_alloc)} spine SALs absent from the allocation: {not_in_alloc[:10]})\n"
        f"weight basis: {dict(basis_counts)}; straddlers (dominant share < {STRADDLE_SHARE}): {straddle}\n"
        f"councils: {len(facts)} ({sum(1 for f in facts.values() if f['kind'] == 'council')} council, "
        f"{sum(1 for f in facts.values() if f['kind'] == 'unincorporated')} unincorporated, "
        f"{sum(1 for f in facts.values() if f['kind'] == 'pseudo')} pseudo); "
        f"centroids for {sum(1 for f in facts.values() if f['centroidLat'] is not None)}",
        file=sys.stderr,
    )
    return 1 if unallocated else 0


if __name__ == "__main__":
    raise SystemExit(main())
