/**
 * Supabase writer — writes Kalshi odds into MSI-compatible tables:
 *   odds_snapshots (archive), latest_odds (serving), latest_preko_odds (pre-kickoff)
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_KEY, BATCH_SIZE } from "../config.js";
import { log } from "../logger.js";
import type { OddsRow } from "../types.js";

let supabase: SupabaseClient;

export function initSupabase(): SupabaseClient {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  log.info("Supabase client initialized");
  return supabase;
}

// ─── Batched upsert ─────────────────────────────────────────

async function upsertBatched(
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string
): Promise<{ inserted: number; failed: number }> {
  let inserted = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from(table)
      .upsert(batch, { onConflict, ignoreDuplicates: false });

    if (error) {
      log.error(
        `${table} batch ${Math.floor(i / BATCH_SIZE) + 1} error:`,
        error.message
      );
      failed += batch.length;
    } else {
      inserted += batch.length;
    }
  }

  return { inserted, failed };
}

// ─── Write odds rows ────────────────────────────────────────

export async function writeOddsRows(
  rows: OddsRow[],
  kickoffMap: Map<number, string>
): Promise<void> {
  if (rows.length === 0) return;

  // 1. Archive: odds_snapshots
  const archiveRows = rows.map((r) => ({
    fixture_id: r.fixture_id,
    bookmaker: r.bookmaker,
    home_odds: r.home_odds,
    draw_odds: r.draw_odds,
    away_odds: r.away_odds,
    days_before_kickoff: r.days_before_kickoff,
    snapshot_time: r.snapshot_time,
    source: r.source,
  }));

  const { inserted, failed } = await upsertBatched(
    "odds_snapshots",
    archiveRows,
    "fixture_id,source,bookmaker,snapshot_time"
  );

  if (failed > 0) log.warn(`${failed} odds_snapshots rows failed`);

  // 2. Serving: latest_odds
  const latestRows = rows.map((r) => ({
    fixture_id: r.fixture_id,
    bookmaker: r.bookmaker,
    home_odds: r.home_odds,
    draw_odds: r.draw_odds,
    away_odds: r.away_odds,
    snapshot_time: r.snapshot_time,
    source: r.source,
  }));

  const { failed: latestFailed } = await upsertBatched(
    "latest_odds",
    latestRows,
    "fixture_id,bookmaker"
  );

  if (latestFailed > 0) log.warn(`${latestFailed} latest_odds rows failed`);

  // 3. Pre-kickoff: latest_preko_odds
  const prekoRows = rows
    .filter((r) => {
      const kickoff = kickoffMap.get(r.fixture_id);
      if (!kickoff) return false;
      return new Date(r.snapshot_time).getTime() < new Date(kickoff).getTime();
    })
    .map((r) => ({
      fixture_id: r.fixture_id,
      bookmaker: r.bookmaker,
      home_odds: r.home_odds,
      draw_odds: r.draw_odds,
      away_odds: r.away_odds,
      snapshot_time: r.snapshot_time,
      source: r.source,
    }));

  if (prekoRows.length > 0) {
    const { failed: prekoFailed } = await upsertBatched(
      "latest_preko_odds",
      prekoRows,
      "fixture_id,bookmaker"
    );
    if (prekoFailed > 0) log.warn(`${prekoFailed} latest_preko_odds rows failed`);
  }

  log.debug(
    `Wrote ${inserted} odds rows (${latestRows.length} latest, ${prekoRows.length} preko)`
  );
}
