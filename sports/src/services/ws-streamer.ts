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
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private alive = true;
  private msgId = 1;
  private lastMessageTime = 0;

  constructor(callbacks: StreamerCallbacks = {}) {
    this.callbacks = callbacks;
  }

  start(): void {
    if (!KALSHI_API_KEY || !KALSHI_PRIVATE_KEY) {
      log.warn("Kalshi WS: missing API key or private key, falling back to REST polling");
      return;
    }
    this.connect();

    // Health check every 30 seconds — detect zombie connections
    this.healthCheckTimer = setInterval(() => {
      if (!this.alive) return;

      const isOpen = this.ws?.readyState === WebSocket.OPEN;
      const timeSinceMsg = Date.now() - this.lastMessageTime;

      // If WS isn't open, or no message received in 2 minutes, force reconnect
      if (!isOpen || (this.lastMessageTime > 0 && timeSinceMsg > 120_000)) {
        log.warn(
          `Kalshi WS health check failed: open=${isOpen} lastMsg=${Math.round(timeSinceMsg / 1000)}s ago — forcing reconnect`
        );
        this.forceReconnect();
      }
    }, 30_000);
  }

  private forceReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.terminate(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.subscribed = false;
    this.connect();
  }

  private connect(): void {
    if (!this.alive) return;

    log.info("Connecting to Kalshi WebSocket...");

    const headers = createAuthHeaders();
    this.ws = new WebSocket(KALSHI_WS_URL, { headers });

    this.ws.on("open", () => {
      log.info("Kalshi WS connected");

      // Always subscribe to ticker channel on connect/reconnect
      this.sendTickerSubscribe();
    });

    this.ws.on("message", (data: Buffer) => {
      this.lastMessageTime = Date.now();
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
      this.subscribed = false;

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

      const marketTicker = ticker.market_ticker as string;

      // Only process tickers we're tracking
      if (!this.subscribedTickers.has(marketTicker)) return;

      this.tickerCount++;

      const yesBid = parseFloat(String(ticker.yes_bid_dollars ?? ticker.yes_bid ?? "0"));
      const yesAsk = parseFloat(String(ticker.yes_ask_dollars ?? ticker.yes_ask ?? "0"));
      const lastPrice = parseFloat(String(ticker.price_dollars ?? ticker.last_price ?? "0"));

      this.callbacks.onTicker?.({
        marketTicker,
        yesBid,
        yesAsk,
        lastPrice,
      });
    } else if (type === "error") {
      log.error("Kalshi WS server error:", JSON.stringify(msg));
    }
    // Ignore subscription confirmations, heartbeats, orderbook, etc.
  }

  private subscribed = false;

  private sendTickerSubscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Subscribe to the ticker channel globally — receives updates for ALL markets
    // We filter by subscribedTickers set in handleMessage
    const msg = {
      id: this.msgId++,
      cmd: "subscribe",
      params: {
        channels: ["ticker"],
      },
    };

    this.ws.send(JSON.stringify(msg));
    this.subscribed = true;
    log.info("Kalshi WS: subscribed to global ticker channel");
  }

  /**
   * Track which market tickers we care about.
   * The WS receives ALL ticker updates — we filter in handleMessage.
   */
  subscribe(tickers: string[]): void {
    for (const t of tickers) {
      this.subscribedTickers.add(t);
    }
    log.info(`Kalshi WS: tracking ${this.subscribedTickers.size} tickers`);
  }

  unsubscribe(tickers: string[]): void {
    for (const t of tickers) {
      this.subscribedTickers.delete(t);
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
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.subscribedTickers.clear();
    log.info(`Kalshi WS stopped (${this.tickerCount} ticker updates received)`);
  }
}
