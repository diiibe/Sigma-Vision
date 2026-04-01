import { resolveTimeZone } from "./timeZone";

export function formatClock(dateValue: string, timeZone: string) {
  const resolvedTimeZone = resolveTimeZone(timeZone);
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: resolvedTimeZone,
  }).format(new Date(dateValue));
}

export function formatShortTime(dateValue: string, timeZone = "UTC") {
  const resolvedTimeZone = resolveTimeZone(timeZone);
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: resolvedTimeZone,
  }).format(new Date(dateValue));
}

export function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

export function titleCase(input: string) {
  return input
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
