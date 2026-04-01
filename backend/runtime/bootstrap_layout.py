from __future__ import annotations

from ..models import LayoutPartitionDefinition, LotCameraDefinition, LotDefinition, LotFrameDefinition, LotLevelDefinition
from .spatial_config import iso_now


DEFAULT_BOOTSTRAP_CAMERA_ID = "CAM-01"
DEFAULT_BOOTSTRAP_LEVEL_ID = "PLANE-01"
DEFAULT_BOOTSTRAP_TIME_ZONE = "Europe/Rome"


def build_blank_lot_definition(
    *,
    template: LotDefinition | None = None,
    camera_ids: list[str] | None = None,
) -> LotDefinition:
    level = LotLevelDefinition(
        id=DEFAULT_BOOTSTRAP_LEVEL_ID,
        name="Plane 01",
        index=0,
        gridRows=1,
        gridColumns=4,
    )
    known_templates: dict[str, LotCameraDefinition] = {}
    if template is not None:
        for camera in [*template.cameras, template.camera]:
            known_templates[camera.id] = camera
    ordered_camera_ids = _resolve_camera_ids(template=template, camera_ids=camera_ids)
    cameras = [
        _build_camera_definition(camera_id, template=known_templates.get(camera_id), level_id=level.id)
        for camera_id in ordered_camera_ids
    ]
    frames = [
        LotFrameDefinition(
            id=f"{camera.id}-frame-01",
            cameraId=camera.id,
            label="Capture 1",
            imagePath=None,
            capturedAt=iso_now(),
            width=1280,
            height=720,
        )
        for camera in cameras
    ]
    partition = LayoutPartitionDefinition(
        id=f"{level.id}-PART-01",
        name="Zone 01",
        levelId=level.id,
        order=0,
        gridRows=1,
        gridColumns=4,
        ownerCameraIds=[],
        layoutPolygon=None,
    )
    primary_camera = cameras[0]

    return LotDefinition(
        facilityId=template.facilityId if template is not None else "facility",
        facilityName=template.facilityName if template is not None else "Parking Control",
        timeZone=template.timeZone if template is not None else DEFAULT_BOOTSTRAP_TIME_ZONE,
        levelId=level.id,
        levelName=level.name,
        levels=[level],
        sourceLotKey="bootstrap:blank",
        camera=primary_camera,
        cameras=cameras,
        frames=frames,
        partitions=[partition],
        observationPolygons=[],
        slots=[],
    )


def _resolve_camera_ids(
    *,
    template: LotDefinition | None,
    camera_ids: list[str] | None,
) -> list[str]:
    if camera_ids:
        return list(dict.fromkeys(camera_ids))

    template_camera_ids = []
    if template is not None:
        template_camera_ids = list(dict.fromkeys([*(camera.id for camera in template.cameras), template.camera.id]))
    if template_camera_ids:
        return template_camera_ids
    return [DEFAULT_BOOTSTRAP_CAMERA_ID]


def _build_camera_definition(
    camera_id: str,
    *,
    template: LotCameraDefinition | None,
    level_id: str,
) -> LotCameraDefinition:
    return LotCameraDefinition(
        id=camera_id,
        name=template.name if template is not None else camera_id,
        levelId=level_id,
        location=template.location if template is not None else "Unassigned view",
        angle=template.angle if template is not None else "fixed view",
    )
