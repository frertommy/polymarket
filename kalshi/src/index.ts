import { validateEnv, MARKET_REFRESH_INTERVAL, ORDERBOOK_POLL_INTERVAL } from "./config.js";
import { log } from "./logger.js";
import {
  discoverSoccerMarkets,
  extractTickers,
  type KalshiMarket,
} from "./services/market-discovery.js";
import { fetchOrderbooks } from "./services/orderbook-poller.js";
import {
  initSupabase,
  upsertMarkets,
  storeOrderbooks,
} from "./services/supabase-store.js";

validateEnv();
initSupabase();

// ─── State ──────────────────────────────────────────────────
let markets: KalshiMarket[] = [];
let tickers: string[] = [];

// ─── Market discovery cycle ─────────────────────────────────
async function refreshMarkets(): Promise<void> {
  const newMarkets = await discoverSoccerMarkets();
  if (newMarkets.length === 0) {
    log.warn("No Kalshi soccer markets found, keeping previous list");
    return;
  }

  markets = newMarkets;
  tickers = extractTickers(markets);

  // Persist to Supabase
  await upsertMarkets(markets);

  log.info(`Markets refreshed: ${markets.length} markets, ${tickers.length} tickers`);
}

// ─── Orderbook poll cycle ───────────────────────────────────
async function orderbookCycle(): Promise<void> {
  if (tickers.length === 0) return;

  const topTickers = tickers.slice(0, 50);
  const orderbooks = await fetchOrderbooks(topTickers);

  if (orderbooks.length > 0) {
    // Persist to Supabase
    await storeOrderbooks(orderbooks);

    const avgSpread =
      orderbooks.reduce((s, ob) => s + ob.spread, 0) / orderbooks.length;
    log.info(
      `Orderbooks: ${orderbooks.length} books, avg spread ${avgSpread.toFixed(4)}`
    );
  }
}

// ─── Main ───────────────────────────────────────────────────
async function main(): Promise<void> {
  log.info("═══ Kalshi Soccer Poller starting ═══");
  log.info("Source: raw REST fetch + Supabase storage");

  // 1. Initial market discovery
  await refreshMarkets();

  // 2. Schedule periodic market refresh
  const discoveryTimer = setInterval(async () => {
    try {
      await refreshMarkets();
    } catch (err) {
      log.error("Market refresh failed:", err instanceof Error ? err.message : err);
    }
  }, MARKET_REFRESH_INTERVAL);

  // 3. Schedule periodic orderbook polling
  const orderbookTimer = setInterval(async () => {
    try {
      await orderbookCycle();
    } catch (err) {
      log.error("Orderbook poll failed:", err instanceof Error ? err.message : err);
    }
  }, ORDERBOOK_POLL_INTERVAL);

  // 4. Periodic stats
  const statsTimer = setInterval(() => {
    log.info(`Stats: ${markets.length} markets, ${tickers.length} tickers tracked`);
  }, 60_000);

  // ─── Graceful shutdown ─────────────────────────────────────
  const shutdown = () => {
    log.info("Shutting down...");
    clearInterval(discoveryTimer);
    clearInterval(orderbookTimer);
    clearInterval(statsTimer);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log.info("═══ Kalshi poller running ═══");
}

main().catch((err) => {
  log.error("Fatal:", err);
  process.exit(1);
});
