import { pool } from '../db/pool.js';

/** Everything the internal page shows: per shop, connection + sync health + last reconciliation. */
export async function internalData() {
  const [shops] = await pool.query(
    `SELECT s.id, s.name, s.region, s.timezone, s.connected_at,
            t.status AS token_status, t.access_expires_at, t.refresh_expires_at, t.last_refreshed_at, t.last_refresh_error,
            st.status AS sync_status, st.incr_cursor, st.full_cursor, st.last_run_started_at, st.last_success_at,
            st.last_full_success_at, st.last_failure_at, st.last_failure_message, st.sync_requested_at, st.sync_requested_kind,
            (SELECT COUNT(*) FROM orders o WHERE o.shop_id = s.id) AS orders_stored,
            (SELECT COUNT(*) FROM order_changes c JOIN orders o ON o.id = c.order_id WHERE o.shop_id = s.id) AS changes_seen
       FROM shops s
       LEFT JOIN shop_tokens t ON t.shop_id = s.id
       LEFT JOIN sync_state st ON st.shop_id = s.id
      ORDER BY s.connected_at`,
  );
  for (const shop of shops) {
    const [runs] = await pool.query(
      `SELECT id, kind, trigger_source, status, started_at, finished_at, pages, orders_upserted, orders_changed, retries, error
         FROM sync_runs WHERE shop_id = ? ORDER BY id DESC LIMIT 10`,
      [shop.id],
    );
    const [[recon]] = await pool.query(
      'SELECT * FROM reconciliation_checks WHERE shop_id = ? ORDER BY id DESC LIMIT 1',
      [shop.id],
    );
    shop.runs = runs;
    shop.reconciliation = recon ?? null;
    shop.orders_stored = Number(shop.orders_stored);
    shop.changes_seen = Number(shop.changes_seen);
  }
  return { shops };
}

/** "Sync now": set a flag; the worker (the only process allowed to call TikTok) picks it up. */
export async function requestSync(shopId, kind) {
  const [r] = await pool.query(
    'UPDATE sync_state SET sync_requested_at = UTC_TIMESTAMP(3), sync_requested_kind = ? WHERE shop_id = ?',
    [kind, shopId],
  );
  return r.affectedRows > 0;
}
