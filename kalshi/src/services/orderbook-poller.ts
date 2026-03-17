/**
 * Kalshi orderbook poller — fetches live orderbook data via public REST API.
 * No auth required for GET /markets/{ticker}/orderbook.
 *
 * Since Kalshi WS requires auth, we poll REST for orderbook snapshots.
 */
import { KALSHI_BASE } from "../config.js";
import { log } from "../logger.js";

export interface KalshiOrderbook {
  ticker: string;
  yesBids: { price: number; quantity: number }[];
  yesAsks: { price: number; quantity: number }[];
  bestYesBid: number;
  bestYesAsk: number;
  spread: number;
  midpoint: number;
  totalBidDepth: number;
  totalAskDepth: number;
  timestamp: string;
}

interface KalshiOrderbookResponse {
  orderbook: {
    yes: [number, number][];  // [price_cents, quantity]
    no: [number, number][];
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch orderbook for a single market ticker.
 */
async function fetchOrderbook(ticker: string): Promise<KalshiOrderbook | null> {
  try {
    const resp = await fetch(`${KALSHI_BASE}/markets/${ticker}/orderbook?depth=10`);
    if (!resp.ok) return null;

    const data = (await resp.json()) as KalshiOrderbookResponse;
    const ob = data.orderbook;
    if (!ob) return null;

    // Yes side: bids (people buying Yes), asks (people selling Yes)
    // Kalshi returns prices in cents
    const yesBids = (ob.yes ?? []).map(([p, q]) => ({
      price: p / 100,
      quantity: q,
    }));
    const yesAsks = (ob.no ?? []).map(([p, q]) => ({
      price: 1 - p / 100,  // No ask = 1 - No price = Yes price
      quantity: q,
    }));

    // Sort: bids descending, asks ascending
    yesBids.sort((a, b) => b.price - a.price);
    yesAsks.sort((a, b) => a.price - b.price);

    const bestBid = yesBids.length > 0 ? yesBids[0].price : 0;
    const bestAsk = yesAsks.length > 0 ? yesAsks[0].price : 0;
    const spread = bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0;
    const midpoint = bestAsk > 0 && bestBid > 0 ? (bestAsk + bestBid) / 2 : 0;

    const totalBidDepth = yesBids.reduce((s, b) => s + b.quantity, 0);
    const totalAskDepth = yesAsks.reduce((s, a) => s + a.quantity, 0);

    return {
      ticker,
      yesBids,
      yesAsks,
      bestYesBid: bestBid,
      bestYesAsk: bestAsk,
      spread: Math.round(spread * 10000) / 10000,
      midpoint: Math.round(midpoint * 10000) / 10000,
      totalBidDepth,
      totalAskDepth,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    log.debug(`Orderbook fetch failed for ${ticker}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Fetch orderbooks for a batch of tickers.
 * Processes 5 at a time to be respectful of rate limits.
 */
export async function fetchOrderbooks(
  tickers: string[]
): Promise<KalshiOrderbook[]> {
  const startTime = Date.now();
  const orderbooks: KalshiOrderbook[] = [];
  const concurrency = 5;

  for (let i = 0; i < tickers.length; i += concurrency) {
    const batch = tickers.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(fetchOrderbook));

    for (const ob of results) {
      if (ob) orderbooks.push(ob);
    }

    if (i + concurrency < tickers.length) {
      await sleep(100);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.info(`Fetched ${orderbooks.length}/${tickers.length} Kalshi orderbooks in ${elapsed}s`);

  return orderbooks;
}
