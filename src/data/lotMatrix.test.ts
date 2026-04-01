import { describe, expect, it } from "vitest";
import { createRectanglePolygon } from "./polygon";
import { syncLotDefinition } from "./lotMatrix";
import type { LotDefinition } from "./types";

function buildLot(overrides?: Partial<LotDefinition>): LotDefinition {
  const defaultCamera = {
    id: "CAM-01",
    name: "Demo camera",
    levelId: "PLANE-01",
    location: "north",
    angle: "45deg",
  };

  return {
    facilityId: overrides?.facilityId ?? "demo",
    facilityName: overrides?.facilityName ?? "Demo lot",
    timeZone: overrides?.timeZone ?? "Europe/Rome",
    levelId: overrides?.levelId ?? "PLANE-01",
    levelName: overrides?.levelName ?? "Plane 01",
    sourceLotKey: overrides?.sourceLotKey ?? "demo",
    camera: overrides?.camera ?? defaultCamera,
    cameras: overrides?.cameras ?? [],
    frames: overrides?.frames ?? [],
    levels: overrides?.levels ?? [
      {
        id: "PLANE-01",
        name: "Plane 01",
        index: 0,
        gridRows: 1,
        gridColumns: 2,
      },
    ],
    slots: overrides?.slots ?? [
      {
        id: "B01",
        label: "Bay 01",
        row: 0,
        column: 0,
        levelId: "PLANE-01",
        partitionId: "PLANE-01-PART-A",
        cameraId: "CAM-01",
        imagePolygon: createRectanglePolygon(0.35, 0.5, 0.1, 0.12),
        layoutPolygon: createRectanglePolygon(0.35, 0.5, 0.1, 0.12),
        evCapable: false,
        reservedDefault: false,
      },
      {
        id: "B02",
        label: "Bay 02",
        row: 0,
        column: 0,
        levelId: "PLANE-01",
        partitionId: "PLANE-01-PART-A",
        cameraId: "CAM-01",
        imagePolygon: createRectanglePolygon(0.55, 0.5, 0.1, 0.12),
        layoutPolygon: createRectanglePolygon(0.55, 0.5, 0.1, 0.12),
        evCapable: true,
        reservedDefault: false,
      },
    ],
    partitions: overrides?.partitions ?? [
      {
        id: "PLANE-01-PART-A",
        name: "Plane 01",
        levelId: "PLANE-01",
        order: 0,
        gridRows: 1,
        gridColumns: 2,
        ownerCameraIds: ["CAM-01"],
        layoutPolygon: null,
      },
    ],
    observationPolygons: overrides?.observationPolygons ?? [],
  };
}

describe("syncLotDefinition", () => {
  it("keeps grid rows and columns authoritative instead of expanding them to match slot coordinates", () => {
    const synced = syncLotDefinition(
      buildLot({
        levels: [
          {
            id: "PLANE-01",
            name: "Plane 01",
            index: 0,
            gridRows: 1,
            gridColumns: 2,
          },
        ],
        slots: [
          {
            id: "B09",
            label: "Bay 09",
            row: 3,
            column: 7,
            levelId: "PLANE-01",
            partitionId: "PLANE-01-PART-A",
            cameraId: "CAM-01",
            imagePolygon: createRectanglePolygon(0.5, 0.5, 0.1, 0.12),
            layoutPolygon: createRectanglePolygon(0.5, 0.5, 0.1, 0.12),
            evCapable: false,
            reservedDefault: false,
          },
        ],
      }),
    );

    expect(synced.levels[0]?.gridRows).toBe(1);
    expect(synced.levels[0]?.gridColumns).toBe(2);
    expect(synced.slots[0]?.row).toBe(0);
    expect(synced.slots[0]?.column).toBe(1);
  });

  it("reassigns duplicate cells to unique positions when the grid has spare capacity", () => {
    const synced = syncLotDefinition(buildLot());
    const positions = synced.slots.map((slot) => `${slot.row}:${slot.column}`);

    expect(new Set(positions).size).toBe(2);
    expect(positions).toContain("0:0");
    expect(positions).toContain("0:1");
  });
});
