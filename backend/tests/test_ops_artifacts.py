from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]
DASHBOARD_PATH = ROOT_DIR / "ops" / "grafana" / "hack26-dashboard.json"


class OpsArtifactsTest(unittest.TestCase):
    def test_grafana_dashboard_references_the_canonical_metric_names(self):
        dashboard = json.loads(DASHBOARD_PATH.read_text(encoding="utf-8"))

        self.assertEqual(dashboard["title"], "Hack26 Parking Ops")
        self.assertGreaterEqual(len(dashboard["panels"]), 4)

        expressions = [
            target["expr"]
            for panel in dashboard["panels"]
            for target in panel.get("targets", [])
        ]

        self.assertIn("hack26_input_fps", expressions)
        self.assertIn("hack26_detector_latency_ms", expressions)
        self.assertIn("hack26_active_alerts", expressions)
        self.assertIn("increase(hack26_processing_errors_total[5m])", expressions)


if __name__ == "__main__":
    unittest.main()
