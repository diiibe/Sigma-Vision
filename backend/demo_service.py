from __future__ import annotations

from pathlib import Path
from typing import Literal

from .demo_paths import ROOT_DIR
from .models import LotDefinition, SpatialConfig
from .runtime.service import ParkingBackendService
from .runtime.spatial_config import spatial_config_to_legacy_lot


LOT_DEFINITION_PATH = ROOT_DIR / "demo" / "lot-definition.json"


class DemoService(ParkingBackendService):
    def __init__(
        self,
        lot_path: Path = LOT_DEFINITION_PATH,
        db_path: Path | None = None,
        *,
        state_dir: Path | None = None,
        config_root: Path | None = None,
        recovery_dir: Path | None = None,
        videos_dir: Path | None = None,
        enable_scheduler: bool = False,
        bootstrap_layout: Literal["legacy", "blank"] = "legacy",
    ):
        super().__init__(
            lot_path=lot_path,
            db_path=db_path,
            state_dir=state_dir,
            config_root=config_root,
            recovery_dir=recovery_dir,
            videos_dir=videos_dir,
            enable_scheduler=enable_scheduler,
            bootstrap_layout=bootstrap_layout,
        )

    @property
    def backend(self) -> ParkingBackendService:
        return self

    def seed_from_config(self, config: SpatialConfig) -> LotDefinition:
        return spatial_config_to_legacy_lot(config)
