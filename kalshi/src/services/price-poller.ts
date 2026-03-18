/**
 * Price poller — polls Kalshi REST API every 1 second for all tracked
 * match-winner markets, detects price changes, writes to Supabase.
 *
 * Strategy:
 *   - Every 1 second: fetch all market tickers via REST
 *   - Compare prices against last written values
 *   - Only write when at least one of H/D/A changed
 *   - No WS available without auth, so REST is our path
 */
import { KALSHI_BASE, PRICE_CHANGE_THRESHOLD } from "../config.js";
import { kalshiFetch } from "../fetch.js";
import { log } from "../logger.js";
import type { KalshiMarket, GroupedMatch, OddsRow } from "../types.js";
import { writeOddsRows } from "./supabase-writer.js";

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Map of event_ticker → GroupedMatch */
let matchMap = new Map<string, GroupedMatch>();

/** Map of fixture_id → gameStartTime */
let kickoffMap = new Map<number, string>();

/** Stats */
let totalPolls = 0;
let totalWrites = 0;
let totalSkipped = 0;

// ─── Update match data (called on discovery refresh) ────────

export function updateMatches(matches: GroupedMatch[]): void {
  const oldMap = matchMap;
  matchMap = new Map();
  kickoffMap = new Map();

  for (const m of matches) {
    // Carry over lastWritten values from previous cycle to avoid re-writing same prices
    const prev = oldMap.get(m.eventTicker);
    if (prev) {
      m.lastWrittenHome = prev.lastWrittenHome;
      m.lastWrittenDraw = prev.lastWrittenDraw;
      m.lastWrittenAway = prev.lastWrittenAway;
      m.lastWriteTime = prev.lastWriteTime;
    }
    matchMap.set(m.eventTicker, m);
    kickoffMap.set(m.fixtureId, m.gameStartTime);
  }

  log.info(`PricePoller updated: ${matchMap.size} matches`);
}

// ─── Fetch current prices for all markets in a match ────────

async function fetchMarketPrices(
  tickers: string[]
): Promise<Map<string, KalshiMarket>> {
  const result = new Map<string, KalshiMarket>();

  // Kalshi doesn't have a bulk endpoint, so we batch by event
  // Each event has 3 markets, fetched in one call
  const eventTickers = new Set<string>();
  for (const t of tickers) {
    // Ticker format: KXEPLGAME-26MAR22TOTNFO-TOT → event = KXEPLGAME-26MAR22TOTNFO
    const parts = t.split("-");
    parts.pop(); // remove team suffix
    eventTickers.add(parts.join("-"));
  }

  const fetches = [...eventTickers].map(async (eventTicker) => {
    try {
      const url = `${KALSHI_BASE}/markets?event_ticker=${eventTicker}&limit=10`;
      const res = await kalshiFetch(url);
      if (!res.ok) return;
      const data = (await res.json()) as { markets: KalshiMarket[] };
      for (const m of data.markets ?? []) {
        result.set(m.ticker, m);
      }
    } catch {
      // silently skip failed fetches
    }
  });

  // Concurrency limit: 10 at a time
  const CONCURRENCY = 10;
  for (let i = 0; i < fetches.length; i += CONCURRENCY) {
    await Promise.all(fetches.slice(i, i + CONCURRENCY));
  }

  return result;
}

// ─── Poll cycle (called every 1 second) ─────────────────────

export async function pollCycle(): Promise<void> {
  if (matchMap.size === 0) return;

  totalPolls++;

  // Collect all market tickers
  const allTickers: string[] = [];
  for (const m of matchMap.values()) {
    allTickers.push(m.homeMarketTicker, m.drawMarketTicker, m.awayMarketTicker);
  }

  // Fetch current prices
  const marketData = await fetchMarketPrices(allTickers);

  const now = Date.now();
  const rows: OddsRow[] = [];

  for (const match of matchMap.values()) {
    const homeM = marketData.get(match.homeMarketTicker);
    const drawM = marketData.get(match.drawMarketTicker);
    const awayM = marketData.get(match.awayMarketTicker);

    if (!homeM || !drawM || !awayM) continue;

    // Get midpoint price (avg bid/ask)
    const midpoint = (m: KalshiMarket): number => {
      const bid = parseFloat(m.yes_bid_dollars || "0");
      const ask = parseFloat(m.yes_ask_dollars || "0");
      if (bid > 0 && ask > 0) return (bid + ask) / 2;
      return parseFloat(m.last_price_dollars || "0");
    };

    const homePrice = midpoint(homeM);
    const drawPrice = midpoint(drawM);
    const awayPrice = midpoint(awayM);

    // Change detection
    const homeChanged =
      Math.abs(homePrice - match.lastWrittenHome) >= PRICE_CHANGE_THRESHOLD;
    const drawChanged =
      Math.abs(drawPrice - match.lastWrittenDraw) >= PRICE_CHANGE_THRESHOLD;
    const awayChanged =
      Math.abs(awayPrice - match.lastWrittenAway) >= PRICE_CHANGE_THRESHOLD;

    if (!homeChanged && !drawChanged && !awayChanged) {
      totalSkipped++;
      continue;
    }

    // 1-second throttle per match
    if (now - match.lastWriteTime < 1000) {
      totalSkipped++;
      continue;
    }

    // Skip if all prices are zero
    if (homePrice < 0.001 && drawPrice < 0.001 && awayPrice < 0.001) continue;

    // Convert to decimal odds
    const homeOdds = homePrice > 0.001 ? round4(1 / homePrice) : null;
    const drawOdds = drawPrice > 0.001 ? round4(1 / drawPrice) : null;
    const awayOdds = awayPrice > 0.001 ? round4(1 / awayPrice) : null;

    const kickoff = new Date(match.gameStartTime).getTime();
    const daysBefore = Math.max(0, Math.round((kickoff - now) / 86400000));

    rows.push({
      fixture_id: match.fixtureId,
      bookmaker: "kalshi",
      home_odds: homeOdds,
      draw_odds: drawOdds,
      away_odds: awayOdds,
      days_before_kickoff: daysBefore,
      snapshot_time: new Date().toISOString(),
      source: "kalshi",
    });

    // Update tracking
    match.homeYesPrice = homePrice;
    match.drawYesPrice = drawPrice;
    match.awayYesPrice = awayPrice;
    match.lastWrittenHome = homePrice;
    match.lastWrittenDraw = drawPrice;
    match.lastWrittenAway = awayPrice;
    match.lastWriteTime = now;
  }

  if (rows.length > 0) {
    totalWrites += rows.length;
    await writeOddsRows(rows, kickoffMap);
  }
}

// ─── Stats ──────────────────────────────────────────────────

export function getStats(): {
  trackedMatches: number;
  totalPolls: number;
  totalWrites: number;
  totalSkipped: number;
} {
  return {
    trackedMatches: matchMap.size,
    totalPolls,
    totalWrites,
    totalSkipped,
  };
}
