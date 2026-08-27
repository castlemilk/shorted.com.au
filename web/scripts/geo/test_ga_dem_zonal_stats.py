import importlib.util
import math
from pathlib import Path
import unittest


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


if __name__ == "__main__":
    unittest.main()
