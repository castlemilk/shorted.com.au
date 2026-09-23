#!/usr/bin/env python3
"""Share of each SAL suburb's land inside a statutory hazard overlay.

Inputs are the newline-delimited GeoJSON pages `fetch-layer.mjs` writes (one
directory per layer, with a `.done` marker proving the page set is complete).
For every suburb the overlay polygons that touch it are clipped to the suburb,
unioned (overlays overlap — a floodway inside a flood-planning area must not be
counted twice) and the union's area is divided by the suburb's area, all in GDA2020
Australian Albers (EPSG:3577) so the ratio is a true area share.

A suburb the layer's source does not cover is NOT zero. Across states that is
structural: this script only runs against suburbs of the state the source
covers, and every other state stays null downstream. Inside a state it takes a
coverage mask, because a statutory layer is only as wide as the instruments
that mapped it. NSW's EPI Flood layer holds maps lodged by ten LEPs and two
precinct SEPPs; every other council defines flood planning land by clause and
keeps the map in its own DCP, so "no polygon" there means "no map lodged", not
"no flood". Without a mask 4,350 NSW suburbs, Lismore and Windsor among them,
were published as a measured 0%.

  --coverage-dir    the land the source's instruments apply to (NSW: the Land
                    Application boundaries of exactly the EPIs present in the
                    flood layer; TAS: the councils whose Local Provisions
                    Schedule maps the code overlay).
  --unassessed-dir  land the source itself declares unassessed, carved out of
                    coverage (SA: the Code's "Evidence Required" flood overlay
                    and its precautionary "Regional"/"Outback" bushfire
                    overlays, which exist precisely because no study was done).

With a mask, a suburb whose covered part is under MIN_COVERED_PCT of its area
is null, and every other suburb's share is the share of its COVERED land. That
is a choice: dividing by the whole suburb would report a suburb half inside an
unmapped council as half as exposed as it is. The covered fraction of each
suburb is written to --coverage-out when asked, so a partial denominator is
never invisible. Without a mask the whole suburb is covered and a suburb no
polygon touches is a genuine 0.

  --raster-m        burn the layer onto a grid of this cell size and take each
                    suburb's share of burnt cells instead. For layers too big to
                    hold as geometry: QLD's bushfire prone area is 2.56 million
                    polygonised-raster fragments (3.6 GB of GeoJSON), and a
                    per-suburb GEOS union of those runs out of memory and time.
                    Pages are streamed into the grid one at a time, so memory is
                    the grid (QLD at 30 m: ~4 GB), never the input. Masks are
                    not supported on this path; it is for statewide layers.

    python3 vector_share.py --layer-dir vector/nsw-flood --suburbs web/public/geo/suburbs/NSW.topojson \
        --coverage-dir vector/nsw-flood-epi-application --out out/nsw-flood.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

# Below this share of a suburb inside the coverage mask, the covered part is a
# boundary sliver or a fringe too small to speak for the suburb: instrument
# boundaries follow cadastre and SAL boundaries follow mesh blocks, and the two
# disagree by metres along every council edge.
MIN_COVERED_PCT = 10.0

# On the raster path a suburb must span this many cell centres before its share
# is read from centre-sampled cells; a smaller one is read from every cell it
# touches instead, which overstates its footprint slightly but never leaves a
# measured suburb without a value.
MIN_RASTER_CELLS = 25


def page_geometries(page: Path) -> list:
    """The non-empty, valid WGS84 geometries of one fetched page."""
    from shapely.geometry import shape
    from shapely.validation import make_valid

    geoms = []
    with page.open() as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            geometry = json.loads(line).get("geometry")
            if not geometry:
                continue
            geom = shape(geometry)
            if geom.is_empty:
                continue
            geoms.append(geom if geom.is_valid else make_valid(geom))
    return geoms


def layer_pages(layer_dir: Path) -> list[Path]:
    if not (layer_dir / ".done").exists():
        raise SystemExit(f"{layer_dir}: no .done marker — the page set is incomplete; refusing")
    return sorted(layer_dir.glob("page-*.geojsonl"))


def load_layer(layer_dir: Path):
    import geopandas as gpd

    geoms = [g for page in layer_pages(layer_dir) for g in page_geometries(page)]
    if not geoms:
        raise SystemExit(f"{layer_dir}: no geometries")
    return clean(gpd.GeoSeries(geoms, crs="EPSG:4326").to_crs("EPSG:3577"))


def burn_layer(layer_dir: Path, bounds, cell_m: float):
    """Burn every polygon of a fetched layer onto a cell_m grid (EPSG:3577)
    covering `bounds`, one page at a time. Returns (grid, transform, polygons);
    a cell is 1 when its centre falls inside any polygon, so overlaps count once."""
    import geopandas as gpd
    import numpy as np
    import rasterio
    from rasterio.features import rasterize

    minx, miny, maxx, maxy = bounds
    width = int(np.ceil((maxx - minx) / cell_m))
    height = int(np.ceil((maxy - miny) / cell_m))
    transform = rasterio.Affine(cell_m, 0, minx, 0, -cell_m, maxy)
    grid = np.zeros((height, width), dtype="uint8")
    burnt = 0
    for page in layer_pages(layer_dir):
        geoms = page_geometries(page)
        if not geoms:
            continue
        projected = gpd.GeoSeries(geoms, crs="EPSG:4326").to_crs("EPSG:3577")
        rasterize(((g, 1) for g in projected.values if not g.is_empty), out=grid, transform=transform)
        burnt += len(geoms)
    if not burnt:
        raise SystemExit(f"{layer_dir}: no geometries")
    return grid, transform, burnt


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


def clipped_union(geom, candidates):
    """Union of the candidate polygons' parts inside `geom` (empty if none)."""
    import shapely
    from shapely.geometry import MultiPolygon

    clipped = [polygonal(c.intersection(geom, grid_size=0.01)) for c in candidates]
    clipped = [c for c in clipped if not c.is_empty]
    if not clipped:
        return MultiPolygon()
    return polygonal(shapely.union_all(clipped, grid_size=0.01))


def share_for(suburb_geom, candidates) -> float:
    if suburb_geom.is_empty or suburb_geom.area <= 0:
        return 0.0
    covered = clipped_union(suburb_geom, candidates).area
    return round(min(100.0, max(0.0, covered / suburb_geom.area * 100.0)), 4)


def covered_part(suburb_geom, coverage, unassessed):
    """The part of a suburb the source speaks for: inside the coverage mask
    (the whole suburb when there is none) and outside any land the source
    declares unassessed. `coverage` / `unassessed` are candidate lists, or None
    when that mask is not in use."""
    covered = suburb_geom if coverage is None else clipped_union(suburb_geom, coverage)
    if unassessed and not covered.is_empty:
        gap = clipped_union(covered, unassessed)
        if not gap.is_empty:
            covered = polygonal(covered.difference(gap, grid_size=0.01))
    return covered


def masked_share(suburb_geom, candidates, coverage=None, unassessed=None,
                 min_covered_pct: float = MIN_COVERED_PCT):
    """(share, covered_pct) for one suburb.

    share is None when the masks leave less than `min_covered_pct` of the
    suburb covered; otherwise it is the hazard's share of the covered land.
    With neither mask this is exactly `share_for` and never None."""
    if suburb_geom.is_empty or suburb_geom.area <= 0:
        return (0.0, 100.0) if coverage is None and unassessed is None else (None, 0.0)
    if coverage is None and unassessed is None:
        return share_for(suburb_geom, candidates), 100.0
    covered = covered_part(suburb_geom, coverage, unassessed)
    covered_pct = round(min(100.0, covered.area / suburb_geom.area * 100.0), 4)
    if covered_pct < min_covered_pct:
        return None, covered_pct
    return share_for(covered, candidates), covered_pct


def load_suburbs(suburbs_path: Path):
    import geopandas as gpd

    suburbs = gpd.read_file(suburbs_path)
    if suburbs.crs is None:
        suburbs = suburbs.set_crs("EPSG:7844")
    suburbs = suburbs.to_crs("EPSG:3577")
    return suburbs.set_geometry(clean(suburbs.geometry))


def sal_code(row) -> str:
    return str(row.get("SAL_CODE21") or row.get("id") or "").strip()


def raster_share(grid, transform, suburb_geom) -> float:
    """Share of the burnt cells among the cells whose centre is in the suburb
    (every touched cell for a suburb smaller than MIN_RASTER_CELLS)."""
    import math

    import numpy as np
    from rasterio import windows
    from rasterio.features import geometry_mask

    if suburb_geom.is_empty or suburb_geom.area <= 0:
        return 0.0
    cell, x0, y0 = transform.a, transform.c, transform.f
    minx, miny, maxx, maxy = suburb_geom.bounds
    col0, row0 = max(0, math.floor((minx - x0) / cell)), max(0, math.floor((y0 - maxy) / cell))
    col1 = min(grid.shape[1], math.ceil((maxx - x0) / cell))
    row1 = min(grid.shape[0], math.ceil((y0 - miny) / cell))
    if col1 <= col0 or row1 <= row0:
        return 0.0
    cells = grid[row0:row1, col0:col1]
    win_transform = windows.transform(windows.Window(col0, row0, col1 - col0, row1 - row0), transform)
    for all_touched in (False, True):
        inside = ~geometry_mask([suburb_geom.__geo_interface__], out_shape=cells.shape,
                                transform=win_transform, all_touched=all_touched)
        n = int(inside.sum())
        if n >= MIN_RASTER_CELLS or (all_touched and n):
            return round(float(np.count_nonzero(cells[inside])) / n * 100.0, 4)
    return 0.0


def build_raster(layer_dir: Path, suburbs_path: Path, cell_m: float) -> tuple[dict, dict]:
    """Per-SAL shares from a burnt grid; every suburb is fully covered."""
    suburbs = load_suburbs(suburbs_path)
    minx, miny, maxx, maxy = suburbs.total_bounds
    pad = 2 * cell_m
    grid, transform, _ = burn_layer(layer_dir, (minx - pad, miny - pad, maxx + pad, maxy + pad), cell_m)
    shares = {sal_code(row): raster_share(grid, transform, row.geometry) for _, row in suburbs.iterrows()
              if row.geometry is not None}
    return dict(sorted(shares.items())), {sal: 100.0 for sal in shares}


def build(layer_dir: Path, suburbs_path: Path, coverage_dir: Path | None = None,
          unassessed_dir: Path | None = None) -> tuple[dict, dict]:
    """Per-SAL shares, and the covered share of each suburb (100 without masks)."""
    from shapely.strtree import STRtree

    layer = load_layer(layer_dir)
    tree = STRtree(layer.values)
    masks = {}
    for key, mask_dir in (("coverage", coverage_dir), ("unassessed", unassessed_dir)):
        if mask_dir is not None:
            geoms = load_layer(mask_dir).values
            masks[key] = (STRtree(geoms), geoms)
    suburbs = load_suburbs(suburbs_path)

    def candidates(key, geom):
        if key not in masks:
            return None
        mask_tree, geoms = masks[key]
        return [geoms[i] for i in mask_tree.query(geom, predicate="intersects")]

    shares: dict[str, float | None] = {}
    coverage: dict[str, float] = {}
    for _, row in suburbs.iterrows():
        sal = sal_code(row)
        geom = row.geometry
        if geom is None or geom.is_empty:
            shares[sal], coverage[sal] = (0.0, 100.0) if not masks else (None, 0.0)
            continue
        hits = [layer.values[i] for i in tree.query(geom, predicate="intersects")]
        shares[sal], coverage[sal] = masked_share(
            geom, hits, candidates("coverage", geom), candidates("unassessed", geom),
        )
    return dict(sorted(shares.items())), dict(sorted(coverage.items()))


def main() -> None:
    parser = argparse.ArgumentParser(description="Per-SAL hazard overlay area share")
    parser.add_argument("--layer-dir", type=Path, required=True)
    parser.add_argument("--suburbs", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--coverage-dir", type=Path, default=None,
                        help="fetched layer of the land the source's instruments apply to")
    parser.add_argument("--unassessed-dir", type=Path, default=None,
                        help="fetched layer of land the source declares unassessed (carved out of coverage)")
    parser.add_argument("--coverage-out", type=Path, default=None,
                        help="also write each suburb's covered share (keep it OUT of the merge's vector dir)")
    parser.add_argument("--raster-m", type=float, default=0,
                        help="share of burnt cells on a grid of this cell size instead of a GEOS union")
    args = parser.parse_args()
    if args.raster_m:
        if args.coverage_dir or args.unassessed_dir:
            parser.error("--raster-m is for statewide layers; it does not take --coverage-dir/--unassessed-dir")
        result, covered = build_raster(args.layer_dir, args.suburbs, args.raster_m)
    else:
        result, covered = build(args.layer_dir, args.suburbs, args.coverage_dir, args.unassessed_dir)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, separators=(",", ":")) + "\n")
    if args.coverage_out:
        args.coverage_out.parent.mkdir(parents=True, exist_ok=True)
        args.coverage_out.write_text(json.dumps(covered, separators=(",", ":")) + "\n")
    nulls = sum(1 for v in result.values() if v is None)
    zeros = sum(1 for v in result.values() if v == 0)
    positive = sum(1 for v in result.values() if v is not None and v > 0)
    partial = sum(1 for sal, v in result.items() if v is not None and covered[sal] < 99.0)
    print(f"wrote {args.out}: {len(result)} suburbs — {positive} > 0, {zeros} measured 0, "
          f"{nulls} null (uncovered), {partial} shares over a partly covered suburb")


if __name__ == "__main__":
    main()
