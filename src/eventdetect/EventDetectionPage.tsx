import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useParkingClient } from "../api/parkingClientContext";
import { useSecurityTasks } from "./useEventDetection";
import { useSecurityState } from "./useSecurityState";
import { SecuritySetupPanel } from "./SecuritySetupPanel";
import { SecurityTaskList, EventStats } from "./SecurityTaskList";
import { EventFeedPanel } from "./EventFeedPanel";
import type { SecurityTask } from "./useEventDetection";

interface EventDetectionPageProps {
  onNavigate?(path: string): void;
}

export function EventDetectionPage({ onNavigate }: EventDetectionPageProps) {
  const client = useParkingClient();
  const snapshot = useSyncExternalStore(
    client.live.subscribe,
    client.live.getSnapshot,
    client.live.getSnapshot,
  );
  const facilityName = snapshot?.facilityName ?? "Facility";
  const { state, createTask, deleteTask, toggleTask } = useSecurityTasks();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cameras, setCameras] = useState<string[]>([]);
  const [setupCameraId, setSetupCameraId] = useState("");

  useEffect(() => {
    document.body.classList.add("ed-route");
    return () => document.body.classList.remove("ed-route");
  }, []);

  useEffect(() => {
    fetch("/api/security/cameras")
      .then((r) => r.json())
      .then((ids: string[]) => {
        setCameras(ids);
        if (ids.length > 0 && !setupCameraId) setSetupCameraId(ids[0]);
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Active slots: max 2 tasks (same as VehicleAnalysisPage) ──
  const [activeSlots, setActiveSlots] = useState<string[]>([]);
  const allEnabled = state.tasks.filter((t) => t.enabled);

  useEffect(() => {
    const enabledIds = new Set(allEnabled.map((t) => t.id));
    setActiveSlots((prev) => {
      const kept = prev.filter((id) => enabledIds.has(id));
      for (const t of allEnabled) {
        if (!kept.includes(t.id)) kept.push(t.id);
      }
      return kept.slice(-2);
    });
  }, [allEnabled.map((t) => t.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const slotTasks = activeSlots
    .map((id) => state.tasks.find((t) => t.id === id))
    .filter((t): t is SecurityTask => t != null);

  const selectedTask = useMemo(
    () => state.tasks.find((t) => t.id === selectedId) ?? null,
    [state.tasks, selectedId],
  );

  const feedCameraId = useMemo(
    () => (selectedTask?.cameraId ?? setupCameraId) || cameras[0] || null,
    [selectedTask, setupCameraId, cameras],
  );

  // ── Polling at PAGE level (like counting's useCountingState) ──
  // One poll per camera in active slots
  const activeCameraId0 = slotTasks[0]?.cameraId ?? feedCameraId;
  const activeCameraId1 = slotTasks[1]?.cameraId ?? null;
  const hasSlot0 = slotTasks.length >= 1;
  const hasSlot1 = slotTasks.length >= 2;

  const cameraState0 = useSecurityState(activeCameraId0, hasSlot0);
  const cameraState1 = useSecurityState(activeCameraId1, hasSlot1);

  // ── Callbacks ──

  const handleSaveTask = useCallback(
    async (task: SecurityTask) => {
      try { await createTask(task); } catch (err) { console.error(err); }
    },
    [createTask],
  );

  const handleToggle = useCallback(
    (taskId: string, enabled: boolean) => { toggleTask(taskId, enabled).catch(console.error); },
    [toggleTask],
  );

  const handleDelete = useCallback(
    (taskId: string) => {
      deleteTask(taskId).catch(console.error);
      if (selectedId === taskId) setSelectedId(null);
    },
    [deleteTask, selectedId],
  );

  const handleSelect = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      const task = id ? state.tasks.find((t) => t.id === id) : null;
      if (task) setSetupCameraId(task.cameraId);
    },
    [state.tasks],
  );

  return (
    <div className="ed-page">
      <header className="ed-page__header top-bar" aria-label="Event analysis header">
        <div className="top-bar__cluster">
          <p className="top-bar__title">Event Analysis</p>
          <p className="top-bar__subtitle">{facilityName}</p>
        </div>
        <div className="top-bar__status ed-page__header-right">
          <button className="top-bar__editor-button ed-page__nav-btn" onClick={() => onNavigate?.("/live")}>Dashboard</button>
          <button className="top-bar__editor-button ed-page__nav-btn" onClick={() => onNavigate?.("/config")}>Editor</button>
          <button className="top-bar__editor-button ed-page__nav-btn" onClick={() => onNavigate?.("/analysis")}>Vehicle Analysis</button>
        </div>
      </header>

      <div className="ed-page__body">
        <aside className="ed-page__setup panel">
          <SecuritySetupPanel
            cameraId={setupCameraId}
            availableCameraIds={cameras}
            onCameraChange={setSetupCameraId}
            onSave={handleSaveTask}
          />
        </aside>

        <section className="ed-page__observations panel">
          <SecurityTaskList
            tasks={state.tasks}
            events={state.events}
            activeCameras={state.activeCameras}
            taskCounts={state.taskCounts}
            selectedId={selectedId}
            onSelect={handleSelect}
            onToggle={handleToggle}
            onDelete={handleDelete}
          />
          <EventStats events={state.events} cameraId={feedCameraId} />
        </section>

        <aside className="ed-page__feed panel">
          {/* Slot 0 — always rendered, never unmounted */}
          <EventFeedPanel
            cameraId={slotTasks[0]?.cameraId ?? feedCameraId}
            cameraState={cameraState0}
            activeTask={slotTasks[0] ?? null}
            events={state.events}
            drawingPoints={[]}
            drawMode={null}
          />
          {/* Slot 1 — if same camera, share cameraState0 (already has correct position) */}
          {slotTasks.length >= 2 && (
            <EventFeedPanel
              cameraId={slotTasks[1].cameraId}
              cameraState={slotTasks[1].cameraId === slotTasks[0]?.cameraId ? cameraState0 : cameraState1}
              activeTask={slotTasks[1]}
              events={state.events}
              drawingPoints={[]}
              drawMode={null}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
