export function clampDb(metering: unknown): number | null {
  if (typeof metering !== "number" || Number.isNaN(metering)) return null;
  return Math.max(-160, Math.min(0, metering));
}

export function msNow() {
  return Date.now();
}
