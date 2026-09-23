"""Tests for the planning build. Run with the DEM venv (geometry tests need
shapely/pyproj; the vocabulary tests are pure Python):

    /Volumes/gamma-systems-2/shorted-dem/venv/bin/python -m unittest \
        web/scripts/geo/planning/test_planning.py -v
"""

import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

import zone_families as z  # noqa: E402

VOCAB = json.loads((HERE / "zone_codes.json").read_text())


def fam(layer, **props):
    return z.family_for(layer, props)


class VocabularyIsFullyMapped(unittest.TestCase):
    """Every zone code the fetched sources carry maps to a family — an unknown
    code must fail the build, never slide silently into `other`."""

    def test_every_nsw_code_maps(self):
        for key in VOCAB["nsw"]:
            code, cls = key.split(" | ", 1)
            self.assertIn(fam("nsw-zoning", SYM_CODE=code, LAY_CLASS=cls), z.FAMILIES, key)

    def test_every_vic_code_maps(self):
        for key in VOCAB["vic"]:
            code = key.split(" | ", 1)[0]
            self.assertIn(fam("vic-zoning", zone_code=code), z.FAMILIES, key)

    def test_every_sa_zone_maps(self):
        for key in VOCAB["sa"]:
            self.assertIn(fam("sa-zones", name=key.split(" | ", 1)[1]), z.FAMILIES, key)

    def test_every_tas_zone_maps(self):
        for key in VOCAB["tas"]:
            self.assertIn(fam("tas-zones", ZONE=key), z.FAMILIES, key)
        for key in VOCAB["tas_kingborough_interim"]:
            self.assertIn(fam("tas-zones-kingborough-interim", ZONE=key), z.FAMILIES, key)

    def test_every_act_zone_maps(self):
        for key in VOCAB["act"]:
            self.assertIn(fam("act-zones", LAND_USE_ZONE_CODE_ID=key.split(" | ", 1)[0]), z.FAMILIES, key)

    def test_an_unknown_code_raises_instead_of_defaulting(self):
        with self.assertRaises(z.UnknownZoneCode):
            fam("nsw-zoning", SYM_CODE="R9", LAY_CLASS="Hyper Density Residential")
        with self.assertRaises(z.UnknownZoneCode):
            fam("vic-zoning", zone_code="XYZ1")
        with self.assertRaises(z.UnknownZoneCode):
            fam("sa-zones", name="Lunar Neighbourhood")
        with self.assertRaises(z.UnknownZoneCode):
            fam("act-zones", LAND_USE_ZONE_CODE_ID="RZ9")

    def test_every_family_is_used_and_labelled(self):
        used = set()
        for table in (z.NSW, z.VIC, z.SA, z.TAS, z.ACT):
            used |= set(table.values())
        self.assertEqual(used, set(z.FAMILIES))
        self.assertEqual(set(z.FAMILY_LABELS), set(z.FAMILIES))

    def test_no_mapping_entry_is_dead(self):
        """A mapping entry nobody fetched is either a typo or stale; flag it."""
        live = {
            "NSW": set(VOCAB["nsw"]),
            "VIC": {z.vic_family_key(k.split(" | ", 1)[0]) for k in VOCAB["vic"]},
            "SA": {k.split(" | ", 1)[1] for k in VOCAB["sa"]},
            "TAS": set(VOCAB["tas"]) | {z.kingborough_key(k) for k in VOCAB["tas_kingborough_interim"]},
            "ACT": {k.split(" | ", 1)[0] for k in VOCAB["act"]},
        }
        for name, table in (("NSW", z.NSW), ("VIC", z.VIC), ("SA", z.SA), ("TAS", z.TAS), ("ACT", z.ACT)):
            self.assertEqual(set(table) - live[name], set(), name)


class KnownExemplars(unittest.TestCase):
    def nsw(self, code, cls):
        return fam("nsw-zoning", SYM_CODE=code, LAY_CLASS=cls)

    def test_nsw(self):
        self.assertEqual(self.nsw("R2", "Low Density Residential"), "res_low")
        self.assertEqual(self.nsw("R3", "Medium Density Residential"), "res_medium_high")
        self.assertEqual(self.nsw("R4", "High Density Residential"), "res_medium_high")
        # 2023 employment-zone reform: E1–E3 and MU1 are centres, E4 is industrial
        for code, cls in [("E1", "Local Centre"), ("E2", "Commercial Centre"), ("E3", "Productivity Support"), ("MU1", "Mixed Use")]:
            self.assertEqual(self.nsw(code, cls), "centre_mixed", code)
        self.assertEqual(self.nsw("E4", "General Industrial"), "industrial")
        # …but pre-reform LEPs reuse E2/E4 for environment zones
        self.assertEqual(self.nsw("E2", "Environmental Conservation"), "conservation")
        self.assertEqual(self.nsw("E4", "Environmental Living"), "conservation")
        for code, cls in [("C1", "National Parks and Nature Reserves"), ("C2", "Environmental Conservation"),
                          ("C3", "Environmental Management"), ("C4", "Environmental Living")]:
            self.assertEqual(self.nsw(code, cls), "conservation", code)
        self.assertEqual(self.nsw("RE1", "Public Recreation"), "open_space")
        self.assertEqual(self.nsw("RE2", "Private Recreation"), "open_space")
        for code, cls in [("SP1", "Special Activities"), ("SP2", "Infrastructure"), ("SP3", "Tourist")]:
            self.assertEqual(self.nsw(code, cls), "infrastructure", code)
        # Deliberate deviation from a prefix rule: SP5 is the Sydney CBD, SP4
        # enterprise land (decision 8: "commercial centres", "enterprise").
        self.assertEqual(self.nsw("SP5", "Metropolitan Centre"), "centre_mixed")
        self.assertEqual(self.nsw("SP4", "Enterprise"), "industrial")
        for code, cls in [("W1", "Natural Waterways"), ("W2", "Recreational Waterways"),
                          ("W3", "Working Waterways"), ("W4", "Working Waterfront")]:
            self.assertEqual(self.nsw(code, cls), "water", code)
        for code, cls in [("RU1", "Primary Production"), ("RU2", "Rural Landscape"), ("RU5", "Village")]:
            self.assertEqual(self.nsw(code, cls), "rural", code)
        self.assertEqual(self.nsw("DM", "Deferred Matter"), "other")
        self.assertEqual(self.nsw("UL", "Unzoned Land"), "other")

    def test_vic(self):
        v = lambda code: fam("vic-zoning", zone_code=code)  # noqa: E731
        self.assertEqual(v("NRZ1"), "res_low")
        for code in ("GRZ1", "GRZ12", "RGZ3"):
            self.assertEqual(v(code), "res_medium_high", code)
        for code in ("ACZ2", "C1Z", "MUZ", "CCZ1"):
            self.assertEqual(v(code), "centre_mixed", code)
        self.assertEqual(v("IN1Z"), "industrial")
        self.assertEqual(v("IN3Z"), "industrial")
        for code in ("FZ", "FZ1", "GWZ4", "RLZ1", "RAZ"):
            self.assertEqual(v(code), "rural", code)
        self.assertEqual(v("PCRZ"), "conservation")
        self.assertEqual(v("PPRZ"), "open_space")
        # RDZ (the pre-2018 Road Zone) no longer exists: TRZ replaced it, and a
        # code nobody publishes would be a dead mapping entry.
        for code in ("PUZ1", "PUZ7", "SUZ2", "TRZ1", "TRZ3"):
            self.assertEqual(v(code), "infrastructure", code)
        # Growth-area / site-specific zones say nothing about use until a plan applies
        for code in ("UGZ", "UGZ14", "CDZ1", "PDZ2", "CA"):
            self.assertEqual(v(code), "other", code)
        # the schedule digit is stripped, but a zone's own digit is kept
        self.assertEqual(z.vic_family_key("IN1Z"), "IN1Z")
        self.assertEqual(z.vic_family_key("GRZ12"), "GRZ")

    def test_sa_tas_act(self):
        self.assertEqual(fam("sa-zones", name="Established Neighbourhood"), "res_low")
        self.assertEqual(fam("sa-zones", name="General Neighbourhood"), "res_medium_high")
        self.assertEqual(fam("sa-zones", name="Housing Diversity Neighbourhood"), "res_medium_high")
        self.assertEqual(fam("sa-zones", name="Suburban Activity Centre"), "centre_mixed")
        self.assertEqual(fam("sa-zones", name="Strategic Employment"), "industrial")
        self.assertEqual(fam("sa-zones", name="Adelaide Park Lands"), "open_space")
        self.assertEqual(fam("sa-zones", name="Deferred Urban"), "other")
        self.assertEqual(fam("tas-zones", ZONE="General Residential"), "res_medium_high")
        self.assertEqual(fam("tas-zones", ZONE="Low Density Residential"), "res_low")
        self.assertEqual(fam("tas-zones", ZONE="Environmental Management"), "conservation")
        self.assertEqual(fam("tas-zones-kingborough-interim", ZONE="10.0 General Residential"), "res_medium_high")
        self.assertEqual(fam("tas-zones-kingborough-interim", ZONE="26.0 Rural Resource"), "rural")
        self.assertEqual(fam("act-zones", LAND_USE_ZONE_CODE_ID="RZ1"), "res_low")
        self.assertEqual(fam("act-zones", LAND_USE_ZONE_CODE_ID="RZ4"), "res_medium_high")
        self.assertEqual(fam("act-zones", LAND_USE_ZONE_CODE_ID="CZ1"), "centre_mixed")
        self.assertEqual(fam("act-zones", LAND_USE_ZONE_CODE_ID="PRZ1"), "open_space")
        self.assertEqual(fam("act-zones", LAND_USE_ZONE_CODE_ID="DES"), "other")


try:
    import shapely  # noqa: F401
    import planning_share as ps
except ImportError:  # pragma: no cover - vocabulary tests still run without GEOS
    ps = None


@unittest.skipIf(ps is None, "needs shapely/pyproj (use the DEM venv)")
class ShareGeometry(unittest.TestCase):
    """Drive suburb_row against a synthetic state with hand-computable areas."""

    def setUp(self):
        import numpy as np
        from shapely.geometry import Point, box
        from shapely.strtree import STRtree

        self.box = box
        ps._G.clear()
        ps._G["state"] = "NSW"
        # A 100 m x 100 m suburb (1 ha) and one no instrument reaches.
        ps._G["suburbs"] = [("10001", box(0, 0, 100, 100)), ("10002", box(1000, 1000, 1100, 1100))]
        zoning = [
            box(0, 0, 60, 100),    # LEP R2: 60%, 10% of it under the SEPP
            box(40, 0, 100, 50),   # SEPP R4: 30% — tier 0, claims the overlap
            box(60, 50, 100, 80),  # LEP RE1: 12%
        ]  # uncovered: x 60–100, y 80–100 = 8%
        ps._G["zoning"] = np.array(zoning, dtype=object)
        ps._G["zoning_meta"] = [
            (1, "res_low", "nsw-zoning", ("Test LEP 2020",)),
            (0, "res_medium_high", "nsw-zoning", ("Test SEPP 2021",)),
            (1, "open_space", "nsw-zoning", ("Test LEP 2020",)),
        ]
        ps._G["zoning_tree"] = STRtree(ps._G["zoning"])
        ps._G["heritage_layer"] = "nsw-heritage"
        ps._G["heritage_areas"] = np.array([box(0, 0, 10, 100), box(5, 0, 15, 100)], dtype=object)  # 15% after union
        ps._G["heritage_tree"] = STRtree(ps._G["heritage_areas"])
        ps._G["item_points"] = np.array([Point(50, 50), Point(99, 99), Point(500, 500)], dtype=object)
        ps._G["item_tree"] = STRtree(ps._G["item_points"])
        # Height: 9 m over x<80, 30 m over x≥80, and a numeric clause area
        # (x<20) overriding the 9 m beneath it with 12 m.
        hob = [box(0, 0, 80, 100), box(80, 0, 100, 100)]
        extra = [box(0, 0, 20, 100)]
        ps._G["ctl_height"] = (np.array(hob, dtype=object), [9.0, 30.0], STRtree(hob),
                               np.array(extra, dtype=object), [12.0], STRtree(extra))
        fsr = [box(0, 0, 100, 100)]
        ps._G["ctl_fsr"] = (np.array(fsr, dtype=object), [0.5], STRtree(fsr), np.array([], dtype=object), [], None)
        lot = [box(0, 0, 50, 100), box(50, 0, 100, 100)]
        ps._G["ctl_lot"] = (np.array(lot, dtype=object), [450.0, 700.0], STRtree(lot), np.array([], dtype=object), [], None)
        landapp = [box(0, 0, 100, 100)]
        ps._G["landapp"] = (np.array(landapp, dtype=object), ["Test LEP 2020"], STRtree(landapp))

    def test_family_shares_resolve_overlaps_and_sum_to_coverage(self):
        sal, row = ps.suburb_row(0)
        self.assertEqual(sal, "10001")
        shares = row["zoneSharesPct"]
        # SEPP R4 (tier 0) claims its 30% first; LEP R2 keeps 60 − 10 = 50%.
        self.assertAlmostEqual(shares["res_medium_high"], 30.0, places=3)
        self.assertAlmostEqual(shares["res_low"], 50.0, places=3)
        self.assertAlmostEqual(shares["open_space"], 12.0, places=3)
        self.assertAlmostEqual(row["zoningCoveragePct"], 92.0, places=3)
        self.assertAlmostEqual(sum(shares.values()), row["zoningCoveragePct"], places=3)
        self.assertEqual(row["dominantZoneFamily"], "res_low")
        self.assertNotIn("industrial", shares)  # absent = 0, encoded by omission

    def test_heritage_share_unions_before_dividing_and_items_count_once(self):
        _, row = ps.suburb_row(0)
        self.assertAlmostEqual(row["heritageSharePct"], 15.0, places=3)
        self.assertEqual(row["heritageItemCount"], 2)
        self.assertEqual(row["heritageSource"], "nsw_epi_heritage")

    def test_controls_are_area_weighted_over_residential_land_only(self):
        _, row = ps.suburb_row(0)
        # Residential land = R2 ∪ R4 = 8,000 m² (80%). Height over it: 12 m on
        # 2,000 (the clause override), 9 m on 5,000, 30 m on 1,000 → the
        # area-weighted median is 9 m and the max 30 m. The open-space strip
        # under the 30 m polygon (x≥80, y 50–80) is not residential.
        self.assertAlmostEqual(row["nswResidentialSharePct"], 80.0, places=3)
        self.assertEqual(row["nswHeightMedianM"], 9.0)
        self.assertEqual(row["nswHeightMaxM"], 30.0)
        self.assertEqual(row["nswFsrMedian"], 0.5)
        # Lot: 450 m² on 5,000 m² of residential land, 700 m² on 3,000.
        self.assertEqual(row["nswMinLotMedianM2"], 450.0)

    def test_a_clause_area_overrides_the_base_value_beneath_it(self):
        import numpy as np
        from shapely.strtree import STRtree

        hob, values, tree, _, _, _ = ps._G["ctl_height"]
        extra = [self.box(0, 0, 60, 100)]  # 12 m over 6,000 of the 8,000 m²
        ps._G["ctl_height"] = (hob, values, tree, np.array(extra, dtype=object), [12.0], STRtree(extra))
        _, row = ps.suburb_row(0)
        self.assertEqual(row["nswHeightMedianM"], 12.0)

    def test_instruments_are_named_largest_first(self):
        _, row = ps.suburb_row(0)
        self.assertEqual(row["planningInstruments"], ["Test LEP 2020", "Test SEPP 2021"])

    def test_a_suburb_no_instrument_reaches_is_zero_coverage_and_null_everything_else(self):
        sal, row = ps.suburb_row(1)
        self.assertEqual(sal, "10002")
        self.assertEqual(row["zoningCoveragePct"], 0.0)
        for key in ("zoneSharesPct", "dominantZoneFamily", "heritageSharePct", "heritageItemCount",
                    "nswHeightMedianM", "planningInstruments"):
            self.assertNotIn(key, row, key)

    def test_weighted_median(self):
        self.assertEqual(ps.weighted_median([(9, 60), (30, 40)]), 9)
        self.assertEqual(ps.weighted_median([(9, 40), (30, 60)]), 30)
        self.assertIsNone(ps.weighted_median([]))


@unittest.skipIf(ps is None, "needs shapely/pyproj (use the DEM venv)")
class TasHeritageCoverageMask(unittest.TestCase):
    """TAS councils map the heritage code one by one; an unmapped class in the
    governing LPS is NULL (not mapped), never a measured 0."""

    def build(self, lps_areas, lps_items):
        import numpy as np
        from shapely.geometry import Point, box
        from shapely.strtree import STRtree

        ps._G.clear()
        ps._G["state"] = "TAS"
        ps._G["suburbs"] = [("60001", box(0, 0, 100, 100))]
        zoning = [box(0, 0, 100, 100)]
        ps._G["zoning"] = np.array(zoning, dtype=object)
        ps._G["zoning_meta"] = [(0, "res_medium_high", "tas-zones",
                                 ("Tasmanian Planning Scheme – Hobart Local Provisions Schedule",))]
        ps._G["zoning_tree"] = STRtree(ps._G["zoning"])
        ps._G["heritage_layer"] = "tas-heritage"
        ps._G["heritage_areas"] = np.array([box(0, 0, 50, 100)], dtype=object)
        ps._G["heritage_tree"] = STRtree(ps._G["heritage_areas"])
        ps._G["item_points"] = np.array([], dtype=object)
        ps._G["item_tree"] = None
        ps._G["tas_lps_areas"] = set(lps_areas)
        ps._G["tas_lps_items"] = set(lps_items)
        return ps.suburb_row(0)[1]

    def test_places_unmapped_by_the_lps_are_null(self):
        row = self.build({"Hobart Local Provisions Schedule"}, set())
        self.assertAlmostEqual(row["heritageSharePct"], 50.0, places=3)
        self.assertNotIn("heritageItemCount", row)

    def test_places_mapped_by_the_lps_count_a_measured_zero(self):
        row = self.build({"Hobart Local Provisions Schedule"}, {"Hobart Local Provisions Schedule"})
        self.assertEqual(row["heritageItemCount"], 0)

    def test_an_lps_mapping_nothing_has_no_heritage_at_all(self):
        row = self.build(set(), set())
        self.assertNotIn("heritageSharePct", row)
        self.assertNotIn("heritageSource", row)


@unittest.skipIf(ps is None, "needs shapely/pyproj (use the DEM venv)")
class ControlValues(unittest.TestCase):
    def test_height_ignores_rl_elevations(self):
        self.assertEqual(ps.hob_value({"UNITS": "m", "MAX_B_H_M": 8.5}), 8.5)
        self.assertIsNone(ps.hob_value({"UNITS": "m(RL)", "MAX_B_H_M": 40}))
        self.assertIsNone(ps.hob_value({"UNITS": "m (RL)", "MAX_B_H_M": 40}))
        self.assertIsNone(ps.hob_value({"UNITS": "m", "MAX_B_H_M": None}))

    def test_lot_size_normalises_hectares(self):
        self.assertEqual(ps.lot_value({"UNITS": "ha", "LOT_SIZE": 40}), 400_000.0)
        self.assertEqual(ps.lot_value({"UNITS": "m²", "LOT_SIZE": 450}), 450.0)
        self.assertEqual(ps.lot_value({"UNITS": "m2", "LOT_SIZE": 450}), 450.0)
        self.assertIsNone(ps.lot_value({"UNITS": "m²", "LOT_SIZE": None}))

    def test_heritage_classes(self):
        self.assertEqual(ps.heritage_class("nsw-heritage", {"LAY_CLASS": "Conservation Area - General"}), (True, None))
        self.assertEqual(ps.heritage_class("nsw-heritage", {"LAY_CLASS": "Item - General", "EPI_NAME": "X", "H_ID": "I1"})[0], False)
        self.assertIsNone(ps.heritage_class("nsw-heritage", {"LAY_CLASS": "Aboriginal Object"}))
        self.assertIsNone(ps.heritage_class("nsw-heritage", {"LAY_CLASS": "Conservation Area - Aboriginal"}))
        self.assertIsNone(ps.heritage_class("sa-overlays", {"name": "Heritage Adjacency"}))
        self.assertEqual(ps.heritage_class("sa-overlays", {"name": "Historic Area"}), (True, None))
        self.assertIsNone(ps.heritage_class("tas-heritage", {"OV_NAME": "Significant trees"}))
        self.assertIsNone(ps.heritage_class("act-heritage", {"HRcategory": "Natural place or object"}))

    def test_vic_scheme_names(self):
        self.assertEqual(ps.vic_scheme_name("GREATER GEELONG"), "Greater Geelong Planning Scheme")
        self.assertEqual(ps.vic_scheme_name("MERRI-BEK"), "Merri-bek Planning Scheme")
        self.assertEqual(ps.vic_scheme_name("MOUNT BULLER ALPINE RESORT (UNINC)"), "Alpine Resorts Planning Scheme")

    def test_tas_governing_lps(self):
        self.assertEqual(ps.governing_tas_lps({
            "Tasmanian Planning Scheme – Hobart Local Provisions Schedule": 900.0,
            "Tasmanian Planning Scheme – Clarence Local Provisions Schedule": 100.0,
        }), "Hobart Local Provisions Schedule")
        self.assertEqual(ps.governing_tas_lps({"Kingborough Interim Planning Scheme 2015": 1.0}), "")


if __name__ == "__main__":
    unittest.main()
