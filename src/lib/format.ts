const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Format an ISO-ish timestamp as "Jun 18, 2026" deterministically (no locale/timezone),
 * so server and client render identically (avoids hydration mismatches).
 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = iso.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso.slice(0, 10);
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}
