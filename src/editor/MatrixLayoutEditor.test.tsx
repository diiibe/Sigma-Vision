import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createRectanglePolygon } from "../data/polygon";
import { syncLotDefinition } from "../data/lotMatrix";
import type { LotDefinition } from "../data/types";
import { MatrixLayoutEditor } from "./MatrixLayoutEditor";

function buildLot(): LotDefinition {
  return syncLotDefinition({
    facilityId: "demo",
    facilityName: "Demo lot",
    timeZone: "Europe/Rome",
    levelId: "PLANE-01",
    levelName: "Plane 01",
    sourceLotKey: "demo",
    camera: {
      id: "CAM-01",
      name: "Demo camera",
      levelId: "PLANE-01",
      location: "north",
      angle: "45deg",
    },
    cameras: [],
    frames: [],
    levels: [
      {
        id: "PLANE-01",
        name: "Plane 01",
        index: 0,
        gridRows: 1,
        gridColumns: 2,
      },
    ],
    slots: [
      {
        id: "B01",
        label: "Bay 01",
        row: 0,
        column: 0,
        levelId: "PLANE-01",
        partitionId: "PLANE-01-PART-A",
        cameraId: "CAM-01",
        imagePolygon: createRectanglePolygon(0.4, 0.5, 0.12, 0.16),
        layoutPolygon: createRectanglePolygon(0.4, 0.5, 0.12, 0.16),
        evCapable: false,
        reservedDefault: false,
      },
      {
        id: "B02",
        label: "Bay 02",
        row: 0,
        column: 0,
        levelId: "PLANE-01",
        partitionId: "PLANE-01-PART-B",
        cameraId: "CAM-01",
        imagePolygon: createRectanglePolygon(0.6, 0.5, 0.12, 0.16),
        layoutPolygon: createRectanglePolygon(0.6, 0.5, 0.12, 0.16),
        evCapable: false,
        reservedDefault: false,
      },
    ],
    partitions: [
      {
        id: "PLANE-01-PART-A",
        name: "Zone A",
        levelId: "PLANE-01",
        order: 0,
        gridRows: 1,
        gridColumns: 2,
        ownerCameraIds: ["CAM-01"],
        layoutPolygon: null,
      },
      {
        id: "PLANE-01-PART-B",
        name: "Zone B",
        levelId: "PLANE-01",
        order: 1,
        gridRows: 1,
        gridColumns: 2,
        ownerCameraIds: ["CAM-01"],
        layoutPolygon: null,
      },
    ],
    observationPolygons: [
      {
        id: "obs-01",
        cameraId: "CAM-01",
        presetVersion: 1,
        canonicalBayId: "B01",
        imagePolygon: createRectanglePolygon(0.4, 0.5, 0.12, 0.16),
        enabled: true,
        priority: 1,
        notes: null,
      },
      {
        id: "obs-02",
        cameraId: "CAM-01",
        presetVersion: 1,
        canonicalBayId: "B02",
        imagePolygon: createRectanglePolygon(0.6, 0.5, 0.12, 0.16),
        enabled: true,
        priority: 1,
        notes: null,
      },
    ],
  });
}

describe("MatrixLayoutEditor", () => {
  beforeAll(() => {
    if (!("PointerEvent" in globalThis)) {
      globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
    }
    if (!("scrollIntoView" in HTMLElement.prototype)) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: vi.fn(),
      });
    }
  });

  it("renders plane and zone navigation with one matrix per visible zone", () => {
    render(
      <MatrixLayoutEditor
        lotDefinition={buildLot()}
        selectedCameraId="CAM-01"
        selectedLevelId="PLANE-01"
        selectedPartitionId="PLANE-01-PART-A"
        selectedSlotId={null}
        onSelectLevel={vi.fn()}
        onSelectPartition={vi.fn()}
        onSelectSlot={vi.fn()}
        onCreateSlot={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("button", { name: "Add bay" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Bay 01/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Plane 01/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Zone A/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Zone B/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Zone A matrix/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Zone B matrix/i)).toBeInTheDocument();
  });

  it("selects and focuses a zone matrix when its zone tab is clicked", () => {
    const onSelectLevel = vi.fn();
    const onSelectPartition = vi.fn();

    render(
      <MatrixLayoutEditor
        lotDefinition={buildLot()}
        selectedCameraId="CAM-01"
        selectedLevelId="PLANE-01"
        selectedPartitionId="PLANE-01-PART-A"
        selectedSlotId={null}
        onSelectLevel={onSelectLevel}
        onSelectPartition={onSelectPartition}
        onSelectSlot={vi.fn()}
        onCreateSlot={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /Zone B/i }));

    expect(onSelectLevel).toHaveBeenCalledWith("PLANE-01");
    expect(onSelectPartition).toHaveBeenCalledWith("PLANE-01-PART-B");
  });

  it("falls back to zone labels when a zone name mirrors the plane name", () => {
    const lot = buildLot();
    lot.partitions = lot.partitions.map((partition, index) => ({
      ...partition,
      name: index === 0 ? "Plane 01" : partition.name,
    }));

    render(
      <MatrixLayoutEditor
        lotDefinition={lot}
        selectedCameraId="CAM-01"
        selectedLevelId="PLANE-01"
        selectedPartitionId="PLANE-01-PART-A"
        selectedSlotId={null}
        onSelectLevel={vi.fn()}
        onSelectPartition={vi.fn()}
        onSelectSlot={vi.fn()}
        onCreateSlot={vi.fn()}
      />,
    );

    expect(screen.getByRole("tab", { name: /Zone 01/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Zone 01 matrix/i)).toBeInTheDocument();
  });

  it("deselects the active bay when its matrix tile is clicked again", () => {
    const onSelectSlot = vi.fn();

    render(
      <MatrixLayoutEditor
        lotDefinition={buildLot()}
        selectedCameraId="CAM-01"
        selectedLevelId="PLANE-01"
        selectedPartitionId="PLANE-01-PART-A"
        selectedSlotId="B01"
        onSelectLevel={vi.fn()}
        onSelectPartition={vi.fn()}
        onSelectSlot={onSelectSlot}
        onCreateSlot={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Bay 01/i }));

    expect(onSelectSlot).toHaveBeenCalledWith(null);
  });

  it("pans the matrix viewport when dragging the plane background", () => {
    const { container } = render(
      <MatrixLayoutEditor
        lotDefinition={syncLotDefinition({
          ...buildLot(),
          levels: [
            {
              id: "PLANE-01",
              name: "Plane 01",
              index: 0,
              gridRows: 10,
              gridColumns: 14,
            },
          ],
        })}
        selectedCameraId="CAM-01"
        selectedLevelId="PLANE-01"
        selectedPartitionId="PLANE-01-PART-A"
        selectedSlotId={null}
        onSelectLevel={vi.fn()}
        onSelectPartition={vi.fn()}
        onSelectSlot={vi.fn()}
        onCreateSlot={vi.fn()}
      />,
    );

    const viewport = container.querySelector(".matrix-editor__viewport") as HTMLDivElement;
    const stage = container.querySelector(".matrix-editor__stage") as HTMLDivElement;

    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 320 });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 220 });
    Object.defineProperty(viewport, "scrollWidth", { configurable: true, value: 1120 });
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 860 });
    Object.defineProperty(viewport, "scrollLeft", { configurable: true, writable: true, value: 180 });
    Object.defineProperty(viewport, "scrollTop", { configurable: true, writable: true, value: 140 });

    fireEvent.pointerDown(stage, { clientX: 150, clientY: 120 });
    fireEvent.pointerMove(window, { clientX: 210, clientY: 165 });
    fireEvent.pointerUp(window);

    expect(viewport.scrollLeft).toBe(120);
    expect(viewport.scrollTop).toBe(95);
  });
});
