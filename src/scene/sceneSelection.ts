import type { SlotStatus } from "../data/types";

interface SlotHighlightOptions {
  slotId: string;
  slotStatus: SlotStatus;
  selectedSlotId: string | null;
  hoveredSlotId: string | null;
  cameraRelevantSlotIds: string[];
  activeFilters: Record<SlotStatus, boolean>;
}

export function isSceneSlotHighlighted({
  slotId,
  slotStatus,
  selectedSlotId,
  hoveredSlotId,
  cameraRelevantSlotIds,
  activeFilters,
}: SlotHighlightOptions) {
  if (selectedSlotId === slotId || hoveredSlotId === slotId) {
    return true;
  }

  if (!activeFilters[slotStatus]) {
    return false;
  }

  return cameraRelevantSlotIds.includes(slotId);
}
