/**
 * Multi-Sport Prediction Market Poller
 *
 * Polls Polymarket and Kalshi for NBA, MLB, NHL, Tennis match-winner
 * odds and writes to sport-specific Supabase projects.
 *
 * Each sport gets:
 *   - Polymarket discovery (Gamma API) + REST price polling (CLOB midpoint)
 *   - Kalshi discovery (series ticker) + WebSocket real-time ticker updates
 *   - Change detection + per-match throttle
 *   - Writes to its own Supabase (matches, odds_snapshots, latest_odds)
 */
import {
  validateEnv,
  SPORTS,
  DISCOVERY_INTERVAL,
  PRICE_FLUSH_INTERVAL,
  STATS_INTERVAL,
  KALSHI_PRIVATE_KEY,
} from "./config.js";
import { log } from "./logger.js";
import { discoverPolymarketMatches } from "./services/polymarket-discovery.js";
import { discoverKalshiMatches } from "./services/kalshi-discovery.js";
import { initSupabaseClients, upsertMatches } from "./services/supabase-writer.js";
import { PriceTracker } from "./services/price-tracker.js";
import { KalshiStreamer, type TickerUpdate } from "./services/ws-streamer.js";
import type { TrackedMatch } from "./types.js";

validateEnv();
initSupabaseClients(SPORTS);

const priceTracker = new PriceTracker();
let allMatches: TrackedMatch[] = [];

// ─── Kalshi WS callback → PriceTracker ──────────────────────

function onKalshiTicker(update: TickerUpdate): void {
  const mid =
    update.yesBid > 0 && update.yesAsk > 0
      ? (update.yesBid + update.yesAsk) / 2
      : 0;
  if (mid > 0) {
    priceTracker.onPriceChange(update.marketTicker, mid);
  }
}

// ─── Polymarket REST poll for price updates ─────────────────

async function pollPolymarketPrices(): Promise<void> {
  const polyMatches = allMatches.filter((m) => m.source === "polymarket");
  if (polyMatches.length === 0) return;

  // Batch fetch midpoints via CLOB API (5 concurrent)
  const CONCURRENCY = 5;
  for (let i = 0; i < polyMatches.length; i += CONCURRENCY) {
    const batch = polyMatches.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (match) => {
        try {
          const [homeRes, awayRes] = await Promise.all([
            fetch(`https://clob.polymarket.com/midpoint?token_id=${match.homeAssetId}`),
            fetch(`https://clob.polymarket.com/midpoint?token_id=${match.awayAssetId}`),
          ]);
          if (!homeRes.ok || !awayRes.ok) return;

          const homeData = (await homeRes.json()) as { mid: string };
          const awayData = (await awayRes.json()) as { mid: string };

          const homePrice = parseFloat(homeData.mid || "0");
          const awayPrice = parseFloat(awayData.mid || "0");

          if (homePrice > 0) priceTracker.onPriceChange(match.homeAssetId, homePrice);
          if (awayPrice > 0) priceTracker.onPriceChange(match.awayAssetId, awayPrice);
        } catch { /* skip */ }
      })
    );
  }
}

// ─── Discovery cycle ────────────────────────────────────────

async function runDiscovery(streamer: KalshiStreamer): Promise<void> {
  log.info("Starting multi-sport discovery...");
  const newMatches: TrackedMatch[] = [];

  for (const sport of SPORTS) {
    const polyMatches = await discoverPolymarketMatches(
      sport.name,
      sport.polymarketTag
    );
    newMatches.push(...polyMatches);

    const kalshiMatches = await discoverKalshiMatches(
      sport.name,
      sport.kalshiSeries
    );
    newMatches.push(...kalshiMatches);

    const sportMatches = [...polyMatches, ...kalshiMatches];
    await upsertMatches(sport.name, sportMatches);
  }

  // Update price tracker
  priceTracker.updateMatches(newMatches);

  // Update Kalshi WS subscriptions
  const kalshiTickers = newMatches
    .filter((m) => m.source === "kalshi")
    .flatMap((m) => [m.homeAssetId, m.awayAssetId]);
  streamer.subscribe(kalshiTickers);

  allMatches = newMatches;

  for (const sport of SPORTS) {
    const poly = newMatches.filter(
      (m) => m.sport === sport.name && m.source === "polymarket"
    ).length;
    const kalshi = newMatches.filter(
      (m) => m.sport === sport.name && m.source === "kalshi"
    ).length;
    log.info(`[${sport.name}] ${poly} Polymarket + ${kalshi} Kalshi matches`);
  }

  log.info(`Discovery complete: ${newMatches.length} total matches`);
}

// ─── Main ───────────────────────────────────────────────────

async function main(): Promise<void> {
  log.info("═══ Multi-Sport Prediction Market Poller v2 (WS) starting ═══");
  log.info(`Sports: ${SPORTS.map((s) => s.name.toUpperCase()).join(", ")}`);
  log.info(
    `Intervals: discovery=${DISCOVERY_INTERVAL / 1000}s, flush=${PRICE_FLUSH_INTERVAL}ms`
  );

  // 1. Start Kalshi WS streamer
  const kalshiStreamer = new KalshiStreamer({
    onTicker: onKalshiTicker,
    onError: (err) => log.error("Kalshi WS error:", err.message),
  });

  if (KALSHI_PRIVATE_KEY) {
    kalshiStreamer.start();
  } else {
    log.warn("KALSHI_PRIVATE_KEY not set — Kalshi WS disabled, no Kalshi real-time updates");
  }

  // 2. Initial discovery
  await runDiscovery(kalshiStreamer);

  // 3. Polymarket REST price poll (1 second)
  const polyPollTimer = setInterval(async () => {
    try {
      await pollPolymarketPrices();
    } catch (err) {
      log.error("Poly poll error:", err instanceof Error ? err.message : err);
    }
  }, PRICE_FLUSH_INTERVAL);

  // 4. Price flush timer (1 second, offset by 500ms)
  setTimeout(() => {
    setInterval(async () => {
      try {
        await priceTracker.flush();
      } catch (err) {
        log.error("Flush error:", err instanceof Error ? err.message : err);
      }
    }, PRICE_FLUSH_INTERVAL);
  }, 500);

  // 5. Discovery refresh (5 minutes)
  const discoveryTimer = setInterval(async () => {
    try {
      await runDiscovery(kalshiStreamer);
    } catch (err) {
      log.error("Discovery error:", err instanceof Error ? err.message : err);
    }
  }, DISCOVERY_INTERVAL);

  // 6. Stats (1 minute)
  const statsTimer = setInterval(() => {
    const wsStats = kalshiStreamer.getStats();
    const ptStats = priceTracker.getStats();
    log.info(
      `Kalshi WS: ${wsStats.subscribedTickers} tickers, ${wsStats.tickersReceived} updates, ${wsStats.connected ? "connected" : "DISCONNECTED"}`
    );
    for (const [sport, s] of ptStats) {
      log.info(
        `[${sport}] ${s.matches} matches, ${s.updates} updates, ${s.writes} writes, ${s.skipped} skipped`
      );
    }
  }, STATS_INTERVAL);

  // ─── Graceful shutdown ─────────────────────────────────────
  const shutdown = async () => {
    log.info("Shutting down...");
    clearInterval(polyPollTimer);
    clearInterval(discoveryTimer);
    clearInterval(statsTimer);
    await priceTracker.flush();
    kalshiStreamer.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => { shutdown(); });
  process.on("SIGTERM", () => { shutdown(); });

  log.info("═══ Multi-sport poller running ═══");
}

main().catch((err) => {
  log.error("Fatal:", err);
  process.exit(1);
});
