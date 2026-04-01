import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useParkingClient } from "../api/parkingClientContext";
import type { CameraFeed, SystemEvent } from "../data/types";
import { formatShortTime, titleCase } from "../lib/format";

const PAGE_SIZE = 50;
const LOAD_MORE_THRESHOLD_PX = 180;

type EventHistoryScope = "feed" | "all";

interface EventHistoryDialogProps {
  cameras: CameraFeed[];
  open: boolean;
  previewEvents: SystemEvent[];
  timeZone: string;
  selectedCameraId: string | null;
  trackedSlotId: string | null;
  onClose(): void;
  onSelectEvent(event: SystemEvent): void;
}

export function EventHistoryDialog({
  cameras,
  open,
  previewEvents,
  timeZone,
  selectedCameraId,
  trackedSlotId,
  onClose,
  onSelectEvent,
}: EventHistoryDialogProps) {
  const client = useParkingClient();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const prependHeightRef = useRef<number | null>(null);
  const loadRequestRef = useRef(0);
  const refreshRequestRef = useRef(0);
  const [scope, setScope] = useState<EventHistoryScope>("feed");
  const [items, setItems] = useState<SystemEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const selectedCamera = cameras.find((camera) => camera.id === selectedCameraId) ?? cameras[0] ?? null;
  const activeCameraId = scope === "feed" ? selectedCamera?.id ?? null : null;
  const cameraNames = useMemo(
    () => new Map(cameras.map((camera) => [camera.id, camera.name])),
    [cameras],
  );
  const relevantPreviewEvents = useMemo(() => {
    if (scope === "all") {
      return previewEvents;
    }
    if (!activeCameraId) {
      return [];
    }
    return previewEvents.filter(
      (event) => event.cameraId === activeCameraId || event.cameraId === undefined || event.cameraId === null,
    );
  }, [activeCameraId, previewEvents, scope]);
  const previewSignature = useMemo(
    () => relevantPreviewEvents.map((event) => event.id).join("|"),
    [relevantPreviewEvents],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    setScope("feed");
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => {
      closeButtonRef.current?.focus();
    }, 0);

    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open]);

  useLayoutEffect(() => {
    const previousHeight = prependHeightRef.current;
    const node = scrollRef.current;
    if (previousHeight === null || node === null) {
      return;
    }
    node.scrollTop += node.scrollHeight - previousHeight;
    prependHeightRef.current = null;
  }, [items]);

  useEffect(() => {
    if (!open) {
      return;
    }
    void loadFirstPage();
  }, [activeCameraId, open, scope]);

  useEffect(() => {
    if (!open || relevantPreviewEvents.length === 0) {
      return;
    }
    if (scope === "feed") {
      preserveScrollPositionForPrepend();
      setItems((current) => prependUniqueEvents(current, relevantPreviewEvents));
      return;
    }
    void refreshHeadPage();
  }, [open, previewSignature, relevantPreviewEvents, scope]);

  const loadFirstPage = async () => {
    const requestId = ++loadRequestRef.current;
    setIsLoading(true);
    setIsLoadingMore(false);
    setErrorMessage(null);
    try {
      const page = await client.live.listEvents({
        cameraId: activeCameraId ?? undefined,
        limit: PAGE_SIZE,
      });
      if (loadRequestRef.current !== requestId) {
        return;
      }
      setItems(prependUniqueEvents(page.items, relevantPreviewEvents));
      setNextCursor(page.nextCursor ?? null);
    } catch {
      if (loadRequestRef.current !== requestId) {
        return;
      }
      setItems(prependUniqueEvents([], relevantPreviewEvents));
      setNextCursor(null);
      setErrorMessage("Unable to load archived events.");
    } finally {
      if (loadRequestRef.current === requestId) {
        setIsLoading(false);
      }
    }
  };

  const refreshHeadPage = async () => {
    const requestId = ++refreshRequestRef.current;
    try {
      const page = await client.live.listEvents({
        limit: PAGE_SIZE,
      });
      if (refreshRequestRef.current !== requestId) {
        return;
      }
      preserveScrollPositionForPrepend();
      setItems((current) => prependUniqueEvents(current, page.items));
    } catch {
      // Let the existing list stand. The dialog already has loaded content.
    }
  };

  const loadMore = async () => {
    if (isLoading || isLoadingMore || !nextCursor) {
      return;
    }
    setIsLoadingMore(true);
    try {
      const page = await client.live.listEvents({
        cameraId: activeCameraId ?? undefined,
        cursor: nextCursor,
        limit: PAGE_SIZE,
      });
      setItems((current) => appendUniqueEvents(current, page.items));
      setNextCursor(page.nextCursor ?? null);
    } catch {
      setErrorMessage("Unable to load older events.");
    } finally {
      setIsLoadingMore(false);
    }
  };

  const preserveScrollPositionForPrepend = () => {
    const node = scrollRef.current;
    if (!node || node.scrollTop <= 8) {
      return;
    }
    prependHeightRef.current = node.scrollHeight;
  };

  const handleScroll = () => {
    const node = scrollRef.current;
    if (!node) {
      return;
    }
    const remaining = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (remaining <= LOAD_MORE_THRESHOLD_PX) {
      void loadMore();
    }
  };

  if (!open || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="event-history-dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="event-history-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Event history"
      >
        <header className="event-history-dialog__header">
          <div className="event-history-dialog__header-copy">
            <span className="event-history-dialog__eyebrow">Historical event ledger</span>
            <div className="section-heading event-history-dialog__heading">
              <h2>Event history</h2>
              <p>
                {scope === "feed"
                  ? selectedCamera?.name ?? "Selected feed"
                  : `${cameras.length} calibrated ${cameras.length === 1 ? "source" : "sources"}`}
              </p>
            </div>
          </div>

          <div className="event-history-dialog__header-actions">
            <div className="event-history-dialog__scope" role="group" aria-label="Event history scope">
              <button
                type="button"
                className={`camera-switcher__button ${scope === "feed" ? "is-active" : ""}`}
                onClick={() => setScope("feed")}
                aria-pressed={scope === "feed"}
              >
                <span>This feed</span>
                <strong>{selectedCamera?.id ?? "none"}</strong>
              </button>
              <button
                type="button"
                className={`camera-switcher__button ${scope === "all" ? "is-active" : ""}`}
                onClick={() => setScope("all")}
                aria-pressed={scope === "all"}
              >
                <span>All feeds</span>
                <strong>{cameras.length} total</strong>
              </button>
            </div>

            <button
              ref={closeButtonRef}
              type="button"
              className="detail-card__dismiss event-history-dialog__dismiss"
              onClick={onClose}
              aria-label="Close event history"
            >
              ×
            </button>
          </div>
        </header>

        <div
          ref={scrollRef}
          className="event-history-dialog__scroll"
          onScroll={handleScroll}
        >
          {isLoading ? (
            <div className="event-history-dialog__status">
              <p>Loading historical events…</p>
            </div>
          ) : items.length > 0 ? (
            <div className="event-history-dialog__list" role="list" aria-label="Archived system events">
              {items.map((event) => {
                const eventCameraName = event.cameraId ? cameraNames.get(event.cameraId) : null;
                return (
                  <button
                    key={event.id}
                    type="button"
                    className={`event-row event-history-dialog__row event-row--${event.severity} ${
                      trackedSlotId && event.slotId === trackedSlotId ? "event-row--tracked" : ""
                    }`}
                    onClick={() => {
                      onSelectEvent(event);
                      onClose();
                    }}
                  >
                    <span className="event-row__time">
                      {formatShortTime(event.timestamp, timeZone)}
                    </span>
                    <span className="event-row__body">
                      <strong>{titleCase(event.type)}</strong>
                      <span>{event.message}</span>
                      <small className="event-history-dialog__meta">
                        {event.slotId ? `Bay ${event.slotId}` : "Facility event"}
                        {eventCameraName ? ` · ${eventCameraName}` : ""}
                      </small>
                    </span>
                    <span className="event-history-dialog__badge-stack">
                      {scope === "all" && eventCameraName ? (
                        <span className="event-history-dialog__camera-badge">{eventCameraName}</span>
                      ) : null}
                      {trackedSlotId && event.slotId === trackedSlotId ? (
                        <span className="event-row__flag">Tracked</span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="event-history-dialog__status">
              <p>No archived events available for this view.</p>
            </div>
          )}

          {isLoadingMore ? (
            <div className="event-history-dialog__footer">
              <span>Loading older updates…</span>
            </div>
          ) : null}

          {!isLoading && !isLoadingMore && nextCursor === null && items.length > 0 ? (
            <div className="event-history-dialog__footer">
              <span>Beginning of retained history</span>
            </div>
          ) : null}

          {errorMessage ? (
            <div className="event-history-dialog__footer event-history-dialog__footer--error">
              <span>{errorMessage}</span>
            </div>
          ) : null}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function prependUniqueEvents(existing: SystemEvent[], incoming: SystemEvent[]) {
  return mergeEvents([...incoming, ...existing]);
}

function appendUniqueEvents(existing: SystemEvent[], incoming: SystemEvent[]) {
  return mergeEvents([...existing, ...incoming]);
}

function mergeEvents(events: SystemEvent[]) {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (seen.has(event.id)) {
      return false;
    }
    seen.add(event.id);
    return true;
  });
}
