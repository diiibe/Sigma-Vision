from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend.demo_service import DemoService
from backend.demo_service import LOT_DEFINITION_PATH
from backend.models import CameraFeed, FacilityMetrics, FlowCounts, LiveStateSnapshot, LotDefinition, ParkingLevel, TimelinePoint
from backend.runtime.config_repository import SpatialConfigFileRepository
from backend.runtime.spatial_config import legacy_lot_to_spatial_configs
from backend.runtime.storage import SQLiteStore


class StorageArchitectureTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.lot_path = self.root / "lot-definition.json"
        self.lot_path.write_text(LOT_DEFINITION_PATH.read_text(encoding="utf-8"), encoding="utf-8")

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_file_repository_persists_versions_activation_and_archive(self):
        repo = SpatialConfigFileRepository(self.root / "canonical" / "spatial-configs")
        base_lot = LotDefinition.model_validate_json(self.lot_path.read_text(encoding="utf-8"))
        base_config = legacy_lot_to_spatial_configs(base_lot)[0]

        version_one = base_config.model_copy(
            update={
                "version": 1,
                "status": "active",
                "createdAt": "2026-03-24T10:00:00Z",
                "updatedAt": "2026-03-24T10:00:00Z",
                "activatedAt": "2026-03-24T10:00:00Z",
                "presetName": "Baseline",
            }
        )
        repo.upsert_config(version_one)
        repo.activate_config("", 1)

        version_two = version_one.model_copy(
            update={
                "version": 2,
                "status": "draft",
                "updatedAt": "2026-03-24T10:05:00Z",
                "activatedAt": None,
                "presetName": "Draft 02",
            }
        )
        repo.upsert_config(version_two)

        self.assertEqual([entry.version for entry in repo.list_versions("")], [1, 2])
        self.assertEqual(repo.get_active_config("").version, 1)
        self.assertTrue((repo.root_dir / "manifest.json").exists())
        self.assertTrue((repo.versions_dir / "000001.json").exists())
        self.assertTrue((repo.versions_dir / "000002.json").exists())

        activated = repo.activate_config("", 2)
        self.assertEqual(activated.version, 2)
        self.assertEqual(repo.get_active_config("").version, 2)
        self.assertEqual(repo.get_version("", 1).status, "draft")

        archived = repo.archive_config("", 2)
        self.assertEqual(archived.status, "archived")
        self.assertEqual(repo.get_active_config("").version, 1)

    def test_runtime_sqlite_prunes_history_and_omits_config_table(self):
        db_path = self.root / "runtime.sqlite"
        store = SQLiteStore(db_path, snapshot_retention=3, event_retention=4, timeline_retention=2)
        try:
            for index in range(6):
                store.save_live_snapshot(_make_snapshot("PTL1", index))
            for index in range(7):
                store.append_event(
                    "PTL1",
                    {
                        "id": f"evt-{index}",
                        "type": "sensor_update",
                        "severity": "info",
                        "timestamp": f"2026-03-24T10:00:0{index}Z",
                        "message": f"Event {index}",
                    },
                )
            for index in range(5):
                store.append_timeline_point(
                    "PTL1",
                    TimelinePoint(
                        bucketStart=f"2026-03-24T10:00:0{index}Z",
                        capturedAt=f"2026-03-24T10:00:0{index}Z",
                        occupancyRate=0.1 * index,
                        entries=0,
                        exits=0,
                        activeAlerts=0,
                        zoneId=None,
                    ),
                )

            with sqlite3.connect(db_path) as conn:
                snapshot_count = conn.execute(
                    "SELECT COUNT(*) FROM live_state_snapshots WHERE camera_id = ?",
                    ("PTL1",),
                ).fetchone()[0]
                event_count = conn.execute(
                    "SELECT COUNT(*) FROM live_events WHERE camera_id = ?",
                    ("PTL1",),
                ).fetchone()[0]
                timeline_count = conn.execute(
                    "SELECT COUNT(*) FROM timeline_points WHERE camera_id = ?",
                    ("PTL1",),
                ).fetchone()[0]
                table_names = {
                    row[0]
                    for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
                }

            self.assertEqual(snapshot_count, 3)
            self.assertEqual(event_count, 4)
            self.assertEqual(timeline_count, 2)
            self.assertNotIn("spatial_config_versions", table_names)
        finally:
            store.close()

    def test_service_bootstraps_from_canonical_manifest_and_fallbacks_to_lot(self):
        state_dir = self.root / "state"
        config_root = state_dir / "canonical" / "spatial-configs"
        runtime_db_path = state_dir / "runtime" / "runtime.sqlite"
        repo = SpatialConfigFileRepository(config_root)

        seed_service = DemoService(lot_path=self.lot_path, state_dir=self.root / "seed-state")
        try:
            seeded_config = seed_service.get_active_config().model_copy(
                update={
                    "version": 7,
                    "status": "active",
                    "createdAt": "2026-03-24T09:00:00Z",
                    "updatedAt": "2026-03-24T09:00:00Z",
                    "activatedAt": "2026-03-24T09:00:00Z",
                    "presetName": "Canonical Seed",
                }
            )
        finally:
            seed_service.close()

        repo.upsert_config(seeded_config)
        repo.activate_config("", seeded_config.version)

        service = DemoService(lot_path=self.lot_path, state_dir=state_dir, db_path=runtime_db_path)
        try:
            self.assertEqual(service.get_active_config().version, 7)
            self.assertEqual(service.get_active_config().presetName, "Canonical Seed")
        finally:
            service.close()

        fresh_service = DemoService(lot_path=self.lot_path, state_dir=self.root / "fresh-state")
        try:
            active = fresh_service.get_active_config()
            manifest_path = fresh_service.backend.config_root / "manifest.json"
            self.assertEqual(active.version, 1)
            self.assertTrue(manifest_path.exists())
            self.assertTrue((fresh_service.backend.config_root / "versions" / "000001.json").exists())
        finally:
            fresh_service.close()

    def test_service_can_bootstrap_a_blank_layout_without_demo_bays(self):
        service = DemoService(lot_path=self.lot_path, state_dir=self.root / "blank-state", bootstrap_layout="blank")
        try:
            active = service.get_active_config()
            bundle = service.get_editor_bundle(active.cameraId)

            self.assertEqual(active.sourceLotKey, "bootstrap:blank")
            self.assertEqual(active.bays, [])
            self.assertEqual(len(active.partitions), 1)
            self.assertEqual(bundle.lotDefinition.slots, [])
            self.assertEqual(len(bundle.lotDefinition.partitions), 1)
        finally:
            service.close()

    def test_editor_bundle_reopens_latest_saved_config_even_if_it_is_not_active(self):
        state_dir = self.root / "editor-reopen-state"
        service = DemoService(lot_path=self.lot_path, state_dir=state_dir)
        try:
            active = service.get_active_config()
            draft = active.model_copy(
                update={
                    "version": active.version + 1,
                    "status": "draft",
                    "presetName": "Saved Draft Config",
                    "updatedAt": "2026-03-24T11:00:00Z",
                    "activatedAt": None,
                }
            )
            service.save_spatial_config(draft)
        finally:
            service.close()

        reopened = DemoService(lot_path=self.lot_path, state_dir=state_dir)
        try:
            bundle = reopened.get_editor_bundle(active.cameraId)

            self.assertEqual(bundle.active.version, active.version)
            self.assertEqual(bundle.selectedVersion, draft.version)
            self.assertEqual(bundle.selected.presetName, "Saved Draft Config")
        finally:
            reopened.close()


def _make_snapshot(camera_id: str, index: int) -> LiveStateSnapshot:
    timestamp = f"2026-03-24T10:00:{index:02d}Z"
    return LiveStateSnapshot(
        facilityId="facility",
        facilityName="Facility",
        timeZone="Europe/Rome",
        cameraId=camera_id,
        activeCameraId=camera_id,
        configVersion=1,
        capturedAt=timestamp,
        systemStatus="online",
        connectionHealth="stable",
        config=None,
        levels=[
            ParkingLevel(
                id="L1",
                name="Level 1",
                index=0,
                elevation=0.0,
                dimensions={"width": 1, "height": 1},
                slots=[],
            )
        ],
        cameras=[
            CameraFeed(
                id=camera_id,
                name=camera_id,
                levelId="L1",
                location="Test",
                status="online",
                timestamp=timestamp,
                thumbnail="/frame.jpg",
                frameUrl="/frame.jpg",
                frameId=f"{camera_id}-frame-{index}",
                frameLabel=f"Capture {index}",
                imageWidth=100,
                imageHeight=100,
                angle="front",
                streamHealth=1.0,
            )
        ],
        bayStates=[],
        flowEvents=[],
        moduleHealth=[],
        detections=[],
        tracks=[],
        events=[],
        metrics=FacilityMetrics(
            totalSlots=0,
            occupiedSlots=0,
            freeSlots=0,
            evSlots=0,
            reservedSlots=0,
            unknownSlots=0,
            occupancyRate=0.0,
            onlineSensors=1,
            flaggedEvents=0,
            levelStats=[],
            entriesLastHour=0,
            exitsLastHour=0,
            activeAlerts=0,
        ),
        zoneKpis=[],
        counts=FlowCounts(),
        alerts=[],
        timeline=[],
        modules=[],
    )
