/**
 * Supabase writer — manages per-sport Supabase clients and writes
 * odds to matches, odds_snapshots, and latest_odds tables.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { BATCH_SIZE, type SportConfig } from "../config.js";
import { log } from "../logger.js";
import type { OddsRow, TrackedMatch } from "../types.js";

const clients = new Map<string, SupabaseClient>();

export function initSupabaseClients(sports: SportConfig[]): void {
  for (const sport of sports) {
    const client = createClient(sport.supabaseUrl, sport.supabaseKey);
    clients.set(sport.name, client);
    log.info(`[${sport.name}] Supabase client initialized`);
  }
}

function getClient(sport: string): SupabaseClient | null {
  return clients.get(sport) ?? null;
}

// ─── Upsert matches ─────────────────────────────────────────

export async function upsertMatches(
  sport: string,
  matches: TrackedMatch[]
): Promise<void> {
  const sb = getClient(sport);
  if (!sb || matches.length === 0) return;

  const rows = matches.map((m) => ({
    match_id: m.matchId,
    sport: m.sport,
    home_team: m.homeTeam,
    away_team: m.awayTeam,
    game_start_time: m.gameStartTime,
    source: m.source,
  }));

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await sb
      .from("matches")
      .upsert(batch, { onConflict: "match_id", ignoreDuplicates: true });
    if (error) log.error(`[${sport}] matches upsert error:`, error.message);
  }
}

// ─── Write odds ─────────────────────────────────────────────

export async function writeOddsRows(
  sport: string,
  rows: OddsRow[]
): Promise<void> {
  const sb = getClient(sport);
  if (!sb || rows.length === 0) return;

  // 1. Archive: odds_snapshots
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await sb
      .from("odds_snapshots")
      .upsert(batch, {
        onConflict: "match_id,source,snapshot_time",
        ignoreDuplicates: false,
      });
    if (error) log.error(`[${sport}] odds_snapshots error:`, error.message);
  }

  // 2. Serving: latest_odds
  const latestRows = rows.map((r) => ({
    match_id: r.match_id,
    source: r.source,
    home_odds: r.home_odds,
    away_odds: r.away_odds,
    home_prob: r.home_prob,
    away_prob: r.away_prob,
    snapshot_time: r.snapshot_time,
  }));

  for (let i = 0; i < latestRows.length; i += BATCH_SIZE) {
    const batch = latestRows.slice(i, i + BATCH_SIZE);
    const { error } = await sb
      .from("latest_odds")
      .upsert(batch, { onConflict: "match_id,source", ignoreDuplicates: false });
    if (error) log.error(`[${sport}] latest_odds error:`, error.message);
  }

  log.debug(`[${sport}] Wrote ${rows.length} odds rows`);
}
