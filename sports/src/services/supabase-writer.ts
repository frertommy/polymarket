/**
 * Supabase writer — manages per-sport Supabase clients and writes
 * odds to matches, odds_snapshots, and latest_odds tables.
 *
 * Each sport's Supabase has a different schema:
 *   NHL:    match_id (text), source, home_odds, away_odds, home_prob, away_prob
 *   Tennis: match_id (text), bookmaker, player1_odds, player2_odds
 *   NBA:    fixture_id (bigint, FK), bookmaker, home_odds, away_odds, draw_odds, days_before_tipoff
 *   MLB:    fixture_id (bigint, FK), bookmaker, home_odds, away_odds, days_before_kickoff
 *
 * NBA/MLB use integer fixture_ids with FK constraints populated by external services.
 * The sports poller generates string match_ids, so it can only write to NHL and Tennis.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { BATCH_SIZE, type SportConfig } from "../config.js";
import { log } from "../logger.js";
import type { OddsRow, TrackedMatch } from "../types.js";

const clients = new Map<string, SupabaseClient>();

/** Sports that use string match_id (compatible with this poller) */
const WRITABLE_SPORTS = new Set(["nhl", "tennis"]);

export function initSupabaseClients(sports: SportConfig[]): void {
  for (const sport of sports) {
    const client = createClient(sport.supabaseUrl, sport.supabaseKey);
    clients.set(sport.name, client);
    log.info(`[${sport.name}] Supabase client initialized`);
    if (!WRITABLE_SPORTS.has(sport.name)) {
      log.warn(
        `[${sport.name}] DB uses integer fixture_id — odds writes skipped (handled by standalone service)`
      );
    }
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
  if (!WRITABLE_SPORTS.has(sport)) return;

  const sb = getClient(sport);
  if (!sb || matches.length === 0) return;

  if (sport === "nhl") {
    // NHL matches: match_id, sport, home_team, away_team, game_start_time, source
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
  } else if (sport === "tennis") {
    // Tennis matches: match_id, player1, player2, commence_time, status
    const rows = matches.map((m) => ({
      match_id: m.matchId,
      player1: m.homeTeam,
      player2: m.awayTeam,
      date: m.gameStartTime.split("T")[0],
      commence_time: m.gameStartTime,
      status: "upcoming",
    }));

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error } = await sb
        .from("matches")
        .upsert(batch, { onConflict: "match_id", ignoreDuplicates: true });
      if (error) log.error(`[${sport}] matches upsert error:`, error.message);
    }
  }
}

// ─── Write odds ─────────────────────────────────────────────

export async function writeOddsRows(
  sport: string,
  rows: OddsRow[]
): Promise<void> {
  if (!WRITABLE_SPORTS.has(sport)) return;

  const sb = getClient(sport);
  if (!sb || rows.length === 0) return;

  if (sport === "nhl") {
    await writeNhlOdds(sb, rows);
  } else if (sport === "tennis") {
    await writeTennisOdds(sb, rows);
  }
}

// ─── NHL: match_id, source, home_odds, away_odds, home_prob, away_prob ──

async function writeNhlOdds(sb: SupabaseClient, rows: OddsRow[]): Promise<void> {
  // 1. Archive: odds_snapshots
  const snapshotRows = rows.map((r) => ({
    match_id: r.match_id,
    source: r.source,
    home_odds: r.home_odds,
    away_odds: r.away_odds,
    home_prob: r.home_prob,
    away_prob: r.away_prob,
    snapshot_time: r.snapshot_time,
  }));

  for (let i = 0; i < snapshotRows.length; i += BATCH_SIZE) {
    const batch = snapshotRows.slice(i, i + BATCH_SIZE);
    const { error } = await sb
      .from("odds_snapshots")
      .upsert(batch, {
        onConflict: "match_id,source,snapshot_time",
        ignoreDuplicates: false,
      });
    if (error) log.error(`[nhl] odds_snapshots error:`, error.message);
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
    if (error) log.error(`[nhl] latest_odds error:`, error.message);
  }

  log.debug(`[nhl] Wrote ${rows.length} odds rows`);
}

// ─── Tennis: match_id, bookmaker, player1_odds, player2_odds ────────

async function writeTennisOdds(sb: SupabaseClient, rows: OddsRow[]): Promise<void> {
  // 1. Archive: odds_snapshots
  const snapshotRows = rows.map((r) => ({
    match_id: r.match_id,
    bookmaker: r.source, // Tennis uses "bookmaker" column, not "source"
    player1_odds: r.home_odds, // home → player1
    player2_odds: r.away_odds, // away → player2
    snapshot_time: r.snapshot_time,
    source: r.source,
  }));

  for (let i = 0; i < snapshotRows.length; i += BATCH_SIZE) {
    const batch = snapshotRows.slice(i, i + BATCH_SIZE);
    const { error } = await sb
      .from("odds_snapshots")
      .upsert(batch, {
        onConflict: "match_id,bookmaker,source,snapshot_time",
        ignoreDuplicates: false,
      });
    if (error) log.error(`[tennis] odds_snapshots error:`, error.message);
  }

  // 2. Serving: latest_odds
  const latestRows = rows.map((r) => ({
    match_id: r.match_id,
    bookmaker: r.source,
    player1_odds: r.home_odds,
    player2_odds: r.away_odds,
    snapshot_time: r.snapshot_time,
    source: r.source,
  }));

  for (let i = 0; i < latestRows.length; i += BATCH_SIZE) {
    const batch = latestRows.slice(i, i + BATCH_SIZE);
    const { error } = await sb
      .from("latest_odds")
      .upsert(batch, { onConflict: "match_id,bookmaker", ignoreDuplicates: false });
    if (error) log.error(`[tennis] latest_odds error:`, error.message);
  }

  log.debug(`[tennis] Wrote ${rows.length} odds rows`);
}
