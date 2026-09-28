"""Unit tests for register-monitors.py's pure logic: python3 -m unittest discover deploy/kubernetes/jobs/scripts"""

import importlib.util
import unittest
from pathlib import Path

import yaml

_spec = importlib.util.spec_from_file_location("register_monitors", Path(__file__).with_name("register-monitors.py"))
rm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rm)

VALUES = yaml.safe_load((Path(__file__).parent.parent / "chart" / "values.yaml").read_text())


class DesiredMonitors(unittest.TestCase):
    def setUp(self):
        self.want = rm.desired_monitors(VALUES)

    def test_one_monitor_per_cronjob_plus_heartbeat(self):
        self.assertEqual(set(self.want), set(VALUES["jobs"]) | {rm.HEARTBEAT_KEY})

    def test_max_runtime_outlasts_the_job_deadline(self):
        # drop-index: 14400s x 3 attempts + 300 = the Job's activeDeadlineSeconds.
        m = self.want["house-price-collector-drop-index"]
        self.assertEqual(m["maxRuntimeSeconds"], 14400 * 3 + 300 + VALUES["monitoring"]["maxRuntimeSlackSeconds"])
        # extractors never retry: one attempt.
        self.assertEqual(self.want["director-trade-extractor"]["maxRuntimeSeconds"], 3600 + 300 + 900)

    def test_grace_exceeds_the_cronjob_starting_deadline(self):
        start = VALUES["defaults"]["startingDeadlineSeconds"]
        for key, m in self.want.items():
            if key != rm.HEARTBEAT_KEY:
                self.assertGreater(m["gracePeriodSeconds"], start, key)

    def test_schedules_are_utc_cron(self):
        m = self.want["shorted-news-cluster"]
        self.assertEqual(m["schedule"], {"cronExpression": "30 */2 * * *", "timezone": "UTC"})

    def test_heartbeat_tolerates_one_dropped_ping(self):
        hb = self.want[rm.HEARTBEAT_KEY]
        self.assertGreaterEqual(int(hb["schedule"]["intervalSeconds"]), 2 * rm.parse_duration(VALUES["reporter"]["heartbeatInterval"]))


class Drift(unittest.TestCase):
    want = {"schedule": {"cronExpression": "0 10 * * *", "timezone": "UTC"},
            "gracePeriodSeconds": 1800, "maxRuntimeSeconds": 8400, "affectsServiceStatus": True}

    def test_protojson_strings_are_not_drift(self):
        have = {"schedule": {"cronExpression": "0 10 * * *", "timezone": "UTC"},
                "gracePeriodSeconds": "1800", "maxRuntimeSeconds": "8400", "affectsServiceStatus": True}
        self.assertEqual(rm.drift(have, self.want), {})

    def test_schedule_and_runtime_changes_are_detected(self):
        have = {"schedule": {"cronExpression": "0 11 * * *", "timezone": "UTC"},
                "gracePeriodSeconds": "1800", "maxRuntimeSeconds": "100"}
        self.assertEqual(set(rm.drift(have, self.want)), {"schedule", "maxRuntimeSeconds", "affectsServiceStatus"})

    def test_interval_schedules_compare_as_strings(self):
        want = {"schedule": {"intervalSeconds": "600", "timezone": "UTC"},
                "gracePeriodSeconds": 300, "maxRuntimeSeconds": 0, "affectsServiceStatus": True}
        have = {"schedule": {"intervalSeconds": "600", "timezone": "UTC"},
                "gracePeriodSeconds": "300", "affectsServiceStatus": True}
        self.assertEqual(rm.drift(have, want), {})


if __name__ == "__main__":
    unittest.main()
