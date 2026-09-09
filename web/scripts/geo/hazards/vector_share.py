#!/usr/bin/env python3
"""Share of each SAL suburb's land inside a statutory hazard overlay.

Inputs are the newline-delimited GeoJSON pages `fetch-layer.mjs` writes (one
directory per layer, with a `.done` marker proving the page set is complete).
For every suburb the overlay polygons that touch it are clipped to the suburb,
unioned (overlays overlap — a floodway inside a flood-planning area must not be
counted twice) and the union's area is divided by the suburb's area, all in GDA2020
Australian Albers (EPSG:3577) so the ratio is a true area share.

A suburb the layer's source does not cover is NOT zero: this script only runs
against suburbs of the state the source covers, and everything else stays null
downstream. A suburb inside the covered state that no polygon touches IS a
genuine 0, and is written as 0.

    python3 vector_share.py --layer-dir vector/nsw-flood --suburbs web/public/geo/suburbs/NSW.topojson \
        --out out/nsw-flood.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def load_layer(layer_dir: Path):
    import geopandas as gpd
    from shapely.geometry import shape
    from shapely.validation import make_valid

    if not (layer_dir / ".done").exists():
        raise SystemExit(f"{layer_dir}: no .done marker — the page set is incomplete; refusing")
    geoms = []
    for page in sorted(layer_dir.glob("page-*.geojsonl")):
        with page.open() as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                feature = json.loads(line)
                geometry = feature.get("geometry")
                if not geometry:
                    continue
                geom = shape(geometry)
                if geom.is_empty:
                    continue
                if not geom.is_valid:
                    geom = make_valid(geom)
                geoms.append(geom)
    if not geoms:
        raise SystemExit(f"{layer_dir}: no geometries")
    return clean(gpd.GeoSeries(geoms, crs="EPSG:4326").to_crs("EPSG:3577"))


def clean(series):
    """Snap to a 1 cm grid and repair: parcel-precision overlays carry slivers
    that are valid in WGS84 and self-touch after projection, and GEOS refuses
    to overlay those ("side location conflict")."""
    import geopandas as gpd
    import shapely

    fixed = []
    for geom in series.values:
        geom = polygonal(shapely.make_valid(geom))
        try:
            geom = polygonal(shapely.make_valid(shapely.set_precision(geom, 0.01)))
        except shapely.errors.GEOSException:
            # Some parcel slivers cannot be snapped; a zero buffer rebuilds them
            # from the valid interior, which is what an area share wants anyway.
            geom = geom.buffer(0)
        fixed.append(geom)
    return gpd.GeoSeries(fixed, crs=series.crs)


def polygonal(geom):
    """make_valid can hand back a GeometryCollection with stray lines and points
    where a ring collapsed; an area share only wants the polygonal parts, and
    GEOS refuses to overlay mixed dimensions."""
    import shapely
    from shapely.geometry import MultiPolygon

    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom
    parts = [p for p in shapely.get_parts(geom) if p.geom_type in ("Polygon", "MultiPolygon")]
    if not parts:
        return MultiPolygon()
    return shapely.union_all(parts)


def share_for(suburb_geom, candidates) -> float:
    import shapely

    if suburb_geom.is_empty or suburb_geom.area <= 0:
        return 0.0
    clipped = [polygonal(c.intersection(suburb_geom, grid_size=0.01)) for c in candidates]
    clipped = [c for c in clipped if not c.is_empty]
    if not clipped:
        return 0.0
    covered = shapely.union_all(clipped, grid_size=0.01).area
    return round(min(100.0, max(0.0, covered / suburb_geom.area * 100.0)), 4)


def build(layer_dir: Path, suburbs_path: Path) -> dict:
    import geopandas as gpd
    from shapely.strtree import STRtree

    layer = load_layer(layer_dir)
    tree = STRtree(layer.values)
    suburbs = gpd.read_file(suburbs_path)
    if suburbs.crs is None:
        suburbs = suburbs.set_crs("EPSG:7844")
    suburbs = suburbs.to_crs("EPSG:3577")
    suburbs = suburbs.set_geometry(clean(suburbs.geometry))
    out: dict[str, float] = {}
    for _, row in suburbs.iterrows():
        sal = str(row.get("SAL_CODE21") or row.get("id") or "").strip()
        geom = row.geometry
        if geom is None or geom.is_empty:
            out[sal] = 0.0
            continue
        idx = tree.query(geom, predicate="intersects")
        out[sal] = share_for(geom, [layer.values[i] for i in idx]) if len(idx) else 0.0
    return dict(sorted(out.items()))


def main() -> None:
    parser = argparse.ArgumentParser(description="Per-SAL hazard overlay area share")
    parser.add_argument("--layer-dir", type=Path, required=True)
    parser.add_argument("--suburbs", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = build(args.layer_dir, args.suburbs)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, separators=(",", ":")) + "\n")
    nonzero = sum(1 for v in result.values() if v > 0)
    print(f"wrote {args.out}: {len(result)} suburbs, {nonzero} with any overlap")


if __name__ == "__main__":
    main()
