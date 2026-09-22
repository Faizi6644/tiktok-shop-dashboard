/**
 * Calendar-date helpers in an IANA timezone, using the built-in Intl API
 * (MySQL's CONVERT_TZ needs timezone tables that are often not installed).
 */

/** Unix seconds -> 'YYYY-MM-DD' in the given timezone. */
export function localDate(unixSec, timeZone) {
  // en-CA formats as YYYY-MM-DD
  return new Date(unixSec * 1000).toLocaleDateString('en-CA', { timeZone });
}

/** Today's date in the given timezone. */
export function todayIn(timeZone) {
  return localDate(Math.floor(Date.now() / 1000), timeZone);
}

/** 'YYYY-MM-DD' plus n days (pure calendar arithmetic, no timezone involved). */
export function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Inclusive list of dates from..to. */
export function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
