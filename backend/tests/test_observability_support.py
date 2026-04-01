from __future__ import annotations

import unittest

from backend.observability import (
    METRIC_NAMES,
    ThresholdRule,
    TimelinePoint,
    bucket_timestamp,
    create_metrics_bundle,
    evaluate_alerts,
    export_metrics_text,
    find_state_inconsistencies,
    rollup_timeline_points,
)


class ObservabilitySupportTest(unittest.TestCase):
    def test_metric_bundle_tracks_pipeline_state(self):
        bundle = create_metrics_bundle()
        bundle.record_pipeline_state(
            input_fps=24.5,
            dropped_frames=2,
            detector_latency_ms=11.1,
            tracker_latency_ms=7.2,
            end_to_end_state_latency_ms=19.6,
            active_tracks=5,
            active_alerts=1,
            state_inconsistencies=2,
            stale_data_incidents=1,
            processing_errors=3,
        )

        snapshot = bundle.snapshot()
        self.assertEqual(snapshot["input_fps"], 24.5)
        self.assertEqual(snapshot["active_tracks"], 5.0)
        self.assertIn(METRIC_NAMES["processing_errors"], export_metrics_text(bundle))

    def test_timeline_bucketing_and_alert_rules_are_deterministic(self):
        self.assertEqual(
            bucket_timestamp("2026-03-18T10:14:07Z", 300),
            "2026-03-18T10:10:00Z",
        )

        alerts = evaluate_alerts(
            [
                ThresholdRule(
                    rule_id="zone-high",
                    source_kpi="zone_01_occupancy",
                    comparator="gte",
                    threshold_value=0.8,
                    severity="warning",
                    explanation_template="{source_kpi} reached {value} against {threshold}",
                )
            ],
            {"zone_01_occupancy": 0.91},
            observed_at="2026-03-18T10:15:00Z",
        )

        self.assertEqual(len(alerts), 1)
        self.assertTrue(alerts[0].active)
        self.assertIn("0.91", alerts[0].explanation_text)

    def test_consistency_checks_detect_totals_and_staleness(self):
        issues = find_state_inconsistencies(
            {
                "zone-a": {"totalBays": 4, "occupiedBays": 3, "availableBays": 0},
                "zone-b": {"totalBays": 2, "occupiedBays": 3, "availableBays": -1},
            },
            observed_at="2026-03-18T10:15:00Z",
            max_state_age_seconds=30,
            state_age_seconds=45,
        )

        codes = {issue.code for issue in issues}
        self.assertIn("bay_totals_mismatch", codes)
        self.assertIn("occupied_exceeds_total", codes)
        self.assertIn("negative_available", codes)
        self.assertIn("stale_state", codes)

    def test_timeline_points_roll_up_by_bucket(self):
        rolled = rollup_timeline_points(
            [
                TimelinePoint(
                    bucket_start="2026-03-18T10:10:00Z",
                    metric_name="occupancy",
                    scope="zone-a",
                    value=0.4,
                    window_seconds=300,
                ),
                TimelinePoint(
                    bucket_start="2026-03-18T10:12:00Z",
                    metric_name="occupancy",
                    scope="zone-a",
                    value=0.6,
                    window_seconds=300,
                ),
            ],
            300,
        )

        self.assertEqual(len(rolled), 1)
        self.assertEqual(rolled[0].value, 1.0)


if __name__ == "__main__":
    unittest.main()
