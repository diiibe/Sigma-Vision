import type { LotDefinition } from "../data/types";

interface EditorSelectionInput {
  selectedSlotId: string | null;
  selectedLevelId: string | null;
  selectedPartitionId: string | null;
  selectedCameraId: string | null;
}

interface EditorSelectionResult {
  selectedSlotId: string | null;
  selectedLevelId: string | null;
  selectedPartitionId: string | null;
  selectedCameraId: string | null;
  currentFrameId: string;
}

export function resolveEditorSelection(
  lotDefinition: LotDefinition,
  currentSelection: EditorSelectionInput,
  preferredCameraId?: string | null,
): EditorSelectionResult {
  const selectedSlot =
    currentSelection.selectedSlotId
      ? lotDefinition.slots.find((slot) => slot.id === currentSelection.selectedSlotId) ?? null
      : null;
  const selectedPartition =
    currentSelection.selectedPartitionId
      ? lotDefinition.partitions.find((partition) => partition.id === currentSelection.selectedPartitionId) ?? null
      : null;
  const selectedLevel =
    currentSelection.selectedLevelId
      ? lotDefinition.levels.find((level) => level.id === currentSelection.selectedLevelId) ?? null
      : null;
  const resolvedCameraId =
    (preferredCameraId && lotDefinition.cameras.some((camera) => camera.id === preferredCameraId)
      ? preferredCameraId
      : null) ??
    (currentSelection.selectedCameraId &&
    lotDefinition.cameras.some((camera) => camera.id === currentSelection.selectedCameraId)
      ? currentSelection.selectedCameraId
      : null) ??
    lotDefinition.camera.id;

  const resolvedLevelId =
    selectedSlot?.levelId ??
    selectedPartition?.levelId ??
    selectedLevel?.id ??
    lotDefinition.levels[0]?.id ??
    null;
  const resolvedPartitionId =
    selectedSlot?.partitionId ??
    (selectedPartition && selectedPartition.levelId === resolvedLevelId ? selectedPartition.id : null) ??
    pickPartitionForLevel(lotDefinition, resolvedLevelId, resolvedCameraId)?.id ??
    lotDefinition.partitions.find((partition) => partition.levelId === resolvedLevelId)?.id ??
    lotDefinition.partitions[0]?.id ??
    null;

  return {
    selectedSlotId: selectedSlot?.id ?? null,
    selectedLevelId: resolvedLevelId,
    selectedPartitionId: resolvedPartitionId,
    selectedCameraId: resolvedCameraId,
    currentFrameId:
      lotDefinition.frames.find((frame) => frame.cameraId === resolvedCameraId)?.id ??
      lotDefinition.frames[0]?.id ??
      "",
  };
}

function pickPartitionForLevel(
  lotDefinition: LotDefinition,
  levelId: string | null,
  cameraId: string | null,
) {
  if (!levelId) {
    return null;
  }

  const partitions = lotDefinition.partitions
    .filter((partition) => partition.levelId === levelId)
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));

  if (partitions.length === 0) {
    return null;
  }

  if (cameraId) {
    const cameraPartition =
      partitions.find((partition) => partition.ownerCameraIds.includes(cameraId)) ??
      partitions.find((partition) =>
        lotDefinition.slots.some((slot) => slot.partitionId === partition.id && slot.cameraId === cameraId),
      );

    if (cameraPartition) {
      return cameraPartition;
    }
  }

  return partitions[0];
}
