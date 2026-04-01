import { create } from "zustand";
import type { SlotStatus } from "../data/types";

export type DashboardOverlayKey = "occupancyDwell" | "vehicleTurnover";

export interface DashboardOverlayState {
  occupancyDwell: boolean;
  vehicleTurnover: boolean;
}

export interface DashboardUiState {
  selectedSlotId: string | null;
  selectedLevelId: string | null;
  selectedCameraId: string | null;
  trackedSlotId: string | null;
  hoveredSlotId: string | null;
  isDetailCardOpen: boolean;
  activeFilters: Record<SlotStatus, boolean>;
  activeLevelIds: string[];
  activePartitionIds: string[];
  activeOverlays: DashboardOverlayState;
  setSelectedSlot(slotId: string | null): void;
  setSelectedLevel(levelId: string | null): void;
  setSelectedCamera(cameraId: string | null): void;
  setTrackedSlot(slotId: string | null): void;
  setHoveredSlot(slotId: string | null): void;
  setActiveLevelIds(levelIds: string[]): void;
  setActivePartitionIds(partitionIds: string[]): void;
  closeDetailCard(): void;
  toggleFilter(status: SlotStatus): void;
  toggleOverlay(key: DashboardOverlayKey): void;
  resetFilters(): void;
  resetState(): void;
}

const defaultFilters: Record<SlotStatus, boolean> = {
  free: true,
  occupied: true,
  ev: true,
  reserved: true,
  unknown: true,
};

const defaultOverlays: DashboardOverlayState = {
  occupancyDwell: false,
  vehicleTurnover: false,
};

const createInitialState = () => ({
  selectedSlotId: null,
  selectedLevelId: null,
  selectedCameraId: null,
  trackedSlotId: null,
  hoveredSlotId: null,
  isDetailCardOpen: false,
  activeFilters: { ...defaultFilters },
  activeLevelIds: [] as string[],
  activePartitionIds: [] as string[],
  activeOverlays: { ...defaultOverlays },
});

export const useDashboardStore = create<DashboardUiState>((set) => ({
  ...createInitialState(),
  setSelectedSlot(selectedSlotId) {
    set({ selectedSlotId, isDetailCardOpen: selectedSlotId !== null });
  },
  setSelectedLevel(selectedLevelId) {
    set({ selectedLevelId });
  },
  setSelectedCamera(selectedCameraId) {
    set({ selectedCameraId });
  },
  setTrackedSlot(trackedSlotId) {
    set({ trackedSlotId });
  },
  setHoveredSlot(hoveredSlotId) {
    set({ hoveredSlotId });
  },
  setActiveLevelIds(activeLevelIds) {
    set({ activeLevelIds });
  },
  setActivePartitionIds(activePartitionIds) {
    set({ activePartitionIds });
  },
  closeDetailCard() {
    set({ isDetailCardOpen: false });
  },
  toggleFilter(status) {
    set((state) => ({
      activeFilters: {
        ...state.activeFilters,
        [status]: !state.activeFilters[status],
      },
    }));
  },
  toggleOverlay(key) {
    set((state) => ({
      activeOverlays: {
        ...state.activeOverlays,
        [key]: !state.activeOverlays[key],
      },
    }));
  },
  resetFilters() {
    set({
      activeFilters: { ...defaultFilters },
      activeLevelIds: [],
      activePartitionIds: [],
    });
  },
  resetState() {
    set(createInitialState());
  },
}));

export function resetDashboardStore() {
  useDashboardStore.getState().resetState();
}
