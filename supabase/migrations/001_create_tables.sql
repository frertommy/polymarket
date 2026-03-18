-- ═══════════════════════════════════════════════════════════════
-- Polymarket poller — tables managed by this project
-- ═══════════════════════════════════════════════════════════════
--
-- The poller writes odds into MSI2026's existing tables:
--   odds_snapshots     (source='polymarket', bookmaker='polymarket')
--   latest_odds        (bookmaker='polymarket')
--   latest_preko_odds  (bookmaker='polymarket')
--   matches            (read-only — UCL fixture lookup)
--
-- Those tables are defined in the MSI2026 migrations, not here.
-- This migration only creates the Polymarket-specific table below.

-- Orderbook depth snapshots (Polymarket CLOB REST, hourly)
CREATE TABLE IF NOT EXISTS orderbook_snapshots (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform        TEXT NOT NULL DEFAULT 'polymarket',
  asset_id        TEXT NOT NULL,
  midpoint        NUMERIC,
  spread          NUMERIC,
  best_bid        NUMERIC,
  best_ask        NUMERIC,
  last_price      NUMERIC,
  bid_depth       NUMERIC,
  ask_depth       NUMERIC,
  snapshot_time   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_asset ON orderbook_snapshots (asset_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_time ON orderbook_snapshots (snapshot_time);
