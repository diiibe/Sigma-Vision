import { describe, expect, it } from "vitest";
import { buildFixtureSnapshot } from "../data/demoFixtures";
import {
  buildMockSlotOverlayMetrics,
  deriveSlotVisualState,
} from "./slotOverlay";

const NEUTRAL_TUNING = {
  saturation: 1,
  lightness: 1,
  bayOutlineSaturation: 1,
  bayOutlineLightness: 1,
  zoneOutlineSaturation: 1,
  zoneOutlineLightness: 1,
} as const;

describe("slotOverlay", () => {
  it("builds deterministic overlay metrics for the same model input", () => {
    const levels = buildFixtureSnapshot().levels;

    expect(buildMockSlotOverlayMetrics(levels)).toEqual(
      buildMockSlotOverlayMetrics(levels),
    );
  });

  it("changes the metric distribution when the model shape changes", () => {
    const levels = buildFixtureSnapshot().levels;
    const shiftedLevels = levels.map((level) => ({
      ...level,
      slots: level.slots.map((slot, index) =>
        index === 0
          ? {
              ...slot,
              position: [slot.position[0] + 0.48, slot.position[1] - 0.22] as [number, number],
            }
          : slot,
      ),
    }));

    expect(buildMockSlotOverlayMetrics(shiftedLevels)).not.toEqual(
      buildMockSlotOverlayMetrics(levels),
    );
  });

  it("keeps occupancy as the base fill and turnover as violet emphasis when both overlays are active", () => {
    expect(
      deriveSlotVisualState(
        "free",
        { occupancyDwell: true, vehicleTurnover: false },
        { occupancyDwell: 1, vehicleTurnover: 0 },
        NEUTRAL_TUNING,
      ),
    ).toMatchObject({
      fillColor: "#ffe199",
      emissiveColor: "#ffe199",
    });

    expect(
      deriveSlotVisualState(
        "free",
        { occupancyDwell: false, vehicleTurnover: true },
        { occupancyDwell: 0, vehicleTurnover: 1 },
        NEUTRAL_TUNING,
      ),
    ).toMatchObject({
      fillColor: "#d4bbff",
      emissiveColor: "#d4bbff",
    });

    expect(
      deriveSlotVisualState(
        "free",
        { occupancyDwell: true, vehicleTurnover: true },
        { occupancyDwell: 1, vehicleTurnover: 1 },
        NEUTRAL_TUNING,
      ),
    ).toMatchObject({
      fillColor: "#ffe199",
      outlineColor: "#dbc6ff",
      emissiveColor: "#d4bbff",
    });
  });
});
