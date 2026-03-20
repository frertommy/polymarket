/**
 * Kalshi discovery for 2-outcome sports (NBA, MLB, NHL, Tennis).
 * Fetches match-winner events and groups 2 markets per match.
 */
import { KALSHI_BASE, KALSHI_API_KEY } from "../config.js";
import { log } from "../logger.js";
import type { KalshiEvent, KalshiMarket, TrackedMatch } from "../types.js";

const VS_REGEX = /^(.+?)\s+(?:vs\.?|at)\s+(.+?)$/i;

function kalshiFetch(url: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (KALSHI_API_KEY) headers["Authorization"] = `Bearer ${KALSHI_API_KEY}`;
  return fetch(url, { headers });
}

async function fetchSeriesEvents(series: string): Promise<KalshiEvent[]> {
  const all: KalshiEvent[] = [];
  let cursor: string | undefined;
  while (true) {
    let url = `${KALSHI_BASE}/events?series_ticker=${series}&status=open&limit=200`;
    if (cursor) url += `&cursor=${cursor}`;
    try {
      const res = await kalshiFetch(url);
      if (!res.ok) break;
      const data = (await res.json()) as { cursor: string; events: KalshiEvent[] };
      if (!data.events || data.events.length === 0) break;
      all.push(...data.events);
      if (!data.cursor || data.events.length < 200) break;
      cursor = data.cursor;
    } catch { break; }
  }
  return all;
}

async function fetchMarkets(eventTicker: string): Promise<KalshiMarket[]> {
  try {
    const res = await kalshiFetch(
      `${KALSHI_BASE}/markets?event_ticker=${eventTicker}&limit=10`
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { markets: KalshiMarket[] };
    return data.markets ?? [];
  } catch { return []; }
}

export async function discoverKalshiMatches(
  sport: string,
  seriesTickers: string[]
): Promise<TrackedMatch[]> {
  const allEvents: KalshiEvent[] = [];
  for (const series of seriesTickers) {
    const events = await fetchSeriesEvents(series);
    allEvents.push(...events);
    await new Promise((r) => setTimeout(r, 300));
  }

  const matches: TrackedMatch[] = [];
  const CONCURRENCY = 5;

  for (let i = 0; i < allEvents.length; i += CONCURRENCY) {
    const batch = allEvents.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (event) => {
        const markets = await fetchMarkets(event.event_ticker);
        const active = markets.filter((m) => m.status === "active");
        if (active.length !== 2) return null;

        const teams = event.title.match(VS_REGEX);
        if (!teams) return null;

        const gameStartTime =
          active[0].expected_expiration_time ?? new Date().toISOString();

        // Midpoint price
        const mid = (m: KalshiMarket): number => {
          const bid = parseFloat(m.yes_bid_dollars || "0");
          const ask = parseFloat(m.yes_ask_dollars || "0");
          return bid > 0 && ask > 0 ? (bid + ask) / 2 : parseFloat(m.last_price_dollars || "0");
        };

        // Determine home/away from sub_title matching event title order
        const homeTeam = teams[1].trim();
        const awayTeam = teams[2].trim();
        let homeMarket = active.find((m) =>
          homeTeam.toLowerCase().includes(m.yes_sub_title.toLowerCase().slice(0, 5))
        );
        let awayMarket = active.find((m) =>
          awayTeam.toLowerCase().includes(m.yes_sub_title.toLowerCase().slice(0, 5))
        );

        if (!homeMarket || !awayMarket || homeMarket === awayMarket) {
          homeMarket = active[0];
          awayMarket = active[1];
        }

        return {
          matchId: `kalshi_${event.event_ticker}`,
          sport,
          source: "kalshi" as const,
          homeTeam,
          awayTeam,
          gameStartTime,
          homeAssetId: homeMarket.ticker,
          awayAssetId: awayMarket.ticker,
          homePrice: mid(homeMarket),
          awayPrice: mid(awayMarket),
          lastWrittenHome: 0,
          lastWrittenAway: 0,
          lastWriteTime: 0,
        };
      })
    );

    for (const r of results) {
      if (r) matches.push(r);
    }

    if (i + CONCURRENCY < allEvents.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  log.info(
    `[${sport}] Kalshi: ${matches.length} moneyline matches from ${allEvents.length} events`
  );
  return matches;
}
