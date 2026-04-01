from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
import subprocess
from collections import Counter
from unittest.mock import Mock, patch

from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.demo_paths import BACKEND_CORS_ORIGINS_ENV_VAR, DEFAULT_CORS_ORIGINS
from backend.demo_service import DemoService
from backend.models import CameraObservationPolygon, CameraPresetCloneRequest, LayoutPartitionDefinition, SpatialBayDefinition, SpatialConfig, SpatialZoneDefinition
from backend.predictor_protocol import BayPrediction
from backend.runtime.pipeline import StabilizationEngine, StateStore
from backend.runtime.service import _project_polygon_from_editor_cover_to_frame


ROOT_DIR = Path(__file__).resolve().parents[2]
SAMPLE_LOT_PATH = ROOT_DIR / "demo" / "lot-definition.json"


class DemoServiceTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.lot_path = Path(self.temp_dir.name) / "lot-definition.json"
        self.db_path = Path(self.temp_dir.name) / "hack26.db"
        self.videos_dir = Path(self.temp_dir.name) / "videos"
        self.videos_dir.mkdir(parents=True, exist_ok=True)
        self.lot_path.write_text(SAMPLE_LOT_PATH.read_text(encoding="utf-8"), encoding="utf-8")
        self._create_demo_video("CAM-ACPDS-01")
        self.service = DemoService(lot_path=self.lot_path, db_path=self.db_path, videos_dir=self.videos_dir)

    def tearDown(self):
        self.service.close()
        self.temp_dir.cleanup()

    def _create_demo_video(self, camera_id: str, directory: Path | None = None) -> None:
        output_path = (directory or self.videos_dir) / f"{camera_id}.mp4"
        subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=96x54:rate=10",
                "-t",
                "1.2",
                "-pix_fmt",
                "yuv420p",
                str(output_path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )

    def test_demo_frame_endpoint_resolves_legacy_frame_ids(self):
        app = create_app()
        app.state.service = self.service
        frame_id = self.service.get_lot_definition().frames[1].id

        with TestClient(app) as client:
            response = client.get(f"/api/demo/frame/{frame_id}")

        self.assertEqual(response.status_code, 200)

    def test_create_app_uses_default_local_cors_origins(self):
        with patch.dict(os.environ, {BACKEND_CORS_ORIGINS_ENV_VAR: ""}, clear=False):
            app = create_app()

        cors = _cors_middleware(app)

        self.assertEqual(cors.kwargs["allow_origins"], list(DEFAULT_CORS_ORIGINS))
        self.assertTrue(cors.kwargs["allow_credentials"])

    def test_create_app_reads_cors_origins_from_env(self):
        with patch.dict(
            os.environ,
            {BACKEND_CORS_ORIGINS_ENV_VAR: "https://demo.example.com, https://ops.example.com"},
            clear=False,
        ):
            app = create_app()

        cors = _cors_middleware(app)

        self.assertEqual(
            cors.kwargs["allow_origins"],
            ["https://demo.example.com", "https://ops.example.com"],
        )
        self.assertTrue(cors.kwargs["allow_credentials"])

    def test_create_app_disables_credentials_for_wildcard_cors_origin(self):
        with patch.dict(os.environ, {BACKEND_CORS_ORIGINS_ENV_VAR: "*"}, clear=False):
            app = create_app()

        cors = _cors_middleware(app)

        self.assertEqual(cors.kwargs["allow_origins"], ["*"])
        self.assertFalse(cors.kwargs["allow_credentials"])

    def test_seeded_active_config_has_bays_zones_and_lines(self):
        config = self.service.get_active_config()

        self.assertEqual(config.status, "active")
        self.assertGreater(len(config.bays), 0)
        self.assertGreater(len(config.zones), 0)
        self.assertGreater(len(config.lines), 0)

    def test_live_snapshot_contains_backend_owned_state(self):
        snapshot = self.service.get_live_snapshot()

        self.assertEqual(snapshot.cameraId, self.service.get_active_config().cameraId)
        self.assertGreaterEqual(len(snapshot.bayStates), 1)
        self.assertGreaterEqual(len(snapshot.zoneKpis), 1)
        self.assertTrue(snapshot.metrics.totalSlots >= len(snapshot.bayStates))
        self.assertIn("occupancy", {module.module for module in snapshot.modules})
        self.assertGreaterEqual(len(snapshot.cameras), 1)
        self.assertTrue(snapshot.cameras[0].frameId)
        self.assertTrue(snapshot.cameras[0].frameUrl.startswith("/api/live/frame/"))
        self.assertIn("cameraId=", snapshot.cameras[0].frameUrl)

    def test_live_snapshot_groups_zones_inside_plane_levels(self):
        active_config = self.service.get_active_config().model_copy(deep=True)
        primary_level = active_config.levels[0]
        primary_partitions = [partition for partition in active_config.partitions if partition.levelId == primary_level.id]
        original_partition = primary_partitions[0]
        extra_partition = LayoutPartitionDefinition(
            id=f"{primary_level.id}-ZONE-02",
            name="Zone 02",
            levelId=primary_level.id,
            order=original_partition.order + 1,
            gridRows=max(original_partition.gridRows, 1),
            gridColumns=max(original_partition.gridColumns, 1),
            ownerCameraIds=list(original_partition.ownerCameraIds),
            layoutPolygon=None,
        )
        active_config.partitions.append(extra_partition)

        moved = 0
        for bay in active_config.bays:
            if bay.levelId != primary_level.id or bay.partitionId != original_partition.id:
                continue
            if moved % 2 == 0:
                bay.partitionId = extra_partition.id
                bay.zoneId = extra_partition.id
            moved += 1

        self.assertGreater(moved, 1)

        self.service.save_run(active_config.cameraId, active_config)
        snapshot = self.service.get_live_snapshot()
        active_config = self.service.get_active_config()

        self.assertEqual(
            [level.id for level in snapshot.levels],
            [level.id for level in active_config.levels],
        )

        partitions_by_level = Counter(partition.levelId for partition in active_config.partitions)
        level_by_id = {level.id: level for level in snapshot.levels}
        self.assertTrue(any(count > 1 for count in partitions_by_level.values()))

        for level_id, partition_count in partitions_by_level.items():
            if partition_count <= 1:
                continue
            self.assertIn(level_id, level_by_id)
            self.assertGreaterEqual(
                len({slot.partitionId for slot in level_by_id[level_id].slots}),
                2,
            )

    def test_live_snapshot_degrades_without_falling_back_to_synthetic_predictions(self):
        class MissingModelPredictor:
            def __init__(self):
                self.health = type("Health", (), {"mode": "fallback", "reason": "weights missing"})()

        service = DemoService(
            lot_path=self.lot_path,
            db_path=Path(self.temp_dir.name) / "degraded-hack26.db",
            videos_dir=self.videos_dir,
        )
        service.pipeline.predictor = MissingModelPredictor()
        try:
            camera_id = service.get_active_config().cameraId
            snapshot = service.refresh_live_snapshot(camera_id)
            occupancy = next(module for module in snapshot.moduleHealth if module.module == "occupancy")

            self.assertEqual(snapshot.systemStatus, "degraded")
            self.assertEqual(occupancy.status, "degraded")
            self.assertEqual(len(snapshot.detections), 0)
            self.assertEqual(len(snapshot.tracks), 0)
            self.assertEqual(len(snapshot.flowEvents), 0)
            self.assertEqual(snapshot.counts.entriesTotal, 0)
            self.assertTrue(all(bay.status == "unknown" for bay in snapshot.bayStates))
        finally:
            service.close()

    def test_live_runtime_passes_camera_specific_bays_to_the_predictor(self):
        captured: dict[str, object] = {}

        class CapturingPredictor:
            def __init__(self):
                self.health = type("Health", (), {"mode": "model", "reason": "capturing"})()

            def predict(self, frame_path, observations, frame_width, frame_height, timestamp):
                captured["bays"] = observations
                captured["frame_path"] = frame_path
                return [
                    BayPrediction(bay_id=obs.canonicalBayId, occupied=index == 0, confidence=0.93 if index == 0 else 0.12)
                    for index, obs in enumerate(observations)
                ]

        service = DemoService(
            lot_path=self.lot_path,
            db_path=Path(self.temp_dir.name) / "capturing-hack26.db",
            videos_dir=self.videos_dir,
        )
        service.pipeline.predictor = CapturingPredictor()
        try:
            camera_id = service.get_active_config().cameraId
            active_config = service.get_active_config(camera_id)

            service.refresh_live_snapshot(camera_id)
            snapshot = service.refresh_live_snapshot(camera_id)

            passed_observations = captured["bays"]
            self.assertIsInstance(passed_observations, list)
            self.assertEqual(
                sorted(obs.canonicalBayId for obs in passed_observations),
                sorted(bay.id for bay in active_config.bays),
            )
            self.assertEqual(len(snapshot.detections), 0)
            self.assertEqual(len(snapshot.tracks), 0)
            self.assertEqual(len(snapshot.flowEvents), 0)
            self.assertEqual(snapshot.counts.entriesTotal, 0)
            self.assertIn(
                snapshot.bayStates[0].status,
                {"free", "occupied", "reserved"},
            )
        finally:
            service.close()

    def test_live_runtime_accepts_internal_video_frame_paths_for_model_inference(self):
        class PathAwarePredictor:
            def __init__(self):
                self.health = type("Health", (), {"mode": "model", "reason": "path-aware"})()

            def predict(self, frame_path, observations, frame_width, frame_height, timestamp):
                if not frame_path.exists():
                    raise FileNotFoundError(f"Frame does not exist at {frame_path}")
                return [
                    BayPrediction(bay_id=obs.canonicalBayId, occupied=index == 0, confidence=0.91 if index == 0 else 0.18)
                    for index, obs in enumerate(observations)
                ]

        with patch("backend.runtime.frame_paths.get_demo_videos_dir", return_value=self.videos_dir):
            service = DemoService(
                lot_path=self.lot_path,
                db_path=Path(self.temp_dir.name) / "path-aware-hack26.db",
                videos_dir=self.videos_dir,
            )
            service.pipeline.predictor = PathAwarePredictor()
            try:
                snapshot = service.get_live_snapshot()
                occupancy = next(module for module in snapshot.moduleHealth if module.module == "occupancy")

                self.assertEqual(occupancy.status, "online")
                self.assertNotIn("approved local asset", occupancy.details or "")
                self.assertTrue(any(bay.status in {"occupied", "free", "reserved"} for bay in snapshot.bayStates))
            finally:
                service.close()

    def test_advance_changes_the_frame_and_persists_snapshot(self):
        initial_snapshot = self.service.get_live_snapshot()
        next_snapshot = self.service.advance_live_snapshot()
        active_camera_id = initial_snapshot.cameraId
        initial_feed = next(feed for feed in initial_snapshot.cameras if feed.id == active_camera_id)
        next_feed = next(feed for feed in next_snapshot.cameras if feed.id == active_camera_id)

        self.assertNotEqual(initial_feed.frameId, next_feed.frameId)
        latest = self.service.backend.store.get_latest_live_snapshot(initial_snapshot.cameraId)
        self.assertIsNotNone(latest)
        self.assertEqual(next_feed.frameId, next(feed for feed in latest.cameras if feed.id == active_camera_id).frameId)
        video_source = self.service.get_video_source(initial_snapshot.cameraId)
        self.assertIsNotNone(video_source)
        self.assertEqual(video_source.status, "ready")
        self.assertGreater(video_source.frameCount, 0)

    def test_demo_service_backend_alias_points_to_the_service_instance(self):
        self.assertIs(self.service.backend, self.service)

    def test_video_ingestion_keeps_native_frame_count_and_subsecond_timestamps(self):
        source = self.service.get_video_source("CAM-ACPDS-01")
        self.assertIsNotNone(source)
        self.assertEqual(source.status, "ready")
        self.assertGreaterEqual(source.inputFps or 0, 9.5)
        self.assertGreaterEqual(source.normalizedFps, source.inputFps or 0)
        self.assertGreaterEqual(source.frameCount, 10)

        frames = self.service.get_editor_bundle("CAM-ACPDS-01").lotDefinition.frames
        self.assertGreaterEqual(len(frames), 10)
        self.assertIn(".", frames[0].capturedAt)
        self.assertNotEqual(frames[0].capturedAt, frames[1].capturedAt)

    def test_editor_bundle_and_video_source_endpoint_are_available(self):
        app = create_app()
        app.state.service = self.service

        with TestClient(app) as client:
            bundle_response = client.get(f"/api/editor/cameras/{self.service.get_active_config().cameraId}/bundle")
            self.assertEqual(bundle_response.status_code, 200)
            self.assertIn("videoSource", bundle_response.json())
            self.assertEqual(bundle_response.json()["videoSource"]["status"], "ready")

            video_source_response = client.get(f"/api/editor/cameras/{self.service.get_active_config().cameraId}/video-source")
            self.assertEqual(video_source_response.status_code, 200)
            self.assertEqual(video_source_response.json()["status"], "ready")

    def test_video_map_supports_nonstandard_video_filenames(self):
        mapped_videos_dir = Path(self.temp_dir.name) / "mapped-videos"
        mapped_videos_dir.mkdir(parents=True, exist_ok=True)
        self._create_demo_video("PTL1", directory=mapped_videos_dir)
        (mapped_videos_dir / "video-map.json").write_text(
            '{"CAM-ACPDS-01": "PTL1.mp4"}',
            encoding="utf-8",
        )

        service = DemoService(
            lot_path=self.lot_path,
            db_path=Path(self.temp_dir.name) / "mapped-hack26.db",
            videos_dir=mapped_videos_dir,
        )
        try:
            source = service.get_video_source("CAM-ACPDS-01")
            self.assertIsNotNone(source)
            self.assertEqual(source.status, "ready")
            self.assertEqual(source.frameCount > 0, True)
            bundle = service.get_editor_bundle("CAM-ACPDS-01")
            self.assertTrue(bundle.lotDefinition.frames[0].id.startswith("CAM-ACPDS-01-video-"))
        finally:
            service.close()

    def test_editor_bundle_uses_selected_version_layout_for_the_requested_camera(self):
        source_camera_id = self.service.get_active_config().cameraId
        target_camera_id = "CAM-SECONDARY"
        cloned = self.service.clone_spatial_config(
            target_camera_id,
            CameraPresetCloneRequest(
                sourceCameraId=source_camera_id,
                sourceVersion=self.service.get_active_config(source_camera_id).version,
                targetName="Secondary preset",
                activate=False,
            ),
        )
        self.assertEqual(cloned.cameraId, target_camera_id)
        self.assertEqual(cloned.camera.id, target_camera_id)
        changed = cloned.model_copy(
            update={
                "partitions": [
                    partition.model_copy(
                        update={"gridColumns": 7 if index == 0 else partition.gridColumns}
                    )
                    for index, partition in enumerate(cloned.partitions)
                ]
            }
        )
        self.service.update_spatial_config_version(target_camera_id, cloned.version, changed)

        bundle = self.service.get_editor_bundle(target_camera_id, version=cloned.version)

        self.assertEqual(bundle.selected.cameraId, target_camera_id)
        self.assertTrue(all(entry.cameraId == target_camera_id for entry in bundle.versions))
        self.assertEqual(bundle.lotDefinition.camera.id, target_camera_id)
        self.assertEqual(bundle.lotDefinition.partitions[0].gridColumns, 7)

    def test_editor_bundle_frames_are_served_through_api_urls(self):
        camera_id = self.service.get_active_config().cameraId
        bundle = self.service.get_editor_bundle(camera_id)

        self.assertGreaterEqual(len(bundle.lotDefinition.frames), 1)
        self.assertTrue(
            bundle.lotDefinition.frames[0].imagePath.startswith(f"/api/live/frame/{bundle.lotDefinition.frames[0].id}")
        )

    def test_legacy_snapshot_uses_canonical_live_frame_urls(self):
        legacy_snapshot = self.service.get_snapshot()

        self.assertGreaterEqual(len(legacy_snapshot["cameras"]), 1)
        self.assertTrue(legacy_snapshot["cameras"][0]["frameUrl"].startswith("/api/live/frame/"))
        self.assertIn("cameraId=", legacy_snapshot["cameras"][0]["frameUrl"])

    def test_video_inventory_creates_matching_demo_cameras(self):
        inventory_videos_dir = Path(self.temp_dir.name) / "inventory-videos"
        inventory_videos_dir.mkdir(parents=True, exist_ok=True)
        for video_name in ["PTL1", "PTL2", "PTL3", "PTL4"]:
            self._create_demo_video(video_name, directory=inventory_videos_dir)

        service = DemoService(
            lot_path=self.lot_path,
            db_path=Path(self.temp_dir.name) / "inventory-hack26.db",
            videos_dir=inventory_videos_dir,
        )
        try:
            camera_ids = service.backend.pipeline.list_camera_ids()
            self.assertEqual(camera_ids, ["PTL1", "PTL2", "PTL3", "PTL4"])
            lot_definition = service.get_lot_definition()
            self.assertEqual([camera.id for camera in lot_definition.cameras], ["PTL1", "PTL2", "PTL3", "PTL4"])
            slots_by_camera = Counter(slot.cameraId for slot in lot_definition.slots)
            self.assertEqual(sorted(slots_by_camera.keys()), ["PTL1", "PTL2", "PTL3", "PTL4"])
            self.assertTrue(all(count > 0 for count in slots_by_camera.values()))
        finally:
            service.close()

    def test_live_snapshot_uses_selected_camera_observation_polygons_for_feed_alignment(self):
        inventory_videos_dir = Path(self.temp_dir.name) / "overlay-inventory-videos"
        inventory_videos_dir.mkdir(parents=True, exist_ok=True)
        for video_name in ["PTL1", "PTL2"]:
            self._create_demo_video(video_name, directory=inventory_videos_dir)

        service = DemoService(
            lot_path=self.lot_path,
            db_path=Path(self.temp_dir.name) / "overlay-inventory-hack26.db",
            videos_dir=inventory_videos_dir,
        )
        try:
            snapshot = service.get_live_snapshot("PTL2")
            slot = next(
                slot
                for level in snapshot.levels
                for slot in level.slots
                if slot.imagePolygonsByCamera.get("PTL2")
            )
            active_config = service.get_active_config("PTL2")
            expected_polygon = next(
                (
                    polygon.imagePolygon
                    for polygon in active_config.observationPolygons
                    if polygon.canonicalBayId == slot.id
                ),
                next(
                    bay.imagePolygon
                    for bay in active_config.bays
                    if bay.id == slot.id
                ),
            )
            self.assertEqual(slot.imagePolygon, expected_polygon)
            self.assertEqual(slot.imagePolygonsByCamera.get("PTL2"), expected_polygon)
        finally:
            service.close()

    def test_editor_cover_projection_restores_frame_space_coordinates_for_wide_video_frames(self):
        original = [
            (0.08, 0.78),
            (0.2, 0.82),
            (0.22, 0.66),
            (0.1, 0.64),
        ]

        editor_width = 1000
        editor_height = 640
        frame_width = 1280
        frame_height = 720
        scaled_width = editor_height * (frame_width / frame_height)
        crop_x = (scaled_width - editor_width) / 2
        distorted = [
            (((x * scaled_width) - crop_x) / editor_width, y)
            for x, y in original
        ]

        restored = _project_polygon_from_editor_cover_to_frame(
            distorted,
            frame_width,
            frame_height,
        )

        for (expected_x, expected_y), (actual_x, actual_y) in zip(original, restored, strict=True):
            self.assertAlmostEqual(actual_x, expected_x, places=6)
            self.assertAlmostEqual(actual_y, expected_y, places=6)

    def test_live_snapshot_is_facility_wide_but_selected_camera_slots_follow_selected_feed_frame(self):
        inventory_videos_dir = Path(self.temp_dir.name) / "aggregate-inventory-videos"
        inventory_videos_dir.mkdir(parents=True, exist_ok=True)
        for video_name in ["PTL1", "PTL2", "PTL3"]:
            self._create_demo_video(video_name, directory=inventory_videos_dir)

        service = DemoService(
            lot_path=self.lot_path,
            db_path=Path(self.temp_dir.name) / "aggregate-inventory-hack26.db",
            videos_dir=inventory_videos_dir,
        )
        try:
            snapshot = service.get_live_snapshot("PTL2")
            self.assertEqual(sorted(feed.id for feed in snapshot.cameras), ["PTL1", "PTL2", "PTL3"])
            snapshot_slots = [slot for level in snapshot.levels for slot in level.slots]
            self.assertGreater(len(snapshot_slots), 0)
            self.assertTrue({slot.frameId for slot in snapshot_slots}.issubset({feed.frameId for feed in snapshot.cameras}))
            self.assertTrue(all(slot.cameraId for slot in snapshot_slots))
        finally:
            service.close()

    def test_editor_bundle_hides_removed_video_cameras_from_current_inventory(self):
        inventory_videos_dir = Path(self.temp_dir.name) / "mutable-inventory-videos"
        inventory_videos_dir.mkdir(parents=True, exist_ok=True)
        for video_name in ["PTL1", "PTL2"]:
            self._create_demo_video(video_name, directory=inventory_videos_dir)

        service = DemoService(
            lot_path=self.lot_path,
            db_path=Path(self.temp_dir.name) / "mutable-inventory-hack26.db",
            videos_dir=inventory_videos_dir,
        )
        try:
            initial_bundle = service.get_editor_bundle("PTL1")
            self.assertEqual([camera.id for camera in initial_bundle.lotDefinition.cameras], ["PTL1", "PTL2"])

            (inventory_videos_dir / "PTL2.mp4").unlink()

            updated_bundle = service.get_editor_bundle("PTL1")
            self.assertEqual([camera.id for camera in updated_bundle.lotDefinition.cameras], ["PTL1"])
        finally:
            service.close()

    def test_reopening_service_preserves_existing_active_version_without_reseeding_conflict(self):
        camera_id = self.service.get_active_config().cameraId
        updated = self.service.get_active_config(camera_id).model_copy(
            update={"presetName": "Persisted preset"}
        )
        saved = self.service.save_spatial_config(updated)
        self.service.activate_spatial_config(camera_id, saved.version)
        self.service.close()

        self.service = DemoService(lot_path=self.lot_path, db_path=self.db_path, videos_dir=self.videos_dir)

        reopened = self.service.get_active_config(camera_id)
        self.assertEqual(reopened.version, saved.version)
        self.assertEqual(reopened.presetName, "Persisted preset")

    def test_archiving_active_preset_promotes_fallback_and_keeps_statuses_consistent(self):
        camera_id = self.service.get_active_config().cameraId
        baseline = self.service.get_active_config(camera_id)
        draft = self.service.save_spatial_config(
            baseline.model_copy(update={"presetName": "Archive me"})
        )
        activated = self.service.activate_spatial_config(camera_id, draft.version)

        archived = self.service.archive_spatial_config(camera_id, activated.version)
        reopened = self.service.get_active_config(camera_id)
        statuses = {entry.version: entry.status for entry in self.service.list_versions(camera_id)}

        self.assertEqual(archived.status, "archived")
        self.assertEqual(reopened.version, baseline.version)
        self.assertEqual(statuses[baseline.version], "active")
        self.assertEqual(statuses[activated.version], "archived")

    def test_save_spatial_config_rejects_invalid_zone_assignment(self):
        config = self.service.get_active_config()
        invalid = config.model_copy(update={"zones": [], "updatedAt": config.updatedAt})

        with self.assertRaises(ValueError):
            self.service.save_spatial_config(invalid)

    def test_save_spatial_config_rejects_disallowed_image_path(self):
        config = self.service.get_active_config()
        invalid = config.model_copy(
            update={
                "frames": [
                    frame.model_copy(update={"imagePath": "/etc/hosts"}) if index == 0 else frame
                    for index, frame in enumerate(config.frames)
                ],
                "updatedAt": config.updatedAt,
            }
        )

        with self.assertRaises(ValueError):
            self.service.save_spatial_config(invalid)

    def test_activate_spatial_config_rejects_persisted_disallowed_image_path(self):
        camera_id = self.service.get_active_config().cameraId
        baseline = self.service.get_active_config(camera_id)
        invalid = baseline.model_copy(
            update={
                "version": baseline.version + 1,
                "status": "draft",
                "updatedAt": "2026-03-25T10:15:00Z",
                "activatedAt": None,
                "frames": [
                    frame.model_copy(update={"imagePath": "/etc/hosts"}) if index == 0 else frame
                    for index, frame in enumerate(baseline.frames)
                ],
            }
        )
        self.service.backend.config_store.upsert_config(invalid)

        with self.assertRaises(ValueError):
            self.service.activate_spatial_config(camera_id, invalid.version)

        self.assertEqual(self.service.get_active_config(camera_id).version, baseline.version)

    def test_activate_config_endpoint_returns_400_for_persisted_disallowed_image_path(self):
        camera_id = self.service.get_active_config().cameraId
        baseline = self.service.get_active_config(camera_id)
        invalid = baseline.model_copy(
            update={
                "version": baseline.version + 1,
                "status": "draft",
                "updatedAt": "2026-03-25T10:20:00Z",
                "activatedAt": None,
                "frames": [
                    frame.model_copy(update={"imagePath": "/etc/hosts"}) if index == 0 else frame
                    for index, frame in enumerate(baseline.frames)
                ],
            }
        )
        self.service.backend.config_store.upsert_config(invalid)
        app = create_app()
        app.state.service = self.service

        with TestClient(app) as client:
            response = client.post(
                f"/api/spatial-configs/{camera_id}/activate",
                json={"version": invalid.version},
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "Requested spatial config version is invalid.")
        self.assertNotIn("/etc/hosts", response.json()["detail"])

    def test_frame_endpoints_fallback_to_placeholder_for_disallowed_image_path(self):
        legacy_videos_dir = Path(self.temp_dir.name) / "legacy-frame-fallback-videos"
        legacy_videos_dir.mkdir(parents=True, exist_ok=True)
        service = DemoService(
            lot_path=self.lot_path,
            db_path=Path(self.temp_dir.name) / "legacy-frame-fallback-hack26.db",
            videos_dir=legacy_videos_dir,
        )
        active = service.get_active_config()
        frame_id = active.frames[0].id
        invalid_active = active.model_copy(
            update={
                "frames": [
                    frame.model_copy(update={"imagePath": "/etc/hosts"}) if frame.id == frame_id else frame
                    for frame in active.frames
                ],
            }
        )
        service.backend.config_store.upsert_config(invalid_active)
        app = create_app()
        app.state.service = service

        try:
            with TestClient(app) as client:
                live_response = client.get(f"/api/live/frame/{frame_id}?cameraId={active.cameraId}")
                demo_response = client.get(f"/api/demo/frame/{frame_id}")

            for response in (live_response, demo_response):
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["content-type"], "image/svg+xml")
                self.assertIn("<svg", response.text)
                self.assertNotIn("localhost", response.text)
        finally:
            service.close()

    def test_live_api_and_sse_routes_exist(self):
        app = create_app()
        app.state.service = self.service

        with TestClient(app) as client:
            snapshot_response = client.get("/api/live/snapshot")
            self.assertEqual(snapshot_response.status_code, 200)
            self.assertIn("bayStates", snapshot_response.json())

            active_response = client.get(f"/api/spatial-configs/{self.service.get_active_config().cameraId}/active")
            self.assertEqual(active_response.status_code, 200)
            self.assertIn("active", active_response.json())
            self.assertIn("bays", active_response.json()["active"])
            bay_id = self.service.get_active_config().bays[0].id
            reserve_response = client.post(f"/api/live/bays/{bay_id}/reserve")
            self.assertEqual(reserve_response.status_code, 200)
            clear_response = client.post(f"/api/live/bays/{bay_id}/clear-override")
            self.assertEqual(clear_response.status_code, 200)
        live_route_paths = {
            route.path
            for route in app.router.routes
            if hasattr(route, "path")
        }
        self.assertIn("/api/live/stream", live_route_paths)
        self.assertIn("/api/live/events", live_route_paths)

    def test_global_config_routes_use_public_default_camera_id(self):
        app = create_app()
        app.state.service = self.service
        active_config = self.service.get_active_config()
        default_camera_id = active_config.cameraId
        self.service.get_default_camera_id = Mock(return_value=default_camera_id)
        self.service.backend._default_camera_id = lambda: (_ for _ in ()).throw(AssertionError("private default camera access should not be used"))

        with TestClient(app) as client:
            versions_response = client.get("/api/spatial-configs/versions")
            create_response = client.post("/api/spatial-configs/versions", json=active_config.model_dump())
            activate_response = client.post("/api/spatial-configs/activate", json={"version": active_config.version})

        self.assertEqual(versions_response.status_code, 200)
        self.assertEqual(create_response.status_code, 200)
        self.assertEqual(activate_response.status_code, 200)
        self.assertEqual(self.service.get_default_camera_id.call_count, 3)

    def test_live_stream_emits_snapshot_keepalive_and_buffering_headers(self):
        app = create_app()
        app.state.service = self.service
        app.state.live_stream_interval_seconds = 0.01
        app.state.live_stream_heartbeat_seconds = 0.01
        app.state.live_stream_max_duration_seconds = 0.03
        app.state.live_stream_retry_ms = 750

        with TestClient(app) as client:
            response = client.get("/api/live/stream")

        self.assertEqual(response.status_code, 200)
        self.assertIn("text/event-stream", response.headers["content-type"])
        self.assertEqual(response.headers["x-accel-buffering"], "no")
        self.assertIn("no-cache", response.headers["cache-control"])
        self.assertIn("retry: 750", response.text)
        self.assertIn("event: snapshot", response.text)
        self.assertIn(": keepalive", response.text)

    def test_live_bay_override_404_is_sanitized(self):
        app = create_app()
        app.state.service = self.service

        with TestClient(app) as client:
            response = client.post("/api/live/bays/BAY-DOES-NOT-EXIST/reserve")

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"], "Requested bay was not found.")
        self.assertNotIn("BAY-DOES-NOT-EXIST", response.json()["detail"])

    def test_live_event_history_endpoint_supports_filter_and_cursor_pagination(self):
        app = create_app()
        app.state.service = self.service
        primary_camera_id = self.service.get_active_config().cameraId

        self.service.backend.store.append_event(
            primary_camera_id,
            {
                "bayId": self.service.get_active_config().bays[0].id,
                "timestamp": "2026-03-23T11:57:30Z",
                "message": "Legacy raw bay payload",
            },
        )
        self.service.backend.store.append_event(
            primary_camera_id,
            {
                "id": "history-primary-1",
                "type": "slot_occupied",
                "severity": "info",
                "timestamp": "2026-03-23T11:58:00Z",
                "message": "Primary history event 1",
                "cameraId": primary_camera_id,
                "slotId": self.service.get_active_config().bays[0].id,
            },
        )
        self.service.backend.store.append_event(
            primary_camera_id,
            {
                "id": "history-primary-2",
                "type": "reserved_detected",
                "severity": "warning",
                "timestamp": "2026-03-23T11:59:00Z",
                "message": "Primary history event 2",
                "cameraId": primary_camera_id,
                "slotId": self.service.get_active_config().bays[1].id,
            },
        )
        self.service.backend.store.append_event(
            "CAM-HISTORY-ALT",
            {
                "id": "history-alt-1",
                "type": "alert_active",
                "severity": "critical",
                "timestamp": "2026-03-23T12:00:00Z",
                "message": "Alternate history event",
                "cameraId": "CAM-HISTORY-ALT",
            },
        )

        with TestClient(app) as client:
            first_page = client.get("/api/live/events?limit=2")
            self.assertEqual(first_page.status_code, 200)
            first_payload = first_page.json()
            self.assertEqual(
                [item["id"] for item in first_payload["items"][:2]],
                ["history-alt-1", "history-primary-2"],
            )
            self.assertIsNotNone(first_payload["nextCursor"])

            second_page = client.get(f"/api/live/events?limit=2&cursor={first_payload['nextCursor']}")
            self.assertEqual(second_page.status_code, 200)
            second_payload = second_page.json()
            self.assertEqual(second_payload["items"][0]["id"], "history-primary-1")
            self.assertNotIn(
                "history-primary-2",
                {item["id"] for item in second_payload["items"]},
            )

            filtered_page = client.get(f"/api/live/events?cameraId={primary_camera_id}&limit=5")
            self.assertEqual(filtered_page.status_code, 200)
            filtered_payload = filtered_page.json()
            filtered_ids = [item["id"] for item in filtered_payload["items"]]
            self.assertEqual(filtered_ids[:2], ["history-primary-2", "history-primary-1"])
            self.assertNotIn("history-alt-1", filtered_ids)
            self.assertNotIn("Legacy raw bay payload", {item["message"] for item in filtered_payload["items"]})

    def test_live_override_round_trips_in_snapshot(self):
        bay_id = self.service.get_active_config().bays[0].id
        reserve_result = self.service.reserve_bay(bay_id)
        self.assertTrue(reserve_result.override.active)
        self.assertEqual(reserve_result.override.status, "reserved")
        self.assertTrue(any(bay.bayId == bay_id and bay.status == "reserved" for bay in reserve_result.snapshot.bayStates))
        self.assertGreaterEqual(len(reserve_result.snapshot.events), 1)
        self.assertEqual(reserve_result.snapshot.events[0].type, "reserved_detected")
        self.assertEqual(reserve_result.snapshot.events[0].slotId, bay_id)
        reserve_history = self.service.backend.store.list_events(camera_id=reserve_result.override.cameraId, limit=5)
        self.assertIn("reserved_detected", [item.type for item in reserve_history.items])
        self.assertEqual(
            next(item.slotId for item in reserve_history.items if item.type == "reserved_detected"),
            bay_id,
        )

        clear_result = self.service.clear_bay_override(bay_id)
        self.assertFalse(clear_result.override.active)
        self.assertEqual(clear_result.override.status, "cleared")
        self.assertGreaterEqual(len(clear_result.snapshot.events), 1)
        self.assertEqual(clear_result.snapshot.events[0].type, "alert_cleared")
        self.assertEqual(clear_result.snapshot.events[0].slotId, bay_id)
        cleared_history = self.service.backend.store.list_events(camera_id=clear_result.override.cameraId, limit=5)
        self.assertIn("alert_cleared", [item.type for item in cleared_history.items[:3]])
        self.assertIn("reserved_detected", [item.type for item in cleared_history.items[:5]])
        self.assertEqual(cleared_history.items[0].slotId, bay_id)

    def test_refresh_persists_normalized_snapshot_events_to_live_history(self):
        class AlwaysOccupiedPredictor:
            def __init__(self):
                self.health = type("Health", (), {"mode": "model", "reason": "occupied"})()

            def predict(self, frame_path, observations, frame_width, frame_height, timestamp):
                return [
                    BayPrediction(bay_id=obs.canonicalBayId, occupied=True, confidence=0.96)
                    for obs in observations
                ]

        service = DemoService(
            lot_path=self.lot_path,
            db_path=Path(self.temp_dir.name) / "normalized-events-hack26.db",
            videos_dir=self.videos_dir,
        )
        service.pipeline.predictor = AlwaysOccupiedPredictor()
        try:
            camera_id = service.get_active_config().cameraId
            # Two refreshes needed: first seeds memory, second triggers
            # the debounce transition (StabilizationEngine requires occupied_seen >= 2).
            service.refresh_live_snapshot(camera_id)
            snapshot = service.refresh_live_snapshot(camera_id)

            self.assertGreaterEqual(len(snapshot.events), 1)
            self.assertIn("alert_active", {event.type for event in snapshot.events})
            self.assertTrue(
                {event.type for event in snapshot.events}.issubset(
                    {"slot_occupied", "slot_released", "alert_active", "reserved_detected", "alert_cleared"}
                )
            )
            self.assertNotIn("entry_count", {event.type for event in snapshot.events})
            self.assertNotIn("exit_count", {event.type for event in snapshot.events})

            history_page = service.backend.store.list_events(camera_id=camera_id, limit=50)
            self.assertEqual(
                [(event.id, event.type, event.message) for event in history_page.items[: len(snapshot.events)]],
                [(event.id, event.type, event.message) for event in snapshot.events],
            )
            self.assertTrue(
                {event.type for event in history_page.items}.issubset(
                    {"slot_occupied", "slot_released", "alert_active", "reserved_detected", "alert_cleared"}
                )
            )
        finally:
            service.close()

    def test_partition_and_overlay_editor_routes_require_explicit_version(self):
        app = create_app()
        app.state.service = self.service
        camera_id = self.service.get_active_config().cameraId
        version = self.service.get_active_config(camera_id).version

        with TestClient(app) as client:
            partitions_response = client.get(f"/api/editor/cameras/{camera_id}/partitions")
            self.assertEqual(partitions_response.status_code, 200)
            self.assertGreaterEqual(len(partitions_response.json()), 1)

            partition_payload = self.service.get_active_config().partitions[0].model_copy(
                update={"id": f"{camera_id}-custom-partition", "name": "Custom partition"}
            )
            create_partition_response = client.post(
                f"/api/editor/cameras/{camera_id}/partitions",
                json=partition_payload.model_dump(),
            )
            self.assertEqual(create_partition_response.status_code, 400)

            create_partition_response = client.post(
                f"/api/editor/cameras/{camera_id}/partitions?version={version}",
                json=partition_payload.model_dump(),
            )
            self.assertEqual(create_partition_response.status_code, 200)
            self.assertIn("partitions", create_partition_response.json())
            self.assertIn(
                f"{camera_id}-custom-partition",
                {item["id"] for item in create_partition_response.json()["partitions"]},
            )

            overlay_payload = self.service.get_active_config().observationPolygons[0].model_copy(
                update={
                    "id": f"{camera_id}-custom-overlay",
                    "canonicalBayId": self.service.get_active_config().bays[0].id,
                    "notes": "test overlay binding",
                }
            )
            create_overlay_response = client.post(
                f"/api/editor/cameras/{camera_id}/observation-polygons",
                json=overlay_payload.model_dump(),
            )
            self.assertEqual(create_overlay_response.status_code, 400)

            create_overlay_response = client.post(
                f"/api/editor/cameras/{camera_id}/observation-polygons?version={version}",
                json=overlay_payload.model_dump(),
            )
            self.assertEqual(create_overlay_response.status_code, 200)
            self.assertIn(
                f"{camera_id}-custom-overlay",
                {item["id"] for item in create_overlay_response.json()["observationPolygons"]},
            )

    def test_activating_global_layout_updates_all_camera_views(self):
        inventory_videos_dir = Path(self.temp_dir.name) / "sync-layout-videos"
        inventory_videos_dir.mkdir(parents=True, exist_ok=True)
        for video_name in ["PTL1", "PTL2"]:
            self._create_demo_video(video_name, directory=inventory_videos_dir)

        service = DemoService(
            lot_path=self.lot_path,
            db_path=Path(self.temp_dir.name) / "sync-layout-hack26.db",
            videos_dir=inventory_videos_dir,
        )
        try:
            baseline_ptl1 = service.get_active_config("PTL1")
            baseline_ptl2 = service.get_active_config("PTL2")
            changed = baseline_ptl1.model_copy(
                update={
                    "partitions": [
                        partition.model_copy(
                            update={
                                "gridColumns": partition.gridColumns + 3 if index == 0 else partition.gridColumns
                            }
                        )
                        for index, partition in enumerate(baseline_ptl1.partitions)
                    ]
                }
            )
            service.update_spatial_config_version("PTL1", baseline_ptl1.version, changed)
            service.activate_spatial_config("PTL1", baseline_ptl1.version)

            ptl1 = service.get_active_config("PTL1")
            ptl2 = service.get_active_config("PTL2")
            aggregate = service.get_lot_definition()

            self.assertEqual(ptl1.partitions[0].gridColumns, baseline_ptl1.partitions[0].gridColumns + 3)
            self.assertEqual(ptl2.partitions[0].gridColumns, baseline_ptl2.partitions[0].gridColumns + 3)
            # Each camera sees only its own bays; aggregate sees all
            all_bay_ids = {bay.id for bay in ptl1.bays} | {bay.id for bay in ptl2.bays}
            self.assertEqual({slot.id for slot in aggregate.slots}, all_bay_ids)
        finally:
            service.close()

    def test_camera_scoped_save_normalizes_persisted_camera_identity(self):
        inventory_videos_dir = Path(self.temp_dir.name) / "camera-contract-videos"
        inventory_videos_dir.mkdir(parents=True, exist_ok=True)
        for video_name in ["PTL1", "PTL2"]:
            self._create_demo_video(video_name, directory=inventory_videos_dir)

        service = DemoService(
            lot_path=self.lot_path,
            db_path=Path(self.temp_dir.name) / "camera-contract-hack26.db",
            videos_dir=inventory_videos_dir,
        )
        try:
            source_config = service.get_active_config("PTL1")
            saved = service.save_spatial_config(source_config, "PTL2")
            persisted = service.backend.config_store.get_version("", saved.version)

            self.assertIsNotNone(persisted)
            self.assertEqual(saved.cameraId, "PTL2")
            self.assertEqual(saved.camera.id, "PTL2")
            self.assertEqual(persisted.cameraId, "PTL2")
            self.assertEqual(persisted.camera.id, "PTL2")
            self.assertEqual(service.list_versions("PTL2")[-1].cameraId, "PTL2")
        finally:
            service.close()

    def test_editor_bundle_keeps_global_bays_and_selected_camera_polygons(self):
        inventory_videos_dir = Path(self.temp_dir.name) / "camera-scope-videos"
        inventory_videos_dir.mkdir(parents=True, exist_ok=True)
        for video_name in ["PTL1", "PTL2"]:
            self._create_demo_video(video_name, directory=inventory_videos_dir)

        service = DemoService(
            lot_path=self.lot_path,
            db_path=Path(self.temp_dir.name) / "camera-scope-hack26.db",
            videos_dir=inventory_videos_dir,
        )
        try:
            bundle = service.get_editor_bundle("PTL2")
            overlay_bay_ids = {polygon.canonicalBayId for polygon in bundle.lotDefinition.observationPolygons}
            slot_ids = {slot.id for slot in bundle.lotDefinition.slots}

            self.assertTrue(overlay_bay_ids.issubset(slot_ids))
            # The lotDefinition now includes ALL observation polygons (global)
            # so the frontend can determine which cameras observe each bay.
            # At minimum, the requested camera's polygons should be present.
            ptl2_polygons = [p for p in bundle.lotDefinition.observationPolygons if p.cameraId == "PTL2"]
            self.assertTrue(len(ptl2_polygons) > 0 or len(bundle.lotDefinition.observationPolygons) == 0)
        finally:
            service.close()

    def test_editor_bundle_projects_slots_to_known_camera_inventory(self):
        inventory_videos_dir = Path(self.temp_dir.name) / "camera-slot-projection-videos"
        inventory_videos_dir.mkdir(parents=True, exist_ok=True)
        for video_name in ["PTL1", "PTL2"]:
            self._create_demo_video(video_name, directory=inventory_videos_dir)

        service = DemoService(
            lot_path=self.lot_path,
            db_path=Path(self.temp_dir.name) / "camera-slot-projection-hack26.db",
            videos_dir=inventory_videos_dir,
        )
        try:
            bundle = service.get_editor_bundle("PTL2")
            known_camera_ids = {camera.id for camera in bundle.lotDefinition.cameras}

            self.assertEqual(known_camera_ids, {"PTL1", "PTL2"})
            self.assertTrue(all(slot.cameraId in known_camera_ids for slot in bundle.lotDefinition.slots))
            self.assertTrue(
                all(
                    set(slot.ownerCameraIds).issubset(known_camera_ids)
                    for slot in bundle.lotDefinition.slots
                )
            )
        finally:
            service.close()

    def test_camera_view_config_uses_runtime_frame_dimensions_for_selected_camera(self):
        inventory_videos_dir = Path(self.temp_dir.name) / "camera-frame-dimensions-videos"
        inventory_videos_dir.mkdir(parents=True, exist_ok=True)
        for video_name in ["PTL1", "PTL2"]:
            self._create_demo_video(video_name, directory=inventory_videos_dir)

        service = DemoService(
            lot_path=self.lot_path,
            db_path=Path(self.temp_dir.name) / "camera-frame-dimensions-hack26.db",
            videos_dir=inventory_videos_dir,
        )
        try:
            active = service.get_active_config("PTL2")
            bundle = service.get_editor_bundle("PTL2")

            self.assertEqual((active.frameWidth, active.frameHeight), (96, 54))
            self.assertTrue(all(frame.cameraId == "PTL2" for frame in active.frames))
            self.assertTrue(all((frame.width, frame.height) == (96, 54) for frame in active.frames))
            self.assertTrue(all((frame.width, frame.height) == (96, 54) for frame in bundle.selected.frames))
            self.assertTrue(all((frame.width, frame.height) == (96, 54) for frame in bundle.lotDefinition.frames))
        finally:
            service.close()

    def test_refresh_all_persists_timeline_points_for_each_camera(self):
        inventory_videos_dir = Path(self.temp_dir.name) / "timeline-videos"
        inventory_videos_dir.mkdir(parents=True, exist_ok=True)
        for video_name in ["PTL1", "PTL2"]:
            self._create_demo_video(video_name, directory=inventory_videos_dir)

        service = DemoService(
            lot_path=self.lot_path,
            db_path=Path(self.temp_dir.name) / "timeline-hack26.db",
            videos_dir=inventory_videos_dir,
        )
        try:
            service.refresh_live_snapshot("PTL1")

            self.assertGreaterEqual(len(service.backend.store.list_timeline_points("PTL1")), 1)
            self.assertGreaterEqual(len(service.backend.store.list_timeline_points("PTL2")), 1)
        finally:
            service.close()

    def test_stabilization_debounces_bay_transitions(self):
        bay = SpatialBayDefinition(
            id="bay-1",
            label="Bay 1",
            row=1,
            column=1,
            levelId="level-1",
            partitionId="partition-1",
            cameraId="CAM-A",
            zoneId="zone-1",
            imagePolygon=[(0.1, 0.1), (0.3, 0.1), (0.3, 0.3), (0.1, 0.3)],
            layoutPolygon=[(0.1, 0.1), (0.3, 0.1), (0.3, 0.3), (0.1, 0.3)],
        )
        engine = StabilizationEngine()
        predictions = {
            "bay-1": BayPrediction(bay_id="bay-1", occupied=True, confidence=0.92),
        }

        first_states, events1 = engine.update([bay], predictions, "2026-03-19T10:00:00Z")
        second_states, events2 = engine.update([bay], predictions, "2026-03-19T10:00:01Z")

        # First frame: not yet confirmed (needs 2 frames)
        self.assertFalse(first_states[0].occupied)
        self.assertEqual(len(events1), 0)
        # Second frame: confirmed occupied
        self.assertTrue(second_states[0].occupied)
        self.assertEqual(len(events2), 1)
        self.assertEqual(events2[0]["bayId"], "bay-1")
        self.assertTrue(events2[0]["occupied"])

    def test_save_run_creates_and_activates_a_new_preset(self):
        config = self.service.get_active_config()
        def rect_from_polygon(points):
            xs = [x for x, _ in points]
            ys = [y for _, y in points]
            left = min(max(min(xs), 0.05), 0.9)
            top = min(max(min(ys), 0.05), 0.9)
            right = min(max(max(xs), left + 0.05), 0.95)
            bottom = min(max(max(ys), top + 0.05), 0.95)
            return [(left, top), (right, top), (right, bottom), (left, bottom)]

        def simple_line(points):
            if not points:
                return [(0.1, 0.1), (0.9, 0.1)]
            start_x, start_y = points[0]
            end_x, end_y = points[-1]
            return [
                (min(max(start_x, 0.05), 0.95), min(max(start_y, 0.05), 0.95)),
                (min(max(end_x, 0.05), 0.95), min(max(end_y, 0.05), 0.95)),
            ]

        changed = config.model_copy(
            update={
                "presetName": "Test preset",
                "updatedAt": config.updatedAt,
                "bays": [
                    bay.model_copy(
                        update={
                            "layoutPolygon": rect_from_polygon(bay.layoutPolygon),
                            "imagePolygon": rect_from_polygon(bay.imagePolygon),
                        }
                    )
                    for bay in config.bays
                ],
                "zones": [
                    zone.model_copy(
                        update={
                            "layoutPolygon": rect_from_polygon(zone.layoutPolygon),
                            "imagePolygon": rect_from_polygon(zone.imagePolygon),
                        }
                    )
                    for zone in config.zones
                ],
                "lines": [
                    line.model_copy(update={"points": simple_line(line.points), "layoutPoints": simple_line(line.layoutPoints or line.points)})
                    for line in config.lines
                ],
            }
        )
        result = self.service.save_run(config.cameraId, changed)
        self.assertEqual(result.status, "active")
        self.assertEqual(result.presetName, "Test preset")
        self.assertGreaterEqual(result.version, 1)


    def test_saving_camera_b_preserves_camera_a_draft_bays_and_observations(self):
        """Regression: saving from camera B must not lose camera A's bays/observations
        when camera A's save is still a draft (not yet activated)."""
        inventory_videos_dir = Path(self.temp_dir.name) / "cross-camera-draft-videos"
        inventory_videos_dir.mkdir(parents=True, exist_ok=True)
        for video_name in ["CAM-A", "CAM-B"]:
            self._create_demo_video(video_name, directory=inventory_videos_dir)

        service = DemoService(
            lot_path=self.lot_path,
            db_path=Path(self.temp_dir.name) / "cross-camera-draft.db",
            videos_dir=inventory_videos_dir,
            bootstrap_layout="blank",
        )
        try:
            # --- Camera A: define bays on Plane 1, Zone 1 ---
            base = service.get_active_config("CAM-A")
            polygon_a = [(0.1, 0.1), (0.4, 0.1), (0.4, 0.4), (0.1, 0.4)]
            bay_a = SpatialBayDefinition(
                id="BAY-A1", label="A1", row=0, column=0,
                levelId="PLANE-01", partitionId="PLANE-01",
                cameraId="CAM-A", sourceCameraIds=["CAM-A"],
                zoneId="ZONE-A", imagePolygon=polygon_a, layoutPolygon=polygon_a,
            )
            obs_a = CameraObservationPolygon(
                id="obs-CAM-A-BAY-A1", cameraId="CAM-A", presetVersion=base.version,
                canonicalBayId="BAY-A1", imagePolygon=polygon_a,
            )
            zone_a = SpatialZoneDefinition(
                id="ZONE-A", label="Zone A", levelId="PLANE-01",
                imagePolygon=polygon_a, layoutPolygon=polygon_a, bayIds=["BAY-A1"],
            )
            config_a = base.model_copy(update={
                "bays": [bay_a],
                "observationPolygons": [obs_a],
                "zones": [zone_a],
            })
            saved_a = service.save_spatial_config(config_a, camera_id="CAM-A")

            # --- Camera B: define different bays ---
            base_b = service.get_active_config("CAM-B")
            polygon_b = [(0.5, 0.5), (0.9, 0.5), (0.9, 0.9), (0.5, 0.9)]
            bay_b = SpatialBayDefinition(
                id="BAY-B1", label="B1", row=0, column=1,
                levelId="PLANE-01", partitionId="PLANE-01",
                cameraId="CAM-B", sourceCameraIds=["CAM-B"],
                zoneId="ZONE-B", imagePolygon=polygon_b, layoutPolygon=polygon_b,
            )
            obs_b = CameraObservationPolygon(
                id="obs-CAM-B-BAY-B1", cameraId="CAM-B", presetVersion=base_b.version,
                canonicalBayId="BAY-B1", imagePolygon=polygon_b,
            )
            zone_b = SpatialZoneDefinition(
                id="ZONE-B", label="Zone B", levelId="PLANE-01",
                imagePolygon=polygon_b, layoutPolygon=polygon_b, bayIds=["BAY-B1"],
            )
            config_b = base_b.model_copy(update={
                "bays": [bay_b],
                "observationPolygons": [obs_b],
                "zones": [zone_b],
            })
            saved_b = service.save_spatial_config(config_b, camera_id="CAM-B")

            # --- Verify: the latest version must contain BOTH cameras' data ---
            latest = service.backend.config_store.get_latest_config("")
            self.assertIsNotNone(latest)
            bay_ids = {bay.id for bay in latest.bays}
            obs_bay_ids = {obs.canonicalBayId for obs in latest.observationPolygons}
            self.assertIn("BAY-A1", bay_ids, "Camera A's bay lost after Camera B save")
            self.assertIn("BAY-B1", bay_ids, "Camera B's bay missing")
            self.assertIn("BAY-A1", obs_bay_ids, "Camera A's observation lost after Camera B save")
            self.assertIn("BAY-B1", obs_bay_ids, "Camera B's observation missing")

            # --- Verify: loading Camera A's editor bundle still shows its bays ---
            bundle_a = service.get_editor_bundle("CAM-A")
            editor_bay_ids = {slot.id for slot in bundle_a.lotDefinition.slots}
            editor_obs_bays = {p.canonicalBayId for p in bundle_a.selected.observationPolygons}
            self.assertIn("BAY-A1", editor_bay_ids, "Camera A's bay not visible in editor after Camera B save")
            self.assertIn("BAY-A1", editor_obs_bays, "Camera A's observation not visible in editor after Camera B save")
        finally:
            service.close()


    def test_cross_camera_save_via_update_version_preserves_other_camera(self):
        """Regression: update_spatial_config_version for camera B must not lose camera A's data."""
        inventory_videos_dir = Path(self.temp_dir.name) / "update-version-cross-videos"
        inventory_videos_dir.mkdir(parents=True, exist_ok=True)
        for video_name in ["CAM-A", "CAM-B"]:
            self._create_demo_video(video_name, directory=inventory_videos_dir)

        service = DemoService(
            lot_path=self.lot_path,
            db_path=Path(self.temp_dir.name) / "update-version-cross.db",
            videos_dir=inventory_videos_dir,
            bootstrap_layout="blank",
        )
        try:
            polygon_a = [(0.1, 0.1), (0.4, 0.1), (0.4, 0.4), (0.1, 0.4)]
            polygon_b = [(0.5, 0.5), (0.9, 0.5), (0.9, 0.9), (0.5, 0.9)]

            # --- Step 1: Camera A get_editor_bundle → draw bays → save_spatial_config ---
            bundle_a = service.get_editor_bundle("CAM-A")
            config_a = bundle_a.selected.model_copy(update={
                "bays": [SpatialBayDefinition(
                    id="BAY-A1", label="A1", row=0, column=0,
                    levelId="PLANE-01", partitionId="PLANE-01",
                    cameraId="CAM-A", sourceCameraIds=["CAM-A"],
                    zoneId="ZONE-A", imagePolygon=polygon_a, layoutPolygon=polygon_a,
                )],
                "observationPolygons": [CameraObservationPolygon(
                    id="obs-CAM-A-BAY-A1", cameraId="CAM-A",
                    presetVersion=bundle_a.selected.version,
                    canonicalBayId="BAY-A1", imagePolygon=polygon_a,
                )],
                "zones": [SpatialZoneDefinition(
                    id="ZONE-A", label="Zone A", levelId="PLANE-01",
                    imagePolygon=polygon_a, layoutPolygon=polygon_a, bayIds=["BAY-A1"],
                )],
            })
            saved_a = service.save_spatial_config(config_a, camera_id="CAM-A")

            # Verify V2 on disk has Camera A's data
            v2 = service.backend.config_store.get_version("", saved_a.version)
            self.assertEqual({bay.id for bay in v2.bays}, {"BAY-A1"})
            self.assertEqual({obs.canonicalBayId for obs in v2.observationPolygons}, {"BAY-A1"})

            # --- Step 2: Camera B get_editor_bundle → draw bays → save_spatial_config ---
            bundle_b = service.get_editor_bundle("CAM-B")
            config_b = bundle_b.selected.model_copy(update={
                "bays": [SpatialBayDefinition(
                    id="BAY-B1", label="B1", row=0, column=1,
                    levelId="PLANE-01", partitionId="PLANE-01",
                    cameraId="CAM-B", sourceCameraIds=["CAM-B"],
                    zoneId="ZONE-B", imagePolygon=polygon_b, layoutPolygon=polygon_b,
                )],
                "observationPolygons": [CameraObservationPolygon(
                    id="obs-CAM-B-BAY-B1", cameraId="CAM-B",
                    presetVersion=bundle_b.selected.version,
                    canonicalBayId="BAY-B1", imagePolygon=polygon_b,
                )],
                "zones": [SpatialZoneDefinition(
                    id="ZONE-B", label="Zone B", levelId="PLANE-01",
                    imagePolygon=polygon_b, layoutPolygon=polygon_b, bayIds=["BAY-B1"],
                )],
            })
            saved_b = service.save_spatial_config(config_b, camera_id="CAM-B")

            # Verify the latest version on disk has BOTH cameras' data
            latest = service.backend.config_store.get_latest_config("")
            bay_ids = {bay.id for bay in latest.bays}
            obs_bay_ids = {obs.canonicalBayId for obs in latest.observationPolygons}
            self.assertEqual(bay_ids, {"BAY-A1", "BAY-B1"}, f"Expected both bays, got {bay_ids}")
            self.assertEqual(obs_bay_ids, {"BAY-A1", "BAY-B1"}, f"Expected both obs, got {obs_bay_ids}")

            # --- Step 3: Reload Camera A's editor → data must survive ---
            bundle_a2 = service.get_editor_bundle("CAM-A")
            editor_a_bay_ids = {slot.id for slot in bundle_a2.lotDefinition.slots}
            editor_a_obs = {p.canonicalBayId for p in bundle_a2.selected.observationPolygons}
            self.assertIn("BAY-A1", editor_a_bay_ids, f"Camera A bay lost, got: {editor_a_bay_ids}")
            self.assertIn("BAY-A1", editor_a_obs, f"Camera A obs lost, got: {editor_a_obs}")

            # --- Step 4: Now test update_spatial_config_version path ---
            # Camera A saves AGAIN via update (simulating the "Save" button on an already-persisted preset)
            polygon_a2 = [(0.15, 0.15), (0.45, 0.15), (0.45, 0.45), (0.15, 0.45)]
            bay_a2 = SpatialBayDefinition(
                id="BAY-A2", label="A2", row=0, column=2,
                levelId="PLANE-01", partitionId="PLANE-01",
                cameraId="CAM-A", sourceCameraIds=["CAM-A"],
                zoneId="ZONE-A", imagePolygon=polygon_a2, layoutPolygon=polygon_a2,
            )
            obs_a2 = CameraObservationPolygon(
                id="obs-CAM-A-BAY-A2", cameraId="CAM-A",
                presetVersion=saved_a.version,
                canonicalBayId="BAY-A2", imagePolygon=polygon_a2,
            )
            update_config = bundle_a2.selected.model_copy(update={
                "bays": [
                    SpatialBayDefinition(
                        id="BAY-A1", label="A1", row=0, column=0,
                        levelId="PLANE-01", partitionId="PLANE-01",
                        cameraId="CAM-A", sourceCameraIds=["CAM-A"],
                        zoneId="ZONE-A", imagePolygon=polygon_a, layoutPolygon=polygon_a,
                    ),
                    bay_a2,
                ],
                "observationPolygons": [
                    CameraObservationPolygon(
                        id="obs-CAM-A-BAY-A1", cameraId="CAM-A",
                        presetVersion=saved_a.version,
                        canonicalBayId="BAY-A1", imagePolygon=polygon_a,
                    ),
                    obs_a2,
                ],
                "zones": [SpatialZoneDefinition(
                    id="ZONE-A", label="Zone A", levelId="PLANE-01",
                    imagePolygon=polygon_a, layoutPolygon=polygon_a, bayIds=["BAY-A1", "BAY-A2"],
                )],
            })
            updated = service.update_spatial_config_version("CAM-A", saved_a.version, update_config)

            # Verify Camera B's data survived the update
            updated_disk = service.backend.config_store.get_version("", updated.version)
            updated_bay_ids = {bay.id for bay in updated_disk.bays}
            updated_obs_ids = {obs.canonicalBayId for obs in updated_disk.observationPolygons}
            self.assertIn("BAY-B1", updated_bay_ids, f"Camera B bay lost after Camera A update, got: {updated_bay_ids}")
            self.assertIn("BAY-B1", updated_obs_ids, f"Camera B obs lost after Camera A update, got: {updated_obs_ids}")
            self.assertIn("BAY-A1", updated_bay_ids)
            self.assertIn("BAY-A2", updated_bay_ids)

        finally:
            service.close()

    def test_save_run_cross_camera_preserves_other_camera(self):
        """Regression: save_run for camera B must not lose camera A's data."""
        inventory_videos_dir = Path(self.temp_dir.name) / "save-run-cross-videos"
        inventory_videos_dir.mkdir(parents=True, exist_ok=True)
        for video_name in ["CAM-A", "CAM-B"]:
            self._create_demo_video(video_name, directory=inventory_videos_dir)

        service = DemoService(
            lot_path=self.lot_path,
            db_path=Path(self.temp_dir.name) / "save-run-cross.db",
            videos_dir=inventory_videos_dir,
            bootstrap_layout="blank",
        )
        try:
            polygon_a = [(0.1, 0.1), (0.4, 0.1), (0.4, 0.4), (0.1, 0.4)]
            polygon_b = [(0.5, 0.5), (0.9, 0.5), (0.9, 0.9), (0.5, 0.9)]

            # --- Camera A: save_run (simulates "Save & Run" from editor) ---
            base_a = service.get_active_config("CAM-A")
            config_a = base_a.model_copy(update={
                "bays": [SpatialBayDefinition(
                    id="BAY-A1", label="A1", row=0, column=0,
                    levelId="PLANE-01", partitionId="PLANE-01",
                    cameraId="CAM-A", sourceCameraIds=["CAM-A"],
                    zoneId="ZONE-A", imagePolygon=polygon_a, layoutPolygon=polygon_a,
                )],
                "observationPolygons": [CameraObservationPolygon(
                    id="obs-CAM-A-BAY-A1", cameraId="CAM-A",
                    presetVersion=base_a.version,
                    canonicalBayId="BAY-A1", imagePolygon=polygon_a,
                )],
                "zones": [SpatialZoneDefinition(
                    id="ZONE-A", label="Zone A", levelId="PLANE-01",
                    imagePolygon=polygon_a, layoutPolygon=polygon_a, bayIds=["BAY-A1"],
                )],
            })
            activated_a = service.save_run("CAM-A", config_a)

            # Verify V1 is active and has Camera A's data
            v1 = service.backend.config_store.get_active_config("")
            self.assertIsNotNone(v1)
            self.assertEqual({bay.id for bay in v1.bays}, {"BAY-A1"})

            # --- Camera B: save_run ---
            base_b = service.get_active_config("CAM-B")
            config_b = base_b.model_copy(update={
                "bays": [SpatialBayDefinition(
                    id="BAY-B1", label="B1", row=0, column=1,
                    levelId="PLANE-01", partitionId="PLANE-01",
                    cameraId="CAM-B", sourceCameraIds=["CAM-B"],
                    zoneId="ZONE-B", imagePolygon=polygon_b, layoutPolygon=polygon_b,
                )],
                "observationPolygons": [CameraObservationPolygon(
                    id="obs-CAM-B-BAY-B1", cameraId="CAM-B",
                    presetVersion=base_b.version,
                    canonicalBayId="BAY-B1", imagePolygon=polygon_b,
                )],
                "zones": [SpatialZoneDefinition(
                    id="ZONE-B", label="Zone B", levelId="PLANE-01",
                    imagePolygon=polygon_b, layoutPolygon=polygon_b, bayIds=["BAY-B1"],
                )],
            })
            activated_b = service.save_run("CAM-B", config_b)

            # Verify the active config has BOTH cameras' data
            active = service.backend.config_store.get_active_config("")
            self.assertIsNotNone(active)
            bay_ids = {bay.id for bay in active.bays}
            obs_bay_ids = {obs.canonicalBayId for obs in active.observationPolygons}
            self.assertIn("BAY-A1", bay_ids, f"Camera A bay lost after save_run B, got: {bay_ids}")
            self.assertIn("BAY-B1", bay_ids, f"Camera B bay missing, got: {bay_ids}")
            self.assertIn("BAY-A1", obs_bay_ids, f"Camera A obs lost, got: {obs_bay_ids}")
            self.assertIn("BAY-B1", obs_bay_ids, f"Camera B obs missing, got: {obs_bay_ids}")

            # Verify Camera A's editor bundle still shows its bays
            bundle_a = service.get_editor_bundle("CAM-A")
            self.assertIn("BAY-A1", {s.id for s in bundle_a.lotDefinition.slots})
        finally:
            service.close()


    def test_shared_bay_ids_across_cameras_preserves_source_camera_ids(self):
        """Regression: when two cameras observe the SAME bays (same IDs), saving
        from camera B must merge sourceCameraIds so camera A still sees the bays."""
        inventory_videos_dir = Path(self.temp_dir.name) / "shared-bay-ids-videos"
        inventory_videos_dir.mkdir(parents=True, exist_ok=True)
        for video_name in ["CAM-A", "CAM-B"]:
            self._create_demo_video(video_name, directory=inventory_videos_dir)

        service = DemoService(
            lot_path=self.lot_path,
            db_path=Path(self.temp_dir.name) / "shared-bay-ids.db",
            videos_dir=inventory_videos_dir,
            bootstrap_layout="blank",
        )
        try:
            polygon_a = [(0.1, 0.1), (0.4, 0.1), (0.4, 0.4), (0.1, 0.4)]
            polygon_b = [(0.5, 0.5), (0.9, 0.5), (0.9, 0.9), (0.5, 0.9)]

            # --- Camera A saves with bays B01, B02 (sourceCameraIds=["CAM-A"]) ---
            base = service.get_active_config("CAM-A")
            bays_a = [
                SpatialBayDefinition(
                    id="B01", label="Bay 1", row=0, column=0,
                    levelId="PLANE-01", partitionId="PLANE-01",
                    cameraId="CAM-A", sourceCameraIds=["CAM-A"],
                    zoneId="Z1", imagePolygon=polygon_a, layoutPolygon=polygon_a,
                ),
                SpatialBayDefinition(
                    id="B02", label="Bay 2", row=0, column=1,
                    levelId="PLANE-01", partitionId="PLANE-01",
                    cameraId="CAM-A", sourceCameraIds=["CAM-A"],
                    zoneId="Z1", imagePolygon=polygon_a, layoutPolygon=polygon_a,
                ),
            ]
            obs_a = [
                CameraObservationPolygon(
                    id="obs-CAM-A-B01", cameraId="CAM-A", presetVersion=base.version,
                    canonicalBayId="B01", imagePolygon=polygon_a,
                ),
                CameraObservationPolygon(
                    id="obs-CAM-A-B02", cameraId="CAM-A", presetVersion=base.version,
                    canonicalBayId="B02", imagePolygon=polygon_a,
                ),
            ]
            config_a = base.model_copy(update={
                "bays": bays_a, "observationPolygons": obs_a,
                "zones": [SpatialZoneDefinition(
                    id="Z1", label="Zone 1", levelId="PLANE-01",
                    imagePolygon=polygon_a, layoutPolygon=polygon_a, bayIds=["B01", "B02"],
                )],
            })
            service.save_spatial_config(config_a, camera_id="CAM-A")

            # --- Camera B saves the SAME bay IDs with its own observation polygons ---
            # (simulates the frontend sending all bays but with sourceCameraIds=["CAM-B"])
            bays_b = [
                SpatialBayDefinition(
                    id="B01", label="Bay 1", row=0, column=0,
                    levelId="PLANE-01", partitionId="PLANE-01",
                    cameraId="CAM-B", sourceCameraIds=["CAM-B"],
                    zoneId="Z1", imagePolygon=polygon_b, layoutPolygon=polygon_a,
                ),
                SpatialBayDefinition(
                    id="B02", label="Bay 2", row=0, column=1,
                    levelId="PLANE-01", partitionId="PLANE-01",
                    cameraId="CAM-B", sourceCameraIds=["CAM-B"],
                    zoneId="Z1", imagePolygon=polygon_b, layoutPolygon=polygon_a,
                ),
            ]
            obs_b = [
                CameraObservationPolygon(
                    id="obs-CAM-B-B01", cameraId="CAM-B", presetVersion=1,
                    canonicalBayId="B01", imagePolygon=polygon_b,
                ),
                CameraObservationPolygon(
                    id="obs-CAM-B-B02", cameraId="CAM-B", presetVersion=1,
                    canonicalBayId="B02", imagePolygon=polygon_b,
                ),
            ]
            # Also include Camera A's observation polygons (the frontend preserves these)
            config_b = base.model_copy(update={
                "bays": bays_b,
                "observationPolygons": obs_a + obs_b,
                "zones": [SpatialZoneDefinition(
                    id="Z1", label="Zone 1", levelId="PLANE-01",
                    imagePolygon=polygon_a, layoutPolygon=polygon_a, bayIds=["B01", "B02"],
                )],
            })
            service.save_spatial_config(config_b, camera_id="CAM-B")

            # --- Verify: bays must have BOTH cameras in sourceCameraIds ---
            latest = service.backend.config_store.get_latest_config("")
            self.assertIsNotNone(latest)
            for bay in latest.bays:
                self.assertIn("CAM-A", bay.sourceCameraIds,
                    f"Bay {bay.id} lost CAM-A from sourceCameraIds: {bay.sourceCameraIds}")
                self.assertIn("CAM-B", bay.sourceCameraIds,
                    f"Bay {bay.id} lost CAM-B from sourceCameraIds: {bay.sourceCameraIds}")

            # --- Verify: project_config_to_camera for CAM-A still shows the bays ---
            from backend.runtime.spatial_config import project_config_to_camera
            projected_a = project_config_to_camera(latest, "CAM-A")
            projected_a_bay_ids = {bay.id for bay in projected_a.bays}
            self.assertEqual(projected_a_bay_ids, {"B01", "B02"},
                f"Camera A can't see bays after Camera B save: {projected_a_bay_ids}")

            projected_b = project_config_to_camera(latest, "CAM-B")
            projected_b_bay_ids = {bay.id for bay in projected_b.bays}
            self.assertEqual(projected_b_bay_ids, {"B01", "B02"},
                f"Camera B can't see bays: {projected_b_bay_ids}")
        finally:
            service.close()


def _cors_middleware(app):
    return next(middleware for middleware in app.user_middleware if middleware.cls is CORSMiddleware)


if __name__ == "__main__":
    unittest.main()
