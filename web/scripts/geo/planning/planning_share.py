#!/usr/bin/env python3
"""Per-suburb planning layer: zoning-family mix, heritage share + item count,
NSW development controls and the planning instrument(s) that apply.

Two subcommands:

    state  compute one state's rows from the fetched layers into an
           intermediate JSON (out/<ST>.json on the external volume)
    merge  combine every state's intermediate into the one artifact the
           collector loads (services/house-price-collector/data/suburb-planning.json)

    PY=/Volumes/gamma-systems-2/shorted-dem/venv/bin/python
    P=/Volumes/gamma-systems-2/shorted-planning
    $PY planning_share.py state --state NSW --root $P \
        --suburbs web/public/geo/suburbs/NSW.topojson --out $P/out/NSW.json
    $PY planning_share.py merge --in-dir $P/out \
        --out services/house-price-collector/data/suburb-planning.json

Geometry follows vector_share.py: GDA2020 Australian Albers (EPSG:3577) so a
ratio is a true area share, every geometry snapped to 1 cm and repaired, and
polygons are unioned per family BEFORE dividing, so an overlap never counts
twice. Zoning layers can overlap (a NSW SEPP precinct zones land its LEP also
maps, usually as Deferred Matter), so each suburb's zone pieces are resolved in
precedence order: a higher tier claims its area first and a lower tier only
keeps what is left; within a tier, families claim in FAMILIES order. The family
shares therefore sum to the zoning coverage exactly.

NULL vs 0 (the program rule): a state with no source produces no value at all
(QLD zoning, WA, NT). Inside a covered state a suburb no polygon touches is a
measured 0 for coverage — but its family shares, dominant family and heritage
are NULL, because no instrument covers it (offshore and "no usual address"
pseudo-suburbs, unincorporated land outside every LEP).
"""

from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

os.environ.setdefault("GDAL_CACHEMAX", "256")

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from zone_families import FAMILIES, family_for  # noqa: E402

GRID = 0.01  # 1 cm snap, as vector_share.py
INSTRUMENT_MIN_SHARE = 1.0  # % of the suburb an instrument must cover to be named
MAX_SLIVER_M2 = 50.0  # a control piece smaller than this cannot set the maximum
RESIDENTIAL = ("res_low", "res_medium_high")

# --- Per-state configuration ------------------------------------------------
# zoning: [(layer, tier)] — lower tier number claims area first.
STATES: dict[str, dict] = {
    "NSW": {
        "zoning": [("nsw-zoning", None)],  # tier from EPI_TYPE: SEPP 0, LEP 1
        "heritage": "nsw-heritage",
        "controls": True,
        "licence": "CC-BY-4.0",
    },
    "VIC": {"zoning": [("vic-zoning", 0)], "heritage": "vic-heritage", "licence": "CC-BY-4.0"},
    # data.sa.gov.au lists CC BY 4.0; the License.txt shipped inside the zips
    # we fetched says CC BY 3.0 AU — record the one that came with the bytes.
    "SA": {"zoning": [("sa-zones", 0)], "heritage": "sa-overlays", "licence": "CC-BY-3.0-AU"},
    "TAS": {
        # Kingborough is on its interim scheme and absent from the TPS layer;
        # the two are disjoint, so tiering only matters if that ever changes.
        "zoning": [("tas-zones", 0), ("tas-zones-kingborough-interim", 1)],
        "heritage": "tas-heritage",
        "licence": "CC-BY-3.0-AU",
    },
    "ACT": {"zoning": [("act-zones", 0)], "heritage": "act-heritage", "licence": "CC-BY-4.0"},
    # QLD: no statewide zoning (77 council schemes); the Heritage Register is
    # places, not areas — an item count only.
    "QLD": {"zoning": [], "heritage": "qld-heritage", "licence": "CC-BY-4.0"},
}

ZONING_SOURCE = {
    "nsw-zoning": "nsw_epi_land_zoning",
    "vic-zoning": "vic_plan_zone",
    "sa-zones": "sa_pd_code_zones",
    "tas-zones": "tas_tps_zones",
    "tas-zones-kingborough-interim": "tas_kingborough_ips_2015",
    "act-zones": "act_territory_plan_zones",
}

HERITAGE_SOURCE = {
    "nsw-heritage": "nsw_epi_heritage",
    "vic-heritage": "vic_plan_overlay_ho",
    "sa-overlays": "sa_pd_code_heritage_overlays",
    "tas-heritage": "tas_tps_local_historic_heritage_code",
    "act-heritage": "act_heritage_register",
    "qld-heritage": "qld_heritage_register",
}

# --- Heritage: which classes are AREAS (share) and which are ITEMS (count) ---
NSW_HERITAGE_AREAS = {
    "Conservation Area - General",
    "Conservation Area - Landscape",
    "Conservation Area - Archaeological",
    "Heritage Conservation Area",
}
NSW_HERITAGE_ITEMS = {"Item - General", "Item - Landscape", "Item - Archaeological", "Local Heritage - General"}
# Aboriginal classes (Aboriginal Place of Heritage Significance, Item -
# Aboriginal, Conservation Area - Aboriginal, Aboriginal Object) are excluded
# from both: culturally sensitive, and not a built-form constraint a buyer reads.

SA_HERITAGE_AREAS = {"Historic Area", "Character Area", "State Heritage Area"}
SA_HERITAGE_ITEMS = {"Local Heritage Place", "State Heritage Place"}
# Excluded: Heritage Adjacency (a consideration buffer around State Heritage
# Places, not a listing) and Character Preservation District (the Barossa and
# McLaren Vale rural-landscape districts under their own Acts — whole valleys,
# not a heritage streetscape).

TAS_HERITAGE_AREAS = {"Local heritage precinct", "Local historic landscape precinct"}
TAS_HERITAGE_ITEMS = {"Local heritage place"}
# Excluded: Significant trees; Place or precinct of archaeological potential.
# The code overlay is mapped council by council: 18 of 28 Local Provisions
# Schedules carry any heritage feature, and Hobart maps precincts but no
# places. So a TAS value is only measured where the suburb's governing LPS maps
# that class at all; elsewhere it is NULL (not mapped), never 0.


def heritage_class(layer: str, props: dict):
    """-> (is_area, item_key or None), or None when the feature is excluded."""
    if layer == "nsw-heritage":
        cls = props.get("LAY_CLASS")
        if cls in NSW_HERITAGE_AREAS:
            return True, None
        if cls in NSW_HERITAGE_ITEMS:
            return False, ("nsw", props.get("EPI_NAME"), props.get("H_ID") or f"oid:{props.get('OBJECTID')}")
        return None
    if layer == "vic-heritage":
        # Every gazetted Heritage Overlay polygon — precincts and individual
        # places alike (the HO does not distinguish them). No item count: the
        # Victorian Heritage Register was not fetched and HO numbers mix both.
        return True, None
    if layer == "sa-overlays":
        name = props.get("name")
        if name in SA_HERITAGE_AREAS:
            return True, None
        if name in SA_HERITAGE_ITEMS:
            return False, ("sa", name, props.get("value") or props.get("id"))
        return None
    if layer == "tas-heritage":
        name = props.get("OV_NAME")
        if name in TAS_HERITAGE_AREAS:
            return True, None
        if name in TAS_HERITAGE_ITEMS:
            # The code overlay carries no per-place identifier; each mapped
            # place polygon is one place.
            return False, ("tas", props.get("OBJECTID"))
        return None
    if layer == "act-heritage":
        # Fetched pre-filtered: registered, not data-restricted, not an
        # Aboriginal place. Historic places are both an area (the register
        # boundary, like a VIC HO) and an item; natural places are neither.
        if props.get("HRcategory") != "Historic place or object":
            return None
        return True, ("act", props.get("HeritageID"))
    if layer == "qld-heritage":
        return False, ("qld", props.get("place_id"))
    raise ValueError(layer)


HAS_HERITAGE_AREAS = {"nsw-heritage", "vic-heritage", "sa-overlays", "tas-heritage", "act-heritage"}
HAS_HERITAGE_ITEMS = {"nsw-heritage", "sa-overlays", "tas-heritage", "act-heritage", "qld-heritage"}


# --- Instruments -------------------------------------------------------------
VIC_SCHEME_OVERRIDES = {
    "MERRI-BEK": "Merri-bek Planning Scheme",
    "FRENCH-ELIZABETH-SANDSTONE ISLANDS (UNINC)": "French Island and Sandstone Island Planning Scheme",
    "PORT OF MELBOURNE": "Port of Melbourne Planning Scheme",
}
_ALPINE = re.compile(r"ALPINE RESORT \(UNINC\)$")


def vic_scheme_name(lga: str) -> str:
    lga = (lga or "").strip()
    if lga in VIC_SCHEME_OVERRIDES:
        return VIC_SCHEME_OVERRIDES[lga]
    if _ALPINE.search(lga):
        return "Alpine Resorts Planning Scheme"
    words = []
    for w in lga.split(" "):
        words.append("-".join(p[:1] + p[1:].lower() for p in w.split("-")))
    return " ".join(words) + " Planning Scheme"


def instrument_for(layer: str, props: dict, family: str) -> list[str]:
    if layer == "nsw-zoning":
        # The instrument that zones this polygon — an LEP, or a SEPP that zones
        # land directly (precincts, Aerotropolis). The Land Application layer
        # adds LEPs by boundary; Lord Howe Island's LEP is absent there.
        name = (props.get("EPI_NAME") or "").strip()
        return [name] if name else []
    if layer == "vic-zoning":
        return [vic_scheme_name(props.get("lga"))]
    if layer == "sa-zones":
        return ["Planning and Design Code"]
    if layer == "tas-zones":
        lps = (props.get("LPS") or "").strip()
        return [f"Tasmanian Planning Scheme – {lps}" if lps else "Tasmanian Planning Scheme"]
    if layer == "tas-zones-kingborough-interim":
        return [(props.get("PLANSCHEME") or "Kingborough Interim Planning Scheme 2015").strip()]
    if layer == "act-zones":
        # Designated land is planned by the National Capital Authority.
        if props.get("LAND_USE_ZONE_CODE_ID") == "DES":
            return ["National Capital Plan"]
        return ["Territory Plan"]
    return []


NSW_LANDAPP_CLASSES = {"Included", "INCLUDED", "Subject Land", "Gosford City Centre "}


# --- NSW development controls -------------------------------------------------
def hob_value(props: dict):
    """Metres, or None. RL heights are an elevation above datum, not a height."""
    units = (props.get("UNITS") or "").replace(" ", "")
    if "RL" in units or units == "NA":
        return None
    v = props.get("MAX_B_H_M")
    return float(v) if isinstance(v, (int, float)) and v > 0 else None


def fsr_value(props: dict):
    v = props.get("FSR")
    return float(v) if isinstance(v, (int, float)) and v > 0 else None


def lot_value(props: dict):
    v = props.get("LOT_SIZE")
    if not isinstance(v, (int, float)) or v <= 0:
        return None
    units = (props.get("UNITS") or "").strip()
    if units == "ha":
        return float(v) * 10_000.0
    if units in ("m²", "m2", ""):
        return float(v)
    return None


# The *-additional layers are clause-application areas ("CA", "Street
# Frontage") that the EPI_Primary service folds into HOB/FSR/LSZ. They mark
# where an LEP clause varies the mapped standard and, bar four HOB features,
# carry no number. The mapped base value still applies beneath them, so the
# base layer supplies every number; an additional feature WITH a number (HOB
# MAX_B_H_M) overrides the base where it lies.
CONTROLS = {
    "height": ("nsw-hob", "nsw-hob-additional", hob_value),
    "fsr": ("nsw-fsr", "nsw-fsr-additional", fsr_value),
    "lot": ("nsw-lotsize", "nsw-lotsize-additional", lot_value),
}


# --- Geometry helpers ----------------------------------------------------------
def polygonal(geom):
    import shapely
    from shapely.geometry import MultiPolygon

    if geom is None or geom.is_empty:
        return MultiPolygon()
    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom
    parts = [p for p in shapely.get_parts(geom) if p.geom_type in ("Polygon", "MultiPolygon")]
    return shapely.union_all(parts) if parts else MultiPolygon()


def clean_one(geom):
    import shapely

    geom = polygonal(shapely.make_valid(geom))
    try:
        return polygonal(shapely.make_valid(shapely.set_precision(geom, GRID)))
    except shapely.errors.GEOSException:
        return polygonal(geom.buffer(0))


def iter_features(layer_dir: Path):
    if not (layer_dir / ".done").exists():
        raise SystemExit(f"{layer_dir}: no .done marker — the page set is incomplete; refusing")
    for page in sorted(layer_dir.glob("page-*.geojsonl")):
        with page.open() as fh:
            for line in fh:
                line = line.strip()
                if line:
                    yield json.loads(line)


def load(layer_dir: Path, keep):
    """Stream a layer, keep features `keep(props)` returns non-None for, and
    project + clean their geometry. -> (geoms[3577], payloads)."""
    import numpy as np
    import pyproj
    import shapely
    from shapely.geometry import shape

    to_albers = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:3577", always_xy=True).transform
    geoms, payloads = [], []
    for feature in iter_features(layer_dir):
        geometry = feature.get("geometry")
        if not geometry:
            continue
        payload = keep(feature.get("properties") or {})
        if payload is None:
            continue
        geom = shape(geometry)
        if geom.is_empty:
            continue
        geom = shapely.transform(geom, lambda xy: np.column_stack(to_albers(xy[:, 0], xy[:, 1])))
        geom = clean_one(geom)
        if geom.is_empty:
            continue
        geoms.append(geom)
        payloads.append(payload)
    return np.array(geoms, dtype=object), payloads


def load_suburbs(path: Path):
    import geopandas as gpd

    suburbs = gpd.read_file(path)
    if suburbs.crs is None:
        suburbs = suburbs.set_crs("EPSG:7844")
    suburbs = suburbs.to_crs("EPSG:3577")
    out = []
    for _, row in suburbs.iterrows():
        sal = str(row.get("SAL_CODE21") or row.get("id") or "").strip()
        out.append((sal, clean_one(row.geometry) if row.geometry is not None else None))
    return out


def weighted_median(pairs):
    """pairs: [(value, area)] -> the value at the 50% cumulative area."""
    pairs = sorted(pairs)
    total = sum(a for _, a in pairs)
    if total <= 0:
        return None
    acc = 0.0
    for value, area in pairs:
        acc += area
        if acc >= total / 2.0:
            return value
    return pairs[-1][0]


def r4(x):
    return None if x is None else round(float(x), 4)


# --- The per-state build --------------------------------------------------------
_G: dict = {}  # fork-shared state for worker processes


def prepare(state: str, root: Path, suburbs_path: Path) -> None:
    import numpy as np
    from shapely.strtree import STRtree

    cfg = STATES[state]
    vec = root / "vector"
    _G.clear()
    _G["state"] = state
    _G["suburbs"] = load_suburbs(suburbs_path)

    zoning_geoms, zoning_meta = [], []
    for layer, tier in cfg["zoning"]:
        def keep(props, layer=layer, tier=tier):
            fam = family_for(layer, props)  # raises on an unmapped code
            t = tier if tier is not None else (0 if props.get("EPI_TYPE") == "SEPP" else 1)
            return (t, fam, layer, tuple(instrument_for(layer, props, fam)))

        g, p = load(vec / layer, keep)
        zoning_geoms.extend(g)
        zoning_meta.extend(p)
        print(f"  {layer}: {len(g)} zone polygons", flush=True)
    if zoning_geoms:
        _G["zoning"] = np.array(zoning_geoms, dtype=object)
        _G["zoning_meta"] = zoning_meta
        _G["zoning_tree"] = STRtree(_G["zoning"])

    hlayer = cfg["heritage"]
    if hlayer == "tas-heritage":
        _G["tas_lps_areas"], _G["tas_lps_items"] = set(), set()
        for feature in iter_features(vec / hlayer):
            props = feature.get("properties") or {}
            cls = heritage_class(hlayer, props)
            if cls is None:
                continue
            (_G["tas_lps_areas"] if cls[0] else _G["tas_lps_items"]).add((props.get("LPS") or "").strip())
        print(f"  tas-heritage: LPS mapping areas {len(_G['tas_lps_areas'])}, places {len(_G['tas_lps_items'])}", flush=True)
    g, p = load(vec / hlayer, lambda props: heritage_class(hlayer, props))
    _G["heritage_layer"] = hlayer
    areas = [geom for geom, (is_area, _) in zip(g, p) if is_area]
    if hlayer in HAS_HERITAGE_AREAS:
        _G["heritage_areas"] = np.array(areas, dtype=object)
        _G["heritage_tree"] = STRtree(_G["heritage_areas"]) if areas else None
    if hlayer in HAS_HERITAGE_ITEMS:
        # One representative point per item (its largest polygon), so an item
        # spanning a suburb boundary is counted once, in one suburb.
        best: dict = {}
        for geom, (_, key) in zip(g, p):
            if key is None:
                continue
            if key not in best or geom.area > best[key].area:
                best[key] = geom
        pts = [best[k].representative_point() for k in sorted(best, key=repr)]
        _G["item_points"] = np.array(pts, dtype=object)
        _G["item_tree"] = STRtree(_G["item_points"]) if pts else None
        print(f"  {hlayer}: {len(areas)} area polygons, {len(pts)} distinct items", flush=True)
    else:
        print(f"  {hlayer}: {len(areas)} area polygons (no item count)", flush=True)

    if cfg.get("controls"):
        for name, (base, extra, value_fn) in CONTROLS.items():
            bg, bp = load(vec / base, lambda props, f=value_fn: (f(props),))
            xg, xp = load(vec / extra, lambda props, f=value_fn: (f(props),) if f(props) is not None else None)
            _G[f"ctl_{name}"] = (bg, [v for (v,) in bp], STRtree(bg), xg, [v for (v,) in xp],
                                 STRtree(xg) if len(xg) else None)
            print(f"  {name}: {len(bg)} base polygons, {len(xg)} numeric clause polygons", flush=True)
        g, p = load(vec / "nsw-landapp",
                    lambda props: (props.get("EPI_NAME") or "").strip() if props.get("LAY_CLASS") in NSW_LANDAPP_CLASSES else None)
        _G["landapp"] = (g, p, STRtree(g))
        print(f"  nsw-landapp: {len(g)} application polygons", flush=True)


def clip(geoms, sub):
    import shapely

    out = shapely.intersection(geoms, sub, grid_size=GRID)
    return [polygonal(g) for g in out]


def control_stats(name: str, residential):
    import shapely

    bg, bv, btree, xg, xv, xtree = _G[f"ctl_{name}"]
    pieces = []  # (value, geom)
    override = None
    if xtree is not None:
        idx = xtree.query(residential, predicate="intersects")
        if len(idx):
            parts = clip(xg[idx], residential)
            for value, geom in zip([xv[i] for i in idx], parts):
                if not geom.is_empty and value is not None:
                    pieces.append((value, geom))
            if pieces:
                override = shapely.union_all([gm for _, gm in pieces], grid_size=GRID)
    idx = btree.query(residential, predicate="intersects")
    if len(idx):
        parts = clip(bg[idx], residential)
        for value, geom in zip([bv[i] for i in idx], parts):
            if geom.is_empty or value is None:
                continue
            if override is not None:
                geom = polygonal(shapely.difference(geom, override, grid_size=GRID))
                if geom.is_empty:
                    continue
            pieces.append((value, geom))
    pairs = [(v, g.area) for v, g in pieces if g.area > 0]
    if not pairs:
        return None, None
    median = weighted_median(pairs)
    substantial = [v for v, a in pairs if a >= MAX_SLIVER_M2]
    return median, (max(substantial) if substantial else max(v for v, _ in pairs))


def suburb_row(i: int):
    import shapely

    sal, sub = _G["suburbs"][i]
    state = _G["state"]
    cfg = STATES[state]
    row: dict = {"licence": cfg["licence"]}
    if sub is None or sub.is_empty or sub.area <= 0:
        return sal, None
    area = sub.area
    instruments: dict[str, float] = defaultdict(float)
    covered = None

    if "zoning" in _G:
        idx = _G["zoning_tree"].query(sub, predicate="intersects")
        groups: dict = defaultdict(list)
        sources = set()
        if len(idx):
            parts = clip(_G["zoning"][idx], sub)
            for j, geom in zip(idx, parts):
                if geom.is_empty:
                    continue
                tier, fam, layer, insts = _G["zoning_meta"][j]
                groups[(tier, fam)].append(geom)
                sources.add(ZONING_SOURCE[layer])
                for name in insts:
                    instruments[name] += geom.area
        fam_area = {f: 0.0 for f in FAMILIES}
        residential = []
        for tier in sorted({t for t, _ in groups}):
            for fam in FAMILIES:
                if (tier, fam) not in groups:
                    continue
                g = polygonal(shapely.union_all(groups[(tier, fam)], grid_size=GRID))
                if covered is not None:
                    g = polygonal(shapely.difference(g, covered, grid_size=GRID))
                if g.is_empty:
                    continue
                fam_area[fam] += g.area
                if fam in RESIDENTIAL:
                    residential.append(g)
                covered = g if covered is None else polygonal(shapely.union(covered, g, grid_size=GRID))
        cov = 0.0 if covered is None else min(100.0, covered.area / area * 100.0)
        row["zoningCoveragePct"] = r4(cov)
        row["zoningSource"] = "+".join(sorted(sources)) if sources else ZONING_SOURCE[cfg["zoning"][0][0]]
        if cov > 0:
            shares = {f: r4(min(100.0, a / area * 100.0)) for f, a in fam_area.items()}
            row["zoneSharesPct"] = {f: v for f, v in shares.items() if v and v > 0}
            row["dominantZoneFamily"] = max(FAMILIES, key=lambda f: (fam_area[f], -FAMILIES.index(f)))
            if cfg.get("controls") and residential:
                res = polygonal(shapely.union_all(residential, grid_size=GRID))
                if not res.is_empty and res.area > 0:
                    h_med, h_max = control_stats("height", res)
                    f_med, _ = control_stats("fsr", res)
                    l_med, _ = control_stats("lot", res)
                    row["nswHeightMedianM"] = r4(h_med)
                    row["nswHeightMaxM"] = r4(h_max)
                    row["nswFsrMedian"] = r4(f_med)
                    row["nswMinLotMedianM2"] = r4(l_med)
                    row["nswResidentialSharePct"] = r4(res.area / area * 100.0)

    zoned = "zoning" not in _G or (covered is not None and covered.area > 0)
    hlayer = _G["heritage_layer"]
    measure_areas = hlayer in HAS_HERITAGE_AREAS
    measure_items = hlayer in HAS_HERITAGE_ITEMS
    if hlayer == "tas-heritage":
        lps = governing_tas_lps(instruments)
        measure_areas = lps in _G["tas_lps_areas"]
        measure_items = lps in _G["tas_lps_items"]
    if zoned and (measure_areas or measure_items):
        row["heritageSource"] = HERITAGE_SOURCE[hlayer]
        if measure_areas:
            tree = _G.get("heritage_tree")
            share = 0.0
            if tree is not None:
                idx = tree.query(sub, predicate="intersects")
                if len(idx):
                    parts = [g for g in clip(_G["heritage_areas"][idx], sub) if not g.is_empty]
                    if parts:
                        share = shapely.union_all(parts, grid_size=GRID).area / area * 100.0
            row["heritageSharePct"] = r4(min(100.0, share))
        if measure_items:
            tree = _G.get("item_tree")
            row["heritageItemCount"] = int(len(tree.query(sub, predicate="contains"))) if tree is not None else 0

    if cfg.get("controls") and zoned:
        g, names, tree = _G["landapp"]
        idx = tree.query(sub, predicate="intersects")
        for j in idx:
            a = shapely.intersection(g[j], sub).area
            if names[j]:
                instruments[names[j]] = max(instruments[names[j]], a)
    named = sorted(
        ((n, a) for n, a in instruments.items() if a / area * 100.0 >= INSTRUMENT_MIN_SHARE),
        key=lambda t: (-round(t[1] / area * 100.0, 1), t[0]),
    )
    if named:
        row["planningInstruments"] = [n for n, _ in named]
    return sal, row


TAS_LPS_PREFIX = "Tasmanian Planning Scheme – "


def governing_tas_lps(instruments: dict) -> str:
    """The Local Provisions Schedule zoning the largest part of a TAS suburb
    ('' for Kingborough's interim scheme or no zoning)."""
    best = max(instruments.items(), key=lambda t: (t[1], t[0]), default=(None, 0))[0]
    if not best or not best.startswith(TAS_LPS_PREFIX):
        return ""
    return best[len(TAS_LPS_PREFIX):]


def _work(indices):
    return [suburb_row(i) for i in indices]


def build_state(state: str, root: Path, suburbs_path: Path, workers: int) -> dict:
    prepare(state, root, suburbs_path)
    n = len(_G["suburbs"])
    print(f"  {n} suburbs; {workers} workers", flush=True)
    chunks = [list(range(i, n, max(1, workers * 8))) for i in range(max(1, workers * 8))]
    rows: dict = {}
    if workers > 1:
        ctx = mp.get_context("fork")
        with ctx.Pool(workers) as pool:
            for done, part in enumerate(pool.imap_unordered(_work, chunks), 1):
                for sal, row in part:
                    if row is not None:
                        rows[sal] = row
                if done % max(1, len(chunks) // 10) == 0:
                    print(f"  … {done}/{len(chunks)} chunks", flush=True)
    else:
        for sal, row in _work(range(n)):
            if row is not None:
                rows[sal] = row
    return dict(sorted(rows.items()))


def merge(in_dir: Path) -> dict:
    merged: dict = {}
    for path in sorted(in_dir.glob("*.json")):
        state = path.stem
        if state not in STATES:
            raise SystemExit(f"{path}: not a planning state intermediate")
        for sal, row in json.loads(path.read_text()).items():
            if sal in merged:
                raise SystemExit(f"{sal}: present in two state files")
            row["licence"] = STATES[state]["licence"]
            merged[sal] = row
    return dict(sorted(merged.items()))


def main() -> None:
    parser = argparse.ArgumentParser(description="Per-SAL planning layer")
    sub = parser.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("state")
    s.add_argument("--state", required=True, choices=sorted(STATES))
    s.add_argument("--root", type=Path, required=True)
    s.add_argument("--suburbs", type=Path, required=True)
    s.add_argument("--out", type=Path, required=True)
    s.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    m = sub.add_parser("merge")
    m.add_argument("--in-dir", type=Path, required=True)
    m.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.cmd == "state":
        rows = build_state(args.state, args.root, args.suburbs, args.workers)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(rows, separators=(",", ":"), sort_keys=True, ensure_ascii=False) + "\n")
        zoned = sum(1 for r in rows.values() if (r.get("zoningCoveragePct") or 0) > 0)
        print(f"wrote {args.out}: {len(rows)} suburbs, {zoned} with any zoning")
    else:
        rows = merge(args.in_dir)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(rows, separators=(",", ":"), sort_keys=True, ensure_ascii=False) + "\n")
        print(f"wrote {args.out}: {len(rows)} suburbs ({args.out.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
