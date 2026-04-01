import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CameraFeed, ParkingSlot } from "../data/types";
import { MonitoringPanel } from "./MonitoringPanel";

vi.mock("./EventHistoryDialog", () => ({
  EventHistoryDialog: () => null,
}));

function buildCameraFeed(): CameraFeed {
  return {
    id: "CAM-01",
    name: "Camera 01",
    levelId: "L1",
    location: "Deck 01 A",
    status: "online",
    timestamp: "2026-03-25T10:00:00Z",
    thumbnail: "/api/live/frame/frame-01?cameraId=CAM-01",
    frameUrl: "/api/live/frame/frame-01?cameraId=CAM-01",
    frameId: "frame-01",
    frameLabel: "Frame 01",
    imageWidth: 1280,
    imageHeight: 720,
    angle: "north",
    streamHealth: 0.99,
  };
}

function buildSlot(overrides: Partial<ParkingSlot> = {}): ParkingSlot {
  return {
    id: "B01",
    label: "Bay 01",
    levelId: "L1",
    partitionId: "P1",
    levelIndex: 0,
    row: 0,
    column: 0,
    position: [0, 0],
    size: [1, 1],
    status: "free",
    source: "model",
    sensorState: "online",
    cameraId: "CAM-01",
    licensePlate: null,
    vehicleType: null,
    confidence: 0.91,
    occupancyProbability: 0.12,
    lastDetectionAt: "2026-03-25T10:00:00Z",
    frameId: "frame-01",
    chargingKw: null,
    evCapable: false,
    imagePolygon: [
      [0.1, 0.1],
      [0.25, 0.1],
      [0.25, 0.3],
      [0.1, 0.3],
    ],
    layoutPolygon: [
      [0.1, 0.1],
      [0.25, 0.1],
      [0.25, 0.3],
      [0.1, 0.3],
    ],
    ...overrides,
  };
}

describe("MonitoringPanel", () => {
  it("supports keyboard interaction for the SVG slot overlay", () => {
    const onSelectSlot = vi.fn();

    render(
      <MonitoringPanel
        cameras={[buildCameraFeed()]}
        slots={[buildSlot()]}
        moduleHealth={[]}
        events={[]}
        timeZone="Europe/Rome"
        selectedCameraId="CAM-01"
        selectedSlotId={null}
        trackedSlotId={null}
        cameraRelevantPartitions={[{ id: "P1", name: "Deck 01 A", ownerCameraIds: ["CAM-01"] }]}
        cameraRelevantPartitionIds={["P1"]}
        cameraRelevantSlotIds={["B01"]}
        onSelectCamera={vi.fn()}
        onSelectSlot={onSelectSlot}
        onSelectEvent={vi.fn()}
      />,
    );

    const overlayButton = screen.getByRole("button", { name: /select bay 01 \(free\)/i });

    expect(overlayButton).toHaveAttribute("tabindex", "0");
    expect(overlayButton).toHaveAttribute("aria-pressed", "false");

    overlayButton.focus();
    expect(overlayButton).toHaveFocus();

    fireEvent.keyDown(overlayButton, { key: "Enter" });
    fireEvent.keyDown(overlayButton, { key: " " });

    expect(onSelectSlot).toHaveBeenCalledTimes(2);
    expect(onSelectSlot).toHaveBeenNthCalledWith(1, "B01");
    expect(onSelectSlot).toHaveBeenNthCalledWith(2, "B01");
  });

  it("renders camera and event times using the provided timezone", () => {
    render(
      <MonitoringPanel
        cameras={[buildCameraFeed()]}
        slots={[buildSlot()]}
        moduleHealth={[]}
        events={[
          {
            id: "evt-01",
            type: "sensor_update",
            severity: "info",
            timestamp: "2026-03-25T10:00:00Z",
            message: "Heartbeat restored",
            cameraId: "CAM-01",
          },
        ]}
        timeZone="America/New_York"
        selectedCameraId="CAM-01"
        selectedSlotId={null}
        trackedSlotId={null}
        cameraRelevantPartitions={[{ id: "P1", name: "Deck 01 A", ownerCameraIds: ["CAM-01"] }]}
        cameraRelevantPartitionIds={["P1"]}
        cameraRelevantSlotIds={["B01"]}
        onSelectCamera={vi.fn()}
        onSelectSlot={vi.fn()}
        onSelectEvent={vi.fn()}
      />,
    );

    expect(screen.getAllByText("06:00:00")).toHaveLength(2);
  });
});
