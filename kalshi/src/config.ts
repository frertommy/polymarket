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

// ─── Polling intervals ──────────────────────────────────────
export const MARKET_REFRESH_INTERVAL = 5 * 60 * 1000;   // 5 min — refresh market list
export const ORDERBOOK_POLL_INTERVAL = 30 * 1000;        // 30s — poll orderbooks

// ─── Soccer series slugs on Kalshi ──────────────────────────
// These are the series that contain soccer match events.
// Found via GET /trade-api/v2/series?category=soccer
export const SOCCER_SERIES = [
  "KXUCL",       // UEFA Champions League
  "KXEPL",       // English Premier League
  "KXBUND",      // Bundesliga
  "KXLALIGA",    // La Liga
  "KXLIG1",      // Ligue 1
  "KXSERIEA",    // Serie A
  "KXMLS",       // MLS
  "KXUEL",       // Europa League
];
