"""Vehicle tracking module using Hungarian matching with IoU + centroid cost.

Replaces supervision-based ByteTrack with a validated approach that provides
stable track IDs even when vehicles are close together.
"""

from __future__ import annotations

import logging

import numpy as np
from scipy.optimize import linear_sum_assignment

from ..models import BoundingBox, DetectionRecord, PolygonPoint, TrackRecord

logger = logging.getLogger(__name__)


def _iou(b1: BoundingBox, b2: BoundingBox) -> float:
    """IoU between two normalized bboxes (x1, y1, x2, y2)."""
    x1 = max(b1[0], b2[0])
    y1 = max(b1[1], b2[1])
    x2 = min(b1[2], b2[2])
    y2 = min(b1[3], b2[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    a1 = (b1[2] - b1[0]) * (b1[3] - b1[1])
    a2 = (b2[2] - b2[0]) * (b2[3] - b2[1])
    union = a1 + a2 - inter
    return inter / union if union > 0 else 0.0


class ByteTrackAdapter:
    """Hungarian matching tracker with combined IoU + centroid cost.

    Name kept as ByteTrackAdapter for backward compatibility with pipeline imports.
    Uses scipy.optimize.linear_sum_assignment for globally optimal matching
    instead of greedy centroid-only assignment.
    """

    def __init__(
        self,
        track_buffer: int = 30,
        max_match_distance: float = 0.12,
        iou_weight: float = 0.5,
    ):
        self.track_buffer = track_buffer
        self.max_match_distance = max_match_distance
        self.iou_weight = iou_weight
        self._track_history: dict[str, _TrackState] = {}
        self._next_id: int = 0
        self._frame_count: int = 0

    def update(
        self,
        detections: list[DetectionRecord],
        frame_id: str,
        timestamp: str,
        frame_width: int = 1,
        frame_height: int = 1,
    ) -> list[TrackRecord]:
        self._frame_count += 1

        if not detections:
            self._gc_history()
            return []

        det_cx = [(d.bbox[0] + d.bbox[2]) / 2 for d in detections]
        det_cy = [(d.bbox[1] + d.bbox[3]) / 2 for d in detections]
        active_ids = list(self._track_history.keys())
        matched_det: dict[int, str] = {}

        if active_ids:
            n_det = len(detections)
            n_trk = len(active_ids)
            cost = np.zeros((n_det, n_trk))

            for di in range(n_det):
                for ti, tid in enumerate(active_ids):
                    state = self._track_history[tid]
                    cdist = ((det_cx[di] - state.cx) ** 2 + (det_cy[di] - state.cy) ** 2) ** 0.5
                    iou_score = _iou(detections[di].bbox, state.bbox)
                    cost[di, ti] = (1 - self.iou_weight) * cdist + self.iou_weight * (1 - iou_score)

            row_ind, col_ind = linear_sum_assignment(cost)
            for di, ti in zip(row_ind, col_ind):
                state = self._track_history[active_ids[ti]]
                cdist = ((det_cx[di] - state.cx) ** 2 + (det_cy[di] - state.cy) ** 2) ** 0.5
                if cdist <= self.max_match_distance:
                    matched_det[di] = active_ids[ti]

        tracks: list[TrackRecord] = []
        for di, det in enumerate(detections):
            cx, cy = det_cx[di], det_cy[di]

            if di in matched_det:
                best_id = matched_det[di]
            else:
                best_id = f"trk-{self._next_id:05d}"
                self._next_id += 1

            prev = self._track_history.get(best_id)
            age = (prev.age + 1) if prev else 1
            velocity = None
            if prev is not None:
                velocity = (round(cx - prev.cx, 6), round(cy - prev.cy, 6))

            self._track_history[best_id] = _TrackState(
                cx=cx, cy=cy, bbox=det.bbox, age=age, frame_count=self._frame_count,
            )

            centroid: PolygonPoint = (round(cx, 4), round(cy, 4))
            tracks.append(TrackRecord(
                frameId=frame_id,
                timestamp=timestamp,
                trackId=best_id,
                bbox=det.bbox,
                className=det.className,
                confidence=det.confidence,
                age=age,
                persistence=float(age),
                centroid=centroid,
                cameraId=None,
                velocity=velocity,
                heading=None,
                persistenceFrames=age,
                sourceModel="yolov8s-visdrone+hungarian",
            ))

        self._gc_history()
        return tracks

    def _gc_history(self) -> None:
        """Remove tracks not seen for track_buffer frames."""
        cutoff = self._frame_count - self.track_buffer
        stale = [k for k, v in self._track_history.items() if v.frame_count < cutoff]
        for k in stale:
            del self._track_history[k]

    def reset(self) -> None:
        self._track_history.clear()
        self._next_id = 0
        self._frame_count = 0


class _TrackState:
    __slots__ = ("cx", "cy", "bbox", "age", "frame_count")

    def __init__(self, cx: float, cy: float, bbox: BoundingBox, age: int, frame_count: int):
        self.cx = cx
        self.cy = cy
        self.bbox = bbox
        self.age = age
        self.frame_count = frame_count
