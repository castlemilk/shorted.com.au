#!/usr/bin/env python3
"""Harmonised zoning families: every state's statutory zone vocabulary mapped
onto one cross-state set of ten families (program decision 8).

    res_low          low-density / large-lot / neighbourhood residential
    res_medium_high  general / medium / high-density residential
    centre_mixed     commercial centres, mixed use, business
    industrial       industrial / employment / enterprise
    rural            rural, primary production, rural living
    conservation     environmental conservation / management, national park
    open_space       public / private recreation, open space
    infrastructure   special purpose, roads, rail, airports, utilities,
                     health / education precincts
    water            waterway zones
    other            growth area (use set later by a structure plan), deferred,
                     unzoned, or no family fits

An unknown code is an ERROR, never a silent `other`: `family_for` raises, the
share build aborts, and `test_planning.py` checks every code in the committed
vocabulary snapshot (`zone_codes.json`, taken from the fetch manifest) maps.
When a source publishes a new code, the build fails until a human places it.

Keys are the source's own labels, exactly as fetched:
  NSW  "SYM_CODE | LAY_CLASS" — the pair, because codes are reused: "E2" is
       Commercial Centre in the 2023 employment-zone reform but Environmental
       Conservation in the pre-reform LEPs that still carry it; "E4" is General
       Industrial or Environmental Living; "E" is Environment or a SEPP
       Commercial Core.
  VIC  zone_code with the trailing schedule number stripped (GRZ1 -> GRZ; IN1Z
       stays IN1Z because its digit is part of the zone name).
  SA   P&D Code zone name (`name`).
  TAS  TPS zone name (`ZONE`); Kingborough's interim scheme is keyed by its
       label with the clause number stripped ("10.0 General Residential" ->
       "General Residential").
  ACT  Territory Plan code (`LAND_USE_ZONE_CODE_ID`).
"""

from __future__ import annotations

import re

FAMILIES: tuple[str, ...] = (
    "res_low",
    "res_medium_high",
    "centre_mixed",
    "industrial",
    "rural",
    "conservation",
    "open_space",
    "infrastructure",
    "water",
    "other",
)

FAMILY_LABELS: dict[str, str] = {
    "res_low": "Low-density residential",
    "res_medium_high": "General / medium / high-density residential",
    "centre_mixed": "Centres & mixed use",
    "industrial": "Industrial & employment",
    "rural": "Rural",
    "conservation": "Conservation",
    "open_space": "Open space & recreation",
    "infrastructure": "Infrastructure & special purpose",
    "water": "Waterways",
    "other": "Growth area, deferred or unzoned",
}

# --- NSW: Standard Instrument LEPs + SEPP precinct zoning -------------------
# Keyed by "SYM_CODE | LAY_CLASS". The 2023 employment-zone reform replaced the
# B*/IN* zones with E1–E5 + MU1 + W4 + SP4/SP5; a handful of pre-reform LEPs
# and SEPP precincts still carry legacy or bespoke codes, mapped by purpose.
NSW: dict[str, str] = {
    # Residential
    "R2 | Low Density Residential": "res_low",
    "R5 | Large Lot Residential": "res_low",
    "2(a) | Residential (Low Density)": "res_low",
    "R1 | General Residential": "res_medium_high",
    "R3 | Medium Density Residential": "res_medium_high",
    "R4 | High Density Residential": "res_medium_high",
    "R | Residential": "res_medium_high",  # SEPP precinct generic residential
    "RESI | Residential": "res_medium_high",
    "A | Residential Zone - Medium Density Residential": "res_medium_high",
    # Centres, mixed use, business (post-reform E1/E2/E3 + MU1; legacy B1–B7)
    "E1 | Local Centre": "centre_mixed",
    "E2 | Commercial Centre": "centre_mixed",
    "E3 | Productivity Support": "centre_mixed",
    "MU1 | Mixed Use": "centre_mixed",
    "MU | Mixed Use": "centre_mixed",
    "B1 | Neighbourhood Centre": "centre_mixed",
    "B2 | Local Centre": "centre_mixed",
    "B3 | Commercial Core": "centre_mixed",
    "B4 | Mixed Use": "centre_mixed",
    "B5 | Business Development": "centre_mixed",
    "B6 | Enterprise Corridor": "centre_mixed",
    "B7 | Business Park": "centre_mixed",  # the reform folded B7 into E3
    "B | Business Zone - Local Centre": "centre_mixed",
    "C | Business Zone - Business Park": "centre_mixed",
    "D | Business Zone - Mixed Use": "centre_mixed",
    "E | Business Zone - Commercial Core": "centre_mixed",
    "RESB | Residential – Business": "centre_mixed",  # a mixed residential/business zone
    # Industrial / employment / enterprise
    "E4 | General Industrial": "industrial",
    "E5 | Heavy Industrial": "industrial",
    "IN1 | General Industrial": "industrial",
    "IN2 | Light Industrial": "industrial",
    "IN3 | Heavy Industrial": "industrial",
    "ENT | Enterprise": "industrial",  # Aerotropolis SEPP enterprise zone
    "EM | Employment": "industrial",
    "EP | Employment": "industrial",
    "REZ | Regional Enterprise Zone": "industrial",
    "PAE | Port and Employment": "industrial",
    # Aerotropolis Agribusiness: food processing and logistics employment land,
    # not farmland — its objectives are employment objectives.
    "AGB | Agribusiness": "industrial",
    # Rural (the Standard Instrument's RU group, including RU5 Village, stays
    # rural here even though VIC/SA/TAS townships are residential zones — each
    # state's own zone grouping decides)
    "RU1 | Primary Production": "rural",
    "RU2 | Rural Landscape": "rural",
    "RU3 | Forestry": "rural",
    "RU4 | Primary Production Small Lots": "rural",
    "RU5 | Village": "rural",
    "RU6 | Transition": "rural",
    "RUR | Rural": "rural",
    "RAZ | Rural Activity Zone": "rural",
    "RAC | Rural Activity Zone": "rural",
    "SET | Settlement": "rural",  # Lord Howe Island settlement zone
    # Conservation (C1–C4 + legacy E1–E4 environment zones + SEPP equivalents)
    "C1 | National Parks and Nature Reserves": "conservation",
    "C2 | Environmental Conservation": "conservation",
    "C3 | Environmental Management": "conservation",
    "C4 | Environmental Living": "conservation",
    "E2 | Environmental Conservation": "conservation",
    "E4 | Environmental Living": "conservation",
    "E | Environment": "conservation",
    "ECO | Environmental Conservation": "conservation",
    "ENP | Environment Protection": "conservation",
    "7(a) | Environmental Protection (Wetlands and Littoral Rainforests)": "conservation",
    "7(l) | Environmental Protection (Habitat)": "conservation",
    "PEP | Permanent Park Preserve": "conservation",
    # Aerotropolis "Environment and Recreation": creek corridors and riparian
    # land first, recreation second.
    "ENZ | Environment and Recreation": "conservation",
    # Open space & recreation
    "RE1 | Public Recreation": "open_space",
    "RE2 | Private Recreation": "open_space",
    "REC | Recreation": "open_space",
    "PRC | Public Recreation": "open_space",
    "PRR | Public Recreation - Regional": "open_space",
    "REPL | Public Recreation – Preferred Locations": "open_space",
    "RP | Regional Park": "open_space",
    "RO | Regional Open Space": "open_space",
    "OSP | Open Space": "open_space",
    "P | Parkland": "open_space",
    "H | Recreation Zone - Public Recreation": "open_space",
    "I | Recreation Zone - Private Recreation": "open_space",
    # Special purpose / infrastructure. SP1–SP3 are decision 8's "special
    # purpose". SP4 and SP5 are NOT, despite the prefix: the 2023 employment-
    # zone reform created them to carry employment land and the Sydney CBD —
    # SP5 Metropolitan Centre is the former B8 (only Sydney LEP 2012 uses it)
    # and SP4 Enterprise holds enterprise/business-park land. Mapping them by
    # prefix painted the Sydney CBD as "infrastructure"; decision 8 places
    # "commercial centres" in centre_mixed and "enterprise" in industrial.
    "SP1 | Special Activities": "infrastructure",
    "SP2 | Infrastructure": "infrastructure",
    "SP3 | Tourist": "infrastructure",
    "SP4 | Enterprise": "industrial",
    "SP5 | Metropolitan Centre": "centre_mixed",
    "SPU | Special Uses": "infrastructure",
    "SUS | Special Uses": "infrastructure",
    "G | Special Purposes Zone - Infrastructure": "infrastructure",
    "F | Special Purposes Zone - Comminity": "infrastructure",  # sic, source spelling
    "T | Tourism": "infrastructure",  # consistent with SP3 Tourist
    "RW | Road and Road Widening": "infrastructure",
    "RLWY | Railways": "infrastructure",
    "DR | Drainage": "infrastructure",
    # Waterways
    "W1 | Natural Waterways": "water",
    "W2 | Recreational Waterways": "water",
    "W3 | Working Waterways": "water",
    "W4 | Working Waterfront": "water",
    "W | Waterway": "water",
    "WFU | Waterfront Use": "water",
    "MAP | Marine Park": "water",
    # Deferred / unzoned / future urban without a structure plan
    "DM | Deferred Matter": "other",
    "UL | Unzoned Land": "other",
    "U | Unzoned": "other",
    "UD | Urban Development": "other",  # future urban land, use not yet fixed
    "2(c) | Urban Expansion": "other",  # ditto (legacy)
    "UR | Urban": "other",
}

# --- VIC: Victoria Planning Provisions (plan_zone.zone_code, schedule stripped)
VIC: dict[str, str] = {
    "NRZ": "res_low",
    "LDRZ": "res_low",
    # Township Zone sits in the VPP's residential-zone group (clause 32.05):
    # small-town residential with incidental other uses.
    "TZ": "res_low",
    "GRZ": "res_medium_high",
    "R1Z": "res_medium_high",  # pre-2014 code, described as General Residential
    "RGZ": "res_medium_high",
    "HCTZ": "res_medium_high",  # Housing Choice and Transport Zone (2025)
    "ACZ": "centre_mixed",
    "C1Z": "centre_mixed",
    "C2Z": "centre_mixed",
    "B1Z": "centre_mixed",  # legacy codes, all described as Commercial 1/2
    "B2Z": "centre_mixed",
    "B3Z": "centre_mixed",
    "B4Z": "centre_mixed",
    "B5Z": "centre_mixed",
    "MUZ": "centre_mixed",
    "CCZ": "centre_mixed",
    "DZ": "centre_mixed",  # Docklands: mixed residential/commercial
    # Precinct Zone (2024): activity-centre / Suburban Rail Loop precincts
    # rezoned for mixed-use intensification.
    "PRZ": "centre_mixed",
    "IN1Z": "industrial",
    "IN2Z": "industrial",
    "IN3Z": "industrial",
    "FZ": "rural",
    "RLZ": "rural",
    "RAZ": "rural",
    "GWZ": "rural",
    "GWAZ": "rural",
    "PCRZ": "conservation",
    # Rural Conservation Zone: its first purpose is conserving the landscape and
    # environmental values; agriculture is permitted only where compatible.
    "RCZ": "conservation",
    "PPRZ": "open_space",
    "PUZ": "infrastructure",
    "TRZ": "infrastructure",
    "PZ": "infrastructure",
    # Special Use Zone: site-specific schedules (universities, hospitals,
    # showgrounds, quarries, racecourses) — decision 8's "special purpose".
    "SUZ": "infrastructure",
    "UFZ": "water",  # Urban Floodway: waterways and major floodpaths
    # Urban Growth Zone: growth-area land whose uses are set by a Precinct
    # Structure Plan applied later; before that the zone itself says nothing
    # about density or use.
    "UGZ": "other",
    # Comprehensive Development Zone: one schedule per master-planned site with
    # site-specific uses; no family can be read off the zone.
    "CDZ": "other",
    # Priority Development Zone: regionally significant redevelopment sites
    # governed by an incorporated plan; purpose varies by schedule.
    "PDZ": "other",
    # "Commonwealth land not controlled by planning scheme": defence, airports,
    # Commonwealth offices — outside the state scheme, i.e. unzoned by it.
    "CA": "other",
}

# --- SA: Planning and Design Code zones (name) ------------------------------
SA: dict[str, str] = {
    "Established Neighbourhood": "res_low",
    "Suburban Neighbourhood": "res_low",
    "Neighbourhood": "res_low",
    "Hills Neighbourhood": "res_low",
    "Rural Neighbourhood": "res_low",
    "Township Neighbourhood": "res_low",
    "Waterfront Neighbourhood": "res_low",
    "Township": "res_low",  # small-town residential with incidental other uses
    "Master Planned Township": "res_low",
    "General Neighbourhood": "res_medium_high",  # the Code's "general" infill zone
    "Housing Diversity Neighbourhood": "res_medium_high",
    "Urban Neighbourhood": "res_medium_high",
    "Urban Renewal Neighbourhood": "res_medium_high",
    "Master Planned Neighbourhood": "res_medium_high",
    "Master Planned Renewal": "res_medium_high",
    "City Living": "res_medium_high",
    "Residential Park": "res_medium_high",
    "Urban Corridor (Living)": "res_medium_high",
    "Local Activity Centre": "centre_mixed",
    "Suburban Activity Centre": "centre_mixed",
    "Urban Activity Centre": "centre_mixed",
    "Township Activity Centre": "centre_mixed",
    "Township Main Street": "centre_mixed",
    "Suburban Main Street": "centre_mixed",
    "Suburban Business": "centre_mixed",
    "Business Neighbourhood": "centre_mixed",
    "Urban Corridor (Main Street)": "centre_mixed",
    "Urban Corridor (Business)": "centre_mixed",
    "Urban Corridor (Boulevard)": "centre_mixed",
    "City Main Street": "centre_mixed",
    "Capital City": "centre_mixed",
    "City Riverbank": "centre_mixed",
    # Home Industry: dwellings with attached light-industry workshops — a mixed
    # zone, not an industrial estate.
    "Home Industry ": "centre_mixed",  # sic, trailing space in the source
    "Employment": "industrial",
    "Strategic Employment": "industrial",
    "Employment (Bulk Handling)": "industrial",
    "Employment (Enterprise)": "industrial",
    "Strategic Innovation": "industrial",  # Tonsley / Lot Fourteen employment precincts
    "Resource Extraction": "industrial",  # quarries and mines
    "Rural": "rural",
    "Rural Living": "rural",
    "Rural Settlement": "rural",
    "Rural Shack Settlement": "rural",
    "Rural Horticulture": "rural",
    "Rural Aquaculture": "rural",
    "Rural Intensive Enterprise": "rural",
    "Productive Rural Landscape": "rural",
    "Remote Areas": "rural",
    "Conservation": "conservation",
    "Hills Face": "conservation",
    "Open Space": "open_space",
    "Recreation": "open_space",
    "Adelaide Park Lands": "open_space",
    "Golf Course Estate": "open_space",  # the course is most of the zone's area
    "Community Facilities": "infrastructure",
    "Infrastructure": "infrastructure",
    "Infrastructure (Airfield)": "infrastructure",
    "Infrastructure (Ferry and Marina Facilities)": "infrastructure",
    "Commonwealth Facilities": "infrastructure",
    "Motorsport Park": "infrastructure",
    "Caravan and Tourist Park": "infrastructure",  # consistent with NSW SP3 Tourist
    "Tourism Development": "infrastructure",
    "Coastal Waters and Offshore Islands": "water",
    "Deferred Urban": "other",
    # Workers' Settlement: a workforce accommodation camp; no family fits.
    "Workers' Settlement": "other",
}

# --- TAS: Tasmanian Planning Scheme State Planning Provisions zones ---------
TAS: dict[str, str] = {
    "Low Density Residential": "res_low",
    "Village": "res_low",
    "General Residential": "res_medium_high",
    "Inner Residential": "res_medium_high",
    "Urban Mixed Use": "centre_mixed",
    "Local Business": "centre_mixed",
    "General Business": "centre_mixed",
    "Central Business": "centre_mixed",
    "Commercial": "centre_mixed",
    "Light Industrial": "industrial",
    "General Industrial": "industrial",
    "Rural": "rural",
    "Rural Living": "rural",
    "Agriculture": "rural",
    "Rural Resource": "rural",  # Kingborough interim
    "Environmental Management": "conservation",
    "Landscape Conservation": "conservation",
    "Environmental Living": "conservation",  # Kingborough interim; like NSW C4
    "Open Space": "open_space",
    "Recreation": "open_space",
    "Utilities": "infrastructure",
    "Community Purpose": "infrastructure",
    "Port and Marine": "infrastructure",
    "Major Tourism": "infrastructure",
    # Particular Purpose Zones are site-specific (university, hospital, specific
    # developments) — decision 8's "special purpose".
    "Particular Purpose": "infrastructure",
    "Future Urban": "other",
}

# --- ACT: Territory Plan land use zones -------------------------------------
ACT: dict[str, str] = {
    "RZ1": "res_low",  # Suburban
    "RZ2": "res_medium_high",  # Suburban Core — the multi-unit intensification band
    "RZ3": "res_medium_high",
    "RZ4": "res_medium_high",
    "RZ5": "res_medium_high",
    "CZ1": "centre_mixed",
    "CZ2": "centre_mixed",
    "CZ3": "centre_mixed",
    "CZ4": "centre_mixed",
    "CZ5": "centre_mixed",
    "CZ6": "centre_mixed",  # Leisure and Accommodation — a commercial zone
    "IZ1": "industrial",
    "IZ2": "industrial",
    "NUZ1": "rural",  # Broadacre
    "NUZ2": "rural",
    "NUZ3": "conservation",  # Hills, Ridges and Buffer
    "NUZ4": "conservation",  # River Corridor
    "NUZ5": "conservation",  # Mountains and Bushlands
    "PRZ1": "open_space",
    "PRZ2": "open_space",
    "TSZ1": "infrastructure",
    "TSZ2": "infrastructure",
    "CF": "infrastructure",
    # Designated land is planned by the National Capital Authority under the
    # National Capital Plan, not zoned by the Territory Plan.
    "DES": "other",
}

_TRAILING_DIGITS = re.compile(r"\d+$")
_CLAUSE_PREFIX = re.compile(r"^\d+(\.\d+)?\s+")


class UnknownZoneCode(KeyError):
    """A source code no family map places. Never defaulted to `other`."""


def vic_family_key(zone_code: str) -> str:
    return _TRAILING_DIGITS.sub("", (zone_code or "").strip())


def kingborough_key(zone_label: str) -> str:
    return _CLAUSE_PREFIX.sub("", (zone_label or "").strip())


def zone_key(layer: str, props: dict) -> str:
    """The vocabulary key a feature's properties map by, per source layer."""
    if layer == "nsw-zoning":
        return f"{props.get('SYM_CODE')} | {props.get('LAY_CLASS')}"
    if layer == "vic-zoning":
        return vic_family_key(props.get("zone_code") or "")
    if layer == "sa-zones":
        return props.get("name") or ""
    if layer == "tas-zones":
        return props.get("ZONE") or ""
    if layer == "tas-zones-kingborough-interim":
        return kingborough_key(props.get("ZONE") or "")
    if layer == "act-zones":
        return props.get("LAND_USE_ZONE_CODE_ID") or ""
    raise ValueError(f"not a zoning layer: {layer}")


MAPS: dict[str, dict[str, str]] = {
    "nsw-zoning": NSW,
    "vic-zoning": VIC,
    "sa-zones": SA,
    "tas-zones": TAS,
    "tas-zones-kingborough-interim": TAS,
    "act-zones": ACT,
}


def family_for(layer: str, props: dict) -> str:
    key = zone_key(layer, props)
    try:
        return MAPS[layer][key]
    except KeyError:
        raise UnknownZoneCode(f"{layer}: unmapped zone {key!r} — add it to zone_families.py") from None


def _self_check() -> None:
    for name, table in (("NSW", NSW), ("VIC", VIC), ("SA", SA), ("TAS", TAS), ("ACT", ACT)):
        bad = {k: v for k, v in table.items() if v not in FAMILIES}
        if bad:
            raise AssertionError(f"{name}: families outside the harmonised set: {bad}")


_self_check()
