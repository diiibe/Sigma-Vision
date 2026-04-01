"""Occupancy predictors conforming to the OccupancyPredictor protocol.

Two implementations:
- ``RCNNPredictor``: ResNet50-based ROI classifier (production).
- ``FallbackPredictor``: deterministic hash-based predictions (when weights are missing).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from PIL import Image

from .model.rcnn import RCNN
from .models import CameraObservationPolygon
from .predictor_protocol import BayPrediction
from .runtime.frame_paths import resolve_runtime_frame_path

logger = logging.getLogger(__name__)


@dataclass
class PredictorHealth:
    mode: str
    reason: str


class RCNNPredictor:
    """ResNet50 ROI classifier. Satisfies ``OccupancyPredictor`` protocol."""

    def __init__(self, weights_path: Path, device: str = "cpu"):
        self.device = torch.device(device)
        self.model = RCNN(roi_res=128, pooling_type="square")
        state_dict = torch.load(weights_path, map_location=self.device)
        self.model.load_state_dict(state_dict)
        self.model.to(self.device)
        self.model.eval()
        self.health = PredictorHealth(mode="model", reason=f"Loaded weights from {weights_path}")

    @torch.no_grad()
    def predict(
        self,
        frame_path: Path,
        observations: list[CameraObservationPolygon],
        frame_width: int,
        frame_height: int,
        timestamp: str,
    ) -> list[BayPrediction]:
        if not observations:
            return []

        resolved = resolve_frame_path(str(frame_path))
        if resolved is None:
            logger.warning("Frame path %s does not resolve to an approved local asset", frame_path)
            return []

        image = preprocess_image(resolved).to(self.device)
        rois = torch.tensor(
            [obs.imagePolygon for obs in observations],
            dtype=torch.float32,
        ).to(self.device)

        class_logits = self.model(image, rois)
        class_scores = class_logits.softmax(1)[:, 1].detach().cpu().numpy().tolist()

        return [
            BayPrediction(
                bay_id=obs.canonicalBayId,
                occupied=score >= 0.5,
                confidence=clamp_probability(score),
            )
            for obs, score in zip(observations, class_scores, strict=True)
        ]


class FallbackPredictor:
    """Deterministic hash-based predictions. Satisfies ``OccupancyPredictor`` protocol."""

    def __init__(self, reason: str):
        self.health = PredictorHealth(mode="fallback", reason=reason)

    def predict(
        self,
        frame_path: Path,
        observations: list[CameraObservationPolygon],
        frame_width: int,
        frame_height: int,
        timestamp: str,
    ) -> list[BayPrediction]:
        predictions: list[BayPrediction] = []
        frame_id = frame_path.stem

        for obs_index, obs in enumerate(observations):
            seed = hash_string(f"{obs.canonicalBayId}:{frame_id}")
            occupied = ((seed + obs_index * 7) % 100) > 47
            confidence = clamp_probability(
                0.66 + (seed % 26) / 100 if occupied else 0.58 + (seed % 20) / 100
            )
            predictions.append(
                BayPrediction(
                    bay_id=obs.canonicalBayId,
                    occupied=occupied,
                    confidence=confidence,
                )
            )

        return predictions


def build_predictor(weights_path: Path | None) -> RCNNPredictor | FallbackPredictor:
    """Factory with graceful fallback when weights or torch are unavailable."""
    if weights_path is None or not weights_path.exists():
        return FallbackPredictor("Model weights missing; using deterministic fallback predictions")

    try:
        return RCNNPredictor(weights_path)
    except Exception as exc:  # pragma: no cover - depends on local vision stack.
        return FallbackPredictor(f"Model initialization failed: {exc}")


def preprocess_image(image_path: Path) -> torch.Tensor:
    image = Image.open(image_path).convert("RGB")
    tensor = torch.from_numpy(np.asarray(image).astype("float32") / 255.0).permute(2, 0, 1)
    mean = torch.tensor([0.485, 0.456, 0.406])[:, None, None]
    std = torch.tensor([0.229, 0.224, 0.225])[:, None, None]
    return (tensor - mean) / std


def resolve_frame_path(image_path: str | None) -> Path | None:
    return resolve_runtime_frame_path(image_path)


def hash_string(value: str) -> int:
    hash_value = 0
    for char in value:
        hash_value = ((hash_value * 31) + ord(char)) & 0xFFFFFFFF
    return hash_value


def clamp_probability(value: float) -> float:
    return max(0.5, min(0.99, round(float(value), 2)))
