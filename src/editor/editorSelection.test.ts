import { describe, expect, it } from "vitest";
import { syncLotDefinition } from "../data/lotMatrix";
import { createRectanglePolygon } from "../data/polygon";
import type { LotDefinition } from "../data/types";
import { resolveEditorSelection } from "./editorSelection";

function buildLot(): LotDefinition {
  return syncLotDefinition({
    facilityId: "demo",
    facilityName: "Demo lot",
    timeZone: "Europe/Rome",
    levelId: "PLANE-01",
    levelName: "Plane 01",
    sourceLotKey: "demo",
    camera: {
      id: "CAM-01",
      name: "Camera 01",
      levelId: "PLANE-01",
      location: "north",
      angle: "45deg",
    },
    cameras: [
      {
        id: "CAM-01",
        name: "Camera 01",
        levelId: "PLANE-01",
        location: "north",
        angle: "45deg",
      },
    ],
    frames: [
      {
        id: "CAM-01-frame-01",
        cameraId: "CAM-01",
        label: "Capture 1",
        imagePath: null,
        width: 1280,
        height: 720,
        capturedAt: "",
      },
    ],
    levels: [
      {
        id: "PLANE-01",
        name: "Plane 01",
        index: 0,
        gridRows: 1,
        gridColumns: 2,
      },
    ],
    partitions: [
      {
        id: "PLANE-01-PART-A",
        name: "Zone 01",
        levelId: "PLANE-01",
        order: 0,
        gridRows: 1,
        gridColumns: 2,
        ownerCameraIds: ["CAM-01"],
        layoutPolygon: null,
      },
      {
        id: "PLANE-01-PART-B",
        name: "Zone 02",
        levelId: "PLANE-01",
        order: 1,
        gridRows: 1,
        gridColumns: 3,
        ownerCameraIds: ["CAM-01"],
        layoutPolygon: null,
      },
    ],
    observationPolygons: [],
    slots: [
      {
        id: "B01",
        label: "Bay 01",
        row: 0,
        column: 0,
        levelId: "PLANE-01",
        partitionId: "PLANE-01-PART-A",
        cameraId: "CAM-01",
        imagePolygon: createRectanglePolygon(0.4, 0.5, 0.12, 0.16),
        layoutPolygon: createRectanglePolygon(0.4, 0.5, 0.12, 0.16),
        evCapable: false,
        reservedDefault: false,
      },
    ],
  });
}

describe("resolveEditorSelection", () => {
  it("preserves the selected zone when no bay is selected", () => {
    const lot = buildLot();

    const selection = resolveEditorSelection(lot, {
      selectedSlotId: null,
      selectedLevelId: "PLANE-01",
      selectedPartitionId: "PLANE-01-PART-B",
      selectedCameraId: "CAM-01",
    });

    expect(selection.selectedPartitionId).toBe("PLANE-01-PART-B");
    expect(selection.selectedLevelId).toBe("PLANE-01");
    expect(selection.selectedSlotId).toBeNull();
  });

  it("does not auto-select the first bay while preserving the active polygon set context", () => {
    const lot = buildLot();

    const selection = resolveEditorSelection(lot, {
      selectedSlotId: null,
      selectedLevelId: null,
      selectedPartitionId: "PLANE-01-PART-B",
      selectedCameraId: "CAM-01",
    });

    expect(selection.selectedSlotId).toBeNull();
    expect(selection.selectedPartitionId).toBe("PLANE-01-PART-B");
    expect(selection.currentFrameId).toBe("CAM-01-frame-01");
  });
});
