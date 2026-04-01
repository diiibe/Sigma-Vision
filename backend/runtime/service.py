from __future__ import annotations

import logging
import threading
from collections import defaultdict
from pathlib import Path
from typing import Any, Literal

from fastapi.responses import Response

from ..demo_paths import (
    get_backend_state_dir,
    get_demo_videos_dir,
    get_demo_weights_path,
    get_runtime_event_retention,
    get_runtime_snapshot_retention,
    get_runtime_timeline_retention,
)
from ..models import (
    BayOverrideActionResult,
    BayOverrideState,
    CameraFeed,
    CountingAggregatePoint,
    CountingEvent,
    DensitySnapshot,
    FlowCounts,
    LotCameraDefinition,
    CameraPresetAssignRequest,
    CameraPresetCloneRequest,
    CameraVideoSourceState,
    EditorCameraBundle,
    EventHistoryPage,
    FacilityMetrics,
    LevelMetric,
    LotDefinition,
    LotFrameDefinition,
    LotSlotDefinition,
    LayoutPartitionDefinition,
    LiveStateSnapshot,
    ParkingLevel,
    ParkingSlot,
    SpatialConfig,
    SpatialConfigVersionSummary,
    SystemEvent,
)
from .config_repository import SpatialConfigFileRepository
from .bootstrap_layout import build_blank_lot_definition
from .frame_paths import build_live_frame_url
from .media import frame_response
from .pipeline import LivePipelineService, StateStore
from ..predictor import build_predictor
from .spatial_config import (
    hash_string,
    iso_now,
    legacy_lot_to_spatial_configs,
    merge_camera_config_into_global,
    normalize_spatial_config,
    project_config_to_camera,
    spatial_config_to_legacy_lot,
)
from .storage import SQLiteStore
from .validation import validate_spatial_config
from .video_ingestion import VideoIngestionManager


logger = logging.getLogger(__name__)

SLOT_WIDTH = 1.04
SLOT_DEPTH = 0.58
COLUMN_SPACING = 1.34
ROW_SPACING = 2.12
EDITOR_IMAGE_CANVAS_WIDTH = 1000
EDITOR_IMAGE_CANVAS_HEIGHT = 640
FRAME_SPACE_NOTE = "coord-space:frame"


def _derive_state_dir_from_db_path(db_path: Path) -> Path:
    resolved = db_path.expanduser().resolve()
    if resolved.name == "runtime.sqlite" and resolved.parent.name == "runtime":
        return resolved.parent.parent
    return (resolved.parent / f"{resolved.stem}-state").resolve()


def _resolve_state_dir(state_dir: Path | None, db_path: Path | None) -> Path:
    if state_dir is not None:
        return state_dir.expanduser().resolve()
    if db_path is not None:
        return _derive_state_dir_from_db_path(db_path)
    return get_backend_state_dir()


def _resolve_runtime_db_path(state_dir: Path, db_path: Path | None) -> Path:
    if db_path is not None:
        return db_path.expanduser().resolve()
    return (state_dir / "runtime" / "runtime.sqlite").resolve()


def _resolve_config_root(state_dir: Path, config_root: Path | None) -> Path:
    if config_root is not None:
        return config_root.expanduser().resolve()
    return (state_dir / "canonical" / "spatial-configs").resolve()


def _resolve_recovery_root(state_dir: Path, recovery_dir: Path | None) -> Path:
    if recovery_dir is not None:
        return recovery_dir.expanduser().resolve()
    return (state_dir / "recovery").resolve()


class ParkingBackendService:
    def __init__(
        self,
        lot_path: Path,
        db_path: Path | None = None,
        *,
        state_dir: Path | None = None,
        config_root: Path | None = None,
        recovery_dir: Path | None = None,
        videos_dir: Path | None = None,
        enable_scheduler: bool = False,
        scheduler_interval_seconds: float = 1.0,
        bootstrap_layout: Literal["legacy", "blank"] = "legacy",
    ):
        self.lot_path = lot_path
        self.state_dir = _resolve_state_dir(state_dir, db_path)
        self.config_root = _resolve_config_root(self.state_dir, config_root)
        self.recovery_dir = _resolve_recovery_root(self.state_dir, recovery_dir)
        self.config_store = SpatialConfigFileRepository(self.config_root)
        runtime_db_path = _resolve_runtime_db_path(self.state_dir, db_path)
        self.store = SQLiteStore(
            runtime_db_path,
            snapshot_retention=get_runtime_snapshot_retention(),
            event_retention=get_runtime_event_retention(),
            timeline_retention=get_runtime_timeline_retention(),
        )
        self.state = StateStore()
        self.video_ingestion = VideoIngestionManager(self.store, self.config_store, videos_dir or get_demo_videos_dir())
        self.pipeline = LivePipelineService(
            self.store,
            self.config_store,
            self.state,
            self.video_ingestion,
            predictor=build_predictor(get_demo_weights_path()),
        )
        self.scheduler_interval_seconds = scheduler_interval_seconds
        self.bootstrap_layout = bootstrap_layout
        self._scheduler_stop = threading.Event()
        self._scheduler_thread: threading.Thread | None = None
        self._lock = threading.RLock()
        self._legacy_snapshot_cache: dict[str, Any] | None = None
        self._legacy_previous_statuses: dict[str, str] = {}
        self._legacy_event_counter = 0
        self.legacy_lot_definition = self._build_runtime_lot_definition()
        self._seed_repository_from_legacy_lot(self.legacy_lot_definition)
        inventory_camera_ids = self.video_ingestion.discovered_camera_ids()
        self.pipeline.camera_catalog = inventory_camera_ids or self.config_store.list_camera_ids() or [camera.id for camera in self.legacy_lot_definition.cameras]
        self._migrate_cross_camera_identity_collisions()
        self.rescan_videos()
        self._refresh_all_live_snapshots()
        self._legacy_snapshot_cache = self._rebuild_legacy_snapshot(reset_events=True)
        if enable_scheduler:
            self._start_scheduler()

    def close(self) -> None:
        self._scheduler_stop.set()
        if self._scheduler_thread is not None and self._scheduler_thread.is_alive():
            self._scheduler_thread.join(timeout=2.0)
        self.store.close()

    def get_snapshot(self) -> dict[str, Any]:
        with self._lock:
            if self._legacy_snapshot_cache is None:
                self._refresh_all_live_snapshots()
                self._legacy_snapshot_cache = self._rebuild_legacy_snapshot(reset_events=not self._legacy_previous_statuses)
            return dict(self._legacy_snapshot_cache)

    def get_live_snapshot(self, camera_id: str | None = None):
        with self._lock:
            return self.pipeline.get_snapshot(camera_id or self.get_default_camera_id())

    def advance_live_snapshot(self, camera_id: str | None = None):
        with self._lock:
            snapshot = self.pipeline.advance(camera_id or self.get_default_camera_id())
            self._legacy_snapshot_cache = self._rebuild_legacy_snapshot(reset_events=False, allow_refresh=False)
            return snapshot

    def refresh_live_snapshot(self, camera_id: str | None = None):
        with self._lock:
            snapshot = self.pipeline.refresh(camera_id or self.get_default_camera_id())
            self._legacy_snapshot_cache = self._rebuild_legacy_snapshot(reset_events=False, allow_refresh=False)
            return snapshot

    def list_live_events(
        self,
        camera_id: str | None = None,
        *,
        cursor: str | None = None,
        limit: int = 50,
    ) -> EventHistoryPage:
        with self._lock:
            return self.store.list_events(camera_id=camera_id, cursor=cursor, limit=limit)

    def select_live_frame(self, frame_id: str, camera_id: str | None = None):
        with self._lock:
            snapshot = self.pipeline.select_frame(frame_id, camera_id or self.get_default_camera_id())
            self._legacy_snapshot_cache = self._rebuild_legacy_snapshot(reset_events=False, allow_refresh=False)
            return snapshot

    def get_live_frame_response(self, frame_id: str, camera_id: str | None = None) -> Response:
        frame_path = self.video_ingestion.frame_response_path(frame_id)
        if frame_path is not None and frame_path.exists():
            return Response(
                content=frame_path.read_bytes(),
                media_type="image/jpeg",
                headers={"Cache-Control": "no-cache"},
            )
        resolved_camera_id = camera_id or self._resolve_camera_for_frame(frame_id) or self.get_default_camera_id()
        config = self.pipeline.get_active_config(resolved_camera_id)
        return frame_response(config, frame_id)

    def get_lot_definition(
        self,
        camera_id: str | None = None,
        version: int | None = None,
    ) -> LotDefinition:
        with self._lock:
            return self._lot_definition_from_configs(self._lot_configs(camera_id=camera_id, version=version))

    def save_lot_definition(self, lot_definition: LotDefinition) -> LotDefinition:
        with self._lock:
            config = legacy_lot_to_spatial_configs(lot_definition)[0]
            active = self.config_store.get_active_config("")
            version = active.version if active is not None else self.config_store.next_config_version("")
            now = iso_now()
            normalized = self._normalize_config(config).model_copy(
                update={
                    "version": version,
                    "status": "active",
                    "createdAt": active.createdAt if active is not None else config.createdAt,
                    "updatedAt": now,
                    "activatedAt": now,
                    "presetName": active.presetName if active is not None else (config.presetName or f"Preset {version}"),
                }
            )
            validate_spatial_config(normalized)
            self.config_store.upsert_config(normalized)
            self.config_store.activate_config("", normalized.version)
            for camera_id in self.pipeline.list_camera_ids():
                self.state.reset_camera(camera_id)
                self.video_ingestion.reset_camera(camera_id)
            self.state.reset_bays()

            projected = self._lot_definition_from_configs(self._lot_configs())
            self.lot_path.parent.mkdir(parents=True, exist_ok=True)
            self.lot_path.write_text(projected.model_dump_json(indent=2), encoding="utf-8")
            self.legacy_lot_definition = projected
            self._refresh_all_live_snapshots()
            self._legacy_snapshot_cache = self._rebuild_legacy_snapshot(reset_events=True)
            return projected

    def list_versions(self, camera_id: str) -> list[SpatialConfigVersionSummary]:
        configs = self.pipeline.list_versions(camera_id)
        return [
            SpatialConfigVersionSummary(
                cameraId=camera_id,
                version=config.version,
                status=config.status,
                createdAt=config.createdAt,
                updatedAt=config.updatedAt,
                activatedAt=config.activatedAt,
                presetName=config.presetName,
                copiedFromCameraId=config.copiedFromCameraId,
                copiedFromVersion=config.copiedFromVersion,
                bayCount=len(config.bays),
                zoneCount=len(config.zones),
                lineCount=len(config.lines),
            )
            for config in configs
        ]

    def get_active_config(self, camera_id: str | None = None) -> SpatialConfig:
        resolved_camera_id = camera_id or self.get_default_camera_id()
        config = self.pipeline.get_active_config(resolved_camera_id)
        return self._camera_view_config(config, resolved_camera_id)

    def get_editor_bundle(self, camera_id: str, version: int | None = None) -> EditorCameraBundle:
        active = self.get_active_config(camera_id)
        if version is not None:
            global_selected = self.config_store.get_version("", version)
        else:
            editable_versions = [
                config
                for config in self.config_store.list_versions("")
                if config.status != "archived"
            ]
            global_selected = max(editable_versions, key=lambda config: config.version, default=None) or active
        if global_selected is None:
            raise KeyError(f"Unknown global preset version {version}")
        selected = self._camera_view_config(global_selected, camera_id)
        return EditorCameraBundle(
            cameraId=camera_id,
            selectedVersion=selected.version,
            selected=selected,
            active=active,
            versions=self.list_versions(camera_id),
            # Pass the GLOBAL config so the editor matrix includes ALL bays
            # across all cameras/planes, not just the current camera's.
            lotDefinition=self._editor_lot_definition(camera_id, global_selected),
            videoSource=self.get_video_source(camera_id),
        )

    def list_partitions(self, camera_id: str, version: int | None = None):
        return self._editable_config(camera_id, version).partitions

    def list_observation_polygons(self, camera_id: str, version: int | None = None):
        return [
            polygon
            for polygon in self._editable_config(camera_id, version).observationPolygons
            if polygon.cameraId == camera_id
        ]

    def upsert_partition(self, camera_id: str, partition, version: int | None = None) -> SpatialConfig:
        config = self._editable_config(camera_id, version, require_version=True)
        partition_update = partition.model_copy(update={"ownerCameraIds": partition.ownerCameraIds or []})
        partitions = [item for item in config.partitions if item.id != partition_update.id]
        partitions.append(partition_update)
        updated = config.model_copy(update={"partitions": partitions, "updatedAt": iso_now()})
        return self._persist_editable_config(camera_id, updated)

    def delete_partition(self, camera_id: str, partition_id: str, version: int | None = None) -> SpatialConfig:
        config = self._editable_config(camera_id, version, require_version=True)
        remaining_partitions = [item for item in config.partitions if item.id != partition_id]
        partition_by_level = {item.levelId: item.id for item in remaining_partitions}
        bays = []
        for bay in config.bays:
            if bay.partitionId != partition_id:
                bays.append(bay)
                continue
            updated_partition_id = partition_by_level.get(bay.levelId)
            if updated_partition_id is None:
                updated_partition_id = f"{bay.levelId}-partition"
                fallback_partition = LayoutPartitionDefinition(
                    id=updated_partition_id,
                    name=bay.zoneId or bay.levelId,
                    levelId=bay.levelId,
                    order=0,
                    gridRows=1,
                    gridColumns=1,
                    ownerCameraIds=[],
                    layoutPolygon=list(bay.layoutPolygon),
                )
                remaining_partitions.append(fallback_partition)
                partition_by_level[bay.levelId] = updated_partition_id
            bays.append(bay.model_copy(update={"partitionId": updated_partition_id}))
        updated = config.model_copy(update={"partitions": remaining_partitions, "bays": bays, "updatedAt": iso_now()})
        return self._persist_editable_config(camera_id, updated)

    def upsert_observation_polygon(self, camera_id: str, polygon, version: int | None = None) -> SpatialConfig:
        config = self._editable_config(camera_id, version, require_version=True)
        polygon_update = polygon.model_copy(
            update={
                "cameraId": camera_id,
                "presetVersion": config.version,
            }
        )
        observation_polygons = [item for item in config.observationPolygons if item.id != polygon_update.id]
        observation_polygons.append(polygon_update)
        updated = config.model_copy(update={"observationPolygons": observation_polygons, "updatedAt": iso_now()})
        return self._persist_editable_config(camera_id, updated)

    def delete_observation_polygon(self, camera_id: str, polygon_id: str, version: int | None = None) -> SpatialConfig:
        config = self._editable_config(camera_id, version, require_version=True)
        updated = config.model_copy(
            update={
                "observationPolygons": [polygon for polygon in config.observationPolygons if polygon.id != polygon_id],
                "updatedAt": iso_now(),
            }
        )
        return self._persist_editable_config(camera_id, updated)

    def _editable_config(
        self,
        camera_id: str,
        version: int | None = None,
        *,
        require_version: bool = False,
    ) -> SpatialConfig:
        if version is not None:
            config = self.config_store.get_version("", version)
            if config is None:
                raise KeyError(f"Unknown global config version {version}")
            return config
        if require_version:
            raise ValueError(f"Explicit preset version is required for editor mutations on camera {camera_id}")
        active = self.config_store.get_active_config("")
        if active is None:
            raise KeyError("No global spatial config available")
        return active

    def _persist_editable_config(self, camera_id: str, config: SpatialConfig) -> SpatialConfig:
        normalized = self._normalize_config(config, camera_id=camera_id)
        validate_spatial_config(normalized)
        self.config_store.upsert_config(normalized)
        for current_camera_id in self.pipeline.list_camera_ids():
            self.state.reset_camera(current_camera_id)
            self.video_ingestion.reset_camera(current_camera_id)
        self.state.reset_bays()
        self._refresh_all_live_snapshots()
        self._legacy_snapshot_cache = self._rebuild_legacy_snapshot(reset_events=False)
        return normalized

    def save_spatial_config(self, config: SpatialConfig, camera_id: str | None = None) -> SpatialConfig:
        normalized = self._normalize_config(config, camera_id=camera_id)
        normalized = self._merge_with_existing_global(normalized, camera_id)
        validate_spatial_config(normalized)
        saved = self.pipeline.save_config(normalized)
        for current_camera_id in self.pipeline.list_camera_ids():
            self.state.reset_camera(current_camera_id)
            self.video_ingestion.reset_camera(current_camera_id)
        self.state.reset_bays()
        self._refresh_all_live_snapshots()
        self._legacy_snapshot_cache = self._rebuild_legacy_snapshot(reset_events=False)
        return saved

    def update_spatial_config_version(self, camera_id: str, version: int, config: SpatialConfig) -> SpatialConfig:
        normalized = self._normalize_config(config, camera_id=camera_id)
        normalized = self._merge_with_existing_global(normalized, camera_id)
        validate_spatial_config(normalized)
        saved = self.pipeline.update_config_version(camera_id, version, normalized)
        for current_camera_id in self.pipeline.list_camera_ids():
            self.state.reset_camera(current_camera_id)
            self.video_ingestion.reset_camera(current_camera_id)
        self.state.reset_bays()
        self._refresh_all_live_snapshots()
        self._legacy_snapshot_cache = self._rebuild_legacy_snapshot(reset_events=False)
        return saved

    def activate_spatial_config(self, camera_id: str, version: int) -> SpatialConfig:
        config = self.config_store.get_version(camera_id, version)
        if config is None:
            raise KeyError(f"Unknown global config version {version}")
        validate_spatial_config(self._normalize_config(config, camera_id=camera_id))
        config = self._normalize_config(
            self.pipeline.activate_config(camera_id, version),
            camera_id=camera_id,
        )
        self._sync_active_canonical_layout_from(config)
        for current_camera_id in self.pipeline.list_camera_ids():
            self.state.reset_camera(current_camera_id)
            self.video_ingestion.reset_camera(current_camera_id)
        self.state.reset_bays()
        self._refresh_all_live_snapshots()
        self._legacy_snapshot_cache = self._rebuild_legacy_snapshot(reset_events=True)
        return config

    def archive_spatial_config(self, camera_id: str, version: int) -> SpatialConfig:
        archived = self.pipeline.archive_config(camera_id, version)
        active = self.config_store.get_active_config("")
        if active is not None:
            self._sync_active_canonical_layout_from(active)
        for current_camera_id in self.pipeline.list_camera_ids():
            self.state.reset_camera(current_camera_id)
        self.state.reset_bays()
        self._refresh_all_live_snapshots()
        self._legacy_snapshot_cache = self._rebuild_legacy_snapshot(reset_events=True)
        return archived

    def clone_spatial_config(self, target_camera_id: str, payload: CameraPresetCloneRequest) -> SpatialConfig:
        source_config = self.config_store.get_version("", payload.sourceVersion)
        if source_config is None:
            raise KeyError(f"Unknown global preset version {payload.sourceVersion}")

        cloned = self._normalize_config(source_config, camera_id=target_camera_id).model_copy(
            update={
                "version": self.config_store.next_config_version(""),
                "status": "draft",
                "createdAt": iso_now(),
                "updatedAt": iso_now(),
                "activatedAt": None,
                "presetName": payload.targetName or source_config.presetName or f"Preset {source_config.version}",
                "copiedFromCameraId": source_config.cameraId,
                "copiedFromVersion": source_config.version,
            }
        )
        validate_spatial_config(cloned)
        self.config_store.upsert_config(cloned)
        if payload.activate:
            self.activate_spatial_config(target_camera_id, cloned.version)
            cloned = self.config_store.get_version("", cloned.version) or cloned
        for current_camera_id in self.pipeline.list_camera_ids():
            self.state.reset_camera(current_camera_id)
            self.video_ingestion.reset_camera(current_camera_id)
        self.state.reset_bays()
        self._refresh_all_live_snapshots()
        self._legacy_snapshot_cache = self._rebuild_legacy_snapshot(reset_events=False)
        return cloned

    def assign_preset(self, camera_id: str, payload: CameraPresetAssignRequest | int) -> SpatialConfig:
        version = payload.version if isinstance(payload, CameraPresetAssignRequest) else int(payload)
        return self.activate_spatial_config(camera_id, version)

    def save_run(self, camera_id: str, config: SpatialConfig) -> SpatialConfig:
        normalized = self._normalize_config(config, camera_id=camera_id)
        existing = self.config_store.get_version("", normalized.version)
        if existing is not None:
            saved = self.update_spatial_config_version(camera_id, normalized.version, normalized)
        else:
            saved = self.save_spatial_config(normalized, camera_id)
        activated = self.activate_spatial_config(camera_id, saved.version)
        self.refresh_live_snapshot(camera_id)
        self.state.reset_bays()
        self._legacy_snapshot_cache = self._rebuild_legacy_snapshot(reset_events=False)
        return activated

    def delete_preset(self, camera_id: str, version: int, archive_only: bool = True) -> SpatialConfig:
        if archive_only:
            return self.archive_spatial_config(camera_id, version)
        raise ValueError("Permanent deletion is not supported; use archive_only=True")

    def get_video_source(self, camera_id: str) -> CameraVideoSourceState | None:
        return self.video_ingestion.store.get_video_source(camera_id)

    def rescan_videos(self) -> list[CameraVideoSourceState]:
        self.legacy_lot_definition = self._build_runtime_lot_definition()
        self._seed_repository_from_legacy_lot(self.legacy_lot_definition)
        self._migrate_cross_camera_identity_collisions()
        inventory_camera_ids = self.video_ingestion.discovered_camera_ids()
        self.pipeline.camera_catalog = inventory_camera_ids or self.config_store.list_camera_ids() or [camera.id for camera in self.legacy_lot_definition.cameras]
        # Use the full catalog (filesystem-discovered + config + DB) so new
        # videos get discovered and registered even without a SpatialConfig.
        camera_ids = list(set(self.pipeline.list_camera_ids()) | set(self.pipeline.camera_catalog or []))
        sources = self.video_ingestion.rescan_all(camera_ids)
        self._migrate_editor_cover_polygons()
        self.state.reset_bays()
        self._refresh_all_live_snapshots()
        self._legacy_snapshot_cache = self._rebuild_legacy_snapshot(reset_events=False)
        return sources

    def reserve_bay(self, bay_id: str) -> BayOverrideActionResult:
        with self._lock:
            camera_id = self._resolve_camera_for_bay(bay_id)
            override = BayOverrideState(
                bayId=bay_id,
                cameraId=camera_id,
                status="reserved",
                active=True,
                updatedAt=iso_now(),
                reason="manual reservation",
            )
            event = SystemEvent(
                id=f"override-{bay_id}-{override.updatedAt}",
                type="reserved_detected",
                severity="warning",
                timestamp=override.updatedAt,
                message=f"{bay_id} reserved manually",
                slotId=bay_id,
                cameraId=camera_id,
            )
            self.store.upsert_override(override)
            snapshot = self.refresh_live_snapshot(camera_id)
            self.store.append_event(camera_id, event)
            snapshot = self._prepend_live_event(snapshot, event)
            self._legacy_snapshot_cache = self._rebuild_legacy_snapshot(reset_events=False, allow_refresh=False)
            return BayOverrideActionResult(override=override, snapshot=snapshot)

    def clear_bay_override(self, bay_id: str) -> BayOverrideActionResult:
        with self._lock:
            existing = self.store.get_override(bay_id)
            if existing is None:
                camera_id = self._resolve_camera_for_bay(bay_id)
                existing = BayOverrideState(
                    bayId=bay_id,
                    cameraId=camera_id,
                    status="cleared",
                    active=False,
                    updatedAt=iso_now(),
                    reason="manual clear",
                )
            cleared = self.store.clear_override(bay_id, iso_now()) or existing.model_copy(update={"status": "cleared", "active": False, "updatedAt": iso_now()})
            event = SystemEvent(
                id=f"override-{bay_id}-{cleared.updatedAt}",
                type="alert_cleared",
                severity="info",
                timestamp=cleared.updatedAt,
                message=f"{bay_id} override cleared",
                slotId=bay_id,
                cameraId=cleared.cameraId,
            )
            snapshot = self.refresh_live_snapshot(cleared.cameraId)
            self.store.append_event(cleared.cameraId, event)
            snapshot = self._prepend_live_event(snapshot, event)
            self._legacy_snapshot_cache = self._rebuild_legacy_snapshot(reset_events=False)
            return BayOverrideActionResult(override=cleared, snapshot=snapshot)

    def cycle(self, camera_id: str | None = None) -> dict[str, Any]:
        with self._lock:
            self.pipeline.advance_all()
            self._legacy_snapshot_cache = self._rebuild_legacy_snapshot(reset_events=False)
            return dict(self._legacy_snapshot_cache)

    def select_frame(self, frame_id: str, camera_id: str | None = None) -> dict[str, Any]:
        with self._lock:
            resolved_camera_id = camera_id or self._resolve_camera_for_frame(frame_id)
            if resolved_camera_id is None:
                raise KeyError(f"Unknown frame {frame_id}")
            self.pipeline.select_frame(frame_id, resolved_camera_id)
            self._legacy_snapshot_cache = self._rebuild_legacy_snapshot(reset_events=False)
            return dict(self._legacy_snapshot_cache)

    def get_frame_response(self, frame_id: str, camera_id: str | None = None) -> Response:
        return self.get_live_frame_response(frame_id, camera_id)

    def tick_all_cameras(self) -> list[str]:
        with self._lock:
            try:
                # Don't advance cameras handled by the counting loop
                skip = set(self._counting_camera_ids())
                snapshots = self.pipeline.advance_all(skip_advance_cameras=skip or None)
                camera_ids = list(snapshots.keys())
            except Exception:
                camera_ids = []
            self._legacy_snapshot_cache = self._rebuild_legacy_snapshot(reset_events=False)
            return camera_ids

    def _refresh_all_live_snapshots(self) -> None:
        with self._lock:
            try:
                self.pipeline.refresh_all()
            except Exception:
                pass

    def _prepend_live_event(self, snapshot: LiveStateSnapshot, event: SystemEvent) -> LiveStateSnapshot:
        merged_events = [event, *[existing for existing in snapshot.events if existing.id != event.id]]
        updated_snapshot = snapshot.model_copy(update={"events": merged_events[:24]})
        self.state.store_snapshot(updated_snapshot)
        self.store.save_live_snapshot(updated_snapshot)
        return updated_snapshot

    def _lot_configs(
        self,
        camera_id: str | None = None,
        version: int | None = None,
    ) -> list[SpatialConfig]:
        base_config = self.config_store.get_version("", version) if version is not None else self.config_store.get_active_config("") or self.config_store.get_latest_non_archived_config("")
        if base_config is None:
            return []
        camera_ids = [camera.id for camera in base_config.cameras]
        if camera_id and camera_id not in camera_ids:
            camera_ids.append(camera_id)
        if not camera_ids:
            camera_ids = [base_config.cameraId]

        legacy_order = [camera.id for camera in self.legacy_lot_definition.cameras]
        order_index = {item: index for index, item in enumerate(legacy_order)}
        configs = [project_config_to_camera(base_config, current_camera_id) for current_camera_id in camera_ids]
        return sorted(configs, key=lambda config: (order_index.get(config.cameraId, len(order_index)), config.cameraId))

    def _lot_definition_from_configs(self, configs: list[SpatialConfig]) -> LotDefinition:
        if not configs:
            raise KeyError("No camera presets available")
        canonical_config = configs[0].model_copy(
            update={
                "bays": list({bay.id: bay for config in configs for bay in config.bays}.values()),
                "cameras": list({camera.id: camera for config in configs for camera in [config.camera, *config.cameras]}.values()),
                "frames": list({frame.id: frame for config in configs for frame in config.frames}.values()),
                "observationPolygons": list(
                    {polygon.id: polygon for config in configs for polygon in config.observationPolygons}.values()
                ),
                "zones": list({zone.id: zone for config in configs for zone in config.zones}.values()),
            }
        )
        lot_definition = spatial_config_to_legacy_lot(canonical_config)
        discovered_camera_ids = self.video_ingestion.discovered_camera_ids()
        if discovered_camera_ids:
            return self._augment_lot_with_camera_inventory(lot_definition, discovered_camera_ids)
        return lot_definition

    def _editor_lot_definition(self, camera_id: str, config: SpatialConfig) -> LotDefinition:
        """Build the editor lot from the GLOBAL config so the bay matrix
        includes all planes/cameras.  Only frames are camera-specific."""
        discovered_camera_ids = set(self.video_ingestion.discovered_camera_ids())
        config_cameras_by_id = {cam.id: cam for cam in config.cameras}

        # Build camera list: keep config cameras that are discovered,
        # and create entries for discovered cameras not in the config.
        ordered_cameras: dict[str, LotCameraDefinition] = {}
        for cam in config.cameras:
            if not discovered_camera_ids or cam.id in discovered_camera_ids:
                ordered_cameras[cam.id] = cam

        # Ensure every discovered camera has an entry
        fallback_level_id = (
            config.camera.levelId
            or (config.levels[0].id if config.levels else "PLANE-01")
        )
        for disc_id in sorted(discovered_camera_ids):
            if disc_id not in ordered_cameras:
                template = config_cameras_by_id.get(disc_id, config.camera)
                ordered_cameras[disc_id] = template.model_copy(
                    update={"id": disc_id, "name": disc_id}
                )

        if not ordered_cameras:
            ordered_cameras[camera_id] = config.camera.model_copy(
                update={"id": camera_id, "name": camera_id}
            )

        selected_camera = ordered_cameras.get(
            camera_id,
            config.camera.model_copy(update={"id": camera_id, "name": camera_id}),
        )

        # Build the lot from the GLOBAL config (all bays, levels, zones)
        # with cameras resolved to the discovered set.
        global_config = config.model_copy(update={
            "cameras": list(ordered_cameras.values()),
            "cameraId": camera_id,
            "camera": selected_camera,
        })
        selected_lot = spatial_config_to_legacy_lot(global_config)

        # normalize_spatial_config inside spatial_config_to_legacy_lot may
        # reconstruct the cameras list from observation polygon cameraIds,
        # re-adding cameras not in the discovered set.  Sanitize slots so
        # ownerCameraIds and cameraId only reference known cameras.
        known_cam_ids = set(ordered_cameras.keys())
        sanitized_slots = []
        for slot in selected_lot.slots:
            clean_owners = [cid for cid in slot.ownerCameraIds if cid in known_cam_ids]
            clean_camera_id = slot.cameraId if slot.cameraId in known_cam_ids else (clean_owners[0] if clean_owners else camera_id)
            sanitized_slots.append(slot.model_copy(update={
                "cameraId": clean_camera_id,
                "ownerCameraIds": clean_owners or [clean_camera_id],
            }))
        selected_lot = selected_lot.model_copy(update={
            "slots": sanitized_slots,
            "cameras": list(ordered_cameras.values()),
        })

        selected_level = next(
            (level for level in selected_lot.levels if level.id == selected_camera.levelId),
            selected_lot.levels[0],
        )

        # Frames are camera-specific — resolve from the projected view
        projected_config = self._camera_view_config(config, camera_id)
        editor_frames = [
            frame.model_copy(
                update={
                    "cameraId": camera_id,
                    "imagePath": self._editor_frame_url(camera_id, frame.id),
                }
            )
            for frame in projected_config.frames
        ]

        return selected_lot.model_copy(
            update={
                "camera": selected_camera,
                "cameras": list(ordered_cameras.values()),
                "frames": editor_frames,
                "levelId": selected_level.id,
                "levelName": selected_level.name,
            }
        )

    def _editor_frame_url(self, camera_id: str, frame_id: str) -> str:
        return build_live_frame_url(frame_id, camera_id)

    def _resolve_camera_for_frame(self, frame_id: str) -> str | None:
        video_camera_id = self.video_ingestion.camera_id_for_frame_id(frame_id)
        if video_camera_id:
            return video_camera_id
        for config in self._lot_configs():
            if any(frame.id == frame_id for frame in config.frames):
                return config.cameraId
        return None

    def _rebuild_legacy_snapshot(self, *, reset_events: bool, allow_refresh: bool = True) -> dict[str, Any]:
        configs = self._lot_configs()
        lot_definition = self._lot_definition_from_configs(configs)
        if allow_refresh and any(self.state.latest_snapshot(config.cameraId) is None for config in configs):
            try:
                self.pipeline.refresh_all()
            except Exception:
                pass
        if allow_refresh:
            live_snapshots = {
                config.cameraId: self.state.latest_snapshot(config.cameraId) or self.pipeline.get_snapshot(config.cameraId)
                for config in configs
            }
        else:
            live_snapshots = {
                config.cameraId: snapshot
                for config in configs
                if (snapshot := self.state.latest_snapshot(config.cameraId)) is not None
            }
        bay_state_by_id = {
            bay_state.bayId: bay_state
            for snapshot in live_snapshots.values()
            for bay_state in snapshot.bayStates
        }
        camera_feeds = {
            camera.id: self._build_legacy_camera_feed(camera.id, live_snapshots)
            for camera in lot_definition.cameras
        }
        bay_image_polygons_by_camera = self._collect_bay_image_polygons_by_camera(configs)
        levels = [
            self._build_legacy_level(
                level,
                lot_definition,
                bay_state_by_id,
                camera_feeds,
                bay_image_polygons_by_camera,
            )
            for level in sorted(lot_definition.levels, key=lambda entry: entry.index)
        ]
        primary_camera_id = lot_definition.camera.id
        primary_feed = camera_feeds.get(primary_camera_id) or next(iter(camera_feeds.values()))
        all_slots = [slot for level in levels for slot in level.slots]
        if reset_events:
            self._legacy_previous_statuses = {}
        events = self._build_legacy_events(primary_feed.timestamp, all_slots)
        metrics = derive_metrics(levels, events)
        self._legacy_previous_statuses = {slot.id: slot.status for slot in all_slots}
        self.legacy_lot_definition = lot_definition
        return {
            "facilityId": lot_definition.facilityId,
            "facilityName": lot_definition.facilityName,
            "timeZone": lot_definition.timeZone,
            "capturedAt": primary_feed.timestamp,
            "systemStatus": "degraded" if any(feed.status != "online" for feed in camera_feeds.values()) else "online",
            "connectionHealth": "degraded" if any(feed.streamHealth < 0.8 for feed in camera_feeds.values()) else "stable",
            "levels": [level.model_dump() for level in levels],
            "cameras": [camera_feeds[camera.id].model_dump() for camera in lot_definition.cameras if camera.id in camera_feeds],
            "events": [event.model_dump() for event in events],
            "metrics": metrics.model_dump(),
        }

    def _build_legacy_camera_feed(
        self,
        camera_id: str,
        live_snapshots: dict[str, Any],
    ) -> CameraFeed:
        snapshot = live_snapshots.get(camera_id)
        if snapshot is not None:
            matching = next((feed for feed in snapshot.cameras if feed.id == camera_id), None)
            if matching is not None:
                return matching.model_copy(
                    update={
                        "thumbnail": build_live_frame_url(matching.frameId, camera_id),
                        "frameUrl": build_live_frame_url(matching.frameId, camera_id),
                    }
                )

        config = self.get_active_config(camera_id)
        frame = self.video_ingestion.refresh_camera(config, advance=False)
        return CameraFeed(
            id=config.cameraId,
            name=config.camera.name,
            levelId=config.camera.levelId,
            location=config.camera.location,
            status="online",
            timestamp=frame.captured_at,
            thumbnail=build_live_frame_url(frame.frame_id, camera_id),
            frameUrl=build_live_frame_url(frame.frame_id, camera_id),
            frameId=frame.frame_id,
            frameLabel=frame.label,
            imageWidth=frame.width,
            imageHeight=frame.height,
            angle=config.camera.angle,
            streamHealth=0.99,
        )

    def _build_legacy_level(
        self,
        level_definition,
        lot_definition: LotDefinition,
        bay_state_by_id: dict[str, Any],
        camera_feeds: dict[str, CameraFeed],
        bay_image_polygons_by_camera: dict[str, dict[str, list[tuple[float, float]]]],
    ) -> ParkingLevel:
        rows = max(level_definition.gridRows, 1)
        columns = max(level_definition.gridColumns, 1)
        slot_definitions = sorted(
            [slot for slot in lot_definition.slots if slot.levelId == level_definition.id],
            key=lambda slot: (slot.row, slot.column, slot.label, slot.id),
        )
        slots: list[ParkingSlot] = []
        for slot_definition in slot_definitions:
            bay_state = bay_state_by_id.get(slot_definition.id)
            image_polygons_by_camera = {
                camera_id: list(polygon)
                for camera_id, polygon in bay_image_polygons_by_camera.get(slot_definition.id, {}).items()
            }
            resolved_slot_camera_id = (
                slot_definition.cameraId
                if slot_definition.cameraId in image_polygons_by_camera or not image_polygons_by_camera
                else sorted(image_polygons_by_camera.keys())[0]
            )
            feed = camera_feeds.get(bay_state.winningCameraId if bay_state and bay_state.winningCameraId else resolved_slot_camera_id)
            status = slot_status_for_definition(slot_definition, bay_state, feed.frameId if feed else None)
            observed_at = bay_state.lastUpdatedTime if bay_state is not None else (feed.timestamp if feed is not None else iso_now())
            is_ev = status == "ev"
            occupied = status in {"occupied", "ev"}
            display_polygon = (
                list(image_polygons_by_camera[bay_state.winningCameraId])
                if bay_state is not None and bay_state.winningCameraId in image_polygons_by_camera
                else list(image_polygons_by_camera.get(resolved_slot_camera_id, slot_definition.imagePolygon))
            )
            slots.append(
                ParkingSlot(
                    id=slot_definition.id,
                    label=slot_definition.label,
                    levelId=slot_definition.levelId,
                    levelIndex=level_definition.index,
                    row=slot_definition.row,
                    column=slot_definition.column,
                    position=derive_matrix_position(slot_definition.row, slot_definition.column, rows, columns),
                    size=(SLOT_WIDTH, SLOT_DEPTH),
                    status=status,
                    source="model",
                    sensorState="degraded" if hash_string(f"{slot_definition.id}:sensor") % 11 == 0 else "online",
                    cameraId=resolved_slot_camera_id,
                    licensePlate=seeded_plate(slot_definition.id) if occupied else None,
                    vehicleType="ev" if is_ev else seeded_vehicle(slot_definition.id) if occupied else None,
                    confidence=bay_state.confidence if bay_state is not None else 0.72,
                    occupancyProbability=bay_state.confidence if bay_state is not None else 0.72,
                    lastDetectionAt=observed_at,
                    chargingKw=16 + (hash_string(f"{slot_definition.id}:kw") % 10) * 2 if is_ev else None,
                    evCapable=slot_definition.evCapable,
                    imagePolygon=display_polygon,
                    imagePolygonsByCamera=image_polygons_by_camera,
                    layoutPolygon=list(slot_definition.layoutPolygon),
                    zoneId=slot_definition.zoneId,
                    partitionId=slot_definition.partitionId,
                    activeTrackIds=list(bay_state.sourceTrackIds) if bay_state is not None else [],
                    sourceCameraIds=list(bay_state.sourceCameraIds) if bay_state is not None else [],
                    sourcePolygonIds=list(bay_state.sourcePolygonIds) if bay_state is not None else [],
                    winningCameraId=bay_state.winningCameraId if bay_state is not None else None,
                    winningPolygonId=bay_state.winningPolygonId if bay_state is not None else None,
                )
            )

        return ParkingLevel(
            id=level_definition.id,
            name=level_definition.name,
            index=level_definition.index,
            elevation=level_definition.index * 1.76,
            dimensions={
                "rows": rows,
                "columns": columns,
                "slotWidth": SLOT_WIDTH,
                "slotDepth": SLOT_DEPTH,
            },
            slots=slots,
        )

    def _collect_bay_image_polygons_by_camera(
        self,
        configs: list[SpatialConfig],
    ) -> dict[str, dict[str, list[tuple[float, float]]]]:
        polygons_by_bay: dict[str, dict[str, list[tuple[float, float]]]] = {}
        for config in configs:
            overlay_by_bay_id = {
                polygon.canonicalBayId: polygon
                for polygon in config.observationPolygons
                if polygon.enabled
            }
            for bay in config.bays:
                polygon = overlay_by_bay_id.get(bay.id)
                polygons_by_bay.setdefault(bay.id, {})[config.cameraId] = list(
                    polygon.imagePolygon if polygon is not None else bay.imagePolygon
                )
        return polygons_by_bay

    def _build_legacy_events(self, timestamp: str, slots: list[ParkingSlot]) -> list[SystemEvent]:
        previous_statuses = self._legacy_previous_statuses
        events: list[SystemEvent] = []

        if not previous_statuses:
            for slot in slots[:4]:
                self._legacy_event_counter += 1
                events.append(
                    SystemEvent(
                        id=f"evt-seed-{self._legacy_event_counter}",
                        type="sensor_update" if slot.status in {"free", "unknown"} else "slot_occupied",
                        severity="warning" if slot.status in {"occupied", "ev", "reserved"} else "info",
                        timestamp=timestamp,
                        message=f"{slot.id} seeded from backend runtime",
                        slotId=slot.id,
                        levelId=slot.levelId,
                        cameraId=slot.cameraId,
                    )
                )
            return events

        for slot in slots:
            previous = previous_statuses.get(slot.id)
            if previous == slot.status:
                continue
            self._legacy_event_counter += 1
            events.append(
                SystemEvent(
                    id=f"evt-diff-{self._legacy_event_counter}",
                    type=event_type_for_status(slot.status),
                    severity="info" if slot.status in {"free", "unknown"} else "warning",
                    timestamp=timestamp,
                    message=f"{slot.id} changed from {previous} to {slot.status}",
                    slotId=slot.id,
                    levelId=slot.levelId,
                    cameraId=slot.cameraId,
                )
            )

        return events[:24]

    def _start_scheduler(self) -> None:
        if self._scheduler_thread is not None and self._scheduler_thread.is_alive():
            return

        def _loop() -> None:
            while not self._scheduler_stop.wait(self.scheduler_interval_seconds):
                # Skip main tick when counting loop OR security loop is active —
                # tick_all_cameras() takes 3-4s and starves other threads via GIL
                if self._counting_camera_ids():
                    continue
                if getattr(self, '_security_active', False):
                    continue
                self.tick_all_cameras()

        # Counting loop: runs as fast as the model allows.
        # Small sleep between ticks to yield GIL so HTTP endpoints can respond.
        def _counting_loop() -> None:
            import time as _time
            while not self._scheduler_stop.wait(0.001):
                try:
                    counting_cam_ids = self._counting_camera_ids()
                    if counting_cam_ids:
                        self.pipeline.tick_counting_cameras(counting_cam_ids)
                        _time.sleep(0.01)  # 10ms yield — lets HTTP/signals through
                    else:
                        _time.sleep(0.1)  # idle — check less often
                except Exception:
                    pass

        self._ensure_counting_caches()

        self._scheduler_thread = threading.Thread(target=_loop, name="parking-backend-scheduler", daemon=True)
        self._scheduler_thread.start()
        self._counting_thread = threading.Thread(target=_counting_loop, name="parking-counting-scheduler", daemon=True)
        self._counting_thread.start()

    _counting_camera_ids_cache: list[str] | None = None

    def _ensure_counting_caches(self) -> None:
        """Initialize counting caches for cameras with enabled observations (called at boot)."""
        # Close orphaned sessions (observation deleted or disabled, or previous crash)
        enabled_obs_ids = {o.id for o in self.store.list_observations() if o.enabled}
        for s in self.store.list_counting_sessions():
            if s["status"] == "active" and s["observation_id"] not in enabled_obs_ids:
                self.store.stop_counting_session(s["id"], s["entries"], s["exits"])
        for camera_id in self._counting_camera_ids():
            if camera_id not in self.pipeline._counting_cache:
                self.pipeline.invalidate_counting_cache(camera_id)

    def _counting_camera_ids(self) -> list[str]:
        """Return camera IDs that have active counting observations (cached)."""
        if self._counting_camera_ids_cache is not None:
            return self._counting_camera_ids_cache
        try:
            all_obs = self.store.list_observations()
            result = list({obs.cameraId for obs in all_obs if obs.enabled})
            self._counting_camera_ids_cache = result
            return result
        except Exception:
            return []

    def _invalidate_counting_camera_ids(self) -> None:
        self._counting_camera_ids_cache = None

    def _build_runtime_lot_definition(self) -> LotDefinition:
        canonical_config = self.config_store.get_active_config("") or self.config_store.get_latest_non_archived_config("")
        if canonical_config is not None:
            return spatial_config_to_legacy_lot(canonical_config)

        if self.bootstrap_layout == "blank":
            discovered_camera_ids = self.video_ingestion.discovered_camera_ids()
            return build_blank_lot_definition(template=None, camera_ids=discovered_camera_ids)

        base_lot_definition = self._load_legacy_lot_definition()
        discovered_camera_ids = self.video_ingestion.discovered_camera_ids()
        if not discovered_camera_ids:
            return base_lot_definition
        return self._augment_lot_with_camera_inventory(base_lot_definition, discovered_camera_ids)

    def _try_load_legacy_lot_definition(self) -> LotDefinition | None:
        if not self.lot_path.exists():
            return None
        return LotDefinition.model_validate_json(self.lot_path.read_text(encoding="utf-8"))

    def _load_legacy_lot_definition(self) -> LotDefinition:
        lot_definition = self._try_load_legacy_lot_definition()
        if lot_definition is None:
            raise FileNotFoundError(
                f"Lot definition not found at {self.lot_path}. Create demo/lot-definition.json first."
            )
        return lot_definition

    def _augment_lot_with_camera_inventory(
        self,
        lot_definition: LotDefinition,
        camera_ids: list[str],
    ) -> LotDefinition:
        if not camera_ids:
            return lot_definition

        base_slots = sorted(
            lot_definition.slots,
            key=lambda slot: (
                next((level.index for level in lot_definition.levels if level.id == slot.levelId), 0),
                slot.row,
                slot.column,
                slot.id,
            ),
        )
        if not base_slots:
            return lot_definition

        usable_camera_ids = camera_ids[: max(1, min(len(camera_ids), len(base_slots)))]
        current_camera_ids = [camera.id for camera in lot_definition.cameras]
        if current_camera_ids == usable_camera_ids:
            return lot_definition

        partitions = self._partition_slots_for_cameras(lot_definition, base_slots, usable_camera_ids)
        base_frames = lot_definition.frames or [
            LotFrameDefinition(
                id="frame-01",
                cameraId=usable_camera_ids[0],
                label="Capture 1",
                imagePath=None,
                capturedAt=iso_now(),
                width=1280,
                height=720,
            )
        ]
        existing_cameras = {camera.id: camera for camera in lot_definition.cameras}
        cameras: list[LotCameraDefinition] = []
        frames: list[LotFrameDefinition] = []
        slots = []

        for index, camera_id in enumerate(usable_camera_ids):
            partition_slots = partitions.get(camera_id, [])
            dominant_level_id = self._dominant_level_id(lot_definition, partition_slots, index)
            camera_template = existing_cameras.get(camera_id) or next(iter(existing_cameras.values()), None)
            camera_name = camera_template.name if camera_template and camera_template.id == camera_id else camera_id
            camera = LotCameraDefinition(
                id=camera_id,
                name=camera_name,
                levelId=dominant_level_id,
                location=(camera_template.location if camera_template else f"Demo feed {camera_id}"),
                angle=(camera_template.angle if camera_template else "video replay"),
            )
            cameras.append(camera)
            for frame_index, frame in enumerate(base_frames):
                frames.append(
                    frame.model_copy(
                        update={
                            "id": f"{camera_id}-frame-{frame_index + 1:02d}",
                            "cameraId": camera_id,
                        }
                    )
                )
            for slot in partition_slots:
                slots.append(slot.model_copy(update={"cameraId": camera_id}))

        primary_camera = cameras[0]
        primary_level = next((level for level in lot_definition.levels if level.id == primary_camera.levelId), lot_definition.levels[0])
        return lot_definition.model_copy(
            update={
                "camera": primary_camera,
                "cameras": cameras,
                "frames": frames,
                "slots": slots,
                "levelId": primary_level.id,
                "levelName": primary_level.name,
            }
        )

    def _partition_slots_for_cameras(
        self,
        lot_definition: LotDefinition,
        slots: list[LotSlotDefinition],
        camera_ids: list[str],
    ) -> dict[str, list[LotSlotDefinition]]:
        level_ids = [level.id for level in sorted(lot_definition.levels, key=lambda level: level.index)]
        slots_by_level = {
            level_id: [slot for slot in slots if slot.levelId == level_id]
            for level_id in level_ids
        }
        populated_levels = [level_id for level_id in level_ids if slots_by_level[level_id]]
        if len(camera_ids) < len(populated_levels):
            return self._contiguous_partition(slots, camera_ids)

        total_slots = len(slots)
        allocation = {level_id: 1 for level_id in populated_levels}
        remaining = len(camera_ids) - len(populated_levels)
        if remaining > 0:
            ideal_shares = {
                level_id: (len(slots_by_level[level_id]) / total_slots) * len(camera_ids)
                for level_id in populated_levels
            }
            while remaining > 0:
                level_id = max(
                    populated_levels,
                    key=lambda candidate: (ideal_shares[candidate] - allocation[candidate], len(slots_by_level[candidate])),
                )
                allocation[level_id] += 1
                remaining -= 1

        partitions: list[list[LotSlotDefinition]] = []
        for level_id in populated_levels:
            level_slots = slots_by_level[level_id]
            partitions.extend(self._split_contiguously(level_slots, allocation[level_id]))

        partitions = [partition for partition in partitions if partition]
        return {
            camera_id: partitions[index] if index < len(partitions) else []
            for index, camera_id in enumerate(camera_ids)
        }

    def _contiguous_partition(
        self,
        slots: list[LotSlotDefinition],
        camera_ids: list[str],
    ) -> dict[str, list[LotSlotDefinition]]:
        partitions = self._split_contiguously(slots, len(camera_ids))
        return {
            camera_id: partitions[index] if index < len(partitions) else []
            for index, camera_id in enumerate(camera_ids)
        }

    def _split_contiguously(
        self,
        slots: list[LotSlotDefinition],
        partition_count: int,
    ) -> list[list[LotSlotDefinition]]:
        if partition_count <= 0:
            return []
        total_slots = len(slots)
        return [
            slots[(index * total_slots) // partition_count : ((index + 1) * total_slots) // partition_count]
            for index in range(partition_count)
        ]

    def _dominant_level_id(
        self,
        lot_definition: LotDefinition,
        slots: list[LotSlotDefinition],
        index: int,
    ) -> str:
        if slots:
            counts: dict[str, int] = {}
            for slot in slots:
                counts[slot.levelId] = counts.get(slot.levelId, 0) + 1
            return max(counts, key=counts.get)
        ordered_levels = sorted(lot_definition.levels, key=lambda level: level.index)
        return ordered_levels[index % len(ordered_levels)].id

    def _seed_repository_from_legacy_lot(self, lot_definition: LotDefinition) -> None:
        configs = legacy_lot_to_spatial_configs(lot_definition)
        for config in configs:
            existing_versions = self.config_store.list_versions("")
            if existing_versions:
                if self.config_store.get_active_config("") is None:
                    fallback = self.config_store.get_latest_non_archived_config("")
                    latest_version = fallback.version if fallback is not None else max(item.version for item in existing_versions)
                    self.config_store.activate_config("", latest_version)
                continue
            self.config_store.upsert_config(config)
            if self.config_store.get_active_config("") is None:
                self.config_store.activate_config("", config.version)

    def _normalize_config(self, config: SpatialConfig, camera_id: str | None = None) -> SpatialConfig:
        return normalize_spatial_config(config, camera_id=camera_id)

    def _merge_with_existing_global(self, incoming: SpatialConfig, camera_id: str | None) -> SpatialConfig:
        """Merge incoming camera-specific config with the existing global config.

        Preserves observation polygons, lines, and frames from other cameras
        so that saving from one camera never destroys another camera's data.

        Uses the most recently saved version (highest version number) as the
        merge base — not just the active version.  This ensures that draft
        saves from one camera are preserved when a different camera saves
        before the first draft is activated.
        """
        if not camera_id:
            return incoming
        existing = self.config_store.get_latest_config("") or self.config_store.get_active_config("")
        if existing is None:
            return incoming
        merged = merge_camera_config_into_global(incoming, camera_id, existing)
        logger.info(
            "merge_with_existing_global camera=%s | existing_v=%s bays=%d obs=%d | incoming bays=%d obs=%d | merged bays=%d obs=%d",
            camera_id,
            existing.version,
            len(existing.bays),
            len(existing.observationPolygons),
            len(incoming.bays),
            len(incoming.observationPolygons),
            len(merged.bays),
            len(merged.observationPolygons),
        )
        return merged

    def _camera_view_config(self, config: SpatialConfig, camera_id: str) -> SpatialConfig:
        projected = project_config_to_camera(config, camera_id)
        frames = self.video_ingestion.list_frames(projected) or list(projected.frames)
        public_frames = [
            frame.model_copy(
                update={
                    "cameraId": camera_id,
                    "imagePath": build_live_frame_url(frame.id, camera_id),
                }
            )
            for frame in frames
        ]
        frame_width = public_frames[0].width if public_frames else projected.frameWidth
        frame_height = public_frames[0].height if public_frames else projected.frameHeight
        return projected.model_copy(
            update={
                "frames": public_frames,
                "frameWidth": frame_width,
                "frameHeight": frame_height,
            }
        )

    def _resolve_camera_for_bay(self, bay_id: str) -> str:
        active = self.config_store.get_active_config("") or self.config_store.get_latest_non_archived_config("")
        if active is not None:
            bay = next((item for item in active.bays if item.id == bay_id), None)
            if bay is not None:
                if bay.sourceCameraIds:
                    return bay.sourceCameraIds[0]
                if bay.cameraId:
                    return bay.cameraId
                polygon = next((item for item in active.observationPolygons if item.canonicalBayId == bay_id), None)
                if polygon is not None:
                    return polygon.cameraId
        raise KeyError(f"Unknown bay {bay_id}")

    def _sync_active_canonical_layout_from(self, source_config: SpatialConfig) -> None:
        self.config_store.upsert_config(self._normalize_config(source_config))

    def _migrate_cross_camera_identity_collisions(self) -> None:
        return

    def _migrate_editor_cover_polygons(self) -> None:
        for config in self.config_store.list_versions(""):
            if not config.observationPolygons:
                continue
            if not _config_uses_live_editor_frames(config):
                continue
            if all(_polygon_has_frame_space_note(polygon.notes) for polygon in config.observationPolygons):
                continue

            updated = config.model_copy(
                update={
                    "bays": [
                        bay.model_copy(
                            update={
                                "imagePolygon": _project_polygon_from_editor_cover_to_frame(
                                    bay.imagePolygon,
                                    config.frameWidth,
                                    config.frameHeight,
                                ),
                            }
                        )
                        for bay in config.bays
                    ],
                    "observationPolygons": [
                        polygon.model_copy(
                            update={
                                "imagePolygon": _project_polygon_from_editor_cover_to_frame(
                                    polygon.imagePolygon,
                                    config.frameWidth,
                                    config.frameHeight,
                                ),
                                "notes": _with_frame_space_note(polygon.notes),
                            }
                        )
                        for polygon in config.observationPolygons
                    ],
                    "updatedAt": iso_now(),
                }
            )
            self.config_store.upsert_config(updated)

    def _duplicate_entity_ids(self, configs: list[SpatialConfig]) -> dict[str, set[str]]:
        bay_ids: dict[str, set[str]] = defaultdict(set)
        partition_ids: dict[str, set[str]] = defaultdict(set)
        zone_ids: dict[str, set[str]] = defaultdict(set)
        for config in configs:
            for bay in config.bays:
                bay_ids[bay.id].add(config.cameraId)
            for partition in config.partitions:
                partition_ids[partition.id].add(config.cameraId)
            for zone in config.zones:
                zone_ids[zone.id].add(config.cameraId)
        return {
            "bays": {entity_id for entity_id, camera_ids in bay_ids.items() if len(camera_ids) > 1},
            "partitions": {entity_id for entity_id, camera_ids in partition_ids.items() if len(camera_ids) > 1},
            "zones": {entity_id for entity_id, camera_ids in zone_ids.items() if len(camera_ids) > 1},
        }

    def _scope_identity(self, camera_id: str, entity_id: str) -> str:
        prefix = f"{camera_id}::"
        if entity_id.startswith(prefix):
            return entity_id
        return f"{prefix}{entity_id}"

    def _scope_config_identity_collisions(
        self,
        config: SpatialConfig,
        *,
        duplicate_entity_ids: dict[str, set[str]] | None = None,
    ) -> tuple[SpatialConfig, dict[str, dict[str, str]]]:
        duplicates = duplicate_entity_ids
        if duplicates is None:
            other_configs = [
                version
                for camera_id in self.config_store.list_camera_ids()
                if camera_id != config.cameraId
                for version in self.config_store.list_versions(camera_id)
            ]
            duplicates = self._duplicate_entity_ids([config, *other_configs])

        partition_id_map = {
            partition.id: self._scope_identity(config.cameraId, partition.id)
            for partition in config.partitions
            if partition.id in duplicates["partitions"]
        }
        zone_id_map = {
            zone.id: self._scope_identity(config.cameraId, zone.id)
            for zone in config.zones
            if zone.id in duplicates["zones"]
        }
        bay_id_map = {
            bay.id: self._scope_identity(config.cameraId, bay.id)
            for bay in config.bays
            if bay.id in duplicates["bays"]
        }

        if not partition_id_map and not zone_id_map and not bay_id_map:
            return config, {"partitions": {}, "zones": {}, "bays": {}}

        updated_partitions = [
            partition.model_copy(
                update={
                    "id": partition_id_map.get(partition.id, partition.id),
                    "ownerCameraIds": [config.cameraId],
                }
            )
            for partition in config.partitions
        ]
        updated_bays = [
            bay.model_copy(
                update={
                    "id": bay_id_map.get(bay.id, bay.id),
                    "cameraId": config.cameraId,
                    "partitionId": partition_id_map.get(bay.partitionId, bay.partitionId),
                    "zoneId": zone_id_map.get(bay.zoneId, bay.zoneId),
                }
            )
            for bay in config.bays
        ]
        updated_zones = [
            zone.model_copy(
                update={
                    "id": zone_id_map.get(zone.id, zone.id),
                    "bayIds": [bay_id_map.get(bay_id, bay_id) for bay_id in zone.bayIds],
                }
            )
            for zone in config.zones
        ]
        updated_polygons = [
            polygon.model_copy(
                update={
                    "cameraId": config.cameraId,
                    "canonicalBayId": bay_id_map.get(polygon.canonicalBayId, polygon.canonicalBayId),
                }
            )
            for polygon in config.observationPolygons
        ]
        updated = config.model_copy(
            update={
                "partitions": updated_partitions,
                "bays": updated_bays,
                "zones": updated_zones,
                "observationPolygons": updated_polygons,
            }
        )
        return updated, {
            "partitions": partition_id_map,
            "zones": zone_id_map,
            "bays": bay_id_map,
        }

    # ── Traffic Counting ──────────────────────────────────────────

    # ── Observation CRUD ─��

    def list_observations(self, camera_id: str | None = None) -> list:
        with self._lock:
            return self.store.list_observations(camera_id=camera_id)

    def get_observation(self, observation_id: str):
        with self._lock:
            return self.store.get_observation(observation_id)

    def create_observation(self, obs) -> object:
        with self._lock:
            result = self.store.upsert_observation(obs)
            self.pipeline.invalidate_counting_cache(obs.cameraId)
            self._invalidate_counting_camera_ids()
            return result

    def update_observation(self, obs) -> object:
        with self._lock:
            result = self.store.upsert_observation(obs)
            self.pipeline.invalidate_counting_cache(obs.cameraId)
            self._invalidate_counting_camera_ids()
            return result

    def delete_observation(self, observation_id: str) -> bool:
        with self._lock:
            obs = self.store.get_observation(observation_id)
            result = self.store.delete_observation(observation_id)
            if obs:
                self.pipeline.invalidate_counting_cache(obs.cameraId)
            self._invalidate_counting_camera_ids()
            return result

    def toggle_observation(self, observation_id: str, enabled: bool):
        with self._lock:
            # Check current state to avoid no-op toggles
            current = self.store.get_observation(observation_id)
            if current and current.enabled == enabled:
                # Already in desired state — but ensure cache exists
                if enabled and current.cameraId not in self.pipeline._counting_cache:
                    self.pipeline.invalidate_counting_cache(current.cameraId)
                return current

            result = self.store.toggle_observation(observation_id, enabled)
            self._invalidate_counting_camera_ids()
            if result:
                if enabled:
                    import uuid
                    session_id = f"cs-{uuid.uuid4().hex[:12]}"
                    self.store.start_counting_session(session_id, result)
                    # Hot-add line to existing cache (no rebuild, no interruption)
                    cache = self.pipeline._counting_cache.get(result.cameraId)
                    if cache is not None:
                        from backend.models import CountingLineDefinition, DensityZoneDefinition
                        if result.taskType in ("entry", "exit"):
                            cache["counting_lines"].append(CountingLineDefinition(
                                id=result.id, label=result.name, cameraId=result.cameraId,
                                kind=result.taskType, points=result.points[:2], enabled=True,
                                associationType=result.associationType,
                                associationId=result.associationId,
                            ))
                        elif result.taskType == "density":
                            cache["density_zones"].append(DensityZoneDefinition(
                                id=result.id, label=result.name, cameraId=result.cameraId,
                                imagePolygon=result.points, enabled=True,
                                capacityThreshold=result.capacityThreshold or 4,
                                associationType=result.associationType,
                                associationId=result.associationId,
                            ))
                    else:
                        # First task — full cache init
                        self.pipeline.invalidate_counting_cache(result.cameraId, reset_counts=True)
                else:
                    # Read counts, flush pending events to DB, then hot-remove line
                    cache = self.pipeline._counting_cache.get(result.cameraId)
                    counts = self.pipeline.get_obs_counts(result.cameraId)
                    oc = counts.get(observation_id, {})

                    # Flush pending events to DB (only time we write from this thread)
                    if cache:
                        for pe in cache.get("pending_events", []):
                            try:
                                self.store.append_counting_event(pe)
                            except Exception:
                                pass
                        cache["pending_events"] = []
                        for pd in cache.get("pending_density", []):
                            try:
                                self.store.append_density_snapshot(pd)
                            except Exception:
                                pass
                        cache["pending_density"] = []

                    # Get ALL active sessions (cross-camera) for net flow
                    all_active_sessions = [
                        s for s in self.store.list_counting_sessions()
                        if s["status"] == "active"
                    ]
                    active_sessions = [s for s in all_active_sessions if s["camera_id"] == result.cameraId]

                    # Save net flow partial if 2+ tasks were active (any camera)
                    if len(all_active_sessions) >= 2:
                        import uuid
                        # Gather counts from ALL cameras
                        all_counts: dict = {}
                        for cam_id in {s["camera_id"] for s in all_active_sessions}:
                            for k, v in self.pipeline.get_obs_counts(cam_id).items():
                                all_counts[k] = v
                        total_in = sum(
                            all_counts.get(s["observation_id"], {}).get("entries", 0)
                            for s in all_active_sessions if s["task_type"] == "entry"
                        )
                        total_out = sum(
                            all_counts.get(s["observation_id"], {}).get("exits", 0)
                            for s in all_active_sessions if s["task_type"] == "exit"
                        )
                        net_obs = result.model_copy(update={
                            "id": f"net-{uuid.uuid4().hex[:8]}",
                            "name": "Net flow",
                            "taskType": "entry",
                        })
                        net_id = f"cs-net-{uuid.uuid4().hex[:8]}"
                        self.store.start_counting_session(net_id, net_obs)
                        self.store.stop_counting_session(net_id, total_in, total_out)

                    for s in active_sessions:
                        if s["observation_id"] == observation_id:
                            if result.taskType == "density":
                                # For density: entries=peak vehicles, exits=threshold
                                density_alerts = cache.get("density_alerts", {}) if cache else {}
                                peak = density_alerts.get(observation_id, 0)
                                threshold = result.capacityThreshold or 0
                                self.store.stop_counting_session(s["id"], peak, threshold)
                            else:
                                self.store.stop_counting_session(
                                    s["id"], oc.get("entries", 0), oc.get("exits", 0),
                                )

                    if cache is not None:
                        cache["counting_lines"] = [l for l in cache["counting_lines"] if l.id != observation_id]
                        cache["density_zones"] = [z for z in cache["density_zones"] if z.id != observation_id]
                        remaining = self.store.get_active_sessions(result.cameraId)
                        if not remaining:
                            self.pipeline._counting_cache.pop(result.cameraId, None)
            return result

    # ── Counting queries ──

    def list_counting_events(
        self,
        *,
        camera_id: str | None = None,
        line_id: str | None = None,
        since: str | None = None,
        limit: int = 100,
    ) -> list[CountingEvent]:
        with self._lock:
            return self.store.list_counting_events(
                camera_id=camera_id, line_id=line_id, since=since, limit=limit,
            )

    def get_counting_summary(
        self,
        *,
        association_type: str | None = None,
        association_id: str | None = None,
        since: str | None = None,
    ) -> FlowCounts:
        from .spatial_config import iso_now
        from datetime import datetime, timedelta, timezone
        if since is None:
            one_hour_ago = datetime.now(timezone.utc) - timedelta(hours=1)
            since = one_hour_ago.strftime("%Y-%m-%dT%H:%M:%SZ")
        with self._lock:
            return self.store.count_events_since(
                since,
                association_type=association_type,
                association_id=association_id,
            )

    def list_density_snapshots(
        self,
        *,
        zone_id: str | None = None,
        since: str | None = None,
        limit: int = 50,
    ) -> list[DensitySnapshot]:
        with self._lock:
            return self.store.list_density_snapshots(
                zone_id=zone_id, since=since, limit=limit,
            )

    def list_counting_aggregates(
        self,
        granularity: str = "hourly",
        *,
        since: str | None = None,
        until: str | None = None,
        association_type: str | None = None,
        association_id: str | None = None,
    ) -> list[CountingAggregatePoint]:
        with self._lock:
            return self.store.list_counting_aggregates(
                granularity,
                since=since,
                until=until,
                association_type=association_type,
                association_id=association_id,
            )

    def get_default_camera_id(self) -> str:
        camera_ids = self.pipeline.list_camera_ids()
        primary_camera_id = self.legacy_lot_definition.camera.id
        if primary_camera_id in camera_ids:
            return primary_camera_id
        if camera_ids:
            return camera_ids[0]
        raise RuntimeError("No cameras available")

    def _default_camera_id(self) -> str:
        return self.get_default_camera_id()

    def _legacy_snapshot(self, live_snapshot) -> Any:
        return _LegacySnapshotAdapter.from_live_snapshot(live_snapshot)


class _LegacySnapshotAdapter:
    def __init__(self, payload: dict[str, Any]):
        self._payload = payload

    @classmethod
    def from_live_snapshot(cls, live_snapshot):
        return cls(
            {
                **live_snapshot.model_dump(),
                "levels": [level.model_dump() for level in live_snapshot.levels],
                "cameras": [camera.model_dump() for camera in live_snapshot.cameras],
                "events": live_snapshot.events,
                "metrics": live_snapshot.metrics.model_dump(),
            }
        )

    def model_dump(self) -> dict[str, Any]:
        return self._payload


def slot_status_for_definition(
    slot_definition: LotSlotDefinition,
    bay_state,
    frame_id: str | None,
) -> str:
    if bay_state is None:
        return "unknown"
    if bay_state.status == "unknown":
        return "unknown"
    if bay_state.status == "reserved":
        return "reserved"
    if bay_state.occupied and slot_definition.evCapable and hash_string(f"{slot_definition.id}:{frame_id or 'frame'}:ev") % 3 == 0:
        return "ev"
    if bay_state.occupied:
        return "occupied"
    if slot_definition.reservedDefault:
        return "reserved"
    return "free"


def _config_uses_live_editor_frames(config: SpatialConfig) -> bool:
    return any(
        (frame.imagePath or "").startswith("/api/live/frame/") or "-video-" in frame.id
        for frame in config.frames
    )


def _project_polygon_from_editor_cover_to_frame(
    polygon: list[tuple[float, float]],
    frame_width: int,
    frame_height: int,
) -> list[tuple[float, float]]:
    if frame_width <= 0 or frame_height <= 0:
        return list(polygon)

    editor_aspect = EDITOR_IMAGE_CANVAS_WIDTH / EDITOR_IMAGE_CANVAS_HEIGHT
    frame_aspect = frame_width / frame_height

    if abs(frame_aspect - editor_aspect) < 1e-9:
        return [(_clamp01(x), _clamp01(y)) for x, y in polygon]

    if frame_aspect > editor_aspect:
        scaled_width = EDITOR_IMAGE_CANVAS_HEIGHT * frame_aspect
        crop_x = (scaled_width - EDITOR_IMAGE_CANVAS_WIDTH) / 2
        return [
            (
                _clamp01((x * EDITOR_IMAGE_CANVAS_WIDTH + crop_x) / scaled_width),
                _clamp01(y),
            )
            for x, y in polygon
        ]

    scaled_height = EDITOR_IMAGE_CANVAS_WIDTH / frame_aspect
    crop_y = (scaled_height - EDITOR_IMAGE_CANVAS_HEIGHT) / 2
    return [
        (
            _clamp01(x),
            _clamp01((y * EDITOR_IMAGE_CANVAS_HEIGHT + crop_y) / scaled_height),
        )
        for x, y in polygon
    ]


def _polygon_has_frame_space_note(notes: str | None) -> bool:
    return notes is not None and FRAME_SPACE_NOTE in notes


def _with_frame_space_note(notes: str | None) -> str:
    if _polygon_has_frame_space_note(notes):
        return notes or FRAME_SPACE_NOTE
    if notes:
        return f"{notes} {FRAME_SPACE_NOTE}"
    return FRAME_SPACE_NOTE


def _clamp01(value: float) -> float:
    return min(1.0, max(0.0, value))


def derive_metrics(levels: list[ParkingLevel], events: list[SystemEvent]) -> FacilityMetrics:
    slots = [slot for level in levels for slot in level.slots]
    occupied = sum(slot.status == "occupied" for slot in slots)
    free = sum(slot.status == "free" for slot in slots)
    ev = sum(slot.status == "ev" for slot in slots)
    reserved = sum(slot.status == "reserved" for slot in slots)
    unknown = sum(slot.status == "unknown" for slot in slots)
    known = max(len(slots) - unknown, 0)

    level_stats = [
        LevelMetric(
            levelId=level.id,
            name=level.name,
            occupied=sum(slot.status == "occupied" for slot in level.slots),
            free=sum(slot.status == "free" for slot in level.slots),
            ev=sum(slot.status == "ev" for slot in level.slots),
            reserved=sum(slot.status == "reserved" for slot in level.slots),
            unknownSlots=sum(slot.status == "unknown" for slot in level.slots),
            occupancyRate=(
                sum(slot.status in {"occupied", "ev"} for slot in level.slots)
                / max(len([slot for slot in level.slots if slot.status != "unknown"]), 1)
                if any(slot.status != "unknown" for slot in level.slots)
                else 0.0
            ),
        )
        for level in levels
    ]

    return FacilityMetrics(
        totalSlots=len(slots),
        occupiedSlots=occupied,
        freeSlots=free,
        evSlots=ev,
        reservedSlots=reserved,
        unknownSlots=unknown,
        occupancyRate=((occupied + ev) / known) if known else 0.0,
        onlineSensors=sum(slot.sensorState != "offline" for slot in slots),
        flaggedEvents=sum(event.severity != "info" for event in events),
        levelStats=level_stats,
    )


def event_type_for_status(status: str) -> str:
    if status == "unknown":
        return "sensor_update"
    if status == "ev":
        return "ev_charging"
    if status == "occupied":
        return "slot_occupied"
    if status == "reserved":
        return "reserved_detected"
    return "slot_released"


def seeded_plate(slot_id: str) -> str:
    alphabet = "ABCDEFGHJKLMNPRSTUVWXYZ"
    hash_value = hash_string(slot_id)
    return (
        f"{alphabet[hash_value % len(alphabet)]}{alphabet[(hash_value >> 2) % len(alphabet)]}-"
        f"{100 + (hash_value % 900)}-{10 + ((hash_value >> 4) % 90)}"
    )


def seeded_vehicle(slot_id: str) -> str:
    vehicles = ["sedan", "suv", "van"]
    return vehicles[hash_string(f"{slot_id}:vehicle") % len(vehicles)]


def derive_matrix_position(row: int, column: int, rows: int, columns: int) -> tuple[float, float]:
    x_offset = -((max(columns, 1) - 1) * COLUMN_SPACING) / 2
    z_offset = -((max(rows, 1) - 1) * ROW_SPACING) / 2
    return (
        round(x_offset + column * COLUMN_SPACING, 3),
        round(z_offset + row * ROW_SPACING, 3),
    )
