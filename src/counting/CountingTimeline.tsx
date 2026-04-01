import type { CountingAggregatePoint } from "../data/types";

interface CountingTimelineProps {
  aggregates: CountingAggregatePoint[];
}

export function CountingTimeline({ aggregates }: CountingTimelineProps) {
  if (aggregates.length === 0) {
    return (
      <div className="counting-timeline">
        <h3 className="counting-timeline__title">Hourly Flow</h3>
        <p className="counting-timeline__empty">No data yet</p>
      </div>
    );
  }

  const sorted = [...aggregates].sort((a, b) => a.bucketStart.localeCompare(b.bucketStart));
  const maxVal = Math.max(
    ...sorted.map((p) => Math.max(p.entries, p.exits)),
    1,
  );

  return (
    <div className="counting-timeline">
      <h3 className="counting-timeline__title">Hourly Flow</h3>
      <div className="counting-timeline__chart">
        {sorted.slice(-24).map((point) => {
          const hour = point.bucketStart.slice(11, 16);
          const entryH = Math.round((point.entries / maxVal) * 100);
          const exitH = Math.round((point.exits / maxVal) * 100);
          return (
            <div key={point.bucketStart} className="counting-timeline__bucket">
              <div className="counting-timeline__bars">
                <div
                  className="counting-timeline__bar counting-timeline__bar--entry"
                  style={{ height: `${entryH}%` }}
                  title={`${point.entries} entries`}
                />
                <div
                  className="counting-timeline__bar counting-timeline__bar--exit"
                  style={{ height: `${exitH}%` }}
                  title={`${point.exits} exits`}
                />
              </div>
              <span className="counting-timeline__label">{hour}</span>
            </div>
          );
        })}
      </div>
      <div className="counting-timeline__legend">
        <span className="counting-timeline__legend-item counting-timeline__legend-item--entry">
          Entries
        </span>
        <span className="counting-timeline__legend-item counting-timeline__legend-item--exit">
          Exits
        </span>
      </div>
    </div>
  );
}
