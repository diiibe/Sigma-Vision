import type { ComponentType } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CameraFeed, ParkingLevel, ParkingSlot, SlotStatus } from "../data/types";
import { formatShortTime, titleCase } from "../lib/format";
import type { ParkingSceneProps } from "../scene/ParkingScene";
import { DEFAULT_SCENE_COLOR_TUNING } from "../scene/slotOverlay";
import type {
  SceneColorTuning,
  SlotOverlayMetricsById,
  SlotOverlayState,
} from "../scene/slotOverlay";
import type { DashboardOverlayKey } from "../store/dashboardStore";

interface SceneViewportProps {
  levels: ParkingLevel[];
  selectedSlot: ParkingSlot | null;
  selectedCamera: CameraFeed | null;
  timeZone: string;
  trackedSlotId: string | null;
  cameraRelevantPartitionIds: string[];
  cameraRelevantSlotIds: string[];
  isDetailCardOpen: boolean;
  selectedSlotId: string | null;
  hoveredSlotId: string | null;
  activeFilters: Record<SlotStatus, boolean>;
  activeLevelIds: string[];
  activePartitionIds: string[];
  activeOverlays: SlotOverlayState;
  slotOverlayMetrics: SlotOverlayMetricsById;
  reducedMotion: boolean;
  onHoverSlot(slotId: string | null): void;
  onSelectSlot(slotId: string): void;
  onToggleOverlay(key: DashboardOverlayKey): void;
  onReserveSlot(): void;
  onMarkAvailable(): void;
  onTrackSlot(): void;
  onCloseDetailCard(): void;
  SceneComponent: ComponentType<ParkingSceneProps>;
}

interface Point {
  x: number;
  y: number;
}

const DEFAULT_SCENE_ZOOM = 0.75;

export function SceneViewport({
  levels,
  selectedSlot,
  selectedCamera,
  timeZone,
  trackedSlotId,
  cameraRelevantPartitionIds,
  cameraRelevantSlotIds,
  isDetailCardOpen,
  selectedSlotId,
  hoveredSlotId,
  activeFilters,
  activeLevelIds,
  activePartitionIds,
  activeOverlays,
  slotOverlayMetrics,
  reducedMotion,
  onHoverSlot,
  onSelectSlot,
  onToggleOverlay,
  onReserveSlot,
  onMarkAvailable,
  onTrackSlot,
  onCloseDetailCard,
  SceneComponent,
}: SceneViewportProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const [projectedPoint, setProjectedPoint] = useState<Point | null>(null);
  const [anchorPoint, setAnchorPoint] = useState<Point | null>(null);
  const [isOverlayPanelOpen, setIsOverlayPanelOpen] = useState(false);
  const [colorTuning, setColorTuning] = useState<SceneColorTuning>({
    ...DEFAULT_SCENE_COLOR_TUNING,
  });

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const detail = detailRef.current;

    if (!stage || !detail) {
      setAnchorPoint(null);
      return undefined;
    }

    const updateAnchor = () => {
      const stageRect = stage.getBoundingClientRect();
      const detailRect = detail.getBoundingClientRect();

      setAnchorPoint({
        x: detailRect.left - stageRect.left + detailRect.width / 2,
        y: detailRect.top - stageRect.top + 6,
      });
    };

    updateAnchor();

    const observer = new ResizeObserver(updateAnchor);
    observer.observe(stage);
    observer.observe(detail);
    window.addEventListener("resize", updateAnchor);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateAnchor);
    };
  }, [isDetailCardOpen, selectedSlot?.id]);

  const leaderPath = useMemo(() => {
    if (!isDetailCardOpen || !projectedPoint || !anchorPoint) {
      return null;
    }

    const curveMidY = projectedPoint.y + (anchorPoint.y - projectedPoint.y) * 0.4;

    return `M ${projectedPoint.x} ${projectedPoint.y} C ${projectedPoint.x} ${curveMidY}, ${anchorPoint.x} ${curveMidY - 12}, ${anchorPoint.x} ${anchorPoint.y}`;
  }, [anchorPoint, projectedPoint]);

  const selectedSlotOverlay = selectedSlotId
    ? slotOverlayMetrics[selectedSlotId] ?? null
    : null;
  const colorTuningKey = [
    colorTuning.saturation,
    colorTuning.lightness,
    colorTuning.bayOutlineSaturation,
    colorTuning.bayOutlineLightness,
    colorTuning.zoneOutlineSaturation,
    colorTuning.zoneOutlineLightness,
    DEFAULT_SCENE_ZOOM,
  ]
    .map((value) => value.toFixed(2))
    .join("-");

  return (
    <section className="scene-panel">
      <div className="scene-panel__chrome">
        <div>
          <h2>3D lot matrix</h2>
          <p>Editable parking planes aligned to the selected camera feed and current model frame.</p>
        </div>
        <div className="scene-panel__legend" aria-label="Slot status legend">
          <span className="legend-item legend-item--free">Free</span>
          <span className="legend-item legend-item--occupied">Occupied</span>
          <span className="legend-item legend-item--ev">EV</span>
          <span className="legend-item legend-item--reserved">Reserved</span>
          <span className="legend-item legend-item--unknown">Unknown</span>
        </div>
      </div>

      <div className="scene-stage" ref={stageRef}>
          <SceneComponent
          key={colorTuningKey}
          levels={levels}
          selectedSlotId={selectedSlotId}
          hoveredSlotId={hoveredSlotId}
          cameraRelevantPartitionIds={cameraRelevantPartitionIds}
          cameraRelevantSlotIds={cameraRelevantSlotIds}
          activeFilters={activeFilters}
          activeLevelIds={activeLevelIds}
          activePartitionIds={activePartitionIds}
          activeOverlays={activeOverlays}
          slotOverlayMetrics={slotOverlayMetrics}
          colorTuning={colorTuning}
          zoomFactor={DEFAULT_SCENE_ZOOM}
          reducedMotion={reducedMotion}
          onSlotHover={onHoverSlot}
          onSlotSelect={onSelectSlot}
          onSelectedSlotProject={setProjectedPoint}
        />

        <svg className="scene-stage__leader" aria-hidden="true">
          {leaderPath ? <path d={leaderPath} /> : null}
        </svg>

        {isOverlayPanelOpen ? (
          <div className="scene-stage__overlay-panel" aria-label="Bay overlay controls">
            <div className="scene-stage__overlay-header">
              <p className="scene-stage__overlay-label">Overlays</p>
              <button
                type="button"
                className="scene-stage__overlay-collapse"
                onClick={() => setIsOverlayPanelOpen(false)}
                aria-label="Collapse overlay controls"
              >
                ×
              </button>
            </div>
            <div className="scene-stage__overlay-controls">
              <button
                type="button"
                className={`scene-overlay-toggle ${
                  activeOverlays.occupancyDwell ? "is-active" : ""
                }`}
                onClick={() => onToggleOverlay("occupancyDwell")}
                aria-pressed={activeOverlays.occupancyDwell}
              >
                <span className="scene-overlay-toggle__swatch scene-overlay-toggle__swatch--occupancy" />
                <span>Occupancy dwell · 24h</span>
              </button>
              <button
                type="button"
                className={`scene-overlay-toggle ${
                  activeOverlays.vehicleTurnover ? "is-active" : ""
                }`}
                onClick={() => onToggleOverlay("vehicleTurnover")}
                aria-pressed={activeOverlays.vehicleTurnover}
              >
                <span className="scene-overlay-toggle__swatch scene-overlay-toggle__swatch--turnover" />
                <span>Vehicle turnover</span>
              </button>
            </div>
            <div className="scene-stage__tuning">
              <div className="scene-stage__tuning-header">
                <p className="scene-stage__overlay-label">Color tuning</p>
                <button
                  type="button"
                  className="text-button text-button--compact"
                  onClick={() => setColorTuning({ ...DEFAULT_SCENE_COLOR_TUNING })}
                >
                  Reset
                </button>
              </div>
              <label className="scene-stage__slider-group">
                <span>
                  Fill saturation
                  <strong>{colorTuning.saturation.toFixed(2)}x</strong>
                </span>
                <input
                  type="range"
                  min="0.35"
                  max="2.4"
                  step="0.05"
                  value={colorTuning.saturation}
                  onChange={(event) =>
                    setColorTuning((current) => ({
                      ...current,
                      saturation: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <label className="scene-stage__slider-group">
                <span>
                  Fill lightness
                  <strong>{colorTuning.lightness.toFixed(2)}x</strong>
                </span>
                <input
                  type="range"
                  min="0.45"
                  max="2.25"
                  step="0.05"
                  value={colorTuning.lightness}
                  onChange={(event) =>
                    setColorTuning((current) => ({
                      ...current,
                      lightness: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <label className="scene-stage__slider-group">
                <span>
                  Bay outline sat
                  <strong>{colorTuning.bayOutlineSaturation.toFixed(2)}x</strong>
                </span>
                <input
                  type="range"
                  min="0.35"
                  max="2.4"
                  step="0.05"
                  value={colorTuning.bayOutlineSaturation}
                  onChange={(event) =>
                    setColorTuning((current) => ({
                      ...current,
                      bayOutlineSaturation: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <label className="scene-stage__slider-group">
                <span>
                  Bay outline light
                  <strong>{colorTuning.bayOutlineLightness.toFixed(2)}x</strong>
                </span>
                <input
                  type="range"
                  min="0.45"
                  max="2.25"
                  step="0.05"
                  value={colorTuning.bayOutlineLightness}
                  onChange={(event) =>
                    setColorTuning((current) => ({
                      ...current,
                      bayOutlineLightness: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <label className="scene-stage__slider-group">
                <span>
                  Zone outline sat
                  <strong>{colorTuning.zoneOutlineSaturation.toFixed(2)}x</strong>
                </span>
                <input
                  type="range"
                  min="0.35"
                  max="2.4"
                  step="0.05"
                  value={colorTuning.zoneOutlineSaturation}
                  onChange={(event) =>
                    setColorTuning((current) => ({
                      ...current,
                      zoneOutlineSaturation: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <label className="scene-stage__slider-group">
                <span>
                  Zone outline light
                  <strong>{colorTuning.zoneOutlineLightness.toFixed(2)}x</strong>
                </span>
                <input
                  type="range"
                  min="0.45"
                  max="2.25"
                  step="0.05"
                  value={colorTuning.zoneOutlineLightness}
                  onChange={(event) =>
                    setColorTuning((current) => ({
                      ...current,
                      zoneOutlineLightness: Number(event.target.value),
                    }))
                  }
                />
              </label>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="scene-stage__overlay-collapsed"
            onClick={() => setIsOverlayPanelOpen(true)}
            aria-expanded="false"
          >
            Overlay
          </button>
        )}

        {isDetailCardOpen ? (
          <div className="detail-card" ref={detailRef}>
            {selectedSlot ? (
              <>
                <header className="detail-card__header">
                  <div>
                    <p className="detail-card__eyeline">Selected slot</p>
                    <h3>{selectedSlot.label}</h3>
                    <p className="detail-card__slot-code">{selectedSlot.id}</p>
                  </div>
                  <div className="detail-card__header-actions">
                    <span className={`detail-card__status detail-card__status--${selectedSlot.status}`}>
                      {titleCase(selectedSlot.status)}
                    </span>
                    <button
                      type="button"
                      className="detail-card__dismiss"
                      onClick={onCloseDetailCard}
                      aria-label="Close slot details"
                    >
                      Close
                    </button>
                  </div>
                </header>

                <dl className="detail-card__grid">
                  <div>
                    <dt>Level</dt>
                    <dd>{levels.find((level) => level.id === selectedSlot.levelId)?.name}</dd>
                  </div>
                  <div>
                    <dt>Camera</dt>
                    <dd>{selectedSlot.cameraId}</dd>
                  </div>
                  <div>
                    <dt>Partition</dt>
                    <dd>{selectedSlot.partitionId}</dd>
                  </div>
                  <div>
                    <dt>Plate</dt>
                    <dd>{selectedSlot.licensePlate ?? "No plate captured"}</dd>
                  </div>
                  <div>
                    <dt>Sensor</dt>
                    <dd>{titleCase(selectedSlot.sensorState)}</dd>
                  </div>
                  <div>
                    <dt>Last detection</dt>
                    <dd>{formatShortTime(selectedSlot.lastDetectionAt, timeZone)}</dd>
                  </div>
                  <div>
                    <dt>Confidence</dt>
                    <dd>{Math.round(selectedSlot.confidence * 100)}%</dd>
                  </div>
                  {selectedSlotOverlay ? (
                    <>
                      <div>
                        <dt>Dwell mock</dt>
                        <dd>{Math.round(selectedSlotOverlay.occupancyDwell * 100)}%</dd>
                      </div>
                      <div>
                        <dt>Turnover mock</dt>
                        <dd>{Math.round(selectedSlotOverlay.vehicleTurnover * 100)}%</dd>
                      </div>
                    </>
                  ) : null}
                </dl>

                <div className="detail-card__camera">
                  <div>
                    <span>Linked feed</span>
                    <strong>{selectedCamera?.name ?? selectedSlot.cameraId}</strong>
                  </div>
                  <span>
                    {selectedCamera
                      ? `${selectedCamera.frameLabel} · ${selectedCamera.location}`
                      : "No feed selected"}
                  </span>
                </div>

                <div className="detail-card__actions">
                  <button
                    type="button"
                    className="action-button"
                    onClick={onReserveSlot}
                    disabled={selectedSlot.status === "reserved"}
                  >
                    Flag reserved
                  </button>
                  <button
                    type="button"
                    className="action-button"
                    onClick={onTrackSlot}
                    disabled={trackedSlotId === selectedSlot.id}
                  >
                    {trackedSlotId === selectedSlot.id ? "Tracking active" : "Track bay"}
                  </button>
                  <button
                    type="button"
                    className="action-button"
                    onClick={onMarkAvailable}
                    disabled={selectedSlot.status !== "reserved"}
                  >
                    Clear override
                  </button>
                </div>
              </>
            ) : (
              <div className="detail-card__empty">
                <h3>No slot selected</h3>
                <p>Pick a bay from the scene or the event log to inspect live metadata.</p>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
