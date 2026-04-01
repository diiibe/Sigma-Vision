from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


PolygonPoint = tuple[float, float]
BoundingBox = tuple[float, float, float, float]

SlotStatus = Literal["free", "occupied", "ev", "reserved", "unknown"]
SensorState = Literal["online", "degraded", "offline"]
CameraStatus = Literal["online", "latency", "offline"]
EventSeverity = Literal["info", "warning", "critical"]
EventType = Literal[
    "slot_released",
    "slot_occupied",
    "ev_charging",
    "reserved_detected",
    "sensor_update",
    "entry_count",
    "exit_count",
    "alert_active",
    "alert_cleared",
]


class LotFrameDefinition(BaseModel):
    id: str
    cameraId: str | None = None
    label: str
    imagePath: str | None = None
    capturedAt: str
    width: int
    height: int

    @field_validator("imagePath", mode="before")
    @classmethod
    def normalize_image_path(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if isinstance(value, str):
            trimmed = value.strip()
            return trimmed or None
        return value


class LotLevelDefinition(BaseModel):
    id: str
    name: str
    index: int
    gridRows: int = 1
    gridColumns: int = 1


class LotCameraDefinition(BaseModel):
    id: str
    name: str
    levelId: str
    location: str
    angle: str


class LotSlotDefinition(BaseModel):
    id: str
    label: str
    row: int
    column: int
    levelId: str
    partitionId: str | None = None
    cameraId: str
    imagePolygon: list[PolygonPoint] = Field(min_length=4)
    layoutPolygon: list[PolygonPoint] = Field(min_length=4)
    evCapable: bool = False
    zoneId: str | None = None
    ownerCameraIds: list[str] = Field(default_factory=list)
    reservedDefault: bool | None = None

    @model_validator(mode="after")
    def apply_legacy_partition_defaults(self) -> "LotSlotDefinition":
        if not self.partitionId:
            self.partitionId = self.levelId
        if not self.ownerCameraIds and self.cameraId:
            self.ownerCameraIds = [self.cameraId]
        return self


class LayoutPartitionDefinition(BaseModel):
    id: str
    name: str
    levelId: str
    order: int = 0
    gridRows: int = 1
    gridColumns: int = 1
    ownerCameraIds: list[str] = Field(default_factory=list)
    layoutPolygon: list[PolygonPoint] | None = None


class CameraObservationPolygon(BaseModel):
    id: str
    cameraId: str
    presetVersion: int
    canonicalBayId: str
    imagePolygon: list[PolygonPoint] = Field(min_length=4)
    enabled: bool = True
    priority: int | None = None
    notes: str | None = None


class LotDefinition(BaseModel):
    facilityId: str
    facilityName: str
    timeZone: str
    levelId: str
    levelName: str
    levels: list[LotLevelDefinition] = Field(min_length=1)
    sourceLotKey: str
    camera: LotCameraDefinition
    cameras: list[LotCameraDefinition] = Field(default_factory=list)
    frames: list[LotFrameDefinition] = Field(min_length=1)
    partitions: list[LayoutPartitionDefinition] = Field(default_factory=list)
    observationPolygons: list[CameraObservationPolygon] = Field(default_factory=list)
    slots: list[LotSlotDefinition] = Field(default_factory=list)


class OccupancyPrediction(BaseModel):
    slotId: str
    occupied: bool
    confidence: float
    observedAt: str
    frameId: str


class CycleRequest(BaseModel):
    cameraId: str | None = None


class FrameSelectRequest(BaseModel):
    frameId: str
    cameraId: str | None = None


class SpatialBayDefinition(BaseModel):
    id: str
    label: str
    row: int
    column: int
    levelId: str
    partitionId: str
    cameraId: str | None = None
    sourceCameraIds: list[str] = Field(default_factory=list)
    zoneId: str
    imagePolygon: list[PolygonPoint] = Field(default_factory=list)
    layoutPolygon: list[PolygonPoint] = Field(default_factory=list)
    evCapable: bool = False
    reservedDefault: bool | None = None


class SpatialZoneDefinition(BaseModel):
    id: str
    label: str
    levelId: str
    imagePolygon: list[PolygonPoint] = Field(min_length=4)
    layoutPolygon: list[PolygonPoint] = Field(min_length=4)
    bayIds: list[str] = Field(default_factory=list)


class SpatialLineDefinition(BaseModel):
    id: str
    label: str
    cameraId: str
    kind: Literal["entry", "exit"]
    points: list[PolygonPoint] = Field(min_length=2, max_length=2)
    layoutPoints: list[PolygonPoint] | None = None
    direction: str | None = None
    enabled: bool = True


class CountingLineDefinition(BaseModel):
    id: str
    label: str
    cameraId: str
    kind: Literal["entry", "exit"]
    points: list[PolygonPoint] = Field(min_length=2)
    layoutPoints: list[PolygonPoint] | None = None
    direction: str | None = None
    enabled: bool = True
    associationType: Literal["facility", "level", "zone"] = "facility"
    associationId: str | None = None


class DensityZoneDefinition(BaseModel):
    id: str
    label: str
    cameraId: str
    imagePolygon: list[PolygonPoint] = Field(min_length=3)
    layoutPolygon: list[PolygonPoint] | None = None
    enabled: bool = True
    capacityThreshold: int | None = None
    associationType: Literal["facility", "level", "zone"] = "facility"
    associationId: str | None = None


class CountingAlertRule(BaseModel):
    id: str
    label: str
    sourceType: Literal["density", "flow_rate", "net_flow"]
    sourceId: str
    operator: Literal["gt", "lt", "gte", "lte"] = "gt"
    threshold: int
    severity: EventSeverity = "warning"
    enabled: bool = True


class ObservationDefinition(BaseModel):
    """A user-defined vehicle analysis task: entry line, exit line, or density zone.

    Stored independently in SQLite (not part of SpatialConfig) for
    CRUD operations without affecting the parking layout config.
    """

    id: str
    name: str
    cameraId: str
    taskType: Literal["entry", "exit", "density"]
    # For entry/exit: 2 points (line endpoints). For density: 3+ points (polygon).
    points: list[PolygonPoint] = Field(min_length=2)
    associationType: Literal["facility", "level", "zone"] = "facility"
    associationId: str | None = None
    capacityThreshold: int | None = None  # only for density tasks
    enabled: bool = True
    createdAt: str
    updatedAt: str


class SpatialConfig(BaseModel):
    facilityId: str
    facilityName: str
    timeZone: str
    cameraId: str
    frameWidth: int
    frameHeight: int
    sourceLotKey: str
    version: int = 1
    status: Literal["draft", "active", "archived"] = "draft"
    countingEnabled: bool = True
    createdAt: str
    updatedAt: str
    activatedAt: str | None = None
    presetName: str | None = None
    copiedFromCameraId: str | None = None
    copiedFromVersion: int | None = None
    levels: list[LotLevelDefinition] = Field(min_length=1)
    camera: LotCameraDefinition
    cameras: list[LotCameraDefinition] = Field(default_factory=list)
    frames: list[LotFrameDefinition] = Field(min_length=1)
    partitions: list[LayoutPartitionDefinition] = Field(default_factory=list)
    observationPolygons: list[CameraObservationPolygon] = Field(default_factory=list)
    bays: list[SpatialBayDefinition] = Field(default_factory=list)
    zones: list[SpatialZoneDefinition] = Field(default_factory=list)
    lines: list[SpatialLineDefinition] = Field(default_factory=list)
    countingLines: list[CountingLineDefinition] = Field(default_factory=list)
    densityZones: list[DensityZoneDefinition] = Field(default_factory=list)
    countingAlertRules: list[CountingAlertRule] = Field(default_factory=list)


class SpatialConfigVersionSummary(BaseModel):
    cameraId: str
    version: int
    status: Literal["draft", "active", "archived"]
    createdAt: str
    updatedAt: str
    activatedAt: str | None = None
    presetName: str | None = None
    copiedFromCameraId: str | None = None
    copiedFromVersion: int | None = None
    bayCount: int
    zoneCount: int
    lineCount: int
    countingLineCount: int = 0
    densityZoneCount: int = 0


class SpatialConfigVersionRecord(SpatialConfigVersionSummary):
    config: SpatialConfig


class SpatialConfigBundle(BaseModel):
    active: SpatialConfig
    versions: list[SpatialConfigVersionSummary]


class CameraPresetCloneRequest(BaseModel):
    sourceCameraId: str
    sourceVersion: int
    targetName: str | None = None
    activate: bool = False


class CameraPresetAssignRequest(BaseModel):
    version: int


class CameraPresetDeleteRequest(BaseModel):
    archiveOnly: bool = True


class CameraVideoSourceState(BaseModel):
    cameraId: str
    sourcePath: str | None = None
    cacheDir: str | None = None
    status: Literal["ready", "missing", "error"]
    discoveredAt: str
    updatedAt: str
    normalizedFps: float = 5.0
    inputFps: float | None = None
    durationSeconds: float | None = None
    width: int | None = None
    height: int | None = None
    frameCount: int = 0
    sourceSignature: str | None = None
    currentFrameIndex: int = 0
    currentFrameId: str | None = None
    currentFramePath: str | None = None
    lastTickAt: str | None = None
    loopCount: int = 0
    error: str | None = None


class EditorCameraBundle(BaseModel):
    cameraId: str
    selectedVersion: int
    selected: SpatialConfig
    active: SpatialConfig
    versions: list[SpatialConfigVersionSummary]
    lotDefinition: LotDefinition
    videoSource: CameraVideoSourceState | None = None


class BayOverrideState(BaseModel):
    bayId: str
    cameraId: str
    status: Literal["reserved", "cleared"]
    active: bool
    updatedAt: str
    reason: str | None = None


class BayOverrideActionResult(BaseModel):
    override: BayOverrideState
    snapshot: "LiveStateSnapshot"


class DetectionRecord(BaseModel):
    frameId: str
    timestamp: str
    bbox: BoundingBox
    className: str
    confidence: float
    detectionId: str | None = None


class TrackRecord(BaseModel):
    frameId: str
    timestamp: str
    trackId: str
    bbox: BoundingBox
    className: str
    confidence: float
    age: int = 1
    persistence: float = 1.0
    centroid: PolygonPoint | None = None
    cameraId: str | None = None
    velocity: tuple[float, float] | None = None
    heading: float | None = None
    persistenceFrames: int = 0
    sourceModel: str = "unknown"


class BayState(BaseModel):
    bayId: str
    occupied: bool
    status: SlotStatus
    confidence: float
    lastChangedTime: str
    lastUpdatedTime: str
    frameId: str | None = None
    sourceTrackIds: list[str] = Field(default_factory=list)
    sourceCameraIds: list[str] = Field(default_factory=list)
    sourcePolygonIds: list[str] = Field(default_factory=list)
    winningCameraId: str | None = None
    winningPolygonId: str | None = None
    fusedScore: float | None = None
    stateAgeSec: float | None = None
    evidenceTrackIds: list[str] = Field(default_factory=list)
    fsmState: str | None = None


class ZoneKpiState(BaseModel):
    zoneId: str
    label: str
    totalBays: int
    occupiedBays: int
    availableBays: int
    occupancyPercentage: float
    lastUpdatedTime: str
    source: Literal["bay_rollup", "track_estimate"] = "bay_rollup"


class FlowEvent(BaseModel):
    id: str
    lineId: str
    eventType: Literal["entry", "exit"]
    trackId: str
    timestamp: str
    direction: str
    confidence: float
    valid: bool = True


class AlertEvent(BaseModel):
    alertId: str
    sourceKpi: str
    thresholdRule: str
    severity: EventSeverity
    active: bool
    firstSeen: str
    lastEvaluated: str
    explanation: str
    currentValue: float | None = None


class ModuleHealth(BaseModel):
    module: str
    status: Literal["online", "degraded", "offline"]
    lastUpdatedAt: str
    latencyMs: float | None = None
    errorCount: int = 0
    details: str | None = None


class TimelinePoint(BaseModel):
    bucketStart: str
    capturedAt: str
    occupancyRate: float
    entries: int
    exits: int
    activeAlerts: int
    zoneId: str | None = None


class ParkingSlot(BaseModel):
    id: str
    label: str
    levelId: str
    partitionId: str
    levelIndex: int
    row: int
    column: int
    position: tuple[float, float]
    size: tuple[float, float]
    status: SlotStatus
    source: Literal["model", "mock", "deterministic"]
    sensorState: SensorState
    cameraId: str
    licensePlate: str | None
    vehicleType: Literal["sedan", "suv", "van", "ev"] | None
    confidence: float
    occupancyProbability: float
    lastDetectionAt: str
    frameId: str | None = None
    chargingKw: float | None
    evCapable: bool
    imagePolygon: list[PolygonPoint]
    imagePolygonsByCamera: dict[str, list[PolygonPoint]] = Field(default_factory=dict)
    layoutPolygon: list[PolygonPoint]
    zoneId: str | None = None
    activeTrackIds: list[str] = Field(default_factory=list)
    sourceCameraIds: list[str] = Field(default_factory=list)
    sourcePolygonIds: list[str] = Field(default_factory=list)
    winningCameraId: str | None = None
    winningPolygonId: str | None = None


class ParkingLevel(BaseModel):
    id: str
    name: str
    index: int
    elevation: float
    dimensions: dict[str, float | int]
    slots: list[ParkingSlot]


class CameraFeed(BaseModel):
    id: str
    name: str
    levelId: str
    location: str
    status: CameraStatus
    timestamp: str
    thumbnail: str
    frameUrl: str
    frameId: str
    frameLabel: str
    imageWidth: int
    imageHeight: int
    angle: str
    streamHealth: float
    videoFrameCount: int | None = None
    videoFps: float | None = None


class SystemEvent(BaseModel):
    id: str
    type: EventType
    severity: EventSeverity
    timestamp: str
    message: str
    slotId: str | None = None
    levelId: str | None = None
    cameraId: str | None = None
    zoneId: str | None = None
    lineId: str | None = None
    trackId: str | None = None


class EventHistoryPage(BaseModel):
    items: list[SystemEvent]
    nextCursor: str | None = None


class LevelMetric(BaseModel):
    levelId: str
    name: str
    occupied: int
    free: int
    ev: int
    reserved: int
    unknownSlots: int = 0
    occupancyRate: float


class FacilityMetrics(BaseModel):
    totalSlots: int
    occupiedSlots: int
    freeSlots: int
    evSlots: int
    reservedSlots: int
    unknownSlots: int = 0
    occupancyRate: float
    onlineSensors: int
    flaggedEvents: int
    levelStats: list[LevelMetric]
    entriesLastHour: int = 0
    exitsLastHour: int = 0
    activeAlerts: int = 0


class FlowCounts(BaseModel):
    entriesTotal: int = 0
    exitsTotal: int = 0
    entriesLastHour: int = 0
    exitsLastHour: int = 0


class CountingEvent(BaseModel):
    id: str
    lineId: str
    cameraId: str
    eventType: Literal["entry", "exit"]
    trackId: str
    timestamp: str
    direction: str
    confidence: float
    valid: bool = True
    associationType: str = "facility"
    associationId: str | None = None


class DensitySnapshot(BaseModel):
    zoneId: str
    cameraId: str
    timestamp: str
    vehicleCount: int
    capacity: int | None = None
    occupancyRatio: float | None = None


class CountingAggregatePoint(BaseModel):
    bucketStart: str
    bucketEnd: str
    granularity: Literal["hourly", "daily"]
    entries: int = 0
    exits: int = 0
    netFlow: int = 0
    associationType: str = "facility"
    associationId: str | None = None


class TrafficCountingState(BaseModel):
    countingEvents: list[CountingEvent] = Field(default_factory=list)
    densitySnapshots: list[DensitySnapshot] = Field(default_factory=list)
    entriesTotal: int = 0
    exitsTotal: int = 0
    entriesLastHour: int = 0
    exitsLastHour: int = 0


class LiveStateSnapshot(BaseModel):
    facilityId: str
    facilityName: str
    timeZone: str
    cameraId: str
    activeCameraId: str | None = None
    configVersion: int
    capturedAt: str
    systemStatus: Literal["online", "degraded"]
    connectionHealth: Literal["stable", "degraded"]
    config: SpatialConfigBundle | None = None
    levels: list[ParkingLevel]
    cameras: list[CameraFeed]
    allCameraIds: list[str] = Field(default_factory=list)
    bayStates: list[BayState] = Field(default_factory=list)
    flowEvents: list[FlowEvent] = Field(default_factory=list)
    moduleHealth: list[ModuleHealth] = Field(default_factory=list)
    detections: list[DetectionRecord] = Field(default_factory=list)
    tracks: list[TrackRecord] = Field(default_factory=list)
    events: list[SystemEvent]
    metrics: FacilityMetrics
    zoneKpis: list[ZoneKpiState]
    counts: FlowCounts
    alerts: list[AlertEvent]
    timeline: list[TimelinePoint]
    modules: list[ModuleHealth]
    trafficCounting: TrafficCountingState | None = None


class ActivateConfigRequest(BaseModel):
    version: int


class ReplayRequest(BaseModel):
    cameraId: str | None = None
    frameId: str | None = None
    steps: int = 1


class SaveSpatialConfigRequest(BaseModel):
    config: SpatialConfig
    activate: bool = False


BayOverrideActionResult.model_rebuild()
