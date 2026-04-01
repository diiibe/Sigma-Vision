from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse

from .demo_service import DemoService
from .demo_paths import get_bootstrap_layout, get_cors_allow_credentials, get_cors_origins
from .eventdetect.service import SecurityService
from .eventdetect.routes import create_security_router
from .export_routes import create_export_router
from .models import (
    BayOverrideActionResult,
    CameraPresetAssignRequest,
    CameraPresetCloneRequest,
    CameraObservationPolygon,
    ActivateConfigRequest,
    CountingAggregatePoint,
    CountingEvent,
    DensitySnapshot,
    CycleRequest,
    FlowCounts,
    FrameSelectRequest,
    LotDefinition,
    LayoutPartitionDefinition,
    ObservationDefinition,
    SpatialConfig,
    CameraVideoSourceState,
    EditorCameraBundle,
    EventHistoryPage,
    SpatialConfigBundle,
    SpatialConfigVersionSummary,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if getattr(app.state, "service", None) is None:
        app.state.service = DemoService(enable_scheduler=True, bootstrap_layout=get_bootstrap_layout())

    sec_service = getattr(app.state, "security_service", None)
    if sec_service is not None:
        sec_service.set_video_ingestion(app.state.service.video_ingestion)
        sec_service._parent_service = app.state.service
        # Preload YOLO model in background thread (non-blocking)
        import threading
        threading.Thread(
            target=sec_service._ensure_detector,
            name="security-model-preload",
            daemon=True,
        ).start()

    try:
        yield
    finally:
        sec_service = getattr(app.state, "security_service", None)
        if sec_service is not None:
            sec_service.stop()
        service = getattr(app.state, "service", None)
        if service is not None and hasattr(service, "close"):
            service.close()


def create_app() -> FastAPI:
    app = FastAPI(title="Parking Demo Sidecar", lifespan=lifespan)
    cors_origins = get_cors_origins()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=get_cors_allow_credentials(cors_origins),
        allow_methods=["*"],
        allow_headers=["*"],
    )

    security_service = SecurityService()
    app.state.security_service = security_service
    app.include_router(create_security_router(security_service))

    # Export CSV router — uses lambdas to defer service resolution
    app.include_router(create_export_router(
        get_service=lambda: getattr(app.state, "service", None),
        get_security_service=lambda: security_service,
    ))

    def get_service(request: Request) -> DemoService:
        service = getattr(request.app.state, "service", None)
        if service is None:
            raise RuntimeError("Service not initialized")
        return service

    def float_app_setting(name: str, default: float, minimum: float) -> float:
        raw_value = getattr(app.state, name, default)
        try:
            resolved = float(raw_value)
        except (TypeError, ValueError):
            resolved = default
        return max(resolved, minimum)

    def raise_not_found(detail: str, exc: Exception) -> None:
        raise HTTPException(status_code=404, detail=detail) from exc

    def raise_bad_request(detail: str, exc: Exception) -> None:
        raise HTTPException(status_code=400, detail=detail) from exc

    def build_config_bundle(service: DemoService, camera_id: str | None = None) -> SpatialConfigBundle:
        if camera_id is None:
            active = service.config_store.get_active_config("") or service.config_store.get_latest_non_archived_config("")
            if active is None:
                raise KeyError("No active global spatial config")
        else:
            active = service.get_active_config(camera_id)
        versions = [
            SpatialConfigVersionSummary(
                cameraId=version.cameraId,
                version=version.version,
                status=version.status,
                createdAt=version.createdAt,
                updatedAt=version.updatedAt,
                activatedAt=version.activatedAt,
                presetName=version.presetName,
                copiedFromCameraId=version.copiedFromCameraId,
                copiedFromVersion=version.copiedFromVersion,
                bayCount=version.bayCount,
                zoneCount=version.zoneCount,
                lineCount=version.lineCount,
            )
            for version in service.list_versions(camera_id or active.cameraId)
        ]
        return SpatialConfigBundle(active=active, versions=versions)

    @app.get("/api/live/snapshot")
    async def get_live_snapshot(request: Request, cameraId: str | None = None):
        service = get_service(request)
        return service.get_live_snapshot(cameraId).model_dump()

    @app.get("/api/live/events")
    async def list_live_events(
        request: Request,
        cameraId: str | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> EventHistoryPage:
        service = get_service(request)
        return service.list_live_events(cameraId, cursor=cursor, limit=limit)

    @app.post("/api/live/advance")
    async def advance_live_snapshot(request: Request, cameraId: str | None = None):
        service = get_service(request)
        return service.advance_live_snapshot(cameraId).model_dump()

    @app.get("/api/live/stream")
    async def stream_live_snapshot(request: Request, cameraId: str | None = None):
        service = get_service(request)
        stream_interval_seconds = float_app_setting(
            "live_stream_interval_seconds",
            max(service.scheduler_interval_seconds, 0.1),
            0.05,
        )
        heartbeat_interval_seconds = float_app_setting(
            "live_stream_heartbeat_seconds",
            max(stream_interval_seconds * 5, 15.0),
            stream_interval_seconds,
        )
        max_duration_seconds = float_app_setting(
            "live_stream_max_duration_seconds",
            45.0,
            stream_interval_seconds,
        )
        retry_ms = int(float_app_setting("live_stream_retry_ms", 3000.0, 500.0))

        async def event_stream():
            loop = asyncio.get_running_loop()
            deadline = loop.time() + max_duration_seconds
            last_payload: str | None = None
            last_emit_at = loop.time()
            yield f"retry: {retry_ms}\n\n"
            yield ": keepalive\n\n"
            while True:
                if await request.is_disconnected():
                    break
                now = loop.time()
                if now >= deadline:
                    break
                snapshot = service.get_live_snapshot(cameraId)
                payload = snapshot.model_dump_json()
                if payload != last_payload:
                    yield f"event: snapshot\ndata: {payload}\n\n"
                    last_payload = payload
                    last_emit_at = now
                elif now - last_emit_at >= heartbeat_interval_seconds:
                    yield ": keepalive\n\n"
                    last_emit_at = now
                remaining = deadline - loop.time()
                if remaining <= 0:
                    break
                await asyncio.sleep(min(stream_interval_seconds, remaining))

        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    @app.get("/api/live/frame/{frame_id}")
    async def get_live_frame(request: Request, frame_id: str, cameraId: str | None = None):
        service = get_service(request)
        return service.get_live_frame_response(frame_id, cameraId)

    @app.get("/api/live/video/{camera_id}")
    async def get_live_video(request: Request, camera_id: str):
        service = get_service(request)
        source = service.video_ingestion.store.get_video_source(camera_id)
        if source is None or source.status != "ready" or not source.sourcePath:
            raise HTTPException(status_code=404, detail=f"No video for camera {camera_id}")
        from pathlib import Path
        video_path = Path(source.sourcePath)
        if not video_path.exists():
            raise HTTPException(status_code=404, detail=f"Video file not found for camera {camera_id}")
        return FileResponse(video_path, media_type="video/mp4", filename=f"{camera_id}.mp4")

    @app.get("/api/spatial-configs/active")
    async def get_active_global_config(request: Request):
        service = get_service(request)
        try:
            return build_config_bundle(service).model_dump()
        except KeyError as exc:
            raise_not_found("Active spatial config was not found.", exc)

    @app.get("/api/spatial-configs/versions")
    async def list_global_config_versions(request: Request):
        service = get_service(request)
        return [version.model_dump() for version in service.list_versions(service.get_default_camera_id())]

    @app.post("/api/spatial-configs/versions")
    async def create_global_config_version(request: Request, config: SpatialConfig):
        service = get_service(request)
        try:
            service.save_spatial_config(config, service.get_default_camera_id())
            return build_config_bundle(service).model_dump()
        except KeyError as exc:
            raise_not_found("Active spatial config was not found.", exc)
        except ValueError as exc:
            raise_bad_request("Spatial config payload is invalid.", exc)

    @app.post("/api/spatial-configs/activate")
    async def activate_global_config(request: Request, payload: ActivateConfigRequest):
        service = get_service(request)
        try:
            service.activate_spatial_config(service.get_default_camera_id(), payload.version)
            return build_config_bundle(service).model_dump()
        except KeyError as exc:
            raise_not_found("Requested spatial config version was not found.", exc)
        except ValueError as exc:
            raise_bad_request("Requested spatial config version is invalid.", exc)

    @app.get("/api/spatial-configs/{camera_id}/active")
    async def get_active_config(request: Request, camera_id: str):
        service = get_service(request)
        try:
            return build_config_bundle(service, camera_id).model_dump()
        except KeyError as exc:
            raise_not_found("Active spatial config was not found.", exc)

    @app.get("/api/spatial-configs/{camera_id}/versions")
    async def list_config_versions(request: Request, camera_id: str):
        service = get_service(request)
        return [version.model_dump() for version in service.list_versions(camera_id)]

    @app.post("/api/spatial-configs/{camera_id}/versions")
    async def create_config_version(request: Request, camera_id: str, config: SpatialConfig):
        service = get_service(request)
        try:
            service.save_spatial_config(config, camera_id)
            return build_config_bundle(service, camera_id).model_dump()
        except KeyError as exc:
            raise_not_found("Active spatial config was not found.", exc)
        except ValueError as exc:
            raise_bad_request("Spatial config payload is invalid.", exc)

    @app.post("/api/spatial-configs/{camera_id}/activate")
    async def activate_config(request: Request, camera_id: str, payload: ActivateConfigRequest):
        service = get_service(request)
        try:
            service.activate_spatial_config(camera_id, payload.version)
            return build_config_bundle(service, camera_id).model_dump()
        except KeyError as exc:
            raise_not_found("Requested spatial config version was not found.", exc)
        except ValueError as exc:
            raise_bad_request("Requested spatial config version is invalid.", exc)

    @app.get("/api/editor/cameras/{camera_id}/bundle")
    async def get_editor_bundle(
        request: Request,
        camera_id: str,
        version: int | None = None,
    ) -> EditorCameraBundle:
        service = get_service(request)
        try:
            return service.get_editor_bundle(camera_id, version=version)
        except KeyError as exc:
            raise_not_found("Requested editor bundle was not found.", exc)

    @app.get("/api/editor/cameras/{camera_id}/video-source")
    async def get_editor_video_source(request: Request, camera_id: str) -> CameraVideoSourceState | None:
        service = get_service(request)
        return service.get_video_source(camera_id)

    @app.get("/api/editor/cameras/{camera_id}/partitions")
    async def list_editor_partitions(request: Request, camera_id: str, version: int | None = None):
        service = get_service(request)
        return [partition.model_dump() for partition in service.list_partitions(camera_id, version=version)]

    @app.post("/api/editor/cameras/{camera_id}/partitions")
    async def create_editor_partition(request: Request, camera_id: str, partition: LayoutPartitionDefinition, version: int | None = None):
        service = get_service(request)
        try:
            return service.upsert_partition(camera_id, partition, version=version).model_dump()
        except KeyError as exc:
            raise_not_found("Requested editor preset resource was not found.", exc)
        except ValueError as exc:
            raise_bad_request("Editor preset request is invalid.", exc)

    @app.put("/api/editor/cameras/{camera_id}/partitions/{partition_id}")
    async def update_editor_partition(
        request: Request,
        camera_id: str,
        partition_id: str,
        partition: LayoutPartitionDefinition,
        version: int | None = None,
    ):
        service = get_service(request)
        try:
            updated = partition.model_copy(update={"id": partition_id})
            return service.upsert_partition(camera_id, updated, version=version).model_dump()
        except KeyError as exc:
            raise_not_found("Requested editor preset resource was not found.", exc)
        except ValueError as exc:
            raise_bad_request("Editor preset request is invalid.", exc)

    @app.delete("/api/editor/cameras/{camera_id}/partitions/{partition_id}")
    async def delete_editor_partition(request: Request, camera_id: str, partition_id: str, version: int | None = None):
        service = get_service(request)
        try:
            return service.delete_partition(camera_id, partition_id, version=version).model_dump()
        except KeyError as exc:
            raise_not_found("Requested editor preset resource was not found.", exc)
        except ValueError as exc:
            raise_bad_request("Editor preset request is invalid.", exc)

    @app.get("/api/editor/cameras/{camera_id}/observation-polygons")
    async def list_editor_observation_polygons(request: Request, camera_id: str, version: int | None = None):
        service = get_service(request)
        return [polygon.model_dump() for polygon in service.list_observation_polygons(camera_id, version=version)]

    @app.post("/api/editor/cameras/{camera_id}/observation-polygons")
    async def create_editor_observation_polygon(
        request: Request,
        camera_id: str,
        polygon: CameraObservationPolygon,
        version: int | None = None,
    ):
        service = get_service(request)
        try:
            return service.upsert_observation_polygon(camera_id, polygon, version=version).model_dump()
        except KeyError as exc:
            raise_not_found("Requested editor preset resource was not found.", exc)
        except ValueError as exc:
            raise_bad_request("Editor preset request is invalid.", exc)

    @app.put("/api/editor/cameras/{camera_id}/observation-polygons/{polygon_id}")
    async def update_editor_observation_polygon(
        request: Request,
        camera_id: str,
        polygon_id: str,
        polygon: CameraObservationPolygon,
        version: int | None = None,
    ):
        service = get_service(request)
        try:
            updated = polygon.model_copy(update={"id": polygon_id})
            return service.upsert_observation_polygon(camera_id, updated, version=version).model_dump()
        except KeyError as exc:
            raise_not_found("Requested editor preset resource was not found.", exc)
        except ValueError as exc:
            raise_bad_request("Editor preset request is invalid.", exc)

    @app.delete("/api/editor/cameras/{camera_id}/observation-polygons/{polygon_id}")
    async def delete_editor_observation_polygon(request: Request, camera_id: str, polygon_id: str, version: int | None = None):
        service = get_service(request)
        try:
            return service.delete_observation_polygon(camera_id, polygon_id, version=version).model_dump()
        except KeyError as exc:
            raise_not_found("Requested editor preset resource was not found.", exc)
        except ValueError as exc:
            raise_bad_request("Editor preset request is invalid.", exc)

    @app.post("/api/editor/cameras/{camera_id}/presets")
    async def create_editor_preset(request: Request, camera_id: str, config: SpatialConfig):
        service = get_service(request)
        try:
            service.save_spatial_config(config, camera_id)
            return service.get_editor_bundle(camera_id).model_dump()
        except ValueError as exc:
            raise_bad_request("Editor preset payload is invalid.", exc)

    @app.post("/api/editor/cameras/{camera_id}/presets/clone")
    async def clone_editor_preset(request: Request, camera_id: str, payload: CameraPresetCloneRequest):
        service = get_service(request)
        try:
            return service.clone_spatial_config(camera_id, payload).model_dump()
        except KeyError as exc:
            raise_not_found("Requested preset source was not found.", exc)

    @app.put("/api/editor/cameras/{camera_id}/presets/{preset_id}")
    async def update_editor_preset(request: Request, camera_id: str, preset_id: int, config: SpatialConfig):
        service = get_service(request)
        try:
            return service.update_spatial_config_version(camera_id, preset_id, config).model_dump()
        except KeyError as exc:
            raise_not_found("Requested editor preset was not found.", exc)
        except ValueError as exc:
            raise_bad_request("Editor preset payload is invalid.", exc)

    @app.delete("/api/editor/cameras/{camera_id}/presets/{preset_id}")
    async def delete_editor_preset(request: Request, camera_id: str, preset_id: int):
        service = get_service(request)
        try:
            return service.archive_spatial_config(camera_id, preset_id).model_dump()
        except KeyError as exc:
            raise_not_found("Requested editor preset was not found.", exc)
        except ValueError as exc:
            raise_bad_request("Editor preset request is invalid.", exc)

    @app.post("/api/editor/cameras/{camera_id}/assign-preset")
    async def assign_editor_preset(request: Request, camera_id: str, payload: CameraPresetAssignRequest):
        service = get_service(request)
        try:
            return service.assign_preset(camera_id, payload).model_dump()
        except KeyError as exc:
            raise_not_found("Requested editor preset was not found.", exc)

    @app.post("/api/editor/cameras/{camera_id}/save-run")
    async def save_and_run_editor_preset(request: Request, camera_id: str, config: SpatialConfig):
        service = get_service(request)
        try:
            return service.save_run(camera_id, config).model_dump()
        except KeyError as exc:
            raise_not_found("Requested editor preset was not found.", exc)
        except ValueError as exc:
            raise_bad_request("Editor preset payload is invalid.", exc)

    @app.post("/api/runtime/rescan-videos")
    async def rescan_videos(request: Request):
        service = get_service(request)
        return [source.model_dump() for source in service.rescan_videos()]

    @app.post("/api/live/bays/{bay_id}/reserve")
    async def reserve_bay(request: Request, bay_id: str) -> BayOverrideActionResult:
        service = get_service(request)
        try:
            return service.reserve_bay(bay_id)
        except KeyError as exc:
            raise_not_found("Requested bay was not found.", exc)

    @app.post("/api/live/bays/{bay_id}/clear-override")
    async def clear_bay_override(request: Request, bay_id: str) -> BayOverrideActionResult:
        service = get_service(request)
        try:
            return service.clear_bay_override(bay_id)
        except KeyError as exc:
            raise_not_found("Requested bay was not found.", exc)

    @app.get("/api/demo/snapshot")
    async def get_snapshot(request: Request):
        service = get_service(request)
        return service.get_snapshot()

    @app.get("/api/demo/lot")
    async def get_lot(request: Request):
        service = get_service(request)
        return service.get_lot_definition().model_dump()

    @app.put("/api/demo/lot")
    async def put_lot(request: Request, lot_definition: LotDefinition):
        service = get_service(request)
        return service.save_lot_definition(lot_definition).model_dump()

    @app.post("/api/demo/cycle")
    async def cycle_demo(request: Request, payload: CycleRequest | None = None):
        service = get_service(request)
        return service.cycle(payload.cameraId if payload else None)

    @app.post("/api/demo/frame")
    async def select_frame(request: Request, payload: FrameSelectRequest):
        service = get_service(request)
        try:
            return service.select_frame(payload.frameId, payload.cameraId)
        except KeyError as exc:
            raise_not_found("Requested frame was not found.", exc)

    @app.get("/api/demo/frame/{frame_id}")
    async def get_frame(request: Request, frame_id: str):
        service = get_service(request)
        return service.get_frame_response(frame_id)

    # ── Observation CRUD Endpoints ─────────────────────────────────

    @app.get("/api/observations")
    async def list_observations(
        request: Request,
        cameraId: str | None = None,
    ) -> list[ObservationDefinition]:
        service = get_service(request)
        return service.list_observations(camera_id=cameraId)

    @app.get("/api/observations/{observation_id}")
    async def get_observation(request: Request, observation_id: str) -> ObservationDefinition:
        service = get_service(request)
        obs = service.get_observation(observation_id)
        if obs is None:
            raise HTTPException(status_code=404, detail="Observation not found")
        return obs

    @app.post("/api/observations", status_code=201)
    async def create_observation(
        request: Request,
        body: ObservationDefinition,
    ) -> ObservationDefinition:
        service = get_service(request)
        return service.create_observation(body)

    @app.put("/api/observations/{observation_id}")
    async def update_observation(
        request: Request,
        observation_id: str,
        body: ObservationDefinition,
    ) -> ObservationDefinition:
        service = get_service(request)
        existing = service.get_observation(observation_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Observation not found")
        return service.update_observation(body)

    @app.delete("/api/observations/{observation_id}", status_code=204)
    async def delete_observation(request: Request, observation_id: str):
        service = get_service(request)
        if not service.delete_observation(observation_id):
            raise HTTPException(status_code=404, detail="Observation not found")

    @app.post("/api/observations/{observation_id}/toggle")
    async def toggle_observation(
        request: Request,
        observation_id: str,
        enabled: bool = True,
    ) -> ObservationDefinition:
        service = get_service(request)
        obs = service.toggle_observation(observation_id, enabled)
        if obs is None:
            raise HTTPException(status_code=404, detail="Observation not found")
        return obs

    @app.get("/api/live/video/{camera_id}")
    async def stream_camera_video(request: Request, camera_id: str):
        """Serve the original MP4 video file for a camera (native FPS playback)."""
        from fastapi.responses import FileResponse
        service = get_service(request)
        source = service.get_video_source(camera_id)
        if source is None or not source.sourcePath:
            raise HTTPException(status_code=404, detail=f"No video source for camera {camera_id}")
        from pathlib import Path
        video_path = Path(source.sourcePath)
        if not video_path.exists():
            raise HTTPException(status_code=404, detail=f"Video file not found: {source.sourcePath}")
        return FileResponse(video_path, media_type="video/mp4")

    @app.post("/api/live/reset-camera/{camera_id}")
    async def reset_camera_video(request: Request, camera_id: str, videoTime: float = 0):
        """Sync model to the video's current position."""
        service = get_service(request)
        # Set frame index matching the video's current time
        source = service.video_ingestion.store.get_video_source(camera_id)
        if source and source.status == "ready":
            native_fps = source.inputFps or source.normalizedFps or 24.0
            target_frame = int(videoTime * native_fps) % max(source.frameCount, 1)
            service.video_ingestion.store.upsert_video_source(
                source.model_copy(update={"currentFrameIndex": target_frame})
            )
        # Reset tracker + counting state so tracks start fresh
        service.pipeline._trackers.pop(camera_id, None)
        service.pipeline.line_crossing.reset_camera(camera_id)
        service.pipeline.invalidate_counting_cache(camera_id)
        return {"ok": True, "cameraId": camera_id}

    @app.get("/api/live/counting-state/{camera_id}")
    async def get_counting_state(request: Request, camera_id: str):
        """Lightweight endpoint: tracks + counting + frameUrl + sessions for fast polling."""
        service = get_service(request)
        snapshot = service.pipeline.state.latest_snapshot(camera_id)
        if snapshot is None:
            return {"tracks": [], "trafficCounting": None, "frameUrl": None, "sessions": []}
        frame_url = None
        for cam in snapshot.cameras:
            if cam.id == camera_id:
                frame_url = cam.frameUrl
                break
        # Only include active sessions in fast-poll (completed sessions come from slow-poll)
        active_sessions = service.store.get_active_sessions(camera_id)
        obs_counts = service.pipeline.get_obs_counts(camera_id)
        for s in active_sessions:
            oc = obs_counts.get(s["observation_id"], {})
            s["entries"] = oc.get("entries", 0)
            s["exits"] = oc.get("exits", 0)
        return {
            "tracks": [t.model_dump() for t in snapshot.tracks],
            "trafficCounting": snapshot.trafficCounting.model_dump() if snapshot.trafficCounting else None,
            "frameUrl": frame_url,
            "sessions": active_sessions,
        }

    @app.get("/api/counting-sessions")
    async def list_counting_sessions(request: Request, cameraId: str | None = None):
        service = get_service(request)
        sessions = service.store.list_counting_sessions(camera_id=cameraId)
        # Enrich active sessions with live counts from cache
        for s in sessions:
            if s["status"] == "active":
                obs_counts = service.pipeline.get_obs_counts(s["camera_id"])
                oc = obs_counts.get(s["observation_id"], {})
                s["entries"] = oc.get("entries", 0)
                s["exits"] = oc.get("exits", 0)
        return sessions

    @app.get("/api/cameras/ids")
    async def list_camera_ids(request: Request) -> list[str]:
        """All discovered camera IDs (including those without active configs)."""
        service = get_service(request)
        return service.pipeline.list_camera_ids()

    # Counting-only cameras: exclude security video cameras
    COUNTING_EXCLUDE = {"altercation", "crowd", "running"}

    @app.get("/api/cameras/counting")
    async def list_counting_camera_ids(request: Request) -> list[str]:
        """Camera IDs available for vehicle analysis (excludes security-only cameras)."""
        service = get_service(request)
        all_ids = service.pipeline.list_camera_ids()
        return [c for c in all_ids if c not in COUNTING_EXCLUDE]

    # ── Traffic Counting Endpoints ──────────────────────────────────

    @app.get("/api/counting/events")
    async def list_counting_events(
        request: Request,
        cameraId: str | None = None,
        lineId: str | None = None,
        since: str | None = None,
        limit: int = 100,
    ) -> list[CountingEvent]:
        service = get_service(request)
        return service.list_counting_events(
            camera_id=cameraId, line_id=lineId, since=since, limit=limit,
        )

    @app.get("/api/counting/summary")
    async def get_counting_summary(
        request: Request,
        associationType: str | None = None,
        associationId: str | None = None,
        since: str | None = None,
    ) -> FlowCounts:
        service = get_service(request)
        return service.get_counting_summary(
            association_type=associationType,
            association_id=associationId,
            since=since,
        )

    @app.get("/api/counting/density")
    async def list_density_snapshots(
        request: Request,
        zoneId: str | None = None,
        since: str | None = None,
        limit: int = 50,
    ) -> list[DensitySnapshot]:
        service = get_service(request)
        return service.list_density_snapshots(
            zone_id=zoneId, since=since, limit=limit,
        )

    @app.get("/api/counting/aggregates")
    async def list_counting_aggregates(
        request: Request,
        granularity: str = "hourly",
        since: str | None = None,
        until: str | None = None,
        associationType: str | None = None,
        associationId: str | None = None,
    ) -> list[CountingAggregatePoint]:
        service = get_service(request)
        return service.list_counting_aggregates(
            granularity=granularity,
            since=since,
            until=until,
            association_type=associationType,
            association_id=associationId,
        )

    return app


app = create_app()
