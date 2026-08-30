import importlib.util
import math
from pathlib import Path
import unittest

import numpy as np


MODULE_PATH = Path(__file__).with_name("ga_dem_zonal_stats.py")
SPEC = importlib.util.spec_from_file_location("ga_dem_zonal_stats", MODULE_PATH)
ga_dem = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ga_dem)


class SummariseValidCellsTest(unittest.TestCase):
    def test_nodata_and_non_finite_cells_are_excluded_from_both_sides(self):
        result = ga_dem.summarise_valid_cells(
            [0.5, None, float("nan"), -9999, 2.0, 6.0],
            [1, 100, 100, 100, 1, 2],
            nodata=-9999,
            minimum_cells=3,
        )

        self.assertEqual(result["sampledCellCount"], 3)
        self.assertEqual(result["elevationMinM"], 0.5)
        self.assertEqual(result["elevationMedianM"], 2.0)
        self.assertEqual(result["elevationMaxM"], 6.0)
        self.assertEqual(result["landShareBelow1m"], 25.0)
        self.assertEqual(result["landShareBelow2m"], 25.0)
        self.assertEqual(result["landShareBelow5m"], 50.0)

    def test_too_few_valid_cells_returns_null_metrics_not_zero(self):
        result = ga_dem.summarise_valid_cells(
            [0.25, None, 8.0],
            [1, 1, 1],
            nodata=None,
            minimum_cells=3,
        )

        self.assertEqual(result["sampledCellCount"], 2)
        for key, value in result.items():
            if key != "sampledCellCount":
                self.assertIsNone(value, key)

    def test_named_production_floor_is_25_cells(self):
        self.assertEqual(ga_dem.MINIMUM_VALID_CELL_COUNT, 25)

    def test_array_input_matches_list_input(self):
        """An ndarray and the equivalent list must summarise identically.

        build_artifact passes arrays; the cases above pass lists. They share one
        implementation, so this pins the two entry shapes to the same answer.
        """
        values = [0.5, float("nan"), -9999.0, 2.0, 6.0, 11.0]
        weights = [1.0, 100.0, 100.0, 1.0, 2.0, 4.0]
        from_list = ga_dem.summarise_valid_cells(
            values, weights, nodata=-9999, minimum_cells=3
        )
        from_array = ga_dem.summarise_valid_cells(
            np.asarray(values, dtype=np.float32),
            np.asarray(weights, dtype=float),
            nodata=-9999,
            minimum_cells=3,
        )
        self.assertEqual(from_list, from_array)


class MemoryContractTest(unittest.TestCase):
    """The largest SAL is 1.9e9 cells; per-cell overhead is not affordable there.

    Coral Sea's bounding box is 36397x52406. At ~40 bytes of Python object per
    cell the old list() cost ~76 GB on its own, and a second raster-sized float64
    weight grid added ~15 GB — the run died before producing a statistic. These
    tests pin the two properties that keep peak memory proportional to the answer
    rather than to the bounding box.
    """

    def test_as_float_array_does_not_copy_an_existing_float_array(self):
        source = np.arange(16, dtype=float)
        self.assertIs(ga_dem._as_float_array(source), source)

    def test_as_float_array_still_maps_none_to_nan_for_lists(self):
        result = ga_dem._as_float_array([1.0, None, 3.0])
        self.assertTrue(math.isnan(result[1]))
        self.assertEqual(list(result[[0, 2]]), [1.0, 3.0])

    def test_row_weights_match_the_full_grid_they_replace(self):
        from rasterio.transform import from_origin
        from rasterio.crs import CRS

        transform = from_origin(149.0, -35.0, 1 / 3600.0, 1 / 3600.0)
        crs = CRS.from_epsg(4326)
        rows, columns = 12, 7
        full = ga_dem._pixel_area_weights(transform, crs, (rows, columns))
        per_row = ga_dem._row_area_weights(transform, crs, rows)

        self.assertEqual(per_row.shape, (rows,))
        # Every column within a row was always the same value; that is the whole
        # reason the per-cell grid was redundant.
        np.testing.assert_array_equal(full, np.repeat(per_row[:, None], columns, axis=1))


if __name__ == "__main__":
    unittest.main()
