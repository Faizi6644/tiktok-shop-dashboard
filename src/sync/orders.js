/**
 * Part 2 + Part 3: pull orders into MySQL and keep them up to date.
 *
 * How it pages ("keyset on update_time"):
 *   The API sorts by update_time ascending and filters with update_time_ge. Instead of walking
 *   page_token offsets from page one, every request asks for "update_time >= cursor", where the
 *   cursor is the highest update_time we have already committed. After each page:
 *     - the orders and the new cursor are written in ONE transaction, so
 *     - a crash (kill -9, lost network, laptop sleep) resumes from the last committed page.
 *   Offsets also shift when an order changes mid-sync (it jumps to the end of the list), which can
 *   silently skip an order. Keyset paging on update_time doesn't have that problem.
 *   Rows that share the cursor's exact timestamp are fetched again. That is harmless because saving is
 *   an upsert on the order id. If a whole page shares one timestamp, we follow next_page_token until
 *   the timestamp moves, so we can never loop forever.
 *
 * Incremental vs full:
 *   - incremental (every 5 min): starts at incr_cursor minus a 10 min lookback. Cancellations and
 *     refunds bump update_time, so a changed order always comes back in the next incremental run.
 *     A normal run is 1 request. We never re-download everything on each run.
 *     The saved incr_cursor never goes past the moment the run started. Why: if any order ever
 *     carries an update_time ahead of our clock (clock skew, or source data stamped in the future;
 *     in this mock, historical update_times run up to a day after the last order), a cursor that
 *     jumped to it would sit *above* a cancellation stamped with the real current time, and that
 *     cancellation would never be fetched. Future-stamped orders are simply re-read each run.
 *   - full (once a day, or "Full resync" on the internal page): walks every order from 0 with its
 *     own resumable cursor (full_cursor). A safety net for anything the API might not surface
 *     through update_time, e.g. a change that does not bump update_time.
 *
 * Duplicates are impossible: orders.id is the TikTok order id (primary key), and every write is
 * INSERT ... ON DUPLICATE KEY UPDATE.
 */
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { localDate } from '../time.js';
import { searchOrders } from '../tiktok/shopApi.js';

const MAX_PAGES_PER_RUN = 10_000; // hard stop against any unforeseen loop

/** Map an API order to our columns. Money stays a string ("34.99") end to end. */
export function toRow(shop, o) {
  const p = o.payment ?? {};
  const r = o.refund ?? {};
  return {
    id: String(o.id),
    shop_id: shop.id,
    status: o.status,
    create_time: Number(o.create_time),
    update_time: Number(o.update_time),
    create_date_local: localDate(Number(o.create_time), shop.timezone),
    buyer_region: o.buyer_region ?? null,
    currency: o.currency ?? 'USD',
    subtotal: p.subtotal ?? '0.00',
    discount: p.discount ?? '0.00',
    shipping_fee: p.shipping_fee ?? '0.00',
    tax: p.tax ?? '0.00',
    total_amount: p.total_amount ?? '0.00',
    refund_amount: r.refund_amount ?? '0.00',
    refund_status: r.refund_status ?? 'NONE',
    raw: JSON.stringify(o),
    line_items: (o.line_items ?? []).map((li, i) => [String(o.id), i + 1, li.product_name, li.sku_id, Number(li.quantity), li.unit_price]),
  };
}

const moneyEq = (a, b) => Number(a).toFixed(2) === Number(b).toFixed(2);

/**
 * Save one page and advance the cursor in the same transaction.
 * Returns { upserted, changed, wentBackwards }.
 */
export async function savePage(shop, apiOrders, { kind, position, safeCursor, runId }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const rows = apiOrders.map((o) => toRow(shop, o));
    let upserted = 0;
    let changed = 0;
    let wentBackwards = 0;

    if (rows.length) {
      const [existing] = await conn.query(
        'SELECT id, update_time, status, refund_amount, refund_status FROM orders WHERE id IN (?) FOR UPDATE',
        [rows.map((r) => r.id)],
      );
      const byId = new Map(existing.map((e) => [e.id, e]));

      const toWrite = [];
      for (const r of rows) {
        const prev = byId.get(r.id);
        // Last fetch wins. We deliberately do NOT drop a copy whose update_time is lower than the
        // stored one: if an order's previous update_time was ahead of the clock, a later change
        // (e.g. a cancellation stamped with the real time) has a *lower* update_time. One worker
        // fetches sequentially, so the latest response is the latest truth. We log it for visibility.
        if (prev && r.update_time < Number(prev.update_time)) {
          wentBackwards++;
          log.warn('order update_time went backwards; keeping the latest fetch', { orderId: r.id, from: Number(prev.update_time), to: r.update_time });
        }
        if (prev && (prev.status !== r.status || prev.refund_status !== r.refund_status || !moneyEq(prev.refund_amount, r.refund_amount))) {
          changed++;
          await conn.query(
            `INSERT INTO order_changes (order_id, old_update_time, new_update_time, old_status, new_status,
               old_refund_amount, new_refund_amount, old_refund_status, new_refund_status) VALUES (?,?,?,?,?,?,?,?,?)`,
            [r.id, prev.update_time, r.update_time, prev.status, r.status, prev.refund_amount, r.refund_amount, prev.refund_status, r.refund_status],
          );
        }
        toWrite.push(r);
      }

      if (toWrite.length) {
        await conn.query(
          `INSERT INTO orders (id, shop_id, status, create_time, update_time, create_date_local, buyer_region, currency,
             subtotal, discount, shipping_fee, tax, total_amount, refund_amount, refund_status, raw)
           VALUES ? AS new
           ON DUPLICATE KEY UPDATE status=new.status, create_time=new.create_time, update_time=new.update_time,
             create_date_local=new.create_date_local, buyer_region=new.buyer_region, currency=new.currency,
             subtotal=new.subtotal, discount=new.discount, shipping_fee=new.shipping_fee, tax=new.tax,
             total_amount=new.total_amount, refund_amount=new.refund_amount, refund_status=new.refund_status,
             raw=new.raw, last_synced_at=UTC_TIMESTAMP(3)`,
          [toWrite.map((r) => [r.id, r.shop_id, r.status, r.create_time, r.update_time, r.create_date_local, r.buyer_region,
            r.currency, r.subtotal, r.discount, r.shipping_fee, r.tax, r.total_amount, r.refund_amount, r.refund_status, r.raw])],
        );
        // Line items: replace the set for each order we wrote (an order's lines can change).
        await conn.query('DELETE FROM order_line_items WHERE order_id IN (?)', [toWrite.map((r) => r.id)]);
        const items = toWrite.flatMap((r) => r.line_items);
        if (items.length) {
          await conn.query('INSERT INTO order_line_items (order_id, line_no, product_name, sku_id, quantity, unit_price) VALUES ?', [items]);
        }
        upserted = toWrite.length;
      }
    }

    // Advance the checkpoint in the same transaction as the data it describes.
    //   position   = where this run has read up to (highest update_time seen): resume point of a full sweep.
    //   safeCursor = min(position, time this run started): the incremental high-water mark. Capped at
    //                "now" so an update_time that is ahead of our clock can never push the mark past
    //                changes that will be stamped with the real current time.
    if (kind === 'full') {
      await conn.query('UPDATE sync_state SET full_cursor = ?, incr_cursor = GREATEST(incr_cursor, ?) WHERE shop_id = ?', [position, safeCursor, shop.id]);
    } else {
      await conn.query('UPDATE sync_state SET incr_cursor = GREATEST(incr_cursor, ?) WHERE shop_id = ?', [safeCursor, shop.id]);
    }
    await conn.query(
      'UPDATE sync_runs SET pages = pages + 1, orders_upserted = orders_upserted + ?, orders_changed = orders_changed + ?, end_cursor = ? WHERE id = ?',
      [upserted, changed, position, runId],
    );
    await conn.commit();
    return { upserted, changed, wentBackwards };
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Run one sync for a shop. kind: 'incremental' | 'full'. triggerSource: 'schedule' | 'manual' | 'resume'.
 * Never throws: failures are recorded on sync_state / sync_runs and the next run resumes from the cursor.
 */
export async function runSync(shop, kind, triggerSource) {
  const [[state]] = await pool.query('SELECT * FROM sync_state WHERE shop_id = ?', [shop.id]);
  const runStartedSec = Math.floor(Date.now() / 1000);
  let cursor =
    kind === 'full'
      ? Number(state.full_cursor ?? 0)
      : Math.max(0, Number(state.incr_cursor) - config.sync.lookbackSec);

  const [ins] = await pool.query(
    'INSERT INTO sync_runs (shop_id, kind, trigger_source, start_cursor) VALUES (?,?,?,?)',
    [shop.id, kind, triggerSource, cursor],
  );
  const runId = ins.insertId;
  await pool.query(
    `UPDATE sync_state SET status='running', current_run_id=?, last_run_started_at=UTC_TIMESTAMP(3)
       ${kind === 'full' ? ', full_cursor = COALESCE(full_cursor, 0)' : ''} WHERE shop_id=?`,
    [runId, shop.id],
  );
  log.info('sync started', { shopId: shop.id, kind, trigger: triggerSource, runId, fromUpdateTime: cursor });

  const stats = { retries: 0 };
  let pageToken;
  let totals = { pages: 0, upserted: 0, changed: 0 };
  try {
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const data = await searchOrders(
        shop,
        { filters: { update_time_ge: cursor }, pageSize: config.sync.pageSize, pageToken },
        stats,
      );
      const orders = data.orders ?? [];
      const maxUpdate = orders.reduce((m, o) => Math.max(m, Number(o.update_time)), cursor);
      const r = await savePage(shop, orders, { kind, position: maxUpdate, safeCursor: Math.min(maxUpdate, runStartedSec), runId });
      totals = { pages: totals.pages + 1, upserted: totals.upserted + r.upserted, changed: totals.changed + r.changed };

      if (!data.next_page_token) break; // nothing after this page
      if (maxUpdate > cursor) {
        cursor = maxUpdate; // keyset: restart the query from the new high-water mark
        pageToken = undefined;
      } else {
        pageToken = data.next_page_token; // whole page shares one timestamp: step through it by offset
      }
    }

    await pool.query('UPDATE sync_runs SET status=?, finished_at=UTC_TIMESTAMP(3), retries=? WHERE id=?', ['success', stats.retries, runId]);
    await pool.query(
      `UPDATE sync_state SET status='idle', current_run_id=NULL, last_success_at=UTC_TIMESTAMP(3)
         ${kind === 'full' ? ', full_cursor=NULL, last_full_success_at=UTC_TIMESTAMP(3)' : ''} WHERE shop_id=?`,
      [shop.id],
    );
    log.info('sync finished', { shopId: shop.id, kind, runId, ...totals, retries: stats.retries });
    return { ok: true, runId, ...totals, retries: stats.retries };
  } catch (e) {
    const message = String(e.message ?? e).slice(0, 2000);
    await pool.query('UPDATE sync_runs SET status=?, finished_at=UTC_TIMESTAMP(3), retries=?, error=? WHERE id=?', ['failed', stats.retries, message, runId]);
    await pool.query(
      `UPDATE sync_state SET status='failed', current_run_id=NULL, last_failure_at=UTC_TIMESTAMP(3), last_failure_message=? WHERE shop_id=?`,
      [message, shop.id],
    );
    log.error('sync failed; will resume from the saved cursor', { shopId: shop.id, kind, runId, error: message, ...totals });
    return { ok: false, runId, error: message, ...totals };
  }
}
