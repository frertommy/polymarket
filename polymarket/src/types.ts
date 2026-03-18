// ─── Gamma API response types ────────────────────────────────

export interface GammaMarketNested {
  id: string;
  conditionId: string;
  questionID: string;
  slug: string;
  question: string;
  outcomes: string; // JSON string: '["Yes","No"]'
  outcomePrices: string; // JSON string: '["0.52","0.48"]'
  clobTokenIds: string; // JSON string: '["id1","id2"]'
  active: boolean;
  closed: boolean;
  volumeNum: number;
  endDateIso: string;
  enableOrderBook: boolean;
  negRisk: boolean;
  negRiskMarketID: string;
  sportsMarketType?: string; // "moneyline" | "totals" | "spreads" | "both_teams_to_score"
  gameStartTime?: string; // ISO timestamp
  groupItemTitle?: string; // e.g. "Arsenal", "Draw (Arsenal vs. Chelsea)"
  groupItemThreshold?: string; // "0", "1", "2"
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  volume?: number;
  liquidity?: number;
}

export interface GammaEventResponse {
  id: string;
  title: string;
  slug: string;
  tags: { label: string }[];
  markets: GammaMarketNested[];
  volume: number;
  active: boolean;
  closed: boolean;
}

// ─── Grouped match (3 binary markets → 1X2) ────────────────

export interface GroupedMatch {
  negRiskMarketId: string;
  fixtureId: number;
  homeTeamRaw: string; // Polymarket name
  awayTeamRaw: string;
  homeTeamCanonical: string; // MSI canonical name
  awayTeamCanonical: string;
  gameStartTime: string; // ISO timestamp

  // Yes-side clobTokenIds for each leg
  homeAssetId: string;
  drawAssetId: string;
  awayAssetId: string;

  // Current in-memory Yes prices (0-1 probability)
  homeYesPrice: number;
  drawYesPrice: number;
  awayYesPrice: number;

  // Last persisted prices (for change detection)
  lastWrittenHome: number;
  lastWrittenDraw: number;
  lastWrittenAway: number;
  lastWriteTime: number; // epoch ms
}

// ─── Odds row (MSI-compatible format) ───────────────────────

export interface OddsRow {
  fixture_id: number;
  bookmaker: string; // 'polymarket'
  home_odds: number | null;
  draw_odds: number | null;
  away_odds: number | null;
  days_before_kickoff: number;
  snapshot_time: string; // ISO timestamp
  source: string; // 'polymarket'
}

// ─── WebSocket event types ──────────────────────────────────

export interface TradeEvent {
  assetId: string;
  market: string;
  price: number;
  size: number;
  side: string;
  timestamp: string;
  transactionHash: string;
}

export interface PriceUpdate {
  assetId: string;
  price: number;
  midpoint: number;
  spread: number;
}

// ─── Orderbook types ────────────────────────────────────────

export interface OrderbookSnapshot {
  assetId: string;
  midpoint: number;
  spread: number;
  bestBid: number;
  bestAsk: number;
  lastTradePrice: number;
  bidDepth: number;
  askDepth: number;
  timestamp: string;
}

// ─── Asset index (reverse lookup from asset_id → match+leg) ─

export interface AssetEntry {
  match: GroupedMatch;
  leg: "home" | "draw" | "away";
}

// ─── Discovery result ───────────────────────────────────────

export interface DiscoveryResult {
  matches: GroupedMatch[];
  assetIndex: Map<string, AssetEntry>;
  allAssetIds: string[];
}
