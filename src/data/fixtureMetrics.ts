import { flattenSlots } from "./dashboardUtils";
import type { FacilityMetrics, ParkingLevel, SystemEvent } from "./types";

export function deriveFixtureMetrics(
  levels: ParkingLevel[],
  events: SystemEvent[],
): FacilityMetrics {
  const totalSlots = flattenSlots(levels).length;
  const levelStats = levels.map((level) => {
    const occupied = level.slots.filter((slot) => slot.status === "occupied").length;
    const free = level.slots.filter((slot) => slot.status === "free").length;
    const ev = level.slots.filter((slot) => slot.status === "ev").length;
    const reserved = level.slots.filter((slot) => slot.status === "reserved").length;
    const unknownSlots = level.slots.filter((slot) => slot.status === "unknown").length;
    const knownSlots = Math.max(level.slots.length - unknownSlots, 0);

    return {
      levelId: level.id,
      name: level.name,
      occupied,
      free,
      ev,
      reserved,
      unknownSlots,
      occupancyRate: knownSlots > 0 ? (occupied + ev) / knownSlots : 0,
    };
  });

  const occupiedSlots = levelStats.reduce((sum, level) => sum + level.occupied, 0);
  const evSlots = levelStats.reduce((sum, level) => sum + level.ev, 0);
  const reservedSlots = levelStats.reduce((sum, level) => sum + level.reserved, 0);
  const freeSlots = levelStats.reduce((sum, level) => sum + level.free, 0);
  const unknownSlots = levelStats.reduce((sum, level) => sum + level.unknownSlots, 0);
  const knownSlots = Math.max(totalSlots - unknownSlots, 0);
  const onlineSensors = flattenSlots(levels).filter(
    (slot) => slot.sensorState !== "offline",
  ).length;
  const flaggedEvents = events.filter((event) => event.severity !== "info").length;

  return {
    totalSlots,
    occupiedSlots,
    freeSlots,
    evSlots,
    reservedSlots,
    unknownSlots,
    occupancyRate: knownSlots > 0 ? (occupiedSlots + evSlots) / knownSlots : 0,
    onlineSensors,
    flaggedEvents,
    levelStats,
  };
}
