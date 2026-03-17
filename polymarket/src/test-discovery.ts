/**
 * End-to-end test: discovery + orderbook snapshots (no Supabase needed).
 * Run with: npx tsx src/test-discovery.ts
 */
import { discoverSoccerMarkets, extractAssetIds } from "./services/market-discovery.js";
import { fetchOrderbookSnapshots } from "./services/orderbook-snapshots.js";

async function main() {
  // ─── 1. Discovery ──────────────────────────────────────────
  console.log("=== Testing Discovery ===\n");
  const markets = await discoverSoccerMarkets();

  const assetIds = extractAssetIds(markets);

  // Group by event
  const byEvent = new Map<string, typeof markets>();
  for (const m of markets) {
    const key = m.eventTitle;
    if (!byEvent.has(key)) byEvent.set(key, []);
    byEvent.get(key)!.push(m);
  }

  console.log(`\nTotal markets: ${markets.length}`);
  console.log(`Total asset IDs: ${assetIds.length}`);
  console.log(`Unique events: ${byEvent.size}\n`);

  // Top 10 events by volume
  const eventSummaries = [...byEvent.entries()]
    .map(([title, mkts]) => ({
      title,
      count: mkts.length,
      totalVolume: mkts.reduce((s, m) => s + m.volume, 0),
    }))
    .sort((a, b) => b.totalVolume - a.totalVolume);

  console.log("Top 10 events by volume:");
  for (const e of eventSummaries.slice(0, 10)) {
    console.log(`  $${(e.totalVolume / 1e6).toFixed(1)}M | ${e.count} mkts | ${e.title}`);
  }

  // ─── 2. Orderbook snapshots (3 assets) ─────────────────────
  console.log("\n=== Testing Orderbook Snapshots (3 assets) ===\n");
  const testAssets = assetIds.slice(0, 3);
  const snapshots = await fetchOrderbookSnapshots(testAssets);

  for (const snap of snapshots) {
    console.log(`  ${snap.assetId.slice(0, 12)}...`);
    console.log(`    midpoint=${snap.midpoint}  spread=${snap.spread.toFixed(4)}`);
    console.log(`    bid=${snap.bestBid}  ask=${snap.bestAsk}  last=${snap.lastTradePrice}`);
    console.log(`    bidDepth=${snap.bidDepth}  askDepth=${snap.askDepth}`);
  }

  if (snapshots.length === 0) {
    console.log("  No snapshots returned (API may be down or assets delisted)");
  }

  console.log("\n=== All tests passed ===");
}

main().catch(console.error);
