-- Conventions
--   * TikTok timestamps are kept exactly as received: BIGINT unix seconds (UTC).
--   * Our own timestamps are DATETIME(3) in UTC (every connection runs SET time_zone='+00:00').
--   * Money is DECIMAL(14,2), never FLOAT.

-- Connected shops.
CREATE TABLE shops (
  id            VARCHAR(32)  NOT NULL PRIMARY KEY,   -- TikTok shop id
  cipher        VARCHAR(64)  NOT NULL,               -- shop_cipher, required on every shop call
  name          VARCHAR(255) NOT NULL,
  region        VARCHAR(8)   NOT NULL,
  timezone      VARCHAR(64)  NOT NULL,               -- IANA tz. All "days" in reports are shop-local days.
  seller_name   VARCHAR(255) NULL,
  open_id       VARCHAR(64)  NULL,
  connected_at  DATETIME(3)  NOT NULL DEFAULT (UTC_TIMESTAMP(3))
) ENGINE=InnoDB;

-- OAuth tokens, encrypted at rest (AES-256-GCM, key only in the worker's environment).
CREATE TABLE shop_tokens (
  shop_id             VARCHAR(32)  NOT NULL PRIMARY KEY,
  access_token_enc    TEXT         NOT NULL,
  access_expires_at   BIGINT       NOT NULL,          -- unix seconds (API gives absolute timestamps)
  refresh_token_enc   TEXT         NOT NULL,
  refresh_expires_at  BIGINT       NOT NULL,
  status              ENUM('active','reauth_required') NOT NULL DEFAULT 'active',
  last_refreshed_at   DATETIME(3)  NULL,
  last_refresh_error  TEXT         NULL,
  updated_at          DATETIME(3)  NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT fk_tokens_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Every order with every money field. The TikTok order id is the primary key,
-- so re-fetching an order updates the same row: duplicates are impossible.
CREATE TABLE orders (
  id                 VARCHAR(32)   NOT NULL PRIMARY KEY,
  shop_id            VARCHAR(32)   NOT NULL,
  status             VARCHAR(32)   NOT NULL,          -- UNPAID | AWAITING_SHIPMENT | IN_TRANSIT | DELIVERED | COMPLETED | CANCELLED
  create_time        BIGINT        NOT NULL,
  update_time        BIGINT        NOT NULL,
  create_date_local  DATE          NOT NULL,          -- create_time as a calendar date in the shop's timezone
  buyer_region       VARCHAR(8)    NULL,
  currency           CHAR(3)       NOT NULL,
  subtotal           DECIMAL(14,2) NOT NULL,
  discount           DECIMAL(14,2) NOT NULL,
  shipping_fee       DECIMAL(14,2) NOT NULL,
  tax                DECIMAL(14,2) NOT NULL,
  total_amount       DECIMAL(14,2) NOT NULL,
  refund_amount      DECIMAL(14,2) NOT NULL,
  refund_status      VARCHAR(32)   NOT NULL,          -- NONE | PARTIAL_REFUND | REFUNDED
  raw                JSON          NOT NULL,          -- exact payload received, for audits
  first_seen_at      DATETIME(3)   NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  last_synced_at     DATETIME(3)   NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  KEY idx_orders_shop_date (shop_id, create_date_local),
  KEY idx_orders_shop_update (shop_id, update_time),
  CONSTRAINT fk_orders_shop FOREIGN KEY (shop_id) REFERENCES shops(id)
) ENGINE=InnoDB;

CREATE TABLE order_line_items (
  order_id      VARCHAR(32)   NOT NULL,
  line_no       INT           NOT NULL,
  product_name  VARCHAR(255)  NOT NULL,
  sku_id        VARCHAR(64)   NOT NULL,
  quantity      INT           NOT NULL,
  unit_price    DECIMAL(14,2) NOT NULL,
  PRIMARY KEY (order_id, line_no),
  CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Audit trail: every change we saw on an order after first fetching it
-- (cancellations, refunds, status moves). Answers "why did yesterday's number change?".
CREATE TABLE order_changes (
  id                 BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id           VARCHAR(32)   NOT NULL,
  observed_at        DATETIME(3)   NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  old_update_time    BIGINT        NOT NULL,
  new_update_time    BIGINT        NOT NULL,
  old_status         VARCHAR(32)   NOT NULL,
  new_status         VARCHAR(32)   NOT NULL,
  old_refund_amount  DECIMAL(14,2) NOT NULL,
  new_refund_amount  DECIMAL(14,2) NOT NULL,
  old_refund_status  VARCHAR(32)   NOT NULL,
  new_refund_status  VARCHAR(32)   NOT NULL,
  KEY idx_changes_order (order_id),
  CONSTRAINT fk_changes_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Sync checkpoint per shop. Cursors are committed in the same transaction as each page of
-- orders, so a crash resumes from the last committed page, never from page one.
CREATE TABLE sync_state (
  shop_id               VARCHAR(32)  NOT NULL PRIMARY KEY,
  incr_cursor           BIGINT       NOT NULL DEFAULT 0,   -- highest update_time fully stored
  full_cursor           BIGINT       NULL,                 -- not NULL while a full sweep is in progress
  status                ENUM('idle','running','failed') NOT NULL DEFAULT 'idle',
  current_run_id        BIGINT       NULL,
  last_run_started_at   DATETIME(3)  NULL,
  last_success_at       DATETIME(3)  NULL,
  last_full_success_at  DATETIME(3)  NULL,
  last_failure_at       DATETIME(3)  NULL,
  last_failure_message  TEXT         NULL,
  sync_requested_at     DATETIME(3)  NULL,                 -- set by "Sync now" on the internal page
  sync_requested_kind   ENUM('incremental','full') NULL,
  CONSTRAINT fk_sync_state_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- One row per sync run.
CREATE TABLE sync_runs (
  id               BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_id          VARCHAR(32)  NOT NULL,
  kind             ENUM('incremental','full') NOT NULL,
  trigger_source   ENUM('schedule','manual','resume') NOT NULL,
  started_at       DATETIME(3)  NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  finished_at      DATETIME(3)  NULL,
  status           ENUM('running','success','failed','interrupted') NOT NULL DEFAULT 'running',
  start_cursor     BIGINT       NULL,
  end_cursor       BIGINT       NULL,
  pages            INT          NOT NULL DEFAULT 0,
  orders_upserted  INT          NOT NULL DEFAULT 0,
  orders_changed   INT          NOT NULL DEFAULT 0,
  retries          INT          NOT NULL DEFAULT 0,
  error            TEXT         NULL,
  KEY idx_runs_shop (shop_id, started_at),
  CONSTRAINT fk_runs_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Automatic reconciliation against Seller Center (README, Part 5).
CREATE TABLE reconciliation_checks (
  id                    BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_id               VARCHAR(32)   NOT NULL,
  checked_at            DATETIME(3)   NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  period_start          DATE          NOT NULL,
  period_end            DATE          NOT NULL,
  seller_center_gmv     DECIMAL(14,2) NOT NULL,
  seller_center_orders  INT           NOT NULL,
  local_gmv             DECIMAL(14,2) NOT NULL,   -- our data, Seller Center's definition
  local_orders          INT           NOT NULL,
  dashboard_net_sales   DECIMAL(14,2) NOT NULL,   -- what the client page shows for the same dates
  dashboard_orders      INT           NOT NULL,
  remote_total_count    INT           NOT NULL,   -- orders/search total_count, no filters
  local_total_count     INT           NOT NULL,
  ok                    BOOLEAN       NOT NULL,
  notes                 TEXT          NULL,
  KEY idx_recon_shop (shop_id, checked_at),
  CONSTRAINT fk_recon_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Hardcoded users, seeded from env by `npm run migrate`. Passwords are scrypt hashes.
CREATE TABLE users (
  id             INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username       VARCHAR(64)  NOT NULL UNIQUE,
  password_hash  VARCHAR(255) NOT NULL,
  role           ENUM('client','admin') NOT NULL,
  shop_id        VARCHAR(32)  NULL,     -- the one shop a client may see (no FK: users exist before the shop connects)
  CONSTRAINT chk_client_has_shop CHECK (role = 'admin' OR shop_id IS NOT NULL)
) ENGINE=InnoDB;

-- Server-side sessions. We store a SHA-256 of the cookie value, never the value itself.
CREATE TABLE sessions (
  id_hash     CHAR(64)    NOT NULL PRIMARY KEY,
  user_id     INT         NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  expires_at  DATETIME(3) NOT NULL,
  KEY idx_sessions_expiry (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
