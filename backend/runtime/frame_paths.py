from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path, PureWindowsPath
from typing import Iterable
from urllib.parse import parse_qs, quote, urlencode, urlsplit

from ..demo_paths import ROOT_DIR, get_demo_assets_dir, get_demo_videos_dir


LIVE_FRAME_PREFIX = "/api/live/frame/"


class FrameImagePathError(ValueError):
    pass


@dataclass(frozen=True)
class ResolvedFrameImagePath:
    kind: str
    value: str | Path


def normalize_frame_image_path(image_path: str | None) -> str | None:
    if image_path is None:
        return None

    trimmed = image_path.strip()
    return trimmed or None


def build_live_frame_url(frame_id: str, camera_id: str | None = None) -> str:
    encoded_frame_id = quote(frame_id, safe="")
    if not camera_id:
        return f"{LIVE_FRAME_PREFIX}{encoded_frame_id}"
    return f"{LIVE_FRAME_PREFIX}{encoded_frame_id}?{urlencode({'cameraId': camera_id})}"


def validate_frame_image_path(image_path: str | None) -> None:
    _resolve_frame_image_path(image_path)


def resolve_frame_asset_path(image_path: str | None) -> Path | None:
    try:
        resolved = _resolve_frame_image_path(image_path)
    except FrameImagePathError:
        return None

    if resolved is None or resolved.kind != "asset":
        return None
    return Path(resolved.value)


def resolve_runtime_frame_path(
    image_path: str | None,
    *,
    approved_roots: Iterable[Path] | None = None,
) -> Path | None:
    try:
        resolved = _resolve_frame_image_path(
            image_path,
            allow_absolute_internal=True,
            approved_roots=approved_roots,
        )
    except FrameImagePathError:
        return None

    if resolved is None or resolved.kind != "asset":
        return None
    return Path(resolved.value)


def _resolve_frame_image_path(
    image_path: str | None,
    *,
    allow_absolute_internal: bool = False,
    approved_roots: Iterable[Path] | None = None,
) -> ResolvedFrameImagePath | None:
    normalized = normalize_frame_image_path(image_path)
    if normalized is None:
        return None

    parsed = urlsplit(normalized)
    if parsed.scheme or parsed.netloc:
        raise FrameImagePathError("imagePath must not reference an external URL")

    if normalized.startswith("/") and not parsed.path.startswith(LIVE_FRAME_PREFIX):
        return _resolve_absolute_runtime_path(
            normalized,
            allow_absolute_internal=allow_absolute_internal,
            approved_roots=approved_roots,
        )

    if PureWindowsPath(normalized).is_absolute() or normalized.startswith("\\\\"):
        return _resolve_absolute_runtime_path(
            normalized,
            allow_absolute_internal=allow_absolute_internal,
            approved_roots=approved_roots,
        )

    if normalized.startswith("/"):
        _validate_live_frame_url(parsed)
        return ResolvedFrameImagePath(kind="live_api", value=normalized)

    candidate = (ROOT_DIR / Path(normalized)).resolve()
    assets_root = get_demo_assets_dir().resolve()
    if not _is_within_root(candidate, assets_root):
        raise FrameImagePathError("imagePath must resolve inside the approved demo assets directory")
    return ResolvedFrameImagePath(kind="asset", value=candidate)


def _validate_live_frame_url(parsed) -> None:
    if parsed.fragment:
        raise FrameImagePathError("imagePath must not include a fragment")
    if not parsed.path.startswith(LIVE_FRAME_PREFIX):
        raise FrameImagePathError("imagePath must use the internal live frame endpoint")

    frame_id = parsed.path[len(LIVE_FRAME_PREFIX) :]
    if not frame_id or "/" in frame_id:
        raise FrameImagePathError("imagePath must target a single frame id")

    query = parse_qs(parsed.query, keep_blank_values=True)
    if any(key != "cameraId" for key in query):
        raise FrameImagePathError("imagePath query parameters are restricted")
    if "cameraId" in query:
        values = query["cameraId"]
        if len(values) != 1 or not values[0].strip():
            raise FrameImagePathError("imagePath cameraId must be a single non-empty value")


def _is_within_root(candidate: Path, root: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def _is_within_any_root(candidate: Path, roots: Iterable[Path]) -> bool:
    return any(_is_within_root(candidate, root.expanduser().resolve()) for root in roots)


def _default_runtime_frame_roots() -> tuple[Path, ...]:
    return (
        get_demo_assets_dir().resolve(),
        get_demo_videos_dir().resolve(),
    )


def _resolve_absolute_runtime_path(
    normalized: str,
    *,
    allow_absolute_internal: bool,
    approved_roots: Iterable[Path] | None,
) -> ResolvedFrameImagePath:
    if allow_absolute_internal:
        candidate = Path(normalized).expanduser().resolve()
        if _is_within_any_root(candidate, approved_roots or _default_runtime_frame_roots()):
            return ResolvedFrameImagePath(kind="asset", value=candidate)
    raise FrameImagePathError("imagePath must not use an absolute filesystem path")
