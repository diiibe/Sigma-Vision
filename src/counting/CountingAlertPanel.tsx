import type { AlertEvent } from "../data/types";

interface CountingAlertPanelProps {
  alerts: AlertEvent[];
}

export function CountingAlertPanel({ alerts }: CountingAlertPanelProps) {
  const countingAlerts = alerts.filter(
    (a) => a.alertId.startsWith("cnt-alert-") && a.active,
  );

  if (countingAlerts.length === 0) {
    return (
      <div className="counting-alerts">
        <h3 className="counting-alerts__title">Traffic Alerts</h3>
        <p className="counting-alerts__empty">No active alerts</p>
      </div>
    );
  }

  return (
    <div className="counting-alerts">
      <h3 className="counting-alerts__title">Traffic Alerts</h3>
      <div className="counting-alerts__list">
        {countingAlerts.map((alert) => (
          <div
            key={alert.alertId}
            className={`counting-alerts__item counting-alerts__item--${alert.severity}`}
          >
            <span className="counting-alerts__severity">{alert.severity.toUpperCase()}</span>
            <span className="counting-alerts__explanation">{alert.explanation}</span>
            <span className="counting-alerts__value">
              {alert.currentValue != null ? alert.currentValue : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
