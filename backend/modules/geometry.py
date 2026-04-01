from __future__ import annotations

from math import atan2

from backend.models import BoundingBox, PolygonPoint


def polygon_centroid(points: list[PolygonPoint]) -> PolygonPoint:
    total_x = sum(point[0] for point in points)
    total_y = sum(point[1] for point in points)
    return (total_x / len(points), total_y / len(points))


def polygon_bounds(points: list[PolygonPoint]) -> tuple[float, float, float, float]:
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return (min(xs), min(ys), max(xs), max(ys))


def bbox_from_polygon(points: list[PolygonPoint]) -> BoundingBox:
    min_x, min_y, max_x, max_y = polygon_bounds(points)
    return (min_x, min_y, max_x, max_y)


def point_in_polygon(point: PolygonPoint, polygon: list[PolygonPoint]) -> bool:
    x, y = point
    inside = False
    point_count = len(polygon)

    for index in range(point_count):
        x1, y1 = polygon[index]
        x2, y2 = polygon[(index + 1) % point_count]
        intersects = ((y1 > y) != (y2 > y)) and (
            x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-9) + x1
        )
        if intersects:
            inside = not inside

    return inside


def polygons_self_intersect(points: list[PolygonPoint]) -> bool:
    segment_count = len(points)

    for index in range(segment_count):
        segment_a = (points[index], points[(index + 1) % segment_count])
        for compare_index in range(index + 1, segment_count):
            if abs(index - compare_index) <= 1:
                continue
            if index == 0 and compare_index == segment_count - 1:
                continue
            segment_b = (
                points[compare_index],
                points[(compare_index + 1) % segment_count],
            )
            if segments_intersect(segment_a[0], segment_a[1], segment_b[0], segment_b[1]):
                return True

    return False


def segments_intersect(
    a1: PolygonPoint,
    a2: PolygonPoint,
    b1: PolygonPoint,
    b2: PolygonPoint,
) -> bool:
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


def orientation(a: PolygonPoint, b: PolygonPoint, c: PolygonPoint) -> int:
    value = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1])
    if abs(value) < 1e-9:
        return 0
    return 1 if value > 0 else 2


def on_segment(a: PolygonPoint, b: PolygonPoint, c: PolygonPoint) -> bool:
    return (
        min(a[0], c[0]) <= b[0] <= max(a[0], c[0])
        and min(a[1], c[1]) <= b[1] <= max(a[1], c[1])
    )


def point_side_of_line(point: PolygonPoint, line: list[PolygonPoint]) -> float:
    start, end = line
    return (end[0] - start[0]) * (point[1] - start[1]) - (end[1] - start[1]) * (
        point[0] - start[0]
    )


def line_direction(line: list[PolygonPoint]) -> str:
    start, end = line
    angle = atan2(end[1] - start[1], end[0] - start[0])
    if -0.785 <= angle <= 0.785:
        return "eastbound"
    if 0.785 < angle <= 2.355:
        return "southbound"
    if angle > 2.355 or angle < -2.355:
        return "westbound"
    return "northbound"
