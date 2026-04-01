import { useMemo } from "react";
import type {
  CountingEvent,
  DensitySnapshot,
  ObservationDefinition,
  TrafficCountingState,
} from "../data/types";

export interface ObservationLiveEntry {
  observation: ObservationDefinition;
  liveCount: number;
  recentEvents: CountingEvent[];
}

export interface PairSummary {
  associationType: string;
  associationId: string | null;
  label: string;
  entries: number;
  exits: number;
  net: number;
  observations: ObservationDefinition[];
}

export interface ObservationLiveData {
  byId: Map<string, ObservationLiveEntry>;
  pairs: PairSummary[];
  cameraObservations(cameraId: string): ObservationDefinition[];
}

export function useObservationLiveData(
  observations: ObservationDefinition[],
  trafficState: TrafficCountingState | null | undefined,
): ObservationLiveData {
  return useMemo(() => {
    const events = trafficState?.countingEvents ?? [];
    const density = trafficState?.densitySnapshots ?? [];

    // Count events per lineId (observation id is used as lineId)
    const entryCountById = new Map<string, number>();
    const exitCountById = new Map<string, number>();
    for (const e of events) {
      if (e.eventType === "entry") {
        entryCountById.set(e.lineId, (entryCountById.get(e.lineId) ?? 0) + 1);
      } else {
        exitCountById.set(e.lineId, (exitCountById.get(e.lineId) ?? 0) + 1);
      }
    }

    // Latest density per zoneId
    const latestDensity = new Map<string, DensitySnapshot>();
    for (const d of density) {
      const existing = latestDensity.get(d.zoneId);
      if (!existing || d.timestamp > existing.timestamp) {
        latestDensity.set(d.zoneId, d);
      }
    }

    // Build per-observation live data
    const byId = new Map<string, ObservationLiveEntry>();
    for (const obs of observations) {
      let liveCount = 0;
      if (obs.taskType === "entry") {
        liveCount = entryCountById.get(obs.id) ?? 0;
      } else if (obs.taskType === "exit") {
        liveCount = exitCountById.get(obs.id) ?? 0;
      } else if (obs.taskType === "density") {
        const snap = latestDensity.get(obs.id);
        liveCount = snap?.vehicleCount ?? 0;
      }
      const recentEvents = events.filter((e) => e.lineId === obs.id).slice(0, 10);
      byId.set(obs.id, { observation: obs, liveCount, recentEvents });
    }

    // Build pair summaries grouped by (associationType, associationId)
    const groupKey = (obs: ObservationDefinition) =>
      `${obs.associationType}::${obs.associationId ?? ""}`;

    const groups = new Map<string, ObservationDefinition[]>();
    for (const obs of observations) {
      const key = groupKey(obs);
      const list = groups.get(key) ?? [];
      list.push(obs);
      groups.set(key, list);
    }

    const pairs: PairSummary[] = [];
    for (const [, groupObs] of groups) {
      const first = groupObs[0];
      const entries = groupObs
        .filter((o) => o.taskType === "entry" && o.enabled)
        .reduce((sum, o) => sum + (byId.get(o.id)?.liveCount ?? 0), 0);
      const exits = groupObs
        .filter((o) => o.taskType === "exit" && o.enabled)
        .reduce((sum, o) => sum + (byId.get(o.id)?.liveCount ?? 0), 0);

      const label =
        first.associationType === "facility"
          ? "Whole Facility"
          : first.associationId ?? first.associationType;

      pairs.push({
        associationType: first.associationType,
        associationId: first.associationId ?? null,
        label,
        entries,
        exits,
        net: entries - exits,
        observations: groupObs,
      });
    }

    const cameraObservations = (cameraId: string) =>
      observations.filter((o) => o.cameraId === cameraId);

    return { byId, pairs, cameraObservations };
  }, [observations, trafficState]);
}
