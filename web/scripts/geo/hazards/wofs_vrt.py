#!/usr/bin/env python3
"""Stitch the synced DEA Water Observations frequency tiles into one VRT.

Dataset: Geoscience Australia, "DEA Water Observations Statistics (Landsat)",
multi-year frequency summary `ga_ls_wo_fq_myear_3` (v2.1.0, 1987 onward),
© Commonwealth of Australia (Geoscience Australia), CC-BY-4.0.
Access: s3://dea-public-data/derivative/ga_ls_wo_fq_myear_3/2-1-0/ (anonymous).

Every tile is a 3200×3200 float32 COG on the same EPSG:3577 30 m grid, so the
mosaic is a pure index and GDAL never needs to run: the VRT is written by hand
from each tile's georeferencing, which keeps this runnable in the rasterio-only
venv on the external volume (no gdalbuildvrt binary there).

    python3 wofs_vrt.py --tiles /Volumes/gamma-systems-2/shorted-hazards/wofs \
        --out /Volumes/gamma-systems-2/shorted-hazards/wofs.vrt
"""

from __future__ import annotations

import argparse
from pathlib import Path
from xml.sax.saxutils import escape


def tile_bounds(paths):
    import rasterio

    tiles = []
    crs_wkt = None
    res = None
    for path in paths:
        with rasterio.open(path) as ds:
            if crs_wkt is None:
                crs_wkt = ds.crs.to_wkt()
                res = (ds.transform.a, ds.transform.e)
            elif ds.crs.to_wkt() != crs_wkt or (ds.transform.a, ds.transform.e) != res:
                raise ValueError(f"{path}: grid differs from the first tile; refuse to mosaic")
            tiles.append((path, ds.bounds, ds.width, ds.height, ds.dtypes[0]))
    return crs_wkt, res, tiles


def build_vrt(tiles_dir: Path, out: Path) -> int:
    paths = sorted(tiles_dir.rglob("*_final_frequency.tif"))
    if not paths:
        raise SystemExit(f"no *_final_frequency.tif under {tiles_dir}")
    crs_wkt, (xres, yres), tiles = tile_bounds(paths)
    left = min(t[1].left for t in tiles)
    top = max(t[1].top for t in tiles)
    right = max(t[1].right for t in tiles)
    bottom = min(t[1].bottom for t in tiles)
    width = int(round((right - left) / xres))
    height = int(round((bottom - top) / yres))

    lines = [
        f'<VRTDataset rasterXSize="{width}" rasterYSize="{height}">',
        f"  <SRS>{escape(crs_wkt)}</SRS>",
        f"  <GeoTransform>{left}, {xres}, 0, {top}, 0, {yres}</GeoTransform>",
        '  <VRTRasterBand dataType="Float32" band="1">',
        "    <NoDataValue>nan</NoDataValue>",
    ]
    for path, bounds, w, h, dtype in tiles:
        xoff = int(round((bounds.left - left) / xres))
        yoff = int(round((bounds.top - top) / yres))
        lines += [
            "    <SimpleSource>",
            f'      <SourceFilename relativeToVRT="0">{escape(str(path))}</SourceFilename>',
            "      <SourceBand>1</SourceBand>",
            f'      <SourceProperties RasterXSize="{w}" RasterYSize="{h}" DataType="Float32" />',
            f'      <SrcRect xOff="0" yOff="0" xSize="{w}" ySize="{h}" />',
            f'      <DstRect xOff="{xoff}" yOff="{yoff}" xSize="{w}" ySize="{h}" />',
            "    </SimpleSource>",
        ]
    lines += ["  </VRTRasterBand>", "</VRTDataset>"]
    out.write_text("\n".join(lines) + "\n")
    return len(tiles)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--tiles", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    n = build_vrt(args.tiles, args.out)
    print(f"wrote {args.out}: {n} tiles")


if __name__ == "__main__":
    main()
