/**
 * Kalshi Soccer Odds Poller — Main Orchestrator
 *
 * Discovers match-winner markets across EPL/La Liga/Bundesliga/Serie A/
 * Ligue 1/UCL, subscribes to Kalshi WebSocket for real-time ticker updates,
 * writes MSI-compatible odds rows to Supabase with change detection.
 *
 * Loops:
 *   1. Market discovery (every 5 min) — find matches, resolve fixture_ids
 *   2. WS ticker stream (continuous) — real-time price updates
 *   3. Price flush (every 1 sec) — write changed odds to Supabase
 *   4. Stats (every 1 min) — log counts
 */
import {
  validateEnv,
  DISCOVERY_INTERVAL,
  PRICE_FLUSH_INTERVAL,
  STATS_INTERVAL,
  KALSHI_PRIVATE_KEY,
} from "./config.js";
import { log } from "./logger.js";
import { discoverMatches } from "./services/market-discovery.js";
import { initSupabase } from "./services/supabase-writer.js";
import { KalshiStreamer, type TickerUpdate } from "./services/ws-streamer.js";
import { PriceTracker } from "./services/price-tracker.js";
import type { GroupedMatch } from "./types.js";

validateEnv();
initSupabase();

// ─── State ──────────────────────────────────────────────────
let currentMatches: GroupedMatch[] = [];
let currentTickers: string[] = [];
const priceTracker = new PriceTracker();

// ─── WS callback → PriceTracker ────────────────────────────

function onTicker(update: TickerUpdate): void {
  priceTracker.onTickerUpdate(update.marketTicker, update.yesBid, update.yesAsk);
}

// ─── Market discovery cycle ─────────────────────────────────

async function refreshMarkets(streamer: KalshiStreamer): Promise<void> {
  const result = await discoverMatches();

  if (result.matches.length === 0) {
    log.warn("No matches found, keeping previous list");
    return;
  }

  const newTickers = result.allMarketTickers;

  // Unsubscribe removed tickers
  const removed = currentTickers.filter((t) => !newTickers.includes(t));
  if (removed.length > 0) {
    streamer.unsubscribe(removed);
  }

  // Subscribe new tickers
  streamer.subscribe(newTickers);

  // Update price tracker
  priceTracker.updateMatches(result.matches);

  currentMatches = result.matches;
  currentTickers = newTickers;

  log.info(
    `Markets refreshed: ${currentMatches.length} matches, ${currentTickers.length} tickers`
  );
}

// ─── Main ───────────────────────────────────────────────────

async function main(): Promise<void> {
  log.info("═══ Kalshi Soccer Odds Poller v2 (WebSocket) starting ═══");
  log.info("Mode: MSI-compatible odds → odds_snapshots + latest_odds");
  log.info(
    `Intervals: discovery=${DISCOVERY_INTERVAL / 1000}s, flush=${PRICE_FLUSH_INTERVAL}ms`
  );

  if (!KALSHI_PRIVATE_KEY) {
    log.error("KALSHI_PRIVATE_KEY not set — cannot connect to WebSocket");
    log.error("Set KALSHI_PRIVATE_KEY env var with RSA private key PEM contents");
    process.exit(1);
  }

  // 1. Start WS streamer
  const streamer = new KalshiStreamer({
    onTicker,
    onError: (err) => log.error("WS error:", err.message),
  });
  streamer.start();

  // 2. Initial market discovery
  await refreshMarkets(streamer);

  // 3. Price flush timer (1 second)
  const flushTimer = setInterval(async () => {
    try {
      await priceTracker.flush();
    } catch (err) {
      log.error(
        "Price flush failed:",
        err instanceof Error ? err.message : err
      );
    }
  }, PRICE_FLUSH_INTERVAL);

  // 4. Market discovery timer (5 minutes)
  const discoveryTimer = setInterval(async () => {
    try {
      await refreshMarkets(streamer);
    } catch (err) {
      log.error(
        "Market refresh failed:",
        err instanceof Error ? err.message : err
      );
    }
  }, DISCOVERY_INTERVAL);

  // 5. Stats timer (1 minute)
  const statsTimer = setInterval(() => {
    const wsStats = streamer.getStats();
    const ptStats = priceTracker.getStats();
    log.info(
      `Stats: ${ptStats.trackedMatches} matches, ${wsStats.subscribedTickers} WS tickers, ` +
        `${wsStats.tickersReceived} ticker updates, ${ptStats.totalWrites} writes, ` +
        `${ptStats.totalSkipped} throttled, WS ${wsStats.connected ? "connected" : "DISCONNECTED"}`
    );
  }, STATS_INTERVAL);

  // ─── Graceful shutdown ─────────────────────────────────────
  const shutdown = async () => {
    log.info("Shutting down...");
    clearInterval(flushTimer);
    clearInterval(discoveryTimer);
    clearInterval(statsTimer);

    await priceTracker.flush();
    streamer.stop();

    const stats = priceTracker.getStats();
    log.info(
      `Final: ${stats.totalWrites} odds rows written, ${stats.totalUpdates} ticker updates processed`
    );
    process.exit(0);
  };

  process.on("SIGINT", () => { shutdown(); });
  process.on("SIGTERM", () => { shutdown(); });

  log.info("═══ Kalshi poller running ═══");
}

main().catch((err) => {
  log.error("Fatal:", err);
  process.exit(1);
});
