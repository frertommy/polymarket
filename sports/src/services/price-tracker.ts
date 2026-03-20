/**
 * Price tracker for 2-outcome sports. Detects changes, throttles
 * writes to 1/sec per match, flushes to sport-specific Supabase.
 */
import { PRICE_CHANGE_THRESHOLD } from "../config.js";
import { log } from "../logger.js";
import type { TrackedMatch, OddsRow } from "../types.js";
import { writeOddsRows } from "./supabase-writer.js";

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export class PriceTracker {
  /** matchId → TrackedMatch */
  private matches = new Map<string, TrackedMatch>();

  /** assetId/ticker → { matchId, leg } */
  private assetIndex = new Map<
    string,
    { matchId: string; leg: "home" | "away" }
  >();

  private pendingWrites = new Set<string>();

  /** Stats per sport */
  private stats = new Map<
    string,
    { updates: number; writes: number; skipped: number }
  >();

  updateMatches(matches: TrackedMatch[]): void {
    const oldMatches = new Map(this.matches);

    this.matches.clear();
    this.assetIndex.clear();

    for (const m of matches) {
      const prev = oldMatches.get(m.matchId);
      if (prev) {
        m.lastWrittenHome = prev.lastWrittenHome;
        m.lastWrittenAway = prev.lastWrittenAway;
        m.lastWriteTime = prev.lastWriteTime;
      }

      this.matches.set(m.matchId, m);
      this.assetIndex.set(m.homeAssetId, { matchId: m.matchId, leg: "home" });
      this.assetIndex.set(m.awayAssetId, { matchId: m.matchId, leg: "away" });

      if (!this.stats.has(m.sport)) {
        this.stats.set(m.sport, { updates: 0, writes: 0, skipped: 0 });
      }
    }
  }

  onPriceChange(assetId: string, newPrice: number): void {
    const entry = this.assetIndex.get(assetId);
    if (!entry) return;

    const match = this.matches.get(entry.matchId);
    if (!match) return;

    const s = this.stats.get(match.sport);
    if (s) s.updates++;

    const key = entry.leg === "home" ? "homePrice" : "awayPrice";
    if (Math.abs(newPrice - match[key]) < PRICE_CHANGE_THRESHOLD) return;
    match[key] = newPrice;

    const lastKey = entry.leg === "home" ? "lastWrittenHome" : "lastWrittenAway";
    const homeChanged =
      Math.abs(match.homePrice - match.lastWrittenHome) >= PRICE_CHANGE_THRESHOLD;
    const awayChanged =
      Math.abs(match.awayPrice - match.lastWrittenAway) >= PRICE_CHANGE_THRESHOLD;

    if (homeChanged || awayChanged) {
      this.pendingWrites.add(entry.matchId);
    }
  }

  async flush(): Promise<void> {
    if (this.pendingWrites.size === 0) return;

    const now = Date.now();
    // Group rows by sport
    const rowsBySport = new Map<string, OddsRow[]>();
    const flushed: string[] = [];

    for (const matchId of this.pendingWrites) {
      const match = this.matches.get(matchId);
      if (!match) continue;

      if (now - match.lastWriteTime < 1000) {
        const s = this.stats.get(match.sport);
        if (s) s.skipped++;
        continue;
      }

      if (match.homePrice < 0.001 && match.awayPrice < 0.001) continue;

      const homeOdds = match.homePrice > 0.001 ? round4(1 / match.homePrice) : null;
      const awayOdds = match.awayPrice > 0.001 ? round4(1 / match.awayPrice) : null;

      const row: OddsRow = {
        match_id: match.matchId,
        source: match.source,
        home_odds: homeOdds,
        away_odds: awayOdds,
        home_prob: round4(match.homePrice),
        away_prob: round4(match.awayPrice),
        snapshot_time: new Date().toISOString(),
      };

      if (!rowsBySport.has(match.sport)) rowsBySport.set(match.sport, []);
      rowsBySport.get(match.sport)!.push(row);

      match.lastWrittenHome = match.homePrice;
      match.lastWrittenAway = match.awayPrice;
      match.lastWriteTime = now;

      const s = this.stats.get(match.sport);
      if (s) s.writes++;

      flushed.push(matchId);
    }

    for (const id of flushed) this.pendingWrites.delete(id);

    // Write to each sport's Supabase
    for (const [sport, rows] of rowsBySport) {
      await writeOddsRows(sport, rows);
    }
  }

  getStats(): Map<string, { matches: number; updates: number; writes: number; skipped: number }> {
    const result = new Map<string, { matches: number; updates: number; writes: number; skipped: number }>();
    for (const [sport, s] of this.stats) {
      const matchCount = [...this.matches.values()].filter((m) => m.sport === sport).length;
      result.set(sport, { matches: matchCount, ...s });
    }
    return result;
  }
}
