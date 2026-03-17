/**
 * Orderbook snapshots — periodic REST polling via CLOB API for soccer markets.
 * Supplements the WS stream with full orderbook depth + midpoint/spread data.
 *
 * Uses: https://clob.polymarket.com (L0, no auth)
 */
import { CLOB_BASE } from "../config.js";
import { log } from "../logger.js";
import { pfetch } from "../fetch.js";

export interface OrderbookSnapshot {
  assetId: string;
  midpoint: number;
  spread: number;
  bestBid: number;
  bestAsk: number;
  lastTradePrice: number;
  bidDepth: number;   // total size across all bid levels
  askDepth: number;   // total size across all ask levels
  timestamp: string;
}

interface ClobBookResponse {
  market: string;
  asset_id: string;
  bids: { price: string; size: string }[];
  asks: { price: string; size: string }[];
  hash: string;
  timestamp: string;
}

interface ClobMidpointResponse {
  mid: string;
}

interface ClobLastTradeResponse {
  price: string;
  side: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch orderbook snapshot for a single asset from CLOB REST API.
 */
async function fetchSnapshot(assetId: string): Promise<OrderbookSnapshot | null> {
  try {
    // Fetch book + midpoint + last trade in parallel
    const [bookResp, midResp, lastResp] = await Promise.all([
      pfetch(`${CLOB_BASE}/book?token_id=${assetId}`),
      pfetch(`${CLOB_BASE}/midpoint?token_id=${assetId}`),
      pfetch(`${CLOB_BASE}/last-trade-price?token_id=${assetId}`),
    ]);

    if (!bookResp.ok) return null;

    const book = (await bookResp.json()) as ClobBookResponse;
    const mid = midResp.ok ? (await midResp.json()) as ClobMidpointResponse : null;
    const last = lastResp.ok ? (await lastResp.json()) as ClobLastTradeResponse : null;

    const bids = book.bids ?? [];
    const asks = book.asks ?? [];

    const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : 0;
    const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : 0;
    const bidDepth = bids.reduce((sum, b) => sum + parseFloat(b.size), 0);
    const askDepth = asks.reduce((sum, a) => sum + parseFloat(a.size), 0);

    return {
      assetId,
      midpoint: mid ? parseFloat(mid.mid) : 0,
      spread: bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0,
      bestBid,
      bestAsk,
      lastTradePrice: last ? parseFloat(last.price) : 0,
      bidDepth: Math.round(bidDepth * 100) / 100,
      askDepth: Math.round(askDepth * 100) / 100,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    log.debug(`Snapshot failed for ${assetId.slice(0, 8)}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Fetch orderbook snapshots for a batch of assets.
 * Processes 5 at a time to avoid hammering the API.
 */
export async function fetchOrderbookSnapshots(
  assetIds: string[]
): Promise<OrderbookSnapshot[]> {
  const startTime = Date.now();
  const snapshots: OrderbookSnapshot[] = [];
  const concurrency = 5;

  for (let i = 0; i < assetIds.length; i += concurrency) {
    const batch = assetIds.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(fetchSnapshot));

    for (const snap of results) {
      if (snap) snapshots.push(snap);
    }

    // Small delay between batches
    if (i + concurrency < assetIds.length) {
      await sleep(100);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.info(`Fetched ${snapshots.length}/${assetIds.length} orderbook snapshots in ${elapsed}s`);

  return snapshots;
}
