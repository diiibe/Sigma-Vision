import type { DensitySnapshot } from "../data/types";

interface DensityGaugeProps {
  snapshots: DensitySnapshot[];
}

export function DensityGauge({ snapshots }: DensityGaugeProps) {
  if (snapshots.length === 0) {
    return (
      <div className="density-gauge">
        <h3 className="density-gauge__title">Zone Density</h3>
        <p className="density-gauge__empty">No density zones configured</p>
      </div>
    );
  }

  const latest = new Map<string, DensitySnapshot>();
  for (const snap of snapshots) {
    const existing = latest.get(snap.zoneId);
    if (!existing || snap.timestamp > existing.timestamp) {
      latest.set(snap.zoneId, snap);
    }
  }

  return (
    <div className="density-gauge">
      <h3 className="density-gauge__title">Zone Density</h3>
      <div className="density-gauge__list">
        {[...latest.values()].map((snap) => {
          const ratio = snap.occupancyRatio ?? 0;
          const pct = Math.round(ratio * 100);
          const level =
            pct >= 90 ? "critical" : pct >= 70 ? "warning" : "normal";
          return (
            <div key={snap.zoneId} className={`density-gauge__item density-gauge__item--${level}`}>
              <div className="density-gauge__header">
                <span className="density-gauge__zone">{snap.zoneId}</span>
                <span className="density-gauge__count">
                  {snap.vehicleCount}
                  {snap.capacity != null ? ` / ${snap.capacity}` : ""}
                </span>
              </div>
              <div className="density-gauge__bar">
                <div
                  className="density-gauge__bar-fill"
                  style={{ width: `${Math.min(pct, 100)}%` }}
                />
              </div>
              {snap.occupancyRatio != null && (
                <span className="density-gauge__pct">{pct}%</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
