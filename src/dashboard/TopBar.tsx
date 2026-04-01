import { useEffect, useState } from "react";
import { formatClock } from "../lib/format";

interface TopBarProps {
  systemStatus: "online" | "degraded";
  connectionHealth: "stable" | "degraded";
  timeZone: string;
  onOpenEditor?(): void;
  onOpenCounting?(): void;
  onOpenEvents?(): void;
}

export function TopBar({
  systemStatus,
  connectionHealth,
  timeZone,
  onOpenEditor,
  onOpenCounting,
  onOpenEvents,
}: TopBarProps) {
  const [now, setNow] = useState(() => new Date().toISOString());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date().toISOString());
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  return (
    <header className="top-bar" aria-label="System header">
      <div className="top-bar__cluster">
        <p className="top-bar__title">Sigma Vision</p>
      </div>

      <div className="top-bar__clock" aria-live="polite">
        <span className="top-bar__clock-label">Local system time</span>
        <strong>{formatClock(now, timeZone)}</strong>
      </div>

      <div className="top-bar__status">
        <span className={`signal signal--${systemStatus}`} />
        <div>
          <strong>
            {systemStatus === "online" ? "SYSTEM ONLINE" : "SYSTEM DEGRADED"}
          </strong>
          <p>
            {connectionHealth === "stable"
              ? "Telemetry link stable"
              : "Telemetry under review"}
          </p>
        </div>
        {onOpenEvents ? (
          <button type="button" className="top-bar__editor-button" onClick={onOpenEvents}>
            Event Detection
          </button>
        ) : null}
        {onOpenCounting ? (
          <button type="button" className="top-bar__editor-button" onClick={onOpenCounting}>
            Vehicle Analysis
          </button>
        ) : null}
        {onOpenEditor ? (
          <button type="button" className="top-bar__editor-button" onClick={onOpenEditor}>
            Edit lot
          </button>
        ) : null}
      </div>
    </header>
  );
}
