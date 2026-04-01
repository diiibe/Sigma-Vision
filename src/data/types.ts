export type SlotStatus = "free" | "occupied" | "ev" | "reserved" | "unknown";
export type SensorState = "online" | "degraded" | "offline";
export type CameraStatus = "online" | "latency" | "offline";
export type EventSeverity = "info" | "warning" | "critical";
export type EventType =
  | "slot_released"
  | "slot_occupied"
  | "ev_charging"
  | "reserved_detected"
  | "sensor_update"
  | "entry_count"
  | "exit_count"
  | "alert_active"
  | "alert_cleared";
export type VehicleType = "sedan" | "suv" | "van" | "ev";
export type SlotSource = "model" | "mock" | "deterministic";
export type PolygonPoint = [number, number];
export type Polygon = PolygonPoint[];

export interface ParkingSlot {
  id: string;
  label: string;
  levelId: string;
  partitionId: string;
  levelIndex: number;
  row: number;
  column: number;
  position: [number, number];
  size: [number, number];
  status: SlotStatus;
  source: SlotSource;
  sensorState: SensorState;
  cameraId: string;
  licensePlate: string | null;
  vehicleType: VehicleType | null;
  confidence: number;
  occupancyProbability: number;
  lastDetectionAt: string;
  frameId?: string | null;
  chargingKw: number | null;
  evCapable: boolean;
  imagePolygon: Polygon;
  imagePolygonsByCamera?: Record<string, Polygon>;
  layoutPolygon: Polygon;
  zoneId?: string | null;
  activeTrackIds?: string[];
  sourceCameraIds?: string[];
  sourcePolygonIds?: string[];
  winningCameraId?: string | null;
  winningPolygonId?: string | null;
}

export interface ParkingLevel {
  id: string;
  name: string;
  index: number;
  elevation: number;
  dimensions: {
    rows: number;
    columns: number;
    slotWidth: number;
    slotDepth: number;
  };
  slots: ParkingSlot[];
}

export interface CameraFeed {
  id: string;
  name: string;
  levelId: string;
  location: string;
  status: CameraStatus;
  timestamp: string;
  thumbnail: string;
  frameUrl: string;
  frameId: string;
  frameLabel: string;
  imageWidth: number;
  imageHeight: number;
  angle: string;
  streamHealth: number;
  videoFrameCount?: number | null;
  videoFps?: number | null;
}

export interface SystemEvent {
  id: string;
  type: EventType;
  severity: EventSeverity;
  timestamp: string;
  message: string;
  slotId?: string;
  levelId?: string;
  cameraId?: string;
  zoneId?: string;
  lineId?: string;
  trackId?: string;
}

export interface EventHistoryPage {
  items: SystemEvent[];
  nextCursor: string | null;
}

export interface LevelMetric {
  levelId: string;
  name: string;
  occupied: number;
  free: number;
  ev: number;
  reserved: number;
  unknownSlots: number;
  occupancyRate: number;
}

export interface FacilityMetrics {
  totalSlots: number;
  occupiedSlots: number;
  freeSlots: number;
  evSlots: number;
  reservedSlots: number;
  unknownSlots: number;
  occupancyRate: number;
  onlineSensors: number;
  flaggedEvents: number;
  levelStats: LevelMetric[];
  entriesLastHour?: number;
  exitsLastHour?: number;
  activeAlerts?: number;
}

export interface BayState {
  bayId: string;
  occupied: boolean;
  status?: SlotStatus;
  confidence: number;
  lastChangedTime?: string;
  lastUpdatedTime?: string;
  lastChangedAt?: string;
  frameId?: string | null;
  sourceTrackIds: string[];
  sourceCameraIds?: string[];
  sourcePolygonIds?: string[];
  winningCameraId?: string | null;
  winningPolygonId?: string | null;
  fusedScore?: number | null;
  stateAgeSec?: number | null;
  evidenceTrackIds?: string[];
  fsmState?: string | null;
}

export interface ZoneKpiState {
  zoneId: string;
  label?: string;
  totalBays: number;
  occupiedBays: number;
  availableBays: number;
  occupancyPercentage: number;
  lastUpdatedTime?: string;
  lastUpdatedAt?: string;
}

export interface FlowEvent {
  id?: string;
  lineId: string;
  eventType: "entry" | "exit";
  trackId: string;
  timestamp: string;
  direction: string;
  confidence: number;
  valid: boolean;
}

export interface AlertEvent {
  alertId: string;
  sourceKpi: string;
  thresholdRule: string;
  severity: EventSeverity;
  active: boolean;
  firstSeen: string;
  lastEvaluated: string;
  explanation: string;
  currentValue?: number | null;
}

export interface TimelinePoint {
  bucketStart: string;
  capturedAt?: string;
  occupancyRate?: number;
  occupancyPercentage?: number;
  occupiedBays?: number;
  availableBays?: number;
  entries: number;
  exits: number;
  activeAlerts?: number;
  alerts?: number;
  zoneId?: string | null;
}

export interface ModuleHealth {
  module: string;
  status: "healthy" | "degraded" | "down" | "online" | "offline";
  latencyMs: number | null;
  message?: string | null;
  lastUpdatedAt?: string;
  errorCount?: number;
  details?: string | null;
}

export interface DetectionRecord {
  frameId: string;
  timestamp: string;
  bbox: [number, number, number, number];
  className: string;
  confidence: number;
  detectionId?: string | null;
}

export interface TrackRecord {
  frameId: string;
  timestamp: string;
  trackId: string;
  bbox: [number, number, number, number];
  className: string;
  confidence: number;
  age: number;
  persistence: number;
  centroid?: [number, number] | null;
  cameraId?: string | null;
  velocity?: [number, number] | null;
  heading?: number | null;
  persistenceFrames?: number;
  sourceModel?: string;
}

export interface SpatialBayDefinition {
  id: string;
  label: string;
  row: number;
  column: number;
  levelId: string;
  partitionId: string;
  cameraId?: string;
  sourceCameraIds?: string[];
  zoneId: string;
  imagePolygon: Polygon;
  layoutPolygon: Polygon;
  evCapable: boolean;
  reservedDefault?: boolean;
}

export interface LayoutPartitionDefinition {
  id: string;
  name: string;
  levelId: string;
  order: number;
  gridRows: number;
  gridColumns: number;
  ownerCameraIds: string[];
  layoutPolygon?: Polygon | null;
}

export interface CameraObservationPolygon {
  id: string;
  cameraId: string;
  presetVersion: number;
  canonicalBayId: string;
  imagePolygon: Polygon;
  enabled: boolean;
  priority?: number | null;
  notes?: string | null;
}

export interface SpatialZoneDefinition {
  id: string;
  label: string;
  levelId: string;
  imagePolygon: Polygon;
  layoutPolygon: Polygon;
  bayIds: string[];
}

export interface SpatialLineDefinition {
  id: string;
  label: string;
  cameraId: string;
  kind: "entry" | "exit";
  points: [PolygonPoint, PolygonPoint];
  layoutPoints?: [PolygonPoint, PolygonPoint] | null;
  direction?: string | null;
  enabled: boolean;
}

export interface CountingLineDefinition {
  id: string;
  label: string;
  cameraId: string;
  kind: "entry" | "exit";
  points: PolygonPoint[];
  layoutPoints?: PolygonPoint[] | null;
  direction?: string | null;
  enabled: boolean;
  associationType: "facility" | "level" | "zone";
  associationId?: string | null;
}

export interface DensityZoneDefinition {
  id: string;
  label: string;
  cameraId: string;
  imagePolygon: PolygonPoint[];
  layoutPolygon?: PolygonPoint[] | null;
  enabled: boolean;
  capacityThreshold?: number | null;
  associationType: "facility" | "level" | "zone";
  associationId?: string | null;
}

export interface CountingAlertRule {
  id: string;
  label: string;
  sourceType: "density" | "flow_rate" | "net_flow";
  sourceId: string;
  operator: "gt" | "lt" | "gte" | "lte";
  threshold: number;
  severity: EventSeverity;
  enabled: boolean;
}

export interface ObservationDefinition {
  id: string;
  name: string;
  cameraId: string;
  taskType: "entry" | "exit" | "density";
  points: PolygonPoint[];
  associationType: "facility" | "level" | "zone";
  associationId?: string | null;
  capacityThreshold?: number | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CountingEvent {
  id: string;
  lineId: string;
  cameraId: string;
  eventType: "entry" | "exit";
  trackId: string;
  timestamp: string;
  direction: string;
  confidence: number;
  valid: boolean;
  associationType: string;
  associationId?: string | null;
}

export interface DensitySnapshot {
  zoneId: string;
  cameraId: string;
  timestamp: string;
  vehicleCount: number;
  capacity?: number | null;
  occupancyRatio?: number | null;
}

export interface CountingAggregatePoint {
  bucketStart: string;
  bucketEnd: string;
  granularity: "hourly" | "daily";
  entries: number;
  exits: number;
  netFlow: number;
  associationType: string;
  associationId?: string | null;
}

export interface TrafficCountingState {
  countingEvents: CountingEvent[];
  densitySnapshots: DensitySnapshot[];
  entriesTotal: number;
  exitsTotal: number;
  entriesLastHour: number;
  exitsLastHour: number;
}

export interface LotFrameDefinition {
  id: string;
  cameraId: string;
  label: string;
  imagePath: string | null;
  capturedAt: string;
  width: number;
  height: number;
}

export interface LotLevelDefinition {
  id: string;
  name: string;
  index: number;
  gridRows: number;
  gridColumns: number;
}

export interface LotCameraDefinition {
  id: string;
  name: string;
  levelId: string;
  location: string;
  angle: string;
}

export interface LotSlotDefinition {
  id: string;
  label: string;
  row: number;
  column: number;
  levelId: string;
  partitionId: string;
  cameraId: string;
  imagePolygon: Polygon;
  imagePolygonDefined?: boolean;
  layoutPolygon: Polygon;
  evCapable: boolean;
  zoneId?: string | null;
  ownerCameraIds?: string[];
  reservedDefault?: boolean;
}

export interface LotDefinition {
  facilityId: string;
  facilityName: string;
  timeZone: string;
  levelId: string;
  levelName: string;
  levels: LotLevelDefinition[];
  sourceLotKey: string;
  camera: LotCameraDefinition;
  cameras: LotCameraDefinition[];
  frames: LotFrameDefinition[];
  partitions: LayoutPartitionDefinition[];
  observationPolygons: CameraObservationPolygon[];
  slots: LotSlotDefinition[];
}

export interface SpatialConfig {
  facilityId: string;
  facilityName: string;
  timeZone: string;
  cameraId: string;
  frameWidth: number;
  frameHeight: number;
  sourceLotKey: string;
  version: number;
  status: "draft" | "active" | "archived";
  countingEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
  presetName?: string | null;
  copiedFromCameraId?: string | null;
  copiedFromVersion?: number | null;
  levels: LotLevelDefinition[];
  camera: LotCameraDefinition;
  cameras: LotCameraDefinition[];
  frames: LotFrameDefinition[];
  partitions: LayoutPartitionDefinition[];
  observationPolygons: CameraObservationPolygon[];
  bays: SpatialBayDefinition[];
  zones: SpatialZoneDefinition[];
  lines: SpatialLineDefinition[];
  countingLines?: CountingLineDefinition[];
  densityZones?: DensityZoneDefinition[];
  countingAlertRules?: CountingAlertRule[];
}

export interface SpatialConfigVersionSummary {
  cameraId: string;
  version: number;
  status: SpatialConfig["status"];
  createdAt: string;
  updatedAt: string;
  activatedAt?: string | null;
  presetName?: string | null;
  copiedFromCameraId?: string | null;
  copiedFromVersion?: number | null;
  bayCount: number;
  zoneCount: number;
  lineCount: number;
  countingLineCount?: number;
  densityZoneCount?: number;
}

export interface SpatialConfigBundle {
  active: SpatialConfig;
  versions: SpatialConfigVersionSummary[];
}

export interface CameraVideoSourceState {
  cameraId: string;
  sourcePath: string | null;
  cacheDir: string | null;
  status: "ready" | "missing" | "error";
  discoveredAt: string;
  updatedAt: string;
  normalizedFps: number;
  inputFps?: number | null;
  durationSeconds?: number | null;
  width?: number | null;
  height?: number | null;
  frameCount: number;
  sourceSignature?: string | null;
  currentFrameIndex: number;
  currentFrameId?: string | null;
  currentFramePath?: string | null;
  lastTickAt?: string | null;
  loopCount: number;
  error?: string | null;
}

export interface EditorCameraBundle {
  cameraId: string;
  selectedVersion: number;
  selected: SpatialConfig;
  active: SpatialConfig;
  versions: SpatialConfigVersionSummary[];
  lotDefinition: LotDefinition;
  videoSource?: CameraVideoSourceState | null;
}

export interface CameraPresetCloneRequest {
  sourceCameraId: string;
  sourceVersion: number;
  targetName?: string | null;
  activate?: boolean;
}

export interface CameraPresetAssignRequest {
  version: number;
}

export interface OccupancyPrediction {
  slotId: string;
  occupied: boolean;
  confidence: number;
  observedAt: string;
  frameId: string;
}

export interface DashboardSnapshot {
  facilityId: string;
  facilityName: string;
  timeZone: string;
  capturedAt: string;
  systemStatus: "online" | "degraded";
  connectionHealth: "stable" | "degraded";
  levels: ParkingLevel[];
  cameras: CameraFeed[];
  allCameraIds?: string[];
  events: SystemEvent[];
  metrics: FacilityMetrics;
  activeCameraId?: string | null;
  config?: SpatialConfigBundle | null;
  bayStates?: BayState[];
  zoneKpis?: ZoneKpiState[];
  flowEvents?: FlowEvent[];
  alerts?: AlertEvent[];
  timeline?: TimelinePoint[];
  moduleHealth?: ModuleHealth[];
  detections?: DetectionRecord[];
  tracks?: TrackRecord[];
  trafficCounting?: TrafficCountingState | null;
}

export type LiveStateSnapshot = DashboardSnapshot;

export interface ParkingDataSource {
  getSnapshot(): DashboardSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface ParkingRuntimeActions {
  reserveSlot(slotId: string): void | Promise<void>;
  markAvailable(slotId: string): void | Promise<void>;
  refreshCamera(cameraId: string): void | Promise<void>;
  trackSlot(slotId: string): void | Promise<void>;
  selectFrame?(frameId: string, cameraId?: string): void | Promise<void>;
  reloadSnapshot?(): void | Promise<void>;
}

export interface ParkingRuntime {
  dataSource: ParkingDataSource;
  actions: ParkingRuntimeActions;
  destroy(): void;
}

export type LegacyRuntime = ParkingRuntime;
