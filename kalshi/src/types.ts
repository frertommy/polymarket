// ─── Kalshi API response types ──────────────────────────────

export interface KalshiEvent {
  event_ticker: string;
  series_ticker: string;
  title: string; // "Tottenham vs Nottingham"
  sub_title: string; // "TOT vs NFO (Mar 22)"
  category: string;
  mutually_exclusive: boolean;
  last_updated_ts: string;
  product_metadata?: {
    competition?: string;
    competition_scope?: string;
  };
}

export interface KalshiMarket {
  ticker: string; // "KXEPLGAME-26MAR22TOTNFO-TOT"
  event_ticker: string;
  title: string;
  subtitle: string;
  status: string; // "active" | "finalized"
  result: string; // "" | "yes" | "no"
  market_type: string;
  yes_bid_dollars: string; // "0.3700"
  yes_ask_dollars: string; // "0.3900"
  no_bid_dollars: string;
  no_ask_dollars: string;
  last_price_dollars: string; // "0.3700"
  previous_price_dollars: string;
  yes_sub_title: string; // "Tottenham" or "Tie"
  yes_bid_size_fp: string;
  yes_ask_size_fp: string;
  volume_fp: string;
  volume_24h_fp: string;
  open_interest_fp: string;
  open_time: string;
  close_time: string;
  expected_expiration_time: string; // actual match time
  created_time: string;
}

// ─── Grouped match (3 markets → 1X2) ───────────────────────

export interface GroupedMatch {
  eventTicker: string;
  fixtureId: number;
  homeTeamRaw: string;
  awayTeamRaw: string;
  homeTeamCanonical: string;
  awayTeamCanonical: string;
  gameStartTime: string; // expected_expiration_time

  // Market tickers for each leg
  homeMarketTicker: string;
  drawMarketTicker: string;
  awayMarketTicker: string;

  // Current midpoint prices (avg of bid/ask, 0-1)
  homeYesPrice: number;
  drawYesPrice: number;
  awayYesPrice: number;

  // Last persisted prices (for change detection)
  lastWrittenHome: number;
  lastWrittenDraw: number;
  lastWrittenAway: number;
  lastWriteTime: number; // epoch ms
}

// ─── Odds row (MSI-compatible) ──────────────────────────────

export interface OddsRow {
  fixture_id: number;
  bookmaker: string; // 'kalshi'
  home_odds: number | null;
  draw_odds: number | null;
  away_odds: number | null;
  days_before_kickoff: number;
  snapshot_time: string;
  source: string; // 'kalshi'
}

// ─── Discovery result ───────────────────────────────────────

export interface DiscoveryResult {
  matches: GroupedMatch[];
  /** All market tickers to poll (3 per match) */
  allMarketTickers: string[];
}
