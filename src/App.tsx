import { useEffect, useMemo, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { TacticalDashboard } from "./dashboard/TacticalDashboard";
import { LotEditorPage } from "./editor/LotEditorPage";
import { TrafficCountingPage } from "./counting/TrafficCountingPage";
import { VehicleAnalysisPage } from "./counting/VehicleAnalysisPage";
import { EventDetectionPage } from "./eventdetect/EventDetectionPage";
import { ParkingClientProvider } from "./api/parkingClientContext";
import { createBrowserParkingClient, type ParkingAppClient } from "./api/parkingClient";
import { createMockParkingClient } from "./api/parkingClientMock";
import sigmaVisionLogo from "./assets/sigma-vision-logo.jpeg";

interface AppProps {
  client?: ParkingAppClient;
}

function useBackendReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    async function check() {
      while (active && !ready) {
        try {
          const res = await fetch("/api/security/ready");
          if (res.ok) {
            const data = await res.json();
            if (data.ready) { setReady(true); return; }
          }
        } catch { /* server not up yet */ }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    check();
    return () => { active = false; };
  }, [ready]);
  return ready;
}

export default function App({ client }: AppProps) {
  const appClient = useMemo(() => client ?? createBrowserParkingClient(), [client]);
  const backendReady = useBackendReady();

  useEffect(() => {
    return () => {
      appClient.destroy();
    };
  }, [appClient]);

  if (!backendReady) {
    return (
      <div className="app-loading">
        <div className="app-loading__content">
          <img
            className="app-loading__logo"
            src={sigmaVisionLogo}
            alt="Sigma Vision"
          />
          <p className="app-loading__text">Loading models...</p>
          <div className="app-loading__spinner" />
        </div>
      </div>
    );
  }

  return (
    <ParkingClientProvider client={appClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/live" replace />} />
          <Route path="/live" element={<LiveRoute />} />
          <Route path="/analysis" element={<AnalysisRoute />} />
          <Route path="/counting" element={<CountingRoute />} />
          <Route path="/config" element={<ConfigRoute />} />
          <Route path="/events" element={<EventsRoute />} />
          <Route path="/editor" element={<Navigate to="/config" replace />} />
          <Route path="*" element={<Navigate to="/live" replace />} />
        </Routes>
      </BrowserRouter>
    </ParkingClientProvider>
  );
}

function LiveRoute() {
  const navigate = useNavigate();

  return (
    <TacticalDashboard
      onOpenEditor={() => navigate("/config")}
      onOpenCounting={() => navigate("/analysis")}
      onOpenEvents={() => navigate("/events")}
    />
  );
}

function AnalysisRoute() {
  const navigate = useNavigate();

  return <VehicleAnalysisPage onNavigate={(path) => navigate(path)} />;
}

function CountingRoute() {
  const navigate = useNavigate();

  return <TrafficCountingPage onNavigate={(path) => navigate(path)} />;
}

function EventsRoute() {
  const navigate = useNavigate();

  return <EventDetectionPage onNavigate={(path) => navigate(path)} />;
}

function ConfigRoute() {
  const navigate = useNavigate();

  return <LotEditorPage onClose={() => navigate("/live")} />;
}

export function createAppTestClient() {
  return createMockParkingClient();
}

export const createAppTestRuntime = createAppTestClient;
