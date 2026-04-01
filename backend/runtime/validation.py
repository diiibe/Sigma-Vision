from __future__ import annotations

from collections import Counter

from ..models import SpatialConfig
from .frame_paths import FrameImagePathError, validate_frame_image_path


class SpatialValidationError(ValueError):
    pass


def validate_spatial_config(config: SpatialConfig) -> None:
    issues: list[str] = []
    bay_ids_seen: Counter[str] = Counter()
    line_ids_seen: Counter[str] = Counter()
    polygon_ids_seen: Counter[str] = Counter()
    partition_ids_seen: Counter[str] = Counter()
    zone_ids_seen: Counter[str] = Counter()
    bay_ids = {bay.id for bay in config.bays}
    partition_ids = {partition.id for partition in config.partitions}
    known_camera_ids = {camera.id for camera in config.cameras} | ({config.camera.id} if config.camera else set())

    for frame in config.frames:
        try:
            validate_frame_image_path(frame.imagePath)
        except FrameImagePathError:
            issues.append(f"frame {frame.id} uses a disallowed imagePath")

    for bay in config.bays:
        bay_ids_seen[bay.id] += 1
        validate_polygon(bay.layoutPolygon, f"bay {bay.id}", issues)
        if bay.cameraId and known_camera_ids and bay.cameraId not in known_camera_ids:
            issues.append(f"bay {bay.id} references unknown camera {bay.cameraId}")
        for source_camera_id in bay.sourceCameraIds:
            if known_camera_ids and source_camera_id not in known_camera_ids:
                issues.append(f"bay {bay.id} references unknown source camera {source_camera_id}")
        if not bay.partitionId:
            issues.append(f"bay {bay.id} must belong to a partition")
        if not bay.zoneId:
            issues.append(f"bay {bay.id} must belong to a zone")
        if bay.partitionId not in partition_ids:
            issues.append(f"bay {bay.id} references missing partition {bay.partitionId}")

    for zone in config.zones:
        zone_ids_seen[zone.id] += 1
        validate_polygon(zone.layoutPolygon, f"zone {zone.id}", issues)
        if not within_bounds(zone.layoutPolygon) or not within_bounds(zone.imagePolygon):
            issues.append(f"zone {zone.id} falls outside frame bounds")

    for partition in config.partitions:
        partition_ids_seen[partition.id] += 1
        if any(camera_id not in known_camera_ids for camera_id in partition.ownerCameraIds):
            issues.append(f"partition {partition.id} references unknown owner cameras")
        if partition.layoutPolygon is not None:
            validate_polygon(partition.layoutPolygon, f"partition {partition.id}", issues)
            if not within_bounds(partition.layoutPolygon):
                issues.append(f"partition {partition.id} falls outside frame bounds")

    for line in config.lines:
        line_ids_seen[line.id] += 1
        if len(line.points) < 2:
            issues.append(f"line {line.id} must contain at least two points")
        if not within_bounds(line.points):
            issues.append(f"line {line.id} falls outside frame bounds")

    for polygon in config.observationPolygons:
        polygon_ids_seen[polygon.id] += 1
        if known_camera_ids and polygon.cameraId not in known_camera_ids:
            issues.append(f"observation polygon {polygon.id} references unknown camera {polygon.cameraId}")
        validate_polygon(polygon.imagePolygon, f"observation polygon {polygon.id}", issues)
        if not within_bounds(polygon.imagePolygon):
            issues.append(f"observation polygon {polygon.id} falls outside frame bounds")
        if polygon.canonicalBayId not in bay_ids:
            issues.append(f"observation polygon {polygon.id} references missing bay {polygon.canonicalBayId}")

    duplicate_bays = [item for item, count in bay_ids_seen.items() if count > 1]
    if duplicate_bays:
        issues.append(f"duplicate bay ids exist: {', '.join(sorted(duplicate_bays))}")

    duplicate_lines = [item for item, count in line_ids_seen.items() if count > 1]
    if duplicate_lines:
        issues.append(f"duplicate line ids exist: {', '.join(sorted(duplicate_lines))}")

    duplicate_polygons = [item for item, count in polygon_ids_seen.items() if count > 1]
    if duplicate_polygons:
        issues.append(f"duplicate observation polygon ids exist: {', '.join(sorted(duplicate_polygons))}")

    duplicate_zones = [item for item, count in zone_ids_seen.items() if count > 1]
    if duplicate_zones:
        issues.append(f"duplicate zone ids exist: {', '.join(sorted(duplicate_zones))}")

    duplicate_partitions = [item for item, count in partition_ids_seen.items() if count > 1]
    if duplicate_partitions:
        issues.append(f"duplicate partition ids exist: {', '.join(sorted(duplicate_partitions))}")

    zone_ids = {zone.id for zone in config.zones}
    for bay in config.bays:
        if bay.zoneId not in zone_ids:
            issues.append(f"bay {bay.id} references missing zone {bay.zoneId}")
        if bay.partitionId not in partition_ids:
            issues.append(f"bay {bay.id} references missing partition {bay.partitionId}")

    enabled_lines = [line for line in config.lines if line.enabled]
    if enabled_lines:
        kinds_by_camera: dict[str, set[str]] = {}
        for line in enabled_lines:
            kinds_by_camera.setdefault(line.cameraId, set()).add(line.kind)
        for camera_id, kinds in kinds_by_camera.items():
            if "entry" not in kinds or "exit" not in kinds:
                issues.append(f"counting-enabled camera {camera_id} requires both entry and exit lines")

    if issues:
        raise SpatialValidationError("; ".join(issues))


def validate_polygon(points: list[tuple[float, float]], label: str, issues: list[str]) -> None:
    if len(points) < 3:
        issues.append(f"{label} must contain at least three points")
        return

    if polygon_self_intersects(points):
        issues.append(f"{label} is self-intersecting")


def within_bounds(points: list[tuple[float, float]]) -> bool:
    return all(0.0 <= float(x) <= 1.0 and 0.0 <= float(y) <= 1.0 for x, y in points)


def polygon_self_intersects(points: list[tuple[float, float]]) -> bool:
    segments = list(zip(points, points[1:] + points[:1], strict=False))
    for index, (a1, a2) in enumerate(segments):
        for other_index, (b1, b2) in enumerate(segments):
            if abs(index - other_index) <= 1 or {index, other_index} == {0, len(segments) - 1}:
                continue
            if segments_intersect(a1, a2, b1, b2):
                return True
    return False


def segments_intersect(
    a1: tuple[float, float],
    a2: tuple[float, float],
    b1: tuple[float, float],
    b2: tuple[float, float],
) -> bool:
    def orientation(p, q, r):
        value = (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1])
        if abs(value) < 1e-12:
            return 0
        return 1 if value > 0 else 2

    def on_segment(p, q, r):
        return (
            min(p[0], r[0]) <= q[0] <= max(p[0], r[0])
            and min(p[1], r[1]) <= q[1] <= max(p[1], r[1])
        )

    o1 = orientation(a1, a2, b1)
    o2 = orientation(a1, a2, b2)
    o3 = orientation(b1, b2, a1)
    o4 = orientation(b1, b2, a2)

    if o1 != o2 and o3 != o4:
        return True

    if o1 == 0 and on_segment(a1, b1, a2):
        return True
    if o2 == 0 and on_segment(a1, b2, a2):
        return True
    if o3 == 0 and on_segment(b1, a1, b2):
        return True
    if o4 == 0 and on_segment(b1, a2, b2):
        return True
    return False
