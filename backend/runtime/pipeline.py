from __future__ import annotations

import logging
import time
from collections import defaultdict
from dataclasses import dataclass
from typing import Any

from ..demo_paths import get_demo_weights_path
from ..models import (
    AlertEvent,
    BayState,
    BayOverrideState,
    CameraFeed,
    CameraObservationPolygon,
    CountingAggregatePoint,
    CountingAlertRule,
    CountingEvent,
    CountingLineDefinition,
    DensitySnapshot,
    DensityZoneDefinition,
    DetectionRecord,
    ObservationDefinition,
    FacilityMetrics,
    FlowCounts,
    FlowEvent,
    LiveStateSnapshot,
    LevelMetric,
    ModuleHealth,
    ParkingLevel,
    ParkingSlot,
    SpatialBayDefinition,
    SpatialConfig,
    SpatialConfigBundle,
    SpatialConfigVersionSummary,
    SystemEvent,
    TimelinePoint,
    TrackRecord,
    TrafficCountingState,
    ZoneKpiState,
)
from ..predictor import build_predictor
from ..predictor_protocol import BayPrediction
from .config_repository import SpatialConfigFileRepository
from .counting_engine import DensityEngine, LineCrossingEngine
from .frame_paths import build_live_frame_url, resolve_frame_asset_path
from .spatial_config import iso_now, project_config_to_camera
from .storage import SQLiteStore
from .video_ingestion import FrameSource, VideoIngestionManager

logger = logging.getLogger(__name__)


@dataclass
class FrameCursor:
    index: int = 0
    frame_id: str | None = None


@dataclass
class CameraCycleContext:
    config: SpatialConfig
    frame: FrameSource
    predictions: list[BayPrediction]
    prediction_latency_ms: float
    occupancy_status: str
    occupancy_details: str | None
    counting_events: list[CountingEvent] | None = None
    density_snapshots: list[DensitySnapshot] | None = None
    detections: list[DetectionRecord] | None = None
    tracks: list[TrackRecord] | None = None
    counting_latency_ms: float = 0.0


class StateStore:
    def __init__(self):
        self._latest_snapshot: dict[str, LiveStateSnapshot] = {}
        self._frame_cursor: dict[str, FrameCursor] = defaultdict(FrameCursor)
        self._bay_memory: dict[str, dict[str, Any]] = {}
        self._track_memory: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
        self._flow_cooldowns: dict[str, dict[str, str]] = defaultdict(dict)

    def latest_snapshot(self, camera_id: str) -> LiveStateSnapshot | None:
        return self._latest_snapshot.get(camera_id)

    def store_snapshot(self, snapshot: LiveStateSnapshot) -> None:
        self._latest_snapshot[snapshot.cameraId] = snapshot

    def reset_camera(self, camera_id: str) -> None:
        self._latest_snapshot.pop(camera_id, None)
        self._frame_cursor.pop(camera_id, None)
        self._track_memory.pop(camera_id, None)
        self._flow_cooldowns.pop(camera_id, None)

    def reset_bays(self) -> None:
        self._bay_memory.clear()

    def cursor_for(self, camera_id: str) -> FrameCursor:
        return self._frame_cursor[camera_id]

    def remember_track(self, camera_id: str, track_id: str, frame_id: str) -> dict[str, Any]:
        memory = self._track_memory[camera_id].setdefault(track_id, {"age": 0, "persistenceFrames": 0})
        memory["age"] += 1
        memory["persistenceFrames"] += 1
        memory["frameId"] = frame_id
        return memory

    def bay_memory(self, camera_id: str, bay_id: str) -> dict[str, Any]:
        memory_key = bay_id
        return self._bay_memory.setdefault(
            memory_key,
            {
                "occupied": False,
                "occupied_seen": 0,
                "absent_seen": 0,
                "lastChangedTime": iso_now(),
                "frameId": None,
                "sourceTrackIds": [],
                "sourceCameraIds": [],
                "sourcePolygonIds": [],
                "winningCameraId": None,
                "winningPolygonId": None,
            },
        )

    def remember_flow(self, camera_id: str, key: str, timestamp: str) -> bool:
        if self._flow_cooldowns[camera_id].get(key) == timestamp:
            return False
        self._flow_cooldowns[camera_id][key] = timestamp
        return True


class StabilizationEngine:
    """Pipeline-level debounce. NOT a model — post-processing only.

    Applies a simple N-frame confirmation window before toggling bay state,
    preventing single-frame flicker from the predictor.
    """

    def __init__(self, confirm_frames: int = 2):
        self.confirm_frames = confirm_frames
        self._memory: dict[str, dict[str, Any]] = {}

    def _get_memory(self, bay_id: str) -> dict[str, Any]:
        return self._memory.setdefault(bay_id, {
            "occupied": False,
            "occupied_seen": 0,
            "absent_seen": 0,
            "lastChangedTime": iso_now(),
            "frameId": None,
        })

    def reset(self) -> None:
        self._memory.clear()

    def update(
        self,
        bays: list[SpatialBayDefinition],
        predictions_by_bay: dict[str, BayPrediction],
        timestamp: str,
        overrides: dict[str, BayOverrideState] | None = None,
        frames_by_camera: dict[str, FrameSource] | None = None,
    ) -> tuple[list[BayState], list[dict[str, Any]]]:
        active_overrides = overrides or {}
        active_frames = frames_by_camera or {}
        bay_states: list[BayState] = []
        changed_events: list[dict[str, Any]] = []

        for bay in bays:
            owner_camera_id = (
                (bay.sourceCameraIds[0] if bay.sourceCameraIds else None)
                or bay.cameraId
                or ""
            )
            owner_frame = active_frames.get(owner_camera_id)
            fallback_frame = owner_frame or next(iter(active_frames.values()), None)
            memory = self._get_memory(bay.id)
            override = active_overrides.get(bay.id)
            prediction = predictions_by_bay.get(bay.id)

            frame_id = fallback_frame.frame_id if fallback_frame is not None else memory.get("frameId")
            memory["frameId"] = frame_id

            # Handle override (reserved)
            if override is not None and override.active and override.status == "reserved":
                memory["occupied"] = True
                memory["occupied_seen"] = max(int(memory["occupied_seen"]), self.confirm_frames)
                memory["absent_seen"] = 0
                memory["lastChangedTime"] = timestamp
                bay_states.append(BayState(
                    bayId=bay.id,
                    occupied=True,
                    status="reserved",
                    confidence=1.0,
                    lastChangedTime=memory["lastChangedTime"],
                    lastUpdatedTime=timestamp,
                    frameId=frame_id,
                    sourceTrackIds=[],
                    sourceCameraIds=[owner_camera_id] if owner_camera_id else [],
                    sourcePolygonIds=[],
                ))
                continue

            # No prediction for this bay — status unknown
            if prediction is None:
                if fallback_frame is not None:
                    memory["frameId"] = fallback_frame.frame_id
                bay_states.append(BayState(
                    bayId=bay.id,
                    occupied=False,
                    status="unknown",
                    confidence=0.0,
                    lastChangedTime=memory["lastChangedTime"],
                    lastUpdatedTime=timestamp,
                    frameId=frame_id,
                    sourceTrackIds=[],
                    sourceCameraIds=[],
                    sourcePolygonIds=[],
                ))
                continue

            # Debounce logic
            current_occupied = bool(memory["occupied"])

            if prediction.occupied:
                memory["occupied_seen"] += 1
                memory["absent_seen"] = 0
                if not current_occupied and memory["occupied_seen"] >= self.confirm_frames:
                    memory["occupied"] = True
                    memory["lastChangedTime"] = timestamp
                    changed_events.append({
                        "bayId": bay.id,
                        "zoneId": bay.zoneId,
                        "occupied": True,
                        "timestamp": timestamp,
                        "trackIds": [],
                        "message": f"{bay.label} changed to occupied",
                    })
            else:
                memory["absent_seen"] += 1
                memory["occupied_seen"] = 0
                if current_occupied and memory["absent_seen"] >= self.confirm_frames:
                    memory["occupied"] = False
                    memory["lastChangedTime"] = timestamp
                    changed_events.append({
                        "bayId": bay.id,
                        "zoneId": bay.zoneId,
                        "occupied": False,
                        "timestamp": timestamp,
                        "trackIds": [],
                        "message": f"{bay.label} changed to free",
                    })

            is_occupied = bool(memory["occupied"])
            status = "occupied" if is_occupied else ("reserved" if bay.reservedDefault else "free")

            bay_states.append(BayState(
                bayId=bay.id,
                occupied=is_occupied,
                status=status,
                confidence=prediction.confidence,
                lastChangedTime=memory["lastChangedTime"],
                lastUpdatedTime=timestamp,
                frameId=frame_id,
                sourceTrackIds=[],
                sourceCameraIds=[owner_camera_id] if owner_camera_id else [],
                sourcePolygonIds=[],
            ))

        return bay_states, changed_events


class AlertEngine:
    def update(self, zone_states: list[ZoneKpiState], timestamp: str) -> list[AlertEvent]:
        alerts: list[AlertEvent] = []
        for zone in zone_states:
            if zone.occupancyPercentage >= 0.8:
                alerts.append(
                    AlertEvent(
                        alertId=f"alert-{zone.zoneId}",
                        sourceKpi=zone.zoneId,
                        thresholdRule="occupancy >= 80%",
                        severity="warning" if zone.occupancyPercentage < 1.0 else "critical",
                        active=True,
                        firstSeen=timestamp,
                        lastEvaluated=timestamp,
                        explanation=f"{zone.zoneId} occupancy at {round(zone.occupancyPercentage * 100)}%",
                        currentValue=zone.occupancyPercentage,
                    )
                )
        return alerts

    def evaluate_counting_alerts(
        self,
        rules: list[CountingAlertRule],
        counting_events: list[CountingEvent],
        density_snapshots: list[DensitySnapshot],
        timestamp: str,
    ) -> list[AlertEvent]:
        """Evaluate counting alert rules against current cycle data.

        Supports three source types:
        - density: vehicleCount in a density zone exceeds threshold
        - flow_rate: events per cycle for a line exceed threshold
        - net_flow: entries - exits across all counting events exceed threshold
        """
        if not rules:
            return []

        alerts: list[AlertEvent] = []
        for rule in rules:
            if not rule.enabled:
                continue

            observed: float | None = None

            if rule.sourceType == "density":
                for snap in density_snapshots:
                    if snap.zoneId == rule.sourceId:
                        observed = float(snap.vehicleCount)
                        break

            elif rule.sourceType == "flow_rate":
                count = sum(
                    1 for e in counting_events
                    if e.lineId == rule.sourceId
                )
                observed = float(count)

            elif rule.sourceType == "net_flow":
                entries = sum(1 for e in counting_events if e.eventType == "entry")
                exits = sum(1 for e in counting_events if e.eventType == "exit")
                observed = float(entries - exits)

            if observed is None:
                continue

            triggered = _compare(rule.operator, observed, float(rule.threshold))
            if not triggered:
                continue

            alerts.append(AlertEvent(
                alertId=f"cnt-alert-{rule.id}-{timestamp}",
                sourceKpi=f"{rule.sourceType}:{rule.sourceId}",
                thresholdRule=f"{rule.sourceType} {rule.operator} {rule.threshold}",
                severity=rule.severity,
                active=True,
                firstSeen=timestamp,
                lastEvaluated=timestamp,
                explanation=f"{rule.label}: {rule.sourceType} = {observed} ({rule.operator} {rule.threshold})",
                currentValue=observed,
            ))

        return alerts


def _compare(operator: str, observed: float, threshold: float) -> bool:
    if operator == "gt":
        return observed > threshold
    if operator == "gte":
        return observed >= threshold
    if operator == "lt":
        return observed < threshold
    if operator == "lte":
        return observed <= threshold
    return observed > threshold


class LivePipelineService:
    def __init__(
        self,
        store: SQLiteStore,
        config_store: SpatialConfigFileRepository,
        state: StateStore | None = None,
        video_ingestion: VideoIngestionManager | None = None,
        predictor=None,
    ):
        self.store = store
        self.config_store = config_store
        self.state = state or StateStore()
        self.video_ingestion = video_ingestion
        self.camera_catalog: list[str] | None = None
        self.predictor = predictor or build_predictor(get_demo_weights_path())
        self.stabilization = StabilizationEngine()
        self.alerts = AlertEngine()
        self.line_crossing = LineCrossingEngine()
        self.density_engine = DensityEngine()
        self._detector = None
        self._trackers: dict[str, Any] = {}

    def list_camera_ids(self) -> list[str]:
        # Combine all sources: config store, video sources DB, and discovered catalog.
        # The catalog includes cameras discovered from the filesystem (e.g. new .mp4
        # files) that may not yet have a config or DB entry.
        all_ids = set(self.config_store.list_camera_ids()) | set(self.store.list_video_source_ids())
        if self.camera_catalog:
            all_ids |= set(self.camera_catalog)
        return sorted(all_ids)

    def get_active_config(self, camera_id: str | None = None) -> SpatialConfig:
        resolved = self._resolve_camera_id(camera_id)
        config = self._get_global_config()
        return project_config_to_camera(config, resolved)

    def get_snapshot(self, camera_id: str | None = None) -> LiveStateSnapshot:
        config = self.get_active_config(camera_id)
        latest = self.state.latest_snapshot(config.cameraId)
        if latest is not None:
            return latest
        snapshots = self.refresh_all()
        return snapshots.get(config.cameraId) or self.state.latest_snapshot(config.cameraId) or self._build_snapshot(config, advance=False)

    def advance(self, camera_id: str | None = None) -> LiveStateSnapshot:
        config = self.get_active_config(camera_id)
        snapshots = self.advance_all()
        return snapshots.get(config.cameraId) or self.state.latest_snapshot(config.cameraId) or self._build_snapshot(config, advance=True)

    def refresh(self, camera_id: str | None = None) -> LiveStateSnapshot:
        config = self.get_active_config(camera_id)
        snapshots = self.refresh_all()
        return snapshots.get(config.cameraId) or self.state.latest_snapshot(config.cameraId) or self._build_snapshot(config, advance=False)

    def select_frame(self, frame_id: str, camera_id: str | None = None) -> LiveStateSnapshot:
        config = self.get_active_config(camera_id)
        if self.video_ingestion is not None:
                frame = self.video_ingestion.select_frame(config, frame_id)
                if frame.source_kind == "video":
                    self._sync_video_cursor(config.cameraId, frame)
                    snapshots = self.refresh_all()
                    return snapshots.get(config.cameraId) or self.state.latest_snapshot(config.cameraId) or self._build_snapshot(config, advance=False)
        index = next((idx for idx, frame_item in enumerate(config.frames) if frame_item.id == frame_id), None)
        if index is None:
            raise KeyError(f"Unknown frame {frame_id} for camera {config.cameraId}")
        cursor = self.state.cursor_for(config.cameraId)
        cursor.index = index
        cursor.frame_id = frame_id
        snapshots = self.refresh_all()
        return snapshots.get(config.cameraId) or self.state.latest_snapshot(config.cameraId) or self._build_snapshot(config, advance=False)

    def advance_all(self, skip_advance_cameras: set[str] | None = None) -> dict[str, LiveStateSnapshot]:
        return self._build_cycle(advance=True, skip_advance_cameras=skip_advance_cameras)

    def refresh_all(self) -> dict[str, LiveStateSnapshot]:
        return self._build_cycle(advance=False)

    # ── Counting fast-path cache ──
    # No lock needed: Python GIL makes dict assignment atomic.
    # The counting thread reads cache[camera_id], HTTP thread swaps it.
    # Worst case: one tick uses stale data, next tick gets the new cache.
    _counting_cache: dict[str, dict] = {}

    def _init_counting_cache(self, camera_id: str) -> dict:
        """One-time setup per camera: cache config, frame list, observations."""
        global_config = self._get_global_config()
        config = project_config_to_camera(global_config, camera_id)
        source = self.store.get_video_source(camera_id)
        if source is None or source.status != "ready" or not source.cacheDir:
            raise KeyError(f"No video source for {camera_id}")

        cache_dir = self.video_ingestion._resolve_cache_dir_path(source.cacheDir)
        frame_entries = self.video_ingestion._frame_entries(cache_dir)
        if not frame_entries:
            raise KeyError(f"No frames for {camera_id}")

        counting_lines = list(config.countingLines)
        density_zones = list(config.densityZones)
        for obs in self.store.list_observations(camera_id=camera_id):
            if not obs.enabled:
                continue
            if obs.taskType in ("entry", "exit"):
                counting_lines.append(CountingLineDefinition(
                    id=obs.id, label=obs.name, cameraId=obs.cameraId,
                    kind=obs.taskType, points=obs.points[:2], enabled=True,
                    associationType=obs.associationType,
                    associationId=obs.associationId,
                ))
            elif obs.taskType == "density":
                density_zones.append(DensityZoneDefinition(
                    id=obs.id, label=obs.name, cameraId=obs.cameraId,
                    imagePolygon=obs.points, enabled=True,
                    capacityThreshold=obs.capacityThreshold or 4,
                    associationType=obs.associationType,
                    associationId=obs.associationId,
                ))

        from datetime import datetime, timezone
        active_cfg = self.config_store.get_active_config(camera_id) or self.config_store.get_latest_non_archived_config(camera_id)
        if active_cfg and active_cfg.frames:
            base_ts = self.video_ingestion._base_timestamp(active_cfg)
        else:
            base_ts = datetime(1970, 1, 1, tzinfo=timezone.utc)

        import time as _time
        native_fps = source.inputFps or source.normalizedFps or 24.0

        return {
            "config": config,
            "source": source,
            "frame_entries": frame_entries,
            "counting_lines": counting_lines,
            "density_zones": density_zones,
            "native_fps": native_fps,
            "start_time": _time.perf_counter(),
            "start_frame": source.currentFrameIndex,
            "base_timestamp": base_ts,
            "entries_total": 0,
            "exits_total": 0,
            "obs_counts": {},
            "all_events": [],
            "pending_events": [],
            "pending_density": [],
            "tick_count": 0,
        }

    def get_obs_counts(self, camera_id: str) -> dict:
        """Read obs_counts snapshot (called from HTTP thread)."""
        cache = self._counting_cache.get(camera_id)
        if cache is None:
            return {}
        # Copy so caller gets a consistent snapshot
        try:
            return {k: dict(v) for k, v in cache.get("obs_counts", {}).items()}
        except RuntimeError:
            return {}  # dict changed size during iteration — rare, retry on next poll

    def invalidate_counting_cache(self, camera_id: str | None = None, reset_counts: bool = False) -> None:
        """Rebuild cache. No lock — GIL makes dict[key]=value atomic."""
        if camera_id:
            try:
                new_cache = self._init_counting_cache(camera_id)
            except Exception:
                logger.debug("Cache rebuild failed for %s", camera_id)
                return  # keep old cache running
            # Preserve accumulated counts from old cache
            old = self._counting_cache.get(camera_id)
            if old and not reset_counts:
                new_cache["obs_counts"] = old["obs_counts"]
                new_cache["entries_total"] = old["entries_total"]
                new_cache["exits_total"] = old["exits_total"]
                new_cache["all_events"] = old["all_events"]
            # Atomic swap — counting thread sees old or new, never None
            self._counting_cache[camera_id] = new_cache
        else:
            self._counting_cache.clear()

    def tick_counting_cameras(self, camera_ids: list[str]) -> None:
        """Fast tick: ~48ms per frame (YOLO only), no DB/config overhead per tick."""
        for camera_id in camera_ids:
            try:
                cache = self._counting_cache.get(camera_id)
                if cache is None:
                    continue

                config = cache["config"]
                frame_entries = cache["frame_entries"]
                import time as _time
                elapsed = _time.perf_counter() - cache["start_time"]
                frame_index = (cache["start_frame"] + int(elapsed * cache["native_fps"])) % len(frame_entries)

                # Detect video loop — reset tracker
                prev_frame = cache.get("last_frame_index", frame_index)
                if frame_index < prev_frame - 10:
                    tracker = self._trackers.get(camera_id)
                    if tracker:
                        tracker.reset()
                    self.line_crossing.reset_camera(camera_id)
                cache["last_frame_index"] = frame_index

                extracted_frame = frame_entries[frame_index]
                frame_id = f"{camera_id}-video-{frame_index + 1:06d}"
                from datetime import timedelta
                ts = cache["base_timestamp"] + timedelta(seconds=extracted_frame.timestamp_seconds)
                captured_at = ts.isoformat(timespec="milliseconds").replace("+00:00", "Z")
                frame_state = FrameSource(
                    camera_id=camera_id, frame_id=frame_id, frame_index=frame_index,
                    captured_at=captured_at,
                    label=f"{camera_id} video frame {frame_index + 1}",
                    image_path=extracted_frame.path,
                    width=config.frameWidth, height=config.frameHeight,
                    source_kind="video",
                )

                context = CameraCycleContext(
                    config=config, frame=frame_state,
                    predictions=[], prediction_latency_ms=0,
                    occupancy_status="online", occupancy_details="counting tick",
                )
                if (cache["counting_lines"] or cache["density_zones"]) and frame_state.image_path is not None:
                    self._run_counting_step(context, cache["counting_lines"], cache["density_zones"])

                # Accumulate counts in memory
                new_events = context.counting_events or []
                for e in new_events:
                    cache["all_events"].append(e)
                    cache["pending_events"].append(e)
                    if e.eventType == "entry":
                        cache["entries_total"] += 1
                    else:
                        cache["exits_total"] += 1
                    oc = cache["obs_counts"].setdefault(e.lineId, {"entries": 0, "exits": 0})
                    oc["entries" if e.eventType == "entry" else "exits"] += 1
                for ds in (context.density_snapshots or []):
                    cache["pending_density"].append(ds)
                    # Track density alerts: peak count per zone
                    if ds.capacity and ds.vehicleCount > ds.capacity:
                        alerts = cache.setdefault("density_alerts", {})
                        prev = alerts.get(ds.zoneId, 0)
                        if ds.vehicleCount > prev:
                            alerts[ds.zoneId] = ds.vehicleCount

                # Update snapshot in memory
                existing = self.state.latest_snapshot(config.cameraId)
                if existing is None:
                    continue

                updated_cameras = []
                for cam in existing.cameras:
                    if cam.id == camera_id:
                        updated_cameras.append(cam.model_copy(update={
                            "frameUrl": build_live_frame_url(frame_state.frame_id, camera_id),
                            "frameId": frame_state.frame_id,
                            "timestamp": frame_state.captured_at,
                        }))
                    else:
                        updated_cameras.append(cam)

                recent_events = cache["all_events"][-200:]
                updated = existing.model_copy(update={
                    "capturedAt": frame_state.captured_at,
                    "cameras": updated_cameras,
                    "detections": context.detections or [],
                    "tracks": context.tracks or [],
                    "trafficCounting": TrafficCountingState(
                        countingEvents=recent_events,
                        densitySnapshots=context.density_snapshots or [],
                        entriesTotal=cache["entries_total"],
                        exitsTotal=cache["exits_total"],
                        entriesLastHour=cache["entries_total"],
                        exitsLastHour=cache["exits_total"],
                    ),
                })
                self.state.store_snapshot(updated)

                # No DB writes from counting thread — all persisted on toggle OFF
                cache["tick_count"] += 1

            except Exception as exc:
                # DON'T delete cache — just log. Cache is still valid for next tick.
                logger.debug("Counting tick failed for %s: %s", camera_id, exc)

    def list_versions(self, camera_id: str) -> list[SpatialConfig]:
        return self.config_store.list_versions(camera_id)

    def save_config(self, config: SpatialConfig) -> SpatialConfig:
        next_version = self.config_store.next_config_version(config.cameraId)
        saved = config.model_copy(
            update={
                "version": next_version,
                "status": "draft",
                "updatedAt": iso_now(),
                "activatedAt": None,
            }
        )
        self.config_store.upsert_config(saved)
        return saved

    def update_config_version(self, camera_id: str, version: int, config: SpatialConfig) -> SpatialConfig:
        saved = config.model_copy(update={"version": version, "status": "draft", "updatedAt": iso_now()})
        self.config_store.upsert_config(saved)
        return saved

    def activate_config(self, camera_id: str, version: int) -> SpatialConfig:
        config = self.config_store.activate_config(camera_id, version)
        for current_camera_id in self.list_camera_ids():
            self._reset_cursor(current_camera_id)
        if self.video_ingestion is not None:
            for current_camera_id in self.list_camera_ids():
                self.video_ingestion.reset_camera(current_camera_id)
        self.stabilization.reset()
        return config

    def archive_config(self, camera_id: str, version: int) -> SpatialConfig:
        return self.config_store.archive_config(camera_id, version)

    def list_video_sources(self) -> list[Any]:
        return self.store.list_video_sources()

    def get_video_source(self, camera_id: str) -> Any | None:
        return self.store.get_video_source(camera_id)

    def _build_snapshot(self, config: SpatialConfig, advance: bool) -> LiveStateSnapshot:
        snapshots = self._build_cycle(advance=advance)
        if config.cameraId in snapshots:
            return snapshots[config.cameraId]
        if snapshots:
            return next(iter(snapshots.values()))
        raise KeyError(f"Spatial config {config.cameraId} does not define frames")

    def _build_cycle(self, advance: bool, skip_advance_cameras: set[str] | None = None) -> dict[str, LiveStateSnapshot]:
        global_config = self._get_global_config()
        camera_ids = self.list_camera_ids() or [global_config.cameraId]
        configs = [project_config_to_camera(global_config, camera_id) for camera_id in camera_ids]
        if not configs:
            raise KeyError("No active spatial configs available")

        predictor_health = getattr(self.predictor, "health", None)
        predictor_mode = getattr(predictor_health, "mode", "unknown")

        contexts: list[CameraCycleContext] = []
        all_predictions: dict[str, BayPrediction] = {}

        for config in configs:
            if not config.frames:
                continue
            # Don't advance cameras handled by the counting loop
            should_advance = advance and (skip_advance_cameras is None or config.cameraId not in skip_advance_cameras)
            frame_state = self._resolve_frame_state(config, should_advance)

            active_observations = [obs for obs in config.observationPolygons if obs.enabled]
            if active_observations and frame_state.image_path is not None and predictor_mode == "model":
                started = time.perf_counter()
                try:
                    predictions = self.predictor.predict(
                        frame_state.image_path,
                        active_observations,
                        config.frameWidth,
                        config.frameHeight,
                        frame_state.captured_at,
                    )
                except Exception as exc:
                    logger.error("Prediction failed for camera %s: %s", config.cameraId, exc)
                    predictions = []
                latency = (time.perf_counter() - started) * 1000

                for pred in predictions:
                    existing = all_predictions.get(pred.bay_id)
                    if existing is None or pred.confidence > existing.confidence:
                        all_predictions[pred.bay_id] = pred

                status = "online" if predictions else "degraded"
                details = f"{len(predictions)} predictions ({latency:.1f}ms)"
            elif active_observations:
                predictions = []
                latency = 0.0
                status = "degraded"
                details = (
                    getattr(predictor_health, "reason", "Model unavailable")
                    if predictor_mode != "model"
                    else f"No frame available for camera {config.cameraId}"
                )
            else:
                predictions = []
                latency = 0.0
                status = "online"
                details = "No observation polygons for this camera"

            contexts.append(CameraCycleContext(
                config=config,
                frame=frame_state,
                predictions=predictions,
                prediction_latency_ms=latency,
                occupancy_status=status,
                occupancy_details=details,
            ))

        if not contexts:
            raise KeyError("No configured cameras have frames available")

        bay_definitions = self._collect_canonical_bays(configs)
        frames_by_camera = {
            context.config.cameraId: context.frame
            for context in contexts
        }
        overrides = {override.bayId: override for override in self.store.list_active_overrides()}
        cycle_timestamp = max(context.frame.captured_at for context in contexts)

        started = time.perf_counter()
        bay_states, bay_events = self.stabilization.update(
            bay_definitions,
            all_predictions,
            cycle_timestamp,
            overrides,
            frames_by_camera,
        )
        occupancy_latency = (time.perf_counter() - started) * 1000

        aggregate_levels = self._build_levels(global_config, configs, bay_states)

        snapshots: dict[str, LiveStateSnapshot] = {}
        camera_occupancy_statuses = {
            context.config.cameraId: context.occupancy_status
            for context in contexts
        }
        for context in contexts:
            started = time.perf_counter()
            zone_states = self._build_zone_states(context.config, bay_states, context.frame.captured_at)
            flow_events: list[FlowEvent] = []
            alerts = self.alerts.update(zone_states, context.frame.captured_at)
            alert_latency = (time.perf_counter() - started) * 1000

            # --- Counting step: merge config lines/zones with active observations ---
            counting_lines = list(context.config.countingLines)
            density_zones = list(context.config.densityZones)
            try:
                active_obs = self.store.list_observations(camera_id=context.config.cameraId)
                for obs in active_obs:
                    if not obs.enabled:
                        continue
                    if obs.taskType in ("entry", "exit"):
                        counting_lines.append(CountingLineDefinition(
                            id=obs.id,
                            label=obs.name,
                            cameraId=obs.cameraId,
                            kind=obs.taskType,
                            points=obs.points[:2],
                            enabled=True,
                            associationType=obs.associationType,
                            associationId=obs.associationId,
                        ))
                    elif obs.taskType == "density":
                        density_zones.append(DensityZoneDefinition(
                            id=obs.id,
                            label=obs.name,
                            cameraId=obs.cameraId,
                            imagePolygon=obs.points,
                            enabled=True,
                            capacityThreshold=obs.capacityThreshold or 4,
                            associationType=obs.associationType,
                            associationId=obs.associationId,
                        ))
            except Exception as exc:
                logger.debug("Could not load observations for %s: %s", context.config.cameraId, exc)

            if (counting_lines or density_zones) and context.frame.image_path is not None:
                self._run_counting_step(context, counting_lines, density_zones)
                # Persist from main scheduler (safe — runs on main thread)
                for event in (context.counting_events or []):
                    self.store.append_counting_event(event)
                for ds in (context.density_snapshots or []):
                    self.store.append_density_snapshot(ds)

            # --- Counting alerts ---
            counting_alert_rules = context.config.countingAlertRules
            if counting_alert_rules and (context.counting_events or context.density_snapshots):
                counting_alerts = self.alerts.evaluate_counting_alerts(
                    counting_alert_rules,
                    context.counting_events or [],
                    context.density_snapshots or [],
                    context.frame.captured_at,
                )
                alerts.extend(counting_alerts)

            entry_count = sum(1 for e in (context.counting_events or []) if e.eventType == "entry")
            exit_count = sum(1 for e in (context.counting_events or []) if e.eventType == "exit")

            timeline_point = TimelinePoint(
                bucketStart=context.frame.captured_at,
                capturedAt=context.frame.captured_at,
                occupancyRate=self._occupancy_percentage(bay_states),
                entries=entry_count,
                exits=exit_count,
                activeAlerts=sum(1 for alert in alerts if alert.active),
                zoneId=context.config.zones[0].id if context.config.zones else None,
            )
            timeline = [timeline_point, *self.store.list_timeline_points(context.config.cameraId, limit=10)]
            occupancy_status = "degraded" if context.occupancy_status != "online" else "online"
            snapshot = self._assemble_snapshot(
                config=context.config,
                frame=context.frame,
                bay_states=bay_states,
                bay_events=bay_events,
                zone_states=zone_states,
                flow_events=flow_events,
                alerts=alerts,
                timeline=timeline,
                system_status=occupancy_status,
                camera_occupancy_statuses=camera_occupancy_statuses,
                levels=aggregate_levels,
                configs=configs,
                module_health=self._build_module_health(
                    context, occupancy_latency, alert_latency,
                ),
                counting_context=context,
            )
            snapshots[context.config.cameraId] = snapshot
            self.state.store_snapshot(snapshot)
            self.store.save_live_snapshot(snapshot)
            self.store.append_timeline_point(context.config.cameraId, timeline_point)
            # Store the same operator-facing events exposed in the snapshot so
            # archive pagination stays aligned with the live event log order.
            for event in reversed(snapshot.events):
                self.store.append_event(context.config.cameraId, event)
        return snapshots

    def _run_counting_step(
        self,
        context: CameraCycleContext,
        counting_lines: list,
        density_zones: list,
    ) -> None:
        """Run YOLO detection + ByteTrack tracking + line-crossing + density counting."""
        count_start = time.perf_counter()
        try:
            detector = self._get_detector()
            if detector is None:
                context.counting_events = []
                context.density_snapshots = []
                context.detections = []
                context.tracks = []
                context.counting_latency_ms = 0.0
                return

            camera_id = context.config.cameraId
            frame = context.frame

            detections = detector.detect(frame.image_path, frame.frame_id, frame.captured_at)

            tracker = self._trackers.get(camera_id)
            if tracker is None:
                from ..vision.tracker import ByteTrackAdapter
                tracker = ByteTrackAdapter()
                self._trackers[camera_id] = tracker

            tracks = tracker.update(
                detections, frame.frame_id, frame.captured_at,
                context.config.frameWidth, context.config.frameHeight,
            )

            counting_events = self.line_crossing.update(
                camera_id, counting_lines, tracks, frame.captured_at,
            )
            density_snapshots = self.density_engine.update(
                camera_id, density_zones, tracks, frame.captured_at,
            )

            context.detections = detections
            context.tracks = tracks
            context.counting_events = counting_events
            context.density_snapshots = density_snapshots

            # DB persistence is handled by the caller (main scheduler writes
            # immediately; counting thread accumulates in cache, flushes on toggle OFF)

        except Exception as exc:
            logger.error("Counting step failed for camera %s: %s", context.config.cameraId, exc)
            context.counting_events = []
            context.density_snapshots = []
            context.detections = []
            context.tracks = []

        context.counting_latency_ms = (time.perf_counter() - count_start) * 1000

    def _get_detector(self):
        """Lazily initialize the YOLO detector."""
        if self._detector is None:
            try:
                from ..vision.detector import YoloDetector
                self._detector = YoloDetector()
            except Exception as exc:
                logger.warning("Could not init YoloDetector: %s", exc)
                self._detector = False
        return self._detector if self._detector is not False else None

    def _build_module_health(
        self,
        context: CameraCycleContext,
        occupancy_latency: float,
        alert_latency: float,
    ) -> list[ModuleHealth]:
        ts = context.frame.captured_at
        return [
            ModuleHealth(
                module="occupancy",
                status=context.occupancy_status,
                lastUpdatedAt=ts,
                latencyMs=round(context.prediction_latency_ms, 3),
                errorCount=0 if context.occupancy_status == "online" else 1,
                details=context.occupancy_details,
            ),
            ModuleHealth(
                module="stabilization",
                status="online",
                lastUpdatedAt=ts,
                latencyMs=round(occupancy_latency, 3),
                errorCount=0,
            ),
            ModuleHealth(
                module="flow_counting",
                status=(
                    "online" if context.counting_events is not None
                    else "offline"
                ),
                lastUpdatedAt=ts,
                latencyMs=round(context.counting_latency_ms, 3) if context.counting_events is not None else None,
                errorCount=0,
                details=(
                    f"{len(context.counting_events or [])} events, "
                    f"{len(context.density_snapshots or [])} density snapshots"
                ) if context.counting_events is not None else None,
            ),
            ModuleHealth(
                module="alerts",
                status="online",
                lastUpdatedAt=ts,
                latencyMs=round(alert_latency, 3),
                errorCount=0,
            ),
        ]

    def _assemble_snapshot(
        self,
        config: SpatialConfig,
        frame: FrameSource,
        bay_states: list[BayState],
        bay_events: list[dict[str, Any]],
        zone_states: list[ZoneKpiState],
        flow_events: list[FlowEvent],
        alerts: list[AlertEvent],
        timeline: list[TimelinePoint],
        system_status: str,
        camera_occupancy_statuses: dict[str, str],
        levels: list[ParkingLevel],
        configs: list[SpatialConfig],
        module_health: list[ModuleHealth],
        counting_context: CameraCycleContext | None = None,
    ) -> LiveStateSnapshot:
        metrics = self._build_metrics(configs, bay_states, levels, alerts, flow_events)
        cameras = self._build_camera_feeds(configs, camera_occupancy_statuses)
        events = self._build_events(config, bay_events, alerts)

        # Build traffic counting state from context
        traffic_counting = None
        detections: list[DetectionRecord] = []
        tracks: list[TrackRecord] = []
        if counting_context is not None:
            detections = counting_context.detections or []
            tracks = counting_context.tracks or []
            counting_events = counting_context.counting_events or []
            density_snapshots = counting_context.density_snapshots or []
            if counting_events or density_snapshots:
                entries_total = sum(1 for e in counting_events if e.eventType == "entry")
                exits_total = sum(1 for e in counting_events if e.eventType == "exit")
                traffic_counting = TrafficCountingState(
                    countingEvents=counting_events,
                    densitySnapshots=density_snapshots,
                    entriesTotal=entries_total,
                    exitsTotal=exits_total,
                    entriesLastHour=entries_total,
                    exitsLastHour=exits_total,
                )

        return LiveStateSnapshot(
            facilityId=config.facilityId,
            facilityName=config.facilityName,
            timeZone=config.timeZone,
            cameraId=config.cameraId,
            activeCameraId=config.cameraId,
            configVersion=config.version,
            capturedAt=frame.captured_at,
            systemStatus="degraded" if system_status != "online" else "online",
            connectionHealth="degraded" if system_status != "online" else "stable",
            config=self._build_config_bundle(config),
            levels=levels,
            cameras=cameras,
            allCameraIds=self.list_camera_ids(),
            bayStates=bay_states,
            flowEvents=flow_events,
            moduleHealth=module_health,
            detections=detections,
            tracks=tracks,
            events=events,
            metrics=metrics,
            zoneKpis=zone_states,
            counts=self._build_counts(flow_events),
            alerts=alerts,
            timeline=timeline,
            modules=module_health,
            trafficCounting=traffic_counting,
        )

    def _build_config_bundle(self, config: SpatialConfig) -> SpatialConfigBundle:
        versions = [
            SpatialConfigVersionSummary(
                cameraId=entry.cameraId,
                version=entry.version,
                status=entry.status,
                createdAt=entry.createdAt,
                updatedAt=entry.updatedAt,
                activatedAt=entry.activatedAt,
                bayCount=len(entry.bays),
                zoneCount=len(entry.zones),
                lineCount=len(entry.lines),
                countingLineCount=len(entry.countingLines),
                densityZoneCount=len(entry.densityZones),
            )
            for entry in self.config_store.list_versions(config.cameraId)
        ]
        return SpatialConfigBundle(active=config, versions=versions)

    def _collect_canonical_bays(self, configs: list[SpatialConfig]) -> list[SpatialBayDefinition]:
        seen: dict[str, SpatialBayDefinition] = {}
        for config in configs:
            for bay in config.bays:
                seen.setdefault(
                    bay.id,
                    bay.model_copy(
                        update={
                            "cameraId": bay.cameraId or (bay.sourceCameraIds[0] if bay.sourceCameraIds else config.cameraId),
                            "sourceCameraIds": bay.sourceCameraIds or ([bay.cameraId] if bay.cameraId else []),
                        }
                    ),
                )
        return list(seen.values())

    def _build_camera_feeds(self, configs: list[SpatialConfig], camera_occupancy_statuses: dict[str, str]) -> list[CameraFeed]:
        config_by_camera = {
            config.cameraId: config
            for config in configs
        }
        feeds: list[CameraFeed] = []
        for camera_id in self.list_camera_ids():
            active_config = config_by_camera.get(camera_id)
            if active_config is not None:
                frame = self._resolve_frame_state(active_config, advance=False)
                video_source = self.store.get_video_source(camera_id)
                status = "online"
                if video_source is not None and video_source.status != "ready":
                    status = "offline"
                elif camera_occupancy_statuses.get(camera_id) == "degraded":
                    status = "latency"
                feeds.append(
                    CameraFeed(
                        id=active_config.cameraId,
                        name=active_config.camera.name,
                        levelId=active_config.levels[0].id if active_config.levels else active_config.cameraId,
                        location=active_config.camera.location,
                        status=status,
                        timestamp=frame.captured_at,
                        thumbnail=build_live_frame_url(frame.frame_id, active_config.cameraId),
                        frameUrl=build_live_frame_url(frame.frame_id, active_config.cameraId),
                        frameId=frame.frame_id,
                        frameLabel=frame.label,
                        imageWidth=frame.width,
                        imageHeight=frame.height,
                        angle=active_config.camera.angle,
                        streamHealth=0.99,
                        videoFrameCount=video_source.frameCount if video_source else None,
                        videoFps=(video_source.inputFps or video_source.normalizedFps) if video_source else None,
                    )
                )
            else:
                # Camera with video source but no SpatialConfig — include with
                # minimal feed so it appears in the Vehicle Analysis camera selector.
                video_source = self.store.get_video_source(camera_id)
                if video_source is None:
                    continue
                frame_url = ""
                frame_id = f"{camera_id}-video-000001"
                ts = iso_now()
                w = video_source.width or 640
                h = video_source.height or 480
                if video_source.status == "ready" and video_source.frameCount and video_source.frameCount > 0:
                    frame_url = build_live_frame_url(frame_id, camera_id)
                feeds.append(
                    CameraFeed(
                        id=camera_id,
                        name=camera_id,
                        levelId=camera_id,
                        location="",
                        status="online" if video_source.status == "ready" else "offline",
                        timestamp=ts,
                        thumbnail=frame_url,
                        frameUrl=frame_url,
                        frameId=frame_id,
                        frameLabel=camera_id,
                        imageWidth=w,
                        imageHeight=h,
                        angle="overhead",
                        streamHealth=0.95,
                        videoFrameCount=video_source.frameCount,
                        videoFps=video_source.inputFps or video_source.normalizedFps,
                    )
                )
        return feeds

    def _resolve_frame_state(self, config: SpatialConfig, advance: bool) -> FrameSource:
        if self.video_ingestion is not None:
            frame = self.video_ingestion.refresh_camera(config, advance=advance)
            if frame is not None:
                return frame
        cursor = self.state.cursor_for(config.cameraId)
        if advance:
            cursor.index = (cursor.index + 1) % len(config.frames)
        frame = config.frames[cursor.index % len(config.frames)]
        cursor.frame_id = frame.id
        return FrameSource(
            camera_id=config.cameraId,
            frame_id=frame.id,
            frame_index=cursor.index,
            captured_at=frame.capturedAt,
            label=frame.label,
            image_path=resolve_frame_asset_path(frame.imagePath),
            width=frame.width,
            height=frame.height,
            source_kind="legacy",
        )

    def _sync_video_cursor(self, camera_id: str, frame: FrameSource) -> None:
        cursor = self.state.cursor_for(camera_id)
        cursor.index = frame.frame_index
        cursor.frame_id = frame.frame_id

    def _build_zone_states(
        self,
        config: SpatialConfig,
        bay_states: list[BayState],
        timestamp: str,
    ) -> list[ZoneKpiState]:
        bay_state_by_id = {bay.bayId: bay for bay in bay_states}
        zone_states: list[ZoneKpiState] = []
        for zone in config.zones:
            zone_bays = [bay_state_by_id[bay_id] for bay_id in zone.bayIds if bay_id in bay_state_by_id]
            total = len(zone_bays)
            known_bays = [bay for bay in zone_bays if bay.status != "unknown"]
            occupied = sum(1 for bay in known_bays if bay.occupied)
            available = sum(1 for bay in known_bays if bay.status == "free")
            zone_states.append(
                ZoneKpiState(
                    zoneId=zone.id,
                    label=zone.label,
                    totalBays=total,
                    occupiedBays=occupied,
                    availableBays=available,
                    occupancyPercentage=(occupied / len(known_bays)) if known_bays else 0.0,
                    lastUpdatedTime=timestamp,
                    source="bay_rollup",
                )
            )
        return zone_states

    def _build_metrics(
        self,
        configs: list[SpatialConfig],
        bay_states: list[BayState],
        levels: list[ParkingLevel],
        alerts: list[AlertEvent],
        flow_events: list[FlowEvent],
    ) -> FacilityMetrics:
        canonical_bays = {bay.id: bay for config in configs for bay in config.bays}
        occupied = sum(1 for bay in bay_states if bay.status == "occupied")
        free = sum(1 for bay in bay_states if bay.status == "free")
        unknown = sum(1 for bay in bay_states if bay.status == "unknown")
        known = max(len(bay_states) - unknown, 0)
        level_stats: list[LevelMetric] = []
        for level in levels:
            zone_bays = list(level.slots)
            known_slots = [slot for slot in zone_bays if slot.status != "unknown"]
            level_stats.append(
                LevelMetric(
                    levelId=level.id,
                    name=level.name,
                    occupied=sum(1 for slot in zone_bays if slot.status == "occupied"),
                    free=sum(1 for slot in zone_bays if slot.status == "free"),
                    ev=sum(1 for slot in zone_bays if slot.status == "ev"),
                    reserved=sum(1 for slot in zone_bays if slot.status == "reserved"),
                    unknownSlots=sum(1 for slot in zone_bays if slot.status == "unknown"),
                    occupancyRate=(
                        sum(1 for slot in known_slots if slot.status in {"occupied", "ev", "reserved"}) / len(known_slots)
                    ) if known_slots else 0.0,
                )
            )
        return FacilityMetrics(
            totalSlots=len(bay_states),
            occupiedSlots=occupied,
            freeSlots=free,
            evSlots=sum(1 for bay in canonical_bays.values() if bay.evCapable),
            reservedSlots=sum(1 for bay in canonical_bays.values() if bay.reservedDefault),
            unknownSlots=unknown,
            occupancyRate=(occupied / known) if known else 0.0,
            onlineSensors=known,
            flaggedEvents=len(alerts) + len(flow_events),
            levelStats=level_stats,
            entriesLastHour=sum(1 for event in flow_events if event.eventType == "entry"),
            exitsLastHour=sum(1 for event in flow_events if event.eventType == "exit"),
            activeAlerts=len(alerts),
        )

    def _build_levels(self, global_config: SpatialConfig, configs: list[SpatialConfig], bay_states: list[BayState]) -> list[ParkingLevel]:
        bay_state_by_id = {bay.bayId: bay for bay in bay_states}
        canonical_config = global_config
        level_by_id = {level.id: level for level in canonical_config.levels}
        observation_polygon_by_camera_and_bay: dict[tuple[str, str], CameraObservationPolygon] = {}
        for config in configs:
            for polygon in config.observationPolygons:
                if polygon.enabled:
                    observation_polygon_by_camera_and_bay[(config.cameraId, polygon.canonicalBayId)] = polygon
        partitions = [
            partition
            for partition in canonical_config.partitions
            if any(bay.partitionId == partition.id for bay in canonical_config.bays)
        ]
        levels: list[ParkingLevel] = []
        partitions.sort(
            key=lambda partition: (
                level_by_id.get(partition.levelId).index if level_by_id.get(partition.levelId) is not None else 0,
                partition.order,
                partition.id,
            ),
        )
        if not partitions and canonical_config:
            partitions = [
                type(
                    "PartitionFallback",
                    (),
                    {
                        "id": zone.id,
                        "name": zone.label,
                        "levelId": zone.levelId,
                        "order": index,
                        "gridRows": 1,
                        "gridColumns": max(len(zone.bayIds), 1),
                    },
                )()
                for index, zone in enumerate(canonical_config.zones)
            ]

        partitions_by_level: dict[str, list[Any]] = defaultdict(list)
        for partition in partitions:
            partitions_by_level[partition.levelId].append(partition)

        ordered_levels = sorted(canonical_config.levels, key=lambda level: (level.index, level.id))
        for index, level in enumerate(ordered_levels):
            level_partitions = sorted(
                partitions_by_level.get(level.id, []),
                key=lambda partition: (partition.order, partition.id),
            )
            if not level_partitions:
                continue

            partition_offsets = derive_partition_offsets(level_partitions)
            slots: list[ParkingSlot] = []
            level_rows = max(max(partition.gridRows, 1) for partition in level_partitions)
            level_columns = sum(max(partition.gridColumns, 1) for partition in level_partitions) + max(len(level_partitions) - 1, 0)

            for partition in level_partitions:
                partition_bays = [bay for bay in canonical_config.bays if bay.partitionId == partition.id]
                partition_bays.sort(key=lambda bay: (bay.row, bay.column, bay.label, bay.id))
                rows = max(partition.gridRows, 1)
                columns = max(partition.gridColumns, 1)
                partition_offset_x, partition_offset_z = partition_offsets.get(partition.id, (0.0, 0.0))

                for bay in partition_bays:
                    bay_state = bay_state_by_id.get(bay.id)
                    if bay_state is None:
                        continue
                    owner_camera_id = (
                        (bay.sourceCameraIds[0] if bay.sourceCameraIds else None)
                        or bay.cameraId
                        or canonical_config.cameraId
                    )
                    observation_polygon = observation_polygon_by_camera_and_bay.get(
                        (bay_state.winningCameraId or owner_camera_id, bay.id)
                    ) or observation_polygon_by_camera_and_bay.get((owner_camera_id, bay.id))
                    image_polygons_by_camera = {
                        camera_id: list(polygon.imagePolygon)
                        for (camera_id, canonical_bay_id), polygon in observation_polygon_by_camera_and_bay.items()
                        if canonical_bay_id == bay.id
                    }
                    local_x, local_z = derive_matrix_position(bay.row, bay.column, rows, columns)
                    slots.append(
                        ParkingSlot(
                            id=bay.id,
                            label=bay.label,
                            levelId=bay.levelId,
                            levelIndex=level.index if level is not None else index,
                            row=bay.row,
                            column=bay.column,
                            position=(round(local_x + partition_offset_x, 3), round(local_z + partition_offset_z, 3)),
                            size=(1.0, 1.0),
                            status=bay_state.status,
                            source="model",
                            sensorState="degraded" if bay_state.status == "unknown" else "online",
                            cameraId=owner_camera_id,
                            licensePlate=None,
                            vehicleType="suv" if bay_state.status == "occupied" else None,
                            confidence=bay_state.confidence,
                            occupancyProbability=bay_state.confidence,
                            lastDetectionAt=bay_state.lastUpdatedTime,
                            frameId=bay_state.frameId,
                            chargingKw=None,
                            evCapable=bay.evCapable,
                            imagePolygon=list(observation_polygon.imagePolygon if observation_polygon is not None else bay.imagePolygon),
                            imagePolygonsByCamera=image_polygons_by_camera or {owner_camera_id: list(bay.imagePolygon)},
                            layoutPolygon=list(bay.layoutPolygon),
                            zoneId=bay.zoneId,
                            partitionId=bay.partitionId,
                            activeTrackIds=list(bay_state.sourceTrackIds),
                            sourceCameraIds=list(bay_state.sourceCameraIds or [owner_camera_id]),
                            sourcePolygonIds=list(bay_state.sourcePolygonIds),
                            winningCameraId=bay_state.winningCameraId or owner_camera_id,
                            winningPolygonId=bay_state.winningPolygonId,
                        )
                    )
            levels.append(
                ParkingLevel(
                    id=level.id,
                    name=level.name,
                    index=level.index if level is not None else index,
                    elevation=float(level.index) * 1.76 if level is not None else float(index) * 1.76,
                    dimensions={
                        "rows": level_rows,
                        "columns": max(level_columns, 1),
                        "slotWidth": 1.04,
                        "slotDepth": 0.58,
                    },
                    slots=slots,
                )
            )
        return levels

    def _build_events(
        self,
        config: SpatialConfig,
        bay_events: list[dict[str, Any]],
        alerts: list[AlertEvent],
    ) -> list[SystemEvent]:
        level_by_bay_id = {bay.id: bay.levelId for bay in config.bays}
        events: list[SystemEvent] = []
        for bay_event in bay_events:
            events.append(
                SystemEvent(
                    id=f"bay-{bay_event['bayId']}-{bay_event['timestamp']}",
                    type="slot_occupied" if bay_event["occupied"] else "slot_released",
                    severity="warning" if bay_event["occupied"] else "info",
                    timestamp=bay_event["timestamp"],
                    message=bay_event["message"],
                    slotId=bay_event["bayId"],
                    levelId=level_by_bay_id.get(bay_event["bayId"]),
                    cameraId=bay_event.get("winningCameraId") or config.cameraId,
                    zoneId=bay_event.get("zoneId"),
                    trackId=None,
                )
            )
        for alert in alerts:
            events.append(
                SystemEvent(
                    id=alert.alertId,
                    type="alert_active" if alert.active else "alert_cleared",
                    severity=alert.severity,
                    timestamp=alert.lastEvaluated,
                    message=alert.explanation,
                    cameraId=config.cameraId,
                )
            )
        return events[:24]

    def _build_counts(self, flow_events: list[FlowEvent]) -> FlowCounts:
        from datetime import datetime, timedelta, timezone
        one_hour_ago = (datetime.now(timezone.utc) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
        try:
            return self.store.count_events_since(one_hour_ago)
        except Exception:
            return FlowCounts(
                entriesTotal=0,
                exitsTotal=0,
                entriesLastHour=0,
                exitsLastHour=0,
            )

    def _resolve_camera_id(self, camera_id: str | None) -> str:
        if camera_id:
            return camera_id
        camera_ids = self.list_camera_ids()
        if camera_ids:
            return camera_ids[0]
        raise KeyError("No cameras configured")

    def _get_global_config(self) -> SpatialConfig:
        config = self.config_store.get_active_config("") or self.config_store.get_latest_non_archived_config("")
        if config is None:
            raise KeyError("No global spatial config available")
        return config

    def _reset_cursor(self, camera_id: str) -> None:
        cursor = self.state.cursor_for(camera_id)
        cursor.index = 0
        cursor.frame_id = None

    def _occupancy_percentage(self, bay_states: list[BayState]) -> float:
        known_bays = [bay for bay in bay_states if bay.status != "unknown"]
        if not known_bays:
            return 0.0
        return sum(1 for bay in known_bays if bay.occupied) / len(known_bays)


def derive_matrix_position(row: int, column: int, rows: int, columns: int) -> tuple[float, float]:
    column_spacing = 1.34
    row_spacing = 2.12
    x_offset = -((max(columns, 1) - 1) * column_spacing) / 2
    z_offset = -((max(rows, 1) - 1) * row_spacing) / 2
    return (
        round(x_offset + column * column_spacing, 3),
        round(z_offset + row * row_spacing, 3),
    )


def derive_partition_offsets(partitions: list[Any]) -> dict[str, tuple[float, float]]:
    column_spacing = 1.34
    partition_gap = 1.34
    slot_width = 1.0
    block_widths = [
        max(max(partition.gridColumns, 1) - 1, 0) * column_spacing + slot_width
        for partition in partitions
    ]
    total_width = sum(block_widths) + partition_gap * max(len(block_widths) - 1, 0)
    left_edge = -(total_width / 2)
    offsets: dict[str, tuple[float, float]] = {}

    for partition, block_width in zip(partitions, block_widths):
        offsets[partition.id] = (round(left_edge + block_width / 2, 3), 0.0)
        left_edge += block_width + partition_gap

    return offsets


def clamp_probability(value: float) -> float:
    return max(0.5, min(0.99, round(float(value), 2)))
