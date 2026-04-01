from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from backend.models import CameraVideoSourceState
from backend.runtime.config_repository import SpatialConfigFileRepository
from backend.runtime.storage import SQLiteStore
from backend.runtime.video_ingestion import VideoIngestionManager, VideoPathError


class VideoIngestionPathHardeningTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.videos_dir = self.root / "videos"
        self.videos_dir.mkdir(parents=True, exist_ok=True)
        self.store = SQLiteStore(self.root / "runtime.sqlite")
        self.config_store = SpatialConfigFileRepository(self.root / "canonical" / "spatial-configs")
        self.manager = VideoIngestionManager(self.store, self.config_store, videos_dir=self.videos_dir)

    def tearDown(self):
        self.store.close()
        self.temp_dir.cleanup()

    def test_resolve_source_path_allows_relative_mapping_inside_videos_dir(self):
        nested_dir = self.videos_dir / "nested"
        nested_dir.mkdir(parents=True, exist_ok=True)
        target = nested_dir / "custom-name.mp4"
        target.write_text("placeholder", encoding="utf-8")
        (self.videos_dir / "video-map.json").write_text(
            json.dumps({"CAM-01": "nested/custom-name.mp4"}),
            encoding="utf-8",
        )

        resolved = self.manager._resolve_source_path("CAM-01")

        self.assertEqual(resolved, target.resolve())

    def test_resolve_source_path_rejects_mapping_outside_videos_dir(self):
        outside_target = self.root / "escape.mp4"
        outside_target.write_text("placeholder", encoding="utf-8")
        (self.videos_dir / "video-map.json").write_text(
            json.dumps({"CAM-01": "../escape.mp4"}),
            encoding="utf-8",
        )

        with self.assertRaises(VideoPathError):
            self.manager._resolve_source_path("CAM-01")

        state = self.manager.discover("CAM-01")

        self.assertEqual(state.status, "error")
        self.assertEqual(
            state.error,
            "Mapped video path must stay inside the configured videos directory.",
        )
        self.assertNotIn("../escape.mp4", state.error)

    def test_frame_entries_ignore_manifest_paths_outside_cache_dir(self):
        cache_dir = self.videos_dir / "CAM-01" / "sig"
        cache_dir.mkdir(parents=True, exist_ok=True)
        valid_frame = cache_dir / "frame_000001.jpg"
        valid_frame.write_text("frame", encoding="utf-8")
        outside_frame = self.videos_dir / "escape.jpg"
        outside_frame.write_text("escape", encoding="utf-8")
        (cache_dir / "manifest.json").write_text(
            json.dumps(
                {
                    "frames": [
                        {"file": "frame_000001.jpg", "index": 0, "timestampSeconds": 0.0},
                        {"file": "../escape.jpg", "index": 1, "timestampSeconds": 1.0},
                        {"file": "..\\escape.jpg", "index": 2, "timestampSeconds": 2.0},
                    ]
                }
            ),
            encoding="utf-8",
        )

        frames = self.manager._frame_entries(cache_dir)

        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0].path, valid_frame.resolve())

    def test_frame_response_path_rejects_cache_dir_outside_videos_root(self):
        outside_cache_dir = self.root / "outside-cache"
        outside_cache_dir.mkdir(parents=True, exist_ok=True)
        (outside_cache_dir / "frame_000001.jpg").write_text("frame", encoding="utf-8")
        self.store.upsert_video_source(
            CameraVideoSourceState(
                cameraId="CAM-01",
                sourcePath=str(self.videos_dir / "CAM-01.mp4"),
                cacheDir=str(outside_cache_dir),
                status="ready",
                discoveredAt="2026-03-25T10:00:00Z",
                updatedAt="2026-03-25T10:00:00Z",
                frameCount=1,
                currentFrameIndex=0,
                currentFrameId="CAM-01-video-000001",
                currentFramePath=str(outside_cache_dir / "frame_000001.jpg"),
            )
        )

        resolved = self.manager.frame_response_path("CAM-01-video-000001")

        self.assertIsNone(resolved)
