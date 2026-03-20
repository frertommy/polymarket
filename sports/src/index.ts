/**
 * Multi-Sport Prediction Market Poller
 *
 * Polls Polymarket and Kalshi for NBA, MLB, NHL, Tennis match-winner
 * odds and writes to sport-specific Supabase projects.
 *
 * Each sport gets:
 *   - Polymarket discovery (Gamma API, tag-based)
 *   - Kalshi discovery (series ticker-based)
 *   - Real-time price tracking via Polymarket WS + Kalshi REST (1s)
 *   - Change detection + per-match throttle
 *   - Writes to its own Supabase (matches, odds_snapshots, latest_odds)
 */
import {
  validateEnv,
  SPORTS,
  DISCOVERY_INTERVAL,
  PRICE_FLUSH_INTERVAL,
  STATS_INTERVAL,
  KALSHI_BASE,
  KALSHI_API_KEY,
} from "./config.js";
import { log } from "./logger.js";
import { discoverPolymarketMatches } from "./services/polymarket-discovery.js";
import { discoverKalshiMatches } from "./services/kalshi-discovery.js";
import { initSupabaseClients, upsertMatches } from "./services/supabase-writer.js";
import { PriceTracker } from "./services/price-tracker.js";
import type { TrackedMatch, KalshiMarket } from "./types.js";

validateEnv();
initSupabaseClients(SPORTS);

const priceTracker = new PriceTracker();
let allMatches: TrackedMatch[] = [];

// ─── Kalshi REST poll for price updates ─────────────────────

function kalshiFetch(url: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (KALSHI_API_KEY) headers["Authorization"] = `Bearer ${KALSHI_API_KEY}`;
  return fetch(url, { headers });
}

async function pollKalshiPrices(): Promise<void> {
  const kalshiMatches = allMatches.filter((m) => m.source === "kalshi");
  if (kalshiMatches.length === 0) return;

  // Group by event ticker to minimize API calls
  const eventTickers = new Set<string>();
  for (const m of kalshiMatches) {
    // matchId format: kalshi_KXNBAGAME-26MAR22WASNYK
    // homeAssetId format: KXNBAGAME-26MAR22WASNYK-NYK (full ticker)
    const parts = m.homeAssetId.split("-");
    parts.pop();
    eventTickers.add(parts.join("-"));
  }

  const CONCURRENCY = 10;
  const tickers = [...eventTickers];
  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    const batch = tickers.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (eventTicker) => {
        try {
          const res = await kalshiFetch(
            `${KALSHI_BASE}/markets?event_ticker=${eventTicker}&limit=10`
          );
          if (!res.ok) return;
          const data = (await res.json()) as { markets: KalshiMarket[] };
          for (const m of data.markets ?? []) {
            const bid = parseFloat(m.yes_bid_dollars || "0");
            const ask = parseFloat(m.yes_ask_dollars || "0");
            const price = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
            if (price > 0) {
              priceTracker.onPriceChange(m.ticker, price);
            }
          }
        } catch { /* skip */ }
      })
    );
  }
}

// ─── Discovery cycle ────────────────────────────────────────

async function runDiscovery(): Promise<void> {
  log.info("Starting multi-sport discovery...");
  const newMatches: TrackedMatch[] = [];

  for (const sport of SPORTS) {
    // Polymarket
    const polyMatches = await discoverPolymarketMatches(
      sport.name,
      sport.polymarketTag
    );
    newMatches.push(...polyMatches);

    // Kalshi
    const kalshiMatches = await discoverKalshiMatches(
      sport.name,
      sport.kalshiSeries
    );
    newMatches.push(...kalshiMatches);

    // Upsert matches to sport-specific Supabase
    const sportMatches = [...polyMatches, ...kalshiMatches];
    await upsertMatches(sport.name, sportMatches);
  }

  priceTracker.updateMatches(newMatches);
  allMatches = newMatches;

  // Log summary
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
  log.info("═══ Multi-Sport Prediction Market Poller starting ═══");
  log.info(`Sports: ${SPORTS.map((s) => s.name.toUpperCase()).join(", ")}`);
  log.info(
    `Intervals: discovery=${DISCOVERY_INTERVAL / 1000}s, flush=${PRICE_FLUSH_INTERVAL}ms`
  );

  // 1. Initial discovery
  await runDiscovery();

  // 2. Kalshi REST price poll (1 second)
  const pollTimer = setInterval(async () => {
    try {
      await pollKalshiPrices();
    } catch (err) {
      log.error("Kalshi poll error:", err instanceof Error ? err.message : err);
    }
  }, PRICE_FLUSH_INTERVAL);

  // 3. Price flush timer (1 second, offset by 500ms)
  setTimeout(() => {
    setInterval(async () => {
      try {
        await priceTracker.flush();
      } catch (err) {
        log.error("Flush error:", err instanceof Error ? err.message : err);
      }
    }, PRICE_FLUSH_INTERVAL);
  }, 500);

  // 4. Discovery refresh (5 minutes)
  const discoveryTimer = setInterval(async () => {
    try {
      await runDiscovery();
    } catch (err) {
      log.error("Discovery error:", err instanceof Error ? err.message : err);
    }
  }, DISCOVERY_INTERVAL);

  // 5. Stats (1 minute)
  const statsTimer = setInterval(() => {
    const stats = priceTracker.getStats();
    for (const [sport, s] of stats) {
      log.info(
        `[${sport}] ${s.matches} matches, ${s.updates} updates, ${s.writes} writes, ${s.skipped} skipped`
      );
    }
  }, STATS_INTERVAL);

  // ─── Graceful shutdown ─────────────────────────────────────
  const shutdown = async () => {
    log.info("Shutting down...");
    clearInterval(pollTimer);
    clearInterval(discoveryTimer);
    clearInterval(statsTimer);
    await priceTracker.flush();
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
