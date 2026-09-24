
import { pool } from './db/pool.js';
import { dateRange } from './time.js';

export const SALES_DEFINITION = {
  title: 'Net sales',
  formula: 'Item subtotal − seller discounts + shipping fees − refunds',
  includes: 'Paid orders placed in the selected dates (shop time, {tz}).',
  excludes: 'Cancelled orders, unpaid orders and sales tax.',
  refunds: 'A refund is deducted from the day the order was placed, so past days can go down when a refund comes in.',
};

const COUNTED = "status NOT IN ('CANCELLED','UNPAID')";
const NET = 'subtotal - discount + shipping_fee - refund_amount';
const GMV = 'subtotal - discount + shipping_fee';

/** Net sales + order count for a range, and one row per day (zero-filled). */
export async function salesSummary(shopId, from, to) {
  const [[tot]] = await pool.query(
    `SELECT COALESCE(SUM(${NET}), 0) AS net_sales, COUNT(*) AS orders
       FROM orders WHERE shop_id = ? AND create_date_local BETWEEN ? AND ? AND ${COUNTED}`,
    [shopId, from, to],
  );
  const [days] = await pool.query(
    `SELECT DATE_FORMAT(create_date_local, '%Y-%m-%d') AS day, SUM(${NET}) AS net_sales, COUNT(*) AS orders
       FROM orders WHERE shop_id = ? AND create_date_local BETWEEN ? AND ? AND ${COUNTED}
      GROUP BY create_date_local ORDER BY create_date_local`,
    [shopId, from, to],
  );
  const byDay = new Map(days.map((d) => [d.day, d]));
  const daily = dateRange(from, to).map((day) => ({
    day,
    net_sales: byDay.get(day)?.net_sales ?? '0.00',
    orders: Number(byDay.get(day)?.orders ?? 0),
  }));
  return { net_sales: String(tot.net_sales), orders: Number(tot.orders), daily };
}

/**
 * Walks from Seller Center's GMV definition to our Net sales for the same dates:
 *   GMV (non-cancelled, incl. unpaid, before refunds, excl. tax)
 *   - unpaid orders
 *   - refunds on counted orders
 *   = Net sales
 */
export async function salesBridge(shopId, from, to) {
  const [[b]] = await pool.query(
    `SELECT
        COALESCE(SUM(CASE WHEN status <> 'CANCELLED' THEN ${GMV} END), 0)                   AS gmv,
        COUNT(CASE WHEN status <> 'CANCELLED' THEN 1 END)                                   AS gmv_orders,
        COALESCE(SUM(CASE WHEN status = 'UNPAID' THEN ${GMV} END), 0)                       AS unpaid,
        COUNT(CASE WHEN status = 'UNPAID' THEN 1 END)                                       AS unpaid_orders,
        COALESCE(SUM(CASE WHEN ${COUNTED} THEN refund_amount END), 0)                       AS refunds,
        COUNT(CASE WHEN ${COUNTED} AND refund_amount > 0 THEN 1 END)                        AS refunded_orders,
        COALESCE(SUM(CASE WHEN ${COUNTED} THEN ${NET} END), 0)                              AS net_sales,
        COUNT(CASE WHEN ${COUNTED} THEN 1 END)                                              AS net_orders,
        COALESCE(SUM(CASE WHEN status = 'CANCELLED' THEN ${GMV} END), 0)                    AS cancelled,
        COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END)                                    AS cancelled_orders,
        COALESCE(SUM(CASE WHEN ${COUNTED} THEN tax END), 0)                                 AS tax_on_counted
       FROM orders WHERE shop_id = ? AND create_date_local BETWEEN ? AND ?`,
    [shopId, from, to],
  );
  const out = {};
  for (const [k, v] of Object.entries(b)) out[k] = k.endsWith('orders') ? Number(v) : String(v);
  return out;
}

/** When the last successful sync finished, and whether the shop connection is healthy. */
export async function syncFreshness(shopId) {
  const [[row]] = await pool.query(
    `SELECT s.last_success_at, s.status, t.status AS token_status
       FROM sync_state s LEFT JOIN shop_tokens t ON t.shop_id = s.shop_id WHERE s.shop_id = ?`,
    [shopId],
  );
  return row ?? null;
}
