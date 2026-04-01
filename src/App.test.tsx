import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App, { createAppTestClient } from "./App";

vi.mock("./scene/ParkingScene", () => ({
  ParkingScene: () => <div data-testid="parking-scene" />,
}));

vi.mock("./hooks/useReducedMotion", () => ({
  useReducedMotion: () => false,
}));

async function flushAppUpdates() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("App routes", () => {
  afterEach(() => {
    vi.useRealTimers();
    window.history.pushState({}, "", "/");
  });

  it("opens the live dashboard by default and links to the spatial config editor", async () => {
    const client = createAppTestClient();

    await act(async () => {
      render(<App client={client} />);
    });
    await flushAppUpdates();

    expect(await screen.findByText("ACPDS Lot 07")).toBeInTheDocument();
    const header = screen.getByRole("banner", { name: "System header" });
    expect(within(header).getByRole("button", { name: "Edit lot" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(header).getByRole("button", { name: "Edit lot" }));
    });
    await flushAppUpdates();

    expect(await screen.findByText("Lot authoring")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply to live" })).toBeInTheDocument();

    client.destroy();
  });

  it("keeps the editor route separate from the live route", async () => {
    const client = createAppTestClient();

    window.history.pushState({}, "", "/config");
    await act(async () => {
      render(<App client={client} />);
    });
    await flushAppUpdates();

    expect(await screen.findByText("Lot authoring")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back to dashboard" }));
    });
    await flushAppUpdates();

    expect(await screen.findByText("ACPDS Lot 07")).toBeInTheDocument();

    client.destroy();
  });
});
