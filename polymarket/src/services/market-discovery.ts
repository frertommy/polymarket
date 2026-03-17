/**
 * Market discovery — finds active soccer markets on Polymarket via the Gamma API.
 * Returns asset IDs (clobTokenIds) that can be passed to the WS streamer.
 *
 * Uses the /events endpoint with tag_slug=soccer, which returns events with
 * their nested markets. Tags only exist on events, not individual markets.
 */
import { GAMMA_BASE } from "../config.js";
import { log } from "../logger.js";
import { pfetch } from "../fetch.js";

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
  eventTitle: string;
  eventSlug: string;
}

interface GammaMarketNested {
  conditionId: string;
  questionID: string;
  slug: string;
  question: string;
  outcomes: string;           // JSON string: '["Yes","No"]'
  clobTokenIds: string;       // JSON string: '["id1","id2"]'
  active: boolean;
  closed: boolean;
  volumeNum: number;
  endDateIso: string;
  enableOrderBook: boolean;
}

interface GammaEventResponse {
  id: string;
  title: string;
  slug: string;
  tags: { label: string }[];
  markets: GammaMarketNested[];
  volume: number;
  active: boolean;
  closed: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Discover all active soccer markets from the Gamma events API.
 * Fetches /events?tag_slug=soccer which returns events with nested markets.
 */
export async function discoverSoccerMarkets(): Promise<SoccerMarket[]> {
  const startTime = Date.now();
  log.info("Discovering soccer markets via Gamma /events API...");

  const allMarkets: SoccerMarket[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const url = `${GAMMA_BASE}/events?active=true&closed=false&tag_slug=soccer&limit=${limit}&offset=${offset}`;

    try {
      const resp = await pfetch(url);
      if (!resp.ok) {
        log.warn(`Gamma API HTTP ${resp.status} at offset ${offset}`);
        break;
      }

      const events = (await resp.json()) as GammaEventResponse[];
      if (!events || events.length === 0) break;

      for (const event of events) {
        const eventTags = event.tags?.map((t) => t.label) ?? [];

        for (const mkt of event.markets ?? []) {
          if (mkt.closed) continue;
          if (!mkt.enableOrderBook) continue;

          let clobTokenIds: string[];
          let outcomes: string[];
          try {
            clobTokenIds = JSON.parse(mkt.clobTokenIds);
            outcomes = JSON.parse(mkt.outcomes);
          } catch {
            continue;
          }

          if (clobTokenIds.length === 0) continue;

          allMarkets.push({
            conditionId: mkt.conditionId,
            questionId: mkt.questionID,
            slug: mkt.slug,
            question: mkt.question,
            outcomes,
            clobTokenIds,
            active: mkt.active,
            volume: mkt.volumeNum ?? 0,
            endDate: mkt.endDateIso,
            tags: eventTags,
            eventTitle: event.title,
            eventSlug: event.slug,
          });
        }
      }

      if (events.length < limit) break;

      offset += limit;
      await sleep(200); // Rate limit
    } catch (err) {
      log.warn("Gamma API error:", err instanceof Error ? err.message : err);
      break;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.info(`Found ${allMarkets.length} soccer markets across events in ${elapsed}s`);

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
