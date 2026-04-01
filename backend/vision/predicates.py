"""Spatial predicates for occupancy determination.

Pure functions operating on model objects and polygon geometry.
"""

from __future__ import annotations

from ..models import PolygonPoint, SpatialBayDefinition, TrackRecord


def polygon_bounds(points: list[tuple[float, float]]) -> tuple[float, float, float, float]:
    """Axis-aligned bounding box of a polygon."""
    xs = [float(p[0]) for p in points]
    ys = [float(p[1]) for p in points]
    return min(xs), min(ys), max(xs), max(ys)


def point_in_polygon(point: tuple[float, float], polygon: list[tuple[float, float]]) -> bool:
    """Ray-casting point-in-polygon test."""
    x, y = point
    inside = False
    if not polygon:
        return False
    px, py = polygon[-1]
    for cx, cy in polygon:
        if ((cy > y) != (py > y)) and (
            x < (px - cx) * (y - cy) / ((py - cy) or 1e-12) + cx
        ):
            inside = not inside
        px, py = cx, cy
    return inside


def is_vehicle(track: TrackRecord) -> bool:
    """Check if a track represents a vehicle detection."""
    return track.className in ("car", "motorcycle", "bus", "truck", "van", "motor", "vehicle")


def track_centroid(track: TrackRecord) -> PolygonPoint:
    """Get the centroid of a track, computing from bbox if not set."""
    if track.centroid is not None:
        return track.centroid
    cx = (track.bbox[0] + track.bbox[2]) / 2
    cy = (track.bbox[1] + track.bbox[3]) / 2
    return (cx, cy)


def center_in_bay(track: TrackRecord, bay: SpatialBayDefinition) -> bool:
    """Check if a track's centroid falls inside a bay's polygon."""
    centroid = track_centroid(track)
    polygon = bay.imagePolygon if bay.imagePolygon else bay.layoutPolygon
    return point_in_polygon(centroid, polygon)


def coverage_in_bay(track: TrackRecord, bay: SpatialBayDefinition) -> float:
    """Estimate how much of a track's bbox overlaps with a bay's bounding box.

    Returns a value in [0.0, 1.0] representing the intersection-over-bay-area ratio.
    Uses axis-aligned bounding boxes for speed.
    """
    polygon = bay.imagePolygon if bay.imagePolygon else bay.layoutPolygon
    bx1, by1, bx2, by2 = polygon_bounds(polygon)
    bay_area = (bx2 - bx1) * (by2 - by1)
    if bay_area <= 0:
        return 0.0

    tx1, ty1, tx2, ty2 = track.bbox
    ix1 = max(bx1, tx1)
    iy1 = max(by1, ty1)
    ix2 = min(bx2, tx2)
    iy2 = min(by2, ty2)

    if ix1 >= ix2 or iy1 >= iy2:
        return 0.0

    intersection = (ix2 - ix1) * (iy2 - iy1)
    return min(1.0, intersection / bay_area)


def stable_bay_assignment(track: TrackRecord, min_frames: int = 3) -> bool:
    """Check if a track has persisted long enough to be considered stable."""
    frames = track.persistenceFrames if track.persistenceFrames > 0 else track.age
    return frames >= min_frames


def vehicle_stopped(track: TrackRecord, velocity_threshold: float = 0.01) -> bool:
    """Check if a tracked vehicle is effectively stationary."""
    if track.velocity is None:
        # If no velocity data, assume stopped if track has aged (parked vehicle)
        return track.age >= 3
    vx, vy = track.velocity
    speed = (vx ** 2 + vy ** 2) ** 0.5
    return speed < velocity_threshold
