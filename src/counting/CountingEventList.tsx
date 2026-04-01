import type { CountingEvent } from "../data/types";

interface CountingEventListProps {
  events: CountingEvent[];
  timeZone?: string;
}

export function CountingEventList({ events, timeZone }: CountingEventListProps) {
  return (
    <div className="counting-events">
      <h3 className="counting-events__title">Recent Events</h3>
      <div className="counting-events__list">
        {events.length === 0 ? (
          <p className="counting-events__empty">No counting events yet</p>
        ) : (
          events.slice(0, 30).map((event) => (
            <div
              key={event.id}
              className={`counting-events__item counting-events__item--${event.eventType}`}
            >
              <span className="counting-events__badge">
                {event.eventType === "entry" ? "IN" : "OUT"}
              </span>
              <span className="counting-events__line">{event.lineId}</span>
              <span className="counting-events__track">Track {event.trackId}</span>
              <span className="counting-events__time">
                {formatEventTime(event.timestamp, timeZone)}
              </span>
              <span className="counting-events__confidence">
                {Math.round(event.confidence * 100)}%
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function formatEventTime(iso: string, timeZone?: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZone: timeZone || undefined,
    });
  } catch {
    return iso.slice(11, 19);
  }
}
