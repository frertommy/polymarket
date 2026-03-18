/**
 * Kalshi Soccer Odds Poller — Main Orchestrator
 *
 * Discovers match-winner markets across EPL/La Liga/Bundesliga/Serie A/
 * Ligue 1/UCL, polls REST API every 1 second, writes MSI-compatible
 * odds rows to Supabase with change detection.
 *
 * Loops:
 *   1. Market discovery (every 5 min) — find matches, resolve fixture_ids
 *   2. Price poll (every 1 sec) — REST fetch + change detect + write
 *   3. Stats (every 1 min) — log counts
 */
import {
  validateEnv,
  DISCOVERY_INTERVAL,
  PRICE_POLL_INTERVAL,
  STATS_INTERVAL,
} from "./config.js";
import { log } from "./logger.js";
import { discoverMatches } from "./services/market-discovery.js";
import { initSupabase } from "./services/supabase-writer.js";
import { updateMatches, pollCycle, getStats } from "./services/price-poller.js";

validateEnv();
initSupabase();

// ─── Market discovery cycle ─────────────────────────────────

async function refreshMarkets(): Promise<void> {
  const result = await discoverMatches();

  if (result.matches.length === 0) {
    log.warn("No matches found, keeping previous list");
    return;
  }

  updateMatches(result.matches);

  log.info(
    `Markets refreshed: ${result.matches.length} matches, ${result.allMarketTickers.length} tickers`
  );
}

// ─── Main ───────────────────────────────────────────────────

async function main(): Promise<void> {
  log.info("═══ Kalshi Soccer Odds Poller starting ═══");
  log.info("Mode: MSI-compatible odds → odds_snapshots + latest_odds");
  log.info(
    `Intervals: discovery=${DISCOVERY_INTERVAL / 1000}s, poll=${PRICE_POLL_INTERVAL}ms`
  );

  // 1. Initial market discovery
  await refreshMarkets();

  // 2. Price poll timer (1 second)
  const pollTimer = setInterval(async () => {
    try {
      await pollCycle();
    } catch (err) {
      log.error(
        "Poll cycle failed:",
        err instanceof Error ? err.message : err
      );
    }
  }, PRICE_POLL_INTERVAL);

  // 3. Market discovery timer (5 minutes)
  const discoveryTimer = setInterval(async () => {
    try {
      await refreshMarkets();
    } catch (err) {
      log.error(
        "Market refresh failed:",
        err instanceof Error ? err.message : err
      );
    }
  }, DISCOVERY_INTERVAL);

  // 4. Stats timer (1 minute)
  const statsTimer = setInterval(() => {
    const stats = getStats();
    log.info(
      `Stats: ${stats.trackedMatches} matches, ${stats.totalPolls} polls, ` +
        `${stats.totalWrites} writes, ${stats.totalSkipped} skipped`
    );
  }, STATS_INTERVAL);

  // ─── Graceful shutdown ─────────────────────────────────────
  const shutdown = async () => {
    log.info("Shutting down...");
    clearInterval(pollTimer);
    clearInterval(discoveryTimer);
    clearInterval(statsTimer);

    // Final poll
    await pollCycle();

    const stats = getStats();
    log.info(
      `Final: ${stats.totalWrites} odds rows written, ${stats.totalPolls} polls`
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
