#!/usr/bin/env python3
"""Stage a filtered slice of a bulk vector download in the fetch-layer contract.

`fetch-layer.mjs` pages a REST service into `page-*.geojsonl` + a `.done`
marker. Some sources are only sensible as a bulk file — SA's Planning and
Design Code overlays are one 380,827-feature shapefile inside an 872 MB zip,
and paging the equivalent GeoJSON would move 1.8 GB — so this script reads the
local file with GDAL, keeps the rows matching an attribute filter, reprojects
to WGS84 and writes the same page set. `vector_share.py` and
`overlay_geometry.py` then cannot tell which path produced a layer, and the
`.done` marker records the file, filter and count so the provenance survives.

    python3 extract_layer.py --src raw/sa-pdcode/PDCodeOverlays_GDA2020.shp \
        --where "name = 'Hazards (Flooding)'" --fields id,name,value \
        --out vector --name sa-flood
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

PAGE_SIZE = 2000


def extract(src: Path, where: str, fields: list[str], out_dir: Path, page_size: int = PAGE_SIZE) -> int:
    import pyogrio

    out_dir.mkdir(parents=True, exist_ok=True)
    done = out_dir / ".done"
    if done.exists():
        print(f"{out_dir.name}: already complete ({done} exists)")
        return json.loads(done.read_text())["count"]
    for stale in out_dir.glob("page-*.geojsonl*"):
        # A partial earlier run is discarded whole: pages are cheap to rewrite
        # from a local file, and a mixed set is exactly what .done guards.
        stale.unlink()
    frame = pyogrio.read_dataframe(src, where=where or None, columns=fields or None)
    if frame.crs is None:
        raise SystemExit(f"{src}: no CRS; refusing to guess")
    frame = frame.to_crs("EPSG:4326")
    count = len(frame)
    if count == 0:
        raise SystemExit(f"{src}: no rows match {where!r}; refusing to write an empty layer")
    props = [c for c in frame.columns if c != "geometry"]
    for page, start in enumerate(range(0, count, page_size)):
        chunk = frame.iloc[start:start + page_size]
        lines = []
        for _, row in chunk.iterrows():
            geometry = row.geometry
            lines.append(json.dumps({
                "type": "Feature",
                "properties": {k: _jsonable(row[k]) for k in props},
                "geometry": None if geometry is None else geometry.__geo_interface__,
            }, separators=(",", ":")))
        tmp = out_dir / f"page-{page:05d}.geojsonl.tmp"
        tmp.write_text("\n".join(lines) + "\n")
        tmp.rename(tmp.with_suffix(""))
    done.write_text(json.dumps({
        "count": count,
        "extractedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "src": str(src),
        "srcModified": datetime.fromtimestamp(src.stat().st_mtime, timezone.utc).isoformat(timespec="seconds"),
        "where": where,
    }) + "\n")
    print(f"{out_dir.name}: extracted {count} features from {src.name}")
    return count


def _jsonable(value):
    """Shapefile attributes arrive as numpy scalars, NaN and pandas timestamps."""
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if hasattr(value, "item"):
        value = value.item()
    if isinstance(value, float) and value != value:
        return None
    return value


def main() -> None:
    parser = argparse.ArgumentParser(description="Filter a local vector file into fetch-layer pages")
    parser.add_argument("--src", type=Path, required=True)
    parser.add_argument("--where", default="", help="OGR SQL attribute filter")
    parser.add_argument("--fields", default="", help="comma-separated attributes to keep")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--name", required=True)
    args = parser.parse_args()
    fields = [f.strip() for f in args.fields.split(",") if f.strip()]
    extract(args.src, args.where, fields, args.out / args.name)


if __name__ == "__main__":
    main()
