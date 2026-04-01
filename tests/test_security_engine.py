"""Tests for SecurityEventEngine — event detection logic."""

import pytest
from backend.eventdetect.engine import SecurityEventEngine, _Track
from backend.eventdetect.schemas import SecurityZone, SecurityLine


def _make_track(track_id="trk-00001", cx=0.5, cy=0.5, vx=0.0, vy=0.0, confidence=0.9, age=5):
    return _Track(
        track_id=track_id, cx=cx, cy=cy,
        velocity=(vx, vy), confidence=confidence, age=age,
        class_name="person", bbox=(cx - 0.02, cy - 0.02, cx + 0.02, cy + 0.02),
    )


def _zone(zone_id="zone-1", points=None, dwell=10.0, detect_entry=True, detect_dwelling=True, detect_running=True, speed=0.02):
    return SecurityZone(
        id=zone_id, name="Test Zone",
        points=points or [(0.2, 0.2), (0.8, 0.2), (0.8, 0.8), (0.2, 0.8)],
        detectEntry=detect_entry, detectDwelling=detect_dwelling,
        dwellThresholdSec=dwell, detectRunning=detect_running, detectChasing=False, speedThreshold=speed,
    )


def _line(line_id="line-1", p1=(0.5, 0.0), p2=(0.5, 1.0)):
    return SecurityLine(id=line_id, name="Test Line", points=[p1, p2])


class TestZoneEntry:
    def test_zone_entry_detection(self):
        engine = SecurityEventEngine()
        zone = _zone()
        # Frame 1: track outside
        t_out = _make_track(cx=0.1, cy=0.1)
        events = engine.update("cam1", [zone], [], [t_out], 1.0)
        assert not any(e.eventType == "zone_entry" for e in events)

        # Frame 2: track enters zone
        t_in = _make_track(cx=0.5, cy=0.5)
        events = engine.update("cam1", [zone], [], [t_in], 2.0)
        entry_events = [e for e in events if e.eventType == "zone_entry"]
        assert len(entry_events) == 1
        assert entry_events[0].zoneId == "zone-1"

    def test_zone_entry_no_repeat_while_inside(self):
        engine = SecurityEventEngine()
        zone = _zone()
        # Enter
        engine.update("cam1", [zone], [], [_make_track(cx=0.1, cy=0.1)], 1.0)
        engine.update("cam1", [zone], [], [_make_track(cx=0.5, cy=0.5)], 2.0)
        # Stay inside — no new entry event
        events = engine.update("cam1", [zone], [], [_make_track(cx=0.5, cy=0.5)], 3.0)
        assert not any(e.eventType == "zone_entry" for e in events)

    def test_zone_entry_cooldown(self):
        engine = SecurityEventEngine()
        zone = _zone()
        # Enter
        engine.update("cam1", [zone], [], [_make_track(cx=0.1, cy=0.1)], 1.0)
        engine.update("cam1", [zone], [], [_make_track(cx=0.5, cy=0.5)], 2.0)
        # Exit
        engine.update("cam1", [zone], [], [_make_track(cx=0.1, cy=0.1)], 3.0)
        # Re-enter within cooldown (3s)
        events = engine.update("cam1", [zone], [], [_make_track(cx=0.5, cy=0.5)], 4.0)
        entry_events = [e for e in events if e.eventType == "zone_entry"]
        assert len(entry_events) == 0  # cooldown blocks it


class TestDwelling:
    def test_dwelling_threshold_not_reached(self):
        engine = SecurityEventEngine()
        zone = _zone(dwell=10.0)
        # Enter and stay for 9s
        engine.update("cam1", [zone], [], [_make_track(cx=0.1, cy=0.1)], 0.0)
        engine.update("cam1", [zone], [], [_make_track(cx=0.5, cy=0.5)], 1.0)
        events = engine.update("cam1", [zone], [], [_make_track(cx=0.5, cy=0.5)], 10.0)
        dwelling = [e for e in events if e.eventType == "dwelling"]
        assert len(dwelling) == 0  # 10 - 1 = 9s < 10s threshold

    def test_dwelling_threshold_reached(self):
        engine = SecurityEventEngine()
        zone = _zone(dwell=10.0)
        engine.update("cam1", [zone], [], [_make_track(cx=0.1, cy=0.1)], 0.0)
        engine.update("cam1", [zone], [], [_make_track(cx=0.5, cy=0.5)], 1.0)  # enter at t=1
        events = engine.update("cam1", [zone], [], [_make_track(cx=0.5, cy=0.5)], 12.0)  # 11s in
        dwelling = [e for e in events if e.eventType == "dwelling"]
        assert len(dwelling) == 1

    def test_dwelling_reset_on_exit(self):
        engine = SecurityEventEngine()
        zone = _zone(dwell=5.0)
        engine.update("cam1", [zone], [], [_make_track(cx=0.1, cy=0.1)], 0.0)
        engine.update("cam1", [zone], [], [_make_track(cx=0.5, cy=0.5)], 1.0)  # enter
        engine.update("cam1", [zone], [], [_make_track(cx=0.5, cy=0.5)], 4.0)  # 3s — not enough
        engine.update("cam1", [zone], [], [_make_track(cx=0.1, cy=0.1)], 5.0)  # exit, timer reset
        engine.update("cam1", [zone], [], [_make_track(cx=0.5, cy=0.5)], 6.0)  # re-enter
        events = engine.update("cam1", [zone], [], [_make_track(cx=0.5, cy=0.5)], 10.0)  # 4s since re-enter
        dwelling = [e for e in events if e.eventType == "dwelling"]
        assert len(dwelling) == 0  # timer was reset


class TestRunning:
    def test_running_detection(self):
        engine = SecurityEventEngine(min_speed_frames=3)
        zone = _zone(speed=0.02)
        fast_track = _make_track(vx=0.03, vy=0.03)  # speed ~0.042
        for i in range(2):
            engine.update("cam1", [zone], [], [fast_track], float(i))
        events = engine.update("cam1", [zone], [], [fast_track], 3.0)
        running = [e for e in events if e.eventType == "running"]
        assert len(running) == 1

    def test_running_slow_no_event(self):
        engine = SecurityEventEngine(min_speed_frames=3)
        zone = _zone(speed=0.02)
        slow_track = _make_track(vx=0.005, vy=0.005)  # speed ~0.007
        for i in range(5):
            events = engine.update("cam1", [zone], [], [slow_track], float(i))
        running = [e for e in events if e.eventType == "running"]
        assert len(running) == 0

    def test_running_streak_reset(self):
        engine = SecurityEventEngine(min_speed_frames=3)
        zone = _zone(speed=0.02)
        fast = _make_track(vx=0.03, vy=0.03)
        slow = _make_track(vx=0.001, vy=0.001)
        engine.update("cam1", [zone], [], [fast], 0.0)
        engine.update("cam1", [zone], [], [fast], 1.0)
        engine.update("cam1", [zone], [], [slow], 2.0)  # streak broken
        engine.update("cam1", [zone], [], [fast], 3.0)
        events = engine.update("cam1", [zone], [], [fast], 4.0)  # only 2 after reset
        running = [e for e in events if e.eventType == "running"]
        assert len(running) == 0


class TestChasing:
    def _chase_zone(self):
        return _zone(detect_entry=False, detect_dwelling=False, detect_running=False)

    def test_chasing_detection(self):
        engine = SecurityEventEngine(min_chase_frames=3, chase_proximity=0.15)
        z = self._chase_zone()
        z.detectChasing = True
        t1 = _make_track(track_id="trk-a", cx=0.5, cy=0.5, vx=0.03, vy=0.03)
        t2 = _make_track(track_id="trk-b", cx=0.55, cy=0.55, vx=0.03, vy=0.03)
        for i in range(2):
            engine.update("cam1", [z], [], [t1, t2], float(i))
        events = engine.update("cam1", [z], [], [t1, t2], 3.0)
        chasing = [e for e in events if e.eventType == "chasing"]
        assert len(chasing) == 1

    def test_chasing_one_slow_no_event(self):
        engine = SecurityEventEngine(min_chase_frames=3, chase_proximity=0.15)
        z = self._chase_zone()
        z.detectChasing = True
        t1 = _make_track(track_id="trk-a", cx=0.5, cy=0.5, vx=0.03, vy=0.03)
        t2 = _make_track(track_id="trk-b", cx=0.55, cy=0.55, vx=0.001, vy=0.001)  # slow
        for i in range(5):
            events = engine.update("cam1", [z], [], [t1, t2], float(i))
        chasing = [e for e in events if e.eventType == "chasing"]
        assert len(chasing) == 0


class TestLineCrossing:
    def test_line_crossing(self):
        engine = SecurityEventEngine(line_crossing_min_age=1)
        line = _line(p1=(0.5, 0.0), p2=(0.5, 1.0))
        # Trail: left of line
        t = _make_track(track_id="trk-x", cx=0.3, cy=0.5, age=3)
        engine.update("cam1", [], [line], [t], 0.0)
        # Cross to right
        t2 = _make_track(track_id="trk-x", cx=0.7, cy=0.5, age=4)
        events = engine.update("cam1", [], [line], [t2], 1.0)
        crossings = [e for e in events if e.eventType == "line_crossing"]
        assert len(crossings) == 1
        assert crossings[0].lineId == "line-1"

    def test_line_no_crossing_parallel(self):
        engine = SecurityEventEngine(line_crossing_min_age=1)
        line = _line(p1=(0.5, 0.0), p2=(0.5, 1.0))
        # Move parallel to line (left side)
        t1 = _make_track(track_id="trk-x", cx=0.3, cy=0.3, age=3)
        engine.update("cam1", [], [line], [t1], 0.0)
        t2 = _make_track(track_id="trk-x", cx=0.3, cy=0.7, age=4)
        events = engine.update("cam1", [], [line], [t2], 1.0)
        crossings = [e for e in events if e.eventType == "line_crossing"]
        assert len(crossings) == 0

    def test_line_crossing_cooldown(self):
        engine = SecurityEventEngine(line_crossing_min_age=1, line_crossing_cooldown=5)
        line = _line()
        # First crossing
        engine.update("cam1", [], [line], [_make_track(track_id="trk-x", cx=0.3, cy=0.5, age=3)], 0.0)
        engine.update("cam1", [], [line], [_make_track(track_id="trk-x", cx=0.7, cy=0.5, age=4)], 1.0)
        # Back across within cooldown
        engine.update("cam1", [], [line], [_make_track(track_id="trk-x", cx=0.3, cy=0.5, age=5)], 2.0)
        events = engine.update("cam1", [], [line], [_make_track(track_id="trk-x", cx=0.7, cy=0.5, age=6)], 3.0)
        crossings = [e for e in events if e.eventType == "line_crossing"]
        assert len(crossings) == 0  # within 5-frame cooldown


class TestEdgeCases:
    def test_no_events_empty_tracks(self):
        engine = SecurityEventEngine()
        zone = _zone()
        line = _line()
        events = engine.update("cam1", [zone], [line], [], 1.0)
        assert events == []

    def test_reset_camera_clears_state(self):
        engine = SecurityEventEngine()
        zone = _zone()
        engine.update("cam1", [zone], [], [_make_track(cx=0.5, cy=0.5)], 1.0)
        engine.reset_camera("cam1")
        # After reset, entry should fire again
        engine.update("cam1", [zone], [], [_make_track(cx=0.1, cy=0.1)], 10.0)
        events = engine.update("cam1", [zone], [], [_make_track(cx=0.5, cy=0.5)], 11.0)
        entry = [e for e in events if e.eventType == "zone_entry"]
        assert len(entry) == 1
