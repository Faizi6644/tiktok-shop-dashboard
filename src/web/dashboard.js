import { pool } from '../db/pool.js';
import { salesSummary, salesBridge, syncFreshness, SALES_DEFINITION } from '../metrics.js';
import { todayIn, addDays, isYmd } from '../time.js';

export class BadRangeError extends Error {}

const MAX_DAYS = 366;

/** Validate ?from&to. Default: the last 30 days including today, in the shop's timezone. */
export function parseRange(from, to, timeZone) {
  const today = todayIn(timeZone);
  if (!from && !to) return { from: addDays(today, -29), to: today };
  if (!isYmd(from) || !isYmd(to)) throw new BadRangeError('Dates must be in YYYY-MM-DD format.');
  if (from > to) throw new BadRangeError('The start date must be on or before the end date.');
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > MAX_DAYS) throw new BadRangeError(`Pick at most ${MAX_DAYS} days.`);
  return { from, to };
}

/** Everything the client page needs, read from MySQL only. */
export async function dashboardData(shopId, fromQ, toQ) {
  if (!shopId) return null;
  const [[shop]] = await pool.query('SELECT id, name, region, timezone FROM shops WHERE id = ?', [shopId]);
  if (!shop) return null;
  const { from, to } = parseRange(fromQ, toQ, shop.timezone);
  const [summary, bridge, freshness] = await Promise.all([
    salesSummary(shop.id, from, to),
    salesBridge(shop.id, from, to),
    syncFreshness(shop.id),
  ]);
  const today = todayIn(shop.timezone);
  const presets = [7, 30, 90].map((n) => ({ label: `Last ${n} days`, from: addDays(today, -(n - 1)), to: today }));
  const definition = { ...SALES_DEFINITION, includes: SALES_DEFINITION.includes.replace('{tz}', shop.timezone) };
  return { shop, from, to, summary, bridge, freshness, definition, presets, rangeError: null };
}
