import { createFrameDefinition, syncLotDefinition } from "./lotMatrix";
import type {
  LayoutPartitionDefinition,
  LotCameraDefinition,
  LotDefinition,
  LotFrameDefinition,
  LotLevelDefinition,
} from "./types";

export const DEFAULT_STARTER_CAMERA_ID = "CAM-01";

interface BlankLotDefinitionOptions {
  facilityId?: string;
  facilityName?: string;
  timeZone?: string;
  cameras?: LotCameraDefinition[];
  frames?: LotFrameDefinition[];
}

export function createBlankLotDefinition(
  cameraId = DEFAULT_STARTER_CAMERA_ID,
  options: BlankLotDefinitionOptions = {},
): LotDefinition {
  const level: LotLevelDefinition = {
    id: "PLANE-01",
    name: "Plane 01",
    index: 0,
    gridRows: 1,
    gridColumns: 4,
  };
  const partition: LayoutPartitionDefinition = {
    id: `${level.id}-PART-01`,
    name: "Zone 01",
    levelId: level.id,
    order: 0,
    gridRows: 1,
    gridColumns: 4,
    ownerCameraIds: [],
    layoutPolygon: null,
  };
  const candidateCameras = options.cameras?.length
    ? options.cameras
    : [
        {
          id: cameraId,
          name: cameraId,
          levelId: level.id,
          location: "Unassigned view",
          angle: "fixed view",
        } satisfies LotCameraDefinition,
      ];
  const normalizedCameras = Array.from(
    new Map(
      candidateCameras.map((entry, index) => [
        entry.id || `${DEFAULT_STARTER_CAMERA_ID}-${index + 1}`,
        {
          ...entry,
          id: entry.id || `${DEFAULT_STARTER_CAMERA_ID}-${index + 1}`,
          name: entry.name || entry.id || `${DEFAULT_STARTER_CAMERA_ID}-${index + 1}`,
          levelId: level.id,
          location: entry.location || "Unassigned view",
          angle: entry.angle || "fixed view",
        } satisfies LotCameraDefinition,
      ]),
    ).values(),
  );
  const fallbackCamera: LotCameraDefinition = {
    id: cameraId,
    name: cameraId,
    levelId: level.id,
    location: "Unassigned view",
    angle: "fixed view",
  };
  const cameras = normalizedCameras.length > 0 ? normalizedCameras : [fallbackCamera];
  const camera =
    cameras.find((entry) => entry.id === cameraId) ??
    cameras[0] ??
    fallbackCamera;
  const frames = cameras.flatMap((entry, index) => {
    const matchingFrames =
      options.frames?.filter((frame) => frame.cameraId === entry.id).map((frame) => ({
        ...frame,
        cameraId: entry.id,
      })) ?? [];

    if (matchingFrames.length > 0) {
      return matchingFrames;
    }

    return [
      createFrameDefinition(entry.id, index, {
        cameraId: entry.id,
      }),
    ];
  });

  return syncLotDefinition({
    facilityId: options.facilityId ?? "facility",
    facilityName: options.facilityName ?? "Parking Control",
    timeZone: options.timeZone ?? "Europe/Rome",
    levelId: level.id,
    levelName: level.name,
    levels: [level],
    sourceLotKey: "bootstrap:blank",
    camera,
    cameras,
    frames,
    partitions: [partition],
    observationPolygons: [],
    slots: [],
  });
}
