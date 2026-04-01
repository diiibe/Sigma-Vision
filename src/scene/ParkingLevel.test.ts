import { describe, expect, it } from "vitest";
import type { ParkingLevel } from "../data/types";
import { derivePartitionFrames } from "./ParkingLevel";
import { isSceneSlotHighlighted } from "./sceneSelection";

describe("isSceneSlotHighlighted", () => {
  it("keeps non-mapped bays dim even when they share the selected camera zone", () => {
    expect(
      isSceneSlotHighlighted({
        slotId: "BAY-01",
        slotStatus: "free",
        selectedSlotId: null,
        hoveredSlotId: null,
        cameraRelevantSlotIds: ["BAY-02"],
        activeFilters: {
          free: true,
          occupied: true,
          ev: true,
          reserved: true,
          unknown: true,
        },
      }),
    ).toBe(false);
  });

  it("highlights only bays mapped to the selected camera", () => {
    expect(
      isSceneSlotHighlighted({
        slotId: "BAY-02",
        slotStatus: "free",
        selectedSlotId: null,
        hoveredSlotId: null,
        cameraRelevantSlotIds: ["BAY-02"],
        activeFilters: {
          free: true,
          occupied: true,
          ev: true,
          reserved: true,
          unknown: true,
        },
      }),
    ).toBe(true);
  });

  it("keeps every bay dim when the selected camera has no mapped polygons", () => {
    expect(
      isSceneSlotHighlighted({
        slotId: "BAY-03",
        slotStatus: "free",
        selectedSlotId: null,
        hoveredSlotId: null,
        cameraRelevantSlotIds: [],
        activeFilters: {
          free: true,
          occupied: true,
          ev: true,
          reserved: true,
          unknown: true,
        },
      }),
    ).toBe(false);
  });

  it("derives separate zone frames inside the same plane", () => {
    const level: ParkingLevel = {
      id: "PLANE-01",
      name: "Plane 01",
      index: 0,
      elevation: 0,
      dimensions: {
        rows: 1,
        columns: 5,
        slotWidth: 1.04,
        slotDepth: 0.58,
      },
      slots: [
        {
          id: "B01",
          label: "Bay 01",
          levelId: "PLANE-01",
          partitionId: "ZONE-A",
          levelIndex: 0,
          row: 0,
          column: 0,
          position: [-2, 0],
          size: [1, 1],
          status: "free",
          source: "model",
          sensorState: "online",
          cameraId: "CAM-01",
          licensePlate: null,
          vehicleType: null,
          confidence: 0.9,
          occupancyProbability: 0.9,
          lastDetectionAt: "2026-03-25T10:00:00Z",
          chargingKw: null,
          evCapable: false,
          imagePolygon: [],
          layoutPolygon: [],
        },
        {
          id: "B02",
          label: "Bay 02",
          levelId: "PLANE-01",
          partitionId: "ZONE-B",
          levelIndex: 0,
          row: 0,
          column: 1,
          position: [2, 0],
          size: [1, 1],
          status: "free",
          source: "model",
          sensorState: "online",
          cameraId: "CAM-01",
          licensePlate: null,
          vehicleType: null,
          confidence: 0.9,
          occupancyProbability: 0.9,
          lastDetectionAt: "2026-03-25T10:00:00Z",
          chargingKw: null,
          evCapable: false,
          imagePolygon: [],
          layoutPolygon: [],
        },
      ],
    };

    const frames = derivePartitionFrames(level);

    expect(frames).toHaveLength(2);
    expect(frames[0]?.id).toBe("ZONE-A");
    expect(frames[1]?.id).toBe("ZONE-B");
    expect(frames[0]?.center[0]).toBeLessThan(frames[1]?.center[0] ?? 0);
    expect(frames[0]?.size[0]).toBeGreaterThan(1);
    expect(frames[1]?.size[0]).toBeGreaterThan(1);
  });
});
