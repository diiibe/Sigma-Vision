"""Clean model interface for occupancy prediction.

Any model that implements ``OccupancyPredictor`` can be plugged into the
pipeline.  The protocol is intentionally minimal: receive a frame and
observation polygons, return per-bay predictions.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, runtime_checkable

from .models import CameraObservationPolygon


@dataclass
class BayPrediction:
    """Model output for a single bay."""

    bay_id: str
    occupied: bool
    confidence: float


@runtime_checkable
class OccupancyPredictor(Protocol):
    """Protocol every occupancy model must satisfy."""

    def predict(
        self,
        frame_path: Path,
        observations: list[CameraObservationPolygon],
        frame_width: int,
        frame_height: int,
        timestamp: str,
    ) -> list[BayPrediction]: ...
