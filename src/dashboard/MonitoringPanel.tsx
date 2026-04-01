import { useState, type KeyboardEvent } from "react";
import { polygonToPath } from "../data/polygon";
import type {
  CameraFeed,
  ModuleHealth,
  ParkingSlot,
  SystemEvent,
} from "../data/types";
import { formatShortTime, titleCase } from "../lib/format";
import { EventHistoryDialog } from "./EventHistoryDialog";

interface RelevantPartitionSummary {
  id: string;
  name: string;
  ownerCameraIds: string[];
}

interface MonitoringPanelProps {
  cameras: CameraFeed[];
  slots: ParkingSlot[];
  moduleHealth: ModuleHealth[];
  events: SystemEvent[];
  timeZone: string;
  selectedCameraId: string | null;
  selectedSlotId: string | null;
  trackedSlotId: string | null;
  cameraRelevantPartitions: RelevantPartitionSummary[];
  cameraRelevantPartitionIds: string[];
  cameraRelevantSlotIds: string[];
  onSelectCamera(cameraId: string): void;
  onSelectSlot(slotId: string): void;
  onSelectEvent(event: SystemEvent): void;
}

function ensureCameraFrameUrl(frameUrl: string, cameraId: string): string {
  const [path, queryString = ""] = frameUrl.split("?", 2);
  const params = new URLSearchParams(queryString);
  if (!params.has("cameraId")) {
    params.set("cameraId", cameraId);
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function isOverlayActivationKey(key: string): boolean {
  return key === "Enter" || key === " " || key === "Spacebar";
}

function describeSlotOverlayAction(slot: ParkingSlot): string {
  return `Select ${slot.label} (${titleCase(slot.status)})`;
}

export function MonitoringPanel({
  cameras,
  slots,
  moduleHealth,
  events,
  timeZone,
  selectedCameraId,
  selectedSlotId,
  trackedSlotId,
  cameraRelevantPartitions,
  cameraRelevantPartitionIds,
  cameraRelevantSlotIds,
  onSelectCamera,
  onSelectSlot,
  onSelectEvent,
}: MonitoringPanelProps) {
  const [isEventHistoryOpen, setIsEventHistoryOpen] = useState(false);
  const selectedCamera =
    cameras.find((camera) => camera.id === selectedCameraId) ?? cameras[0] ?? null;
  const selectedCameraFrameUrl = selectedCamera
    ? ensureCameraFrameUrl(selectedCamera.frameUrl, selectedCamera.id)
    : null;
  const selectedCameraSlots = selectedCamera
    ? slots.filter((slot) => slot.cameraId === selectedCamera.id)
    : [];
  const currentCameraIndex = selectedCamera
    ? cameras.findIndex((camera) => camera.id === selectedCamera.id)
    : -1;
  const nextCamera =
    currentCameraIndex >= 0 && cameras.length > 1
      ? cameras[(currentCameraIndex + 1) % cameras.length]
      : null;
  const occupancyModule = moduleHealth.find((module) => module.module === "occupancy");
  const occupancyDegraded = occupancyModule
    ? !["online", "healthy"].includes(occupancyModule.status)
    : false;
  const handleSlotOverlayKeyDown = (
    event: KeyboardEvent<SVGPathElement>,
    slotId: string,
  ) => {
    if (!isOverlayActivationKey(event.key)) {
      return;
    }
    event.preventDefault();
    onSelectSlot(slotId);
  };

  return (
    <aside className="panel monitoring-panel">
      <section className="panel-section monitoring-panel__feed-section">
        <div className="section-heading">
          <h2>Selected feed</h2>
          <p>
            {cameras.length} calibrated {cameras.length === 1 ? "source" : "sources"}
          </p>
        </div>

        {selectedCamera ? (
          <article className="camera-focus">
            <div className="camera-focus__frame-shell">
              <div
                key={`${selectedCamera.id}:${selectedCamera.frameId}`}
                className="camera-focus__frame"
              >
                <img
                  key={selectedCameraFrameUrl}
                  src={selectedCameraFrameUrl ?? selectedCamera.frameUrl}
                  alt={`${selectedCamera.name} live frame`}
                />
                <svg
                  key={`${selectedCamera.id}:${selectedCamera.frameId}:overlay`}
                  className="camera-focus__overlay"
                  viewBox={`0 0 ${selectedCamera.imageWidth} ${selectedCamera.imageHeight}`}
                  aria-label={`${selectedCamera.name} slot overlay`}
                >
                  {selectedCameraSlots.map((slot) => (
                    <path
                      key={slot.id}
                      d={polygonToPath(
                        slot.imagePolygonsByCamera?.[selectedCamera.id] ?? slot.imagePolygon,
                        selectedCamera.imageWidth,
                        selectedCamera.imageHeight,
                      )}
                      role="button"
                      tabIndex={0}
                      focusable="true"
                      aria-label={describeSlotOverlayAction(slot)}
                      aria-pressed={selectedSlotId === slot.id}
                      className={`camera-focus__slot camera-focus__slot--${slot.status} ${
                        selectedSlotId === slot.id ? "is-selected" : ""
                      } ${trackedSlotId === slot.id ? "is-tracked" : ""} ${
                        cameraRelevantPartitionIds.includes(slot.partitionId) ? "is-camera-relevant" : ""
                      }`}
                      onClick={() => onSelectSlot(slot.id)}
                      onKeyDown={(event) => handleSlotOverlayKeyDown(event, slot.id)}
                    />
                  ))}
                </svg>
              </div>
            </div>

            <div className="camera-focus__meta">
              <div>
                <strong>{selectedCamera.name}</strong>
                <p>{selectedCamera.location}</p>
              </div>
              <div className="camera-focus__meta-actions">
                <span className={`camera-status camera-status--${selectedCamera.status}`}>
                  {titleCase(selectedCamera.status)}
                </span>
                <button
                  type="button"
                  className="action-button action-button--compact"
                  onClick={() => {
                    if (nextCamera) {
                      onSelectCamera(nextCamera.id);
                    }
                  }}
                  disabled={!nextCamera}
                >
                  Change camera
                </button>
              </div>
            </div>

            {occupancyDegraded ? (
              <div className="camera-focus__warning" role="status">
                <strong>Live occupancy degraded.</strong>
                <span>
                  {occupancyModule?.details ??
                    "The model is not returning reliable predictions for this camera. Bays without inference are shown as Unknown."}
                </span>
              </div>
            ) : null}

            {cameraRelevantPartitions.length > 0 ? (
              <div className="camera-focus__partition-strip" aria-label="Relevant partitions">
                {cameraRelevantPartitions.map((partition) => (
                  <span
                    key={partition.id}
                    className={`camera-switcher__button camera-focus__slot-chip ${
                      cameraRelevantPartitionIds.includes(partition.id) ? "is-active" : ""
                    }`}
                  >
                    <span>{partition.name}</span>
                    <strong>{partition.ownerCameraIds.join(" · ") || selectedCamera.id}</strong>
                  </span>
                ))}
              </div>
            ) : null}

            <div className="camera-focus__telemetry">
              <span>{selectedCameraSlots.length} bays visible</span>
              <span>{cameraRelevantPartitions.length} partitions</span>
              <span>{formatShortTime(selectedCamera.timestamp, timeZone)}</span>
              <span>{selectedCamera.angle}</span>
            </div>
          </article>
        ) : (
          <div className="camera-focus camera-focus--empty">
            <p className="camera-focus__empty">No camera feeds available.</p>
          </div>
        )}
      </section>

      <section className="panel-section panel-section--grow monitoring-panel__events-section">
        <div className="section-heading">
          <h2>Event log</h2>
          <p>Latest first, open archive for earlier activity</p>
          <button
            type="button"
            className="text-button monitoring-panel__events-open"
            onClick={() => setIsEventHistoryOpen(true)}
          >
            Open archive
          </button>
        </div>

        <div className="event-log" role="list" aria-label="System event log">
          {events.length > 0 ? (
            events.map((event) => (
              <button
                key={event.id}
                type="button"
                className={`event-row event-row--${event.severity} ${
                  trackedSlotId && event.slotId === trackedSlotId ? "event-row--tracked" : ""
                }`}
                onClick={() => setIsEventHistoryOpen(true)}
              >
                <span className="event-row__time">
                  {formatShortTime(event.timestamp, timeZone)}
                </span>
                <span className="event-row__body">
                  <strong>{titleCase(event.type)}</strong>
                  <span>{event.message}</span>
                </span>
                {trackedSlotId && event.slotId === trackedSlotId ? (
                  <span className="event-row__flag">Tracked</span>
                ) : null}
              </button>
            ))
          ) : (
            <button
              type="button"
              className="event-log__empty monitoring-panel__events-empty"
              onClick={() => setIsEventHistoryOpen(true)}
            >
              No recent events. Open archive.
            </button>
          )}
        </div>
      </section>

      <EventHistoryDialog
        cameras={cameras}
        open={isEventHistoryOpen}
        previewEvents={events}
        timeZone={timeZone}
        selectedCameraId={selectedCamera?.id ?? null}
        trackedSlotId={trackedSlotId}
        onClose={() => setIsEventHistoryOpen(false)}
        onSelectEvent={onSelectEvent}
      />
    </aside>
  );
}
