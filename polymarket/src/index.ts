/**
 * Polymarket Soccer Odds Poller — Main Orchestrator
 *
 * Discovers moneyline soccer markets, subscribes to WS for real-time
 * trade/price updates, and writes MSI-compatible odds rows to Supabase.
 *
 * Loops:
 *   1. Market discovery (every 5 min) — find matches, resolve fixture_ids
 *   2. Price flush (every 1 sec) — write changed odds to odds_snapshots
 *   3. Orderbook depth (every 1 hr) — REST snapshots for context
 *   4. Stats (every 1 min) — log counts
 */
import {
  validateEnv,
  DISCOVERY_INTERVAL,
  PRICE_FLUSH_INTERVAL,
  ORDERBOOK_INTERVAL,
  STATS_INTERVAL,
} from "./config.js";
import { log } from "./logger.js";
import { discoverMoneylineMatches } from "./services/market-discovery.js";
import { PolymarketStreamer } from "./services/ws-streamer.js";
import { fetchOrderbookSnapshots } from "./services/orderbook-snapshots.js";
import { initSupabase, storeSnapshots } from "./services/supabase-writer.js";
import { PriceTracker } from "./services/price-tracker.js";
import type { GroupedMatch, TradeEvent, PriceUpdate } from "./types.js";

validateEnv();
initSupabase();

// ─── State ──────────────────────────────────────────────────
let currentMatches: GroupedMatch[] = [];
let currentAssetIds: string[] = [];
const priceTracker = new PriceTracker();

// ─── WS callbacks → PriceTracker ────────────────────────────

function onTrade(trade: TradeEvent): void {
  // trade.price is the Yes price for this asset
  priceTracker.onPriceChange(trade.assetId, trade.price);
}

function onPriceUpdate(update: PriceUpdate): void {
  // update.price is the Yes price for this asset
  priceTracker.onPriceChange(update.assetId, update.price);
}

// ─── Market discovery cycle ─────────────────────────────────

async function refreshMarkets(streamer: PolymarketStreamer): Promise<void> {
  const result = await discoverMoneylineMatches();

  if (result.matches.length === 0) {
    log.warn("No moneyline matches found, keeping previous list");
    return;
  }

  const newAssetIds = result.allAssetIds;

  // Unsubscribe removed assets
  const removedAssets = currentAssetIds.filter(
    (id) => !newAssetIds.includes(id)
  );
  if (removedAssets.length > 0) {
    await streamer.unsubscribe(removedAssets);
  }

  // Subscribe new assets
  await streamer.subscribe(newAssetIds);

  // Update price tracker with new match data
  priceTracker.updateMatches(result.matches, result.assetIndex);

  currentMatches = result.matches;
  currentAssetIds = newAssetIds;

  log.info(
    `Markets refreshed: ${currentMatches.length} matches, ${currentAssetIds.length} assets`
  );
}

// ─── Orderbook snapshot cycle (hourly) ──────────────────────

async function snapshotCycle(): Promise<void> {
  if (currentAssetIds.length === 0) return;

  // Take top 50 assets
  const topAssets = currentAssetIds.slice(0, 50);
  const snapshots = await fetchOrderbookSnapshots(topAssets);

  if (snapshots.length > 0) {
    await storeSnapshots(snapshots);

    const avgSpread =
      snapshots.reduce((s, snap) => s + snap.spread, 0) / snapshots.length;
    log.info(
      `Orderbook: ${snapshots.length} snapshots, avg spread ${avgSpread.toFixed(4)}`
    );
  }
}

// ─── Main ───────────────────────────────────────────────────

async function main(): Promise<void> {
  log.info("═══ Polymarket Soccer Odds Poller v3 starting ═══");
  log.info("Mode: MSI-compatible odds → odds_snapshots + latest_odds");
  log.info(
    `Intervals: discovery=${DISCOVERY_INTERVAL / 1000}s, flush=${PRICE_FLUSH_INTERVAL}ms, orderbook=${ORDERBOOK_INTERVAL / 60000}min`
  );

  // 1. Start WS streamer with PriceTracker callbacks
  const streamer = new PolymarketStreamer({
    onTrade,
    onPriceUpdate,
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

  // 5. Orderbook snapshot timer (1 hour)
  const orderbookTimer = setInterval(async () => {
    try {
      await snapshotCycle();
    } catch (err) {
      log.error(
        "Orderbook cycle failed:",
        err instanceof Error ? err.message : err
      );
    }
  }, ORDERBOOK_INTERVAL);

  // 6. Stats timer (1 minute)
  const statsTimer = setInterval(() => {
    const wsStats = streamer.getStats();
    const ptStats = priceTracker.getStats();
    log.info(
      `Stats: ${ptStats.trackedMatches} matches, ${wsStats.subscribedAssets} WS assets, ` +
        `${wsStats.tradesReceived} trades, ${ptStats.totalWrites} writes, ` +
        `${ptStats.totalSkipped} throttled, ${ptStats.pendingWrites} pending`
    );
  }, STATS_INTERVAL);

  // Do initial orderbook snapshot
  await snapshotCycle();

  // ─── Graceful shutdown ─────────────────────────────────────
  const shutdown = async () => {
    log.info("Shutting down...");
    clearInterval(flushTimer);
    clearInterval(discoveryTimer);
    clearInterval(orderbookTimer);
    clearInterval(statsTimer);

    // Final flush
    await priceTracker.flush();
    await streamer.stop();

    const stats = priceTracker.getStats();
    log.info(
      `Final: ${stats.totalWrites} odds rows written, ${stats.totalUpdates} price updates processed`
    );
    process.exit(0);
  };

  process.on("SIGINT", () => {
    shutdown();
  });
  process.on("SIGTERM", () => {
    shutdown();
  });

  log.info("═══ Polymarket poller running ═══");
}

main().catch((err) => {
  log.error("Fatal:", err);
  process.exit(1);
});
