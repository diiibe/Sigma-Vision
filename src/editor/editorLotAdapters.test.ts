import { describe, expect, it } from "vitest";
import { buildFixtureSnapshot, sampleLotDefinition } from "../data/demoFixtures";
import { createRectanglePolygon } from "../data/polygon";
import type { EditorCameraBundle } from "../data/types";
import {
  buildEditableLotDefinition,
  hydrateLotDefinitionForCamera,
  syncEditableObservationPolygonsForCamera,
  lotDefinitionToSpatialConfig,
} from "./editorLotAdapters";

describe("buildEditableLotDefinition", () => {
  it("returns a blank starter lot when no bundle is available", () => {
    const hydrated = buildEditableLotDefinition(null, null, "PTL2");

    expect(hydrated.camera.id).toBe("PTL2");
    expect(hydrated.slots).toEqual([]);
    expect(hydrated.partitions).toHaveLength(1);
  });

  it("hydrates bundle-backed editor lots to the requested camera feed", () => {
    const snapshot = buildFixtureSnapshot();
    if (!snapshot.config) {
      throw new Error("Expected fixture snapshot to include an active config.");
    }
    const secondCamera = {
      ...snapshot.cameras[0],
      id: "PTL2",
      name: "PTL2",
      frameId: "PTL2-frame-01",
      frameLabel: "Capture 1",
      frameUrl: "/frames/ptl2.png",
      thumbnail: "/frames/ptl2-thumb.png",
    };
    const bundle = {
      cameraId: "PTL2",
      selectedVersion: 1,
      selected: snapshot.config.active,
      active: snapshot.config.active,
      versions: snapshot.config.versions,
      lotDefinition: sampleLotDefinition,
      videoSource: null,
    } satisfies EditorCameraBundle;

    const hydrated = buildEditableLotDefinition(
      bundle,
      {
        ...snapshot,
        activeCameraId: "PTL2",
        cameras: [snapshot.cameras[0], secondCamera],
      },
      "PTL2",
    );

    expect(hydrated.camera.id).toBe("PTL2");
    expect(hydrated.cameras.some((camera) => camera.id === "PTL2")).toBe(true);
    expect(hydrated.frames.every((frame) => frame.cameraId === "PTL2")).toBe(true);
  });

  it("marks bundle-backed slots as unmapped when the requested camera has no observation polygons", () => {
    const bundle = {
      cameraId: "PTL2",
      selectedVersion: 1,
      selected: {
        ...buildFixtureSnapshot().config!.active,
        cameras: [
          sampleLotDefinition.camera,
          {
            ...sampleLotDefinition.camera,
            id: "PTL2",
            name: "PTL2",
          },
        ],
      },
      active: {
        ...buildFixtureSnapshot().config!.active,
        cameras: [
          sampleLotDefinition.camera,
          {
            ...sampleLotDefinition.camera,
            id: "PTL2",
            name: "PTL2",
          },
        ],
      },
      versions: buildFixtureSnapshot().config!.versions,
      lotDefinition: {
        ...sampleLotDefinition,
        cameras: [
          sampleLotDefinition.camera,
          {
            ...sampleLotDefinition.camera,
            id: "PTL2",
            name: "PTL2",
          },
        ],
        observationPolygons: [],
      },
      videoSource: null,
    } satisfies EditorCameraBundle;

    const hydrated = buildEditableLotDefinition(bundle, buildFixtureSnapshot(), "PTL2");

    expect(hydrated.observationPolygons).toHaveLength(0);
    expect(hydrated.slots.every((slot) => slot.imagePolygonDefined === false)).toBe(true);
  });

  it("can rehydrate a cached editable lot to a different camera without reusing the previous overlays", () => {
    const bundle = {
      cameraId: "PTL1",
      selectedVersion: 1,
      selected: {
        ...buildFixtureSnapshot().config!.active,
        cameras: [
          sampleLotDefinition.camera,
          {
            ...sampleLotDefinition.camera,
            id: "PTL2",
            name: "PTL2",
          },
        ],
      },
      active: {
        ...buildFixtureSnapshot().config!.active,
        cameras: [
          sampleLotDefinition.camera,
          {
            ...sampleLotDefinition.camera,
            id: "PTL2",
            name: "PTL2",
          },
        ],
      },
      versions: buildFixtureSnapshot().config!.versions,
      lotDefinition: {
        ...sampleLotDefinition,
        cameras: [
          sampleLotDefinition.camera,
          {
            ...sampleLotDefinition.camera,
            id: "PTL2",
            name: "PTL2",
          },
        ],
        frames: [
          { ...sampleLotDefinition.frames[0], cameraId: sampleLotDefinition.camera.id },
          { ...sampleLotDefinition.frames[0], id: "PTL2-frame-01", cameraId: "PTL2" },
        ],
        observationPolygons: sampleLotDefinition.observationPolygons.filter(
          (polygon) => polygon.cameraId === sampleLotDefinition.camera.id,
        ),
      },
      videoSource: null,
    } satisfies EditorCameraBundle;

    const firstCameraLot = buildEditableLotDefinition(bundle, buildFixtureSnapshot(), sampleLotDefinition.camera.id);
    const secondCameraLot = hydrateLotDefinitionForCamera(
      firstCameraLot,
      buildFixtureSnapshot(),
      "PTL2",
      null,
    );

    expect(secondCameraLot.camera.id).toBe("PTL2");
    expect(secondCameraLot.frames.every((frame) => frame.cameraId === "PTL2")).toBe(true);
    expect(secondCameraLot.slots.every((slot) => slot.imagePolygonDefined === false)).toBe(true);
  });

  it("keeps unsaved polygons created on a second camera when the lot is rehydrated again", () => {
    const bundle = {
      cameraId: "PTL2",
      selectedVersion: 1,
      selected: {
        ...buildFixtureSnapshot().config!.active,
        cameras: [
          sampleLotDefinition.camera,
          {
            ...sampleLotDefinition.camera,
            id: "PTL2",
            name: "PTL2",
          },
        ],
      },
      active: {
        ...buildFixtureSnapshot().config!.active,
        cameras: [
          sampleLotDefinition.camera,
          {
            ...sampleLotDefinition.camera,
            id: "PTL2",
            name: "PTL2",
          },
        ],
      },
      versions: buildFixtureSnapshot().config!.versions,
      lotDefinition: {
        ...sampleLotDefinition,
        cameras: [
          sampleLotDefinition.camera,
          {
            ...sampleLotDefinition.camera,
            id: "PTL2",
            name: "PTL2",
          },
        ],
        frames: [
          { ...sampleLotDefinition.frames[0], cameraId: sampleLotDefinition.camera.id },
          { ...sampleLotDefinition.frames[0], id: "PTL2-frame-01", cameraId: "PTL2" },
        ],
        observationPolygons: sampleLotDefinition.observationPolygons.filter(
          (polygon) => polygon.cameraId === sampleLotDefinition.camera.id,
        ),
      },
      videoSource: null,
    } satisfies EditorCameraBundle;

    const ptl2Lot = buildEditableLotDefinition(bundle, buildFixtureSnapshot(), "PTL2");
    const targetSlot = ptl2Lot.slots[0];
    if (!targetSlot) {
      throw new Error("Expected at least one slot.");
    }

    const locallyEdited = syncEditableObservationPolygonsForCamera(
      {
        ...ptl2Lot,
        slots: ptl2Lot.slots.map((slot) =>
          slot.id === targetSlot.id
            ? {
                ...slot,
                imagePolygonDefined: true,
                imagePolygon: createRectanglePolygon(0.2, 0.3, 0.1, 0.14),
              }
            : slot,
        ),
      },
      "PTL2",
      1,
    );

    const rehydrated = hydrateLotDefinitionForCamera(locallyEdited, buildFixtureSnapshot(), "PTL2", null);
    const restoredSlot = rehydrated.slots.find((slot) => slot.id === targetSlot.id);

    expect(
      rehydrated.observationPolygons.some(
        (polygon) => polygon.cameraId === "PTL2" && polygon.canonicalBayId === targetSlot.id,
      ),
    ).toBe(true);
    expect(restoredSlot?.imagePolygonDefined).toBe(true);
    expect(restoredSlot?.imagePolygon).toEqual(createRectanglePolygon(0.2, 0.3, 0.1, 0.14));
  });

  it("keeps the requested camera context even when the live snapshot does not expose it yet", () => {
    const snapshot = buildFixtureSnapshot();
    if (!snapshot.config) {
      throw new Error("Expected fixture snapshot to include an active config.");
    }

    const ptl2Camera = {
      ...snapshot.config.active.camera,
      id: "PTL2",
      name: "PTL2",
      levelId: snapshot.config.active.camera.levelId,
    };

    const active = {
      ...snapshot.config.active,
      cameraId: "PTL2",
      camera: ptl2Camera,
      cameras: [snapshot.config.active.camera, ptl2Camera],
    };
    const bundle = {
      active,
      versions: snapshot.config.versions,
    };

    const hydrated = buildEditableLotDefinition(bundle, snapshot, "PTL2");

    expect(hydrated.camera.id).toBe("PTL2");
    expect(hydrated.frames.every((frame) => frame.cameraId === "PTL2")).toBe(true);
    expect(hydrated.frames[0]?.id).toBe("PTL2-frame-01");
  });

  it("serializes observation polygons for the explicitly selected camera", () => {
    const lotDefinition = {
      ...sampleLotDefinition,
      camera: sampleLotDefinition.cameras[0],
      cameras: [
        sampleLotDefinition.cameras[0],
        {
          ...sampleLotDefinition.cameras[0],
          id: "PTL2",
          name: "PTL2",
        },
      ],
      slots: sampleLotDefinition.slots.map((slot) => ({
        ...slot,
        imagePolygon: slot.id === sampleLotDefinition.slots[0]?.id
          ? ([
              [0.11, 0.12],
              [0.24, 0.12],
              [0.24, 0.28],
              [0.11, 0.28],
            ] as [number, number][])
          : slot.imagePolygon,
      })),
    };

    const config = lotDefinitionToSpatialConfig(lotDefinition, {
      cameraId: "PTL2",
      version: 3,
      status: "draft",
    });

    expect(config.cameraId).toBe("PTL2");
    expect(config.camera.id).toBe("PTL2");
    expect(config.lines.some((line) => line.cameraId === "PTL2")).toBe(true);
    const selectedCameraPolygon = config.observationPolygons.find(
      (polygon) => polygon.cameraId === "PTL2" && polygon.canonicalBayId === lotDefinition.slots[0]?.id,
    );
    expect(selectedCameraPolygon?.imagePolygon).toEqual(lotDefinition.slots[0]?.imagePolygon);
    expect(selectedCameraPolygon?.notes).toBe("coord-space:frame");
  });

  it("persists the global matrix while updating overlays for the selected camera", () => {
    const [firstSlot, secondSlot] = sampleLotDefinition.slots;
    if (!firstSlot || !secondSlot) {
      throw new Error("Expected fixture slots.");
    }

    const lotDefinition = {
      ...sampleLotDefinition,
      camera: {
        ...sampleLotDefinition.camera,
        id: "PTL2",
        name: "PTL2",
      },
      cameras: [
        sampleLotDefinition.camera,
        {
          ...sampleLotDefinition.camera,
          id: "PTL2",
          name: "PTL2",
        },
      ],
      frames: [
        { ...sampleLotDefinition.frames[0], cameraId: sampleLotDefinition.camera.id },
        { ...sampleLotDefinition.frames[0], id: "PTL2-frame-01", cameraId: "PTL2" },
      ],
      slots: [
        {
          ...firstSlot,
          cameraId: sampleLotDefinition.camera.id,
          partitionId: "ZONE-A",
          levelId: "PLANE-01",
          imagePolygonDefined: false,
        },
        { ...secondSlot, cameraId: "PTL2", partitionId: "ZONE-B", levelId: "PLANE-01", imagePolygonDefined: true },
      ],
      partitions: [
        { id: "ZONE-A", name: "Zone A", levelId: "PLANE-01", order: 0, gridRows: 1, gridColumns: 1, ownerCameraIds: [sampleLotDefinition.camera.id], layoutPolygon: null },
        { id: "ZONE-B", name: "Zone B", levelId: "PLANE-01", order: 1, gridRows: 1, gridColumns: 1, ownerCameraIds: ["PTL2"], layoutPolygon: null },
      ],
      observationPolygons: [
        {
          id: `obs-${sampleLotDefinition.camera.id}-${firstSlot.id}`,
          cameraId: sampleLotDefinition.camera.id,
          presetVersion: 1,
          canonicalBayId: firstSlot.id,
          imagePolygon: firstSlot.imagePolygon,
          enabled: true,
          priority: 1,
          notes: null,
        },
        {
          id: `obs-PTL2-${secondSlot.id}`,
          cameraId: "PTL2",
          presetVersion: 1,
          canonicalBayId: secondSlot.id,
          imagePolygon: secondSlot.imagePolygon,
          enabled: true,
          priority: 1,
          notes: null,
        },
      ],
    };

    const config = lotDefinitionToSpatialConfig(lotDefinition, {
      cameraId: "PTL2",
      version: 4,
      status: "draft",
    });

    expect(config.frames.map((frame) => frame.cameraId)).toEqual([sampleLotDefinition.camera.id, "PTL2"]);
    expect(config.bays.map((bay) => bay.id)).toEqual([firstSlot.id, secondSlot.id]);
    expect(config.observationPolygons.map((polygon) => `${polygon.cameraId}:${polygon.canonicalBayId}`)).toEqual([
      `${sampleLotDefinition.camera.id}:${firstSlot.id}`,
      `PTL2:${secondSlot.id}`,
    ]);
    expect(config.partitions.map((partition) => partition.id)).toEqual(["ZONE-A", "ZONE-B"]);
  });

  it("does not drop newly added bays when observation polygons are stale", () => {
    const [firstSlot, secondSlot] = sampleLotDefinition.slots;
    if (!firstSlot || !secondSlot) {
      throw new Error("Expected fixture slots.");
    }

    const lotDefinition = {
      ...sampleLotDefinition,
      camera: {
        ...sampleLotDefinition.camera,
        id: "PTL2",
        name: "PTL2",
      },
      cameras: [
        {
          ...sampleLotDefinition.camera,
          id: "PTL2",
          name: "PTL2",
        },
      ],
      frames: [{ ...sampleLotDefinition.frames[0], id: "PTL2-frame-01", cameraId: "PTL2" }],
      levels: [
        { ...sampleLotDefinition.levels[0], id: "PLANE-01", name: "Plane 01", index: 0 },
        { ...sampleLotDefinition.levels[0], id: "PLANE-02", name: "Plane 02", index: 1 },
      ],
      partitions: [
        { id: "ZONE-A", name: "Zone 01", levelId: "PLANE-01", order: 0, gridRows: 1, gridColumns: 2, ownerCameraIds: ["PTL2"], layoutPolygon: null },
        { id: "ZONE-B", name: "Zone 02", levelId: "PLANE-02", order: 0, gridRows: 1, gridColumns: 2, ownerCameraIds: ["PTL2"], layoutPolygon: null },
      ],
      slots: [
        { ...firstSlot, id: "B01", cameraId: "PTL2", partitionId: "ZONE-A", levelId: "PLANE-01", row: 0, column: 0 },
        { ...secondSlot, id: "B02", cameraId: "PTL2", partitionId: "ZONE-B", levelId: "PLANE-02", row: 0, column: 0 },
      ],
      observationPolygons: [
        {
          id: "obs-PTL2-B01",
          cameraId: "PTL2",
          presetVersion: 1,
          canonicalBayId: "B01",
          imagePolygon: firstSlot.imagePolygon,
          enabled: true,
          priority: 1,
          notes: null,
        },
      ],
    };

    const config = lotDefinitionToSpatialConfig(lotDefinition, {
      cameraId: "PTL2",
      version: 5,
      status: "draft",
    });

    expect(config.bays.map((bay) => bay.id)).toEqual(["B01", "B02"]);
    expect(config.partitions.map((partition) => partition.id)).toEqual(["ZONE-A", "ZONE-B"]);
    expect(config.levels.map((level) => level.id)).toEqual(["PLANE-01", "PLANE-02"]);
    expect(config.observationPolygons.map((polygon) => polygon.canonicalBayId)).toEqual(["B01", "B02"]);
  });

  it("keeps a camera without bindings free of ROIs until one is created", () => {
    const snapshot = buildFixtureSnapshot();
    if (!snapshot.config) {
      throw new Error("Expected fixture snapshot to include an active config.");
    }

    const primaryCamera = snapshot.config.active.camera;
    const secondaryCamera = {
      ...primaryCamera,
      id: "PTL2",
      name: "PTL2",
    };
    const active = {
      ...snapshot.config.active,
      cameras: [primaryCamera, secondaryCamera],
      observationPolygons: snapshot.config.active.observationPolygons
        .filter((polygon) => polygon.cameraId === primaryCamera.id)
        .slice(0, 1),
    };

    const lotDefinition = buildEditableLotDefinition(
      {
        active,
        versions: snapshot.config.versions,
      },
      snapshot,
      "PTL2",
    );

    expect(lotDefinition.observationPolygons.every((polygon) => polygon.cameraId !== "PTL2")).toBe(true);
    expect(lotDefinition.slots.every((slot) => slot.imagePolygonDefined === false)).toBe(true);
  });

  it("removes cleared ROIs from the selected camera while preserving other cameras", () => {
    const [firstSlot, secondSlot] = sampleLotDefinition.slots;
    if (!firstSlot || !secondSlot) {
      throw new Error("Expected fixture slots.");
    }

    const otherCameraId = sampleLotDefinition.camera.id;
    const currentCameraId = "PTL2";
    const clearedPlaceholder = createRectanglePolygon(0.5, 0.5, 0.11, 0.16);

    const config = lotDefinitionToSpatialConfig(
      {
        ...sampleLotDefinition,
        camera: {
          ...sampleLotDefinition.camera,
          id: currentCameraId,
          name: currentCameraId,
        },
        cameras: [
          sampleLotDefinition.camera,
          {
            ...sampleLotDefinition.camera,
            id: currentCameraId,
            name: currentCameraId,
          },
        ],
        slots: [
          {
            ...firstSlot,
            imagePolygon: clearedPlaceholder,
            imagePolygonDefined: false,
          },
          {
            ...secondSlot,
            cameraId: currentCameraId,
            imagePolygon: createRectanglePolygon(0.22, 0.24, 0.11, 0.16),
            imagePolygonDefined: true,
          },
        ],
        observationPolygons: [
          {
            id: `obs-${otherCameraId}-${firstSlot.id}`,
            cameraId: otherCameraId,
            presetVersion: 1,
            canonicalBayId: firstSlot.id,
            imagePolygon: firstSlot.imagePolygon,
            enabled: true,
            priority: 1,
            notes: null,
          },
          {
            id: `obs-${currentCameraId}-${firstSlot.id}`,
            cameraId: currentCameraId,
            presetVersion: 1,
            canonicalBayId: firstSlot.id,
            imagePolygon: createRectanglePolygon(0.15, 0.18, 0.11, 0.16),
            enabled: true,
            priority: 1,
            notes: null,
          },
        ],
      },
      {
        cameraId: currentCameraId,
        version: 7,
        status: "draft",
      },
    );

    expect(config.observationPolygons.map((polygon) => `${polygon.cameraId}:${polygon.canonicalBayId}`)).toEqual([
      `${otherCameraId}:${firstSlot.id}`,
      `${currentCameraId}:${secondSlot.id}`,
    ]);
  });

  it("preserves existing observation polygon metadata while marking frame-space notes", () => {
    const [firstSlot] = sampleLotDefinition.slots;
    if (!firstSlot) {
      throw new Error("Expected fixture slot.");
    }

    const lotDefinition = {
      ...sampleLotDefinition,
      camera: {
        ...sampleLotDefinition.camera,
        id: "PTL2",
        name: "PTL2",
      },
      cameras: [
        {
          ...sampleLotDefinition.camera,
          id: "PTL2",
          name: "PTL2",
        },
      ],
      frames: [{ ...sampleLotDefinition.frames[0], id: "PTL2-frame-01", cameraId: "PTL2" }],
      slots: [{ ...firstSlot, cameraId: "PTL2" }],
      observationPolygons: [
        {
          id: "custom-obs-id",
          cameraId: "PTL2",
          presetVersion: 1,
          canonicalBayId: firstSlot.id,
          imagePolygon: firstSlot.imagePolygon,
          enabled: false,
          priority: 9,
          notes: "operator-note",
        },
      ],
    };

    const config = lotDefinitionToSpatialConfig(lotDefinition, {
      cameraId: "PTL2",
      version: 6,
      status: "draft",
    });

    expect(config.observationPolygons[0]?.id).toBe("custom-obs-id");
    expect(config.observationPolygons[0]?.enabled).toBe(false);
    expect(config.observationPolygons[0]?.priority).toBe(9);
    expect(config.observationPolygons[0]?.notes).toBe("operator-note coord-space:frame");
  });
});
