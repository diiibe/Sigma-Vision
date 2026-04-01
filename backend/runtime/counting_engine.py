"""Line-crossing detection and zone density counting engines.

LineCrossingEngine: detects when tracked vehicle centroids cross counting lines.
    Validated improvements: min_track_age filter, trail sanity check.
DensityEngine: counts tracked vehicles inside density zone polygons.
    Validated improvements: track-based (not detection-based), temporal smoothing.
"""

from __future__ import annotations

import logging
from collections import defaultdict

from ..models import (
    CountingEvent,
    CountingLineDefinition,
    DensitySnapshot,
    DensityZoneDefinition,
    DetectionRecord,
    TrackRecord,
)
from ..vision.predicates import is_vehicle, point_in_polygon, track_centroid

logger = logging.getLogger(__name__)


def _side_of_line(
    point: tuple[float, float],
    line_p1: tuple[float, float],
    line_p2: tuple[float, float],
) -> int:
    """Returns +1 or -1 depending on which side of the line the point is."""
    lx = line_p2[0] - line_p1[0]
    ly = line_p2[1] - line_p1[1]
    cross_val = lx * (point[1] - line_p1[1]) - ly * (point[0] - line_p1[0])
    return 1 if cross_val > 0 else -1


class LineCrossingEngine:
    """Detects vehicles crossing counting lines using centroid trajectory analysis.

    Filters:
    - min_track_age: ignore tracks younger than N frames (avoids phantom crossings)
    - trail sanity: oldest trail point must be on opposite side of line from current
      position (confirms a real traversal, not centroid noise)
    - cooldown: minimum frames between events for same track+line
    """

    def __init__(self, cooldown_frames: int = 5, min_track_age: int = 3, trail_len: int = 8):
        self.cooldown_frames = cooldown_frames
        self.min_track_age = min_track_age
        self.trail_len = trail_len
        # camera_id → track_id → (cx, cy)
        self._previous_centroids: dict[str, dict[str, tuple[float, float]]] = defaultdict(dict)
        # camera_id → track_id → list of (cx, cy)
        self._centroid_trails: dict[str, dict[str, list[tuple[float, float]]]] = defaultdict(lambda: defaultdict(list))
        # (line_id, track_id) → last frame count when event was emitted
        self._cooldowns: dict[tuple[str, str], int] = {}
        self._frame_counts: dict[str, int] = defaultdict(int)

    def update(
        self,
        camera_id: str,
        counting_lines: list[CountingLineDefinition],
        tracks: list[TrackRecord],
        timestamp: str,
    ) -> list[CountingEvent]:
        self._frame_counts[camera_id] += 1
        frame_count = self._frame_counts[camera_id]
        prev_centroids = self._previous_centroids[camera_id]
        trails = self._centroid_trails[camera_id]
        enabled_lines = [line for line in counting_lines if line.enabled and len(line.points) >= 2]
        events: list[CountingEvent] = []
        seen_track_ids: set[str] = set()

        for track in tracks:
            if not is_vehicle(track):
                continue
            tid = track.trackId
            seen_track_ids.add(tid)
            cx, cy = track_centroid(track)

            # Update trail
            trails[tid].append((cx, cy))
            if len(trails[tid]) > self.trail_len:
                trails[tid] = trails[tid][-self.trail_len:]

            prev = prev_centroids.get(tid)

            if prev is not None:
                for line in enabled_lines:
                    q1, q2 = line.points[0], line.points[1]
                    if not _segments_intersect(prev, (cx, cy), q1, q2):
                        continue

                    # Filter 1: minimum track age
                    if track.age < self.min_track_age:
                        continue

                    # Filter 2: cooldown
                    cooldown_key = (line.id, tid)
                    last_frame = self._cooldowns.get(cooldown_key, -999)
                    if frame_count - last_frame < self.cooldown_frames:
                        continue

                    # Filter 3: trail sanity
                    trail = trails.get(tid, [])
                    if len(trail) >= 3:
                        current_side = _side_of_line((cx, cy), q1, q2)
                        oldest_side = _side_of_line(trail[0], q1, q2)
                        if current_side == oldest_side:
                            continue

                    direction = _crossing_direction(prev, (cx, cy), q1, q2)
                    # Each line counts only its own type — entry lines count
                    # entries, exit lines count exits, regardless of crossing
                    # direction. User places separate lines for each type.
                    event_type = line.kind

                    events.append(CountingEvent(
                        id=f"cnt-{line.id}-{tid}-{frame_count}",
                        lineId=line.id,
                        cameraId=camera_id,
                        eventType=event_type,
                        trackId=tid,
                        timestamp=timestamp,
                        direction=direction,
                        confidence=track.confidence,
                        valid=True,
                        associationType=line.associationType,
                        associationId=line.associationId,
                    ))
                    self._cooldowns[cooldown_key] = frame_count

            prev_centroids[tid] = (cx, cy)

        # GC stale centroids and trails
        stale_cutoff = frame_count - 60
        stale_keys = [k for k, v in self._cooldowns.items() if v < stale_cutoff]
        for k in stale_keys:
            del self._cooldowns[k]

        stale_tracks = [tid for tid in prev_centroids if tid not in seen_track_ids]
        if len(stale_tracks) > 100:
            for tid in stale_tracks[:len(stale_tracks) - 50]:
                del prev_centroids[tid]
                trails.pop(tid, None)

        return events

    def reset_camera(self, camera_id: str) -> None:
        self._previous_centroids.pop(camera_id, None)
        self._centroid_trails.pop(camera_id, None)
        self._frame_counts.pop(camera_id, None)
        self._cooldowns = {
            k: v for k, v in self._cooldowns.items()
            if not k[0].startswith(camera_id)
        }

    def reset(self) -> None:
        self._previous_centroids.clear()
        self._centroid_trails.clear()
        self._cooldowns.clear()
        self._frame_counts.clear()


class DensityEngine:
    """Counts tracked vehicles inside density zone polygons.

    Uses tracks (not raw detections) for stable counts, with temporal
    smoothing to eliminate frame-to-frame flickering.
    """

    def __init__(self, min_track_age: int = 2, smooth_window: int = 3):
        self.min_track_age = min_track_age
        self.smooth_window = smooth_window
        # (camera_id, zone_id) → list of recent raw counts
        self._history: dict[tuple[str, str], list[int]] = defaultdict(list)

    def update(
        self,
        camera_id: str,
        density_zones: list[DensityZoneDefinition],
        tracks: list[TrackRecord],
        timestamp: str,
    ) -> list[DensitySnapshot]:
        enabled_zones = [z for z in density_zones if z.enabled and len(z.imagePolygon) >= 3]
        if not enabled_zones:
            return []

        # Compute centroids for vehicle tracks with sufficient age
        centroids = []
        for track in tracks:
            if not is_vehicle(track):
                continue
            if track.age < self.min_track_age:
                continue
            centroids.append(track_centroid(track))

        snapshots: list[DensitySnapshot] = []
        for zone in enabled_zones:
            polygon = [(float(p[0]), float(p[1])) for p in zone.imagePolygon]
            raw_count = sum(
                1 for centroid in centroids
                if point_in_polygon(centroid, polygon)
            )

            # Temporal smoothing
            history_key = (camera_id, zone.id)
            self._history[history_key].append(raw_count)
            if len(self._history[history_key]) > self.smooth_window:
                self._history[history_key] = self._history[history_key][-self.smooth_window:]

            smoothed = round(sum(self._history[history_key]) / len(self._history[history_key]))

            capacity = zone.capacityThreshold
            ratio = (smoothed / capacity) if capacity and capacity > 0 else None

            snapshots.append(DensitySnapshot(
                zoneId=zone.id,
                cameraId=camera_id,
                timestamp=timestamp,
                vehicleCount=smoothed,
                capacity=capacity,
                occupancyRatio=round(ratio, 4) if ratio is not None else None,
            ))

        return snapshots

    def reset(self) -> None:
        self._history.clear()


def _segments_intersect(
    p1: tuple[float, float],
    p2: tuple[float, float],
    q1: tuple[float, float],
    q2: tuple[float, float],
) -> bool:
    """Test if segment p1-p2 intersects segment q1-q2 using cross products."""
    def cross(o: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    d1 = cross(q1, q2, p1)
    d2 = cross(q1, q2, p2)
    d3 = cross(p1, p2, q1)
    d4 = cross(p1, p2, q2)

    if ((d1 > 0 and d2 < 0) or (d1 < 0 and d2 > 0)) and \
       ((d3 > 0 and d4 < 0) or (d3 < 0 and d4 > 0)):
        return True
    return False


def _crossing_direction(
    prev: tuple[float, float],
    curr: tuple[float, float],
    line_p1: tuple[float, float],
    line_p2: tuple[float, float],
) -> str:
    """Determine crossing direction relative to the line.

    Returns 'positive' if the track crosses from the left side of line_p1→line_p2
    to the right side, 'negative' otherwise.
    """
    lx = line_p2[0] - line_p1[0]
    ly = line_p2[1] - line_p1[1]
    mx = curr[0] - prev[0]
    my = curr[1] - prev[1]
    cross = lx * my - ly * mx
    return "positive" if cross > 0 else "negative"
