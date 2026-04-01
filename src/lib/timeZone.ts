export const DEFAULT_UI_TIME_ZONE = "Europe/Rome";

export function resolveTimeZone(timeZone?: string | null) {
  const candidate = timeZone?.trim();
  if (!candidate) {
    return DEFAULT_UI_TIME_ZONE;
  }

  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return DEFAULT_UI_TIME_ZONE;
  }
}
