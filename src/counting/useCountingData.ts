import { useCallback, useEffect, useRef, useState } from "react";
import type { ParkingAppClient, CountingSummary } from "../api/parkingClient";
import type { CountingEvent, DensitySnapshot, CountingAggregatePoint } from "../data/types";

interface CountingData {
  events: CountingEvent[];
  summary: CountingSummary;
  density: DensitySnapshot[];
  aggregates: CountingAggregatePoint[];
  loading: boolean;
}

const EMPTY_SUMMARY: CountingSummary = {
  entriesTotal: 0,
  exitsTotal: 0,
  entriesLastHour: 0,
  exitsLastHour: 0,
};

export function useCountingData(client: ParkingAppClient, pollMs = 5000): CountingData {
  const [data, setData] = useState<CountingData>({
    events: [],
    summary: EMPTY_SUMMARY,
    density: [],
    aggregates: [],
    loading: true,
  });
  const disposed = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const [events, summary, density, aggregates] = await Promise.all([
        client.counting.listEvents({ limit: 50 }),
        client.counting.getSummary(),
        client.counting.listDensity({ limit: 20 }),
        client.counting.listAggregates({ granularity: "hourly" }),
      ]);
      if (!disposed.current) {
        setData({ events, summary, density, aggregates, loading: false });
      }
    } catch {
      if (!disposed.current) {
        setData((prev) => ({ ...prev, loading: false }));
      }
    }
  }, [client]);

  useEffect(() => {
    disposed.current = false;
    void refresh();
    const timer = window.setInterval(() => void refresh(), pollMs);
    return () => {
      disposed.current = true;
      window.clearInterval(timer);
    };
  }, [refresh, pollMs]);

  return data;
}
