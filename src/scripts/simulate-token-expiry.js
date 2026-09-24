/**
 * Test helper: make the stored access token unusable, as if it had expired early or been
 * revoked, WITHOUT touching the refresh token. The stored expiry stays in the future, so the
 * proactive refresh won't kick in. The next API call gets a 401, and you can watch the worker
 * refresh the token and carry on in the same run.
 *
 * Usage: npm run simulate:token-expiry   (then click "Sync now" on the internal page)
 */
import { pool } from '../db/pool.js';
import { encrypt } from '../tiktok/secretBox.js';

const [r] = await pool.query(
  `UPDATE shop_tokens SET access_token_enc = ?, access_expires_at = UNIX_TIMESTAMP() + 3600`,
  [encrypt('ROW_at_simulated_expired_token')],
);
console.log(r.affectedRows
  ? 'Stored access token replaced with one the API will reject. Click "Sync now" and watch the worker log for the 401 and the refresh.'
  : 'No shop connected yet.');
await pool.end();
