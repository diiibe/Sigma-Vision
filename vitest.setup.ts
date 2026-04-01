import "@testing-library/jest-dom/vitest";

class ResizeObserverMock {
  observe() {}

  unobserve() {}

  disconnect() {}
}

if (!("ResizeObserver" in globalThis)) {
  // jsdom does not provide ResizeObserver consistently across versions.
  globalThis.ResizeObserver = ResizeObserverMock as never;
}

if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

if (typeof globalThis.matchMedia !== "function") {
  globalThis.matchMedia = window.matchMedia;
}

class EventSourceMock {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly url: string;
  readyState = EventSourceMock.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
  }

  addEventListener() {}

  removeEventListener() {}

  close() {
    this.readyState = EventSourceMock.CLOSED;
  }
}

if (!("EventSource" in globalThis)) {
  globalThis.EventSource = EventSourceMock as never;
}
