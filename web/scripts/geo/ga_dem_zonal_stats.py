#!/usr/bin/env python3
"""Build per-SAL measured elevation statistics from Geoscience Australia DEM-S.

Dataset: Geoscience Australia, "SRTM-derived 1 Second Digital Elevation Model
Version 1.0 (DEM-S)" (approximately 30 m), © Commonwealth of Australia
(Geoscience Australia), licensed CC-BY-4.0.
Portal/download: ELVIS — https://elevation.fsdf.org.au/
Expected size: a national 1-second raster is about 40 GB uncompressed; ELVIS
delivers compressed/tiled exports whose archive size varies with the selected
format and extent. Mosaic the tiles into one GeoTIFF before running this step.

Vertical datum: DEM-S values are orthometric elevations in metres relative to
the EGM96 geoid. They are not Australian Height Datum (AHD) or ellipsoidal
heights, and this script performs no vertical-datum conversion.

Install once (outside this repository's normal app dependencies):
  python3 -m pip install numpy rasterio geopandas pyproj

Run from the repository root after obtaining and mosaicking the real DEM:
  python3 web/scripts/geo/ga_dem_zonal_stats.py \
    --dem /absolute/path/to/DEM-S_1sec_GDA94_EGM96.tif \
    --suburbs-dir web/public/geo/suburbs \
    --out web/public/geo/insights/suburb-elevation.json

The output is keyed directly by sal_code. Metrics describe sampled terrain
only; the script performs no hydrology, drainage, surge, or catchment modelling.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Iterable, Optional

import numpy as np


MINIMUM_VALID_CELL_COUNT = 25
METRIC_KEYS = (
    "elevationMinM",
    "elevationMedianM",
    "elevationMaxM",
    "landShareBelow1m",
    "landShareBelow2m",
    "landShareBelow5m",
)


def empty_result(sampled_cell_count: int) -> dict[str, Optional[float] | int]:
    return {
        "sampledCellCount": sampled_cell_count,
        **{key: None for key in METRIC_KEYS},
    }


def _weighted_median(values: np.ndarray, weights: np.ndarray) -> float:
    order = np.argsort(values)
    ordered_values = values[order]
    cumulative = np.cumsum(weights[order])
    index = int(np.searchsorted(cumulative, weights.sum() / 2.0, side="left"))
    return float(ordered_values[min(index, len(ordered_values) - 1)])


def summarise_valid_cells(
    values: Iterable[Optional[float]],
    area_weights: Iterable[float],
    *,
    nodata: Optional[float],
    minimum_cells: int = MINIMUM_VALID_CELL_COUNT,
) -> dict[str, Optional[float] | int]:
    """Summarise valid DEM cells; null/no-data never enters either share side."""
    samples = np.asarray(list(values), dtype=float)
    weights = np.asarray(list(area_weights), dtype=float)
    if samples.shape != weights.shape:
        raise ValueError("values and area_weights must have the same shape")

    valid = np.isfinite(samples) & np.isfinite(weights) & (weights > 0)
    if nodata is not None and math.isfinite(float(nodata)):
        valid &= samples != float(nodata)
    samples = samples[valid]
    weights = weights[valid]
    count = int(samples.size)
    if count < minimum_cells or not count or weights.sum() <= 0:
        return empty_result(count)

    total_area = float(weights.sum())
    share = lambda threshold: round(
        float(weights[samples < threshold].sum()) / total_area * 100.0, 4
    )
    return {
        "sampledCellCount": count,
        "elevationMinM": round(float(samples.min()), 3),
        "elevationMedianM": round(_weighted_median(samples, weights), 3),
        "elevationMaxM": round(float(samples.max()), 3),
        "landShareBelow1m": share(1.0),
        "landShareBelow2m": share(2.0),
        "landShareBelow5m": share(5.0),
    }


def _pixel_area_weights(transform, crs, shape: tuple[int, int]) -> np.ndarray:
    """Return per-cell area weights, accounting for latitude in geographic DEMs."""
    rows, columns = shape
    if not crs.is_geographic:
        pixel_area = abs(transform.a * transform.e - transform.b * transform.d)
        return np.full(shape, pixel_area, dtype=float)

    from pyproj import Geod

    geod = Geod(ellps="GRS80")
    weights = np.empty(shape, dtype=float)
    for row in range(rows):
        x0, y0 = transform * (0, row)
        x1, y1 = transform * (1, row + 1)
        area, _ = geod.polygon_area_perimeter(
            [x0, x1, x1, x0], [y0, y0, y1, y1]
        )
        weights[row, :] = abs(area)
    return weights


def build_artifact(dem_path: Path, suburbs_dir: Path) -> dict[str, dict]:
    # Heavy geospatial imports stay local so the pure quality-rule tests run on
    # machines that do not have GDAL/rasterio installed.
    import geopandas as gpd
    import rasterio
    from rasterio.mask import mask

    output: dict[str, dict] = {}
    with rasterio.open(dem_path) as dem:
        if dem.crs is None:
            raise ValueError("DEM has no CRS; refuse to guess its horizontal datum")
        for boundary_path in sorted(suburbs_dir.glob("*.topojson")):
            suburbs = gpd.read_file(boundary_path)
            if suburbs.crs is None:
                # The committed ASGS 2021 SAL files were built from the GDA2020
                # source shapefile named in build-boundaries.mjs.
                suburbs = suburbs.set_crs("EPSG:7844")
            suburbs = suburbs.to_crs(dem.crs)
            for _, suburb in suburbs.iterrows():
                sal_code = str(suburb.get("SAL_CODE21") or suburb.get("id") or "").strip()
                if not sal_code:
                    raise ValueError(f"boundary without SAL_CODE21 in {boundary_path}")
                geometry = suburb.geometry
                if geometry is None or geometry.is_empty:
                    output[sal_code] = empty_result(0)
                    continue
                try:
                    clipped, clipped_transform = mask(
                        dem,
                        [geometry.__geo_interface__],
                        crop=True,
                        filled=False,
                        all_touched=False,
                        indexes=1,
                    )
                except ValueError:
                    output[sal_code] = empty_result(0)
                    continue

                values = np.asarray(clipped.data, dtype=float)
                masked = np.ma.getmaskarray(clipped)
                values[masked] = np.nan
                weights = _pixel_area_weights(clipped_transform, dem.crs, values.shape)
                output[sal_code] = summarise_valid_cells(
                    values.ravel(),
                    weights.ravel(),
                    nodata=dem.nodata,
                )
    return dict(sorted(output.items()))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Compute measured GA DEM-S elevation metrics per committed ABS SAL suburb"
    )
    parser.add_argument("--dem", type=Path, required=True, help="mosaicked GA DEM-S GeoTIFF")
    parser.add_argument("--suburbs-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    artifact = build_artifact(args.dem, args.suburbs_dir)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(artifact, separators=(",", ":")) + "\n")
    populated = sum(1 for row in artifact.values() if row["elevationMedianM"] is not None)
    print(
        f"wrote {args.out}: {len(artifact)} SAL suburbs; "
        f"{populated} met the {MINIMUM_VALID_CELL_COUNT}-cell floor"
    )


if __name__ == "__main__":
    main()
