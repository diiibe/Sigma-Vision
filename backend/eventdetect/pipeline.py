"""Security detection pipeline — wall-clock JPEG loop with YOLO + tracker + engine."""

from __future__ import annotations

import logging
import time

from .engine import SecurityEventEngine, tracks_from_dicts
from .model import SecurityTracker, YoloEventDetector
from .schemas import SecurityEvent, SecurityLine, SecurityTask, SecurityZone, TrackState

logger = logging.getLogger(__name__)


class SecurityPipeline:
    """Runs YOLO detection + tracking + security event engine on a camera's frame cache."""

    def __init__(self, detector: YoloEventDetector):
        self._detector = detector
        self._tracker = SecurityTracker()
        self._engine = SecurityEventEngine()

    def run_tick(
        self,
        camera_id: str,
        frame_path: str,
        timestamp_sec: float,
        zones: list[SecurityZone],
        lines: list[SecurityLine],
    ) -> tuple[list[TrackState], list[SecurityEvent]]:
        """Process a single frame. Returns (tracks, events)."""

        # YOLO detection (reads JPEG directly)
        raw_dets = self._detector.detect(frame_path)

        # Hungarian tracker
        tracked = self._tracker.update(raw_dets)

        # Convert to engine format
        engine_tracks = tracks_from_dicts(tracked)

        # Security event engine
        events = self._engine.update(camera_id, zones, lines, engine_tracks, timestamp_sec)

        # Build lightweight track state for frontend
        track_states = [
            TrackState(
                trackId=t["track_id"],
                bbox=(t["x1"], t["y1"], t["x2"], t["y2"]),
                className=t["label"],
                confidence=t["confidence"],
                centroid=t["centroid"],
                velocity=t.get("velocity"),
                age=t.get("age", 0),
            )
            for t in tracked
        ]

        return track_states, events

    def reset(self, camera_id: str) -> None:
        self._tracker.reset()
        self._engine.reset_camera(camera_id)
