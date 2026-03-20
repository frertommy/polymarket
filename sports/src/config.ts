import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Sport configurations ───────────────────────────────────

export interface SportConfig {
  name: string;
  polymarketTag: string; // Gamma API tag_slug
  kalshiSeries: string[]; // Kalshi series tickers for match-winner
  supabaseUrl: string;
  supabaseKey: string;
}

export const SPORTS: SportConfig[] = [
  {
    name: "nba",
    polymarketTag: "nba",
    kalshiSeries: ["KXNBAGAME"],
    supabaseUrl: process.env.SUPABASE_URL_NBA ?? "",
    supabaseKey: process.env.SUPABASE_KEY_NBA ?? "",
  },
  {
    name: "mlb",
    polymarketTag: "mlb",
    kalshiSeries: ["KXMLBGAME"],
    supabaseUrl: process.env.SUPABASE_URL_MLB ?? "",
    supabaseKey: process.env.SUPABASE_KEY_MLB ?? "",
  },
  {
    name: "nhl",
    polymarketTag: "nhl",
    kalshiSeries: ["KXNHLGAME"],
    supabaseUrl: process.env.SUPABASE_URL_NHL ?? "",
    supabaseKey: process.env.SUPABASE_KEY_NHL ?? "",
  },
  {
    name: "tennis",
    polymarketTag: "tennis",
    kalshiSeries: ["KXATPMATCH", "KXWTAMATCH"],
    supabaseUrl: process.env.SUPABASE_URL_TENNIS ?? "",
    supabaseKey: process.env.SUPABASE_KEY_TENNIS ?? "",
  },
];

// ─── Kalshi API ──────────────────────────────────────────────
export const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
export const KALSHI_WS_URL = "wss://api.elections.kalshi.com/trade-api/ws/v2";
export const KALSHI_API_KEY = process.env.KALSHI_API_KEY ?? "";

function loadPrivateKey(): string {
  if (process.env.KALSHI_PRIVATE_KEY) return process.env.KALSHI_PRIVATE_KEY;
  const keyPaths = [
    path.resolve(__dirname, "../KALSHI_PRIVATE_KEY.txt"),
    path.resolve(__dirname, "../../KALSHI_PRIVATE_KEY.txt"),
    path.resolve(__dirname, "../../kalshi/KALSHI_PRIVATE_KEY.txt"),
  ];
  for (const p of keyPaths) {
    try {
      const key = fs.readFileSync(p, "utf-8").trim();
      if (key.includes("BEGIN RSA PRIVATE KEY")) return key;
    } catch { /* skip */ }
  }
  return "";
}

export const KALSHI_PRIVATE_KEY = loadPrivateKey();

// ─── Polymarket ──────────────────────────────────────────────
export const GAMMA_BASE = "https://gamma-api.polymarket.com";

// ─── Polling intervals ──────────────────────────────────────
export const DISCOVERY_INTERVAL = 5 * 60 * 1000; // 5 min
export const PRICE_FLUSH_INTERVAL = 1_000; // 1 sec
export const STATS_INTERVAL = 60_000; // 1 min

// ─── Change detection ────────────────────────────────────────
export const PRICE_CHANGE_THRESHOLD = 0.0001;
export const BATCH_SIZE = 500;

// ─── Validation ──────────────────────────────────────────────
export function validateEnv(): void {
  const missing: string[] = [];
  for (const sport of SPORTS) {
    if (!sport.supabaseUrl) missing.push(`SUPABASE_URL_${sport.name.toUpperCase()}`);
    if (!sport.supabaseKey) missing.push(`SUPABASE_KEY_${sport.name.toUpperCase()}`);
  }
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}
