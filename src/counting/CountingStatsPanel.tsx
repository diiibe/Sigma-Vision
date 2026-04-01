import type { CountingSummary } from "../api/parkingClient";

interface CountingStatsPanelProps {
  summary: CountingSummary;
}

export function CountingStatsPanel({ summary }: CountingStatsPanelProps) {
  const net = summary.entriesTotal - summary.exitsTotal;
  const netSign = net > 0 ? "+" : "";

  return (
    <div className="counting-stats">
      <h3 className="counting-stats__title">Traffic Summary</h3>
      <div className="counting-stats__grid">
        <StatCard label="Entries (1h)" value={summary.entriesLastHour} accent="entry" />
        <StatCard label="Exits (1h)" value={summary.exitsLastHour} accent="exit" />
        <StatCard label="Total Entries" value={summary.entriesTotal} accent="entry" />
        <StatCard label="Total Exits" value={summary.exitsTotal} accent="exit" />
        <StatCard
          label="Net Flow"
          value={`${netSign}${net}`}
          accent={net >= 0 ? "entry" : "exit"}
          wide
        />
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
  wide,
}: {
  label: string;
  value: number | string;
  accent: "entry" | "exit";
  wide?: boolean;
}) {
  return (
    <div className={`counting-stats__card counting-stats__card--${accent} ${wide ? "counting-stats__card--wide" : ""}`}>
      <span className="counting-stats__card-label">{label}</span>
      <strong className="counting-stats__card-value">{value}</strong>
    </div>
  );
}
