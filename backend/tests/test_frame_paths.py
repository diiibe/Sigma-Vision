from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.demo_paths import DEMO_ASSETS_ENV_VAR, ROOT_DIR
from backend.models import LotDefinition
from backend.runtime.frame_paths import (
    FrameImagePathError,
    build_live_frame_url,
    resolve_frame_asset_path,
    resolve_runtime_frame_path,
    validate_frame_image_path,
)


SAMPLE_LOT_PATH = ROOT_DIR / "demo" / "lot-definition.json"


class FramePathPolicyTest(unittest.TestCase):
    def test_validate_frame_image_path_accepts_seed_demo_asset_relative_path(self):
        lot = LotDefinition.model_validate_json(SAMPLE_LOT_PATH.read_text(encoding="utf-8"))

        validate_frame_image_path(lot.frames[0].imagePath)

    def test_validate_frame_image_path_accepts_internal_live_frame_url(self):
        validate_frame_image_path("/api/live/frame/PL2.1-video-000002?cameraId=PL2.1")

    def test_validate_frame_image_path_rejects_absolute_path(self):
        with self.assertRaises(FrameImagePathError):
            validate_frame_image_path("/etc/passwd")

    def test_validate_frame_image_path_rejects_relative_traversal_outside_approved_root(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            approved_root = root / "approved"
            approved_root.mkdir(parents=True, exist_ok=True)
            blocked_path = root / "blocked.txt"
            blocked_path.write_text("nope", encoding="utf-8")
            relative_path = os.path.relpath(blocked_path, ROOT_DIR)

            with patch.dict(os.environ, {DEMO_ASSETS_ENV_VAR: str(approved_root)}):
                with self.assertRaises(FrameImagePathError):
                    validate_frame_image_path(relative_path)

    def test_resolve_frame_asset_path_returns_none_for_internal_live_frame_url(self):
        self.assertIsNone(resolve_frame_asset_path("/api/live/frame/frame-01?cameraId=CAM-01"))

    def test_resolve_runtime_frame_path_accepts_absolute_video_frame_inside_approved_videos_root(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            videos_root = Path(temp_dir) / "videos"
            frame_path = videos_root / "CAM-01" / "sig" / "frame_000001.jpg"
            frame_path.parent.mkdir(parents=True, exist_ok=True)
            frame_path.write_text("frame", encoding="utf-8")

            with patch("backend.runtime.frame_paths.get_demo_videos_dir", return_value=videos_root):
                self.assertEqual(
                    resolve_runtime_frame_path(str(frame_path)),
                    frame_path.resolve(),
                )

    def test_resolve_runtime_frame_path_rejects_absolute_path_outside_approved_runtime_roots(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            outside_path = Path(temp_dir) / "frame_000001.jpg"
            outside_path.write_text("frame", encoding="utf-8")

            self.assertIsNone(resolve_runtime_frame_path(str(outside_path)))

    def test_build_live_frame_url_includes_optional_camera_id(self):
        self.assertEqual(build_live_frame_url("frame-01"), "/api/live/frame/frame-01")
        self.assertEqual(
            build_live_frame_url("frame-01", "CAM-01"),
            "/api/live/frame/frame-01?cameraId=CAM-01",
        )
