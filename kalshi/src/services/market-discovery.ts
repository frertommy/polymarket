/**
 * Kalshi soccer market discovery — finds active soccer markets via public REST API.
 * No auth required for GET endpoints.
 *
 * Kalshi structure: Series → Events → Markets
 *   Series = "KXEPL" (Premier League)
 *   Event  = "KXEPLGAME-26MAR22TOTARS" (Tottenham vs Arsenal)
 *   Market = "KXEPLGAME-26MAR22TOTARS-TOT" (Tottenham to win)
 */
import { KALSHI_BASE, SOCCER_SERIES } from "../config.js";
import { log } from "../logger.js";

export interface KalshiMarket {
  ticker: string;
  eventTicker: string;
  seriesTicker: string;
  title: string;
  subtitle: string;
  yesAsk: number;
  yesBid: number;
  noAsk: number;
  noBid: number;
  lastPrice: number;
  volume: number;
  openInterest: number;
  status: string;
  closeTime: string;
}

export interface KalshiEvent {
  eventTicker: string;
  seriesTicker: string;
  title: string;
  category: string;
  markets: KalshiMarket[];
}

interface KalshiMarketsResponse {
  markets: {
    ticker: string;
    event_ticker: string;
    series_ticker: string;
    title: string;
    subtitle: string;
    yes_ask: number;
    yes_bid: number;
    no_ask: number;
    no_bid: number;
    last_price: number;
    volume: number;
    open_interest: number;
    status: string;
    close_time: string;
  }[];
  cursor: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch all active markets for a given series ticker.
 */
async function fetchSeriesMarkets(seriesTicker: string): Promise<KalshiMarket[]> {
  const markets: KalshiMarket[] = [];
  let cursor = "";

  while (true) {
    const params = new URLSearchParams({
      series_ticker: seriesTicker,
      status: "open",
      limit: "200",
    });
    if (cursor) params.set("cursor", cursor);

    const url = `${KALSHI_BASE}/markets?${params}`;

    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        log.warn(`Kalshi API HTTP ${resp.status} for series ${seriesTicker}`);
        break;
      }

      const data = (await resp.json()) as KalshiMarketsResponse;
      if (!data.markets || data.markets.length === 0) break;

      for (const mkt of data.markets) {
        markets.push({
          ticker: mkt.ticker,
          eventTicker: mkt.event_ticker,
          seriesTicker: mkt.series_ticker,
          title: mkt.title,
          subtitle: mkt.subtitle,
          yesAsk: mkt.yes_ask / 100,   // Kalshi uses cents
          yesBid: mkt.yes_bid / 100,
          noAsk: mkt.no_ask / 100,
          noBid: mkt.no_bid / 100,
          lastPrice: mkt.last_price / 100,
          volume: mkt.volume,
          openInterest: mkt.open_interest,
          status: mkt.status,
          closeTime: mkt.close_time,
        });
      }

      if (!data.cursor || data.markets.length < 200) break;
      cursor = data.cursor;
      await sleep(200);
    } catch (err) {
      log.warn(`Kalshi ${seriesTicker} fetch failed:`, err instanceof Error ? err.message : err);
      break;
    }
  }

  return markets;
}

/**
 * Discover all active soccer markets across all configured series.
 */
export async function discoverSoccerMarkets(): Promise<KalshiMarket[]> {
  const startTime = Date.now();
  log.info("Discovering Kalshi soccer markets...");

  const allMarkets: KalshiMarket[] = [];

  for (let i = 0; i < SOCCER_SERIES.length; i++) {
    const series = SOCCER_SERIES[i];
    const markets = await fetchSeriesMarkets(series);
    allMarkets.push(...markets);
    log.info(`  ${series}: ${markets.length} open markets`);

    if (i < SOCCER_SERIES.length - 1) await sleep(300);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.info(`Found ${allMarkets.length} Kalshi soccer markets in ${elapsed}s`);

  return allMarkets;
}

/**
 * Get unique market tickers for orderbook polling.
 */
export function extractTickers(markets: KalshiMarket[]): string[] {
  return markets.map((m) => m.ticker);
}
