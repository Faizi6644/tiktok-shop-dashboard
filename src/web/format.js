/** Display helpers used by the EJS views (available as `fmt` in every template). */

const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** "1234.5" -> "$1,234.50". Only for display; sums are done in SQL. */
export const usd = (s) => usdFmt.format(Number(s ?? 0));

/** A date/time in a given timezone, e.g. "Sep 22, 2026, 1:04 PM PDT". */
export function dateTime(d, timeZone) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-US', { timeZone, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

/** Unix seconds -> date/time. */
export const unix = (sec, timeZone) => (sec ? dateTime(Number(sec) * 1000, timeZone) : '—');

/** "3 min ago" */
export function ago(d) {
  if (!d) return 'never';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 0) return `in ${inWords(-s)}`;
  return `${inWords(s)} ago`;
}
function inWords(s) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} days`;
}

/** "2026-09-22" -> "Sep 22" */
export const shortDay = (ymd) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * Bar chart geometry for the daily sales SVG (drawn on the server, no chart library, no JS).
 * Returns bars plus y-axis ticks with "nice" round steps.
 */
export function chart(daily, { width = 900, height = 260, padL = 64, padB = 28, padT = 10 } = {}) {
  const values = daily.map((d) => Number(d.net_sales));
  const max = Math.max(0, ...values);
  const step = niceStep(max / 4 || 1);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const plotW = width - padL - 8;
  const plotH = height - padB - padT;
  const slot = plotW / daily.length;
  const barW = Math.max(1, Math.min(24, slot * 0.7));
  const bars = daily.map((d, i) => {
    const v = Math.max(0, Number(d.net_sales));
    const h = (v / top) * plotH;
    return {
      x: padL + i * slot + (slot - barW) / 2,
      y: padT + plotH - h,
      w: barW,
      h,
      label: `${shortDay(d.day)}: ${usd(d.net_sales)} (${d.orders} orders)`,
      day: d.day,
      showLabel: daily.length <= 14 || i % Math.ceil(daily.length / 10) === 0,
      cx: padL + i * slot + slot / 2,
    };
  });
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push({ v, y: padT + plotH - (v / top) * plotH });
  return { width, height, padL, padT, plotH, plotW, bars, ticks, baseY: padT + plotH };
}
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
