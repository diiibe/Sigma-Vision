import { useEffect, useMemo, useState, useCallback, useSyncExternalStore } from "react";
import { useParkingClient } from "../api/parkingClientContext";
import { useObservations } from "./useObservations";
import { useObservationLiveData } from "./useObservationLiveData";
import { SetupPanel } from "./SetupPanel";
import { ObservationsList } from "./ObservationsList";
import { LiveFeedPanel } from "./LiveFeedPanel";
import { SessionLog } from "./SessionLog";
import { useCountingState } from "./useCountingState";
import type { ObservationDefinition } from "../data/types";

interface VehicleAnalysisPageProps {
  onNavigate?(path: string): void;
}

export function VehicleAnalysisPage({ onNavigate }: VehicleAnalysisPageProps) {
  const client = useParkingClient();
  const snapshot = useSyncExternalStore(
    client.live.subscribe,
    client.live.getSnapshot,
    client.live.getSnapshot,
  );
  const facilityName = snapshot?.facilityName ?? "Facility";
  const trafficState = snapshot?.trafficCounting;

  const { observations, create, update, remove, toggle, duplicate } = useObservations(client);
  const liveData = useObservationLiveData(observations, trafficState);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingObs, setEditingObs] = useState<ObservationDefinition | null>(null);
  const [setupCameraId, setSetupCameraId] = useState<string | null>(null);

  const allCameraIds = useMemo(() => {
    const exclude = new Set(["altercation", "crowd", "running", "PL2.1", "PL2.2", "PTL3", "PTL4"]);
    const ids = new Set<string>();
    for (const id of snapshot?.allCameraIds ?? []) if (!exclude.has(id)) ids.add(id);
    for (const cam of snapshot?.cameras ?? []) if (!exclude.has(cam.id)) ids.add(cam.id);
    for (const obs of observations) if (!exclude.has(obs.cameraId)) ids.add(obs.cameraId);
    return Array.from(ids).sort();
  }, [snapshot?.allCameraIds, snapshot?.cameras, observations]);

  // Feed camera: observation selection takes priority, then setup panel camera
  const selectedObs = selectedId ? observations.find((o) => o.id === selectedId) ?? null : null;
  const feedCameraId = selectedObs?.cameraId ?? setupCameraId ?? allCameraIds[0] ?? null;
  const feedCamera = snapshot?.cameras?.find((c) => c.id === feedCameraId) ?? null;
  const feedObservations = feedCameraId ? liveData.cameraObservations(feedCameraId) : [];

  // Active task slots: max 2 visible, newest replaces oldest
  const [activeSlots, setActiveSlots] = useState<string[]>([]); // observation IDs in display order
  const allEnabled = observations.filter((o) => o.enabled);
  useEffect(() => {
    const enabledIds = new Set(allEnabled.map((o) => o.id));
    setActiveSlots((prev) => {
      // Remove slots that are no longer enabled
      const kept = prev.filter((id) => enabledIds.has(id));
      // Add newly enabled ones
      for (const o of allEnabled) {
        if (!kept.includes(o.id)) kept.push(o.id);
      }
      // Keep only last 2
      return kept.slice(-2);
    });
  }, [allEnabled.map((o) => o.id).join(",")]);

  // Resolve slots to observations + cameras
  const slotObs = activeSlots
    .map((id) => observations.find((o) => o.id === id))
    .filter((o): o is import("../data/types").ObservationDefinition => o != null);

  // Determine which camera IDs are in the feed
  const feedCameraIds = slotObs.length > 0
    ? [...new Set(slotObs.map((o) => o.cameraId))]
    : feedCameraId ? [feedCameraId] : [];

  // For counting state polling — use first active camera
  const primaryFeedCameraId = feedCameraIds[0] ?? feedCameraId;
  const hasActiveModel = feedObservations.some((o) => o.enabled);
  const countingState = useCountingState(primaryFeedCameraId, hasActiveModel);

  // Sessions: poll ALL sessions. Re-fetch immediately when tasks change.
  const [persistedSessions, setPersistedSessions] = useState<import("./useCountingState").CountingSession[]>([]);
  const enabledKey = allEnabled.map((o) => o.id).join(",");
  useEffect(() => {
    let running = true;
    async function fetchSessions() {
      try {
        const res = await fetch("/api/counting-sessions");
        if (res.ok && running) setPersistedSessions(await res.json());
      } catch { /* ignore */ }
    }
    // Immediate fetch when tasks change
    fetchSessions();
    // Then poll every 2s
    const interval = setInterval(fetchSessions, 2000);
    return () => { running = false; clearInterval(interval); };
  }, [enabledKey]);

  // Merge: active from all counting-state polls + completed from slow-poll
  const sessions = useMemo(() => {
    // Active sessions come from persistedSessions (status=active) with live counts
    // since fast-poll only covers one camera, we use the DB active sessions for all
    const active = persistedSessions.filter((s) => s.status === "active");
    const completed = persistedSessions.filter((s) => s.status === "completed");
    return [...active, ...completed];
  }, [persistedSessions]);

  const handleSave = useCallback(
    async (obs: ObservationDefinition) => {
      if (editingObs) {
        await update(obs.id, obs);
      } else {
        await create(obs);
      }
      setEditingObs(null);
    },
    [editingObs, create, update],
  );

  const handleEdit = useCallback(
    (id: string) => {
      const obs = observations.find((o) => o.id === id);
      if (obs) setEditingObs(obs);
    },
    [observations],
  );

  const handleCancelEdit = useCallback(() => {
    setEditingObs(null);
  }, []);

  useEffect(() => {
    document.body.classList.add("va-route");
    return () => {
      document.body.classList.remove("va-route");
    };
  }, []);

  return (
    <div className="va-page">
      <header className="va-page__header top-bar" aria-label="Vehicle analysis header">
        <div className="top-bar__cluster">
          <p className="top-bar__title">Vehicle Analysis</p>
          <p className="top-bar__subtitle">{facilityName}</p>
        </div>
        <div className="top-bar__status va-page__header-right">
          <button
            type="button"
            className="top-bar__editor-button va-page__nav-btn"
            onClick={() => onNavigate?.("/live")}
          >
            Dashboard
          </button>
          <button
            type="button"
            className="top-bar__editor-button va-page__nav-btn"
            onClick={() => onNavigate?.("/config")}
          >
            Editor
          </button>
          <button
            type="button"
            className="top-bar__editor-button va-page__nav-btn"
            onClick={() => onNavigate?.("/events")}
          >
            Event Detection
          </button>
        </div>
      </header>

      <div className="va-page__body">
        <aside className="va-page__setup panel">
          <SetupPanel
            snapshot={snapshot}
            availableCameraIds={allCameraIds}
            editingObservation={editingObs}
            onSave={handleSave}
            onCancel={editingObs ? handleCancelEdit : undefined}
            onCameraChange={setSetupCameraId}
          />
        </aside>

        <section className="va-page__observations panel">
          <ObservationsList
            observations={observations}
            liveData={liveData}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onToggle={toggle}
            onEdit={handleEdit}
            onDelete={remove}
            onDuplicate={duplicate}
          />
          <SessionLog sessions={sessions} />
        </section>

        <aside className="va-page__feed panel">
          {slotObs.length === 0 ? (
            <LiveFeedPanel
              cameraId={feedCameraId}
              cameraName={feedCamera?.name ?? feedCameraId ?? ""}
              activeObservations={feedObservations}
              trafficState={trafficState}
            />
          ) : slotObs.length === 1 ? (
            <LiveFeedPanel
              cameraId={slotObs[0].cameraId}
              cameraName={snapshot?.cameras?.find((c) => c.id === slotObs[0].cameraId)?.name ?? slotObs[0].cameraId}
              activeObservations={observations.filter((o) => o.cameraId === slotObs[0].cameraId)}
              trafficState={trafficState}
            />
          ) : (
            <>
              {slotObs.map((obs) => (
                <LiveFeedPanel
                  key={obs.id}
                  cameraId={obs.cameraId}
                  cameraName={snapshot?.cameras?.find((c) => c.id === obs.cameraId)?.name ?? obs.cameraId}
                  activeObservations={[obs]}
                  trafficState={trafficState}
                />
              ))}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
