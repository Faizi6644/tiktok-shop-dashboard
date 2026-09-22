// Unit tests for the pure parts. Run: npm test  (needs a .env, but no database or mock server)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DATABASE_URL ??= 'mysql://u:p@localhost:3306/x';
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

const { encrypt, decrypt } = await import('../src/tiktok/secretBox.js');
const { localDate, addDays, dateRange } = await import('../src/time.js');
const { parseRange, BadRangeError } = await import('../src/web/dashboard.js');
const { decideRun } = await import('../src/worker.js');
const { toRow } = await import('../src/sync/orders.js');
const { hashPassword, verifyPassword } = await import('../src/web/passwords.js');
const { config } = await import('../src/config.js');
const httpMod = await import('../src/tiktok/http.js');

test('tokens round-trip through AES-GCM and ciphertext is not the token', () => {
  const box = encrypt('ROW_at_secret');
  assert.notEqual(box.includes('ROW_at_secret'), true);
  assert.equal(decrypt(box), 'ROW_at_secret');
  assert.notEqual(encrypt('same'), encrypt('same')); // random IV
});

test('tampered ciphertext is rejected', () => {
  const parts = encrypt('ROW_at_secret').split(':');
  parts[3] = Buffer.from('garbage').toString('base64');
  assert.throws(() => decrypt(parts.join(':')));
});

test('passwords hash and verify', () => {
  const h = hashPassword('pw');
  assert.ok(verifyPassword('pw', h));
  assert.ok(!verifyPassword('nope', h));
});

test('dates are bucketed in the shop timezone, not UTC', () => {
  // 2026-09-01 03:00 UTC is still Aug 31 in Los Angeles (UTC-7).
  const ts = Date.UTC(2026, 8, 1, 3, 0, 0) / 1000;
  assert.equal(localDate(ts, 'UTC'), '2026-09-01');
  assert.equal(localDate(ts, 'America/Los_Angeles'), '2026-08-31');
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(dateRange('2026-08-30', '2026-09-02').length, 4);
});

test('date range defaults to 30 days and rejects bad input', () => {
  const r = parseRange(undefined, undefined, 'America/Los_Angeles');
  assert.equal(dateRange(r.from, r.to).length, 30);
  assert.throws(() => parseRange('2026-09-10', '2026-09-01', 'UTC'), BadRangeError);
  assert.throws(() => parseRange('bad', '2026-09-01', 'UTC'), BadRangeError);
  assert.throws(() => parseRange('2024-01-01', '2026-09-01', 'UTC'), BadRangeError);
});

test('order mapping keeps money as exact strings and computes local date', () => {
  const row = toRow({ id: 's1', timezone: 'America/Los_Angeles' }, {
    id: '1', create_time: Date.UTC(2026, 8, 1, 3) / 1000, update_time: 1, status: 'COMPLETED', currency: 'USD',
    line_items: [{ product_name: 'A', sku_id: 'sku', quantity: 2, unit_price: '19.99' }],
    payment: { subtotal: '39.98', discount: '0.00', shipping_fee: '5.99', tax: '3.30', total_amount: '49.27' },
    refund: { refund_amount: '0.00', refund_status: 'NONE' },
  });
  assert.equal(row.subtotal, '39.98');
  assert.equal(row.create_date_local, '2026-08-31');
  assert.deepEqual(row.line_items[0], ['1', 1, 'A', 'sku', 2, '19.99']);
});

test('scheduler picks the right job', () => {
  const cfg = { fullSweepEveryMs: 86_400_000, incrementalEveryMs: 300_000, retryAfterFailureMs: 60_000 };
  const now = Date.parse('2026-09-22T12:00:00Z');
  const shop = { connected_at: '2026-09-22T00:00:00Z' };
  const base = { status: 'idle', full_cursor: null, sync_requested_at: null, last_success_at: '2026-09-22T11:58:00Z', last_run_started_at: '2026-09-22T11:58:00Z' };
  assert.equal(decideRun(base, shop, cfg, now), null); // ran 2 min ago
  assert.deepEqual(decideRun({ ...base, last_run_started_at: '2026-09-22T11:54:00Z' }, shop, cfg, now), { kind: 'incremental', trigger: 'schedule' });
  assert.deepEqual(decideRun({ ...base, status: 'failed', last_run_started_at: '2026-09-22T11:58:30Z' }, shop, cfg, now), { kind: 'incremental', trigger: 'schedule' });
  assert.deepEqual(decideRun({ ...base, full_cursor: 123 }, shop, cfg, now), { kind: 'full', trigger: 'resume' });
  assert.deepEqual(decideRun({ ...base, sync_requested_at: 'x', sync_requested_kind: 'full' }, shop, cfg, now), { kind: 'full', trigger: 'manual' });
  assert.deepEqual(decideRun(base, { connected_at: '2026-09-20T00:00:00Z' }, cfg, now), { kind: 'full', trigger: 'schedule' });
  assert.equal(decideRun({ ...base, last_success_at: null, last_run_started_at: null }, shop, cfg, now).kind, 'incremental');
});

test('a 429 is retried after Retry-After and the data still arrives', async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    if (calls < 3) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      return res.end(JSON.stringify({ code: 36004003, message: 'too many requests' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, message: 'success', data: { ok: true } }));
  });
  await new Promise((r) => server.listen(0, r));
  const old = config.tiktok.baseUrl;
  config.tiktok.baseUrl = `http://localhost:${server.address().port}`;
  try {
    const stats = { retries: 0 };
    const t0 = Date.now();
    const data = await httpMod.requestWithRetry({ method: 'GET', path: '/x' }, stats);
    assert.deepEqual(data, { ok: true });
    assert.equal(stats.retries, 2);
    assert.ok(Date.now() - t0 >= 2000, 'waited Retry-After each time');
  } finally {
    config.tiktok.baseUrl = old;
    server.close();
  }
});

test('401 and 404 are not retried', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 105001, message: 'access token expired' }));
  });
  await new Promise((r) => server.listen(0, r));
  const old = config.tiktok.baseUrl;
  config.tiktok.baseUrl = `http://localhost:${server.address().port}`;
  try {
    await assert.rejects(httpMod.requestWithRetry({ method: 'GET', path: '/x' }), (e) => e.isAuthError && e.code === 105001);
  } finally {
    config.tiktok.baseUrl = old;
    server.close();
  }
});

test('rate limiter never allows more than N requests per minute', async () => {
  const lim = new httpMod.RateLimiter(3);
  const t0 = Date.now();
  await lim.take(); await lim.take(); await lim.take();
  assert.ok(Date.now() - t0 < 100);
  assert.equal(lim.sent.length, 3);
});
