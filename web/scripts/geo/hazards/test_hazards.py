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
import vector_share  # noqa: E402


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


def box(x0, y0, x1, y1):
    from shapely.geometry import box as shapely_box

    return shapely_box(x0, y0, x1, y1)


class CoverageMaskTest(unittest.TestCase):
    """Units are metres (the script works in EPSG:3577); suburbs are 100 x 100."""

    SUBURB = box(0, 0, 100, 100)

    def test_without_masks_an_untouched_suburb_is_a_genuine_zero(self):
        self.assertEqual(vector_share.masked_share(self.SUBURB, []), (0.0, 100.0))

    def test_outside_every_instrument_is_null_not_zero(self):
        # NSW: a suburb outside all twelve flood-mapping EPIs has no map, so no
        # polygon there says nothing about flooding.
        share, covered = vector_share.masked_share(self.SUBURB, [], coverage=[])
        self.assertIsNone(share)
        self.assertEqual(covered, 0.0)

    def test_fully_covered_suburb_with_no_polygon_is_a_measured_zero(self):
        share, covered = vector_share.masked_share(self.SUBURB, [], coverage=[box(-50, -50, 150, 150)])
        self.assertEqual((share, covered), (0.0, 100.0))

    def test_partly_covered_suburb_divides_by_its_covered_land(self):
        # Half the suburb is inside the instrument, and half of THAT is mapped
        # flood planning land: 50% of what the source speaks for, not 25%.
        share, covered = vector_share.masked_share(
            self.SUBURB, [box(0, 0, 50, 50)], coverage=[box(0, 0, 50, 100)])
        self.assertEqual(covered, 50.0)
        self.assertEqual(share, 50.0)

    def test_a_boundary_sliver_of_coverage_does_not_speak_for_the_suburb(self):
        share, covered = vector_share.masked_share(
            self.SUBURB, [box(0, 0, 5, 100)], coverage=[box(0, 0, 5, 100)])
        self.assertIsNone(share)
        self.assertEqual(covered, 5.0)

    def test_unassessed_land_is_carved_out_of_coverage(self):
        # SA: "Evidence Required" land is precautionary — the Code says flood
        # risk there is unknown — so it is neither in nor out of the overlay.
        share, covered = vector_share.masked_share(
            self.SUBURB, [box(0, 0, 10, 100)], unassessed=[box(50, 0, 100, 100)])
        self.assertEqual(covered, 50.0)
        self.assertEqual(share, 20.0)

    def test_suburb_that_is_all_unassessed_is_null(self):
        share, _ = vector_share.masked_share(self.SUBURB, [], unassessed=[box(-1, -1, 101, 101)])
        self.assertIsNone(share)

    def test_unassessed_mask_with_no_polygon_nearby_leaves_the_suburb_covered(self):
        self.assertEqual(vector_share.masked_share(self.SUBURB, [], unassessed=[]), (0.0, 100.0))


class RasterShareTest(unittest.TestCase):
    """The streamed-grid path QLD bushfire uses: 10 m cells over a 1 km square."""

    def _grid(self, burnt):
        import rasterio
        from rasterio.features import rasterize

        transform = rasterio.Affine(10, 0, 0, 0, -10, 1000)
        grid = np.zeros((100, 100), dtype="uint8")
        if burnt:
            rasterize(((g, 1) for g in burnt), out=grid, transform=transform)
        return grid, transform

    def test_share_of_burnt_cells_inside_the_suburb(self):
        grid, transform = self._grid([box(0, 0, 500, 1000)])
        self.assertEqual(vector_share.raster_share(grid, transform, box(0, 0, 1000, 1000)), 50.0)
        self.assertEqual(vector_share.raster_share(grid, transform, box(600, 0, 1000, 1000)), 0.0)

    def test_overlapping_polygons_count_once(self):
        grid, transform = self._grid([box(0, 0, 500, 1000), box(0, 0, 500, 1000)])
        self.assertEqual(vector_share.raster_share(grid, transform, box(0, 0, 1000, 1000)), 50.0)

    def test_a_suburb_smaller_than_the_cell_floor_still_gets_a_value(self):
        # 3 x 3 cells whose centres are inside is under MIN_RASTER_CELLS; the
        # touched-cell read must still find the burnt land rather than report 0.
        grid, transform = self._grid([box(0, 0, 1000, 1000)])
        self.assertEqual(vector_share.raster_share(grid, transform, box(102, 102, 128, 128)), 100.0)

    def test_suburb_off_the_grid_is_zero_not_an_error(self):
        grid, transform = self._grid([box(0, 0, 1000, 1000)])
        self.assertEqual(vector_share.raster_share(grid, transform, box(5000, 5000, 5100, 5100)), 0.0)


if __name__ == "__main__":
    unittest.main()
