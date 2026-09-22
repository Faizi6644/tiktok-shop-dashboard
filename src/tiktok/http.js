/**
 * Low-level HTTP to the TikTok Shop API: the { code, message, data } envelope,
 * a client-side rate limiter, and retries.
 * A 429 is never treated as data or as a failure of the sync: we wait and ask again.
 */
import { config } from '../config.js';
import { log } from '../log.js';

export class ApiError extends Error {
  constructor(httpStatus, code, message, retryAfterSec) {
    super(`TikTok API ${httpStatus} code=${code}: ${message}`);
    this.httpStatus = httpStatus;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
  get isRateLimited() { return this.httpStatus === 429; }
  /** 105001 = expired, 105002 = missing/invalid (e.g. replaced by a refresh elsewhere). */
  get isAuthError() { return this.httpStatus === 401 && (this.code === 105001 || this.code === 105002); }
  /** 0 = network error / timeout. */
  get isRetryable() { return this.httpStatus === 429 || this.httpStatus >= 500 || this.httpStatus === 0; }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sliding window: at most N requests in any 60 seconds. The API allows 40/min per token; our
 * default budget of 30 leaves headroom for the retries that the random 429s cause.
 * Kept in memory because exactly one worker process runs (enforced by a MySQL lock in worker.js).
 */
export class RateLimiter {
  constructor(perMinute) {
    this.perMinute = perMinute;
    this.sent = [];
  }
  async take() {
    for (;;) {
      const now = Date.now();
      this.sent = this.sent.filter((t) => now - t < 60_000);
      if (this.sent.length < this.perMinute) {
        this.sent.push(now);
        return;
      }
      await sleep(60_000 - (now - this.sent[0]) + 50);
    }
  }
}
export const limiter = new RateLimiter(config.sync.maxRequestsPerMinute);

/**
 * One HTTP attempt. Throws ApiError on anything but { code: 0 }.
 * opts: { method, path, query, body, headers, rateLimited }
 */
export async function requestOnce(opts) {
  const url = new URL(opts.path, config.tiktok.baseUrl);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  if (opts.rateLimited) await limiter.take();

  let res;
  try {
    res = await fetch(url, {
      method: opts.method,
      headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new ApiError(0, -1, `network error: ${e.message}`);
  }
  let json = {};
  try {
    json = await res.json();
  } catch {
    /* non-JSON body, handled below */
  }
  if (!res.ok || json.code !== 0) {
    const ra = Number(res.headers.get('retry-after'));
    throw new ApiError(res.status, json.code ?? -1, json.message ?? res.statusText, ra > 0 ? ra : undefined);
  }
  return json.data;
}

/**
 * Retries 429 (waiting exactly Retry-After), 5xx and network errors with exponential backoff.
 * Anything else (400/401/404) goes straight back to the caller.
 * `stats.retries` is incremented so each sync run records how many retries it needed.
 */
export async function requestWithRetry(opts, stats, maxAttempts = 10) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await requestOnce(opts);
    } catch (e) {
      if (!(e instanceof ApiError) || !e.isRetryable || attempt >= maxAttempts) throw e;
      const base = e.retryAfterSec ? e.retryAfterSec * 1000 : Math.min(30_000, 1000 * 2 ** (attempt - 1));
      const wait = base + Math.floor(Math.random() * 250); // jitter
      if (stats) stats.retries = (stats.retries ?? 0) + 1;
      log.warn('retrying request', { path: opts.path, status: e.httpStatus, code: e.code, attempt, waitMs: wait });
      await sleep(wait);
    }
  }
}
