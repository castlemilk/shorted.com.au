#!/usr/bin/env python3
"""Drawable planning overlays per state, as WGS84 GeoJSON for build-overlays.mjs.

    zoning    one dissolved feature per harmonised family (properties.family),
              overlaps resolved by the same precedence as planning_share.py
              (a SEPP precinct over its LEP), so no ground is painted twice
    heritage  one feature: the union of the state's heritage AREA classes (the
              same classes the share counts; items are never drawn)

A statewide map at 1–48× zoom cannot show parcel-precision zoning, and 70,000
NSW polygons would not ship. Zoning is burnt onto a per-state grid (20–75 m),
sieved, and polygonised per family (see zoning()); heritage — one sparse
feature — is dissolved as vectors. mapshaper then simplifies TOPOLOGICALLY (a
boundary two families share is one arc, simplified once) until each file is
under its byte budget. The per-suburb shares come from planning_share.py at full precision —
this geometry is for DRAWING only.

    $PY planning_overlays.py --state NSW --root $P --suburbs web/public/geo/suburbs/NSW.topojson \
        --out-dir $P/overlays
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import planning_share as ps  # noqa: E402
from zone_families import FAMILIES, family_for  # noqa: E402

DRAW_GRID = 1.0  # 1 m: far below the 20 m simplification, far cheaper than 1 cm
SIMPLIFY_M = 10.0  # heritage only; zoning is simplified topologically by mapshaper
MIN_PART_M2 = 10_000.0  # 1 ha
ZONING_CELL_M = {"NSW": 90.0, "VIC": 80.0, "SA": 80.0, "TAS": 50.0, "ACT": 25.0}
SIEVE_CELLS = 40  # regions under 40 cells merge into their largest neighbour (VIC 80 m: 25.6 ha)


def drop_small_parts(geom, min_area: float):
    from shapely.geometry import MultiPolygon, Polygon

    if geom.is_empty:
        return geom
    parts = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
    kept = []
    for part in parts:
        if part.geom_type != "Polygon" or part.area < min_area:
            continue
        holes = [h for h in part.interiors if Polygon(h).area >= min_area]
        kept.append(Polygon(part.exterior, holes))
    if not kept:
        return MultiPolygon()
    return MultiPolygon(kept) if len(kept) > 1 else kept[0]


def to_wgs84(geom):
    import numpy as np
    import pyproj
    import shapely

    back = pyproj.Transformer.from_crs("EPSG:3577", "EPSG:4326", always_xy=True).transform
    return shapely.transform(geom, lambda xy: np.column_stack(back(xy[:, 0], xy[:, 1])))


def union(geoms):
    import shapely

    if not geoms:
        return None
    return ps.polygonal(shapely.union_all(geoms, grid_size=DRAW_GRID))


def zoning(state: str, root: Path, cell_m: float):
    """Burn every zone polygon onto a cell_m grid in precedence order (a
    higher tier burnt last, so it wins), sieve away regions smaller than
    SIEVE_CELLS by merging them into their largest neighbour, and polygonise
    per family.

    Why a raster: a vector dissolve keeps every parcel-scale sliver, and a
    statewide mosaic of ten families is then tens of thousands of parts and
    arcs — VIC measured 53k arcs / 2.6 MB even at 3% retention, NSW would not
    dissolve at all. The grid is bounded by the zoning's extent, so memory is
    the grid (NSW ~350 MB at 75 m), not the input. This is the drawable layer
    only; the shares come from planning_share.py at full vector precision."""
    import numpy as np
    from rasterio.features import rasterize, shapes, sieve
    from rasterio.transform import from_origin
    from shapely.geometry import MultiPolygon, shape

    cfg = ps.STATES[state]
    polys, keys = [], []
    for layer, tier in cfg["zoning"]:
        def keep(props, layer=layer, tier=tier):
            t = tier if tier is not None else (0 if props.get("EPI_TYPE") == "SEPP" else 1)
            return (t, family_for(layer, props))

        geoms, meta = ps.load(root / "vector" / layer, keep)
        polys.extend(geoms)
        keys.extend(meta)
    bounds = np.array([g.bounds for g in polys])
    minx, miny = bounds[:, 0].min(), bounds[:, 1].min()
    maxx, maxy = bounds[:, 2].max(), bounds[:, 3].max()
    width = int(np.ceil((maxx - minx) / cell_m))
    height = int(np.ceil((maxy - miny) / cell_m))
    transform = from_origin(minx, maxy, cell_m, cell_m)
    print(f"  grid {width} x {height} at {cell_m:g} m", flush=True)
    code = {f: i + 1 for i, f in enumerate(FAMILIES)}  # 0 = unzoned
    grid = np.zeros((height, width), dtype=np.uint8)
    # Lowest precedence first (highest tier number), so SEPP (tier 0) lands last.
    order = sorted(range(len(polys)), key=lambda i: -keys[i][0])
    rasterize(((polys[i], code[keys[i][1]]) for i in order), out=grid, transform=transform, dtype="uint8")
    zoned = grid > 0
    grid = sieve(grid, size=SIEVE_CELLS, mask=zoned)
    parts: dict = defaultdict(list)
    for geom, value in shapes(grid, mask=grid > 0, transform=transform):
        parts[int(value)].append(shape(geom))
    features = []
    for family in FAMILIES:
        found = parts.get(code[family])
        if not found:
            continue
        g = MultiPolygon([p for p in found if p.geom_type == "Polygon"])
        features.append({"type": "Feature", "properties": {"family": family},
                         "geometry": to_wgs84(g).__geo_interface__})
        print(f"  {family}: {len(found)} regions", flush=True)
    return features


def heritage(state: str, root: Path):
    import shapely

    layer = ps.STATES[state]["heritage"]
    if layer not in ps.HAS_HERITAGE_AREAS:
        return []
    geoms, _ = ps.load(root / "vector" / layer,
                       lambda props: (1,) if (ps.heritage_class(layer, props) or (False,))[0] else None)
    g = union([ps.polygonal(shapely.set_precision(x, DRAW_GRID)) for x in geoms])
    if g is None or g.is_empty:
        return []
    # One feature, so simplifying here cannot split a shared boundary. Heritage
    # precincts are small; a lighter hand than zoning keeps them.
    g = drop_small_parts(g.simplify(SIMPLIFY_M, preserve_topology=True), MIN_PART_M2 / 10)
    return [{"type": "Feature", "properties": {"layer": "heritage"}, "geometry": to_wgs84(g).__geo_interface__}]


def main() -> None:
    parser = argparse.ArgumentParser(description="Planning overlay geometry")
    parser.add_argument("--state", required=True, choices=sorted(ps.STATES))
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--layers", default="zoning,heritage")
    parser.add_argument("--cell-m", type=float, default=None, help="zoning grid cell (default per state)")
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    for layer in args.layers.split(","):
        if layer == "zoning" and not ps.STATES[args.state]["zoning"]:
            continue
        features = (zoning(args.state, args.root, args.cell_m or ZONING_CELL_M[args.state])
                    if layer == "zoning" else heritage(args.state, args.root))
        if not features:
            print(f"{args.state}-{layer}: nothing to draw")
            continue
        out = args.out_dir / f"{args.state}-{layer}.geojson"
        out.write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")))
        print(f"wrote {out}: {len(features)} features ({out.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
