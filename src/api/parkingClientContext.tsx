import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { ParkingAppClient } from "./parkingClient";

const ParkingClientContext = createContext<ParkingAppClient | null>(null);

interface ParkingClientProviderProps {
  client: ParkingAppClient;
  children: ReactNode;
}

export function ParkingClientProvider({
  client,
  children,
}: ParkingClientProviderProps) {
  return (
    <ParkingClientContext.Provider value={client}>
      {children}
    </ParkingClientContext.Provider>
  );
}

export function useParkingClient() {
  const client = useContext(ParkingClientContext);

  if (!client) {
    throw new Error("Parking client context is missing");
  }

  return client;
}
