export interface PresetSaveResolutionInput {
  isPersistedPreset: boolean;
  currentVersion: number;
  activeVersion: number | null;
  maxVersion: number;
  selectedCreatedAt: string;
  selectedActivatedAt: string | null;
  now: string;
  cameraId: string;
}

export interface PresetSaveResolution {
  targetVersion: number;
  shouldForkActivePreset: boolean;
  createdAt: string;
  activatedAt: string | null;
  copiedFromCameraId: string | null;
  copiedFromVersion: number | null;
}

export function presetIdToVersion(presetId: string | null | undefined): number | null {
  if (!presetId) {
    return null;
  }

  const match = presetId.match(/^preset-(\d+)$/);
  if (!match) {
    return null;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolvePresetSaveResolution({
  isPersistedPreset,
  currentVersion,
  activeVersion,
  maxVersion,
  selectedCreatedAt,
  selectedActivatedAt,
  now,
  cameraId,
}: PresetSaveResolutionInput): PresetSaveResolution {
  const shouldForkActivePreset = isPersistedPreset && activeVersion === currentVersion;
  const targetVersion =
    isPersistedPreset && !shouldForkActivePreset ? currentVersion : maxVersion + 1;

  return {
    targetVersion,
    shouldForkActivePreset,
    createdAt: isPersistedPreset && !shouldForkActivePreset ? selectedCreatedAt : now,
    activatedAt:
      isPersistedPreset && !shouldForkActivePreset ? selectedActivatedAt ?? null : null,
    copiedFromCameraId: shouldForkActivePreset ? cameraId : null,
    copiedFromVersion: shouldForkActivePreset ? currentVersion : null,
  };
}
