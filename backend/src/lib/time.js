/** Time-zone helpers shared by the seed script and the importer (no dependencies). */

// Intl formatters are expensive to build; reuse one per time zone and kind.
const cache = new Map();
const fmt = (kind, tz, options) => {
  const key = `${kind}|${tz}`;
  if (!cache.has(key)) cache.set(key, new Intl.DateTimeFormat(kind === 'date' ? 'en-CA' : 'en-US', { timeZone: tz, ...options }));
  return cache.get(key);
};

/** Offset (ms) of `tz` from UTC at the given instant, rounded to whole minutes. */
export function tzOffsetMs(date, tz) {
  const p = Object.fromEntries(
    fmt('parts', tz, {
      hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((x) => [x.type, x.value]),
  );
  const diff = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
  return Math.round(diff / 60_000) * 60_000;
}

/** UTC instant for local wall-clock minutes-after-midnight on a business date (YYYY-MM-DD). */
export function localToUtc(isoDate, minutes, tz) {
  const guess = new Date(`${isoDate}T00:00:00Z`).getTime() + minutes * 60_000;
  return new Date(guess - tzOffsetMs(new Date(guess), tz));
}

/** UTC instant for a local wall-clock date-time given as parts. */
export function localPartsToUtc({ y, mo, d, h = 0, mi = 0, s = 0 }, tz) {
  const iso = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return new Date(localToUtc(iso, h * 60 + mi, tz).getTime() + s * 1000);
}

/** Local business date (YYYY-MM-DD) of an instant. */
export function localDateISO(date, tz) {
  return fmt('date', tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Local hour (0–23) of an instant. */
export function localHour(date, tz) {
  return Number(fmt('hour', tz, { hour: '2-digit', hourCycle: 'h23' }).format(date));
}
