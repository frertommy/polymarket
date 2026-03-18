import { validateEnv, DISCOVERY_INTERVAL, SNAPSHOT_INTERVAL } from "./config.js";
import { log } from "./logger.js";
import {
  discoverSoccerMarkets,
  extractAssetIds,
  type SoccerMarket,
} from "./services/market-discovery.js";
import { PolymarketStreamer, type TradeEvent } from "./services/ws-streamer.js";
import { fetchOrderbookSnapshots } from "./services/orderbook-snapshots.js";
import {
  initSupabase,
  upsertMarkets,
  bufferTrade,
  flushTrades,
  storeSnapshots,
} from "./services/supabase-store.js";

validateEnv();
initSupabase();

// ─── State ──────────────────────────────────────────────────
let markets: SoccerMarket[] = [];
let assetIds: string[] = [];
let tradeCount = 0;

// ─── Trade handler: buffer → Supabase ───────────────────────
function onTrade(trade: TradeEvent): void {
  tradeCount++;
  bufferTrade(trade);

  if (tradeCount % 50 === 0) {
    log.info(`Trades received: ${tradeCount}`);
  }
}

// ─── Market discovery cycle ─────────────────────────────────
async function refreshMarkets(streamer: PolymarketStreamer): Promise<void> {
  const newMarkets = await discoverSoccerMarkets();
  if (newMarkets.length === 0) {
    log.warn("No soccer markets found, keeping previous list");
    return;
  }

  const newAssetIds = extractAssetIds(newMarkets);

  // Unsubscribe removed assets
  const removed = assetIds.filter((id) => !newAssetIds.includes(id));
  if (removed.length > 0) {
    await streamer.unsubscribe(removed);
  }

  // Subscribe new assets
  await streamer.subscribe(newAssetIds);

  markets = newMarkets;
  assetIds = newAssetIds;

  // Persist to Supabase
  await upsertMarkets(markets);

  log.info(
    `Markets refreshed: ${markets.length} markets, ${assetIds.length} assets`
  );
}

// ─── Orderbook snapshot cycle ───────────────────────────────
async function snapshotCycle(): Promise<void> {
  if (assetIds.length === 0) return;

  const topAssets = assetIds.slice(0, 50);
  const snapshots = await fetchOrderbookSnapshots(topAssets);

  if (snapshots.length > 0) {
    // Persist to Supabase
    await storeSnapshots(snapshots);

    const avgSpread =
      snapshots.reduce((s, snap) => s + snap.spread, 0) / snapshots.length;
    log.info(
      `Snapshots: ${snapshots.length} books, avg spread ${avgSpread.toFixed(4)}`
    );
  }
}

// ─── Main ───────────────────────────────────────────────────
async function main(): Promise<void> {
  log.info("═══ Polymarket Soccer Poller starting ═══");
  log.info("Sources: poly-websockets (WS) + CLOB REST + Supabase storage");

  // 1. Start WS streamer
  const streamer = new PolymarketStreamer({ onTrade });
  streamer.start();

  // 2. Initial market discovery
  await refreshMarkets(streamer);

  // 3. Schedule periodic market refresh
  const discoveryTimer = setInterval(async () => {
    try {
      await refreshMarkets(streamer);
    } catch (err) {
      log.error("Market refresh failed:", err instanceof Error ? err.message : err);
    }
  }, DISCOVERY_INTERVAL);

  // 4. Schedule periodic orderbook snapshots
  const snapshotTimer = setInterval(async () => {
    try {
      await snapshotCycle();
    } catch (err) {
      log.error("Snapshot cycle failed:", err instanceof Error ? err.message : err);
    }
  }, SNAPSHOT_INTERVAL);

  // 5. Periodic trade flush + stats
  const flushTimer = setInterval(async () => {
    await flushTrades();
  }, 10_000);

  const statsTimer = setInterval(() => {
    const stats = streamer.getStats();
    log.info(
      `Stats: ${stats.subscribedAssets} assets, ${tradeCount} trades, ${markets.length} markets`
    );
  }, 60_000);

  // ─── Graceful shutdown ─────────────────────────────────────
  const shutdown = async () => {
    log.info("Shutting down...");
    clearInterval(discoveryTimer);
    clearInterval(snapshotTimer);
    clearInterval(flushTimer);
    clearInterval(statsTimer);
    await flushTrades(); // Flush remaining trades
    await streamer.stop();
    log.info(`Final: ${tradeCount} trades processed`);
    process.exit(0);
  };

  process.on("SIGINT", () => { shutdown(); });
  process.on("SIGTERM", () => { shutdown(); });

  log.info("═══ Polymarket poller running ═══");
}

main().catch((err) => {
  log.error("Fatal:", err);
  process.exit(1);
});
