// "auto" yields "yesterday", "last month" and "last year" for a distance of one.
const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** An English phrase for how long before `now` (ms) the Unix-seconds time was; future reads "just now". */
export function relativeTime(unixSeconds: number, now: number): string {
  const s = now / 1000 - unixSeconds;
  if (s < 45) return "just now";
  const m = s / 60;
  const h = m / 60;
  const d = h / 24;
  if (m < 45) return rtf.format(-Math.max(1, Math.round(m)), "minute");
  if (h < 22) return rtf.format(-Math.max(1, Math.round(h)), "hour");
  if (d < 26) return rtf.format(-Math.max(1, Math.round(d)), "day");
  if (d < 11 * 30) return rtf.format(-Math.max(1, Math.round(d / 30)), "month");
  return rtf.format(-Math.max(1, Math.round(d / 365)), "year");
}

/** The viewer's locale rendering of a Unix-seconds time. */
export const fullDate = (unixSeconds: number) => new Date(unixSeconds * 1000).toLocaleString();
