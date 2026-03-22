// ─── Match (2-outcome: home/away or player1/player2) ────────

export interface TrackedMatch {
  matchId: string; // unique ID (poly negRiskMarketID or kalshi event_ticker)
  sport: string;
  source: "polymarket" | "kalshi";
  homeTeam: string;
  awayTeam: string;
  gameStartTime: string;

  // Asset/ticker IDs for each leg
  homeAssetId: string;
  awayAssetId: string;

  // Current prices (0-1 probability)
  homePrice: number;
  awayPrice: number;

  // Last persisted (for change detection)
  lastWrittenHome: number;
  lastWrittenAway: number;
  lastWriteTime: number;

  // Polymarket metadata (for polymarket_match_odds table)
  polymarketEventId?: string;
  eventTitle?: string;
  volume?: number;
}

// ─── Odds row (for Supabase) ────────────────────────────────

export interface OddsRow {
  match_id: string;
  source: string; // 'polymarket' | 'kalshi'
  home_odds: number | null;
  away_odds: number | null;
  home_prob: number;
  away_prob: number;
  snapshot_time: string;
}

// ─── Gamma API types ────────────────────────────────────────

export interface GammaMarket {
  conditionId: string;
  questionID: string;
  question: string;
  outcomes: string; // JSON string
  outcomePrices: string; // JSON string
  clobTokenIds: string; // JSON string
  volumeNum: number;
  active: boolean;
  closed: boolean;
  enableOrderBook: boolean;
  negRisk: boolean;
  negRiskMarketID: string;
  sportsMarketType?: string;
  gameStartTime?: string;
  groupItemTitle?: string;
  groupItemThreshold?: string;
}

export interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  volume: number;
  markets: GammaMarket[];
  active: boolean;
  closed: boolean;
}

// ─── Kalshi types ───────────────────────────────────────────

export interface KalshiEvent {
  event_ticker: string;
  series_ticker: string;
  title: string;
  sub_title: string;
  mutually_exclusive: boolean;
  last_updated_ts: string;
}

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  status: string;
  yes_bid_dollars: string;
  yes_ask_dollars: string;
  last_price_dollars: string;
  yes_sub_title: string;
  expected_expiration_time: string;
}
