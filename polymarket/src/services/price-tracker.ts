/**
 * Price tracker — tracks live Yes prices for all moneyline matches,
 * detects changes, throttles writes to 1/sec per match, and flushes
 * to Supabase in MSI-compatible odds format.
 *
 * Polling strategy:
 *   - Every trade/price update → update in-memory prices
 *   - Only mark for write if any of the 3 legs changed vs last write
 *   - Flush timer runs every 1 second, writes all pending matches
 *   - Per-match throttle: max 1 write per second per match
 */
import { PRICE_CHANGE_THRESHOLD } from "../config.js";
import { log } from "../logger.js";
import type { GroupedMatch, AssetEntry, OddsRow } from "../types.js";
import { writeOddsRows } from "./supabase-writer.js";

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export class PriceTracker {
  /** negRiskMarketId → GroupedMatch */
  private matches = new Map<string, GroupedMatch>();

  /** assetId → { matchId (negRiskMarketId), leg } */
  private assetIndex = new Map<
    string,
    { matchId: string; leg: "home" | "draw" | "away" }
  >();

  /** Matches with price changes pending write */
  private pendingWrites = new Set<string>();

  /** fixture_id → gameStartTime (for pre-kickoff filtering) */
  private kickoffMap = new Map<number, string>();

  /** Stats */
  private totalUpdates = 0;
  private totalWrites = 0;
  private totalSkipped = 0;

  // ─── Update match data (called on discovery refresh) ──────

  updateMatches(
    matches: GroupedMatch[],
    assetIndex: Map<string, AssetEntry>
  ): void {
    // Rebuild internal maps
    this.matches.clear();
    this.assetIndex.clear();
    this.kickoffMap.clear();

    for (const match of matches) {
      this.matches.set(match.negRiskMarketId, match);
      this.kickoffMap.set(match.fixtureId, match.gameStartTime);
    }

    for (const [assetId, entry] of assetIndex) {
      this.assetIndex.set(assetId, {
        matchId: entry.match.negRiskMarketId,
        leg: entry.leg,
      });
    }

    log.info(
      `PriceTracker updated: ${this.matches.size} matches, ${this.assetIndex.size} assets`
    );
  }

  // ─── Handle incoming price change (from WS) ──────────────

  onPriceChange(assetId: string, newYesPrice: number): void {
    const entry = this.assetIndex.get(assetId);
    if (!entry) return; // unknown asset (not a moneyline we're tracking)

    const match = this.matches.get(entry.matchId);
    if (!match) return;

    this.totalUpdates++;

    // Update the leg price
    const priceKey = `${entry.leg}YesPrice` as
      | "homeYesPrice"
      | "drawYesPrice"
      | "awayYesPrice";
    const prevPrice = match[priceKey];

    if (Math.abs(newYesPrice - prevPrice) < PRICE_CHANGE_THRESHOLD) return;

    match[priceKey] = newYesPrice;

    // Check if ANY of the 3 prices differ from last write
    const homeChanged =
      Math.abs(match.homeYesPrice - match.lastWrittenHome) >=
      PRICE_CHANGE_THRESHOLD;
    const drawChanged =
      Math.abs(match.drawYesPrice - match.lastWrittenDraw) >=
      PRICE_CHANGE_THRESHOLD;
    const awayChanged =
      Math.abs(match.awayYesPrice - match.lastWrittenAway) >=
      PRICE_CHANGE_THRESHOLD;

    if (homeChanged || drawChanged || awayChanged) {
      this.pendingWrites.add(entry.matchId);
    }
  }

  // ─── Flush pending writes (called every 1 second) ─────────

  async flush(): Promise<void> {
    if (this.pendingWrites.size === 0) return;

    const now = Date.now();
    const rows: OddsRow[] = [];
    const flushed: string[] = [];

    for (const matchId of this.pendingWrites) {
      const match = this.matches.get(matchId);
      if (!match) continue;

      // 1-second throttle per match
      if (now - match.lastWriteTime < 1000) {
        this.totalSkipped++;
        continue;
      }

      // Skip if all Yes prices are effectively zero (market not yet active)
      if (
        match.homeYesPrice < 0.001 &&
        match.drawYesPrice < 0.001 &&
        match.awayYesPrice < 0.001
      ) {
        continue;
      }

      // Convert Yes prices to decimal odds: odds = 1 / yesPrice
      const homeOdds =
        match.homeYesPrice > 0.001 ? round4(1 / match.homeYesPrice) : null;
      const drawOdds =
        match.drawYesPrice > 0.001 ? round4(1 / match.drawYesPrice) : null;
      const awayOdds =
        match.awayYesPrice > 0.001 ? round4(1 / match.awayYesPrice) : null;

      // Compute days_before_kickoff
      const kickoff = new Date(match.gameStartTime).getTime();
      const daysBefore = Math.max(
        0,
        Math.round((kickoff - now) / 86400000)
      );

      rows.push({
        fixture_id: match.fixtureId,
        bookmaker: "polymarket",
        home_odds: homeOdds,
        draw_odds: drawOdds,
        away_odds: awayOdds,
        days_before_kickoff: daysBefore,
        snapshot_time: new Date().toISOString(),
        source: "polymarket",
      });

      // Update tracking
      match.lastWrittenHome = match.homeYesPrice;
      match.lastWrittenDraw = match.drawYesPrice;
      match.lastWrittenAway = match.awayYesPrice;
      match.lastWriteTime = now;

      flushed.push(matchId);
    }

    // Remove flushed matches from pending
    for (const id of flushed) {
      this.pendingWrites.delete(id);
    }

    if (rows.length > 0) {
      this.totalWrites += rows.length;
      await writeOddsRows(rows, this.kickoffMap);
    }
  }

  // ─── Stats ────────────────────────────────────────────────

  getStats(): {
    trackedMatches: number;
    trackedAssets: number;
    pendingWrites: number;
    totalUpdates: number;
    totalWrites: number;
    totalSkipped: number;
  } {
    return {
      trackedMatches: this.matches.size,
      trackedAssets: this.assetIndex.size,
      pendingWrites: this.pendingWrites.size,
      totalUpdates: this.totalUpdates,
      totalWrites: this.totalWrites,
      totalSkipped: this.totalSkipped,
    };
  }
}
