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

// ─── Polymarket endpoints ────────────────────────────────────
export const CLOB_BASE = "https://clob.polymarket.com";
export const GAMMA_BASE = "https://gamma-api.polymarket.com";

// ─── Polling intervals ──────────────────────────────────────
export const DISCOVERY_INTERVAL = 5 * 60 * 1000;  // 5 min — refresh soccer market list
export const SNAPSHOT_INTERVAL = 30 * 1000;         // 30s — REST orderbook snapshots

