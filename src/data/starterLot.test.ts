import { describe, expect, it } from "vitest";
import { createBlankLotDefinition } from "./starterLot";

describe("createBlankLotDefinition", () => {
  it("preserves deployment cameras and frames while resetting the layout", () => {
    const blank = createBlankLotDefinition("CAM-02", {
      facilityId: "facility-x",
      facilityName: "Warehouse X",
      timeZone: "Europe/Rome",
      cameras: [
        {
          id: "CAM-01",
          name: "Camera 01",
          levelId: "LEGACY",
          location: "North",
          angle: "fixed",
        },
        {
          id: "CAM-02",
          name: "Camera 02",
          levelId: "LEGACY",
          location: "South",
          angle: "fixed",
        },
      ],
      frames: [
        {
          id: "CAM-01-frame-01",
          cameraId: "CAM-01",
          label: "Capture 1",
          imagePath: "/frames/cam-01.png",
          capturedAt: "2026-03-24T10:00:00Z",
          width: 1920,
          height: 1080,
        },
        {
          id: "CAM-02-frame-01",
          cameraId: "CAM-02",
          label: "Capture 1",
          imagePath: "/frames/cam-02.png",
          capturedAt: "2026-03-24T10:00:05Z",
          width: 1920,
          height: 1080,
        },
      ],
    });

    expect(blank.facilityId).toBe("facility-x");
    expect(blank.facilityName).toBe("Warehouse X");
    expect(blank.camera.id).toBe("CAM-02");
    expect(blank.cameras.map((camera) => camera.id)).toEqual(["CAM-01", "CAM-02"]);
    expect(blank.frames.map((frame) => frame.cameraId)).toEqual(["CAM-01", "CAM-02"]);
    expect(blank.levels).toHaveLength(1);
    expect(blank.partitions).toHaveLength(1);
    expect(blank.slots).toEqual([]);
    expect(blank.observationPolygons).toEqual([]);
  });
});
