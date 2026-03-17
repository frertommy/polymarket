/**
 * Supabase persistence for Polymarket data.
 * Writes to: polymarket_markets, trades, orderbook_snapshots
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_KEY } from "../config.js";
import { log } from "../logger.js";
import type { SoccerMarket } from "./market-discovery.js";
import type { TradeEvent } from "./ws-streamer.js";
import type { OrderbookSnapshot } from "./orderbook-snapshots.js";

let supabase: SupabaseClient;

export function initSupabase(): SupabaseClient {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  log.info("Supabase client initialized");
  return supabase;
}

// ─── Markets ────────────────────────────────────────────────

export async function upsertMarkets(markets: SoccerMarket[]): Promise<void> {
  if (markets.length === 0) return;

  const rows = markets.map((m) => ({
    condition_id: m.conditionId,
    question_id: m.questionId,
    slug: m.slug,
    question: m.question,
    outcomes: m.outcomes,
    clob_token_ids: m.clobTokenIds,
    active: m.active,
    volume: m.volume,
    end_date: m.endDate,
    tags: m.tags,
    event_title: m.eventTitle,
    event_slug: m.eventSlug,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from("polymarket_markets")
    .upsert(rows, { onConflict: "condition_id" });

  if (error) {
    log.error("Failed to upsert polymarket_markets:", error.message);
  } else {
    log.info(`Upserted ${rows.length} polymarket markets`);
  }
}

// ─── Trades ─────────────────────────────────────────────────

const tradeBatch: TradeEvent[] = [];
const TRADE_BATCH_SIZE = 50;

export function bufferTrade(trade: TradeEvent): void {
  tradeBatch.push(trade);
  if (tradeBatch.length >= TRADE_BATCH_SIZE) {
    flushTrades().catch((err) =>
      log.error("Trade flush failed:", err instanceof Error ? err.message : err)
    );
  }
}

export async function flushTrades(): Promise<void> {
  if (tradeBatch.length === 0) return;

  const rows = tradeBatch.splice(0, tradeBatch.length).map((t) => ({
    platform: "polymarket",
    asset_id: t.assetId,
    market: t.market,
    price: t.price,
    size: t.size,
    side: t.side,
    transaction_hash: t.transactionHash,
    trade_timestamp: t.timestamp,
  }));

  const { error } = await supabase.from("trades").insert(rows);

  if (error) {
    log.error(`Failed to insert ${rows.length} trades:`, error.message);
  } else {
    log.debug(`Flushed ${rows.length} trades to Supabase`);
  }
}

// ─── Orderbook snapshots ────────────────────────────────────

export async function storeSnapshots(snapshots: OrderbookSnapshot[]): Promise<void> {
  if (snapshots.length === 0) return;

  const rows = snapshots.map((s) => ({
    platform: "polymarket",
    asset_id: s.assetId,
    midpoint: s.midpoint,
    spread: s.spread,
    best_bid: s.bestBid,
    best_ask: s.bestAsk,
    last_price: s.lastTradePrice,
    bid_depth: s.bidDepth,
    ask_depth: s.askDepth,
  }));

  const { error } = await supabase.from("orderbook_snapshots").insert(rows);

  if (error) {
    log.error(`Failed to insert ${rows.length} snapshots:`, error.message);
  } else {
    log.debug(`Stored ${rows.length} orderbook snapshots`);
  }
}
