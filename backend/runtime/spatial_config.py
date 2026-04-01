from __future__ import annotations

from collections import defaultdict
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from ..models import (
    CameraObservationPolygon,
    LayoutPartitionDefinition,
    LotCameraDefinition,
    LotDefinition,
    LotFrameDefinition,
    LotLevelDefinition,
    LotSlotDefinition,
    SpatialBayDefinition,
    SpatialConfig,
    SpatialLineDefinition,
    SpatialZoneDefinition,
)


GLOBAL_CONFIG_SCOPE = "__global__"


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def hash_string(value: str) -> int:
    hash_value = 0
    for char in value:
        hash_value = ((hash_value * 31) + ord(char)) & 0xFFFFFFFF
    return hash_value


def polygon_bounds(points: list[tuple[float, float]]) -> tuple[float, float, float, float]:
    xs = [float(point[0]) for point in points]
    ys = [float(point[1]) for point in points]
    return min(xs), min(ys), max(xs), max(ys)


def polygon_center(points: list[tuple[float, float]]) -> tuple[float, float]:
    x1, y1, x2, y2 = polygon_bounds(points)
    return (x1 + x2) / 2, (y1 + y2) / 2


def point_in_polygon(point: tuple[float, float], polygon: list[tuple[float, float]]) -> bool:
    x, y = point
    inside = False
    vertices = polygon[:]
    if not vertices:
        return False

    previous_x, previous_y = vertices[-1]
    for current_x, current_y in vertices:
        intersects = ((current_y > y) != (previous_y > y)) and (
            x < (previous_x - current_x) * (y - current_y) / ((previous_y - current_y) or 1e-12) + current_x
        )
        if intersects:
            inside = not inside
        previous_x, previous_y = current_x, current_y
    return inside


def make_rectangle(center_x: float, center_y: float, width: float, height: float) -> list[tuple[float, float]]:
    half_width = width / 2
    half_height = height / 2
    return [
        (round(center_x - half_width, 4), round(center_y - half_height, 4)),
        (round(center_x + half_width, 4), round(center_y - half_height, 4)),
        (round(center_x + half_width, 4), round(center_y + half_height, 4)),
        (round(center_x - half_width, 4), round(center_y + half_height, 4)),
    ]


def make_zone_polygon_from_bays(bays: list[SpatialBayDefinition]) -> list[tuple[float, float]]:
    if not bays:
        return make_rectangle(0.5, 0.5, 0.6, 0.6)

    x_values: list[float] = []
    y_values: list[float] = []
    for bay in bays:
        x1, y1, x2, y2 = polygon_bounds(bay.layoutPolygon)
        x_values.extend([x1, x2])
        y_values.extend([y1, y2])
    x1 = max(min(x_values) - 0.04, 0.0)
    y1 = max(min(y_values) - 0.04, 0.0)
    x2 = min(max(x_values) + 0.04, 1.0)
    y2 = min(max(y_values) + 0.04, 1.0)
    return [
        (round(x1, 4), round(y1, 4)),
        (round(x2, 4), round(y1, 4)),
        (round(x2, 4), round(y2, 4)),
        (round(x1, 4), round(y2, 4)),
    ]


def default_lines(camera_id: str) -> list[SpatialLineDefinition]:
    return [
        SpatialLineDefinition(
            id=f"{camera_id}-entry",
            label="Entry line",
            cameraId=camera_id,
            kind="entry",
            points=[(0.08, 0.1), (0.92, 0.1)],
            layoutPoints=[(0.08, 0.1), (0.92, 0.1)],
            direction="entry",
            enabled=True,
        ),
        SpatialLineDefinition(
            id=f"{camera_id}-exit",
            label="Exit line",
            cameraId=camera_id,
            kind="exit",
            points=[(0.08, 0.9), (0.92, 0.9)],
            layoutPoints=[(0.08, 0.9), (0.92, 0.9)],
            direction="exit",
            enabled=True,
        ),
    ]


def default_observation_polygons(
    camera_id: str,
    preset_version: int,
    bays: list[SpatialBayDefinition],
) -> list[CameraObservationPolygon]:
    return [
        CameraObservationPolygon(
            id=f"{camera_id}-{bay.id}-overlay",
            cameraId=camera_id,
            presetVersion=preset_version,
            canonicalBayId=bay.id,
            imagePolygon=list(bay.imagePolygon),
            enabled=True,
            priority=bay.row * 100 + bay.column,
            notes="default overlay binding",
        )
        for bay in bays
    ]


def default_partitions(lot: LotDefinition) -> list[LayoutPartitionDefinition]:
    if lot.partitions:
        return lot.partitions
    return [
        LayoutPartitionDefinition(
            id=level.id,
            name=level.name,
            levelId=level.id,
            order=index,
            gridRows=level.gridRows,
            gridColumns=level.gridColumns,
            ownerCameraIds=[],
            layoutPolygon=None,
        )
        for index, level in enumerate(lot.levels)
    ]


def get_lot_cameras(lot: LotDefinition) -> list[LotCameraDefinition]:
    if lot.cameras:
        return lot.cameras
    return [lot.camera]


def legacy_lot_to_spatial_config(lot: LotDefinition) -> SpatialConfig:
    cameras = get_lot_cameras(lot)
    partitions = default_partitions(lot)
    partition_by_id = {partition.id: partition for partition in partitions}
    zone_membership: dict[str, list[LotSlotDefinition]] = defaultdict(list)
    bays: list[SpatialBayDefinition] = []
    primary_camera_id = lot.camera.id if cameras else "CAM-01"

    for slot in lot.slots:
        source_camera_ids = sorted(
            {
                *(slot.ownerCameraIds or []),
                *([slot.cameraId] if slot.cameraId else []),
            }
        )
        if not source_camera_ids:
            source_camera_ids = [primary_camera_id]
        zone_id = slot.zoneId or slot.partitionId or slot.levelId
        zone_membership[zone_id].append(slot)
        bays.append(
            SpatialBayDefinition(
                id=slot.id,
                label=slot.label,
                row=slot.row,
                column=slot.column,
                levelId=slot.levelId,
                partitionId=slot.partitionId or slot.levelId,
                cameraId=slot.cameraId or source_camera_ids[0],
                sourceCameraIds=source_camera_ids,
                zoneId=zone_id,
                imagePolygon=list(slot.imagePolygon),
                layoutPolygon=list(slot.layoutPolygon),
                evCapable=slot.evCapable,
                reservedDefault=slot.reservedDefault,
            )
        )

    zones: list[SpatialZoneDefinition] = []
    for zone_id, zone_slots in zone_membership.items():
        level_id = zone_slots[0].levelId
        partition = partition_by_id.get(zone_slots[0].partitionId or "")
        bays_for_zone = [bay for bay in bays if bay.id in {slot.id for slot in zone_slots}]
        polygon = make_zone_polygon_from_bays(bays_for_zone)
        zones.append(
            SpatialZoneDefinition(
                id=zone_id,
                label=partition.name if partition is not None else zone_id,
                levelId=level_id,
                imagePolygon=polygon,
                layoutPolygon=polygon,
                bayIds=[slot.id for slot in zone_slots],
            )
        )

    observation_polygons = list(lot.observationPolygons)
    if not observation_polygons:
        for bay in bays:
            for camera_id in bay.sourceCameraIds or [bay.cameraId or primary_camera_id]:
                observation_polygons.extend(default_observation_polygons(camera_id, 1, [bay]))

    lines: list[SpatialLineDefinition] = []
    for camera in cameras:
        lines.extend(default_lines(camera.id))

    frame_width = lot.frames[0].width if lot.frames else 1280
    frame_height = lot.frames[0].height if lot.frames else 720
    primary_camera = next((camera for camera in cameras if camera.id == primary_camera_id), cameras[0])

    return normalize_spatial_config(
        SpatialConfig(
            facilityId=lot.facilityId,
            facilityName=lot.facilityName,
            timeZone=lot.timeZone,
            cameraId=primary_camera.id,
            frameWidth=frame_width,
            frameHeight=frame_height,
            sourceLotKey=lot.sourceLotKey,
            version=1,
            status="active",
            createdAt=iso_now(),
            updatedAt=iso_now(),
            activatedAt=iso_now(),
            levels=lot.levels,
            camera=primary_camera,
            cameras=cameras,
            frames=lot.frames,
            partitions=partitions,
            observationPolygons=observation_polygons,
            bays=bays,
            zones=zones,
            lines=lines,
        )
    )


def legacy_lot_to_spatial_configs(lot: LotDefinition) -> list[SpatialConfig]:
    return [legacy_lot_to_spatial_config(lot)]


def spatial_config_to_legacy_lot(config: SpatialConfig) -> LotDefinition:
    normalized = normalize_spatial_config(config)
    levels = _normalized_levels(normalized)
    cameras = normalized.cameras or [normalized.camera]
    primary_camera_id = normalized.cameraId or cameras[0].id
    primary_camera = next((camera for camera in cameras if camera.id == primary_camera_id), cameras[0])
    known_camera_ids = {camera.id for camera in cameras}

    overlays_by_bay: dict[str, list[CameraObservationPolygon]] = defaultdict(list)
    for polygon in normalized.observationPolygons:
        if polygon.enabled:
            overlays_by_bay[polygon.canonicalBayId].append(polygon)

    slots: list[LotSlotDefinition] = []
    for bay in normalized.bays:
        bay_overlays = sorted(
            overlays_by_bay.get(bay.id, []),
            key=lambda polygon: (polygon.cameraId, polygon.priority or 0, polygon.id),
        )
        owner_camera_ids = sorted(
            {
                *(bay.sourceCameraIds or []),
                *(polygon.cameraId for polygon in bay_overlays),
                *([bay.cameraId] if bay.cameraId else []),
            }
        )
        canonical_owner_camera_ids = [camera_id for camera_id in owner_camera_ids if camera_id in known_camera_ids]
        slot_camera_id = (
            bay.cameraId
            if bay.cameraId and bay.cameraId in known_camera_ids
            else next((polygon.cameraId for polygon in bay_overlays if polygon.cameraId in known_camera_ids), None)
            or (canonical_owner_camera_ids[0] if canonical_owner_camera_ids else primary_camera_id)
        )
        overlay = next((polygon for polygon in bay_overlays if polygon.cameraId == slot_camera_id), None)
        if overlay is None and bay_overlays:
            overlay = next((polygon for polygon in bay_overlays if polygon.cameraId in known_camera_ids), bay_overlays[0])
        slots.append(
            LotSlotDefinition(
                id=bay.id,
                label=bay.label,
                row=bay.row,
                column=bay.column,
                levelId=bay.levelId,
                partitionId=bay.partitionId,
                cameraId=slot_camera_id,
                imagePolygon=list(overlay.imagePolygon if overlay is not None else bay.imagePolygon),
                layoutPolygon=list(bay.layoutPolygon),
                evCapable=bay.evCapable,
                zoneId=bay.zoneId,
                ownerCameraIds=canonical_owner_camera_ids or [slot_camera_id],
                reservedDefault=bay.reservedDefault,
            )
        )

    frames = list(normalized.frames)
    if not frames:
        frames = [
            LotFrameDefinition(
                id=f"{camera.id}-frame-01",
                cameraId=camera.id,
                label="Capture 1",
                imagePath=None,
                capturedAt=iso_now(),
                width=normalized.frameWidth,
                height=normalized.frameHeight,
            )
            for camera in cameras
        ]

    return LotDefinition(
        facilityId=normalized.facilityId,
        facilityName=normalized.facilityName,
        timeZone=normalized.timeZone,
        levelId=primary_camera.levelId if any(level.id == primary_camera.levelId for level in levels) else levels[0].id,
        levelName=next(
            (level.name for level in levels if level.id == primary_camera.levelId),
            levels[0].name,
        ),
        levels=levels,
        sourceLotKey=normalized.sourceLotKey,
        camera=primary_camera,
        cameras=cameras,
        frames=frames,
        partitions=normalized.partitions,
        observationPolygons=normalized.observationPolygons,
        slots=slots,
    )


def migrate_spatial_config_payload(payload: dict[str, Any]) -> dict[str, Any]:
    data = deepcopy(payload)
    data["facilityId"] = data.get("facilityId") or "facility"
    data["facilityName"] = data.get("facilityName") or "Parking Control"
    data["timeZone"] = data.get("timeZone") or "Europe/Rome"
    data["sourceLotKey"] = data.get("sourceLotKey") or "global:matrix"
    data["version"] = int(data.get("version") or 1)
    data["status"] = data.get("status") or "draft"
    data["createdAt"] = data.get("createdAt") or iso_now()
    data["updatedAt"] = data.get("updatedAt") or data["createdAt"]

    levels = [dict(level) for level in data.get("levels") or []]
    if not levels:
        levels = [{"id": "PLANE-01", "name": "Plane 01", "index": 0, "gridRows": 1, "gridColumns": 4}]

    primary_camera_payload = dict(data.get("camera") or {})
    initial_camera_id = str(
        data.get("cameraId")
        or primary_camera_payload.get("id")
        or next(
            (
                item.get("cameraId")
                for item in [*(data.get("frames") or []), *(data.get("observationPolygons") or []), *(data.get("lines") or [])]
                if isinstance(item, dict) and item.get("cameraId")
            ),
            "CAM-01",
        )
    )

    raw_cameras = [dict(camera) for camera in data.get("cameras") or []]
    if primary_camera_payload and not any(camera.get("id") == initial_camera_id for camera in raw_cameras):
        raw_cameras.insert(0, primary_camera_payload)
    camera_ids_from_payload = {
        *(camera.get("id") for camera in raw_cameras if camera.get("id")),
        *(frame.get("cameraId") for frame in data.get("frames") or [] if frame.get("cameraId")),
        *(polygon.get("cameraId") for polygon in data.get("observationPolygons") or [] if polygon.get("cameraId")),
        *(line.get("cameraId") for line in data.get("lines") or [] if line.get("cameraId")),
    }
    if not camera_ids_from_payload:
        camera_ids_from_payload = {initial_camera_id}

    cameras: list[dict[str, Any]] = []
    for index, camera_id in enumerate(sorted(camera_ids_from_payload)):
        template = next((camera for camera in raw_cameras if camera.get("id") == camera_id), {})
        cameras.append(
            {
                "id": camera_id,
                "name": template.get("name") or camera_id,
                "levelId": template.get("levelId") or levels[min(index, len(levels) - 1)]["id"],
                "location": template.get("location") or f"Camera {camera_id}",
                "angle": template.get("angle") or "front",
            }
        )

    primary_camera_id = initial_camera_id if any(camera["id"] == initial_camera_id for camera in cameras) else cameras[0]["id"]
    primary_camera = next(camera for camera in cameras if camera["id"] == primary_camera_id)

    partitions = [dict(partition) for partition in data.get("partitions") or []]
    if not partitions:
        partitions = [
            {
                "id": level["id"],
                "name": level["name"],
                "levelId": level["id"],
                "order": int(level.get("index", index)),
                "gridRows": max(int(level.get("gridRows", 1) or 1), 1),
                "gridColumns": max(int(level.get("gridColumns", 1) or 1), 1),
                "ownerCameraIds": [],
                "layoutPolygon": None,
            }
            for index, level in enumerate(levels)
        ]

    partition_ids = {partition["id"] for partition in partitions}
    default_partition_by_level = {partition["levelId"]: partition["id"] for partition in partitions}

    bays = [dict(bay) for bay in data.get("bays") or []]
    for bay in bays:
        level_id = bay.get("levelId") or levels[0]["id"]
        bay["levelId"] = level_id
        bay["partitionId"] = bay.get("partitionId") or default_partition_by_level.get(level_id) or level_id
        bay["zoneId"] = bay.get("zoneId") or bay["partitionId"]
        bay["sourceCameraIds"] = sorted(
            {
                *(bay.get("sourceCameraIds") or []),
                *([bay.get("cameraId")] if bay.get("cameraId") else []),
            }
        )
        if bay["partitionId"] not in partition_ids:
            partitions.append(
                {
                    "id": bay["partitionId"],
                    "name": bay["zoneId"],
                    "levelId": level_id,
                    "order": 0,
                    "gridRows": 1,
                    "gridColumns": 1,
                    "ownerCameraIds": [],
                    "layoutPolygon": list(bay.get("layoutPolygon") or []),
                }
            )
            partition_ids.add(bay["partitionId"])

    observation_polygons = [dict(polygon) for polygon in data.get("observationPolygons") or []]
    for polygon in observation_polygons:
        polygon["cameraId"] = polygon.get("cameraId") or primary_camera_id
        polygon["presetVersion"] = int(polygon.get("presetVersion") or data["version"])

    # Ensure every bay with an imagePolygon has a corresponding observation polygon.
    # This migrates legacy data where polygons were stored only on the bay.
    # Only create observations for cameras known from this config's payload,
    # to avoid polluting projected (camera-specific) configs with other cameras' data.
    raw_frames = data.get("frames") or []
    frame_camera_ids = {
        frame.get("cameraId") for frame in raw_frames if frame.get("cameraId")
    } or camera_ids_from_payload
    existing_obs_keys = {
        (polygon["cameraId"], polygon["canonicalBayId"])
        for polygon in observation_polygons
    }
    for bay in bays:
        bay_polygon = bay.get("imagePolygon")
        if not bay_polygon or len(bay_polygon) < 4:
            continue
        target_camera_ids = bay.get("sourceCameraIds") or (
            [bay["cameraId"]] if bay.get("cameraId") else [primary_camera_id]
        )
        for camera_id in [cid for cid in target_camera_ids if cid in frame_camera_ids]:
            if (camera_id, bay["id"]) in existing_obs_keys:
                continue
            observation_polygons.append(
                {
                    "id": f"obs-{camera_id}-{bay['id']}",
                    "cameraId": camera_id,
                    "presetVersion": data["version"],
                    "canonicalBayId": bay["id"],
                    "imagePolygon": bay_polygon,
                    "enabled": True,
                    "priority": int(bay.get("row", 0)) * 100 + int(bay.get("column", 0)),
                    "notes": None,
                }
            )
            existing_obs_keys.add((camera_id, bay["id"]))

    raw_zones = data.get("zones")
    zones = [dict(zone) for zone in raw_zones or []]
    if raw_zones is None:
        bays_by_zone: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for bay in bays:
            bays_by_zone[bay["zoneId"]].append(bay)
        zones = []
        for zone_id, zone_bays in bays_by_zone.items():
            level_id = zone_bays[0]["levelId"]
            partition = next((partition for partition in partitions if partition["id"] == zone_bays[0]["partitionId"]), None)
            bay_models = [
                SpatialBayDefinition.model_validate(
                    {
                        **bay,
                        "cameraId": bay.get("cameraId"),
                        "sourceCameraIds": bay.get("sourceCameraIds") or [],
                    }
                )
                for bay in zone_bays
            ]
            polygon = make_zone_polygon_from_bays(bay_models)
            zones.append(
                {
                    "id": zone_id,
                    "label": partition.get("name") if partition else zone_id,
                    "levelId": level_id,
                    "imagePolygon": polygon,
                    "layoutPolygon": polygon,
                    "bayIds": [bay["id"] for bay in zone_bays],
                }
            )
    elif zones:
        zone_ids = {zone["id"] for zone in zones}
        fallback_zone_id = zones[0]["id"] if zones else partitions[0]["id"]
        for bay in bays:
            if bay["zoneId"] not in zone_ids:
                bay["zoneId"] = fallback_zone_id
            for zone in zones:
                if zone["id"] == bay["zoneId"] and bay["id"] not in (zone.get("bayIds") or []):
                    zone.setdefault("bayIds", []).append(bay["id"])

    frames = [dict(frame) for frame in data.get("frames") or []]
    for frame in frames:
        frame["cameraId"] = frame.get("cameraId") or primary_camera_id

    lines = [dict(line) for line in data.get("lines") or []]
    if not lines:
        for camera in cameras:
            lines.extend([line.model_dump() for line in default_lines(camera["id"])])
    else:
        for line in lines:
            line["cameraId"] = line.get("cameraId") or primary_camera_id

    for partition in partitions:
        partition["ownerCameraIds"] = sorted(set(partition.get("ownerCameraIds") or []))
        partition["gridRows"] = max(int(partition.get("gridRows", 1) or 1), 1)
        partition["gridColumns"] = max(int(partition.get("gridColumns", 1) or 1), 1)

    data["cameraId"] = primary_camera_id
    data["camera"] = primary_camera
    data["cameras"] = cameras
    data["levels"] = levels
    data["partitions"] = partitions
    data["bays"] = bays
    data["zones"] = zones
    data["observationPolygons"] = observation_polygons
    data["frames"] = frames
    data["lines"] = lines
    return data


def normalize_spatial_config(config: SpatialConfig, camera_id: str | None = None) -> SpatialConfig:
    migrated = migrate_spatial_config_payload(config.model_dump())
    if camera_id:
        migrated["cameraId"] = camera_id
        selected_camera = next(
            (camera for camera in migrated["cameras"] if camera.get("id") == camera_id),
            None,
        )
        if selected_camera is not None:
            migrated["camera"] = selected_camera
        else:
            migrated["camera"] = {
                **migrated["camera"],
                "id": camera_id,
            }
    return SpatialConfig.model_validate(migrated)


def merge_camera_config_into_global(
    incoming: SpatialConfig,
    camera_id: str,
    existing_global: SpatialConfig,
) -> SpatialConfig:
    """Merge a camera-specific save into the existing global config.

    The incoming config may only contain observation polygons, lines, and
    frames for *camera_id*.  We preserve data from other cameras that exists
    in *existing_global* so that saving from one camera never destroys
    another camera's configuration.
    """

    # --- Observation polygons: incoming replaces camera_id's, keep others ---
    incoming_obs_ids = {obs.id for obs in incoming.observationPolygons}
    other_observations = [
        obs for obs in existing_global.observationPolygons
        if obs.cameraId != camera_id and obs.id not in incoming_obs_ids
    ]
    merged_observations = other_observations + list(incoming.observationPolygons)

    # --- Lines: incoming replaces camera_id's, keep others ---
    incoming_line_ids = {line.id for line in incoming.lines}
    other_lines = [
        line for line in existing_global.lines
        if line.cameraId != camera_id and line.id not in incoming_line_ids
    ]
    merged_lines = other_lines + list(incoming.lines)

    # --- Frames: incoming replaces camera_id's, keep others ---
    incoming_frame_ids = {frame.id for frame in incoming.frames}
    other_frames = [
        frame for frame in existing_global.frames
        if frame.cameraId != camera_id and frame.id not in incoming_frame_ids
    ]
    merged_frames = other_frames + list(incoming.frames)

    # --- Cameras: merge by id (incoming takes precedence) ---
    cameras_by_id = {cam.id: cam for cam in existing_global.cameras}
    for cam in incoming.cameras:
        cameras_by_id[cam.id] = cam
    merged_cameras = list(cameras_by_id.values())

    # --- Bays: incoming has the full matrix state from the editor.
    # But bays visible only via other cameras may be absent from incoming.
    # Preserve those and ensure sourceCameraIds includes all cameras that
    # have observation polygons for each bay. ---
    obs_cameras_by_bay: dict[str, set[str]] = {}
    for obs in merged_observations:
        obs_cameras_by_bay.setdefault(obs.canonicalBayId, set()).add(obs.cameraId)

    existing_bays_by_id = {bay.id: bay for bay in existing_global.bays}
    incoming_bay_ids = {bay.id for bay in incoming.bays}

    merged_bays: list[SpatialBayDefinition] = []
    for bay in incoming.bays:
        existing = existing_bays_by_id.get(bay.id)
        all_source_ids = set(bay.sourceCameraIds or [])
        if existing:
            all_source_ids.update(existing.sourceCameraIds or [])
        all_source_ids.update(obs_cameras_by_bay.get(bay.id, set()))
        merged_bays.append(bay.model_copy(update={"sourceCameraIds": sorted(all_source_ids)}))

    for bay in existing_global.bays:
        if bay.id not in incoming_bay_ids and bay.id in obs_cameras_by_bay:
            all_source_ids = set(bay.sourceCameraIds or [])
            all_source_ids.update(obs_cameras_by_bay[bay.id])
            merged_bays.append(bay.model_copy(update={"sourceCameraIds": sorted(all_source_ids)}))

    # --- Levels, partitions, zones: incoming is authoritative for the
    # unified matrix.  Preserve existing entries not in incoming so that
    # data owned by other cameras is not lost. ---
    incoming_level_ids = {level.id for level in incoming.levels}
    merged_levels = list(incoming.levels) + [
        level for level in existing_global.levels
        if level.id not in incoming_level_ids
    ]

    incoming_partition_ids = {part.id for part in incoming.partitions}
    merged_partitions = list(incoming.partitions) + [
        part for part in existing_global.partitions
        if part.id not in incoming_partition_ids
    ]

    incoming_zone_ids = {zone.id for zone in incoming.zones}
    merged_zones = list(incoming.zones) + [
        zone for zone in existing_global.zones
        if zone.id not in incoming_zone_ids
    ]

    return incoming.model_copy(update={
        "bays": merged_bays,
        "observationPolygons": merged_observations,
        "lines": merged_lines,
        "frames": merged_frames,
        "cameras": merged_cameras,
        "zones": merged_zones,
        "levels": merged_levels,
        "partitions": merged_partitions,
    })


def project_config_to_camera(config: SpatialConfig, camera_id: str) -> SpatialConfig:
    normalized = normalize_spatial_config(config)
    selected_camera = next((camera for camera in normalized.cameras if camera.id == camera_id), None)
    if selected_camera is None:
        selected_camera = normalized.camera.model_copy(update={"id": camera_id, "name": camera_id})
    else:
        selected_camera = selected_camera.model_copy(update={"id": camera_id})
    camera_frames = [frame for frame in normalized.frames if frame.cameraId == camera_id]
    if not camera_frames and normalized.frames:
        camera_frames = [
            frame.model_copy(update={"cameraId": camera_id})
            for frame in normalized.frames[:1]
        ]
    frame_width = camera_frames[0].width if camera_frames else normalized.frameWidth
    frame_height = camera_frames[0].height if camera_frames else normalized.frameHeight
    camera_lines = [line for line in normalized.lines if line.cameraId == camera_id]
    if not camera_lines:
        camera_lines = default_lines(camera_id)

    camera_bays = [
        bay for bay in normalized.bays
        if camera_id in (bay.sourceCameraIds or []) or bay.cameraId == camera_id
    ]
    camera_bay_ids = {bay.id for bay in camera_bays}
    camera_zones = [
        zone for zone in normalized.zones
        if any(bid in camera_bay_ids for bid in (zone.bayIds or []))
    ]

    camera_counting_lines = [
        cl for cl in normalized.countingLines
        if cl.cameraId == camera_id
    ]
    # Auto-generate countingLines from spatial lines when none are defined
    if not camera_counting_lines and camera_lines:
        from ..models import CountingLineDefinition
        camera_counting_lines = [
            CountingLineDefinition(
                id=f"cnt-{line.id}",
                label=line.label,
                cameraId=camera_id,
                kind=line.kind,
                points=list(line.points),
                layoutPoints=list(line.layoutPoints) if line.layoutPoints else None,
                direction=line.direction,
                enabled=line.enabled,
                associationType="facility",
                associationId=None,
            )
            for line in camera_lines
            if line.enabled
        ]
    camera_density_zones = [
        dz for dz in normalized.densityZones
        if dz.cameraId == camera_id
    ]
    camera_alert_rules = normalized.countingAlertRules

    return normalized.model_copy(
        update={
            "cameraId": camera_id,
            "camera": selected_camera,
            "frameWidth": frame_width,
            "frameHeight": frame_height,
            "frames": camera_frames,
            "bays": camera_bays,
            "zones": camera_zones,
            "observationPolygons": [
                polygon
                for polygon in normalized.observationPolygons
                if polygon.cameraId == camera_id
            ],
            "lines": camera_lines,
            "countingLines": camera_counting_lines,
            "densityZones": camera_density_zones,
            "countingAlertRules": camera_alert_rules,
        }
    )


def _normalized_levels(config: SpatialConfig) -> list[LotLevelDefinition]:
    if config.levels:
        return sorted(config.levels, key=lambda level: (level.index, level.id))

    levels_by_id: dict[str, LotLevelDefinition] = {}
    for index, partition in enumerate(config.partitions or []):
        levels_by_id.setdefault(
            partition.levelId,
            LotLevelDefinition(
                id=partition.levelId,
                name=partition.name,
                index=index,
                gridRows=max(partition.gridRows, 1),
                gridColumns=max(partition.gridColumns, 1),
            ),
        )
    if levels_by_id:
        return sorted(levels_by_id.values(), key=lambda level: (level.index, level.id))
    return [
        LotLevelDefinition(
            id="PLANE-01",
            name="Plane 01",
            index=0,
            gridRows=1,
            gridColumns=max(len(config.bays), 1),
        )
    ]
