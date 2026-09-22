/**
 * Part 5, the "catch it automatically" part.
 *
 * Every hour (right after a successful incremental sync) we:
 *   1. ask Seller Center for its 30-day GMV and order count, and the exact period it used;
 *   2. recompute the same number from OUR database using Seller Center's definition
 *      (LA calendar days, not cancelled, subtotal - discount + shipping, tax excluded, refunds not deducted);
 *   3. compare orders/search total_count (no filters) with the number of orders we hold.
 *
 * If our data is complete, 2 matches 1 to the cent and 3 matches exactly. A mismatch means one of:
 *   - we are missing or holding stale orders (a sync bug or a missed update), or
 *   - Seller Center changed its definition.
 * Either way a human needs to look before the client notices. The result is stored in
 * reconciliation_checks and shown on the internal page. Two failures in a row send an alert
 * (a single failure can be an update that landed between the sync and the check).
 *
 * We also store the Net sales the client page shows for the same dates, so the expected, explained
 * gap between "Seller Center GMV" and "our Net sales" is tracked over time too.
 */
import { pool } from '../db/pool.js';
import { log } from '../log.js';
import { alert } from '../alerts.js';
import { getSellerCenterSummary, searchOrders } from '../tiktok/shopApi.js';
import { salesBridge } from '../metrics.js';

export async function runReconciliation(shop) {
  const sc = await getSellerCenterSummary(shop);
  const { start_date: from, end_date: to } = sc.period;

  const bridge = await salesBridge(shop.id, from, to);
  const remote = await searchOrders(shop, { filters: {}, pageSize: 1 });
  const [[{ n: localTotal }]] = await pool.query('SELECT COUNT(*) AS n FROM orders WHERE shop_id = ?', [shop.id]);

  const problems = [];
  if (Number(sc.gmv).toFixed(2) !== Number(bridge.gmv).toFixed(2)) {
    problems.push(`GMV differs: Seller Center ${sc.gmv}, ours (same definition) ${bridge.gmv}`);
  }
  if (Number(sc.orders) !== bridge.gmv_orders) {
    problems.push(`Order count differs: Seller Center ${sc.orders}, ours ${bridge.gmv_orders}`);
  }
  if (Number(remote.total_count) !== Number(localTotal)) {
    problems.push(`Total orders differ: API ${remote.total_count}, database ${localTotal}`);
  }
  if (sc.timezone && sc.timezone !== shop.timezone) {
    problems.push(`Seller Center timezone ${sc.timezone} differs from shop timezone ${shop.timezone}`);
  }
  const ok = problems.length === 0;

  await pool.query(
    `INSERT INTO reconciliation_checks (shop_id, period_start, period_end, seller_center_gmv, seller_center_orders,
       local_gmv, local_orders, dashboard_net_sales, dashboard_orders, remote_total_count, local_total_count, ok, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [shop.id, from, to, sc.gmv, sc.orders, bridge.gmv, bridge.gmv_orders, bridge.net_sales, bridge.net_orders,
      remote.total_count, localTotal, ok, problems.join('\n') || null],
  );
  log.info('reconciliation', { shopId: shop.id, ok, sellerCenterGmv: sc.gmv, localGmv: bridge.gmv, netSales: bridge.net_sales, problems });

  if (!ok) {
    const [prev] = await pool.query(
      'SELECT ok FROM reconciliation_checks WHERE shop_id = ? ORDER BY id DESC LIMIT 1 OFFSET 1',
      [shop.id],
    );
    if (prev[0] && !prev[0].ok) {
      await alert(`Reconciliation failed twice in a row for shop ${shop.id}`, { problems });
    }
  }
  return { ok, problems, sellerCenter: sc, bridge, remoteTotal: remote.total_count, localTotal: Number(localTotal) };
}
