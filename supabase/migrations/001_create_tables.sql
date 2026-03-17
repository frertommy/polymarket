-- ═══════════════════════════════════════════════════════════════
-- Soccer betting market data — 4 table schema
-- ═══════════════════════════════════════════════════════════════

-- 1. Polymarket markets (discovered via Gamma API)
CREATE TABLE IF NOT EXISTS polymarket_markets (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  condition_id    TEXT NOT NULL UNIQUE,
  question_id     TEXT,
  slug            TEXT,
  question        TEXT NOT NULL,
  outcomes        JSONB NOT NULL DEFAULT '[]',
  clob_token_ids  JSONB NOT NULL DEFAULT '[]',
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  volume          NUMERIC,
  end_date        TIMESTAMPTZ,
  tags            JSONB DEFAULT '[]',
  discovered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_poly_markets_active ON polymarket_markets (active);
CREATE INDEX idx_poly_markets_updated ON polymarket_markets (updated_at);

-- 2. Kalshi markets (discovered via REST API)
CREATE TABLE IF NOT EXISTS kalshi_markets (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticker          TEXT NOT NULL UNIQUE,
  event_ticker    TEXT,
  series_ticker   TEXT,
  title           TEXT NOT NULL,
  subtitle        TEXT,
  yes_ask         NUMERIC,
  yes_bid         NUMERIC,
  no_ask          NUMERIC,
  no_bid          NUMERIC,
  last_price      NUMERIC,
  volume          INTEGER,
  open_interest   INTEGER,
  status          TEXT,
  close_time      TIMESTAMPTZ,
  discovered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_kalshi_markets_status ON kalshi_markets (status);
CREATE INDEX idx_kalshi_markets_series ON kalshi_markets (series_ticker);
CREATE INDEX idx_kalshi_markets_updated ON kalshi_markets (updated_at);

-- 3. Trades (real-time from Polymarket WS)
CREATE TABLE IF NOT EXISTS trades (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform          TEXT NOT NULL DEFAULT 'polymarket',
  asset_id          TEXT NOT NULL,
  market            TEXT,
  price             NUMERIC NOT NULL,
  size              NUMERIC NOT NULL,
  side              TEXT,
  transaction_hash  TEXT,
  trade_timestamp   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_trades_asset ON trades (asset_id);
CREATE INDEX idx_trades_platform ON trades (platform);
CREATE INDEX idx_trades_created ON trades (created_at);

-- 4. Orderbook snapshots (both platforms)
CREATE TABLE IF NOT EXISTS orderbook_snapshots (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform        TEXT NOT NULL,          -- 'polymarket' | 'kalshi'
  asset_id        TEXT NOT NULL,          -- clobTokenId or ticker
  midpoint        NUMERIC,
  spread          NUMERIC,
  best_bid        NUMERIC,
  best_ask        NUMERIC,
  last_price      NUMERIC,
  bid_depth       NUMERIC,
  ask_depth       NUMERIC,
  snapshot_time   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_snapshots_platform ON orderbook_snapshots (platform);
CREATE INDEX idx_snapshots_asset ON orderbook_snapshots (asset_id);
CREATE INDEX idx_snapshots_time ON orderbook_snapshots (snapshot_time);
CREATE INDEX idx_snapshots_platform_asset ON orderbook_snapshots (platform, asset_id);
