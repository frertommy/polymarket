/**
 * Polymarket discovery for 2-outcome sports (NBA, MLB, NHL, Tennis).
 *
 * Unlike soccer (3 separate binary markets per match), these sports use
 * a SINGLE moneyline market with 2 outcomes: ["Team A", "Team B"].
 * clobTokenIds[0] = Team A (home), clobTokenIds[1] = Team B (away).
 * outcomePrices[0] = P(home win), outcomePrices[1] = P(away win).
 */
import { GAMMA_BASE } from "../config.js";
import { log } from "../logger.js";
import type { GammaEvent, TrackedMatch } from "../types.js";

const VS_REGEX = /^(.+?)\s+vs\.?\s+(.+?)$/i;

function safeJsonParse<T>(str: string, fallback: T): T {
  try { return JSON.parse(str) as T; } catch { return fallback; }
}

async function fetchEvents(tag: string): Promise<GammaEvent[]> {
  const all: GammaEvent[] = [];
  let offset = 0;
  while (true) {
    try {
      const res = await fetch(
        `${GAMMA_BASE}/events?active=true&closed=false&tag_slug=${tag}&limit=100&offset=${offset}`
      );
      if (!res.ok) break;
      const events = (await res.json()) as GammaEvent[];
      if (!events || events.length === 0) break;
      all.push(...events);
      if (events.length < 100) break;
      offset += 100;
      await new Promise((r) => setTimeout(r, 200));
    } catch { break; }
  }
  return all;
}

export async function discoverPolymarketMatches(
  sport: string,
  tag: string
): Promise<TrackedMatch[]> {
  const events = await fetchEvents(tag);
  const matches: TrackedMatch[] = [];

  for (const event of events) {
    // Find moneyline market(s)
    const moneyline = event.markets.filter(
      (m) => m.sportsMarketType === "moneyline" && !m.closed && m.enableOrderBook
    );

    if (moneyline.length === 0) continue;

    const teams = event.title.match(VS_REGEX);
    if (!teams) continue;

    const homeTeam = teams[1].trim();
    const awayTeam = teams[2].trim();

    // Case 1: Single market with 2 outcomes (NBA, MLB, NHL, Tennis)
    if (moneyline.length === 1) {
      const m = moneyline[0];
      const outcomes = safeJsonParse<string[]>(m.outcomes, []);
      const prices = safeJsonParse<string[]>(m.outcomePrices, []);
      const clobIds = safeJsonParse<string[]>(m.clobTokenIds, []);

      if (outcomes.length !== 2 || clobIds.length < 2) continue;

      const gameStartTime = m.gameStartTime ?? new Date().toISOString();
      const matchId = `poly_${m.conditionId}`;
      const totalVolume = moneyline.reduce((sum, mk) => sum + (mk.volumeNum || 0), 0);

      matches.push({
        matchId,
        sport,
        source: "polymarket",
        homeTeam,
        awayTeam,
        gameStartTime,
        homeAssetId: clobIds[0], // first outcome = home/player1
        awayAssetId: clobIds[1], // second outcome = away/player2
        homePrice: parseFloat(prices[0] ?? "0"),
        awayPrice: parseFloat(prices[1] ?? "0"),
        lastWrittenHome: 0,
        lastWrittenAway: 0,
        lastWriteTime: 0,
        polymarketEventId: event.id,
        eventTitle: event.title,
        volume: Math.round(totalVolume * 100) / 100,
      });
      continue;
    }

    // Case 2: Two separate binary markets (like soccer without draw)
    if (moneyline.length === 2) {
      const negRiskMarketId = moneyline[0].negRiskMarketID;
      const gameStartTime = moneyline[0].gameStartTime ?? new Date().toISOString();

      let homeMarket = moneyline.find((m) => m.groupItemThreshold === "0") ?? moneyline[0];
      let awayMarket = moneyline.find((m) => m.groupItemThreshold === "1") ?? moneyline[1];

      const homeClobIds = safeJsonParse<string[]>(homeMarket.clobTokenIds, []);
      const awayClobIds = safeJsonParse<string[]>(awayMarket.clobTokenIds, []);
      if (!homeClobIds[0] || !awayClobIds[0]) continue;

      const homePrices = safeJsonParse<string[]>(homeMarket.outcomePrices, []);
      const awayPrices = safeJsonParse<string[]>(awayMarket.outcomePrices, []);

      const totalVolume2 = moneyline.reduce((sum, mk) => sum + (mk.volumeNum || 0), 0);

      matches.push({
        matchId: `poly_${negRiskMarketId || moneyline[0].conditionId}`,
        sport,
        source: "polymarket",
        homeTeam,
        awayTeam,
        gameStartTime,
        homeAssetId: homeClobIds[0],
        awayAssetId: awayClobIds[0],
        homePrice: parseFloat(homePrices[0] ?? "0"),
        awayPrice: parseFloat(awayPrices[0] ?? "0"),
        lastWrittenHome: 0,
        lastWrittenAway: 0,
        lastWriteTime: 0,
        polymarketEventId: event.id,
        eventTitle: event.title,
        volume: Math.round(totalVolume2 * 100) / 100,
      });
    }
  }

  log.info(
    `[${sport}] Polymarket: ${matches.length} moneyline matches from ${events.length} events`
  );
  return matches;
}
