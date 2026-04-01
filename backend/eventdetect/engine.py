"""Security event detection engine.

Detects behavioral events from tracked objects:
- running: sustained high speed
- chasing: two tracks in proximity, both fast
- zone_entry: track enters a defined zone
- dwelling: track stays in zone beyond threshold
- line_crossing: track centroid crosses a defined line
"""

from __future__ import annotations

import math
import uuid
from collections import defaultdict, deque
from datetime import datetime, timezone

from .schemas import SecurityEvent, SecurityLine, SecurityZone


def _point_in_polygon(px: float, py: float, polygon: list[tuple[float, float]]) -> bool:
    """Ray-casting point-in-polygon test."""
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def _segments_intersect(
    ax: float, ay: float, bx: float, by: float,
    cx: float, cy: float, dx: float, dy: float,
) -> bool:
    """Test if segment AB intersects segment CD."""
    def cross(o_x, o_y, a_x, a_y, b_x, b_y):
        return (a_x - o_x) * (b_y - o_y) - (a_y - o_y) * (b_x - o_x)

    d1 = cross(cx, cy, dx, dy, ax, ay)
    d2 = cross(cx, cy, dx, dy, bx, by)
    d3 = cross(ax, ay, bx, by, cx, cy)
    d4 = cross(ax, ay, bx, by, dx, dy)

    if ((d1 > 0 and d2 < 0) or (d1 < 0 and d2 > 0)) and \
       ((d3 > 0 and d4 < 0) or (d3 < 0 and d4 > 0)):
        return True
    return False


# Minimal track interface the engine needs — no import from models.py
class _Track:
    __slots__ = ("track_id", "cx", "cy", "velocity", "confidence", "age", "class_name", "bbox")

    def __init__(self, track_id: str, cx: float, cy: float,
                 velocity: tuple[float, float] | None, confidence: float,
                 age: int, class_name: str, bbox: tuple[float, float, float, float]):
        self.track_id = track_id
        self.cx = cx
        self.cy = cy
        self.velocity = velocity
        self.confidence = confidence
        self.age = age
        self.class_name = class_name
        self.bbox = bbox

    @property
    def speed(self) -> float:
        if self.velocity is None:
            return 0.0
        return math.sqrt(self.velocity[0] ** 2 + self.velocity[1] ** 2)


def tracks_from_dicts(raw: list[dict]) -> list[_Track]:
    """Convert raw detection+track dicts to _Track objects."""
    out = []
    for d in raw:
        cx = (d["x1"] + d["x2"]) / 2
        cy = (d["y1"] + d["y2"]) / 2
        out.append(_Track(
            track_id=d.get("track_id", ""),
            cx=cx, cy=cy,
            velocity=d.get("velocity"),
            confidence=d.get("confidence", 0.0),
            age=d.get("age", 0),
            class_name=d.get("label", ""),
            bbox=(d["x1"], d["y1"], d["x2"], d["y2"]),
        ))
    return out


class SecurityEventEngine:
    """Stateful engine that detects behavioral security events from tracked objects."""

    def __init__(
        self,
        min_speed_frames: int = 3,
        min_chase_frames: int = 3,
        chase_proximity: float = 0.15,
        chase_speed: float = 0.004,
        line_crossing_min_age: int = 3,
        line_crossing_cooldown: int = 5,
    ):
        self.min_speed_frames = min_speed_frames
        self.min_chase_frames = min_chase_frames
        self.chase_proximity = chase_proximity
        self.chase_speed = chase_speed
        self.line_crossing_min_age = line_crossing_min_age
        self.line_crossing_cooldown = line_crossing_cooldown

        # Per-camera state
        self._speed_streak: dict[str, dict[str, int]] = defaultdict(dict)
        self._zone_membership: dict[str, dict[str, set]] = defaultdict(lambda: defaultdict(set))
        self._zone_entry_time: dict[str, dict[str, dict[str, float]]] = defaultdict(lambda: defaultdict(dict))
        self._dwelling_emitted: dict[str, dict[str, set]] = defaultdict(lambda: defaultdict(set))
        self._chase_streak: dict[str, dict[frozenset, int]] = defaultdict(dict)
        self._centroid_trail: dict[str, dict[str, deque]] = defaultdict(lambda: defaultdict(lambda: deque(maxlen=8)))
        self._line_cooldown: dict[str, dict[str, int]] = defaultdict(dict)

        # Event cooldowns (track_key -> last_event_timestamp_sec)
        self._event_cooldown: dict[str, float] = {}
        self._frame_count: dict[str, int] = defaultdict(int)

    def update(
        self,
        camera_id: str,
        zones: list[SecurityZone],
        lines: list[SecurityLine],
        tracks: list[_Track],
        timestamp_sec: float,
    ) -> list[SecurityEvent]:
        self._frame_count[camera_id] = self._frame_count.get(camera_id, 0) + 1
        frame_n = self._frame_count[camera_id]

        events: list[SecurityEvent] = []
        ts_iso = datetime.now(timezone.utc).isoformat()

        # Filter to persons only for security event detection
        # (all tracks are still shown as bboxes in the feed for visual context)
        person_tracks = [t for t in tracks if t.class_name == "person"]

        # Update centroid trails (for all tracks — needed for line crossing detection)
        for t in tracks:
            self._centroid_trail[camera_id][t.track_id].append((t.cx, t.cy))

        # --- Running detection (persons only) ---
        for zone in zones:
            if not zone.detectRunning:
                continue
            for t in person_tracks:
                if t.speed > zone.speedThreshold:
                    self._speed_streak[camera_id][t.track_id] = \
                        self._speed_streak[camera_id].get(t.track_id, 0) + 1
                else:
                    self._speed_streak[camera_id][t.track_id] = 0

                if self._speed_streak[camera_id].get(t.track_id, 0) >= self.min_speed_frames:
                    key = f"running:{camera_id}:{t.track_id}"
                    if not self._in_cooldown(key, timestamp_sec, 5.0):
                        events.append(SecurityEvent(
                            id=_evt_id(), cameraId=camera_id, eventType="running",
                            trackIds=[t.track_id], confidence=t.confidence,
                            timestamp=ts_iso, timestampSec=timestamp_sec,
                        ))
                        self._event_cooldown[key] = timestamp_sec
                    self._speed_streak[camera_id][t.track_id] = 0

        # --- Chasing detection (persons only, gated by detectChasing flag) ---
        chasing_enabled = any(getattr(z, 'detectChasing', False) for z in zones)
        if chasing_enabled:
            for i, t1 in enumerate(person_tracks):
                for t2 in person_tracks[i + 1:]:
                    dist = math.sqrt((t1.cx - t2.cx) ** 2 + (t1.cy - t2.cy) ** 2)
                    pair = frozenset([t1.track_id, t2.track_id])
                    if dist < self.chase_proximity and t1.speed > self.chase_speed and t2.speed > self.chase_speed:
                        self._chase_streak[camera_id][pair] = \
                            self._chase_streak[camera_id].get(pair, 0) + 1
                    else:
                        self._chase_streak[camera_id][pair] = 0

                    if self._chase_streak[camera_id].get(pair, 0) >= self.min_chase_frames:
                        key = f"chasing:{camera_id}:{':'.join(sorted(pair))}"
                        if not self._in_cooldown(key, timestamp_sec, 10.0):
                            events.append(SecurityEvent(
                                id=_evt_id(), cameraId=camera_id, eventType="chasing",
                                trackIds=sorted(pair), confidence=min(t1.confidence, t2.confidence),
                                timestamp=ts_iso, timestampSec=timestamp_sec,
                            ))
                            self._event_cooldown[key] = timestamp_sec
                        self._chase_streak[camera_id][pair] = 0

        # --- Altercation detection (persons only, very close proximity + any movement) ---
        altercation_enabled = any(getattr(z, 'detectAltercation', False) for z in zones)
        if altercation_enabled:
            alt_proximity = min((getattr(z, 'altercationProximity', 0.08) for z in zones if getattr(z, 'detectAltercation', False)), default=0.08)
            for i, t1 in enumerate(person_tracks):
                for t2 in person_tracks[i + 1:]:
                    dist = math.sqrt((t1.cx - t2.cx) ** 2 + (t1.cy - t2.cy) ** 2)
                    pair = frozenset([t1.track_id, t2.track_id])
                    any_moving = t1.speed > 0.001 or t2.speed > 0.001
                    if dist < alt_proximity and any_moving:
                        streak_key = f"alt:{':'.join(sorted(pair))}"
                        self._chase_streak[camera_id][streak_key] = \
                            self._chase_streak[camera_id].get(streak_key, 0) + 1
                    else:
                        streak_key = f"alt:{':'.join(sorted(pair))}"
                        self._chase_streak[camera_id][streak_key] = 0

                    streak_key = f"alt:{':'.join(sorted(pair))}"
                    if self._chase_streak[camera_id].get(streak_key, 0) >= 3:
                        key = f"altercation:{camera_id}:{':'.join(sorted(pair))}"
                        if not self._in_cooldown(key, timestamp_sec, 8.0):
                            events.append(SecurityEvent(
                                id=_evt_id(), cameraId=camera_id, eventType="altercation",
                                trackIds=sorted(pair), confidence=min(t1.confidence, t2.confidence),
                                timestamp=ts_iso, timestampSec=timestamp_sec,
                            ))
                            self._event_cooldown[key] = timestamp_sec
                        self._chase_streak[camera_id][streak_key] = 0

        # --- Zone entry + Dwelling (persons only) ---
        for zone in zones:
            poly = zone.points
            for t in person_tracks:
                in_zone = _point_in_polygon(t.cx, t.cy, poly)
                was_in = zone.id in self._zone_membership[camera_id][t.track_id]

                if in_zone and not was_in:
                    # Zone entry
                    self._zone_membership[camera_id][t.track_id].add(zone.id)
                    self._zone_entry_time[camera_id][t.track_id][zone.id] = timestamp_sec
                    self._dwelling_emitted[camera_id][t.track_id].discard(zone.id)

                    if zone.detectEntry:
                        key = f"zone_entry:{camera_id}:{t.track_id}:{zone.id}"
                        if not self._in_cooldown(key, timestamp_sec, 3.0):
                            events.append(SecurityEvent(
                                id=_evt_id(), cameraId=camera_id, eventType="zone_entry",
                                trackIds=[t.track_id], confidence=t.confidence,
                                timestamp=ts_iso, timestampSec=timestamp_sec,
                                zoneId=zone.id,
                            ))
                            self._event_cooldown[key] = timestamp_sec

                elif not in_zone and was_in:
                    # Zone exit — reset dwelling state
                    self._zone_membership[camera_id][t.track_id].discard(zone.id)
                    self._zone_entry_time[camera_id][t.track_id].pop(zone.id, None)
                    self._dwelling_emitted[camera_id][t.track_id].discard(zone.id)

                elif in_zone and was_in and zone.detectDwelling:
                    # Check dwelling
                    entry_t = self._zone_entry_time[camera_id][t.track_id].get(zone.id)
                    if entry_t is not None and zone.id not in self._dwelling_emitted[camera_id][t.track_id]:
                        elapsed = timestamp_sec - entry_t
                        if elapsed >= zone.dwellThresholdSec:
                            events.append(SecurityEvent(
                                id=_evt_id(), cameraId=camera_id, eventType="dwelling",
                                trackIds=[t.track_id], confidence=t.confidence,
                                timestamp=ts_iso, timestampSec=timestamp_sec,
                                zoneId=zone.id,
                            ))
                            self._dwelling_emitted[camera_id][t.track_id].add(zone.id)

        # --- Crowd gathering (persons only) ---
        for zone in zones:
            if not zone.detectCrowdGathering:
                continue
            count_in_zone = sum(1 for t in person_tracks if _point_in_polygon(t.cx, t.cy, zone.points))
            if count_in_zone >= zone.crowdThreshold:
                key = f"crowd:{camera_id}:{zone.id}"
                if not self._in_cooldown(key, timestamp_sec, 10.0):
                    involved = [t.track_id for t in person_tracks if _point_in_polygon(t.cx, t.cy, zone.points)]
                    events.append(SecurityEvent(
                        id=_evt_id(), cameraId=camera_id, eventType="crowd_gathering",
                        trackIds=involved,
                        confidence=min((t.confidence for t in tracks if t.track_id in involved), default=0.5),
                        timestamp=ts_iso, timestampSec=timestamp_sec,
                        zoneId=zone.id,
                    ))
                    self._event_cooldown[key] = timestamp_sec

        # --- Line crossing (persons only) ---
        for line in lines:
            if not line.enabled or len(line.points) < 2:
                continue
            lx1, ly1 = line.points[0]
            lx2, ly2 = line.points[1]

            for t in person_tracks:
                if t.age < self.line_crossing_min_age:
                    continue
                trail = self._centroid_trail[camera_id].get(t.track_id)
                if not trail or len(trail) < 2:
                    continue

                prev_x, prev_y = trail[-2]
                curr_x, curr_y = trail[-1]

                if _segments_intersect(prev_x, prev_y, curr_x, curr_y, lx1, ly1, lx2, ly2):
                    cooldown_key = f"{t.track_id}:{line.id}"
                    last_frame = self._line_cooldown[camera_id].get(cooldown_key, -999)
                    if frame_n - last_frame >= self.line_crossing_cooldown:
                        events.append(SecurityEvent(
                            id=_evt_id(), cameraId=camera_id, eventType="line_crossing",
                            trackIds=[t.track_id], confidence=t.confidence,
                            timestamp=ts_iso, timestampSec=timestamp_sec,
                            lineId=line.id,
                        ))
                        self._line_cooldown[camera_id][cooldown_key] = frame_n

        # GC stale tracks
        active_ids = {t.track_id for t in tracks}
        for stale_id in list(self._speed_streak[camera_id].keys()):
            if stale_id not in active_ids:
                del self._speed_streak[camera_id][stale_id]
        for stale_id in list(self._zone_membership[camera_id].keys()):
            if stale_id not in active_ids:
                del self._zone_membership[camera_id][stale_id]
                self._zone_entry_time[camera_id].pop(stale_id, None)
                self._dwelling_emitted[camera_id].pop(stale_id, None)
        for stale_id in list(self._centroid_trail[camera_id].keys()):
            if stale_id not in active_ids:
                del self._centroid_trail[camera_id][stale_id]

        return events

    def reset_camera(self, camera_id: str) -> None:
        self._speed_streak.pop(camera_id, None)
        self._zone_membership.pop(camera_id, None)
        self._zone_entry_time.pop(camera_id, None)
        self._dwelling_emitted.pop(camera_id, None)
        self._chase_streak.pop(camera_id, None)
        self._centroid_trail.pop(camera_id, None)
        self._line_cooldown.pop(camera_id, None)
        self._frame_count.pop(camera_id, None)

    def _in_cooldown(self, key: str, now: float, cooldown: float) -> bool:
        last = self._event_cooldown.get(key)
        if last is None:
            return False
        return (now - last) < cooldown


def _evt_id() -> str:
    return f"sec-{uuid.uuid4().hex[:12]}"
