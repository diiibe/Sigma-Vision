from __future__ import annotations

from .models import ReplayFrame, ReplayRunRequest


def build_sample_replay_request() -> ReplayRunRequest:
    frames = [
        ReplayFrame(
            frame_id="frame-001",
            camera_id="camera-01",
            captured_at="2026-03-13T09:00:00Z",
            payload={"brightness": 0.41, "vehicles": 2},
        ),
        ReplayFrame(
            frame_id="frame-002",
            camera_id="camera-01",
            captured_at="2026-03-13T09:00:05Z",
            payload={"brightness": 0.47, "vehicles": 3},
        ),
        ReplayFrame(
            frame_id="frame-003",
            camera_id="camera-01",
            captured_at="2026-03-13T09:00:10Z",
            payload={"brightness": 0.44, "vehicles": 1},
        ),
    ]

    return ReplayRunRequest(
        run_id="replay-sample",
        camera_id="camera-01",
        source_label="fixture-sequence",
        frames=frames,
        metadata={"clipCount": 1, "scenario": "daylight"},
    )
