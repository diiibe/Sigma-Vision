import { useCallback, useEffect, useRef, useState } from "react";

// ── Data types matching backend schemas ──

export interface SecurityZone {
  id: string;
  name: string;
  points: [number, number][];
  detectEntry: boolean;
  detectDwelling: boolean;
  dwellThresholdSec: number;
  detectRunning: boolean;
  detectChasing: boolean;
  detectAltercation: boolean;
  speedThreshold: number;
  altercationProximity: number;
  detectCrowdGathering: boolean;
  crowdThreshold: number;
}

export interface SecurityLine {
  id: string;
  name: string;
  points: [number, number][];
  enabled: boolean;
}

export interface SecurityTask {
  id: string;
  cameraId: string;
  zones: SecurityZone[];
  lines: SecurityLine[];
  sampleRate: number;
  enabled: boolean;
}

export interface SecurityEvent {
  id: string;
  cameraId: string;
  eventType: string;
  trackIds: string[];
  confidence: number;
  timestamp: string;
  timestampSec: number;
  zoneId: string | null;
  lineId: string | null;
}

export interface BackendTaskEventCounts {
  zone_entry: number;
  dwelling: number;
  running: number;
  chasing: number;
  altercation: number;
  crowd_gathering: number;
  line_crossing: number;
  total: number;
}

export interface SecurityServiceState {
  tasks: SecurityTask[];
  events: SecurityEvent[];
  activeCameras: string[];
  taskCounts: Record<string, BackendTaskEventCounts>;
}

// ── API ──

const API = "/api/security";

export function useSecurityTasks(pollMs = 2000) {
  const [state, setState] = useState<SecurityServiceState>({
    tasks: [],
    events: [],
    activeCameras: [],
    taskCounts: {},
  });

  const runningRef = useRef(true);
  useEffect(() => {
    runningRef.current = true;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      if (!runningRef.current) return;
      try {
        const res = await fetch(`${API}/state`);
        if (res.ok) setState(await res.json());
      } catch { /* ignore */ }
      if (runningRef.current) timer = setTimeout(poll, pollMs);
    }

    poll();
    return () => {
      runningRef.current = false;
      clearTimeout(timer);
    };
  }, [pollMs]);

  const createTask = useCallback(async (task: SecurityTask): Promise<SecurityTask> => {
    const res = await fetch(`${API}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(task),
    });
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as SecurityTask;
  }, []);

  const deleteTask = useCallback(async (taskId: string) => {
    await fetch(`${API}/tasks/${taskId}`, { method: "DELETE" });
  }, []);

  const toggleTask = useCallback(async (taskId: string, enabled: boolean) => {
    // Optimistic update — don't block UI waiting for response
    setState((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) => (t.id === taskId ? { ...t, enabled } : t)),
      activeCameras: enabled
        ? [...prev.activeCameras, prev.tasks.find((t) => t.id === taskId)?.cameraId ?? ""]
        : prev.activeCameras.filter((c) => c !== prev.tasks.find((t) => t.id === taskId)?.cameraId),
    }));
    fetch(`${API}/tasks/${taskId}?enabled=${enabled}`, { method: "PATCH" });
  }, []);

  return { state, createTask, deleteTask, toggleTask };
}

// ── Event counts per task ──

export interface TaskEventCounts {
  zone_entry: number;
  dwelling: number;
  line_crossing: number;
  running: number;
  chasing: number;
  altercation: number;
  crowd_gathering: number;
  total: number;
}

export function computeTaskEventCounts(
  events: SecurityEvent[],
  task: SecurityTask,
): TaskEventCounts {
  // Build set of event types this task monitors
  const activeTypes = new Set<string>();
  for (const z of task.zones) {
    if (z.detectEntry) activeTypes.add("zone_entry");
    if (z.detectDwelling) activeTypes.add("dwelling");
    if (z.detectRunning) activeTypes.add("running");
    if (z.detectChasing) activeTypes.add("chasing");
    if (z.detectAltercation) activeTypes.add("altercation");
    if (z.detectCrowdGathering) activeTypes.add("crowd_gathering");
  }
  const relevant = events.filter((e) => e.cameraId === task.cameraId && activeTypes.has(e.eventType));
  const counts: TaskEventCounts = {
    zone_entry: 0,
    dwelling: 0,
    line_crossing: 0,
    running: 0,
    chasing: 0,
    altercation: 0,
    crowd_gathering: 0,
    total: 0,
  };
  for (const e of relevant) {
    const key = e.eventType as keyof TaskEventCounts;
    if (key in counts && key !== "total") {
      (counts as Record<string, number>)[key]++;
    }
    counts.total++;
  }
  return counts;
}
