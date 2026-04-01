import type { CountingSession } from "./useCountingState";

function formatTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDate(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function SessionLog({ sessions }: { sessions: CountingSession[] }) {
  if (!sessions.length) return null;
  const active = sessions.filter((s) => s.status === "active");
  const completed = sessions.filter((s) => s.status === "completed");
  const totalIn = active.filter((s) => s.task_type === "entry").reduce((sum, s) => sum + s.entries, 0);
  const totalOut = active.filter((s) => s.task_type === "exit").reduce((sum, s) => sum + s.exits, 0);
  const showNet = active.some((s) => s.task_type === "entry") && active.some((s) => s.task_type === "exit");

  return (
    <section className="va-session-log panel-section">
      <div className="section-heading va-session-log__heading">
        <div>
          <h2>Session Log</h2>
          <p>Active counters and recent completed runs.</p>
        </div>
      </div>
      <div className="va-feed__log">
        {active.length > 0 && (
          <div className="va-feed__log-section">
            <div className="va-feed__log-title">Active</div>
            {active.map((s) => (
              <div key={s.id} className={`va-feed__log-row is-${s.task_type}`}>
                <span className="va-feed__log-name">{s.observation_name}</span>
                <span className="va-feed__log-type">{s.task_type === "entry" ? "IN" : "OUT"}</span>
                <span className="va-feed__log-count">{s.task_type === "entry" ? s.entries : s.exits}</span>
                <span className="va-feed__log-time">{formatTime(s.started_at)}</span>
              </div>
            ))}
            {showNet && (
              <div className="va-feed__log-row is-net">
                <span className="va-feed__log-name">Net flow</span>
                <span className="va-feed__log-type">&Delta;</span>
                <span className="va-feed__log-count">{totalIn - totalOut >= 0 ? "+" : ""}{totalIn - totalOut}</span>
                <span className="va-feed__log-time">{totalIn} in / {totalOut} out</span>
              </div>
            )}
          </div>
        )}
        {completed.length > 0 && (
          <div className="va-feed__log-section">
            <div className="va-feed__log-title">History</div>
            {completed.slice(0, 10).map((s) => {
              const isNet = s.observation_name === "Net flow";
              const isDensity = s.task_type === "density";
              return (
                <div key={s.id} className={`va-feed__log-row ${isNet ? "is-net" : "is-completed"}`}>
                  <span className="va-feed__log-name">{s.observation_name}</span>
                  <span className="va-feed__log-type">
                    {isNet ? "\u0394" : isDensity ? "ZONE" : s.task_type === "entry" ? "IN" : "OUT"}
                  </span>
                  <span className="va-feed__log-count">
                    {isNet
                      ? `${s.entries - s.exits >= 0 ? "+" : ""}${s.entries - s.exits}`
                      : isDensity
                      ? (s.entries > 0 ? `peak ${s.entries}${s.exits ? `/${s.exits}` : ""} ⚠` : "no alerts")
                      : s.task_type === "entry" ? s.entries : s.exits}
                  </span>
                  <span className="va-feed__log-time">
                    {isNet
                      ? `${s.entries} in / ${s.exits} out`
                      : `${formatDate(s.started_at)} ${formatTime(s.started_at)} — ${formatTime(s.stopped_at)}`}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
