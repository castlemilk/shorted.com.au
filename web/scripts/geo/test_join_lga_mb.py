import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).with_name("join-lga-mb.py")
SPEC = importlib.util.spec_from_file_location("join_lga_mb", MODULE_PATH)
join = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(join)


def alloc(rows):
    """[(mb, code, name, state, area)] -> read_allocation's shape."""
    return {mb: (code, name, state, area) for mb, code, name, state, area in rows}


class SuburbSharesTest(unittest.TestCase):
    def test_persons_weight_the_split_and_the_dominant_comes_first(self):
        basis, shares = join.suburb_shares({"A": [30, 10, 5.0], "B": [70, 40, 1.0]})
        self.assertEqual(basis, "persons")
        self.assertEqual(shares, [("B", 0.7), ("A", 0.3)])

    def test_dwellings_then_area_when_nobody_lives_there(self):
        basis, shares = join.suburb_shares({"A": [0, 1, 9.0], "B": [0, 3, 1.0]})
        self.assertEqual((basis, shares[0]), ("dwellings", ("B", 0.75)))
        basis, shares = join.suburb_shares({"A": [0, 0, 9.0], "B": [0, 0, 1.0]})
        self.assertEqual((basis, shares[0][0]), ("area", "A"))
        self.assertAlmostEqual(shares[0][1], 0.9)

    def test_ties_break_on_code_so_reruns_are_identical(self):
        _, shares = join.suburb_shares({"20000": [5, 0, 0.0], "10000": [5, 0, 0.0]})
        self.assertEqual([s[0] for s in shares], ["10000", "20000"])


class BridgeEntryTest(unittest.TestCase):
    def test_overlaps_keep_every_council_at_or_above_one_percent(self):
        entry = join.bridge_entry([("A", 0.9), ("B", 0.095), ("C", 0.005)])
        self.assertEqual(entry["lga"], "A")
        self.assertEqual(entry["share"], 0.9)
        self.assertEqual(entry["overlaps"], [{"lga": "A", "share": 0.9}, {"lga": "B", "share": 0.095}])

    def test_a_single_council_suburb_carries_no_overlap_list(self):
        self.assertEqual(join.bridge_entry([("A", 0.996), ("B", 0.004)]), {"lga": "A", "share": 0.996})

    def test_shares_are_not_renormalised_after_the_cut(self):
        entry = join.bridge_entry([("A", 0.5), ("B", 0.49), ("C", 0.01), ("D", 0.0)])
        self.assertAlmostEqual(sum(o["share"] for o in entry["overlaps"]), 1.0)
        entry = join.bridge_entry([("A", 0.6), ("B", 0.395), ("C", 0.005)])
        self.assertAlmostEqual(sum(o["share"] for o in entry["overlaps"]), 0.995)


class BuildBridgeTest(unittest.TestCase):
    def test_suburb_shares_are_summed_across_its_mesh_blocks(self):
        sal = alloc([
            ("m1", "S1", "Straddle", "New South Wales", 1.0),
            ("m2", "S1", "Straddle", "New South Wales", 1.0),
            ("m3", "S1", "Straddle", "New South Wales", 1.0),
            ("m4", "S2", "Empty", "New South Wales", 3.0),
        ])
        lga = alloc([
            ("m1", "L1", "One", "New South Wales", 1.0),
            ("m2", "L1", "One", "New South Wales", 1.0),
            ("m3", "L2", "Two", "New South Wales", 1.0),
            ("m4", "L2", "Two", "New South Wales", 3.0),
        ])
        counts = {"m1": (10, 4), "m2": (30, 12), "m3": (60, 20)}
        bridge, bases, missing = join.build_bridge(sal, lga, counts)
        self.assertEqual(missing, [])
        self.assertEqual(bridge["S1"]["lga"], "L2")
        self.assertEqual(bridge["S1"]["overlaps"], [{"lga": "L2", "share": 0.6}, {"lga": "L1", "share": 0.4}])
        # No persons, no dwellings: falls back to area rather than dropping it.
        self.assertEqual((bridge["S2"], bases["S2"]), ({"lga": "L2", "share": 1.0}, "area"))

    def test_a_mesh_block_missing_from_the_lga_file_is_reported(self):
        _, _, missing = join.build_bridge(alloc([("m9", "S", "S", "Victoria", 1.0)]), {}, {})
        self.assertEqual(missing, ["m9"])


class IdentityTest(unittest.TestCase):
    def test_kind_is_pinned_by_code_for_pseudo_areas(self):
        self.assertEqual(join.classify_kind("19499", "No usual address (NSW)"), "pseudo")
        self.assertEqual(join.classify_kind("99799", "Migratory - Offshore - Shipping (OT)"), "pseudo")
        self.assertEqual(join.classify_kind("ZZZZZ", "Outside Australia"), "pseudo")
        self.assertEqual(join.classify_kind("19399", "Unincorporated NSW"), "unincorporated")
        self.assertEqual(join.classify_kind("99399", "Unincorp. Other Territories"), "unincorporated")
        self.assertEqual(join.classify_kind("11250", "Broken Hill"), "council")
        # A council whose code merely contains 9499 is not a pseudo-area.
        self.assertEqual(join.classify_kind("19490", "Somewhere"), "council")

    def test_display_name_cuts_only_the_state_suffix(self):
        self.assertEqual(join.display_name("Campbelltown (NSW)"), "Campbelltown")
        self.assertEqual(join.display_name("Bayside (Vic.)"), "Bayside")
        self.assertEqual(join.display_name("Kingston (Tas.)"), "Kingston")
        self.assertEqual(join.display_name("Merri-bek"), "Merri-bek")
        self.assertEqual(join.display_name("Unincorporated NSW"), "Unincorporated NSW")

    def test_facts_leave_pseudo_areas_without_land_or_dwellings(self):
        lga = alloc([
            ("m1", "10050", "Albury", "New South Wales", 2.25),
            ("m2", "19499", "No usual address (NSW)", "New South Wales", 0.0),
            ("m3", "51710", "Christmas Island", "Other Territories", 1.0),
        ])
        facts = join.build_facts(lga, {"m1": (100, 40), "m2": (7, 0), "m3": (5, 0)}, {"10050": (-36.0, 146.9)})
        self.assertEqual(facts["10050"]["areaSqkm"], 2.2)
        self.assertEqual(facts["10050"]["dwellings"], 40)
        self.assertEqual((facts["10050"]["centroidLat"], facts["10050"]["centroidLon"]), (-36.0, 146.9))
        self.assertEqual(facts["19499"]["areaSqkm"], None)
        self.assertEqual(facts["19499"]["dwellings"], None)
        self.assertEqual(facts["19499"]["kind"], "pseudo")
        # Other Territories gets a state code; a measured 0 dwellings stays 0.
        self.assertEqual(facts["51710"]["stateCode"], "OT")
        self.assertEqual(facts["51710"]["dwellings"], 0)


class CentroidTest(unittest.TestCase):
    def square(self, x0, y0, size, clockwise=False):
        ring = [[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size], [x0, y0]]
        return ring[::-1] if clockwise else ring

    def test_square_centroid_either_winding(self):
        for cw in (False, True):
            lat, lon = join.polygon_centroid({"type": "Polygon", "coordinates": [self.square(150, -34, 1, cw)]})
            self.assertAlmostEqual(lat, -33.5, places=3)
            self.assertAlmostEqual(lon, 150.5, places=3)

    def test_multipolygon_weights_by_area(self):
        geom = {"type": "MultiPolygon", "coordinates": [[self.square(150, -34, 2)], [self.square(160, -34, 0.01)]]}
        _, lon = join.polygon_centroid(geom)
        self.assertLess(abs(lon - 151.0), 0.01)

    def test_a_hole_pulls_the_centroid_away(self):
        outer = self.square(150, -34, 2)
        hole = self.square(150.0, -34.0, 1, clockwise=True)
        _, lon = join.polygon_centroid({"type": "Polygon", "coordinates": [outer, hole]})
        self.assertGreater(lon, 151.0)

    def test_missing_geometry_is_absent_not_zero(self):
        self.assertIsNone(join.polygon_centroid(None))
        self.assertIsNone(join.polygon_centroid({"type": "Polygon", "coordinates": []}))


if __name__ == "__main__":
    unittest.main()
