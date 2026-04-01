import { flattenSlots } from "../data/dashboardUtils";
import type { ParkingLevel, SlotStatus } from "../data/types";

export interface SlotOverlayState {
  occupancyDwell: boolean;
  vehicleTurnover: boolean;
}

export interface SlotOverlayMetric {
  occupancyDwell: number;
  vehicleTurnover: number;
}

export type SlotOverlayMetricsById = Record<string, SlotOverlayMetric>;

export interface SceneColorTuning {
  saturation: number;
  lightness: number;
  bayOutlineSaturation: number;
  bayOutlineLightness: number;
  zoneOutlineSaturation: number;
  zoneOutlineLightness: number;
}

export interface ColorChannelTuning {
  saturation: number;
  lightness: number;
}

export const DEFAULT_SCENE_COLOR_TUNING: SceneColorTuning = {
  saturation: 2.1,
  lightness: 0.9,
  bayOutlineSaturation: 2.05,
  bayOutlineLightness: 1.25,
  zoneOutlineSaturation: 1.75,
  zoneOutlineLightness: 1.25,
};

interface SlotVisualState {
  fillColor: string;
  outlineColor: string;
  emissiveColor: string;
  emissiveIntensity: number;
}

const STATUS_COLORS: Record<SlotStatus, string> = {
  free: "#8fc0ff",
  occupied: "#ff9a84",
  ev: "#86efb5",
  reserved: "#f2dd8d",
  unknown: "#c4d0dd",
};

const OCCUPANCY_GRADIENT = ["#6c4a36", "#a76d4d", "#d98c46", "#f1b867", "#ffe199"];
const TURNOVER_GRADIENT = ["#4a3b72", "#6952a7", "#8966d8", "#ab80ff", "#d4bbff"];

export function buildMockSlotOverlayMetrics(levels: ParkingLevel[]): SlotOverlayMetricsById {
  const slots = flattenSlots(levels);

  if (slots.length === 0) {
    return {};
  }

  const maxAbsX = Math.max(1, ...slots.map((slot) => Math.abs(slot.position[0])));
  const maxAbsZ = Math.max(1, ...slots.map((slot) => Math.abs(slot.position[1])));
  const levelCount = Math.max(levels.length, 1);
  const rawMetrics = slots.map((slot) => {
    const axisBias =
      (1 - Math.abs(slot.position[0]) / maxAbsX) * 0.18 +
      (1 - Math.abs(slot.position[1]) / maxAbsZ) * 0.1;
    const planeBias =
      levelCount > 1 ? (levelCount - 1 - slot.levelIndex) / (levelCount - 1) : 0.5;
    const rowColumnBias = slot.row * 0.07 + slot.column * 0.04;
    const statusBias =
      slot.status === "occupied" ? 0.12 : slot.status === "ev" ? 0.08 : slot.status === "reserved" ? 0.05 : 0;
    const dwellSeed = unitHash(
      `${slot.id}:${slot.levelId}:${slot.levelIndex}:${slot.row}:${slot.column}:${slot.position[0].toFixed(3)}:${slot.position[1].toFixed(3)}:${levelCount}:dwell`,
    );
    const turnoverSeed = unitHash(
      `${slot.id}:${slot.levelId}:${slot.levelIndex}:${slot.row}:${slot.column}:${slot.position[0].toFixed(3)}:${slot.position[1].toFixed(3)}:${levelCount}:turnover`,
    );

    return {
      id: slot.id,
      occupancyDwell:
        dwellSeed * 0.52 + axisBias + planeBias * 0.18 + rowColumnBias * 0.18 + statusBias,
      vehicleTurnover:
        turnoverSeed * 0.56 +
        (slot.column / Math.max(levelCount + 2, 4)) * 0.24 +
        ((slot.levelIndex + slot.row + slot.column) % 3) * 0.08 +
        (Math.abs(slot.position[0]) / maxAbsX) * 0.14,
    };
  });

  const normalizedDwell = normalizeSeries(rawMetrics.map((entry) => entry.occupancyDwell));
  const normalizedTurnover = normalizeSeries(rawMetrics.map((entry) => entry.vehicleTurnover));

  return rawMetrics.reduce<SlotOverlayMetricsById>((accumulator, entry, index) => {
    accumulator[entry.id] = {
      occupancyDwell: normalizedDwell[index] ?? 0,
      vehicleTurnover: normalizedTurnover[index] ?? 0,
    };

    return accumulator;
  }, {});
}

export function deriveSlotVisualState(
  status: SlotStatus,
  overlays: SlotOverlayState,
  metric?: SlotOverlayMetric,
  tuning: SceneColorTuning = DEFAULT_SCENE_COLOR_TUNING,
): SlotVisualState {
  const fallbackColor = tuneHexColor(STATUS_COLORS[status], tuning);
  const occupancyColor = tuneHexColor(
    sampleGradient(OCCUPANCY_GRADIENT, metric?.occupancyDwell ?? 0),
    tuning,
  );
  const turnoverColor = tuneHexColor(
    sampleGradient(TURNOVER_GRADIENT, metric?.vehicleTurnover ?? 0),
    tuning,
  );

  if (overlays.occupancyDwell && overlays.vehicleTurnover) {
    return {
      fillColor: occupancyColor,
      outlineColor: mixHex(turnoverColor, "#f4ecff", 0.22),
      emissiveColor: turnoverColor,
      emissiveIntensity: 0.12 + (metric?.vehicleTurnover ?? 0) * 0.2,
    };
  }

  if (overlays.occupancyDwell) {
    return {
      fillColor: occupancyColor,
      outlineColor: mixHex(occupancyColor, "#fff1d1", 0.34),
      emissiveColor: occupancyColor,
      emissiveIntensity: 0.08 + (metric?.occupancyDwell ?? 0) * 0.1,
    };
  }

  if (overlays.vehicleTurnover) {
    return {
      fillColor: turnoverColor,
      outlineColor: mixHex(turnoverColor, "#e6d8ff", 0.34),
      emissiveColor: turnoverColor,
      emissiveIntensity: 0.1 + (metric?.vehicleTurnover ?? 0) * 0.18,
    };
  }

  return {
    fillColor: fallbackColor,
    outlineColor: mixHex(fallbackColor, "#f6fbff", 0.38),
    emissiveColor: fallbackColor,
    emissiveIntensity: 0.085,
  };
}

export function tuneHexColor(
  value: string,
  tuning: ColorChannelTuning = DEFAULT_SCENE_COLOR_TUNING,
) {
  const [red, green, blue] = parseHex(value);
  const [hue, saturation, lightness] = rgbToHsl(red, green, blue);
  const nextSaturation =
    tuning.saturation >= 1
      ? clamp01(
          saturation + (1 - saturation) * Math.min(1, (tuning.saturation - 1) / 1),
        )
      : clamp01(saturation * tuning.saturation);
  const nextLightness =
    tuning.lightness >= 1
      ? clamp01(
          lightness + (1 - lightness) * Math.min(1, (tuning.lightness - 1) / 0.9),
        )
      : clamp01(lightness * tuning.lightness);
  return rgbToHex(...hslToRgb(hue, nextSaturation, nextLightness));
}

function normalizeSeries(values: number[]) {
  const min = Math.min(...values);
  const max = Math.max(...values);

  if (!Number.isFinite(min) || !Number.isFinite(max) || Math.abs(max - min) < 0.0001) {
    return values.map(() => 0.5);
  }

  return values.map((value) => clamp01((value - min) / (max - min)));
}

function sampleGradient(stops: string[], amount: number) {
  if (stops.length === 0) {
    return "#000000";
  }

  if (stops.length === 1) {
    return stops[0];
  }

  const clamped = clamp01(amount);
  const segment = (stops.length - 1) * clamped;
  const index = Math.min(Math.floor(segment), stops.length - 2);
  const localAmount = segment - index;

  return mixHex(stops[index], stops[index + 1], localAmount);
}

function mixHex(left: string, right: string, amount: number) {
  const from = parseHex(left);
  const to = parseHex(right);
  const ratio = clamp01(amount);

  const red = Math.round(from[0] + (to[0] - from[0]) * ratio);
  const green = Math.round(from[1] + (to[1] - from[1]) * ratio);
  const blue = Math.round(from[2] + (to[2] - from[2]) * ratio);

  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

function rgbToHex(red: number, green: number, blue: number) {
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

function parseHex(value: string) {
  const normalized = value.replace("#", "");
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);

  return [red, green, blue] as const;
}

function toHex(value: number) {
  return value.toString(16).padStart(2, "0");
}

function rgbToHsl(red: number, green: number, blue: number) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;

  if (max === min) {
    return [0, 0, lightness] as const;
  }

  const delta = max - min;
  const saturation =
    lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue = 0;

  switch (max) {
    case r:
      hue = (g - b) / delta + (g < b ? 6 : 0);
      break;
    case g:
      hue = (b - r) / delta + 2;
      break;
    default:
      hue = (r - g) / delta + 4;
      break;
  }

  return [hue / 6, saturation, lightness] as const;
}

function hslToRgb(hue: number, saturation: number, lightness: number) {
  if (saturation === 0) {
    const gray = Math.round(lightness * 255);
    return [gray, gray, gray] as const;
  }

  const hueToChannel = (p: number, q: number, t: number) => {
    let next = t;
    if (next < 0) {
      next += 1;
    }
    if (next > 1) {
      next -= 1;
    }
    if (next < 1 / 6) {
      return p + (q - p) * 6 * next;
    }
    if (next < 1 / 2) {
      return q;
    }
    if (next < 2 / 3) {
      return p + (q - p) * (2 / 3 - next) * 6;
    }
    return p;
  };

  const q =
    lightness < 0.5
      ? lightness * (1 + saturation)
      : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;

  return [
    Math.round(hueToChannel(p, q, hue + 1 / 3) * 255),
    Math.round(hueToChannel(p, q, hue) * 255),
    Math.round(hueToChannel(p, q, hue - 1 / 3) * 255),
  ] as const;
}

function clamp01(value: number) {
  return Math.min(Math.max(value, 0), 1);
}

function unitHash(input: string) {
  return hashString(input) / 4294967295;
}

function hashString(input: string) {
  let hash = 2166136261;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}
