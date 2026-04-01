from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from .schemas import SecurityCameraState, SecurityEvent, SecurityServiceState, SecurityTask
from .service import SecurityService, SECURITY_VIDEOS_DIR


def create_security_router(service: SecurityService) -> APIRouter:
    router = APIRouter(prefix="/api/security", tags=["security"])

    @router.get("/state")
    async def get_service_state() -> SecurityServiceState:
        return service.get_service_state()

    @router.get("/tasks")
    async def list_tasks() -> list[SecurityTask]:
        return service.list_tasks()

    @router.post("/tasks")
    async def create_task(task: SecurityTask) -> SecurityTask:
        return service.create_task(task)

    @router.delete("/tasks/{task_id}")
    async def delete_task(task_id: str):
        if not service.delete_task(task_id):
            raise HTTPException(status_code=404, detail="Task not found")
        return {"ok": True}

    @router.patch("/tasks/{task_id}")
    async def toggle_task(task_id: str, enabled: bool = True) -> SecurityTask:
        import time as _t, logging as _log
        t0 = _t.perf_counter()
        task = service.toggle_task(task_id, enabled)
        elapsed = (_t.perf_counter() - t0) * 1000
        _log.getLogger("eventdetect").info("toggle_task took %.0fms (enabled=%s)", elapsed, enabled)
        if task is None:
            raise HTTPException(status_code=404, detail="Task not found")
        return task

    @router.get("/state/{camera_id}")
    async def get_camera_state(camera_id: str) -> SecurityCameraState:
        return service.get_camera_state(camera_id)

    @router.get("/events")
    async def get_events(
        cameraId: str | None = None,
        sinceSec: float = 0.0,
    ) -> list[SecurityEvent]:
        return service.get_events(camera_id=cameraId, since_sec=sinceSec)

    @router.get("/ready")
    async def is_ready():
        return {"ready": service._detector is not None}

    @router.get("/cameras")
    async def list_cameras() -> list[str]:
        return service.list_camera_ids()

    @router.get("/video/{camera_id}")
    async def stream_video(camera_id: str):
        video_path = SECURITY_VIDEOS_DIR / f"{camera_id}.mp4"
        if not video_path.is_file():
            raise HTTPException(status_code=404, detail=f"No security video for {camera_id}")
        return FileResponse(video_path, media_type="video/mp4")

    @router.get("/frame/{camera_id}")
    async def get_frame(camera_id: str):
        """Return a JPEG frame for the editor canvas."""
        vi = service._own_video_ingestion
        if vi is None:
            raise HTTPException(status_code=404, detail="No video ingestion")
        # Ensure video is discovered and frames extracted
        try:
            vi.discover(camera_id)
        except Exception:
            pass
        source = vi.store.get_video_source(camera_id)
        if source is None or not source.cacheDir:
            raise HTTPException(status_code=404, detail="No frames available")
        cache_dir = vi._resolve_cache_dir_path(source.cacheDir)
        if cache_dir is None:
            raise HTTPException(status_code=404, detail="Cache dir not found")
        entries = vi._frame_entries(cache_dir)
        if not entries:
            raise HTTPException(status_code=404, detail="No frames extracted")
        # Return first frame
        frame_path = entries[0].path
        if not frame_path.exists():
            raise HTTPException(status_code=404, detail="Frame file missing")
        return FileResponse(str(frame_path), media_type="image/jpeg")

    @router.get("/clip/{event_id}")
    async def get_clip(event_id: str):
        """Extract and serve a 5s clip centered on the event timestamp."""
        import subprocess, tempfile

        # Find the event
        events = service.get_events()
        event = next((e for e in events if e.id == event_id), None)
        if event is None:
            raise HTTPException(status_code=404, detail="Event not found")

        # Find the video source
        video_path = SECURITY_VIDEOS_DIR / f"{event.cameraId}.mp4"
        if not video_path.is_file():
            raise HTTPException(status_code=404, detail="Video not found")

        # Extract 5s clip centered on event (2.5s before, 2.5s after)
        start = max(0.0, event.timestampSec - 2.5)
        clip_dir = Path(__file__).resolve().parent.parent / "state" / "event-clips"
        clip_dir.mkdir(parents=True, exist_ok=True)
        clip_path = clip_dir / f"{event_id}.mp4"

        if not clip_path.exists():
            try:
                subprocess.run(
                    [
                        "ffmpeg", "-y",
                        "-ss", f"{start:.2f}",
                        "-i", str(video_path),
                        "-t", "5.0",
                        "-c", "copy",
                        "-an",
                        str(clip_path),
                    ],
                    capture_output=True, timeout=10, check=False,
                )
            except Exception:
                raise HTTPException(status_code=500, detail="Failed to extract clip")

        if not clip_path.exists():
            raise HTTPException(status_code=500, detail="Clip extraction failed")

        return FileResponse(clip_path, media_type="video/mp4", filename=f"{event_id}.mp4")

    @router.get("/classes")
    async def get_classes() -> list[str]:
        return service.get_available_classes()

    @router.post("/reset/{camera_id}")
    async def reset_camera(camera_id: str, videoTime: float = 0):
        """Sync backend frame index to browser video position."""
        service.reset_camera_position(camera_id, videoTime)
        return {"ok": True}

    return router
