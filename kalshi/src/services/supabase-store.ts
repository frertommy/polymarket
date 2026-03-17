/**
 * Supabase persistence for Kalshi data.
 * Writes to: kalshi_markets, orderbook_snapshots
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_KEY } from "../config.js";
import { log } from "../logger.js";
import type { KalshiMarket } from "./market-discovery.js";
import type { KalshiOrderbook } from "./orderbook-poller.js";

let supabase: SupabaseClient;

export function initSupabase(): SupabaseClient {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  log.info("Supabase client initialized");
  return supabase;
}

// ─── Markets ────────────────────────────────────────────────

export async function upsertMarkets(markets: KalshiMarket[]): Promise<void> {
  if (markets.length === 0) return;

  const rows = markets.map((m) => ({
    ticker: m.ticker,
    event_ticker: m.eventTicker,
    series_ticker: m.seriesTicker,
    title: m.title,
    subtitle: m.subtitle,
    yes_ask: m.yesAsk,
    yes_bid: m.yesBid,
    no_ask: m.noAsk,
    no_bid: m.noBid,
    last_price: m.lastPrice,
    volume: m.volume,
    open_interest: m.openInterest,
    status: m.status,
    close_time: m.closeTime,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from("kalshi_markets")
    .upsert(rows, { onConflict: "ticker" });

  if (error) {
    log.error("Failed to upsert kalshi_markets:", error.message);
  } else {
    log.info(`Upserted ${rows.length} Kalshi markets`);
  }
}

// ─── Orderbook snapshots ────────────────────────────────────

export async function storeOrderbooks(orderbooks: KalshiOrderbook[]): Promise<void> {
  if (orderbooks.length === 0) return;

  const rows = orderbooks.map((ob) => ({
    platform: "kalshi",
    asset_id: ob.ticker,
    midpoint: ob.midpoint,
    spread: ob.spread,
    best_bid: ob.bestYesBid,
    best_ask: ob.bestYesAsk,
    last_price: null,
    bid_depth: ob.totalBidDepth,
    ask_depth: ob.totalAskDepth,
  }));

  const { error } = await supabase.from("orderbook_snapshots").insert(rows);

  if (error) {
    log.error(`Failed to insert ${rows.length} Kalshi snapshots:`, error.message);
  } else {
    log.debug(`Stored ${rows.length} Kalshi orderbook snapshots`);
  }
}
