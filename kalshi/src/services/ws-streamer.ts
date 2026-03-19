/**
 * Kalshi WebSocket streamer — connects to Kalshi WS with RSA-PSS auth,
 * subscribes to ticker channel for real-time price updates.
 *
 * Auth flow:
 *   1. Sign "timestamp + GET + /trade-api/ws/v2" with RSA-PSS SHA256
 *   2. Connect with KALSHI-ACCESS-KEY, KALSHI-ACCESS-SIGNATURE, KALSHI-ACCESS-TIMESTAMP headers
 *   3. Subscribe to "ticker" channel for each market ticker
 */
import { createSign } from "node:crypto";
import { WebSocket } from "ws";
import { KALSHI_WS_URL, KALSHI_API_KEY, KALSHI_PRIVATE_KEY } from "../config.js";
import { log } from "../logger.js";

// ─── RSA-PSS signing ────────────────────────────────────────

function signMessage(message: string, privateKeyPem: string): string {
  const sign = createSign("RSA-SHA256");
  sign.update(message);
  sign.end();
  const signature = sign.sign(
    {
      key: privateKeyPem,
      padding: 6, // RSA_PKCS1_PSS_PADDING
      saltLength: 32, // SHA256 digest length
    },
    "base64"
  );
  return signature;
}

function createAuthHeaders(): Record<string, string> {
  const timestamp = String(Date.now());
  const message = timestamp + "GET" + "/trade-api/ws/v2";
  const signature = signMessage(message, KALSHI_PRIVATE_KEY);

  return {
    "KALSHI-ACCESS-KEY": KALSHI_API_KEY,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
  };
}

// ─── Ticker event type ──────────────────────────────────────

export interface TickerUpdate {
  marketTicker: string;
  yesBid: number;
  yesAsk: number;
  lastPrice: number;
}

interface StreamerCallbacks {
  onTicker?: (update: TickerUpdate) => void;
  onError?: (err: Error) => void;
}

// ─── WebSocket streamer ─────────────────────────────────────

export class KalshiStreamer {
  private ws: WebSocket | null = null;
  private subscribedTickers = new Set<string>();
  private callbacks: StreamerCallbacks;
  private tickerCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private alive = true;
  private msgId = 1;

  constructor(callbacks: StreamerCallbacks = {}) {
    this.callbacks = callbacks;
  }

  start(): void {
    if (!KALSHI_API_KEY || !KALSHI_PRIVATE_KEY) {
      log.warn("Kalshi WS: missing API key or private key, falling back to REST polling");
      return;
    }
    this.connect();
  }

  private connect(): void {
    if (!this.alive) return;

    log.info("Connecting to Kalshi WebSocket...");

    const headers = createAuthHeaders();
    this.ws = new WebSocket(KALSHI_WS_URL, { headers });

    this.ws.on("open", () => {
      log.info("Kalshi WS connected");

      // Re-subscribe to all tickers
      if (this.subscribedTickers.size > 0) {
        this.sendSubscribe([...this.subscribedTickers]);
      }
    });

    this.ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch {
        // ignore parse errors
      }
    });

    this.ws.on("error", (err: Error) => {
      log.error("Kalshi WS error:", err.message);
      this.callbacks.onError?.(err);
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      log.warn(`Kalshi WS closed: ${code} ${reason.toString()}`);
      this.ws = null;

      // Auto-reconnect after 5 seconds
      if (this.alive) {
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      }
    });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string;

    if (type === "ticker") {
      const ticker = msg.msg as Record<string, unknown>;
      if (!ticker) return;

      this.tickerCount++;

      const marketTicker = ticker.market_ticker as string;
      const yesBid = parseFloat(String(ticker.yes_bid ?? "0"));
      const yesAsk = parseFloat(String(ticker.yes_ask ?? "0"));
      const lastPrice = parseFloat(String(ticker.last_price ?? "0"));

      this.callbacks.onTicker?.({
        marketTicker,
        yesBid,
        yesAsk,
        lastPrice,
      });
    } else if (type === "orderbook_snapshot" || type === "orderbook_delta") {
      // We could handle orderbook too, but ticker is sufficient for price tracking
    } else if (type === "error") {
      log.error("Kalshi WS server error:", JSON.stringify(msg));
    }
    // Ignore subscription confirmations, heartbeats, etc.
  }

  private sendSubscribe(tickers: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const msg = {
      id: this.msgId++,
      cmd: "subscribe",
      params: {
        channels: ["ticker"],
        market_tickers: tickers,
      },
    };

    this.ws.send(JSON.stringify(msg));
    log.info(`Kalshi WS: subscribed to ${tickers.length} tickers`);
  }

  subscribe(tickers: string[]): void {
    const newTickers = tickers.filter((t) => !this.subscribedTickers.has(t));
    if (newTickers.length === 0) return;

    for (const t of newTickers) {
      this.subscribedTickers.add(t);
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscribe(newTickers);
    }

    log.info(
      `Kalshi WS: ${newTickers.length} new tickers (${this.subscribedTickers.size} total)`
    );
  }

  unsubscribe(tickers: string[]): void {
    const toRemove = tickers.filter((t) => this.subscribedTickers.has(t));
    if (toRemove.length === 0) return;

    for (const t of toRemove) {
      this.subscribedTickers.delete(t);
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const msg = {
        id: this.msgId++,
        cmd: "unsubscribe",
        params: {
          channels: ["ticker"],
          market_tickers: toRemove,
        },
      };
      this.ws.send(JSON.stringify(msg));
    }
  }

  getStats(): { subscribedTickers: number; tickersReceived: number; connected: boolean } {
    return {
      subscribedTickers: this.subscribedTickers.size,
      tickersReceived: this.tickerCount,
      connected: this.ws?.readyState === WebSocket.OPEN,
    };
  }

  stop(): void {
    this.alive = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.subscribedTickers.clear();
    log.info(`Kalshi WS stopped (${this.tickerCount} ticker updates received)`);
  }
}
