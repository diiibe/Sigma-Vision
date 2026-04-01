import type { ParkingLevel } from "./types";

export function flattenSlots(levels: ParkingLevel[]) {
  return levels.flatMap((level) => level.slots);
}

export function findSlotById(levels: ParkingLevel[], slotId: string | null) {
  if (!slotId) {
    return null;
  }

  return flattenSlots(levels).find((slot) => slot.id === slotId) ?? null;
}
