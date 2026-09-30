// Small formatting helpers shared by the upload and admin pages.

export function ago(iso) {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function until(iso) {
  if (!iso) return null;
  const s = Math.round((new Date(iso) - Date.now()) / 1000);
  if (s < 60) return "any moment";
  if (s < 5400) return `in ${Math.round(s / 60)} min`;
  if (s < 129600) return `in ${Math.round(s / 3600)} h`;
  return `in ${Math.round(s / 86400)} days`;
}

// LiPo: ~4.15 V full, ~3.3 V empty under load
export function batteryPct(mv) {
  if (!mv) return null;
  return Math.max(0, Math.min(100, Math.round(((mv - 3300) / (4150 - 3300)) * 100)));
}

export const LOW_BATTERY_PCT = 20;

export function rotateLabel(hours) {
  return ({ 0: "only when a new picture arrives", 1: "every hour", 24: "every day", 168: "every week" })[hours]
    || (hours % 24 === 0 ? `every ${hours / 24} days` : `every ${hours} hours`);
}

export function checkLabel(minutes) {
  return minutes < 60 ? `every ${minutes} minutes` : minutes === 60 ? "every hour" : `every ${minutes / 60} hours`;
}

export const hourLabel = (h) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" });
