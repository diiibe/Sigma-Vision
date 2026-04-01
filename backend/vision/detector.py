"""Vehicle detection module wrapping YOLOv8s fine-tuned on VisDrone.

Requires yolov8s_visdrone.pt weights in backend/model/.
Raises clear errors when the model is unavailable — no silent degradation.
"""

from __future__ import annotations

import logging
from pathlib import Path

from ..models import BoundingBox, DetectionRecord

logger = logging.getLogger(__name__)

# VisDrone vehicle classes (from mshamrai/yolov8s-visdrone, mAP@0.5 = 0.408)
VEHICLE_VISDRONE_CLASSES: dict[int, str] = {
    3: "car",
    4: "van",
    5: "truck",
    8: "bus",
    9: "motor",
}


class YoloDetector:
    """Detects vehicles in a frame using YOLOv8s fine-tuned on VisDrone.

    This detector is designed for aerial/top-down camera footage.
    It does NOT fall back to COCO weights — if the VisDrone model is
    unavailable, it raises an error so the issue can be resolved.
    """

    def __init__(
        self,
        model_path: str = "yolov8s_visdrone.pt",
        device: str = "cpu",
        confidence_threshold: float = 0.25,
        vehicle_classes: dict[int, str] | None = None,
    ):
        self.model_path = model_path
        self.device = device
        self.confidence_threshold = confidence_threshold
        self.vehicle_classes = vehicle_classes or VEHICLE_VISDRONE_CLASSES
        self._model = None
        self._available: bool | None = None
        self._error_message: str | None = None

    @property
    def error_message(self) -> str | None:
        """Human-readable error if the model failed to load."""
        return self._error_message

    def _ensure_model(self) -> bool:
        if self._available is not None:
            return self._available

        try:
            from ultralytics import YOLO
        except ImportError:
            self._error_message = (
                "ultralytics is not installed. "
                "Install it with: pip install ultralytics"
            )
            logger.error("YoloDetector: %s", self._error_message)
            self._available = False
            return False

        weights = Path(self.model_path)
        if not weights.exists():
            alt = Path(__file__).resolve().parent.parent / "model" / weights.name
            if alt.exists():
                weights = alt
            else:
                self._error_message = (
                    f"VisDrone model not found at {self.model_path} or {alt}. "
                    f"Download it from HuggingFace: mshamrai/yolov8s-visdrone"
                )
                logger.error("YoloDetector: %s", self._error_message)
                self._available = False
                return False

        try:
            self._model = YOLO(str(weights))
            self._available = True
            logger.info("YoloDetector loaded VisDrone weights from %s (device=%s)", weights, self.device)
            return True
        except Exception as exc:
            self._error_message = f"Failed to load VisDrone model: {exc}"
            logger.error("YoloDetector: %s", self._error_message)
            self._available = False
            return False

    def detect(
        self,
        frame_path: Path | str,
        frame_id: str,
        timestamp: str,
    ) -> list[DetectionRecord]:
        if not self._ensure_model():
            return []

        frame_path = Path(frame_path)
        if not frame_path.exists():
            return []

        try:
            results = self._model(
                str(frame_path),
                device=self.device,
                conf=self.confidence_threshold,
                verbose=False,
            )
        except Exception as exc:
            logger.error("YOLO inference failed on %s: %s", frame_path, exc)
            return []

        detections: list[DetectionRecord] = []
        for result in results:
            if result.boxes is None:
                continue

            img_h, img_w = result.orig_shape
            if img_h == 0 or img_w == 0:
                continue

            for box in result.boxes:
                cls_id = int(box.cls[0].item())
                class_name = self.vehicle_classes.get(cls_id)
                if class_name is None:
                    continue

                conf = float(box.conf[0].item())
                x1, y1, x2, y2 = box.xyxy[0].tolist()

                # Normalize to 0-1 range (matching existing convention)
                bbox: BoundingBox = (
                    round(max(0.0, x1 / img_w), 4),
                    round(max(0.0, y1 / img_h), 4),
                    round(min(1.0, x2 / img_w), 4),
                    round(min(1.0, y2 / img_h), 4),
                )

                detections.append(
                    DetectionRecord(
                        frameId=frame_id,
                        timestamp=timestamp,
                        bbox=bbox,
                        className=class_name,
                        confidence=round(conf, 4),
                        detectionId=f"yolo-{frame_id}-{len(detections)}",
                    )
                )

        return detections
