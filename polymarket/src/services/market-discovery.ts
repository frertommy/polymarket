/**
 * Market discovery — finds active soccer markets on Polymarket via the Gamma API.
 * Returns asset IDs (clobTokenIds) that can be passed to the WS streamer.
 *
 * The Gamma API supports tag filtering and is free/no-auth.
 * The CLOB API (/markets) requires paginating 85K+ markets with no search,
 * so we use Gamma for discovery and CLOB for orderbook snapshots.
 */
import { GAMMA_BASE, SOCCER_TAGS, SOCCER_KEYWORDS } from "../config.js";
import { log } from "../logger.js";

export interface SoccerMarket {
  conditionId: string;
  questionId: string;
  slug: string;
  question: string;
  outcomes: string[];
  clobTokenIds: string[];  // asset IDs for WS subscription
  active: boolean;
  volume: number;
  endDate: string;
  tags: string[];
}

interface GammaMarketResponse {
  id: string;
  condition_id: string;
  question_id: string;
  slug: string;
  question: string;
  outcomes: string;          // JSON string: '["Yes","No"]'
  clob_token_ids: string;    // JSON string: '["id1","id2"]'
  active: boolean;
  closed: boolean;
  volume_num: number;
  end_date_iso: string;
  tags: { label: string }[];
  enable_order_book: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isSoccerMarket(market: GammaMarketResponse): boolean {
  // Check tags
  const tagLabels = market.tags?.map((t) => t.label) ?? [];
  if (tagLabels.some((t) => SOCCER_TAGS.includes(t))) return true;

  // Check question text
  const q = market.question.toLowerCase();
  if (SOCCER_KEYWORDS.some((kw) => q.includes(kw))) return true;

  return false;
}

/**
 * Discover all active soccer markets from the Gamma API.
 * Returns markets with their clobTokenIds for WS subscription.
 */
export async function discoverSoccerMarkets(): Promise<SoccerMarket[]> {
  const startTime = Date.now();
  log.info("Discovering soccer markets via Gamma API...");

  const allMarkets: SoccerMarket[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const url = `${GAMMA_BASE}/markets?active=true&closed=false&order=volume_num&ascending=false&limit=${limit}&offset=${offset}`;

    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        log.warn(`Gamma API HTTP ${resp.status} at offset ${offset}`);
        break;
      }

      const data = (await resp.json()) as GammaMarketResponse[];
      if (!data || data.length === 0) break;

      for (const mkt of data) {
        if (!isSoccerMarket(mkt)) continue;
        if (!mkt.enable_order_book) continue;

        let clobTokenIds: string[];
        let outcomes: string[];
        try {
          clobTokenIds = JSON.parse(mkt.clob_token_ids);
          outcomes = JSON.parse(mkt.outcomes);
        } catch {
          continue;
        }

        if (clobTokenIds.length === 0) continue;

        allMarkets.push({
          conditionId: mkt.condition_id,
          questionId: mkt.question_id,
          slug: mkt.slug,
          question: mkt.question,
          outcomes,
          clobTokenIds,
          active: mkt.active,
          volume: mkt.volume_num,
          endDate: mkt.end_date_iso,
          tags: mkt.tags?.map((t) => t.label) ?? [],
        });
      }

      // If we've gone through 5000 markets without finding soccer ones recently,
      // and we already have some, stop (they're sorted by volume desc)
      if (offset > 5000 && allMarkets.length > 0) break;
      if (data.length < limit) break;

      offset += limit;
      await sleep(200); // Rate limit
    } catch (err) {
      log.warn("Gamma API error:", err instanceof Error ? err.message : err);
      break;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.info(`Found ${allMarkets.length} soccer markets in ${elapsed}s`);

  return allMarkets;
}

/**
 * Extract all unique clobTokenIds from a list of soccer markets.
 * These are the asset IDs to subscribe to on the WebSocket.
 */
export function extractAssetIds(markets: SoccerMarket[]): string[] {
  const ids = new Set<string>();
  for (const mkt of markets) {
    for (const id of mkt.clobTokenIds) {
      ids.add(id);
    }
  }
  return [...ids];
}
