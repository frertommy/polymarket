/**
 * Supabase writer — manages per-sport Supabase clients and writes
 * odds to sport-specific tables.
 *
 * Each sport's Supabase has a different schema:
 *   NHL:    odds_snapshots/latest_odds with match_id (text), source, home/away odds+prob
 *   Tennis: odds_snapshots/latest_odds with match_id (text), bookmaker, player1/player2 odds
 *   NBA:    polymarket_match_odds (MSI2026 pattern) — no FK constraints
 *   MLB:    polymarket_match_odds (MSI2026 pattern) — no FK constraints
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { BATCH_SIZE, type SportConfig } from "../config.js";
import { log } from "../logger.js";
import type { OddsRow, TrackedMatch } from "../types.js";

const clients = new Map<string, SupabaseClient>();

/** Sports that write to odds_snapshots/latest_odds (string match_id) */
const ODDS_TABLE_SPORTS = new Set(["nhl", "tennis"]);

/** Sports that write to polymarket_match_odds (MSI2026 pattern) */
const PMO_SPORTS = new Set(["nba", "mlb"]);

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
  if (!ODDS_TABLE_SPORTS.has(sport)) return;

  const sb = getClient(sport);
  if (!sb || matches.length === 0) return;

  if (sport === "nhl") {
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

// ─── Write odds (NHL/Tennis → odds_snapshots/latest_odds) ────

export async function writeOddsRows(
  sport: string,
  rows: OddsRow[]
): Promise<void> {
  if (!ODDS_TABLE_SPORTS.has(sport)) return;

  const sb = getClient(sport);
  if (!sb || rows.length === 0) return;

  if (sport === "nhl") {
    await writeNhlOdds(sb, rows);
  } else if (sport === "tennis") {
    await writeTennisOdds(sb, rows);
  }
}

// ─── Write polymarket_match_odds (NBA/MLB) ───────────────────

/** Previous volume cache for delta calculation */
const prevVolumeMap = new Map<string, number>();

export async function writePolymarketMatchOdds(
  sport: string,
  matches: TrackedMatch[]
): Promise<void> {
  if (!PMO_SPORTS.has(sport)) return;

  const sb = getClient(sport);
  if (!sb) return;

  // Only write Polymarket matches (not Kalshi — Kalshi data goes through the standalone services)
  const polyMatches = matches.filter(
    (m) => m.source === "polymarket" && m.homePrice > 0.001
  );
  if (polyMatches.length === 0) return;

  const now = new Date().toISOString();
  const rows: Record<string, unknown>[] = [];

  for (const m of polyMatches) {
    const homeProb = Math.round(m.homePrice * 10000) / 10000;
    const awayProb = Math.round(m.awayPrice * 10000) / 10000;
    const maxProb = Math.max(homeProb, awayProb);
    const resolved = maxProb >= 0.99;

    // Volume delta
    const volKey = `${sport}|${m.polymarketEventId}`;
    const prevVol = prevVolumeMap.get(volKey);
    const volumeDelta =
      prevVol !== undefined && m.volume !== undefined
        ? Math.round((m.volume - prevVol) * 100) / 100
        : 0;
    if (m.volume !== undefined) prevVolumeMap.set(volKey, m.volume);

    rows.push({
      league: sport.toUpperCase(),
      event_title: m.eventTitle ?? `${m.homeTeam} vs. ${m.awayTeam}`,
      polymarket_event_id: m.polymarketEventId ?? m.matchId,
      market_type: "moneyline",
      market_question: m.eventTitle ?? `${m.homeTeam} vs. ${m.awayTeam}`,
      market_status: resolved ? "resolved" : "active",
      outcomes: [m.homeTeam, m.awayTeam],
      outcome_prices: [homeProb, awayProb],
      volume: m.volume ?? 0,
      volume_delta: volumeDelta,
      snapshot_time: now,
    });
  }

  if (rows.length === 0) return;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await sb.from("polymarket_match_odds").insert(batch);
    if (error) {
      log.error(`[${sport}] polymarket_match_odds error:`, error.message);
    }
  }

  log.debug(`[${sport}] Wrote ${rows.length} polymarket_match_odds rows`);
}

// ─── NHL: match_id, source, home_odds, away_odds, home_prob, away_prob ──

async function writeNhlOdds(sb: SupabaseClient, rows: OddsRow[]): Promise<void> {
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
  const snapshotRows = rows.map((r) => ({
    match_id: r.match_id,
    bookmaker: r.source,
    player1_odds: r.home_odds,
    player2_odds: r.away_odds,
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
