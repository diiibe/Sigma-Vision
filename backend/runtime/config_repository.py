from __future__ import annotations

import json
import logging
import tempfile
import threading
from pathlib import Path

from pydantic import BaseModel, Field

from ..models import SpatialConfig, SpatialConfigVersionSummary
from .spatial_config import iso_now, migrate_spatial_config_payload, normalize_spatial_config

logger = logging.getLogger(__name__)


class _SpatialConfigManifest(BaseModel):
    activeVersion: int | None = None
    latestVersion: int = 0
    versions: list[SpatialConfigVersionSummary] = Field(default_factory=list)


class SpatialConfigFileRepository:
    def __init__(self, root_dir: Path):
        self.root_dir = root_dir
        self.versions_dir = self.root_dir / "versions"
        self.manifest_path = self.root_dir / "manifest.json"
        self._lock = threading.RLock()
        self.root_dir.mkdir(parents=True, exist_ok=True)
        self.versions_dir.mkdir(parents=True, exist_ok=True)

    def list_versions(self, camera_id: str) -> list[SpatialConfig]:
        manifest = self._load_manifest()
        versions: list[SpatialConfig] = []
        for summary in sorted(manifest.versions, key=lambda entry: entry.version):
            config = self._read_version(summary.version)
            if config is None:
                continue
            versions.append(self._apply_summary_metadata(config, summary))
        return versions

    def get_version(self, camera_id: str, version: int) -> SpatialConfig | None:
        manifest = self._load_manifest()
        summary = next((entry for entry in manifest.versions if entry.version == version), None)
        config = self._read_version(version)
        if config is None:
            return None
        if summary is None:
            return config
        return self._apply_summary_metadata(config, summary)

    def get_active_config(self, camera_id: str) -> SpatialConfig | None:
        manifest = self._load_manifest()
        if manifest.activeVersion is None:
            return None
        return self.get_version(camera_id, manifest.activeVersion)

    def get_latest_non_archived_config(self, camera_id: str) -> SpatialConfig | None:
        manifest = self._load_manifest()
        candidates = [entry for entry in manifest.versions if entry.status != "archived"]
        if not candidates:
            return None
        selected = sorted(
            candidates,
            key=lambda entry: (0 if entry.status == "active" else 1, -entry.version),
        )[0]
        return self.get_version(camera_id, selected.version)

    def get_latest_config(self, camera_id: str) -> SpatialConfig | None:
        """Return the config with the highest version number, regardless of status."""
        manifest = self._load_manifest()
        if manifest.latestVersion < 1:
            return None
        return self.get_version(camera_id, manifest.latestVersion)

    def next_config_version(self, camera_id: str) -> int:
        manifest = self._load_manifest()
        if manifest.latestVersion > 0:
            return manifest.latestVersion + 1
        versions = [entry.version for entry in manifest.versions]
        return (max(versions) + 1) if versions else 1

    def upsert_config(self, config: SpatialConfig) -> SpatialConfig:
        normalized = normalize_spatial_config(config)
        with self._lock:
            manifest = self._load_manifest()
            summary = self._summary_from_config(normalized)
            replaced = False
            updated_versions: list[SpatialConfigVersionSummary] = []
            for entry in manifest.versions:
                if entry.version == normalized.version:
                    updated_versions.append(summary)
                    replaced = True
                else:
                    updated_versions.append(entry)
            if not replaced:
                updated_versions.append(summary)
            manifest = manifest.model_copy(
                update={
                    "versions": sorted(updated_versions, key=lambda entry: entry.version),
                    "latestVersion": max(manifest.latestVersion, normalized.version),
                    "activeVersion": (
                        normalized.version
                        if manifest.activeVersion is None and normalized.status == "active"
                        else manifest.activeVersion
                    ),
                }
            )
            self._write_version(normalized)
            self._write_manifest(manifest)
            logger.info(
                "upsert_config v=%d status=%s bays=%d obs=%d cameras=%s",
                normalized.version,
                normalized.status,
                len(normalized.bays),
                len(normalized.observationPolygons),
                [c.id for c in normalized.cameras],
            )
        return normalized

    def activate_config(self, camera_id: str, version: int) -> SpatialConfig:
        with self._lock:
            manifest = self._load_manifest()
            target = self._read_version(version)
            if target is None:
                raise KeyError(f"Unknown global config version {version}")

            activated_at = iso_now()
            updated_versions: list[SpatialConfigVersionSummary] = []
            for entry in manifest.versions:
                config = self._read_version(entry.version)
                if config is None:
                    continue
                if entry.version == version:
                    config = config.model_copy(
                        update={
                            "status": "active",
                            "updatedAt": activated_at,
                            "activatedAt": activated_at,
                        }
                    )
                    updated_versions.append(self._summary_from_config(config))
                    target = config
                elif entry.status == "active":
                    config = config.model_copy(update={"status": "draft", "updatedAt": activated_at})
                    updated_versions.append(self._summary_from_config(config))
                    self._write_version(config)
                else:
                    updated_versions.append(self._summary_from_config(config))
                if entry.version != version:
                    continue
                self._write_version(config)

            manifest = manifest.model_copy(
                update={
                    "activeVersion": version,
                    "latestVersion": max(manifest.latestVersion, version),
                    "versions": sorted(updated_versions, key=lambda entry: entry.version),
                }
            )
            self._write_version(target)
            self._write_manifest(manifest)
        return target

    def archive_config(self, camera_id: str, version: int) -> SpatialConfig:
        with self._lock:
            manifest = self._load_manifest()
            target = self._read_version(version)
            if target is None:
                raise KeyError(f"Unknown global config version {version}")

            candidates = [
                entry
                for entry in manifest.versions
                if entry.version != version and entry.status != "archived"
            ]
            if not candidates:
                raise ValueError("Cannot archive the last available global preset")

            archived_at = iso_now()
            fallback = sorted(
                candidates,
                key=lambda entry: (0 if entry.status == "active" else 1, -entry.version),
            )[0]
            updated_versions: list[SpatialConfigVersionSummary] = []
            for entry in manifest.versions:
                config = self._read_version(entry.version)
                if config is None:
                    continue
                if entry.version == version:
                    config = config.model_copy(update={"status": "archived", "updatedAt": archived_at})
                    target = config
                elif entry.version == fallback.version:
                    config = config.model_copy(update={"status": "active", "updatedAt": archived_at, "activatedAt": archived_at})
                elif entry.status == "active":
                    config = config.model_copy(update={"status": "draft", "updatedAt": archived_at})
                updated_versions.append(self._summary_from_config(config))
                self._write_version(config)

            manifest = manifest.model_copy(
                update={
                    "activeVersion": fallback.version,
                    "latestVersion": max((entry.version for entry in updated_versions), default=0),
                    "versions": sorted(updated_versions, key=lambda entry: entry.version),
                }
            )
            self._write_manifest(manifest)
        return target

    def list_camera_ids(self) -> list[str]:
        active = self.get_active_config("") or self.get_latest_non_archived_config("")
        if active is None:
            return []
        camera_ids = {
            active.cameraId,
            *(camera.id for camera in active.cameras),
            *(frame.cameraId for frame in active.frames if frame.cameraId),
            *(line.cameraId for line in active.lines),
            *(polygon.cameraId for polygon in active.observationPolygons),
            *(bay.cameraId for bay in active.bays if bay.cameraId),
            *(camera_id for bay in active.bays for camera_id in bay.sourceCameraIds),
        }
        return sorted(camera_ids)

    def has_manifest(self) -> bool:
        return self.manifest_path.exists()

    def _load_manifest(self) -> _SpatialConfigManifest:
        with self._lock:
            if self.manifest_path.exists():
                return _SpatialConfigManifest.model_validate_json(self.manifest_path.read_text(encoding="utf-8"))
            rebuilt = self._rebuild_manifest_from_versions()
            if rebuilt is not None:
                self._write_manifest(rebuilt)
                return rebuilt
        return _SpatialConfigManifest()

    def _rebuild_manifest_from_versions(self) -> _SpatialConfigManifest | None:
        version_paths = sorted(self.versions_dir.glob("*.json"))
        if not version_paths:
            return None
        versions: list[SpatialConfigVersionSummary] = []
        active_version: int | None = None
        latest_version = 0
        for path in version_paths:
            config = self._load_config_json(path.read_text(encoding="utf-8"))
            versions.append(self._summary_from_config(config))
            latest_version = max(latest_version, config.version)
            if config.status == "active":
                active_version = config.version
        return _SpatialConfigManifest(
            activeVersion=active_version,
            latestVersion=latest_version,
            versions=sorted(versions, key=lambda entry: entry.version),
        )

    def _read_version(self, version: int) -> SpatialConfig | None:
        path = self._version_path(version)
        if not path.exists():
            return None
        return self._load_config_json(path.read_text(encoding="utf-8"))

    def _load_config_json(self, raw_json: str) -> SpatialConfig:
        try:
            return normalize_spatial_config(SpatialConfig.model_validate_json(raw_json))
        except Exception:
            payload = json.loads(raw_json)
            migrated_payload = migrate_spatial_config_payload(payload)
            return normalize_spatial_config(SpatialConfig.model_validate(migrated_payload))

    def _write_manifest(self, manifest: _SpatialConfigManifest) -> None:
        self._atomic_write(self.manifest_path, manifest.model_dump_json(indent=2))

    def _write_version(self, config: SpatialConfig) -> None:
        self._atomic_write(self._version_path(config.version), config.model_dump_json(indent=2))

    def _atomic_write(self, target_path: Path, payload: str) -> None:
        target_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=target_path.parent,
            prefix=f".{target_path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            handle.write(payload)
            temp_path = Path(handle.name)
        temp_path.replace(target_path)

    def _summary_from_config(self, config: SpatialConfig) -> SpatialConfigVersionSummary:
        return SpatialConfigVersionSummary(
            cameraId=config.cameraId,
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

    def _apply_summary_metadata(
        self,
        config: SpatialConfig,
        summary: SpatialConfigVersionSummary,
    ) -> SpatialConfig:
        return config.model_copy(
            update={
                "cameraId": summary.cameraId,
                "version": summary.version,
                "status": summary.status,
                "createdAt": summary.createdAt,
                "updatedAt": summary.updatedAt,
                "activatedAt": summary.activatedAt,
                "presetName": summary.presetName,
                "copiedFromCameraId": summary.copiedFromCameraId,
                "copiedFromVersion": summary.copiedFromVersion,
            }
        )

    def _version_path(self, version: int) -> Path:
        return self.versions_dir / f"{version:06d}.json"
