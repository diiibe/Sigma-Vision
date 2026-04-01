"""YOLO detector + Hungarian tracker for the security event detection module.

Independent from the counting pipeline — uses its own YOLO and tracker instances.
"""

from __future__ import annotations

import logging
import math

import numpy as np
from scipy.optimize import linear_sum_assignment

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "yolo11s.pt"
DETECT_CLASSES = [0]  # person only


class YoloEventDetector:
    def __init__(self, model_path: str = DEFAULT_MODEL, device: str | None = None):
        self.model_path = model_path
        self._model = None
        self._device = device
        self._labels: list[str] = []

    def load(self) -> None:
        from ultralytics import YOLO
        logger.info("Loading YOLO model %s ...", self.model_path)
        self._model = YOLO(self.model_path)
        if self._device:
            self._model.to(self._device)
        names = getattr(self._model, "names", None) or {}
        self._labels = []
        for i in sorted(names.keys()):
            self._labels.append(names[i])
        logger.info("YOLO loaded: %d classes (filtering to %d)", len(self._labels), len(DETECT_CLASSES))

    @property
    def labels(self) -> list[str]:
        return [self._labels[i] for i in DETECT_CLASSES if i < len(self._labels)]

    def detect(self, source, conf: float = 0.25) -> list[dict]:
        """Run YOLO on a frame (path or array). Returns list of normalized detection dicts."""
        if self._model is None:
            raise RuntimeError("Model not loaded.")
        results = self._model(source, device=self._device, conf=conf,
                              classes=DETECT_CLASSES, verbose=False)
        dets: list[dict] = []
        if results and len(results) > 0:
            result = results[0]
            h, w = result.orig_shape
            if result.boxes is not None and len(result.boxes) > 0:
                for box in result.boxes:
                    cls_id = int(box.cls[0])
                    label = self._labels[cls_id] if cls_id < len(self._labels) else f"class_{cls_id}"
                    x1, y1, x2, y2 = box.xyxy[0].tolist()
                    dets.append({
                        "label": label,
                        "confidence": round(float(box.conf[0]), 3),
                        "x1": round(x1 / w, 4), "y1": round(y1 / h, 4),
                        "x2": round(x2 / w, 4), "y2": round(y2 / h, 4),
                    })
        return dets


def _iou(b1, b2) -> float:
    x1 = max(b1[0], b2[0]); y1 = max(b1[1], b2[1])
    x2 = min(b1[2], b2[2]); y2 = min(b1[3], b2[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    a1 = (b1[2] - b1[0]) * (b1[3] - b1[1])
    a2 = (b2[2] - b2[0]) * (b2[3] - b2[1])
    union = a1 + a2 - inter
    return inter / union if union > 0 else 0.0


class SecurityTracker:
    """Hungarian matching tracker (independent copy from vision/tracker.py)."""

    def __init__(self, track_buffer: int = 30, max_match_distance: float = 0.12, iou_weight: float = 0.5):
        self.track_buffer = track_buffer
        self.max_match_distance = max_match_distance
        self.iou_weight = iou_weight
        self._history: dict[str, _TrackState] = {}
        self._next_id: int = 0
        self._frame_count: int = 0

    def update(self, detections: list[dict]) -> list[dict]:
        """Match detections to tracks. Returns list of tracked dicts with track_id, velocity, age."""
        self._frame_count += 1

        if not detections:
            self._gc()
            return []

        det_cx = [(d["x1"] + d["x2"]) / 2 for d in detections]
        det_cy = [(d["y1"] + d["y2"]) / 2 for d in detections]
        active_ids = list(self._history.keys())
        matched: dict[int, str] = {}

        if active_ids:
            n_det, n_trk = len(detections), len(active_ids)
            cost = np.zeros((n_det, n_trk))
            for di in range(n_det):
                for ti, tid in enumerate(active_ids):
                    s = self._history[tid]
                    cdist = math.sqrt((det_cx[di] - s.cx) ** 2 + (det_cy[di] - s.cy) ** 2)
                    iou_s = _iou(
                        (detections[di]["x1"], detections[di]["y1"], detections[di]["x2"], detections[di]["y2"]),
                        s.bbox,
                    )
                    cost[di, ti] = (1 - self.iou_weight) * cdist + self.iou_weight * (1 - iou_s)

            row_ind, col_ind = linear_sum_assignment(cost)
            for di, ti in zip(row_ind, col_ind):
                s = self._history[active_ids[ti]]
                cdist = math.sqrt((det_cx[di] - s.cx) ** 2 + (det_cy[di] - s.cy) ** 2)
                if cdist <= self.max_match_distance:
                    matched[di] = active_ids[ti]

        results: list[dict] = []
        for di, det in enumerate(detections):
            cx, cy = det_cx[di], det_cy[di]
            if di in matched:
                tid = matched[di]
            else:
                tid = f"trk-{self._next_id:05d}"
                self._next_id += 1

            prev = self._history.get(tid)
            age = (prev.age + 1) if prev else 1
            velocity = None
            if prev is not None:
                velocity = (round(cx - prev.cx, 6), round(cy - prev.cy, 6))

            self._history[tid] = _TrackState(
                cx=cx, cy=cy,
                bbox=(det["x1"], det["y1"], det["x2"], det["y2"]),
                age=age, frame_count=self._frame_count,
            )

            results.append({
                **det,
                "track_id": tid,
                "velocity": velocity,
                "age": age,
                "centroid": (round(cx, 4), round(cy, 4)),
            })

        self._gc()
        return results

    def _gc(self) -> None:
        cutoff = self._frame_count - self.track_buffer
        stale = [k for k, v in self._history.items() if v.frame_count < cutoff]
        for k in stale:
            del self._history[k]

    def reset(self) -> None:
        self._history.clear()
        self._next_id = 0
        self._frame_count = 0


class _TrackState:
    __slots__ = ("cx", "cy", "bbox", "age", "frame_count")

    def __init__(self, cx, cy, bbox, age, frame_count):
        self.cx = cx
        self.cy = cy
        self.bbox = bbox
        self.age = age
        self.frame_count = frame_count
