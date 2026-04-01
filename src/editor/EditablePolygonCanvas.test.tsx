import { act, fireEvent, render } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createRectanglePolygon } from "../data/polygon";
import type { LotSlotDefinition } from "../data/types";
import { EditablePolygonCanvas } from "./EditablePolygonCanvas";

function buildSlot(overrides?: Partial<LotSlotDefinition>): LotSlotDefinition {
  return {
    id: "B01",
    label: "Bay 01",
    row: 0,
    column: 0,
    ...overrides,
    levelId: overrides?.levelId ?? "PLANE-01",
    partitionId: overrides?.partitionId ?? "PLANE-01-PART-A",
    cameraId: overrides?.cameraId ?? "CAM-01",
    imagePolygon: overrides?.imagePolygon ?? createRectanglePolygon(0.45, 0.52, 0.18, 0.22),
    layoutPolygon: overrides?.layoutPolygon ?? createRectanglePolygon(0.45, 0.52, 0.18, 0.22),
    evCapable: overrides?.evCapable ?? false,
    reservedDefault: overrides?.reservedDefault ?? false,
  };
}

describe("EditablePolygonCanvas", () => {
  beforeAll(() => {
    if (!("PointerEvent" in globalThis)) {
      globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
    }
  });

  it("applies a pinch-style zoom increment when the gesture is reported through the viewport", () => {
    const onZoomChange = vi.fn();
    const { container } = render(
      <EditablePolygonCanvas
        title="Image calibration"
        subtitle="Testing"
        slots={[buildSlot()]}
        selectedSlotId={null}
        variant="image"
        backgroundImageUrl="/frame.png"
        zoom={1}
        onSelectSlot={vi.fn()}
        onMoveVertex={vi.fn()}
        onZoomChange={onZoomChange}
      />,
    );

    const viewport = container.querySelector(".editor-canvas__viewport") as HTMLDivElement;
    const zoomLayer = container.querySelector(".editor-canvas__zoom-layer") as HTMLDivElement;

    zoomLayer.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 500,
        height: 320,
        right: 500,
        bottom: 320,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    act(() => {
      fireEvent.wheel(viewport, { clientX: 220, clientY: 120, deltaY: -40, ctrlKey: true });
    });

    expect(onZoomChange).toHaveBeenCalledWith(1.045);
  });

  it("ignores ordinary mouse-wheel scrolling for zooming", () => {
    const onZoomChange = vi.fn();
    const { container } = render(
      <EditablePolygonCanvas
        title="Image calibration"
        subtitle="Testing"
        slots={[buildSlot()]}
        selectedSlotId={null}
        variant="image"
        backgroundImageUrl="/frame.png"
        zoom={1}
        onSelectSlot={vi.fn()}
        onMoveVertex={vi.fn()}
        onZoomChange={onZoomChange}
      />,
    );

    const viewport = container.querySelector(".editor-canvas__viewport") as HTMLDivElement;

    act(() => {
      fireEvent.wheel(viewport, { clientX: 220, clientY: 120, deltaY: -40 });
    });

    expect(onZoomChange).not.toHaveBeenCalled();
  });

  it("pans the image with drag in navigate mode without selecting or moving polygons", () => {
    const onSelectSlot = vi.fn();
    const onMoveVertex = vi.fn();
    const { container } = render(
      <EditablePolygonCanvas
        title="Image calibration"
        subtitle="Testing"
        slots={[buildSlot()]}
        selectedSlotId={null}
        variant="image"
        backgroundImageUrl="/frame.png"
        zoom={2}
        onSelectSlot={onSelectSlot}
        onMoveVertex={onMoveVertex}
        onZoomChange={vi.fn()}
      />,
    );

    const viewport = container.querySelector(".editor-canvas__viewport") as HTMLDivElement;
    const zoomLayer = container.querySelector(".editor-canvas__zoom-layer") as HTMLDivElement;
    const polygon = container.querySelector(".editor-canvas__polygon") as SVGPathElement;

    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 240 });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 140 });
    Object.defineProperty(viewport, "scrollLeft", { configurable: true, writable: true, value: 60 });
    Object.defineProperty(viewport, "scrollTop", { configurable: true, writable: true, value: 40 });
    Object.defineProperty(zoomLayer, "clientWidth", { configurable: true, value: 800 });
    Object.defineProperty(zoomLayer, "clientHeight", { configurable: true, value: 480 });

    act(() => {
      fireEvent.pointerDown(polygon, { clientX: 100, clientY: 80 });
      fireEvent.pointerMove(window, { clientX: 130, clientY: 95 });
      fireEvent.pointerUp(window);
    });

    expect(viewport.scrollLeft).toBe(30);
    expect(viewport.scrollTop).toBe(25);
    expect(onSelectSlot).not.toHaveBeenCalled();
    expect(onMoveVertex).not.toHaveBeenCalled();
  });

  it("still translates polygons with a normal drag when pan mode is not armed", () => {
    const onTranslatePolygon = vi.fn();
    const { container } = render(
      <EditablePolygonCanvas
        title="Image calibration"
        subtitle="Testing"
        slots={[buildSlot()]}
        selectedSlotId="B01"
        variant="image"
        backgroundImageUrl="/frame.png"
        zoom={1}
        interactionMode="edit"
        onSelectSlot={vi.fn()}
        onMoveVertex={vi.fn()}
        onTranslatePolygon={onTranslatePolygon}
      />,
    );

    const svg = container.querySelector(".editor-canvas__svg") as SVGSVGElement;
    const polygon = container.querySelector(".editor-canvas__polygon") as SVGPathElement;

    svg.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 1000,
        height: 640,
        right: 1000,
        bottom: 640,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    act(() => {
      fireEvent.pointerDown(polygon, { clientX: 400, clientY: 300 });
      fireEvent.pointerMove(window, { clientX: 420, clientY: 316 });
      fireEvent.pointerUp(window);
    });

    expect(onTranslatePolygon).toHaveBeenCalledWith("B01", 0.02, 0.025);
  });

  it("disables wheel zoom while polygon editing mode is active", () => {
    const onZoomChange = vi.fn();
    const { container } = render(
      <EditablePolygonCanvas
        title="Image calibration"
        subtitle="Testing"
        slots={[buildSlot()]}
        selectedSlotId="B01"
        variant="image"
        backgroundImageUrl="/frame.png"
        zoom={1.5}
        interactionMode="edit"
        onSelectSlot={vi.fn()}
        onMoveVertex={vi.fn()}
        onZoomChange={onZoomChange}
      />,
    );

    const viewport = container.querySelector(".editor-canvas__viewport") as HTMLDivElement;

    act(() => {
      fireEvent.wheel(viewport, { clientX: 120, clientY: 80, deltaY: -40 });
    });

    expect(onZoomChange).not.toHaveBeenCalled();
  });

  it("recenters the viewport when the reset key changes", () => {
    const { container, rerender } = render(
      <EditablePolygonCanvas
        title="Image calibration"
        subtitle="Testing"
        slots={[buildSlot()]}
        selectedSlotId={null}
        variant="image"
        backgroundImageUrl="/frame.png"
        zoom={1.8}
        viewResetKey={0}
        onSelectSlot={vi.fn()}
        onMoveVertex={vi.fn()}
        onZoomChange={vi.fn()}
      />,
    );

    const viewport = container.querySelector(".editor-canvas__viewport") as HTMLDivElement;
    const zoomLayer = container.querySelector(".editor-canvas__zoom-layer") as HTMLDivElement;

    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 200 });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 120 });
    Object.defineProperty(viewport, "scrollLeft", { configurable: true, writable: true, value: 90 });
    Object.defineProperty(viewport, "scrollTop", { configurable: true, writable: true, value: 70 });
    Object.defineProperty(zoomLayer, "clientWidth", { configurable: true, value: 800 });
    Object.defineProperty(zoomLayer, "clientHeight", { configurable: true, value: 480 });

    act(() => {
      rerender(
        <EditablePolygonCanvas
          title="Image calibration"
          subtitle="Testing"
          slots={[buildSlot()]}
          selectedSlotId={null}
          variant="image"
          backgroundImageUrl="/frame.png"
          zoom={1}
          viewResetKey={1}
          onSelectSlot={vi.fn()}
          onMoveVertex={vi.fn()}
          onZoomChange={vi.fn()}
        />,
      );
    });

    expect(viewport.scrollLeft).toBe(300);
    expect(viewport.scrollTop).toBe(180);
  });
});
