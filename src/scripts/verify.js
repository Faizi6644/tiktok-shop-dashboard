/**
 * Independent check: downloads every order from the API right now and compares it field by field
 * with the database. Prints any difference. Run while the worker is idle: npm run verify
 * (Uses ~15 API requests; the shared limiter keeps it under the rate limit.)
 */
import { pool } from '../db/pool.js';
import { searchOrders } from '../tiktok/shopApi.js';
import { toRow } from '../sync/orders.js';

const [[shop]] = await pool.query('SELECT * FROM shops LIMIT 1');
if (!shop) {
  console.error('No shop connected.');
  process.exit(1);
}

const remote = new Map();
let pageToken;
let total;
do {
  const data = await searchOrders(shop, { filters: {}, pageSize: 50, pageToken });
  total = data.total_count;
  for (const o of data.orders) remote.set(String(o.id), toRow(shop, o));
  pageToken = data.next_page_token;
} while (pageToken);

const [rows] = await pool.query('SELECT * FROM orders WHERE shop_id = ?', [shop.id]);
const local = new Map(rows.map((r) => [r.id, r]));
const fields = ['status', 'update_time', 'subtotal', 'discount', 'shipping_fee', 'tax', 'total_amount', 'refund_amount', 'refund_status'];
const diffs = [];
for (const [id, r] of remote) {
  const l = local.get(id);
  if (!l) { diffs.push(`${id}: missing in database`); continue; }
  for (const f of fields) {
    const a = String(r[f]);
    const b = String(l[f]);
    const same = ['status', 'refund_status'].includes(f) ? a === b : Number(a) === Number(b);
    if (!same) diffs.push(`${id}: ${f} api=${a} db=${b}`);
  }
}
for (const id of local.keys()) if (!remote.has(id)) diffs.push(`${id}: in database but not in API`);

const [[{ dupes }]] = await pool.query('SELECT COUNT(*) - COUNT(DISTINCT id) AS dupes FROM orders');
console.log(`API total_count: ${total}, downloaded: ${remote.size}, database rows: ${rows.length}, duplicate ids: ${dupes}`);
console.log(`cancelled: api=${[...remote.values()].filter((o) => o.status === 'CANCELLED').length} db=${rows.filter((o) => o.status === 'CANCELLED').length}; ` +
  `refunded: api=${[...remote.values()].filter((o) => o.refund_status !== 'NONE').length} db=${rows.filter((o) => o.refund_status !== 'NONE').length}`);
console.log(diffs.length ? `${diffs.length} differences:\n${diffs.slice(0, 50).join('\n')}` : 'Database matches the API exactly.');
await pool.end();
process.exit(diffs.length ? 2 : 0);
