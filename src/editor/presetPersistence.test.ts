import { describe, expect, it } from "vitest";
import { presetIdToVersion, resolvePresetSaveResolution } from "./presetPersistence";

describe("presetPersistence", () => {
  it("parses preset ids into version numbers", () => {
    expect(presetIdToVersion("preset-7")).toBe(7);
    expect(presetIdToVersion("draft-7")).toBeNull();
    expect(presetIdToVersion(null)).toBeNull();
  });

  it("updates the same version when saving a persisted draft preset", () => {
    expect(
      resolvePresetSaveResolution({
        isPersistedPreset: true,
        currentVersion: 4,
        activeVersion: 2,
        maxVersion: 5,
        selectedCreatedAt: "2026-03-23T10:00:00.000Z",
        selectedActivatedAt: null,
        now: "2026-03-23T12:00:00.000Z",
        cameraId: "PTL2",
      }),
    ).toEqual({
      targetVersion: 4,
      shouldForkActivePreset: false,
      createdAt: "2026-03-23T10:00:00.000Z",
      activatedAt: null,
      copiedFromCameraId: null,
      copiedFromVersion: null,
    });
  });

  it("forks a new draft when saving the currently active preset", () => {
    expect(
      resolvePresetSaveResolution({
        isPersistedPreset: true,
        currentVersion: 3,
        activeVersion: 3,
        maxVersion: 5,
        selectedCreatedAt: "2026-03-23T10:00:00.000Z",
        selectedActivatedAt: "2026-03-23T11:00:00.000Z",
        now: "2026-03-23T12:00:00.000Z",
        cameraId: "PL2.1",
      }),
    ).toEqual({
      targetVersion: 6,
      shouldForkActivePreset: true,
      createdAt: "2026-03-23T12:00:00.000Z",
      activatedAt: null,
      copiedFromCameraId: "PL2.1",
      copiedFromVersion: 3,
    });
  });
});
