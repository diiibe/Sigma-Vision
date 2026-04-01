import { afterEach, describe, expect, it, vi } from "vitest";

import { createBrowserParkingClient } from "./parkingClient";
import { createMockParkingClient } from "./parkingClientMock";

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

async function buildBundle(cameraId: string) {
  const mock = createMockParkingClient();
  try {
    return await mock.configs.getActive(cameraId);
  } finally {
    mock.destroy();
  }
}

function buildJsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

describe("createBrowserParkingClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers the camera-specific active config route over the global fallback", async () => {
    const requestedBundle = await buildBundle("CAM-02");
    const globalBundle = await buildBundle("CAM-ACPDS-01");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/live/snapshot") {
        return new Response("", { status: 404 });
      }
      if (url === "/api/demo/snapshot") {
        return new Response("", { status: 404 });
      }
      if (url === "/api/spatial-configs/CAM-02/active") {
        return buildJsonResponse(requestedBundle);
      }
      if (url === "/api/spatial-configs/active") {
        return buildJsonResponse(globalBundle);
      }
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createBrowserParkingClient();
    await flushAsyncWork();
    fetchMock.mockClear();

    const bundle = await client.configs.getActive("CAM-02");

    expect(bundle.active.cameraId).toBe("CAM-02");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/spatial-configs/CAM-02/active");

    client.destroy();
  });

  it("uses the dedicated versions route and does not fetch the active bundle to list versions", async () => {
    const expectedVersions = (await buildBundle("CAM-02")).versions;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/live/snapshot") {
        return new Response("", { status: 404 });
      }
      if (url === "/api/demo/snapshot") {
        return new Response("", { status: 404 });
      }
      if (url === "/api/spatial-configs/CAM-02/versions") {
        return buildJsonResponse(expectedVersions);
      }
      if (url === "/api/spatial-configs/CAM-02/active" || url === "/api/spatial-configs/active") {
        return buildJsonResponse(await buildBundle("CAM-ACPDS-01"));
      }
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createBrowserParkingClient();
    await flushAsyncWork();
    fetchMock.mockClear();

    const versions = await client.configs.listVersions("CAM-02");

    expect(versions).toEqual(expectedVersions);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/spatial-configs/CAM-02/versions");

    client.destroy();
  });

  it("does not call stale /api/demo/lot when saving a draft falls back to the mock client", async () => {
    const bundle = await buildBundle("CAM-02");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/live/snapshot") {
        return new Response("", { status: 404 });
      }
      if (url === "/api/demo/snapshot") {
        return new Response("", { status: 404 });
      }
      if (init?.method === "POST" && (url === "/api/spatial-configs/CAM-02/versions" || url === "/api/spatial-configs/versions")) {
        return new Response("", { status: 500 });
      }
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createBrowserParkingClient();
    await flushAsyncWork();
    fetchMock.mockClear();

    await client.configs.saveDraft("CAM-02", bundle.active);

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/spatial-configs/CAM-02/versions",
      "/api/spatial-configs/versions",
    ]);

    client.destroy();
  });

  it("does not call stale /api/demo/bays routes when reserve falls back to the mock client", async () => {
    const liveSnapshot = createMockParkingClient().live.getSnapshot();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/live/snapshot") {
        return new Response("", { status: 404 });
      }
      if (url === "/api/demo/snapshot") {
        return new Response("", { status: 404 });
      }
      if (url === "/api/live/bays/B01/reserve") {
        return new Response("", { status: 500 });
      }
      if (url.startsWith("/api/demo/bays/")) {
        return new Response("", { status: 404 });
      }
      if (url === "/api/live/snapshot?cameraId=CAM-ACPDS-01" && liveSnapshot) {
        return buildJsonResponse(liveSnapshot);
      }
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createBrowserParkingClient();
    await flushAsyncWork();
    fetchMock.mockClear();

    await client.live.reserveBay?.("B01");

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/live/bays/B01/reserve",
    ]);

    client.destroy();
  });

  it("prefers the camera-specific activate route over the global fallback", async () => {
    const requestedBundle = await buildBundle("CAM-02");
    const globalBundle = await buildBundle("CAM-ACPDS-01");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/live/snapshot") {
        return new Response("", { status: 404 });
      }
      if (url === "/api/demo/snapshot") {
        return new Response("", { status: 404 });
      }
      if (init?.method === "POST" && url === "/api/spatial-configs/CAM-02/activate") {
        return buildJsonResponse(requestedBundle);
      }
      if (init?.method === "POST" && url === "/api/spatial-configs/activate") {
        return buildJsonResponse(globalBundle);
      }
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createBrowserParkingClient();
    await flushAsyncWork();
    fetchMock.mockClear();

    const bundle = await client.configs.activate("CAM-02", requestedBundle.active.version);

    expect(bundle.active.cameraId).toBe("CAM-02");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/spatial-configs/CAM-02/activate");

    client.destroy();
  });
});
