from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from fractions import Fraction
from pathlib import Path, PureWindowsPath
from typing import Iterable

from ..demo_paths import ROOT_DIR, get_demo_video_path, get_demo_videos_dir
from ..models import CameraVideoSourceState, LotFrameDefinition, SpatialConfig
from .config_repository import SpatialConfigFileRepository
from .spatial_config import iso_now
from .storage import SQLiteStore


NORMALIZED_VIDEO_FPS = 5.0


class VideoPathError(ValueError):
    pass


@dataclass
class FrameSource:
    camera_id: str
    frame_id: str
    frame_index: int
    captured_at: str
    label: str
    image_path: Path | None
    width: int
    height: int
    source_kind: str


@dataclass
class ExtractedVideoFrame:
    path: Path
    index: int
    timestamp_seconds: float


class VideoIngestionManager:
    def __init__(
        self,
        store: SQLiteStore,
        config_store: SpatialConfigFileRepository,
        videos_dir: Path | None = None,
        normalized_fps: float = NORMALIZED_VIDEO_FPS,
    ):
        self.store = store
        self.config_store = config_store
        self.videos_dir = (videos_dir or get_demo_videos_dir()).expanduser().resolve()
        self.normalized_fps = normalized_fps
        self.videos_dir.mkdir(parents=True, exist_ok=True)
        self._legacy_cursors: dict[str, int] = {}

    def rescan_all(self, camera_ids: Iterable[str]) -> list[CameraVideoSourceState]:
        return [self.discover(camera_id) for camera_id in camera_ids]

    def discovered_camera_ids(self) -> list[str]:
        mapping = self._load_video_map()
        if mapping:
            return sorted(mapping.keys())
        valid_ids = sorted(path.stem for path in self.videos_dir.glob("*.mp4"))
        # Cleanup orphan frame-cache directories (no matching .mp4)
        # Skip directories that contain .mp4 files (they are video subdirs, not caches)
        import shutil
        valid_set = set(valid_ids)
        for d in self.videos_dir.iterdir():
            if d.is_dir() and d.name not in valid_set:
                has_videos = any(d.glob("*.mp4"))
                if not has_videos:
                    try:
                        shutil.rmtree(d)
                    except Exception:
                        pass
        return valid_ids

    def discover(self, camera_id: str) -> CameraVideoSourceState:
        now = iso_now()
        existing = self.store.get_video_source(camera_id)
        try:
            source_path = self._resolve_source_path(camera_id)
        except VideoPathError as exc:
            state = CameraVideoSourceState(
                cameraId=camera_id,
                sourcePath=None,
                cacheDir=None,
                status="error",
                discoveredAt=existing.discoveredAt if existing else now,
                updatedAt=now,
                normalizedFps=self.normalized_fps,
                frameCount=0,
                sourceSignature=None,
                currentFrameIndex=existing.currentFrameIndex if existing else 0,
                currentFrameId=None,
                currentFramePath=None,
                lastTickAt=existing.lastTickAt if existing else None,
                loopCount=existing.loopCount if existing else 0,
                error=str(exc),
            )
            return self.store.upsert_video_source(state)

        if not source_path.exists():
            available_files = ", ".join(self._available_video_files()) or "none"
            mapped_target = self._load_video_map().get(camera_id)
            if mapped_target:
                error = f"Mapped video '{mapped_target}' for camera {camera_id} was not found."
            else:
                error = (
                    f"No video matched camera {camera_id}. Expected '{camera_id}.mp4' or "
                    f"an entry in demo/videos/video-map.json. Available files: {available_files}."
                )
            state = CameraVideoSourceState(
                cameraId=camera_id,
                sourcePath=str(source_path),
                cacheDir=None,
                status="missing",
                discoveredAt=existing.discoveredAt if existing else now,
                updatedAt=now,
                normalizedFps=self.normalized_fps,
                frameCount=0,
                sourceSignature=None,
                currentFrameIndex=existing.currentFrameIndex if existing else 0,
                currentFrameId=None,
                currentFramePath=None,
                lastTickAt=existing.lastTickAt if existing else None,
                loopCount=existing.loopCount if existing else 0,
                error=error,
            )
            return self.store.upsert_video_source(state)

        stat = source_path.stat()
        signature = f"{stat.st_mtime_ns}:{stat.st_size}"
        cache_dir = self._cache_dir(camera_id, signature)
        manifest_path = cache_dir / "manifest.json"
        metadata = self._probe(source_path)
        extracted_frames = self._extract_frames_if_needed(
            source_path,
            cache_dir,
            manifest_path,
            signature,
            metadata,
        )
        current_index = existing.currentFrameIndex if existing and existing.status == "ready" else 0
        if extracted_frames:
            current_index = min(current_index, len(extracted_frames) - 1)
        current_path = extracted_frames[current_index].path if extracted_frames else None
        effective_fps = metadata.get("inputFps") or self.normalized_fps
        state = CameraVideoSourceState(
            cameraId=camera_id,
            sourcePath=str(source_path),
            cacheDir=str(cache_dir),
            status="ready",
            discoveredAt=existing.discoveredAt if existing else now,
            updatedAt=now,
            normalizedFps=effective_fps,
            inputFps=metadata.get("inputFps"),
            durationSeconds=metadata.get("durationSeconds"),
            width=metadata.get("width"),
            height=metadata.get("height"),
            frameCount=len(extracted_frames),
            sourceSignature=signature,
            currentFrameIndex=current_index,
            currentFrameId=self._frame_id(camera_id, current_index) if extracted_frames else None,
            currentFramePath=str(current_path) if current_path else None,
            lastTickAt=existing.lastTickAt if existing else None,
            loopCount=existing.loopCount if existing else 0,
            error=None,
        )
        return self.store.upsert_video_source(state)

    def refresh_camera(self, config: SpatialConfig, advance: bool, force_index: int | None = None) -> FrameSource:
        source = self.store.get_video_source(config.cameraId)
        if source and source.status == "ready" and source.frameCount > 0:
            return self._video_frame(config.cameraId, source, advance=advance, force_index=force_index)
        return self._legacy_frame(config, advance=advance, force_index=force_index)

    def select_frame(self, config: SpatialConfig, frame_id: str) -> FrameSource:
        source = self.store.get_video_source(config.cameraId)
        if source and source.status == "ready" and source.frameCount > 0:
            index = self._index_from_frame_id(config.cameraId, frame_id)
            if index is not None:
                return self._video_frame(config.cameraId, source, advance=False, force_index=index)
        return self._legacy_frame(config, advance=False, force_index=self._legacy_index(config, frame_id))

    def frame_response_path(self, frame_id: str) -> Path | None:
        camera_id, index = self._parse_frame_id(frame_id)
        if camera_id is None or index is None:
            return None
        source = self.store.get_video_source(camera_id)
        if source is None or source.status != "ready" or not source.cacheDir:
            return None
        cache_dir = self._resolve_cache_dir_path(source.cacheDir)
        if cache_dir is None:
            return None
        frame_paths = self._frame_paths(cache_dir)
        if not frame_paths:
            return None
        if index < 0 or index >= len(frame_paths):
            return None
        return frame_paths[index]

    def list_frames(self, config: SpatialConfig) -> list[LotFrameDefinition]:
        source = self.store.get_video_source(config.cameraId)
        cache_dir = self._resolve_cache_dir_path(source.cacheDir) if source and source.cacheDir else None
        if source is None or source.status != "ready" or cache_dir is None:
            return [
                frame.model_copy(update={"cameraId": config.cameraId})
                for frame in config.frames
            ]

        extracted_frames = self._frame_entries(cache_dir)
        if not extracted_frames:
            return [
                frame.model_copy(update={"cameraId": config.cameraId})
                for frame in config.frames
            ]

        base_timestamp = self._base_timestamp(config)
        return [
            LotFrameDefinition(
                id=self._frame_id(config.cameraId, index),
                cameraId=config.cameraId,
                label=f"Capture {index + 1}",
                imagePath=str(extracted_frame.path),
                capturedAt=self._serialize_timestamp(
                    base_timestamp + timedelta(seconds=extracted_frame.timestamp_seconds)
                ),
                width=source.width or config.frameWidth,
                height=source.height or config.frameHeight,
            )
            for index, extracted_frame in enumerate(extracted_frames)
        ]

    def camera_id_for_frame_id(self, frame_id: str) -> str | None:
        camera_id, _ = self._parse_frame_id(frame_id)
        return camera_id

    def reset_camera(self, camera_id: str) -> None:
        source = self.store.get_video_source(camera_id)
        if source is None:
            return
        updated = source.model_copy(
            update={
                "currentFrameIndex": 0,
                "currentFrameId": self._frame_id(camera_id, 0) if source.frameCount else None,
                "currentFramePath": None,
                "lastTickAt": None,
                "loopCount": 0,
                "updatedAt": iso_now(),
            }
        )
        if source.cacheDir and source.frameCount > 0:
            cache_dir = self._resolve_cache_dir_path(source.cacheDir)
            frame_paths = self._frame_paths(cache_dir) if cache_dir is not None else []
            if frame_paths:
                updated = updated.model_copy(update={"currentFramePath": str(frame_paths[0])})
        self.store.upsert_video_source(updated)

    def _legacy_frame(self, config: SpatialConfig, advance: bool, force_index: int | None = None) -> FrameSource:
        cursor_index = self._legacy_cursors.get(config.cameraId, 0)
        if force_index is not None:
            cursor_index = force_index % len(config.frames)
        elif advance:
            cursor_index = (cursor_index + 1) % len(config.frames)
        self._legacy_cursors[config.cameraId] = cursor_index
        frame = config.frames[cursor_index % len(config.frames)]
        return FrameSource(
            camera_id=config.cameraId,
            frame_id=frame.id,
            frame_index=cursor_index,
            captured_at=frame.capturedAt or iso_now(),
            label=frame.label,
            image_path=self._resolve_image_path(frame.imagePath),
            width=frame.width,
            height=frame.height,
            source_kind="legacy",
        )

    def _video_frame(self, camera_id: str, source: CameraVideoSourceState, advance: bool, force_index: int | None = None) -> FrameSource:
        cache_dir = self._resolve_cache_dir_path(source.cacheDir)
        if cache_dir is None:
            raise KeyError(f"Video cache directory is unavailable for camera {camera_id}")
        extracted_frames = self._frame_entries(cache_dir)
        if not extracted_frames:
            raise KeyError(f"No extracted frames available for camera {camera_id}")

        index = source.currentFrameIndex
        if force_index is not None:
            index = force_index % len(extracted_frames)
        elif advance:
            index = (index + 1) % len(extracted_frames)

        loop_count = source.loopCount + 1 if advance and index == 0 and source.frameCount > 0 and source.currentFrameIndex >= source.frameCount - 1 else source.loopCount
        extracted_frame = extracted_frames[index]
        frame = FrameSource(
            camera_id=camera_id,
            frame_id=self._frame_id(camera_id, index),
            frame_index=index,
            captured_at=self._captured_at_for_timestamp_seconds(camera_id, extracted_frame.timestamp_seconds),
            label=f"{camera_id} video frame {index + 1}",
            image_path=extracted_frame.path,
            width=source.width or 1280,
            height=source.height or 720,
            source_kind="video",
        )
        self.store.upsert_video_source(
            source.model_copy(
                update={
                    "currentFrameIndex": index,
                    "currentFrameId": frame.frame_id,
                    "currentFramePath": str(extracted_frame.path),
                    "lastTickAt": frame.captured_at,
                    "loopCount": loop_count,
                    "updatedAt": frame.captured_at,
                }
            )
        )
        return frame

    def _extract_frames_if_needed(
        self,
        source_path: Path,
        cache_dir: Path,
        manifest_path: Path,
        signature: str,
        metadata: dict[str, float | int | None],
    ) -> list[ExtractedVideoFrame]:
        if manifest_path.exists():
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                manifest = {}
            if manifest.get("signature") == signature:
                extracted_frames = self._frame_entries(cache_dir)
                if extracted_frames and all(frame.path.exists() for frame in extracted_frames):
                    return extracted_frames

        cache_dir.mkdir(parents=True, exist_ok=True)
        for existing in cache_dir.glob("frame_*.jpg"):
            existing.unlink(missing_ok=True)
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source_path),
            "-vsync",
            "0",
            "-q:v",
            "2",
            str(cache_dir / "frame_%06d.jpg"),
        ]
        subprocess.run(cmd, check=True, capture_output=True, text=True)
        frame_files = sorted(cache_dir.glob("frame_*.jpg"))
        frame_timestamps = self._probe_frame_timestamps(source_path)
        frame_entries = []
        for index, path in enumerate(frame_files):
            timestamp_seconds = (
                frame_timestamps[index]
                if index < len(frame_timestamps)
                else self._fallback_frame_timestamp(index, metadata.get("inputFps"))
            )
            frame_entries.append(
                {
                    "file": path.name,
                    "index": index,
                    "timestampSeconds": round(float(timestamp_seconds), 6),
                }
            )
        manifest_path.write_text(
            json.dumps(
                {
                    "signature": signature,
                    "source": str(source_path),
                    "normalized_fps": metadata.get("inputFps") or self.normalized_fps,
                    "input_fps": metadata.get("inputFps"),
                    "duration_seconds": metadata.get("durationSeconds"),
                    "frames": frame_entries,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        return self._frame_entries(cache_dir)

    def _probe(self, source_path: Path) -> dict[str, float | int | None]:
        cmd = [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,avg_frame_rate,r_frame_rate,nb_frames:format=duration",
            "-of",
            "json",
            str(source_path),
        ]
        result = subprocess.run(cmd, check=True, capture_output=True, text=True)
        payload = json.loads(result.stdout)
        stream = (payload.get("streams") or [{}])[0]
        fmt = payload.get("format") or {}
        fps = self._parse_rate(stream.get("avg_frame_rate") or stream.get("r_frame_rate"))
        frame_count = stream.get("nb_frames")
        try:
            frame_count_int = int(frame_count) if frame_count not in (None, "N/A") else None
        except (TypeError, ValueError):
            frame_count_int = None
        duration = self._parse_float(fmt.get("duration"))
        if frame_count_int is None and fps and duration:
            frame_count_int = max(int(round(duration * fps)), 0)
        return {
            "width": self._parse_int(stream.get("width")),
            "height": self._parse_int(stream.get("height")),
            "inputFps": fps,
            "durationSeconds": duration,
            "frameCount": frame_count_int,
        }

    def _cache_dir(self, camera_id: str, signature: str) -> Path:
        return self.videos_dir / self._safe_camera_cache_segment(camera_id) / signature.replace(":", "_")

    def _resolve_source_path(self, camera_id: str) -> Path:
        exact_match = (self.videos_dir / f"{camera_id}.mp4").resolve()
        if exact_match.exists():
            return exact_match

        mapped_name = self._load_video_map().get(camera_id)
        if not mapped_name:
            return exact_match

        mapped_path = Path(mapped_name).expanduser()
        if mapped_path.is_absolute():
            raise VideoPathError("Mapped video path must stay inside the configured videos directory.")
        resolved = (self.videos_dir / mapped_path).resolve()
        if not _is_within_root(resolved, self.videos_dir):
            raise VideoPathError("Mapped video path must stay inside the configured videos directory.")
        return resolved

    def _load_video_map(self) -> dict[str, str]:
        map_path = self.videos_dir / "video-map.json"
        if not map_path.exists():
            return {}

        try:
            payload = json.loads(map_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}

        if not isinstance(payload, dict):
            return {}

        return {
            str(camera_id): str(filename)
            for camera_id, filename in payload.items()
            if isinstance(camera_id, str) and isinstance(filename, str) and filename.strip()
        }

    def _available_video_files(self) -> list[str]:
        return sorted(path.name for path in self.videos_dir.glob("*.mp4"))

    def _frame_paths(self, cache_dir: Path) -> list[Path]:
        return [entry.path for entry in self._frame_entries(cache_dir)]

    def _frame_entries(self, cache_dir: Path) -> list[ExtractedVideoFrame]:
        cache_dir = self._resolve_cache_dir_path(cache_dir)
        if cache_dir is None or not cache_dir.exists():
            return []
        manifest_path = cache_dir / "manifest.json"
        if manifest_path.exists():
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                manifest = {}
            frames = manifest.get("frames", [])
            if isinstance(frames, list):
                extracted_frames: list[ExtractedVideoFrame] = []
                for index, item in enumerate(frames):
                    if isinstance(item, str):
                        resolved_path = self._resolve_manifest_frame_path(cache_dir, item)
                        if resolved_path is None:
                            continue
                        extracted_frames.append(
                            ExtractedVideoFrame(
                                path=resolved_path,
                                index=index,
                                timestamp_seconds=self._fallback_frame_timestamp(index, manifest.get("input_fps")),
                            )
                        )
                        continue
                    if not isinstance(item, dict):
                        continue
                    file_name = item.get("file")
                    if not isinstance(file_name, str):
                        continue
                    resolved_path = self._resolve_manifest_frame_path(cache_dir, file_name)
                    if resolved_path is None:
                        continue
                    extracted_frames.append(
                        ExtractedVideoFrame(
                            path=resolved_path,
                            index=int(item.get("index", index)),
                            timestamp_seconds=float(
                                item.get(
                                    "timestampSeconds",
                                    self._fallback_frame_timestamp(index, manifest.get("input_fps")),
                                )
                            ),
                        )
                    )
                if extracted_frames:
                    return extracted_frames
        return [
            ExtractedVideoFrame(
                path=path,
                index=index,
                timestamp_seconds=self._fallback_frame_timestamp(index, None),
            )
            for index, path in enumerate(sorted(cache_dir.glob("frame_*.jpg")))
        ]

    def _frame_id(self, camera_id: str, index: int) -> str:
        return f"{camera_id}-video-{index + 1:06d}"

    def _parse_rate(self, raw_value: object) -> float | None:
        if raw_value in (None, "", "N/A"):
            return None
        if isinstance(raw_value, (int, float)):
            return float(raw_value)
        if isinstance(raw_value, str):
            try:
                return float(Fraction(raw_value))
            except (ValueError, ZeroDivisionError):
                return self._parse_float(raw_value)
        return None

    def _parse_int(self, raw_value: object) -> int | None:
        try:
            return int(raw_value) if raw_value not in (None, "", "N/A") else None
        except (TypeError, ValueError):
            return None

    def _parse_float(self, raw_value: object) -> float | None:
        try:
            return float(raw_value) if raw_value not in (None, "", "N/A") else None
        except (TypeError, ValueError):
            return None

    def _probe_frame_timestamps(self, source_path: Path) -> list[float]:
        cmd = [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "frame=best_effort_timestamp_time,pkt_pts_time",
            "-of",
            "json",
            str(source_path),
        ]
        result = subprocess.run(cmd, check=True, capture_output=True, text=True)
        payload = json.loads(result.stdout)
        frames = payload.get("frames") or []
        timestamps: list[float] = []
        for index, frame in enumerate(frames):
            if not isinstance(frame, dict):
                continue
            raw_timestamp = frame.get("best_effort_timestamp_time", frame.get("pkt_pts_time"))
            timestamp = self._parse_float(raw_timestamp)
            timestamps.append(timestamp if timestamp is not None else self._fallback_frame_timestamp(index, None))
        return timestamps

    def _fallback_frame_timestamp(self, index: int, fps: object) -> float:
        resolved_fps = self._parse_float(fps) or self.normalized_fps or 1.0
        return index / max(resolved_fps, 0.1)

    def _captured_at_for_timestamp_seconds(self, camera_id: str, timestamp_seconds: float) -> str:
        active = self.config_store.get_active_config(camera_id) or self.config_store.get_latest_non_archived_config(camera_id)
        if active is not None:
            base_timestamp = self._base_timestamp(active)
        else:
            base_timestamp = datetime(1970, 1, 1, tzinfo=timezone.utc)
        return self._serialize_timestamp(base_timestamp + timedelta(seconds=timestamp_seconds))

    def _serialize_timestamp(self, value: datetime) -> str:
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        else:
            value = value.astimezone(timezone.utc)
        return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def _resolve_image_path(self, image_path: str | None) -> Path | None:
        if not image_path:
            return None
        candidate = Path(image_path)
        if candidate.is_absolute():
            return candidate
        return (ROOT_DIR / candidate).resolve()

    def _resolve_cache_dir_path(self, cache_dir: Path | str | None) -> Path | None:
        if not cache_dir:
            return None
        candidate = Path(cache_dir).expanduser().resolve()
        if not _is_within_root(candidate, self.videos_dir):
            return None
        return candidate

    def _resolve_manifest_frame_path(self, cache_dir: Path, file_name: str) -> Path | None:
        if (
            not file_name
            or "/" in file_name
            or "\\" in file_name
            or Path(file_name).is_absolute()
            or PureWindowsPath(file_name).is_absolute()
        ):
            return None
        candidate = (cache_dir / file_name).resolve()
        if not _is_within_root(candidate, cache_dir):
            return None
        return candidate

    def _safe_camera_cache_segment(self, camera_id: str) -> str:
        sanitized = re.sub(r"[^A-Za-z0-9._-]+", "_", camera_id).strip("._")
        return sanitized or "camera"

    def _legacy_index(self, config: SpatialConfig, frame_id: str) -> int | None:
        for index, frame in enumerate(config.frames):
            if frame.id == frame_id:
                return index
        return None

    def _base_timestamp(self, config: SpatialConfig) -> datetime:
        frame = config.frames[0] if config.frames else None
        if frame and frame.capturedAt:
            raw_value = frame.capturedAt.replace("Z", "+00:00")
            try:
                parsed = datetime.fromisoformat(raw_value)
                if parsed.tzinfo is None:
                    return parsed.replace(tzinfo=timezone.utc)
                return parsed.astimezone(timezone.utc)
            except ValueError:
                pass
        return datetime.now(timezone.utc).replace(microsecond=0)

    def _index_from_frame_id(self, camera_id: str, frame_id: str) -> int | None:
        prefix = f"{camera_id}-video-"
        if not frame_id.startswith(prefix):
            return None
        try:
            return max(int(frame_id.removeprefix(prefix)) - 1, 0)
        except ValueError:
            return None

    def _parse_frame_id(self, frame_id: str) -> tuple[str | None, int | None]:
        if "-video-" not in frame_id:
            return None, None
        camera_id, index_text = frame_id.rsplit("-video-", 1)
        try:
            return camera_id, max(int(index_text) - 1, 0)
        except ValueError:
            return camera_id, None


def _is_within_root(candidate: Path, root: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False
