from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from backend.replay_eval import ReplayArtifactStore, ReplayRunner
from backend.replay_eval.fixtures import build_sample_replay_request


class ReplayEvalScaffoldTest(unittest.TestCase):
    def test_replay_runner_serializes_deterministic_outputs(self):
        request = build_sample_replay_request()

        def handler(frame):
            vehicles = int(frame.payload.get("vehicles", 0))
            return {
                "detections": [{"frameId": frame.frame_id, "count": vehicles}],
                "tracks": [{"frameId": frame.frame_id, "trackId": f"{frame.frame_id}-track"}],
                "alerts": [] if vehicles < 3 else [{"sourceKpi": "occupancy"}],
                "events": [{"type": "sensor_update", "frameId": frame.frame_id}],
            }

        result = ReplayRunner(handler).run(request)

        self.assertEqual(result.run_id, request.run_id)
        self.assertEqual(result.step_count, len(request.frames))
        self.assertEqual(result.summary["frames"], len(request.frames))
        self.assertEqual(result.summary["detections"], 3)
        self.assertEqual(result.summary["tracks"], 3)
        self.assertEqual(result.summary["alerts"], 1)

    def test_replay_artifact_store_round_trips_results(self):
        request = build_sample_replay_request()

        def handler(frame):
            return {
                "detections": [{"frameId": frame.frame_id}],
                "tracks": [{"trackId": f"{frame.frame_id}-track"}],
                "alerts": [],
                "events": [],
            }

        result = ReplayRunner(handler).run(request)

        with tempfile.TemporaryDirectory() as temp_dir:
            store = ReplayArtifactStore(Path(temp_dir))
            run_dir = store.write(result)

            self.assertTrue((run_dir / "manifest.json").exists())
            self.assertTrue((run_dir / "steps.jsonl").exists())
            self.assertEqual(store.list_runs(), [request.run_id])

            restored = store.read(request.run_id)
            self.assertEqual(restored.run_id, result.run_id)
            self.assertEqual(len(restored.steps), len(result.steps))
            self.assertEqual(restored.summary["detections"], result.summary["detections"])


if __name__ == "__main__":
    unittest.main()
