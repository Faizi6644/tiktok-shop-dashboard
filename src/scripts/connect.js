/**
 * Connect the shop: exchange the authorization code for tokens and store them (encrypted).
 * Usage: npm run connect            (uses TTS_AUTH_CODE / TTS_SHOP_CIPHER from .env)
 *        npm run connect -- <code>  (a new code, e.g. after the shop owner re-authorises)
 * The worker also does this automatically on first start if no shop is connected.
 */
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { connectShop } from '../tiktok/tokens.js';

const code = process.argv[2] || config.tiktok.authCode;
if (!code) {
  console.error('No authorization code. Set TTS_AUTH_CODE or pass one: npm run connect -- <code>');
  process.exit(1);
}
try {
  const shop = await connectShop(code, config.tiktok.shopCipher);
  console.log(`Connected ${shop.name} (${shop.id}, ${shop.region}, ${shop.timezone}). The worker will keep it connected.`);
} catch (e) {
  console.error(`Connect failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
