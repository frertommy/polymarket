/**
 * WebSocket streamer — connects to Polymarket CLOB WS via @nevuamarkets/poly-websockets.
 * Streams real-time trades, orderbook updates, and price changes for soccer markets.
 *
 * Uses: wss://ws-subscriptions-clob.polymarket.com/ws/market
 * No auth required.
 */
import { WSSubscriptionManager } from "@nevuamarkets/poly-websockets";
import type { LastTradePriceEvent, PolymarketPriceUpdateEvent } from "@nevuamarkets/poly-websockets";
import { log } from "../logger.js";

export interface TradeEvent {
  assetId: string;
  market: string;
  price: number;
  size: number;
  side: string;
  timestamp: string;
  transactionHash: string;
}

export interface PriceUpdate {
  assetId: string;
  price: number;
  midpoint: number;
  spread: number;
}

interface StreamerCallbacks {
  onTrade?: (trade: TradeEvent) => void;
  onPriceUpdate?: (update: PriceUpdate) => void;
  onError?: (err: Error) => void;
}

export class PolymarketStreamer {
  private manager: WSSubscriptionManager | null = null;
  private subscribedAssets = new Set<string>();
  private callbacks: StreamerCallbacks;
  private tradeCount = 0;

  constructor(callbacks: StreamerCallbacks = {}) {
    this.callbacks = callbacks;
  }

  start(): void {
    log.info("Starting Polymarket WS streamer...");

    this.manager = new WSSubscriptionManager({
      onLastTradePrice: async (events: LastTradePriceEvent[]) => {
        for (const event of events) {
          this.tradeCount++;
          const trade: TradeEvent = {
            assetId: String(event.asset_id ?? ""),
            market: String(event.market ?? ""),
            price: parseFloat(String(event.price ?? "0")),
            size: parseFloat(String(event.size ?? "0")),
            side: String(event.side ?? ""),
            timestamp: String(event.timestamp ?? new Date().toISOString()),
            transactionHash: String(event.transaction_hash ?? ""),
          };

          log.debug(
            `Trade: ${trade.side} ${trade.size} @ ${trade.price} [${trade.assetId.slice(0, 8)}...]`
          );

          this.callbacks.onTrade?.(trade);
        }
      },

      onPolymarketPriceUpdate: async (events: PolymarketPriceUpdateEvent[]) => {
        for (const event of events) {
          const update: PriceUpdate = {
            assetId: String(event.asset_id ?? ""),
            price: parseFloat(String(event.price ?? "0")),
            midpoint: parseFloat(String(event.midpoint ?? "0")),
            spread: parseFloat(String(event.spread ?? "0")),
          };

          this.callbacks.onPriceUpdate?.(update);
        }
      },

      onError: async (err: Error) => {
        log.error("WS error:", err.message);
        this.callbacks.onError?.(err);
      },
    });

    log.info("WS streamer connected, waiting for subscriptions...");
  }

  async subscribe(assetIds: string[]): Promise<void> {
    if (!this.manager) {
      log.warn("Streamer not started, call start() first");
      return;
    }

    const newIds = assetIds.filter((id) => !this.subscribedAssets.has(id));
    if (newIds.length === 0) return;

    log.info(`Subscribing to ${newIds.length} new assets (${this.subscribedAssets.size} existing)...`);
    await this.manager.addSubscriptions(newIds);

    for (const id of newIds) {
      this.subscribedAssets.add(id);
    }

    log.info(`Total subscribed assets: ${this.subscribedAssets.size}`);
  }

  async unsubscribe(assetIds: string[]): Promise<void> {
    if (!this.manager) return;

    const toRemove = assetIds.filter((id) => this.subscribedAssets.has(id));
    if (toRemove.length === 0) return;

    await this.manager.removeSubscriptions(toRemove);

    for (const id of toRemove) {
      this.subscribedAssets.delete(id);
    }

    log.info(`Unsubscribed ${toRemove.length} assets, ${this.subscribedAssets.size} remaining`);
  }

  getStats(): { subscribedAssets: number; tradesReceived: number } {
    return {
      subscribedAssets: this.subscribedAssets.size,
      tradesReceived: this.tradeCount,
    };
  }

  async stop(): Promise<void> {
    if (this.manager) {
      await this.manager.clearState();
      this.manager = null;
    }
    this.subscribedAssets.clear();
    log.info(`WS streamer stopped (${this.tradeCount} trades received total)`);
  }
}
