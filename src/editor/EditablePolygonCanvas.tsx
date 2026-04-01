import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { polygonCentroid, polygonToPath } from "../data/polygon";
import type { CountingLineDefinition, DensityZoneDefinition, LotSlotDefinition } from "../data/types";

export interface CanvasCountingOverlay {
  countingLines?: CountingLineDefinition[];
  densityZones?: DensityZoneDefinition[];
  selectedCountingLineId?: string | null;
  selectedDensityZoneId?: string | null;
  onSelectCountingLine?(lineId: string | null): void;
  onSelectDensityZone?(zoneId: string | null): void;
  onMoveLineEndpoint?(lineId: string, endpointIndex: number, nextPoint: [number, number]): void;
  onMoveDensityZoneVertex?(zoneId: string, vertexIndex: number, nextPoint: [number, number]): void;
}

interface EditablePolygonCanvasProps {
  title: string;
  subtitle: string;
  slots: LotSlotDefinition[];
  selectedSlotId: string | null;
  backgroundImageUrl?: string;
  variant: "image" | "layout";
  interactionMode?: "navigate" | "edit";
  onSelectSlot(slotId: string | null): void;
  onMoveVertex(slotId: string, vertexIndex: number, nextPoint: [number, number]): void;
  onTranslatePolygon?(slotId: string, deltaX: number, deltaY: number): void;
  controls?: ReactNode;
  zoom?: number;
  viewResetKey?: number;
  onZoomChange?(zoom: number): void;
  countingOverlay?: CanvasCountingOverlay;
}

const VIEWPORT_WIDTH = 1000;
const VIEWPORT_HEIGHT = 640;
const MIN_ZOOM = 0.7;
const MAX_ZOOM = 3;
const DOUBLE_CLICK_ZOOM_FACTOR = 1.12;
const PINCH_ZOOM_SENSITIVITY = 0.0011;

export function EditablePolygonCanvas({
  title,
  subtitle,
  slots,
  selectedSlotId,
  backgroundImageUrl,
  variant,
  interactionMode = "navigate",
  onSelectSlot,
  onMoveVertex,
  onTranslatePolygon,
  controls,
  zoom = 1,
  viewResetKey = 0,
  onZoomChange,
  countingOverlay,
}: EditablePolygonCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const zoomLayerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<
    | { mode: "vertex"; slotId: string; vertexIndex: number }
    | { mode: "polygon"; slotId: string; lastX: number; lastY: number }
    | null
  >(null);
  const panningRef = useRef<
    | { startX: number; startY: number; startScrollLeft: number; startScrollTop: number }
    | null
  >(null);
  const pointerPositionsRef = useRef(new Map<number, { clientX: number; clientY: number }>());
  const pinchRef = useRef<{ startDistance: number; startZoom: number } | null>(null);
  const focusPointRef = useRef<[number, number]>([0.5, 0.5]);
  const pendingAnchorRef = useRef<
    | { ratioX: number; ratioY: number; pointerOffsetX: number; pointerOffsetY: number }
    | null
  >(null);
  const panMovedRef = useRef(false);
  const resetKeyRef = useRef(viewResetKey);
  const [viewportSize, setViewportSize] = useState({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
  const [isPanning, setIsPanning] = useState(false);

  const canNavigate = variant === "image" && interactionMode === "navigate";
  const canEdit = interactionMode === "edit";

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return undefined;
    }

    const updateSize = () => {
      setViewportSize({
        width: Math.max(viewport.clientWidth, 1),
        height: Math.max(viewport.clientHeight, 1),
      });
    };

    updateSize();

    const observer = new ResizeObserver(updateSize);
    observer.observe(viewport);

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (draggingRef.current && !slots.some((slot) => slot.id === draggingRef.current?.slotId)) {
      draggingRef.current = null;
    }

    if (selectedSlotId && !slots.some((slot) => slot.id === selectedSlotId)) {
      panningRef.current = null;
      setIsPanning(false);
    }
  }, [selectedSlotId, slots]);

  useEffect(() => {
    if (!canEdit) {
      draggingRef.current = null;
    }
    if (!canNavigate) {
      panningRef.current = null;
      pinchRef.current = null;
      pointerPositionsRef.current.clear();
      setIsPanning(false);
    }
  }, [canEdit, canNavigate]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (pointerPositionsRef.current.has(event.pointerId)) {
        pointerPositionsRef.current.set(event.pointerId, {
          clientX: event.clientX,
          clientY: event.clientY,
        });
      }

      if (pinchRef.current && canNavigate && onZoomChange) {
        const touchPoints = [...pointerPositionsRef.current.values()].slice(0, 2);
        if (touchPoints.length >= 2) {
          const centerX = (touchPoints[0].clientX + touchPoints[1].clientX) / 2;
          const centerY = (touchPoints[0].clientY + touchPoints[1].clientY) / 2;
          const distance = distanceBetweenPoints(touchPoints[0], touchPoints[1]);
          const scale = distance / Math.max(pinchRef.current.startDistance, 1);
          applyZoomFromEvent(centerX, centerY, pinchRef.current.startZoom * scale);
        }
        return;
      }

      const viewport = viewportRef.current;
      const layer = zoomLayerRef.current;
      if (panningRef.current && viewport && layer) {
        const movedX = Math.abs(event.clientX - panningRef.current.startX);
        const movedY = Math.abs(event.clientY - panningRef.current.startY);
        if (movedX > 2 || movedY > 2) {
          panMovedRef.current = true;
        }
        viewport.scrollLeft = clampScroll(
          panningRef.current.startScrollLeft - (event.clientX - panningRef.current.startX),
          layer.clientWidth - viewport.clientWidth,
        );
        viewport.scrollTop = clampScroll(
          panningRef.current.startScrollTop - (event.clientY - panningRef.current.startY),
          layer.clientHeight - viewport.clientHeight,
        );
        focusPointRef.current = deriveViewportCenterPoint(viewport, layer);
        setIsPanning(true);
        return;
      }

      const activeHandle = draggingRef.current;
      const svg = svgRef.current;

      if (!activeHandle || !svg || !canEdit) {
        return;
      }

      const rect = svg.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;

      if (activeHandle.mode === "vertex") {
        onMoveVertex(activeHandle.slotId, activeHandle.vertexIndex, [
          clamp01(x),
          clamp01(y),
        ]);
        return;
      }

      if (!onTranslatePolygon) {
        return;
      }

      const deltaX = (event.clientX - activeHandle.lastX) / rect.width;
      const deltaY = (event.clientY - activeHandle.lastY) / rect.height;
      draggingRef.current = {
        mode: "polygon",
        slotId: activeHandle.slotId,
        lastX: event.clientX,
        lastY: event.clientY,
      };
      onTranslatePolygon(activeHandle.slotId, deltaX, deltaY);
    };

    const stopDragging = (event: PointerEvent) => {
      if (pointerPositionsRef.current.has(event.pointerId)) {
        pointerPositionsRef.current.delete(event.pointerId);
      }
      if (pointerPositionsRef.current.size < 2) {
        pinchRef.current = null;
      }
      draggingRef.current = null;
      if (pointerPositionsRef.current.size === 0) {
        panningRef.current = null;
      }
      setIsPanning(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, [canEdit, canNavigate, onMoveVertex, onTranslatePolygon, onZoomChange, zoom]);

  const zoomSize = useMemo(() => {
    const viewportAspect = viewportSize.width / viewportSize.height;
    const sourceAspect = VIEWPORT_WIDTH / VIEWPORT_HEIGHT;
    const fitted =
      viewportAspect > sourceAspect
        ? {
            width: viewportSize.height * sourceAspect,
            height: viewportSize.height,
          }
        : {
            width: viewportSize.width,
            height: viewportSize.width / sourceAspect,
          };

    return {
      width: Math.max(160, fitted.width * zoom),
      height: Math.max(120, fitted.height * zoom),
    };
  }, [viewportSize.height, viewportSize.width, zoom]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const layer = zoomLayerRef.current;
    if (!viewport || !layer) {
      return;
    }

    if (resetKeyRef.current !== viewResetKey) {
      resetKeyRef.current = viewResetKey;
      focusPointRef.current = [0.5, 0.5];
      pendingAnchorRef.current = null;
      focusViewportAt(focusPointRef.current, viewport, layer);
      return;
    }

    const pendingAnchor = pendingAnchorRef.current;
    if (pendingAnchor) {
      viewport.scrollLeft = clampScroll(
        pendingAnchor.ratioX * layer.clientWidth - pendingAnchor.pointerOffsetX,
        layer.clientWidth - viewport.clientWidth,
      );
      viewport.scrollTop = clampScroll(
        pendingAnchor.ratioY * layer.clientHeight - pendingAnchor.pointerOffsetY,
        layer.clientHeight - viewport.clientHeight,
      );
      focusPointRef.current = [pendingAnchor.ratioX, pendingAnchor.ratioY];
      pendingAnchorRef.current = null;
      return;
    }

    focusViewportAt(focusPointRef.current, viewport, layer);
  }, [viewResetKey, zoomSize.height, zoomSize.width]);

  const setFocusPointFromClient = (clientX: number, clientY: number) => {
    const viewport = viewportRef.current;
    const zoomLayer = zoomLayerRef.current;
    if (!zoomLayer || !viewport) {
      return focusPointRef.current;
    }

    const rect = zoomLayer.getBoundingClientRect();
    const localX = clamp(clientX - rect.left, 0, rect.width);
    const localY = clamp(clientY - rect.top, 0, rect.height);
    const ratioX = clamp01((viewport.scrollLeft + localX) / Math.max(zoomLayer.clientWidth, 1));
    const ratioY = clamp01((viewport.scrollTop + localY) / Math.max(zoomLayer.clientHeight, 1));
    focusPointRef.current = [ratioX, ratioY];
    return focusPointRef.current;
  };

  const rememberAnchor = (clientX: number, clientY: number) => {
    const viewport = viewportRef.current;
    const zoomLayer = zoomLayerRef.current;
    if (!viewport || !zoomLayer) {
      return;
    }

    const viewportRect = viewport.getBoundingClientRect();
    const rect = zoomLayer.getBoundingClientRect();
    const localX = clamp(clientX - rect.left, 0, rect.width);
    const localY = clamp(clientY - rect.top, 0, rect.height);
    const pointerOffsetX = clamp(clientX - viewportRect.left, 0, viewport.clientWidth);
    const pointerOffsetY = clamp(clientY - viewportRect.top, 0, viewport.clientHeight);
    const ratioX = clamp01((viewport.scrollLeft + localX) / Math.max(zoomLayer.clientWidth, 1));
    const ratioY = clamp01((viewport.scrollTop + localY) / Math.max(zoomLayer.clientHeight, 1));

    focusPointRef.current = [ratioX, ratioY];
    pendingAnchorRef.current = {
      ratioX,
      ratioY,
      pointerOffsetX,
      pointerOffsetY,
    };
  };

  const applyZoomFromEvent = (clientX: number, clientY: number, nextZoom: number) => {
    if (!onZoomChange || !canNavigate) {
      return;
    }

    rememberAnchor(clientX, clientY);
    onZoomChange(clampZoom(nextZoom));
  };

  return (
    <section className="editor-canvas">
      <header className="editor-canvas__header">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      </header>

      <div className="editor-canvas__body">
        <div className={`editor-canvas__surface editor-canvas__surface--${variant}`}>
          <div
            ref={viewportRef}
            className={`editor-canvas__viewport ${
              canNavigate ? "is-pan-ready" : ""
            } ${isPanning ? "is-panning" : ""} ${canEdit ? "is-editing" : ""}`}
            onPointerDown={(event) => {
              if (canNavigate) {
                if (event.pointerType === "mouse" && event.button !== 0) {
                  return;
                }
                event.preventDefault();
                panMovedRef.current = false;
                pointerPositionsRef.current.set(event.pointerId, {
                  clientX: event.clientX,
                  clientY: event.clientY,
                });
                if (event.pointerType === "touch" && pointerPositionsRef.current.size >= 2) {
                  const touchPoints = [...pointerPositionsRef.current.values()].slice(0, 2);
                  pinchRef.current = {
                    startDistance: distanceBetweenPoints(touchPoints[0], touchPoints[1]),
                    startZoom: zoom,
                  };
                  panningRef.current = null;
                  setIsPanning(false);
                  return;
                }
                panningRef.current = {
                  startX: event.clientX,
                  startY: event.clientY,
                  startScrollLeft: event.currentTarget.scrollLeft,
                  startScrollTop: event.currentTarget.scrollTop,
                };
                setIsPanning(true);
                return;
              }

              const target = event.target as Element;
              const isBackgroundTarget =
                target === event.currentTarget ||
                target === svgRef.current ||
                target.classList.contains("editor-canvas__image");

              if (!isBackgroundTarget) {
                return;
              }

              onSelectSlot(null);
              setFocusPointFromClient(event.clientX, event.clientY);
            }}
            onPointerMove={(event) => {
              if (draggingRef.current || panningRef.current) {
                return;
              }

              setFocusPointFromClient(event.clientX, event.clientY);
            }}
            onDoubleClick={(event) => {
              if (!canNavigate) {
                return;
              }

              applyZoomFromEvent(event.clientX, event.clientY, zoom * DOUBLE_CLICK_ZOOM_FACTOR);
            }}
            onWheel={(event) => {
              if (!onZoomChange || !canNavigate || !event.ctrlKey) {
                return;
              }

              event.preventDefault();
              const nextZoom = zoom * Math.exp(-event.deltaY * PINCH_ZOOM_SENSITIVITY);
              applyZoomFromEvent(event.clientX, event.clientY, nextZoom);
            }}
          >
            <div
              ref={zoomLayerRef}
              className="editor-canvas__zoom-layer"
              style={{
                width: `${zoomSize.width}px`,
                height: `${zoomSize.height}px`,
              }}
            >
              {backgroundImageUrl ? (
                <img src={backgroundImageUrl} alt="" className="editor-canvas__image" />
              ) : null}

              <svg
                ref={svgRef}
                className="editor-canvas__svg"
                viewBox={`0 0 ${VIEWPORT_WIDTH} ${VIEWPORT_HEIGHT}`}
              >
                {variant === "layout" ? (
                  <>
                    <rect x="70" y="86" width="860" height="142" rx="22" className="editor-canvas__lane" />
                    <rect x="70" y="250" width="860" height="142" rx="22" className="editor-canvas__lane" />
                    <rect x="70" y="414" width="860" height="142" rx="22" className="editor-canvas__lane" />
                  </>
                ) : null}

                {slots.map((slot) => {
                  const polygon = variant === "image" ? slot.imagePolygon : slot.layoutPolygon;
                  const centroid = polygonCentroid(polygon);
                  const selected = selectedSlotId === slot.id;

                  return (
                    <g
                      key={slot.id}
                      className={`editor-canvas__slot ${selected ? "is-selected" : ""}`}
                      onClick={(event) => {
                        if (panMovedRef.current) {
                          event.preventDefault();
                          event.stopPropagation();
                          panMovedRef.current = false;
                          return;
                        }

                        onSelectSlot(slot.id);
                      }}
                    >
                      <path
                        d={polygonToPath(polygon, VIEWPORT_WIDTH, VIEWPORT_HEIGHT)}
                        className="editor-canvas__polygon"
                        onPointerDown={(event) => {
                          if (!canEdit) {
                            return;
                          }

                          event.preventDefault();
                          event.stopPropagation();
                          draggingRef.current = {
                            mode: "polygon",
                            slotId: slot.id,
                            lastX: event.clientX,
                            lastY: event.clientY,
                          };
                          onSelectSlot(slot.id);
                        }}
                      />
                      <text
                        x={centroid[0] * VIEWPORT_WIDTH}
                        y={centroid[1] * VIEWPORT_HEIGHT}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        className="editor-canvas__label"
                      >
                        {slot.label}
                      </text>
                      {polygon.map((point, vertexIndex) => (
                        <circle
                          key={`${slot.id}-${vertexIndex}`}
                          cx={point[0] * VIEWPORT_WIDTH}
                          cy={point[1] * VIEWPORT_HEIGHT}
                          r={selected ? 8 : 6}
                          className="editor-canvas__vertex"
                          onPointerDown={(event) => {
                            if (!canEdit) {
                              return;
                            }

                            event.preventDefault();
                            event.stopPropagation();
                            draggingRef.current = { mode: "vertex", slotId: slot.id, vertexIndex };
                            onSelectSlot(slot.id);
                          }}
                        />
                      ))}
                    </g>
                  );
                })}

                {countingOverlay?.densityZones
                  ?.filter((zone) => zone.enabled)
                  .map((zone) => {
                    const polygon = zone.imagePolygon;
                    if (polygon.length < 3) return null;
                    const selected = countingOverlay.selectedDensityZoneId === zone.id;
                    const centroid = polygonCentroid(polygon);
                    return (
                      <g
                        key={`dz-${zone.id}`}
                        className={`editor-canvas__density-zone ${selected ? "is-selected" : ""}`}
                        onClick={() => countingOverlay.onSelectDensityZone?.(zone.id)}
                      >
                        <path
                          d={polygonToPath(polygon, VIEWPORT_WIDTH, VIEWPORT_HEIGHT)}
                          className="editor-canvas__density-zone-fill"
                        />
                        <text
                          x={centroid[0] * VIEWPORT_WIDTH}
                          y={centroid[1] * VIEWPORT_HEIGHT}
                          textAnchor="middle"
                          dominantBaseline="middle"
                          className="editor-canvas__density-zone-label"
                        >
                          {zone.label}
                        </text>
                        {selected &&
                          polygon.map((point, vi) => (
                            <circle
                              key={`dz-v-${zone.id}-${vi}`}
                              cx={point[0] * VIEWPORT_WIDTH}
                              cy={point[1] * VIEWPORT_HEIGHT}
                              r={7}
                              className="editor-canvas__density-zone-vertex"
                              onPointerDown={(event) => {
                                if (!canEdit || !countingOverlay.onMoveDensityZoneVertex) return;
                                event.preventDefault();
                                event.stopPropagation();
                              }}
                            />
                          ))}
                      </g>
                    );
                  })}

                {countingOverlay?.countingLines
                  ?.filter((line) => line.enabled && line.points.length >= 2)
                  .map((line) => {
                    const [p1, p2] = line.points;
                    const selected = countingOverlay.selectedCountingLineId === line.id;
                    const isEntry = line.kind === "entry";
                    const mx = ((p1[0] + p2[0]) / 2) * VIEWPORT_WIDTH;
                    const my = ((p1[1] + p2[1]) / 2) * VIEWPORT_HEIGHT;
                    return (
                      <g
                        key={`cl-${line.id}`}
                        className={`editor-canvas__counting-line ${isEntry ? "is-entry" : "is-exit"} ${selected ? "is-selected" : ""}`}
                        onClick={() => countingOverlay.onSelectCountingLine?.(line.id)}
                      >
                        <line
                          x1={p1[0] * VIEWPORT_WIDTH}
                          y1={p1[1] * VIEWPORT_HEIGHT}
                          x2={p2[0] * VIEWPORT_WIDTH}
                          y2={p2[1] * VIEWPORT_HEIGHT}
                          className="editor-canvas__counting-line-stroke"
                        />
                        <text
                          x={mx}
                          y={my - 10}
                          textAnchor="middle"
                          className="editor-canvas__counting-line-label"
                        >
                          {line.label}
                        </text>
                        <circle
                          cx={p1[0] * VIEWPORT_WIDTH}
                          cy={p1[1] * VIEWPORT_HEIGHT}
                          r={selected ? 8 : 6}
                          className="editor-canvas__counting-line-endpoint"
                          onPointerDown={(event) => {
                            if (!canEdit || !countingOverlay.onMoveLineEndpoint) return;
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                        />
                        <circle
                          cx={p2[0] * VIEWPORT_WIDTH}
                          cy={p2[1] * VIEWPORT_HEIGHT}
                          r={selected ? 8 : 6}
                          className="editor-canvas__counting-line-endpoint"
                          onPointerDown={(event) => {
                            if (!canEdit || !countingOverlay.onMoveLineEndpoint) return;
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                        />
                      </g>
                    );
                  })}
              </svg>
            </div>
          </div>
        </div>

        {controls ? <div className="editor-canvas__toolbar">{controls}</div> : null}
      </div>
    </section>
  );
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(min, value), max);
}

function clampZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(3))));
}

function clampScroll(value: number, max: number) {
  return Math.min(Math.max(0, value), Math.max(0, max));
}

function focusViewportAt(
  point: [number, number],
  viewport: HTMLDivElement,
  layer: HTMLDivElement,
) {
  const nextLeft = point[0] * layer.clientWidth - viewport.clientWidth / 2;
  const nextTop = point[1] * layer.clientHeight - viewport.clientHeight / 2;

  viewport.scrollLeft = clampScroll(nextLeft, layer.clientWidth - viewport.clientWidth);
  viewport.scrollTop = clampScroll(nextTop, layer.clientHeight - viewport.clientHeight);
}

function deriveViewportCenterPoint(viewport: HTMLDivElement, layer: HTMLDivElement): [number, number] {
  return [
    clamp01((viewport.scrollLeft + viewport.clientWidth / 2) / Math.max(layer.clientWidth, 1)),
    clamp01((viewport.scrollTop + viewport.clientHeight / 2) / Math.max(layer.clientHeight, 1)),
  ];
}

function distanceBetweenPoints(
  left: { clientX: number; clientY: number },
  right: { clientX: number; clientY: number },
) {
  return Math.hypot(left.clientX - right.clientX, left.clientY - right.clientY);
}
