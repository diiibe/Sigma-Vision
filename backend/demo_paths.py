from __future__ import annotations

import os
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
DEMO_ASSETS_ENV_VAR = "HACK26_DEMO_ASSETS_DIR"
STATE_DIR_ENV_VAR = "HACK26_STATE_DIR"
BOOTSTRAP_LAYOUT_ENV_VAR = "HACK26_BOOTSTRAP_LAYOUT"
BACKEND_CORS_ORIGINS_ENV_VAR = "HACK26_CORS_ORIGINS"
RUNTIME_SNAPSHOT_RETENTION_ENV_VAR = "HACK26_RUNTIME_SNAPSHOT_RETENTION"
RUNTIME_EVENT_RETENTION_ENV_VAR = "HACK26_RUNTIME_EVENT_RETENTION"
RUNTIME_TIMELINE_RETENTION_ENV_VAR = "HACK26_RUNTIME_TIMELINE_RETENTION"
DEFAULT_LOCAL_DIR = ROOT_DIR.parent / "hack26-local"
DEFAULT_DEMO_ASSETS_DIR = DEFAULT_LOCAL_DIR / "demo-assets"
DEFAULT_DEMO_VIDEOS_DIR = ROOT_DIR / "demo" / "videos"
DEFAULT_BACKEND_STATE_DIR = ROOT_DIR / "backend" / "state"
DEFAULT_BACKEND_RUNTIME_DIR = DEFAULT_BACKEND_STATE_DIR / "runtime"
DEFAULT_BACKEND_DB_PATH = DEFAULT_BACKEND_RUNTIME_DIR / "runtime.sqlite"
DEFAULT_BACKEND_REPLAY_DIR = DEFAULT_BACKEND_RUNTIME_DIR / "replay"
DEFAULT_BACKEND_CANONICAL_DIR = DEFAULT_BACKEND_STATE_DIR / "canonical" / "spatial-configs"
DEFAULT_BACKEND_RECOVERY_DIR = DEFAULT_BACKEND_STATE_DIR / "recovery"
DEFAULT_RUNTIME_SNAPSHOT_RETENTION = 300
DEFAULT_RUNTIME_EVENT_RETENTION = 2000
DEFAULT_RUNTIME_TIMELINE_RETENTION = 1000
DEFAULT_BOOTSTRAP_LAYOUT = "blank"
DEFAULT_CORS_ORIGINS = (
    "http://127.0.0.1:5173",
    "http://localhost:5173",
)


def get_demo_assets_dir() -> Path:
    raw_value = os.environ.get(DEMO_ASSETS_ENV_VAR, "").strip()
    base_dir = Path(raw_value).expanduser() if raw_value else DEFAULT_DEMO_ASSETS_DIR
    return base_dir.resolve()


def _read_positive_int_env(env_var: str, default: int) -> int:
    raw_value = os.environ.get(env_var, "").strip()
    if not raw_value:
        return default
    try:
        return max(int(raw_value), 0)
    except ValueError:
        return default


def get_demo_downloads_dir() -> Path:
    return get_demo_assets_dir() / "downloads"


def get_demo_dataset_dir() -> Path:
    return get_demo_assets_dir() / "acpds"


def get_demo_weights_dir() -> Path:
    return get_demo_assets_dir() / "weights"


def get_demo_weights_path() -> Path:
    return get_demo_weights_dir() / "RCNN_128_square_gopro.pt"


def get_demo_videos_dir() -> Path:
    return DEFAULT_DEMO_VIDEOS_DIR


def get_demo_video_path(camera_id: str) -> Path:
    return get_demo_videos_dir() / f"{camera_id}.mp4"


def to_repo_relative_path(path: Path) -> str:
    resolved = path.expanduser().resolve()
    relative_path = Path(os.path.relpath(resolved, ROOT_DIR))
    return relative_path.as_posix()


def get_backend_runtime_dir() -> Path:
    return get_backend_state_dir() / "runtime"


def get_backend_state_dir() -> Path:
    raw_value = os.environ.get(STATE_DIR_ENV_VAR, "").strip()
    base_dir = Path(raw_value).expanduser() if raw_value else DEFAULT_BACKEND_STATE_DIR
    return base_dir.resolve()


def get_backend_canonical_spatial_configs_dir() -> Path:
    return get_backend_state_dir() / "canonical" / "spatial-configs"


def get_backend_canonical_manifest_path() -> Path:
    return get_backend_canonical_spatial_configs_dir() / "manifest.json"


def get_backend_db_path() -> Path:
    return get_backend_runtime_dir() / "runtime.sqlite"


def get_backend_replay_dir() -> Path:
    return get_backend_runtime_dir() / "replay"


def get_backend_recovery_dir() -> Path:
    return get_backend_state_dir() / "recovery"


def get_bootstrap_layout() -> str:
    raw_value = os.environ.get(BOOTSTRAP_LAYOUT_ENV_VAR, "").strip().lower()
    if raw_value in {"legacy", "blank"}:
        return raw_value
    return DEFAULT_BOOTSTRAP_LAYOUT


def get_cors_origins() -> list[str]:
    raw_value = os.environ.get(BACKEND_CORS_ORIGINS_ENV_VAR, "").strip()
    if not raw_value:
        return list(DEFAULT_CORS_ORIGINS)
    if raw_value == "*":
        return ["*"]
    origins = [origin.strip() for origin in raw_value.split(",") if origin.strip()]
    if not origins:
        return list(DEFAULT_CORS_ORIGINS)
    return list(dict.fromkeys(origins))


def get_cors_allow_credentials(origins: list[str]) -> bool:
    return "*" not in origins


def get_runtime_snapshot_retention() -> int:
    return _read_positive_int_env(RUNTIME_SNAPSHOT_RETENTION_ENV_VAR, DEFAULT_RUNTIME_SNAPSHOT_RETENTION)


def get_runtime_event_retention() -> int:
    return _read_positive_int_env(RUNTIME_EVENT_RETENTION_ENV_VAR, DEFAULT_RUNTIME_EVENT_RETENTION)


def get_runtime_timeline_retention() -> int:
    return _read_positive_int_env(RUNTIME_TIMELINE_RETENTION_ENV_VAR, DEFAULT_RUNTIME_TIMELINE_RETENTION)
