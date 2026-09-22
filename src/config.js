import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// One .env at the repository root, shared by the worker and the web server.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env'), quiet: true });

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return v;
}
const num = (name, def) => (process.env[name] ? Number(process.env[name]) : def);

/**
 * All configuration comes from the environment. Secrets are read lazily (getters),
 * so the web process, which never talks to TikTok, never needs TTS_APP_SECRET or
 * TOKEN_ENCRYPTION_KEY in its environment at all.
 */
export const config = {
  rootDir: root,
  databaseUrl: required('DATABASE_URL'),

  tiktok: {
    baseUrl: process.env.TTS_BASE_URL ?? 'http://localhost:4000',
    appKey: process.env.TTS_APP_KEY ?? '',
    get appSecret() { return required('TTS_APP_SECRET'); },
    authCode: process.env.TTS_AUTH_CODE ?? '',
    shopId: process.env.TTS_SHOP_ID ?? '',
    shopCipher: process.env.TTS_SHOP_CIPHER ?? '',
  },

  /** 32 bytes (base64 or hex) used to encrypt tokens at rest with AES-256-GCM. */
  get tokenEncryptionKey() { return required('TOKEN_ENCRYPTION_KEY'); },

  sync: {
    /** Incremental sync interval. README "Part 3" explains why 5 minutes. */
    incrementalEveryMs: num('SYNC_INCREMENTAL_EVERY_SEC', 300) * 1000,
    /** Safety-net sweep over every order, once a day. */
    fullSweepEveryMs: num('SYNC_FULL_EVERY_SEC', 86400) * 1000,
    /** After a failed run, retry sooner than the normal interval. */
    retryAfterFailureMs: num('SYNC_RETRY_AFTER_FAILURE_SEC', 60) * 1000,
    /** Seller Center reconciliation interval. */
    reconcileEveryMs: num('RECONCILE_EVERY_SEC', 3600) * 1000,
    /** Each incremental run re-reads this many seconds before the saved cursor (late updates). */
    lookbackSec: num('SYNC_LOOKBACK_SEC', 600),
    pageSize: 50, // API maximum
    /** Our own request budget. The API allows 40/min per token; we stay well under. */
    maxRequestsPerMinute: num('TTS_MAX_RPM', 30),
    /** Refresh the access token when fewer than this many seconds remain. */
    refreshMarginSec: num('TOKEN_REFRESH_MARGIN_SEC', 300),
    /** How often the worker wakes up to check what is due. */
    tickMs: num('WORKER_TICK_SEC', 15) * 1000,
  },

  web: {
    port: num('PORT', 3000),
    sessionTtlHours: num('SESSION_TTL_HOURS', 12),
    cookieSecure: process.env.COOKIE_SECURE === 'true',
  },

  users: {
    clientUsername: process.env.CLIENT_USERNAME ?? 'client',
    clientPassword: process.env.CLIENT_PASSWORD ?? '',
    adminUsername: process.env.ADMIN_USERNAME ?? 'admin',
    adminPassword: process.env.ADMIN_PASSWORD ?? '',
  },

  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL ?? '',
};
