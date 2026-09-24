import { pool } from './db/pool.js';
import { config } from './config.js';
import { log } from './log.js';
import { pathToFileURL } from 'node:url';
import { sleep } from './tiktok/http.js';
import { connectShop, getAccessToken, ReauthRequiredError } from './tiktok/tokens.js';
import { runSync } from './sync/orders.js';
import { runReconciliation } from './sync/reconcile.js';

const LOCK_NAME = 'tiktok_dashboard_worker';

async function acquireSingletonLock() {
  const conn = await pool.getConnection(); // kept for the life of the process; the lock dies with it
  const [[{ got }]] = await conn.query('SELECT GET_LOCK(?, 0) AS got', [LOCK_NAME]);
  if (got !== 1) {
    log.error('another worker is already running; exiting');
    process.exit(1);
  }
  // Keep the connection alive so MySQL never times it out and silently drops the lock.
  setInterval(() => conn.query('SELECT 1').catch((e) => log.error('lock connection lost', { error: e.message })), 60_000).unref();
  return conn;
}

/** A run left as 'running' means the previous process died mid-sync. Record that; the cursor makes it resumable. */
async function recoverInterruptedRuns() {
  const [r] = await pool.query(
    `UPDATE sync_runs SET status='interrupted', finished_at=UTC_TIMESTAMP(3), error='process stopped during the run'
      WHERE status='running'`,
  );
  if (r.affectedRows) {
    await pool.query(
      `UPDATE sync_state SET status='failed', current_run_id=NULL, last_failure_at=UTC_TIMESTAMP(3),
         last_failure_message='Previous run was interrupted (process stopped). Resuming from the saved cursor.'
       WHERE status='running'`,
    );
    log.warn('marked interrupted runs; they will resume from their saved cursor', { runs: r.affectedRows });
  }
}

async function ensureConnected() {
  const [shops] = await pool.query('SELECT id FROM shops');
  if (shops.length || !config.tiktok.authCode) return;
  log.info('no shop connected yet; exchanging TTS_AUTH_CODE for tokens');
  await connectShop(config.tiktok.authCode, config.tiktok.shopCipher);
}

const ago = (d) => (d ? Date.now() - new Date(d).getTime() : Infinity);

/** Decide what (if anything) should run now for this shop. */
export function decideRun(state, shop, cfg = config.sync, now = Date.now()) {
  const since = (d) => (d ? now - new Date(d).getTime() : Infinity);
  if (state.sync_requested_at) return { kind: state.sync_requested_kind ?? 'incremental', trigger: 'manual' };
  if (state.full_cursor !== null && state.full_cursor !== undefined) return { kind: 'full', trigger: 'resume' };
  if (state.last_success_at && since(state.last_full_success_at ?? shop.connected_at) >= cfg.fullSweepEveryMs) {
    return { kind: 'full', trigger: 'schedule' };
  }
  const interval = state.status === 'failed' ? cfg.retryAfterFailureMs : cfg.incrementalEveryMs;
  if (since(state.last_run_started_at) >= interval) return { kind: 'incremental', trigger: 'schedule' };
  return null;
}

async function tickShop(shop) {
  // 1. Token keep-alive. Cheap (one DB read) unless a refresh is due.
  try {
    await getAccessToken(shop.id);
  } catch (e) {
    if (e instanceof ReauthRequiredError) {
      await pool.query(
        `UPDATE sync_state SET status='failed', last_failure_at=UTC_TIMESTAMP(3), last_failure_message=? WHERE shop_id=? AND (last_failure_message IS NULL OR last_failure_message <> ?)`,
        [e.message, shop.id, e.message],
      );
      return; // nothing else can work until a human reconnects the shop
    }
    log.warn('token refresh attempt failed; will retry next tick', { shopId: shop.id, error: e.message });
    return;
  }

  // 2. Sync if due.
  const [[state]] = await pool.query('SELECT * FROM sync_state WHERE shop_id = ?', [shop.id]);
  const decision = decideRun(state, shop);
  if (!decision) return;
  if (decision.trigger === 'manual') {
    await pool.query('UPDATE sync_state SET sync_requested_at=NULL, sync_requested_kind=NULL WHERE shop_id=?', [shop.id]);
  }
  const result = await runSync(shop, decision.kind, decision.trigger);

  // 3. Reconciliation right after a good sync, so both sides describe the same moment.
  if (result.ok) {
    const [[last]] = await pool.query('SELECT MAX(checked_at) AS at FROM reconciliation_checks WHERE shop_id = ?', [shop.id]);
    if (ago(last.at) >= config.sync.reconcileEveryMs) {
      await runReconciliation(shop).catch((e) => log.error('reconciliation errored', { shopId: shop.id, error: e.message }));
    }
  }
}

async function main() {
  await acquireSingletonLock();
  await recoverInterruptedRuns();
  await ensureConnected();
  log.info('worker started', {
    incrementalEverySec: config.sync.incrementalEveryMs / 1000,
    fullSweepEverySec: config.sync.fullSweepEveryMs / 1000,
    reconcileEverySec: config.sync.reconcileEveryMs / 1000,
  });

  for (;;) {
    try {
      const [shops] = await pool.query('SELECT * FROM shops');
      for (const shop of shops) await tickShop(shop);
    } catch (e) {
      // Never let one bad tick (DB blip, bug) kill the loop that keeps the shop connected.
      log.error('worker tick failed', { error: e.message, stack: e.stack });
    }
    await sleep(config.sync.tickMs);
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    // Safe to stop at any moment: each page and its cursor commit together.
    log.info(`received ${sig}, stopping`);
    process.exit(0);
  });
}

// Run only when started directly (not when imported by tests). pathToFileURL makes this work on Windows too.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    log.error('worker crashed', { error: e.message, stack: e.stack });
    process.exit(1);
  });
}
