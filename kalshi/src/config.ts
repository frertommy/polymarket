// ─── Environment ─────────────────────────────────────────────
export const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
export const SUPABASE_KEY = process.env.SUPABASE_KEY ?? "";

export function validateEnv(): void {
  const missing: string[] = [];
  if (!SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!SUPABASE_KEY) missing.push("SUPABASE_KEY");
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}

// ─── Kalshi API ──────────────────────────────────────────────
export const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

// Series tickers for match-winner markets per league
export const KALSHI_SERIES = [
  "KXEPLGAME",        // Premier League
  "KXLALIGAGAME",     // La Liga
  "KXBUNDESLIGAGAME",  // Bundesliga
  "KXSERIEAGAME",     // Serie A
  "KXLIGUE1GAME",     // Ligue 1
  "KXUCLGAME",        // Champions League
];

// ─── Polling intervals ──────────────────────────────────────
export const DISCOVERY_INTERVAL = 5 * 60 * 1000; // 5 min — market discovery
export const PRICE_POLL_INTERVAL = 1_000; // 1 sec — REST price poll
export const STATS_INTERVAL = 60_000; // 1 min — log stats

// ─── Change detection ────────────────────────────────────────
export const PRICE_CHANGE_THRESHOLD = 0.0001;

// ─── Batch sizes ─────────────────────────────────────────────
export const BATCH_SIZE = 500;
