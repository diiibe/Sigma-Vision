import { useCallback, useEffect, useRef, useState } from "react";
import type { ParkingAppClient } from "../api/parkingClient";
import type { ObservationDefinition } from "../data/types";

export interface ObservationsState {
  observations: ObservationDefinition[];
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  create(obs: ObservationDefinition): Promise<ObservationDefinition>;
  update(id: string, obs: ObservationDefinition): Promise<ObservationDefinition>;
  remove(id: string): Promise<void>;
  toggle(id: string, enabled: boolean): Promise<void>;
  duplicate(id: string): Promise<ObservationDefinition | null>;
}

export function useObservations(client: ParkingAppClient, pollMs = 5000): ObservationsState {
  const [observations, setObservations] = useState<ObservationDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const disposed = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const list = await client.observations.list();
      if (!disposed.current) {
        setObservations(list);
        setError(null);
        setLoading(false);
      }
    } catch (err) {
      if (!disposed.current) {
        setError(err instanceof Error ? err.message : "Failed to load observations");
        setLoading(false);
      }
    }
  }, [client]);

  const create = useCallback(
    async (obs: ObservationDefinition) => {
      const created = await client.observations.create(obs);
      await refresh();
      return created;
    },
    [client, refresh],
  );

  const update = useCallback(
    async (id: string, obs: ObservationDefinition) => {
      const updated = await client.observations.update(id, obs);
      await refresh();
      return updated;
    },
    [client, refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await client.observations.remove(id);
      await refresh();
    },
    [client, refresh],
  );

  const toggle = useCallback(
    async (id: string, enabled: boolean) => {
      await client.observations.toggle(id, enabled);
      await refresh();
    },
    [client, refresh],
  );

  const duplicate = useCallback(
    async (id: string) => {
      const original = observations.find((o) => o.id === id);
      if (!original) return null;
      const now = new Date().toISOString();
      const copy: ObservationDefinition = {
        ...original,
        id: `obs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: `${original.name} (copy)`,
        enabled: false,
        createdAt: now,
        updatedAt: now,
      };
      const created = await client.observations.create(copy);
      await refresh();
      return created;
    },
    [client, observations, refresh],
  );

  useEffect(() => {
    disposed.current = false;
    void refresh();
    const timer = window.setInterval(() => void refresh(), pollMs);
    return () => {
      disposed.current = true;
      window.clearInterval(timer);
    };
  }, [refresh, pollMs]);

  return { observations, loading, error, refresh, create, update, remove, toggle, duplicate };
}
