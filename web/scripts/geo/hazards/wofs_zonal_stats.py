#!/usr/bin/env python3
"""Per-SAL observed-surface-water shares from DEA Water Observations.

Input raster: the multi-year water frequency summary (`wofs_vrt.py`), where each
30 m cell holds the fraction of CLEAR Landsat observations since 1987 in which
water was detected (0..1), or NaN where the cell was never clearly observed.

Two measured shares per suburb, both area shares of the suburb's validly
observed cells, in percent:

  waterObservedSharePct  — cells wet in at least OBSERVED_MIN_FREQUENCY of clear
                           observations but below PERMANENT_MIN_FREQUENCY:
                           land that has been under water at least occasionally.
  permanentWaterSharePct — cells wet in PERMANENT_MIN_FREQUENCY or more of
                           observations: lakes, rivers, reservoirs, the sea.

What this is NOT: a flood-risk estimate. Landsat revisits every 8–16 days and
cloud hides many events, so the record under-observes flood peaks; the share is
a floor on inundation, never a ceiling. It measures water that was SEEN.

Same quality rule as the DEM pipeline: NaN never enters either side of a share,
and a suburb with fewer than MINIMUM_VALID_CELL_COUNT valid cells reports null.

The raster is equal-area (EPSG:3577), so every cell carries the same area and
shares are plain cell ratios. Large suburbs are read in row bands so the
Coral Sea does not need 8 GB of RAM to summarise.

    python3 wofs_zonal_stats.py --vrt wofs.vrt --suburbs-dir <dir with STATE.topojson> \
        --out out/STATE.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Optional

import numpy as np

MINIMUM_VALID_CELL_COUNT = 25
OBSERVED_MIN_FREQUENCY = 0.01
PERMANENT_MIN_FREQUENCY = 0.90
ROW_BAND = 2048

METRIC_KEYS = ("waterObservedSharePct", "permanentWaterSharePct")


def empty_result(sampled: int) -> dict:
    return {"sampledCellCount": sampled, **{k: None for k in METRIC_KEYS}}


class ShareAccumulator:
    """Counts cells across row bands; `result()` applies the quality floor."""

    def __init__(self) -> None:
        self.valid = 0
        self.observed = 0
        self.permanent = 0

    def add(self, frequencies: np.ndarray, inside: np.ndarray) -> None:
        values = np.asarray(frequencies, dtype=float)
        mask = np.asarray(inside, dtype=bool) & np.isfinite(values)
        if not mask.any():
            return
        sample = values[mask]
        self.valid += int(sample.size)
        self.permanent += int((sample >= PERMANENT_MIN_FREQUENCY).sum())
        self.observed += int(((sample >= OBSERVED_MIN_FREQUENCY) & (sample < PERMANENT_MIN_FREQUENCY)).sum())

    def result(self, minimum_cells: int = MINIMUM_VALID_CELL_COUNT) -> dict:
        if self.valid < minimum_cells or self.valid == 0:
            return empty_result(self.valid)
        return {
            "sampledCellCount": self.valid,
            "waterObservedSharePct": round(self.observed / self.valid * 100.0, 4),
            "permanentWaterSharePct": round(self.permanent / self.valid * 100.0, 4),
        }


def summarise_cells(frequencies, inside, minimum_cells: int = MINIMUM_VALID_CELL_COUNT) -> dict:
    acc = ShareAccumulator()
    acc.add(np.asarray(frequencies, dtype=float), np.asarray(inside, dtype=bool))
    return acc.result(minimum_cells)


def summarise_geometry(ds, geometry, minimum_cells: int = MINIMUM_VALID_CELL_COUNT) -> dict:
    """Band-by-band zonal summary of one (already reprojected) geometry."""
    from rasterio import windows
    from rasterio.features import geometry_mask

    minx, miny, maxx, maxy = geometry.bounds
    full = windows.from_bounds(minx, miny, maxx, maxy, ds.transform)
    raster = windows.Window(0, 0, ds.width, ds.height)
    try:
        win = full.intersection(raster)
    except Exception:
        return empty_result(0)
    win = windows.Window(
        int(np.floor(win.col_off)), int(np.floor(win.row_off)),
        int(np.ceil(win.width)) + 1, int(np.ceil(win.height)) + 1,
    ).intersection(raster)
    if win.width <= 0 or win.height <= 0:
        return empty_result(0)

    acc = ShareAccumulator()
    row = int(win.row_off)
    end = int(win.row_off + win.height)
    while row < end:
        band = windows.Window(int(win.col_off), row, int(win.width), min(ROW_BAND, end - row))
        transform = windows.transform(band, ds.transform)
        inside = ~geometry_mask(
            [geometry.__geo_interface__], out_shape=(int(band.height), int(band.width)),
            transform=transform, all_touched=False,
        )
        if inside.any():
            data = ds.read(1, window=band)
            acc.add(data, inside)
        row += ROW_BAND
    return acc.result(minimum_cells)


def build_artifact(vrt: Path, suburbs_dir: Path) -> dict:
    import geopandas as gpd
    import rasterio

    output: dict[str, dict] = {}
    with rasterio.open(vrt) as ds:
        for boundary in sorted(suburbs_dir.glob("*.topojson")):
            suburbs = gpd.read_file(boundary)
            if suburbs.crs is None:
                suburbs = suburbs.set_crs("EPSG:7844")
            suburbs = suburbs.to_crs(ds.crs)
            for _, suburb in suburbs.iterrows():
                sal = str(suburb.get("SAL_CODE21") or suburb.get("id") or "").strip()
                if not sal:
                    raise ValueError(f"boundary without SAL_CODE21 in {boundary}")
                geometry = suburb.geometry
                if geometry is None or geometry.is_empty:
                    output[sal] = empty_result(0)
                    continue
                output[sal] = summarise_geometry(ds, geometry)
    return dict(sorted(output.items()))


def main() -> None:
    parser = argparse.ArgumentParser(description="Per-SAL DEA Water Observations shares")
    parser.add_argument("--vrt", type=Path, required=True)
    parser.add_argument("--suburbs-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    artifact = build_artifact(args.vrt, args.suburbs_dir)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(artifact, separators=(",", ":")) + "\n")
    populated = sum(1 for r in artifact.values() if r["waterObservedSharePct"] is not None)
    print(f"wrote {args.out}: {len(artifact)} SAL suburbs; {populated} met the {MINIMUM_VALID_CELL_COUNT}-cell floor")


if __name__ == "__main__":
    main()
