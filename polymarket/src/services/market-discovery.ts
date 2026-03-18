/**
 * Market discovery — finds active soccer moneyline markets on Polymarket
 * via the Gamma API, groups them into 1X2 matches, resolves team names
 * to MSI canonical names, and links to fixture_ids.
 *
 * Only keeps matches that resolve to existing UCL fixtures in Supabase.
 * No synthetic fixtures — if we can't match it, we skip it.
 */
import { GAMMA_BASE } from "../config.js";
import { pfetch } from "../fetch.js";
import { log } from "../logger.js";
import type {
  GammaEventResponse,
  GroupedMatch,
  DiscoveryResult,
} from "../types.js";
import {
  groupEventMarkets,
  resolveGroupedMatch,
  buildAssetIndex,
} from "./match-grouper.js";
import { refreshFixtureCache } from "./team-resolver.js";

// ─── Fetch all soccer events from Gamma API ─────────────────

async function fetchSoccerEvents(): Promise<GammaEventResponse[]> {
  const allEvents: GammaEventResponse[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const url = `${GAMMA_BASE}/events?active=true&closed=false&tag_slug=soccer&limit=${limit}&offset=${offset}`;

    try {
      const res = await pfetch(url);
      if (!res.ok) {
        log.warn(`Gamma API returned ${res.status} at offset ${offset}`);
        break;
      }

      const events = (await res.json()) as GammaEventResponse[];
      if (!events || events.length === 0) break;

      allEvents.push(...events);

      if (events.length < limit) break;
      offset += limit;

      // Rate limit between pages
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      log.error(
        "Gamma API fetch error:",
        err instanceof Error ? err.message : err
      );
      break;
    }
  }

  return allEvents;
}

// ─── Discover and resolve moneyline matches ─────────────────

export async function discoverMoneylineMatches(): Promise<DiscoveryResult> {
  const startTime = Date.now();
  log.info("Starting market discovery...");

  // Refresh cached fixtures for all tracked leagues (1 query)
  await refreshFixtureCache();

  const events = await fetchSoccerEvents();
  log.info(`Fetched ${events.length} soccer events from Gamma API`);

  // Group each event's moneyline markets into 1X2 triplets
  const groupedRaw: NonNullable<ReturnType<typeof groupEventMarkets>>[] = [];

  for (const event of events) {
    const grouped = groupEventMarkets(event);
    if (grouped) {
      groupedRaw.push(grouped);
    }
  }

  log.info(
    `Found ${groupedRaw.length} moneyline match events (out of ${events.length} total)`
  );

  // Resolve team names and fixture IDs — all in-memory, no DB queries
  // Only keeps matches that resolve to an existing tracked fixture
  const matches: GroupedMatch[] = [];
  let skipped = 0;

  for (const g of groupedRaw) {
    const resolved = resolveGroupedMatch(g);
    if (resolved) {
      matches.push(resolved);
    } else {
      skipped++;
    }
  }

  // Build reverse index: asset_id → { match, leg }
  const assetIndex = buildAssetIndex(matches);

  // Extract all Yes-side asset IDs for WS subscription
  const allAssetIds = matches.flatMap((m) => [
    m.homeAssetId,
    m.drawAssetId,
    m.awayAssetId,
  ]);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  log.info(
    `Discovery complete in ${elapsed}s: ${matches.length} matches tracked, ` +
      `${skipped} unmatched skipped, ${allAssetIds.length} asset IDs`
  );

  // Log each tracked match for visibility
  for (const m of matches) {
    log.info(
      `  → ${m.homeTeamCanonical} vs ${m.awayTeamCanonical} (fixture ${m.fixtureId})`
    );
  }

  return { matches, assetIndex, allAssetIds };
}
