// ─── Environment ─────────────────────────────────────────────
export const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
export const SUPABASE_KEY = process.env.SUPABASE_KEY ?? "";
export const PORT = parseInt(process.env.PORT ?? "3000", 10);

export function validateEnv(): void {
  const missing: string[] = [];
  if (!SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!SUPABASE_KEY) missing.push("SUPABASE_KEY");
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}

// ─── Polymarket league series IDs (Gamma API) ────────────────
export const POLYMARKET_SERIES_IDS: Record<string, string> = {
  "Premier League": "10188",
  "La Liga": "10193",
  Bundesliga: "10194",
  "Serie A": "10203",
  "Ligue 1": "10195",
};

// ─── Polymarket futures slugs (league winner markets) ────────
export const POLYMARKET_FUTURES_SLUGS: Record<string, string> = {
  "Premier League": "english-premier-league-winner",
  "La Liga": "la-liga-winner-114",
  Bundesliga: "bundesliga-winner-527",
  "Serie A": "serie-a-league-winner",
  "Ligue 1": "french-ligue-1-winner",
};

// ─── Polling intervals ──────────────────────────────────────
export const POLYMARKET_POLL_INTERVAL = 10 * 60 * 1000; // 10 minutes

// ─── Batch size for Supabase inserts ─────────────────────────
export const BATCH_SIZE = 500;
