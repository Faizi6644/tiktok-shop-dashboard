# TikTok Shop Reporting Dashboard

A thin, end-to-end slice of a TikTok Shop reporting dashboard. A background worker connects one shop, keeps its OAuth tokens alive, and syncs every order into MySQL. A small Express + EJS web app shows the numbers to a client user and the sync health to an admin user.

- [Run it](#run-it)
- [Stack and why](#stack-and-why)
- [How it fits together](#how-it-fits-together)
- [Schema](#schema)
- [Keeping the shop connected (Part 1)](#keeping-the-shop-connected-part-1)
- [How the sync works (Part 2)](#how-the-sync-works-part-2)
- [Orders that change later (Part 3)](#orders-that-change-later-part-3)
- [Pages, roles and security (Part 4)](#pages-roles-and-security-part-4)
- [Reconciliation note (Part 5)](#reconciliation-note-part-5)
- [Testing and checking it](#testing-and-checking-it)
- [With more time](#with-more-time)

---

## Run it

Requirements: Node.js 20+, MySQL 8 (or Docker), and the mock API from the brief.

```bash
# 1. Mock API (separate terminal)
unzip tiktok-shop-mock-api.zip && cd tiktok-shop-mock-api && npm install && npm start   # http://localhost:4000

# 2. MySQL. Skip this if you already have MySQL 8 running; create a database and user instead.
docker compose up -d

# 3. Configure
cp .env.example .env
#   Fill in TTS_APP_KEY, TTS_APP_SECRET, TTS_AUTH_CODE, TTS_SHOP_ID, TTS_SHOP_CIPHER from the brief,
#   set CLIENT_PASSWORD / ADMIN_PASSWORD, and generate an encryption key:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # -> TOKEN_ENCRYPTION_KEY

# 4. Install, create tables, seed the two users
npm install
npm run migrate

# 5. Start the two processes (two terminals, or a process manager)
npm run worker   # connects the shop on first start, then syncs on its own schedule
npm run web      # http://localhost:3000
```

Log in as the client (`CLIENT_USERNAME` / `CLIENT_PASSWORD`) to see the sales page, or as the admin to see the internal page. If you prefer an explicit connect step: `npm run connect`, or `npm run connect -- <new auth code>` after a shop re-authorises.

| Command | What it does |
|---|---|
| `npm run migrate` | Applies `src/db/migrations/*.sql` once each, and seeds/updates the two users from `.env` |
| `npm run worker` | The only process that talks to TikTok: token refresh, sync, reconciliation |
| `npm run web` | Client and internal pages plus JSON endpoints. Reads MySQL only |
| `npm run connect` | Exchanges the authorization code for tokens and stores them |
| `npm run verify` | Downloads every order from the API and diffs it field by field against MySQL |
| `npm test` | Unit tests (no database or mock needed) |

## Stack and why

- **Node.js + Express.** It is what I use day to day, and the mock is Node too. Plain JavaScript (ES modules), no build step, so a second developer can run and read it straight away.
- **MySQL 8.** DECIMAL money columns, real transactions and row locks (`SELECT … FOR UPDATE`) for the token refresh, `INSERT … ON DUPLICATE KEY UPDATE` for idempotent upserts, `GET_LOCK` to guarantee a single worker.
- **EJS, server-rendered.** Two plain pages. No frontend build, no client-side JavaScript at all (the CSP forbids scripts). The daily chart is an SVG drawn on the server. The brief scores correctness, not UI.
- **Dependencies:** `express`, `ejs`, `mysql2`, `dotenv`. Everything else (encryption, password hashing, HTTP, tests) uses Node's standard library.

## How it fits together

```
                    ┌──────────────────────────── worker (npm run worker) ───────────────────────────┐
 TikTok Shop API ◄──┤ every 15s tick: keep token fresh → run sync if due → reconcile hourly           │
 (mock :4000)       │ rate limiter (30/min) · 429 retry with Retry-After · 401 → refresh → retry once │
                    └──────────────────────────────┬─────────────────────────────────────────────────┘
                                                   │ writes
                                                   ▼
                                                 MySQL  ◄── reads ── web (npm run web) ◄── browser
                                                   ▲                    "Sync now" only sets a flag
                                                   └──────────── sync_state.sync_requested_at ─┘
```

Two processes, one database. The web process has no TikTok client, no app secret and no encryption key. It cannot call the API even by accident, so opening any page produces zero requests in the mock's log.

Code map:

```
src/
  config.js              all env configuration (secrets read lazily, only where used)
  db/pool.js             mysql2 pool, UTC sessions, transaction helper
  db/migrations/*.sql    schema
  tiktok/http.js         envelope handling, rate limiter, retry/backoff
  tiktok/tokens.js       connect, encrypted storage, locked refresh
  tiktok/shopApi.js      shop-scoped calls (+ 401 → refresh → retry once)
  tiktok/secretBox.js    AES-256-GCM for tokens at rest
  sync/orders.js         resumable keyset sync, idempotent upserts, change audit
  sync/reconcile.js      Seller Center reconciliation check
  metrics.js             Net sales definition and the GMV → Net sales bridge (SQL)
  worker.js              scheduler loop + single-instance lock
  web/                   Express app, sessions/roles, EJS views, CSS
  scripts/               connect, verify
test/unit.test.js
```

## Schema

Full DDL: [`src/db/migrations/001_init.sql`](src/db/migrations/001_init.sql). TikTok timestamps are kept exactly as received (BIGINT unix seconds). Our own timestamps are UTC `DATETIME(3)`. Money is `DECIMAL(14,2)`, never float, and is summed in SQL.

| Table | Purpose |
|---|---|
| `shops` | Connected shops: id, cipher, name, region, **timezone** |
| `shop_tokens` | Access + refresh token (**encrypted**), absolute expiry times, `active` / `reauth_required`, last refresh error |
| `orders` | One row per TikTok order id (primary key → no duplicates). Every money field (subtotal, discount, shipping_fee, tax, total_amount, refund_amount), status, refund_status, create/update time, `create_date_local` (the order date in the shop's timezone), and the raw JSON |
| `order_line_items` | Product, SKU, quantity, unit price per line |
| `order_changes` | Audit row whenever a re-fetched order's status or refund changed (old → new). Explains why a past day's number moved |
| `sync_state` | Per shop: incremental cursor, full-sweep cursor, status, last success, last failure time + message, manual-sync request flag |
| `sync_runs` | One row per run: kind, trigger, pages, orders upserted/changed, retries, error |
| `reconciliation_checks` | Hourly Seller Center comparison (see Part 5) |
| `users`, `sessions` | Two hardcoded users (scrypt hashes); server-side sessions stored as SHA-256 of the cookie |

## Keeping the shop connected (Part 1)

- **Storage.** Tokens are stored in MySQL, encrypted with AES-256-GCM. The key (`TOKEN_ENCRYPTION_KEY`) exists only in the worker's environment, so a database dump or backup alone does not leak usable tokens. Tokens are never logged or sent to the browser.
- **Proactive refresh.** The worker wakes every 15 seconds and checks the stored expiry (an absolute timestamp, as the API returns). With less than 5 minutes left it refreshes. So with a 15-minute token it refreshes roughly every 10 minutes, whether or not a sync is running.
- **Reactive refresh.** If a call still gets `401` (105001 expired, or 105002 invalid), the request forces one refresh and retries once.
- **No refresh races.** Each refresh invalidates the previous refresh token. If two refreshes ran at once, the second would send a dead refresh token and the shop would need a human to re-authorise it. Refresh therefore runs inside a transaction holding `SELECT … FOR UPDATE` on the token row: a second caller waits, sees that the token has already been replaced, and uses the new one. Only one worker can run at all (MySQL `GET_LOCK`).
- **Rolling 7-day refresh token.** Every refresh returns a new 7-day refresh token, so it never gets close to expiring while the worker runs.
- **When only a human can fix it.** If the refresh token itself is rejected, the shop is marked `reauth_required`, syncing stops (no hammering), the internal page shows it in red with the fix (`npm run connect -- <code>`), and an alert is logged (and POSTed to `ALERT_WEBHOOK_URL` if set).

## How the sync works (Part 2)

**Scheduling.** The worker checks every 15 seconds what is due. All decisions are read from MySQL, so a restart keeps the schedule:

1. a manual "Sync now" / "Full resync" from the internal page,
2. a full sweep that was interrupted (resume it),
3. the daily full sweep,
4. the incremental sync, every 5 minutes (every 60 seconds after a failure).

**Paging: keyset on `update_time`, not page-one offsets.** The API sorts by `update_time` ascending and accepts `update_time_ge`. Each request asks for `update_time >= cursor`, where the cursor is the highest `update_time` already committed. Each page of orders and the new cursor are written **in one transaction**. Therefore:

- **Kill it mid-sync and it resumes from the last committed page.** On start-up the worker marks the orphaned run `interrupted` and continues from the saved cursor. Tested with `kill -9` after 4 of 14 pages: the next run started at the saved cursor and needed 10 pages, not 14.
- **Offsets can't skip orders.** With `page_token` offsets, an order that changes mid-sync jumps to the end of the list and shifts every later offset by one, silently skipping an order. Keyset paging does not have this problem.
- **No infinite loops.** If a whole page shares one `update_time`, it follows `next_page_token` until the timestamp moves.

**No duplicates.** `orders.id` is the TikTok order id and every write is `INSERT … ON DUPLICATE KEY UPDATE`. Re-running a page, a whole sync, or two overlapping syncs only rewrites the same rows. Line items are replaced per order in the same transaction.

**429s never lose data.** A 429 is a request to ask again, not an error in the data:

- `Retry-After` is honoured exactly (2s for the random ones, 15s for the per-minute limit), with a little jitter.
- 5xx and network errors back off exponentially.
- A client-side sliding-window limiter caps us at 30 requests/minute, under the API's 40, so the 15-second penalty doesn't happen in normal running.
- If retries run out, the run is marked failed, but everything committed so far stays and the next run continues from the cursor.

**Everything is stored.** Every order with every money field, its line items, and its raw JSON. Totals are computed from rows at query time, never stored.

## Orders that change later (Part 3)

Cancellations and refunds bump `update_time`, so a changed order reappears in the next incremental query:

- **Incremental every 5 minutes.** Each run starts 10 minutes before the saved cursor (lookback for late-arriving updates). A normal run is **one request**. We never re-download every order on every run.
- **Change audit.** When a re-fetched order's status or refund differs from what we stored, an `order_changes` row records old → new. The internal page shows the count, and it explains why a past day's number changed.
- **Cursor safety.** The saved cursor is never allowed past the time the run started. If an `update_time` is ever ahead of our clock (clock skew, or future-stamped source data), a cursor that jumped to it would sit above changes stamped with the real current time, and they would never be fetched. For the same reason we keep the latest copy even if its `update_time` is lower than the stored one.
- **Daily full sweep.** A safety net for any change that might not bump `update_time`. It is resumable, like the incremental sync.

**Why 5 minutes is "a reasonable time".** A client looking at sales mostly compares today with previous days, and a cancellation that takes an hour to show makes our number disagree with what they just saw in Seller Center. That costs trust. On the other side, 5 minutes costs about 288 small requests a day, far inside the 40/min limit. Going to 1 minute would add load for no decision a seller actually makes faster. The client page shows when the data was last synced, and warns if that is more than 20 minutes ago. In testing: the mock cancelled 25 orders at T+20 min, and the next incremental run (T+21 min) picked up all 25 in a single request.

## Pages, roles and security (Part 4)

**Client page** (`/dashboard`): Net sales and order count for the selected range, a daily net sales chart with the numbers underneath, a date range picker with presets, and "data last synced" time. It defaults to the last 30 days including today, in the shop's timezone. The **definition of Net sales is printed on the page**, together with a small table that walks from Seller Center's GMV to our Net sales for the same dates (see Part 5).

**Internal page** (`/internal`, admin only): per connected shop, sync status, last successful sync, last failure time and message, token status and expiry, the latest reconciliation result, the last 10 runs, and **Sync now** / **Full resync** buttons. The buttons only set a flag. The worker starts the run within ~15 seconds, so the web process still never calls TikTok.

**Permissions are enforced on the server, per request.**

- Every internal page and every `/api/internal/*` endpoint passes `requireRole('admin')`. A client gets 403 from the page, the JSON API and the form POST, whether they edit the URL or replay requests with their own cookie.
- A client's shop always comes from their session (`users.shop_id`). A `?shop=` parameter is ignored for clients.
- Sessions: 32 random bytes in an `HttpOnly`, `SameSite=Strict` cookie, stored as a SHA-256 hash with an expiry. Passwords are scrypt hashes. Failed logins are throttled.
- CSRF: `SameSite=Strict`, plus a per-session token on every HTML form. JSON POSTs must be `application/json`, which a browser cannot send cross-site without CORS, and we never allow CORS.
- Headers: a strict CSP (no scripts at all), `X-Frame-Options: DENY`, `nosniff`.

Quick check with curl:

```bash
curl -s -c c.txt -d 'username=client&password=...' localhost:3000/login
curl -s -b c.txt -o /dev/null -w '%{http_code}\n' localhost:3000/internal                      # 403
curl -s -b c.txt localhost:3000/api/internal/shops                                             # {"error":"forbidden"}
curl -s -b c.txt -X POST -H 'content-type: application/json' -d '{}' localhost:3000/api/internal/shops/7495001122334455/sync   # 403
```

**Secrets.** `.env` is git-ignored; `.env.example` lists every variable with placeholders. The app secret and encryption key are read only by the worker, never rendered, logged or sent to the browser, and the secret travels only in the POST body of the token calls, never in a URL.

## Reconciliation note (Part 5)

Measured after both of the mock's change waves, with the client page on its default range (the last 30 days as of 22 Sep, shop time):

| | Amount | Orders |
|---|---:|---:|
| Seller Center GMV (23 Aug – 21 Sep) | $26,634.82 | 562 |
| − 23 Aug, which is outside our default range (we show 24 Aug – 22 Sep) | −$966.07 | −21 |
| − unpaid orders: Seller Center counts them, we don't | −$209.90 | −3 |
| − partial refunds: Seller Center ignores them, we deduct them | −$240.70 | (10 orders) |
| **= our Net sales** | **$25,218.15** | **538** |

**Why they differ.** I rebuilt Seller Center's number from our own rows and it matches to the cent. Its GMV is: orders created on Los Angeles calendar days, not cancelled, subtotal − discount + shipping, tax excluded, refunds **not** deducted, **unpaid orders included**, over a fixed window that ends yesterday. So the gap is three specific, explainable things: the date window, unpaid orders, and refunds. None of it is missing data. Three traps would have made it worse, and we avoid all three:
- UTC days instead of shop days: +$138.69 and 3 orders.
- Summing `total_amount`: +$2,044.26 of sales tax.
- Missing the post-fetch cancellations: +$1,944.58 across 44 orders.

**What I'd show the client.** Net sales as the headline. It is the money they actually keep: paid, after refunds, before tax. GMV overstates it with orders that were never paid for or were refunded. But a client will compare it with Seller Center, so the page also prints the definition and the bridge table above for their selected dates. The gap is explained before they have to ask. I would never label our number "GMV".

**Catching the next gap automatically (built, `src/sync/reconcile.js`).** Every hour, right after a successful sync, the worker:
1. fetches the Seller Center summary;
2. recomputes GMV from our database *using Seller Center's own definition and its own period*;
3. compares the API's `total_count` with our row count.

Because the definitions are identical, any difference means our data is wrong (a missed update, a sync bug) or Seller Center changed its definition. Either way, we want to know before the client does. Each result is stored in `reconciliation_checks` and shown on the internal page. Two mismatches in a row raise an alert (log + optional webhook). A daily full sweep and the `order_changes` audit let us find and explain the cause.

## Testing and checking it

- `npm test`: unit tests for token encryption, timezone bucketing, date range validation, order mapping, the scheduler's decisions, 429 retry honouring `Retry-After`, 401 not being retried blindly, and the rate limiter.
- `npm run verify`: downloads all orders from the API right now and diffs them field by field against MySQL, including duplicate ids and cancelled/refunded counts. After the mock's two waves of changes: `640 / 640 rows, 0 duplicates, cancelled 47 = 47, refunded 35 = 35, database matches the API exactly`.
- Things tested by hand:
  - `kill -9` mid-sync, then restart: the run resumed from the cursor.
  - Real token expiry: the stored expiry was pushed forward so the proactive refresh wouldn't fire. The mock expired the token, the next sync got `401 105001`, refreshed, and finished in the same run.
  - Loading both pages many times: 0 new lines in the mock's request log.
  - Client-to-admin access via page, API and form POST: all 403.
- To see the 15-second rate-limit 429 in action, start the worker with `TTS_MAX_RPM=60` and trigger a full resync. It waits 15 seconds and carries on.

## With more time

- **Shared rate limiter.** Move it to MySQL/Redis, keyed per token, so several workers (one per group of shops) can run safely. Today exactly one worker runs, enforced by `GET_LOCK`.
- **Real OAuth callback.** Add an OAuth callback endpoint for the connect flow instead of a CLI with a pasted code, and multi-shop client users.
- **Refresh edge case.** If the network drops *after* TikTok rotated the refresh token but before we received it, that token is lost. I would handle this with TikTok's documented grace behaviour, or at least alert immediately, which happens today through `reauth_required`.
- **Refunds by refund date.** Record the date a refund happened (from `order_changes`), so the client can choose "refunds on the day they happened" vs "on the order day".
- **Hosted setup.** Run the worker under a process manager / container with health checks, ship metrics (sync lag, 429 rate, refresh failures) to monitoring, and add integration tests that run the mock in CI.
- **Store money as integer cents** end to end and add currency handling for non-USD shops.
