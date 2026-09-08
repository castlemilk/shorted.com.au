#!/usr/bin/env python3
"""Build the map's overlay geometry per state, as WGS84 GeoJSON.

Two producers share one output contract (a FeatureCollection with a single
`properties.layer` per feature, ready for `build-overlays.mjs` to quantize into
TopoJSON under a byte budget):

  vector  — dissolve a fetched statutory layer (flood planning, bushfire prone)
            to one multipolygon, simplify at SIMPLIFY_M, drop parts smaller than
            MIN_PART_M2. Planning overlays are drawn at parcel precision; a state
            map at 1–48× zoom cannot show that, and a 235,000-polygon layer would
            not ship.

  wofs    — threshold the water-frequency raster at OBSERVED_MIN_FREQUENCY (and
            below PERMANENT_MIN_FREQUENCY, so the sea and lakes are not painted as
            "observed flooding"), coarsen 4× to 120 m by block fraction, clip to the
            state's suburbs and polygonise. The coarse mask is for DRAWING only;
            the per-suburb shares come from `wofs_zonal_stats.py` at full resolution.

    python3 overlay_geometry.py vector --layer-dir vector/nsw-flood --layer flood_planning \
        --suburbs NSW.topojson --out overlays/NSW-flood_planning.geojson
    python3 overlay_geometry.py wofs --vrt wofs.vrt --suburbs NSW.topojson \
        --out overlays/NSW-water_observed.geojson
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from wofs_zonal_stats import OBSERVED_MIN_FREQUENCY, PERMANENT_MIN_FREQUENCY

SIMPLIFY_M = 40.0
MIN_PART_M2 = 20_000.0  # 2 ha: below this a part is sub-pixel at state zoom
COARSEN = 4
BLOCK_FRACTION = 0.25


def drop_small_parts(geom, min_area: float):
    from shapely.geometry import MultiPolygon, Polygon

    if geom.is_empty:
        return geom
    parts = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
    kept = []
    for part in parts:
        if part.area < min_area:
            continue
        holes = [h for h in part.interiors if Polygon(h).area >= min_area]
        kept.append(Polygon(part.exterior, holes))
    if not kept:
        return MultiPolygon()
    return MultiPolygon(kept) if len(kept) > 1 else kept[0]


def load_suburbs(path: Path):
    import geopandas as gpd

    from vector_share import clean

    suburbs = gpd.read_file(path)
    if suburbs.crs is None:
        suburbs = suburbs.set_crs("EPSG:7844")
    suburbs = suburbs.to_crs("EPSG:3577")
    return suburbs.set_geometry(clean(suburbs.geometry))


def write_geojson(geom_3577, layer: str, out: Path, extra: dict) -> None:
    import geopandas as gpd

    series = gpd.GeoSeries([geom_3577], crs="EPSG:3577").to_crs("EPSG:4326")
    fc = {
        "type": "FeatureCollection",
        "properties": {"layer": layer, **extra},
        "features": [
            {"type": "Feature", "properties": {"layer": layer}, "geometry": series.iloc[0].__geo_interface__}
        ],
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(fc, separators=(",", ":")))


def vector(args) -> None:
    import shapely

    from vector_share import load_layer, polygonal

    layer = load_layer(args.layer_dir)
    suburbs = load_suburbs(args.suburbs)
    state = polygonal(shapely.union_all(suburbs.geometry.values, grid_size=0.01))
    dissolved = polygonal(shapely.union_all(layer.values, grid_size=0.01).intersection(state, grid_size=0.01))
    simplified = dissolved.simplify(SIMPLIFY_M, preserve_topology=True)
    cleaned = drop_small_parts(simplified, MIN_PART_M2)
    write_geojson(cleaned, args.layer, args.out, {"source_polygons": int(len(layer))})
    print(f"wrote {args.out}: {len(layer)} polygons -> {cleaned.area / 1e6:.0f} km²")


def coarse_mask(ds, window, transform):
    """Block-fraction coarsening of the observed-water mask inside one window."""
    data = ds.read(1, window=window)
    flagged = np.isfinite(data) & (data >= OBSERVED_MIN_FREQUENCY) & (data < PERMANENT_MIN_FREQUENCY)
    h, w = flagged.shape
    h2, w2 = h // COARSEN, w // COARSEN
    blocks = flagged[: h2 * COARSEN, : w2 * COARSEN].reshape(h2, COARSEN, w2, COARSEN)
    fraction = blocks.mean(axis=(1, 3))
    return fraction >= BLOCK_FRACTION


def wofs(args) -> None:
    import rasterio
    import shapely
    from rasterio import windows
    from rasterio.features import geometry_mask, shapes
    from shapely.geometry import shape
    from shapely.ops import unary_union

    suburbs = load_suburbs(args.suburbs)
    state = shapely.union_all(suburbs.geometry.values, grid_size=0.01)
    minx, miny, maxx, maxy = state.bounds
    polys = []
    with rasterio.open(args.vrt) as ds:
        full = windows.from_bounds(minx, miny, maxx, maxy, ds.transform).intersection(
            windows.Window(0, 0, ds.width, ds.height)
        )
        col0 = int(np.floor(full.col_off)) // COARSEN * COARSEN
        row0 = int(np.floor(full.row_off)) // COARSEN * COARSEN
        col1 = int(np.ceil(full.col_off + full.width))
        row1 = int(np.ceil(full.row_off + full.height))
        band_rows = 4096
        for r in range(row0, row1, band_rows):
            win = windows.Window(col0, r, col1 - col0, min(band_rows, row1 - r))
            mask = coarse_mask(ds, win, windows.transform(win, ds.transform))
            if not mask.any():
                continue
            coarse_transform = windows.transform(win, ds.transform) * rasterio.Affine.scale(COARSEN, COARSEN)
            inside = ~geometry_mask([state.__geo_interface__], out_shape=mask.shape, transform=coarse_transform)
            mask &= inside
            if not mask.any():
                continue
            for geom, value in shapes(mask.astype(np.uint8), mask=mask, transform=coarse_transform):
                if value:
                    polys.append(shape(geom))
    merged = unary_union(polys) if polys else __import__("shapely").geometry.MultiPolygon()
    simplified = merged.simplify(SIMPLIFY_M, preserve_topology=True)
    cleaned = drop_small_parts(simplified, MIN_PART_M2)
    write_geojson(cleaned, "water_observed", args.out, {
        "min_frequency": OBSERVED_MIN_FREQUENCY, "max_frequency": PERMANENT_MIN_FREQUENCY,
        "cell_m": 30 * COARSEN,
    })
    print(f"wrote {args.out}: {len(polys)} raw parts -> {cleaned.area / 1e6:.0f} km²")


def main() -> None:
    parser = argparse.ArgumentParser(description="Overlay geometry for the housing map")
    sub = parser.add_subparsers(dest="mode", required=True)
    v = sub.add_parser("vector")
    v.add_argument("--layer-dir", type=Path, required=True)
    v.add_argument("--layer", required=True, choices=["flood_planning", "bushfire_prone"])
    v.add_argument("--suburbs", type=Path, required=True)
    v.add_argument("--out", type=Path, required=True)
    w = sub.add_parser("wofs")
    w.add_argument("--vrt", type=Path, required=True)
    w.add_argument("--suburbs", type=Path, required=True)
    w.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    (vector if args.mode == "vector" else wofs)(args)


if __name__ == "__main__":
    main()
