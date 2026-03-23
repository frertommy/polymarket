/**
 * Market discovery — fetches active match-winner events from Kalshi
 * for all tracked leagues, groups 3 markets per match into 1X2,
 * resolves team names to MSI canonical, links to fixture_ids.
 */
import { KALSHI_BASE, KALSHI_SERIES } from "../config.js";
import { kalshiFetch } from "../fetch.js";
import { log } from "../logger.js";
import type {
  KalshiEvent,
  KalshiMarket,
  GroupedMatch,
  DiscoveryResult,
} from "../types.js";
import {
  refreshFixtureCache,
  resolveTeamName,
  lookupFixtureId,
} from "./team-resolver.js";

// ─── Parse event title into home/away ───────────────────────

const VS_REGEX = /^(.+?)\s+vs\.?\s+(.+?)$/i;

function parseEventTitle(title: string): { home: string; away: string } | null {
  const match = title.match(VS_REGEX);
  if (!match) return null;
  return { home: match[1].trim(), away: match[2].trim() };
}

// ─── Parse date from sub_title like "TOT vs NFO (Mar 22)" ──

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const SUB_TITLE_DATE_RE = /\((\w{3})\s+(\d{1,2})\)/;

function parseSubTitleDate(subTitle: string | undefined): string | null {
  if (!subTitle) return null;
  const m = subTitle.match(SUB_TITLE_DATE_RE);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return null;
  const day = parseInt(m[2], 10);
  const now = new Date();
  const year = now.getFullYear();
  const date = new Date(year, month, day);
  // If the date is more than 2 months in the past, assume next year
  if (date.getTime() < now.getTime() - 60 * 86400000) {
    date.setFullYear(year + 1);
  }
  return date.toISOString();
}

// ─── Fetch events for a single series ───────────────────────

async function fetchSeriesEvents(
  seriesTicker: string
): Promise<KalshiEvent[]> {
  const allEvents: KalshiEvent[] = [];
  let cursor: string | undefined;

  while (true) {
    let url = `${KALSHI_BASE}/events?series_ticker=${seriesTicker}&limit=200`;
    if (cursor) url += `&cursor=${cursor}`;

    try {
      const res = await kalshiFetch(url);
      if (!res.ok) {
        log.warn(`Kalshi API returned ${res.status} for ${seriesTicker}`);
        break;
      }

      const data = (await res.json()) as {
        cursor: string;
        events: KalshiEvent[];
      };
      if (!data.events || data.events.length === 0) break;

      allEvents.push(...data.events);

      if (!data.cursor || data.events.length < 200) break;
      cursor = data.cursor;
    } catch (err) {
      log.error(
        `Kalshi fetch error (${seriesTicker}):`,
        err instanceof Error ? err.message : err
      );
      break;
    }
  }

  return allEvents;
}

// ─── Fetch markets for an event ─────────────────────────────

async function fetchEventMarkets(
  eventTicker: string
): Promise<KalshiMarket[]> {
  const url = `${KALSHI_BASE}/markets?event_ticker=${eventTicker}&limit=50`;
  try {
    const res = await kalshiFetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as { markets: KalshiMarket[] };
    return data.markets ?? [];
  } catch {
    return [];
  }
}

// ─── Group 3 markets into 1X2 ───────────────────────────────

function groupMarkets(
  event: KalshiEvent,
  markets: KalshiMarket[]
): GroupedMatch | null {
  // Only active events with 3 mutually exclusive markets
  const active = markets.filter((m) => m.status === "active");
  if (active.length !== 3) return null;

  const teams = parseEventTitle(event.title);
  if (!teams) return null;

  let homeMarket: KalshiMarket | null = null;
  let drawMarket: KalshiMarket | null = null;
  let awayMarket: KalshiMarket | null = null;

  for (const m of active) {
    const sub = (m.yes_sub_title ?? "").toLowerCase();
    if (sub === "tie" || sub === "draw") {
      drawMarket = m;
    } else if (sub.includes(teams.home.toLowerCase().slice(0, 5))) {
      homeMarket = m;
    } else if (sub.includes(teams.away.toLowerCase().slice(0, 5))) {
      awayMarket = m;
    }
  }

  // Fallback: assign non-draw markets by position
  if (!homeMarket || !awayMarket) {
    const nonDraw = active.filter((m) => m !== drawMarket);
    if (nonDraw.length === 2 && drawMarket) {
      // Use ticker suffix to determine order — ticker ends with team code
      const homeCode = event.sub_title?.split(" vs ")[0]?.trim();
      if (homeCode) {
        const first = nonDraw[0];
        const second = nonDraw[1];
        if (first.ticker.endsWith(`-${homeCode}`)) {
          homeMarket = first;
          awayMarket = second;
        } else {
          homeMarket = second;
          awayMarket = first;
        }
      } else {
        homeMarket = nonDraw[0];
        awayMarket = nonDraw[1];
      }
    }
  }

  if (!homeMarket || !drawMarket || !awayMarket) return null;

  // Get midpoint price (avg of bid/ask) or last_price
  const midpoint = (m: KalshiMarket): number => {
    const bid = parseFloat(m.yes_bid_dollars || "0");
    const ask = parseFloat(m.yes_ask_dollars || "0");
    if (bid > 0 && ask > 0) return (bid + ask) / 2;
    return parseFloat(m.last_price_dollars || "0");
  };

  const gameStartTime =
    homeMarket.expected_expiration_time ?? new Date().toISOString();

  // Resolve team names
  const homeCanonical = resolveTeamName(teams.home);
  const awayCanonical = resolveTeamName(teams.away);

  // Look up fixture_id
  const fixtureId = lookupFixtureId(homeCanonical, awayCanonical, gameStartTime);
  if (fixtureId === null) return null; // not a tracked fixture

  return {
    eventTicker: event.event_ticker,
    fixtureId,
    homeTeamRaw: teams.home,
    awayTeamRaw: teams.away,
    homeTeamCanonical: homeCanonical,
    awayTeamCanonical: awayCanonical,
    gameStartTime,
    homeMarketTicker: homeMarket.ticker,
    drawMarketTicker: drawMarket.ticker,
    awayMarketTicker: awayMarket.ticker,
    homeYesPrice: midpoint(homeMarket),
    drawYesPrice: midpoint(drawMarket),
    awayYesPrice: midpoint(awayMarket),
    lastWrittenHome: 0,
    lastWrittenDraw: 0,
    lastWrittenAway: 0,
    lastWriteTime: 0,
  };
}

// ─── Main discovery function ────────────────────────────────

export async function discoverMatches(): Promise<DiscoveryResult> {
  const startTime = Date.now();
  log.info("Starting Kalshi market discovery...");

  // Refresh fixture cache (1 query)
  await refreshFixtureCache();

  // Fetch events for all series (sequentially to avoid 429)
  const allEvents: KalshiEvent[] = [];
  for (const series of KALSHI_SERIES) {
    const events = await fetchSeriesEvents(series);
    allEvents.push(...events);
    await new Promise((r) => setTimeout(r, 300)); // rate limit
  }
  log.info(
    `Fetched ${allEvents.length} Kalshi match events across ${KALSHI_SERIES.length} series`
  );

  // Pre-filter: only fetch markets for events whose team names
  // exist in our fixture cache (saves hundreds of API calls).
  // We use a wide date window here since we don't have the exact
  // match date yet — groupMarkets() will do the precise date check.
  const candidateEvents: KalshiEvent[] = [];
  for (const event of allEvents) {
    const teams = parseEventTitle(event.title);
    if (!teams) continue;
    const homeCanonical = resolveTeamName(teams.home);
    const awayCanonical = resolveTeamName(teams.away);
    // Parse actual match date from sub_title (e.g. "TOT vs NFO (Mar 22)")
    const eventDate = parseSubTitleDate(event.sub_title) ?? new Date().toISOString();
    const fixtureId = lookupFixtureId(
      homeCanonical,
      awayCanonical,
      eventDate
    );
    if (fixtureId !== null) {
      candidateEvents.push(event);
    }
  }

  log.info(
    `${candidateEvents.length} events match tracked fixtures (${allEvents.length - candidateEvents.length} skipped)`
  );

  // Fetch markets only for candidate events (concurrency-limited)
  const matches: GroupedMatch[] = [];
  let skipped = 0;
  const CONCURRENCY = 5;

  for (let i = 0; i < candidateEvents.length; i += CONCURRENCY) {
    const batch = candidateEvents.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (event) => {
        const markets = await fetchEventMarkets(event.event_ticker);
        return groupMarkets(event, markets);
      })
    );

    for (const r of results) {
      if (r) {
        matches.push(r);
      } else {
        skipped++;
      }
    }

    if (i + CONCURRENCY < candidateEvents.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const allMarketTickers = matches.flatMap((m) => [
    m.homeMarketTicker,
    m.drawMarketTicker,
    m.awayMarketTicker,
  ]);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.info(
    `Discovery complete in ${elapsed}s: ${matches.length} matches tracked, ` +
      `${skipped} unmatched skipped, ${allMarketTickers.length} market tickers`
  );

  for (const m of matches) {
    log.info(
      `  → ${m.homeTeamCanonical} vs ${m.awayTeamCanonical} (fixture ${m.fixtureId})`
    );
  }

  return { matches, allMarketTickers };
}
