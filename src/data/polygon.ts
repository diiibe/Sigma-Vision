import type { Polygon, PolygonPoint } from "./types";

export function polygonCentroid(points: Polygon): PolygonPoint {
  const total = points.reduce(
    (acc, [x, y]) => {
      acc.x += x;
      acc.y += y;
      return acc;
    },
    { x: 0, y: 0 },
  );

  return [total.x / points.length, total.y / points.length];
}

export function polygonBounds(points: Polygon) {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);

  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

export function deriveSlotPosition(points: Polygon): [number, number] {
  return polygonCentroid(points);
}

export function deriveSlotSize(points: Polygon): [number, number] {
  const bounds = polygonBounds(points);
  return [bounds.maxX - bounds.minX, bounds.maxY - bounds.minY];
}

export function translatePolygon(
  points: Polygon,
  deltaX: number,
  deltaY: number,
): Polygon {
  return points.map(([x, y]) => [
    clamp01(x + deltaX),
    clamp01(y + deltaY),
  ]);
}

export function setPolygonVertex(
  points: Polygon,
  index: number,
  nextPoint: PolygonPoint,
): Polygon {
  return points.map((point, pointIndex) =>
    pointIndex === index
      ? [clamp01(nextPoint[0]), clamp01(nextPoint[1])]
      : point,
  );
}

export function createRectanglePolygon(
  centerX: number,
  centerY: number,
  width: number,
  height: number,
): Polygon {
  const halfWidth = width / 2;
  const halfHeight = height / 2;

  return [
    [clamp01(centerX - halfWidth), clamp01(centerY - halfHeight)],
    [clamp01(centerX + halfWidth), clamp01(centerY - halfHeight)],
    [clamp01(centerX + halfWidth), clamp01(centerY + halfHeight)],
    [clamp01(centerX - halfWidth), clamp01(centerY + halfHeight)],
  ];
}

export function polygonToPath(points: Polygon, width: number, height: number) {
  return points
    .map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x * width} ${y * height}`)
    .join(" ")
    .concat(" Z");
}

export function scalePoint(
  [x, y]: PolygonPoint,
  width: number,
  height: number,
): PolygonPoint {
  return [x * width, y * height];
}

export function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}
