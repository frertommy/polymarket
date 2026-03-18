import type {
  GammaEventResponse,
  GammaMarketNested,
  GroupedMatch,
  AssetEntry,
} from "../types.js";
import { resolveTeamName, lookupFixtureId } from "./team-resolver.js";
import { log } from "../logger.js";

// ─── Parse event title into home/away team names ────────────

const VS_REGEX = /^(.+?)\s+vs\.?\s+(.+?)$/i;

function parseEventTitle(title: string): { home: string; away: string } | null {
  const match = title.match(VS_REGEX);
  if (!match) return null;
  return { home: match[1].trim(), away: match[2].trim() };
}

// ─── Safe JSON parse ────────────────────────────────────────

function safeJsonParse<T>(str: string, fallback: T): T {
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}

// ─── Group an event's 3 moneyline markets into one match ────

/**
 * Takes a Gamma event and extracts the 3 moneyline legs (home/draw/away).
 * Returns null if the event doesn't have exactly 3 moneyline markets.
 */
export function groupEventMarkets(
  event: GammaEventResponse
): {
  homeTeamRaw: string;
  awayTeamRaw: string;
  negRiskMarketId: string;
  gameStartTime: string;
  homeAssetId: string;
  drawAssetId: string;
  awayAssetId: string;
  homeYesPrice: number;
  drawYesPrice: number;
  awayYesPrice: number;
} | null {
  // Filter to moneyline markets only
  const moneylineMarkets = event.markets.filter(
    (m) =>
      m.sportsMarketType === "moneyline" &&
      !m.closed &&
      m.enableOrderBook &&
      m.negRisk
  );

  if (moneylineMarkets.length !== 3) return null;

  // Parse team names from event title
  const teams = parseEventTitle(event.title);
  if (!teams) return null;

  // Find the negRiskMarketID (shared across all 3)
  const negRiskMarketId = moneylineMarkets[0].negRiskMarketID;
  if (!negRiskMarketId) return null;

  // Get gameStartTime from any market
  const gameStartTime =
    moneylineMarkets[0].gameStartTime ?? new Date().toISOString();

  // Classify each market as home, draw, or away
  let homeMarket: GammaMarketNested | null = null;
  let drawMarket: GammaMarketNested | null = null;
  let awayMarket: GammaMarketNested | null = null;

  for (const m of moneylineMarkets) {
    const title = (m.groupItemTitle ?? "").toLowerCase();
    const question = (m.question ?? "").toLowerCase();

    if (title.includes("draw") || question.includes("draw")) {
      drawMarket = m;
    } else if (m.groupItemThreshold === "0") {
      homeMarket = m;
    } else if (m.groupItemThreshold === "2") {
      awayMarket = m;
    }
  }

  // If threshold-based assignment didn't work, use name matching
  if (!homeMarket || !awayMarket) {
    const homeNorm = teams.home.toLowerCase();
    const awayNorm = teams.away.toLowerCase();

    for (const m of moneylineMarkets) {
      if (m === drawMarket) continue;
      const title = (m.groupItemTitle ?? "").toLowerCase();
      const question = (m.question ?? "").toLowerCase();

      if (title.includes(homeNorm) || question.includes(homeNorm)) {
        homeMarket = m;
      } else if (title.includes(awayNorm) || question.includes(awayNorm)) {
        awayMarket = m;
      }
    }
  }

  // Final fallback: assign remaining non-draw markets by position
  if (!homeMarket || !awayMarket) {
    const nonDraw = moneylineMarkets.filter((m) => m !== drawMarket);
    if (nonDraw.length === 2) {
      homeMarket = homeMarket ?? nonDraw[0];
      awayMarket = awayMarket ?? nonDraw[1];
    }
  }

  if (!homeMarket || !drawMarket || !awayMarket) {
    log.debug(`Could not classify all 3 legs for event: ${event.title}`);
    return null;
  }

  // Extract Yes-side clobTokenId (first element) and Yes price
  const homeClobIds = safeJsonParse<string[]>(homeMarket.clobTokenIds, []);
  const drawClobIds = safeJsonParse<string[]>(drawMarket.clobTokenIds, []);
  const awayClobIds = safeJsonParse<string[]>(awayMarket.clobTokenIds, []);

  if (!homeClobIds[0] || !drawClobIds[0] || !awayClobIds[0]) return null;

  const homePrices = safeJsonParse<string[]>(homeMarket.outcomePrices, []);
  const drawPrices = safeJsonParse<string[]>(drawMarket.outcomePrices, []);
  const awayPrices = safeJsonParse<string[]>(awayMarket.outcomePrices, []);

  return {
    homeTeamRaw: teams.home,
    awayTeamRaw: teams.away,
    negRiskMarketId,
    gameStartTime,
    homeAssetId: homeClobIds[0],
    drawAssetId: drawClobIds[0],
    awayAssetId: awayClobIds[0],
    homeYesPrice: parseFloat(homePrices[0] ?? "0"),
    drawYesPrice: parseFloat(drawPrices[0] ?? "0"),
    awayYesPrice: parseFloat(awayPrices[0] ?? "0"),
  };
}

// ─── Resolve grouped event to a full GroupedMatch ───────────

/**
 * Resolve a grouped event to a full GroupedMatch.
 * Returns null if the match doesn't exist in the matches table (UCL only).
 * No synthetic fixtures — we only track matches we can compare against bookmaker data.
 */
export function resolveGroupedMatch(
  grouped: ReturnType<typeof groupEventMarkets> & {}
): GroupedMatch | null {
  const homeCanonical = resolveTeamName(grouped.homeTeamRaw);
  const awayCanonical = resolveTeamName(grouped.awayTeamRaw);

  // Look up in cached UCL fixtures (in-memory, no DB query)
  const fixtureId = lookupFixtureId(
    homeCanonical,
    awayCanonical,
    grouped.gameStartTime
  );

  // Skip if no matching fixture — we only want UCL matches
  if (fixtureId === null) {
    return null;
  }

  return {
    negRiskMarketId: grouped.negRiskMarketId,
    fixtureId,
    homeTeamRaw: grouped.homeTeamRaw,
    awayTeamRaw: grouped.awayTeamRaw,
    homeTeamCanonical: homeCanonical,
    awayTeamCanonical: awayCanonical,
    gameStartTime: grouped.gameStartTime,
    homeAssetId: grouped.homeAssetId,
    drawAssetId: grouped.drawAssetId,
    awayAssetId: grouped.awayAssetId,
    homeYesPrice: grouped.homeYesPrice,
    drawYesPrice: grouped.drawYesPrice,
    awayYesPrice: grouped.awayYesPrice,
    lastWrittenHome: 0,
    lastWrittenDraw: 0,
    lastWrittenAway: 0,
    lastWriteTime: 0,
  };
}

// ─── Build reverse index: asset_id → match + leg ────────────

export function buildAssetIndex(
  matches: GroupedMatch[]
): Map<string, AssetEntry> {
  const index = new Map<string, AssetEntry>();
  for (const match of matches) {
    index.set(match.homeAssetId, { match, leg: "home" });
    index.set(match.drawAssetId, { match, leg: "draw" });
    index.set(match.awayAssetId, { match, leg: "away" });
  }
  return index;
}
