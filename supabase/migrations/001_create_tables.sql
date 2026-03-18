-- ═══════════════════════════════════════════════════════════════
-- Polymarket soccer betting data — 3 table schema
-- ═══════════════════════════════════════════════════════════════

-- 1. Polymarket markets (discovered via Gamma /events?tag_slug=soccer)
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
  event_title     TEXT,
  event_slug      TEXT,
  discovered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_poly_markets_active ON polymarket_markets (active);
CREATE INDEX idx_poly_markets_updated ON polymarket_markets (updated_at);
CREATE INDEX idx_poly_markets_event ON polymarket_markets (event_slug);

-- 2. Trades (real-time from Polymarket WS)
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

-- 3. Orderbook snapshots (Polymarket CLOB)
CREATE TABLE IF NOT EXISTS orderbook_snapshots (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform        TEXT NOT NULL DEFAULT 'polymarket',
  asset_id        TEXT NOT NULL,          -- clobTokenId
  midpoint        NUMERIC,
  spread          NUMERIC,
  best_bid        NUMERIC,
  best_ask        NUMERIC,
  last_price      NUMERIC,
  bid_depth       NUMERIC,
  ask_depth       NUMERIC,
  snapshot_time   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_snapshots_asset ON orderbook_snapshots (asset_id);
CREATE INDEX idx_snapshots_time ON orderbook_snapshots (snapshot_time);
