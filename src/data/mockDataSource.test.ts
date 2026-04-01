import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildInitialSnapshot,
  createMockParkingDataSource,
  findSlotById,
  flattenSlots,
} from "./mockDataSource";

describe("mock parking data source", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds a deterministic seeded snapshot with derived metrics", () => {
    const snapshot = buildInitialSnapshot(26);
    const slots = flattenSlots(snapshot.levels);
    const occupied = slots.filter((slot) => slot.status === "occupied").length;
    const free = slots.filter((slot) => slot.status === "free").length;
    const ev = slots.filter((slot) => slot.status === "ev").length;
    const reserved = slots.filter((slot) => slot.status === "reserved").length;

    expect(snapshot.levels).toHaveLength(5);
    expect(snapshot.cameras).toHaveLength(5);
    expect(snapshot.events).toHaveLength(10);
    expect(snapshot.metrics.totalSlots).toBe(80);
    expect(snapshot.metrics.occupiedSlots).toBe(occupied);
    expect(snapshot.metrics.freeSlots).toBe(free);
    expect(snapshot.metrics.evSlots).toBe(ev);
    expect(snapshot.metrics.reservedSlots).toBe(reserved);
  });

  it("mutates slot state through runtime actions and appends events", () => {
    const runtime = createMockParkingDataSource(26, 60_000);
    const initialSnapshot = runtime.dataSource.getSnapshot();
    const freeSlot = flattenSlots(initialSnapshot.levels).find(
      (slot) => slot.status === "free",
    );

    expect(freeSlot).toBeTruthy();
    runtime.actions.reserveSlot(freeSlot!.id);

    const reservedSnapshot = runtime.dataSource.getSnapshot();
    expect(findSlotById(reservedSnapshot.levels, freeSlot!.id)?.status).toBe("reserved");
    expect(reservedSnapshot.events[0]?.slotId).toBe(freeSlot!.id);

    runtime.actions.markAvailable(freeSlot!.id);

    const availableSnapshot = runtime.dataSource.getSnapshot();
    expect(findSlotById(availableSnapshot.levels, freeSlot!.id)?.status).toBe("free");
    expect(availableSnapshot.events[0]?.type).toBe("slot_released");

    runtime.destroy();
  });

  it("notifies subscribers when live activity ticks", () => {
    vi.useFakeTimers();
    const runtime = createMockParkingDataSource(26, 1_000);
    const listener = vi.fn();

    runtime.dataSource.subscribe(listener);

    vi.advanceTimersByTime(1_000);

    expect(listener).toHaveBeenCalledTimes(1);
    runtime.destroy();
  });
});
