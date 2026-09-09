import importlib.util
import json
import sys
import tempfile
from pathlib import Path
import unittest

import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

import wofs_zonal_stats as wofs  # noqa: E402
import merge_hazards  # noqa: E402


class WofsShareTest(unittest.TestCase):
    def test_nan_never_enters_either_side(self):
        freq = [np.nan, 0.0, 0.02, 0.5, 0.95, 1.0]
        inside = [True] * 6
        result = wofs.summarise_cells(freq, inside, minimum_cells=3)
        self.assertEqual(result["sampledCellCount"], 5)
        # 0.02 and 0.5 are observed-but-not-permanent; 0.95 and 1.0 permanent
        self.assertEqual(result["waterObservedSharePct"], 40.0)
        self.assertEqual(result["permanentWaterSharePct"], 40.0)

    def test_cells_outside_geometry_are_ignored(self):
        freq = [0.5, 0.5, 0.0]
        inside = [True, False, True]
        result = wofs.summarise_cells(freq, inside, minimum_cells=1)
        self.assertEqual(result["sampledCellCount"], 2)
        self.assertEqual(result["waterObservedSharePct"], 50.0)

    def test_below_floor_is_null_not_zero(self):
        result = wofs.summarise_cells([0.0, 0.0], [True, True], minimum_cells=3)
        self.assertEqual(result["sampledCellCount"], 2)
        self.assertIsNone(result["waterObservedSharePct"])
        self.assertIsNone(result["permanentWaterSharePct"])

    def test_dry_suburb_is_a_genuine_zero(self):
        result = wofs.summarise_cells([0.0] * 30, [True] * 30)
        self.assertEqual(result["waterObservedSharePct"], 0.0)
        self.assertEqual(result["permanentWaterSharePct"], 0.0)

    def test_low_confidence_cells_count_as_dry_land_not_as_missing(self):
        freq = [0.5, 0.5, 0.5, 0.0]
        conf = [0.05, -1.0, 0.9, 0.9]  # below cutoff, nodata, confident, confident
        result = wofs.summarise_cells(freq, [True] * 4, minimum_cells=1, confidence=conf)
        self.assertEqual(result["sampledCellCount"], 4)
        self.assertEqual(result["waterObservedSharePct"], 25.0)
        self.assertEqual(wofs.CONFIDENCE_MIN, 0.1)

    def test_thresholds_are_the_published_ones(self):
        self.assertEqual(wofs.OBSERVED_MIN_FREQUENCY, 0.01)
        self.assertEqual(wofs.PERMANENT_MIN_FREQUENCY, 0.90)
        self.assertEqual(wofs.MINIMUM_VALID_CELL_COUNT, 25)

    def test_accumulator_matches_single_pass(self):
        rng = np.random.default_rng(1)
        freq = rng.random(1000)
        inside = rng.random(1000) > 0.3
        single = wofs.summarise_cells(freq, inside)
        acc = wofs.ShareAccumulator()
        acc.add(freq[:400], inside[:400])
        acc.add(freq[400:], inside[400:])
        self.assertEqual(acc.result(), single)


class MergeTest(unittest.TestCase):
    def _write(self, tmp, states, vectors):
        wdir = Path(tmp) / "wofs"
        vdir = Path(tmp) / "vector"
        wdir.mkdir()
        vdir.mkdir()
        for st, rows in states.items():
            (wdir / f"{st}.json").write_text(json.dumps(rows))
        for name, rows in vectors.items():
            (vdir / f"{name}.json").write_text(json.dumps(rows))
        return wdir, vdir

    def _full_states(self, extra=None):
        base = {st: {} for st in merge_hazards.STATES}
        base["NSW"] = {"10001": {"sampledCellCount": 100, "waterObservedSharePct": 1.5, "permanentWaterSharePct": 0.0}}
        base["VIC"] = {"20001": {"sampledCellCount": 100, "waterObservedSharePct": 0.0, "permanentWaterSharePct": 2.0}}
        if extra:
            base.update(extra)
        return base

    def test_vector_layers_attach_and_absent_states_stay_null(self):
        with tempfile.TemporaryDirectory() as tmp:
            wdir, vdir = self._write(tmp, self._full_states(), {"nsw-flood": {"10001": 12.5}})
            merged = merge_hazards.merge(wdir, vdir)
        self.assertEqual(merged["10001"]["floodPlanningSharePct"], 12.5)
        self.assertIsNone(merged["10001"]["bushfireProneSharePct"])
        self.assertIsNone(merged["20001"]["floodPlanningSharePct"])

    def test_missing_wofs_state_refuses(self):
        states = self._full_states()
        del states["TAS"]
        with tempfile.TemporaryDirectory() as tmp:
            wdir, vdir = self._write(tmp, states, {})
            with self.assertRaises(SystemExit):
                merge_hazards.merge(wdir, vdir)

    def test_vector_row_for_wrong_state_refuses(self):
        with tempfile.TemporaryDirectory() as tmp:
            wdir, vdir = self._write(tmp, self._full_states(), {"nsw-flood": {"20001": 1.0}})
            with self.assertRaises(SystemExit):
                merge_hazards.merge(wdir, vdir)


if __name__ == "__main__":
    unittest.main()
