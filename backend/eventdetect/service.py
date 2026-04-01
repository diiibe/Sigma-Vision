"""Security monitoring service — manages per-camera detection threads."""

from __future__ import annotations

import logging
import threading
import time
import uuid
from pathlib import Path

from .model import YoloEventDetector
from .pipeline import SecurityPipeline
from .storage import SecurityStore
from .schemas import (
    SecurityCameraState,
    SecurityEvent,
    TaskEventCounts,
    SecurityServiceState,
    SecurityTask,
    TrackState,
)

logger = logging.getLogger(__name__)


SECURITY_VIDEOS_DIR = Path(__file__).resolve().parent.parent.parent / "demo" / "videos" / "security"


class SecurityService:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._detector: YoloEventDetector | None = None
        self._video_ingestion = None
        self._own_video_ingestion = None  # dedicated to security videos
        self._parent_service = None
        self._store = SecurityStore()
        self._tasks: dict[str, SecurityTask] = {}
        self._camera_threads: dict[str, _CameraRunner] = {}
        self._camera_states: dict[str, SecurityCameraState] = {}
        self._camera_video_times: dict[str, float] = {}  # last known video position per cam
        self._events: list[SecurityEvent] = []
        self._event_counts: dict[str, dict[str, int]] = {}  # task_id → {event_type → count}

        # Load persisted tasks
        for task in self._store.list_tasks():
            self._tasks[task.id] = task
        # Load recent events
        self._events = self._store.list_events(limit=200)

    def set_video_ingestion(self, vi) -> None:
        """Receive the main video ingestion (for shared infra).
        We create our own VideoIngestionManager for the security video directory."""
        self._video_ingestion = vi
        self._parent_service = None  # set externally to signal scheduler
        # Create dedicated ingestion for security videos subfolder
        if SECURITY_VIDEOS_DIR.is_dir():
            from ..runtime.video_ingestion import VideoIngestionManager
            self._own_video_ingestion = VideoIngestionManager(
                vi.store, vi.config_store, SECURITY_VIDEOS_DIR,
            )

    def _ensure_detector(self) -> YoloEventDetector:
        if self._detector is None:
            self._detector = YoloEventDetector()
            self._detector.load()
        return self._detector

    # --- Task CRUD ---

    def list_tasks(self) -> list[SecurityTask]:
        with self._lock:
            return list(self._tasks.values())

    def create_task(self, task: SecurityTask) -> SecurityTask:
        if not task.id:
            task.id = f"sec-task-{uuid.uuid4().hex[:8]}"
        self._store.upsert_task(task)
        with self._lock:
            self._tasks[task.id] = task
        if task.enabled:
            self._start_camera(task)
        return task

    def delete_task(self, task_id: str) -> bool:
        with self._lock:
            task = self._tasks.pop(task_id, None)
        if task is None:
            return False
        self._store.delete_task(task_id)
        self._refresh_camera_runner(task.cameraId)
        return True

    def toggle_task(self, task_id: str, enabled: bool) -> SecurityTask | None:
        t0 = time.perf_counter()
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                return None
            task.enabled = enabled
            self._tasks[task_id] = task
        self._store.upsert_task(task)
        t1 = time.perf_counter()

        self._refresh_camera_runner(task.cameraId)
        t2 = time.perf_counter()
        logger.info("toggle_task: lock=%.0fms action=%.0fms total=%.0fms",
                     (t1-t0)*1000, (t2-t1)*1000, (t2-t0)*1000)
        return task

    def reset_camera_position(self, camera_id: str, video_time: float) -> None:
        """Sync the runner for this camera to the browser video position.

        Same pattern as counting: save position, then tell runner to re-anchor.
        """
        # Save position so future runners start from here
        self._camera_video_times[camera_id] = video_time

        runner = self._camera_threads.get(camera_id)
        if runner is not None:
            runner.sync_to_video_time(video_time)
            logger.info("Reset camera %s to videoTime=%.2f", camera_id, video_time)
        else:
            logger.info("Saved camera %s position videoTime=%.2f (no runner yet)", camera_id, video_time)

    # --- State queries ---

    def get_camera_state(self, camera_id: str) -> SecurityCameraState:
        with self._lock:
            return self._camera_states.get(camera_id, SecurityCameraState())

    def get_events(self, camera_id: str | None = None, since_sec: float = 0.0) -> list[SecurityEvent]:
        with self._lock:
            evts = self._events
            if camera_id:
                evts = [e for e in evts if e.cameraId == camera_id]
            if since_sec > 0:
                evts = [e for e in evts if e.timestampSec >= since_sec]
            return list(evts[-100:])  # Cap at last 100

    def get_service_state(self) -> SecurityServiceState:
        with self._lock:
            # Build per-task TaskEventCounts
            task_counts: dict[str, TaskEventCounts] = {}
            for task_id, counts in self._event_counts.items():
                task_counts[task_id] = TaskEventCounts(
                    zone_entry=counts.get("zone_entry", 0),
                    dwelling=counts.get("dwelling", 0),
                    running=counts.get("running", 0),
                    chasing=counts.get("chasing", 0),
                    altercation=counts.get("altercation", 0),
                    crowd_gathering=counts.get("crowd_gathering", 0),
                    line_crossing=counts.get("line_crossing", 0),
                    total=sum(counts.values()),
                )
            return SecurityServiceState(
                tasks=list(self._tasks.values()),
                events=list(self._events[-200:]),
                activeCameras=list(self._camera_threads.keys()),
                taskCounts=task_counts,
            )

    def get_available_classes(self) -> list[str]:
        det = self._ensure_detector()
        return det.labels

    def list_camera_ids(self) -> list[str]:
        """Return camera IDs from the security videos directory only."""
        if self._own_video_ingestion:
            return self._own_video_ingestion.discovered_camera_ids()
        return []

    # --- Camera thread management ---

    def _start_camera(self, task: SecurityTask) -> None:
        cam_id = task.cameraId
        self._refresh_camera_runner(cam_id)

    def _refresh_camera_runner(self, cam_id: str) -> None:
        """Start or update the single runner for this camera with ALL enabled tasks."""
        cam_tasks = [t for t in self._tasks.values() if t.cameraId == cam_id and t.enabled]

        if not cam_tasks:
            if cam_id in self._camera_threads:
                self._stop_runner(cam_id)
            return

        # Merge all zones and lines from all tasks
        all_zones = []
        all_lines = []
        for t in cam_tasks:
            all_zones.extend(t.zones)
            all_lines.extend(t.lines)

        merged_task = SecurityTask(
            id=f"merged-{cam_id}",
            cameraId=cam_id,
            zones=all_zones,
            lines=all_lines,
            sampleRate=min(t.sampleRate for t in cam_tasks),
            enabled=True,
        )

        # If runner already exists, just hot-swap zones/lines — DON'T restart
        existing_runner = self._camera_threads.get(cam_id)
        if existing_runner and not existing_runner._stop_event.is_set():
            existing_runner.task = merged_task
            logger.info("Hot-updated security runner for camera %s: %d tasks, %d zones",
                         cam_id, len(cam_tasks), len(all_zones))
            return

        # No runner exists — start fresh from last known video position
        frame_entries, fps = self._resolve_frame_cache(cam_id)
        if not frame_entries:
            logger.error("No frame cache for camera %s", cam_id)
            return

        # Use saved video position (from reset-camera) as start frame
        saved_time = self._camera_video_times.get(cam_id, 0.0)
        initial_frame = int(saved_time * fps) % max(len(frame_entries), 1) if saved_time > 0 else 0
        awaiting_sync = saved_time == 0  # No saved position → wait for frontend reset

        det = self._ensure_detector()
        pipeline = SecurityPipeline(det)

        runner = _CameraRunner(
            camera_id=cam_id,
            task=merged_task,
            pipeline=pipeline,
            frame_paths=[str(e.path) for e in frame_entries],
            frame_timestamps=[e.timestamp_seconds for e in frame_entries],
            fps=fps,
            on_update=self._on_camera_update,
            initial_frame=initial_frame,
        )
        runner._awaiting_sync = awaiting_sync
        self._camera_threads[cam_id] = runner
        runner.start()
        self._update_scheduler_flag()
        logger.info("Started security runner for camera %s: %d tasks, %d zones, start=%d, await_sync=%s",
                     cam_id, len(cam_tasks), len(all_zones), initial_frame, awaiting_sync)

    def _stop_runner(self, cam_id: str) -> None:
        runner = self._camera_threads.pop(cam_id, None)
        if runner is not None:
            runner._stop_event.set()
            # Brief wait to ensure thread exits before a new one starts
            if runner._thread is not None:
                runner._thread.join(timeout=0.2)
            self._camera_states.pop(cam_id, None)
            self._camera_video_times.pop(cam_id, None)  # Force fresh sync on next start
            self._update_scheduler_flag()
            logger.info("Stopped security runner for camera %s", cam_id)

    def _update_scheduler_flag(self) -> None:
        """Tell the main scheduler to skip tick_all_cameras when security is active."""
        svc = self._parent_service
        if svc is not None:
            svc._security_active = len(self._camera_threads) > 0

    def _on_camera_update(self, camera_id: str, state: SecurityCameraState, events: list[SecurityEvent]) -> None:
        # Atomic state swap — no lock needed (GIL makes dict assignment atomic)
        self._camera_states[camera_id] = state
        if events:
            with self._lock:
                self._events.extend(events)
                if len(self._events) > 500:
                    self._events = self._events[-250:]
                # Route each event to the task(s) that monitor its type
                for ev in events:
                    for task in self._tasks.values():
                        if task.cameraId != camera_id:
                            continue
                        if self._task_monitors_event(task, ev.eventType):
                            tc = self._event_counts.setdefault(task.id, {})
                            tc[ev.eventType] = tc.get(ev.eventType, 0) + 1
            # DB writes in background thread — never block the detection loop
            evts = list(events)
            threading.Thread(
                target=self._persist_events, args=(evts,), daemon=True
            ).start()

    @staticmethod
    def _task_monitors_event(task: SecurityTask, event_type: str) -> bool:
        for z in task.zones:
            if event_type == "zone_entry" and z.detectEntry:
                return True
            if event_type == "dwelling" and z.detectDwelling:
                return True
            if event_type == "running" and z.detectRunning:
                return True
            if event_type == "chasing" and getattr(z, "detectChasing", False):
                return True
            if event_type == "altercation" and getattr(z, "detectAltercation", False):
                return True
            if event_type == "crowd_gathering" and z.detectCrowdGathering:
                return True
        for l in task.lines:
            if event_type == "line_crossing" and l.enabled:
                return True
        return False

    def _persist_events(self, events: list[SecurityEvent]) -> None:
        for ev in events:
            try:
                self._store.append_event(ev)
            except Exception:
                pass

    def _resolve_frame_cache(self, camera_id: str):
        # Use own video ingestion (security videos dir) first, fall back to shared
        vi = self._own_video_ingestion or self._video_ingestion
        if vi is None:
            return None, 0.0
        try:
            # Ensure video is discovered/scanned
            vi.discover(camera_id)
            source = vi.store.get_video_source(camera_id)
            if source is None or not source.cacheDir:
                return None, 0.0
            cache_dir = vi._resolve_cache_dir_path(source.cacheDir)
            entries = vi._frame_entries(cache_dir)
            fps = source.inputFps or source.normalizedFps or 24.0
            return entries, fps
        except Exception:
            logger.debug("Frame cache resolution failed for %s", camera_id)
            return None, 0.0

    def stop(self) -> None:
        for cam_id in list(self._camera_threads.keys()):
            self._stop_runner(cam_id)
        self._store.close()


class _CameraRunner:
    """Runs the detection loop for a single camera in its own thread."""

    def __init__(
        self,
        camera_id: str,
        task: SecurityTask,
        pipeline: SecurityPipeline,
        frame_paths: list[str],
        frame_timestamps: list[float],
        fps: float,
        on_update,
        initial_frame: int = 0,
    ):
        self.camera_id = camera_id
        self.task = task
        self.pipeline = pipeline
        self.frame_paths = frame_paths
        self.frame_timestamps = frame_timestamps
        self.fps = fps
        self.total_frames = len(frame_paths)
        self.on_update = on_update
        self._initial_frame = initial_frame
        self._awaiting_sync = initial_frame == 0  # Wait for frontend reset before producing output
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._sync_video_time: float | None = None  # Set by frontend to sync

    def sync_to_video_time(self, video_time: float) -> None:
        """Called by frontend to reset the frame anchor to match browser video position."""
        self._sync_video_time = video_time
        self._awaiting_sync = False  # Frontend has synced — start producing output

    def start(self) -> None:
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run, name=f"security-{self.camera_id}", daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=0.5)
            self._thread = None

    def _run(self) -> None:
        """Wall-clock frame loop — EXACT same pattern as counting pipeline.

        _counting_loop:  while True → tick_counting_cameras() → sleep(10ms)
        tick_counting_cameras:  elapsed = perf_counter - start_time
                                frame_index = (start_frame + int(elapsed * fps)) % total
                                run YOLO on frame_entries[frame_index]
                                store snapshot

        No stride, no pacing. Process as fast as possible.
        Wall-clock determines which frame = always in sync with video.
        """
        start_time = time.perf_counter()
        start_frame = self._initial_frame

        logger.info(
            "Security loop %s: %d frames, %.1f fps, start_frame=%d",
            self.camera_id, self.total_frames, self.fps, start_frame,
        )

        try:
            while not self._stop_event.is_set():
                # Check if frontend requested a sync
                sync_t = self._sync_video_time
                if sync_t is not None:
                    self._sync_video_time = None
                    start_frame = int(sync_t * self.fps) % max(self.total_frames, 1)
                    start_time = time.perf_counter()
                    self.pipeline.reset(self.camera_id)
                    logger.info("Security sync → frame %d", start_frame)

                # Wait for frontend to tell us the video position before producing output
                if self._awaiting_sync:
                    time.sleep(0.05)
                    continue

                # Wall-clock frame index (identical to counting)
                elapsed = time.perf_counter() - start_time
                frame_index = (start_frame + int(elapsed * self.fps)) % self.total_frames

                ts = self.frame_timestamps[frame_index]

                # YOLO + tracking + security engine
                tracks, events = self.pipeline.run_tick(
                    self.camera_id,
                    self.frame_paths[frame_index],
                    ts,
                    self.task.zones,
                    self.task.lines,
                )

                frame_id = f"{self.camera_id}-video-{frame_index + 1:06d}"
                frame_url = f"/api/live/frame/{frame_id}?cameraId={self.camera_id}"

                state = SecurityCameraState(
                    tracks=tracks,
                    frameIndex=frame_index,
                    currentSec=ts,
                    frameUrl=frame_url,
                )

                self.on_update(self.camera_id, state, events)

                tick_count = getattr(self, '_tick_count', 0) + 1
                self._tick_count = tick_count
                if tick_count == 1 or tick_count % 50 == 0:
                    tick_fps = tick_count / max(time.perf_counter() - start_time, 0.001)
                    logger.info(
                        "Security %s tick=%d frame=%d fps=%.1f",
                        self.camera_id, tick_count, frame_index, tick_fps,
                    )

                # 10ms GIL yield — safe now because main scheduler skips
                # tick_all_cameras when security is active
                time.sleep(0.01)

        except Exception:
            logger.exception("Security loop CRASHED for %s", self.camera_id)
        finally:
            logger.warning("Security loop ENDED for %s", self.camera_id)
