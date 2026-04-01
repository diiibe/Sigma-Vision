from __future__ import annotations

from pydantic import BaseModel


class SecurityZone(BaseModel):
    id: str
    name: str = ""
    points: list[tuple[float, float]]  # normalized 0-1 polygon
    detectEntry: bool = True
    detectDwelling: bool = True
    dwellThresholdSec: float = 10.0
    detectRunning: bool = True
    detectChasing: bool = True
    detectAltercation: bool = True
    speedThreshold: float = 0.012  # normalized units/frame (calibrated for aerial video)
    altercationProximity: float = 0.08  # very close proximity
    detectCrowdGathering: bool = True
    crowdThreshold: int = 3  # min people in zone to trigger


class SecurityLine(BaseModel):
    id: str
    name: str = ""
    points: list[tuple[float, float]]  # exactly 2 points, normalized 0-1
    enabled: bool = True


class SecurityTask(BaseModel):
    id: str
    cameraId: str
    zones: list[SecurityZone] = []
    lines: list[SecurityLine] = []
    sampleRate: int = 4
    enabled: bool = True


class SecurityEvent(BaseModel):
    id: str
    cameraId: str
    eventType: str  # running, chasing, zone_entry, dwelling, line_crossing
    trackIds: list[str]
    confidence: float
    timestamp: str
    timestampSec: float = 0.0
    zoneId: str | None = None
    lineId: str | None = None


class TrackState(BaseModel):
    trackId: str
    bbox: tuple[float, float, float, float]  # x1 y1 x2 y2 normalized
    className: str
    confidence: float
    centroid: tuple[float, float]
    velocity: tuple[float, float] | None = None
    age: int = 0


class SecurityCameraState(BaseModel):
    tracks: list[TrackState] = []
    frameIndex: int = 0
    currentSec: float = 0.0
    frameUrl: str | None = None


class TaskEventCounts(BaseModel):
    zone_entry: int = 0
    dwelling: int = 0
    running: int = 0
    chasing: int = 0
    altercation: int = 0
    crowd_gathering: int = 0
    line_crossing: int = 0
    total: int = 0


class SecurityServiceState(BaseModel):
    tasks: list[SecurityTask] = []
    events: list[SecurityEvent] = []
    activeCameras: list[str] = []
    taskCounts: dict[str, TaskEventCounts] = {}  # task.cameraId → counts
