import { useEffect, useSyncExternalStore } from "react";
import { useParkingClient } from "../api/parkingClientContext";
import { resolveTimeZone } from "../lib/timeZone";
import { useCountingData } from "./useCountingData";
import { CountingStatsPanel } from "./CountingStatsPanel";
import { CountingEventList } from "./CountingEventList";
import { CountingTimeline } from "./CountingTimeline";
import { CountingAlertPanel } from "./CountingAlertPanel";
import { DensityGauge } from "./DensityGauge";

interface TrafficCountingPageProps {
  onNavigate?(path: string): void;
}

export function TrafficCountingPage({ onNavigate }: TrafficCountingPageProps) {
  const client = useParkingClient();
  const snapshot = useSyncExternalStore(
    client.live.subscribe,
    client.live.getSnapshot,
    client.live.getSnapshot,
  );
  const countingData = useCountingData(client);
  const timeZone = resolveTimeZone(snapshot?.timeZone);
  const facilityName = snapshot?.facilityName ?? "Facility";
  const trafficState = snapshot?.trafficCounting;

  const liveEntries = trafficState?.entriesTotal ?? countingData.summary.entriesTotal;
  const liveExits = trafficState?.exitsTotal ?? countingData.summary.exitsTotal;
  const liveEntriesHour = trafficState?.entriesLastHour ?? countingData.summary.entriesLastHour;
  const liveExitsHour = trafficState?.exitsLastHour ?? countingData.summary.exitsLastHour;

  const mergedSummary = {
    entriesTotal: liveEntries,
    exitsTotal: liveExits,
    entriesLastHour: liveEntriesHour,
    exitsLastHour: liveExitsHour,
  };

  const liveEvents =
    trafficState && trafficState.countingEvents.length > 0
      ? trafficState.countingEvents
      : countingData.events;

  const liveDensity =
    trafficState && trafficState.densitySnapshots.length > 0
      ? trafficState.densitySnapshots
      : countingData.density;

  useEffect(() => {
    document.body.classList.add("counting-route");
    return () => {
      document.body.classList.remove("counting-route");
    };
  }, []);

  return (
    <div className="counting-page">
      <header className="counting-page__header">
        <div className="counting-page__header-left">
          <h1 className="counting-page__title">Traffic Counting</h1>
          <p className="counting-page__subtitle">{facilityName}</p>
        </div>
        <div className="counting-page__header-right">
          <button
            type="button"
            className="counting-page__nav-btn"
            onClick={() => onNavigate?.("/live")}
          >
            Dashboard
          </button>
          <button
            type="button"
            className="counting-page__nav-btn"
            onClick={() => onNavigate?.("/config")}
          >
            Editor
          </button>
        </div>
      </header>

      <div className="counting-page__body">
        <aside className="counting-page__sidebar">
          <CountingStatsPanel summary={mergedSummary} />
          <CountingTimeline aggregates={countingData.aggregates} />
        </aside>

        <main className="counting-page__main">
          <div className="counting-page__cameras">
            {snapshot?.cameras?.slice(0, 4).map((cam) => (
              <div key={cam.id} className="counting-page__camera-card">
                <div className="counting-page__camera-header">
                  <span className="counting-page__camera-name">{cam.name}</span>
                  <span
                    className={`counting-page__camera-status counting-page__camera-status--${cam.status}`}
                  >
                    {cam.status}
                  </span>
                </div>
                {cam.frameUrl ? (
                  <img
                    src={cam.frameUrl}
                    alt={cam.name}
                    className="counting-page__camera-image"
                  />
                ) : (
                  <div className="counting-page__camera-placeholder">No frame</div>
                )}
              </div>
            )) ?? (
              <p className="counting-page__no-cameras">No cameras available</p>
            )}
          </div>
        </main>

        <aside className="counting-page__monitoring">
          <CountingAlertPanel alerts={snapshot?.alerts ?? []} />
          <CountingEventList events={liveEvents} timeZone={timeZone} />
          <DensityGauge snapshots={liveDensity} />
        </aside>
      </div>
    </div>
  );
}
