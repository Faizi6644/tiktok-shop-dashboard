/**
 * Part 1: connect the shop and keep it connected, with nobody touching it.
 *
 * - Tokens live in MySQL (shop_tokens), encrypted with AES-256-GCM. Not in a file, not in logs.
 * - Proactive refresh: the worker calls getAccessToken() on every tick (15s). When fewer than
 *   TOKEN_REFRESH_MARGIN_SEC (5 min) remain, it refreshes. So the token is renewed around minute
 *   10 of its 15, whether or not a sync is running.
 * - Reactive refresh: if a call still gets a 401, shopApi.js forces one refresh and retries once.
 * - Refresh runs under SELECT ... FOR UPDATE. This is the important part: every refresh
 *   invalidates the previous refresh token. If two refreshes ran at once, one would send a
 *   refresh token that no longer exists, and the shop would need a human to re-authorise it.
 *   The row lock makes the second caller wait, then reuse the token the first one got.
 * - Every refresh also returns a new 7-day refresh token, and we refresh every ~10 minutes,
 *   so the refresh token never gets close to expiring.
 */
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { alert } from '../alerts.js';
import { encrypt, decrypt } from './secretBox.js';
import { ApiError, requestWithRetry } from './http.js';

export class ReauthRequiredError extends Error {
  constructor(shopId, reason) {
    super(`shop ${shopId} must be re-authorised: ${reason}`);
    this.name = 'ReauthRequiredError';
  }
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** Exchange the one-time authorization code for tokens, look up the shop, store both. */
export async function connectShop(authCode, shopCipher) {
  const { appKey, appSecret } = config.tiktok;
  const tok = await requestWithRetry({
    method: 'POST',
    path: '/api/v2/token/get',
    body: { app_key: appKey, app_secret: appSecret, auth_code: authCode, grant_type: 'authorized_code' },
  });

  const { shops } = await requestWithRetry({
    method: 'GET',
    path: '/api/v2/authorization/shops',
    query: { shop_cipher: shopCipher },
    headers: { 'x-tts-access-token': tok.access_token },
    rateLimited: true,
  });
  const shop = shops.find((s) => s.cipher === shopCipher) ?? shops[0];
  if (!shop) throw new Error('authorization returned no shops');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO shops (id, cipher, name, region, timezone, seller_name, open_id) VALUES (?,?,?,?,?,?,?) AS new
       ON DUPLICATE KEY UPDATE cipher=new.cipher, name=new.name, region=new.region, timezone=new.timezone,
         seller_name=new.seller_name, open_id=new.open_id`,
      [shop.id, shop.cipher, shop.name, shop.region, shop.timezone, tok.seller_name, tok.open_id],
    );
    await conn.query(
      `INSERT INTO shop_tokens (shop_id, access_token_enc, access_expires_at, refresh_token_enc, refresh_expires_at, status, last_refreshed_at)
       VALUES (?,?,?,?,?,'active',UTC_TIMESTAMP(3)) AS new
       ON DUPLICATE KEY UPDATE access_token_enc=new.access_token_enc, access_expires_at=new.access_expires_at,
         refresh_token_enc=new.refresh_token_enc, refresh_expires_at=new.refresh_expires_at, status='active',
         last_refresh_error=NULL, last_refreshed_at=UTC_TIMESTAMP(3), updated_at=UTC_TIMESTAMP(3)`,
      [shop.id, encrypt(tok.access_token), tok.access_token_expire_in, encrypt(tok.refresh_token), tok.refresh_token_expire_in],
    );
    await conn.query('INSERT IGNORE INTO sync_state (shop_id) VALUES (?)', [shop.id]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  log.info('shop connected', { shopId: shop.id, name: shop.name });
  return shop;
}

/** A usable access token for the shop, refreshed first if it is about to expire. */
export async function getAccessToken(shopId) {
  const [rows] = await pool.query(
    'SELECT access_token_enc, access_expires_at, status FROM shop_tokens WHERE shop_id = ?',
    [shopId],
  );
  const row = rows[0];
  if (!row) throw new ReauthRequiredError(shopId, 'no tokens stored (run npm run connect)');
  if (row.status === 'reauth_required') throw new ReauthRequiredError(shopId, 'the refresh token was rejected');
  if (Number(row.access_expires_at) - nowSec() > config.sync.refreshMarginSec) return decrypt(row.access_token_enc);
  return refreshAccessToken(shopId);
}

/**
 * Refresh under a row lock.
 * `staleToken`: the token that just got a 401. We refresh even if its stored expiry looks fine,
 * unless another caller already replaced it (then we simply return the newer one).
 */
export async function refreshAccessToken(shopId, staleToken) {
  const conn = await pool.getConnection();
  let reauthReason = null;
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT access_token_enc, access_expires_at, refresh_token_enc, status
         FROM shop_tokens WHERE shop_id = ? FOR UPDATE`,
      [shopId],
    );
    const row = rows[0];
    if (!row) throw new ReauthRequiredError(shopId, 'no tokens stored');
    if (row.status === 'reauth_required') throw new ReauthRequiredError(shopId, 'the refresh token was rejected');

    const current = decrypt(row.access_token_enc);
    const stillFresh = Number(row.access_expires_at) - nowSec() > config.sync.refreshMarginSec;
    const replacedElsewhere = staleToken !== undefined && current !== staleToken;
    if (replacedElsewhere || (staleToken === undefined && stillFresh)) {
      await conn.commit();
      return current;
    }

    let tok;
    try {
      tok = await requestWithRetry({
        method: 'POST',
        path: '/api/v2/token/refresh',
        body: {
          app_key: config.tiktok.appKey,
          app_secret: config.tiktok.appSecret,
          refresh_token: decrypt(row.refresh_token_enc),
          grant_type: 'refresh_token',
        },
      });
    } catch (e) {
      if (e instanceof ApiError && e.httpStatus === 401) {
        // Refresh token rejected or expired. Only a human can fix this: stop retrying, surface it.
        reauthReason = e.message;
        await conn.query(
          `UPDATE shop_tokens SET status='reauth_required', last_refresh_error=?, updated_at=UTC_TIMESTAMP(3) WHERE shop_id=?`,
          [e.message, shopId],
        );
      } else {
        await conn.query(`UPDATE shop_tokens SET last_refresh_error=?, updated_at=UTC_TIMESTAMP(3) WHERE shop_id=?`, [e.message, shopId]);
      }
      await conn.commit();
      throw reauthReason ? new ReauthRequiredError(shopId, reauthReason) : e;
    }

    // The new refresh token replaces the old one in the same statement as the new access token.
    await conn.query(
      `UPDATE shop_tokens SET access_token_enc=?, access_expires_at=?, refresh_token_enc=?, refresh_expires_at=?,
         last_refreshed_at=UTC_TIMESTAMP(3), last_refresh_error=NULL, updated_at=UTC_TIMESTAMP(3) WHERE shop_id=?`,
      [encrypt(tok.access_token), tok.access_token_expire_in, encrypt(tok.refresh_token), tok.refresh_token_expire_in, shopId],
    );
    await conn.commit();
    log.info('access token refreshed', { shopId, expiresAt: new Date(tok.access_token_expire_in * 1000).toISOString() });
    return tok.access_token;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
    if (reauthReason) await alert(`Shop ${shopId} needs to be re-authorised`, { reason: reauthReason });
  }
}
