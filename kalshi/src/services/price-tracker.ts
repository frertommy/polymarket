/**
 * Price tracker — receives real-time ticker updates from Kalshi WS,
 * detects changes, throttles writes to 1/sec per match, flushes to Supabase.
 *
 * Same pattern as Polymarket's price-tracker:
 *   - WS ticker update → update in-memory price for that leg
 *   - Change detection: only write when at least one leg changed
 *   - 1-second flush timer writes all pending matches
 */
import { PRICE_CHANGE_THRESHOLD } from "../config.js";
import { log } from "../logger.js";
import type { GroupedMatch, OddsRow } from "../types.js";
import { writeOddsRows } from "./supabase-writer.js";

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export class PriceTracker {
  /** eventTicker → GroupedMatch */
  private matches = new Map<string, GroupedMatch>();

  /** marketTicker → { matchId (eventTicker), leg } */
  private tickerIndex = new Map<
    string,
    { matchId: string; leg: "home" | "draw" | "away" }
  >();

  /** Matches with price changes pending write */
  private pendingWrites = new Set<string>();

  /** fixture_id → gameStartTime */
  private kickoffMap = new Map<number, string>();

  /** Stats */
  private totalUpdates = 0;
  private totalWrites = 0;
  private totalSkipped = 0;

  // ─── Update match data (called on discovery refresh) ──────

  updateMatches(matches: GroupedMatch[]): void {
    const oldMatches = new Map(this.matches);

    this.matches.clear();
    this.tickerIndex.clear();
    this.kickoffMap.clear();

    for (const match of matches) {
      // Carry over lastWritten values
      const prev = oldMatches.get(match.eventTicker);
      if (prev) {
        match.lastWrittenHome = prev.lastWrittenHome;
        match.lastWrittenDraw = prev.lastWrittenDraw;
        match.lastWrittenAway = prev.lastWrittenAway;
        match.lastWriteTime = prev.lastWriteTime;
      }

      this.matches.set(match.eventTicker, match);
      this.kickoffMap.set(match.fixtureId, match.gameStartTime);

      // Build reverse index: marketTicker → match + leg
      this.tickerIndex.set(match.homeMarketTicker, {
        matchId: match.eventTicker,
        leg: "home",
      });
      this.tickerIndex.set(match.drawMarketTicker, {
        matchId: match.eventTicker,
        leg: "draw",
      });
      this.tickerIndex.set(match.awayMarketTicker, {
        matchId: match.eventTicker,
        leg: "away",
      });
    }

    log.info(
      `PriceTracker updated: ${this.matches.size} matches, ${this.tickerIndex.size} tickers`
    );
  }

  // ─── Handle incoming ticker update (from WS) ─────────────

  onTickerUpdate(
    marketTicker: string,
    yesBid: number,
    yesAsk: number
  ): void {
    const entry = this.tickerIndex.get(marketTicker);
    if (!entry) return;

    const match = this.matches.get(entry.matchId);
    if (!match) return;

    this.totalUpdates++;

    // Midpoint price
    const newPrice = yesBid > 0 && yesAsk > 0 ? (yesBid + yesAsk) / 2 : 0;
    if (newPrice < 0.001) return;

    // Update the leg price
    const priceKey = `${entry.leg}YesPrice` as
      | "homeYesPrice"
      | "drawYesPrice"
      | "awayYesPrice";
    const prevPrice = match[priceKey];

    if (Math.abs(newPrice - prevPrice) < PRICE_CHANGE_THRESHOLD) return;

    match[priceKey] = newPrice;

    // Check if ANY of the 3 prices differ from last write
    const homeChanged =
      Math.abs(match.homeYesPrice - match.lastWrittenHome) >= PRICE_CHANGE_THRESHOLD;
    const drawChanged =
      Math.abs(match.drawYesPrice - match.lastWrittenDraw) >= PRICE_CHANGE_THRESHOLD;
    const awayChanged =
      Math.abs(match.awayYesPrice - match.lastWrittenAway) >= PRICE_CHANGE_THRESHOLD;

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

      // Skip if all prices are zero
      if (
        match.homeYesPrice < 0.001 &&
        match.drawYesPrice < 0.001 &&
        match.awayYesPrice < 0.001
      ) {
        continue;
      }

      const homeOdds =
        match.homeYesPrice > 0.001 ? round4(1 / match.homeYesPrice) : null;
      const drawOdds =
        match.drawYesPrice > 0.001 ? round4(1 / match.drawYesPrice) : null;
      const awayOdds =
        match.awayYesPrice > 0.001 ? round4(1 / match.awayYesPrice) : null;

      const kickoff = new Date(match.gameStartTime).getTime();
      const daysBefore = Math.max(0, Math.round((kickoff - now) / 86400000));

      rows.push({
        fixture_id: match.fixtureId,
        bookmaker: "kalshi",
        home_odds: homeOdds,
        draw_odds: drawOdds,
        away_odds: awayOdds,
        days_before_kickoff: daysBefore,
        snapshot_time: new Date().toISOString(),
        source: "kalshi",
      });

      match.lastWrittenHome = match.homeYesPrice;
      match.lastWrittenDraw = match.drawYesPrice;
      match.lastWrittenAway = match.awayYesPrice;
      match.lastWriteTime = now;

      flushed.push(matchId);
    }

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
    trackedTickers: number;
    pendingWrites: number;
    totalUpdates: number;
    totalWrites: number;
    totalSkipped: number;
  } {
    return {
      trackedMatches: this.matches.size,
      trackedTickers: this.tickerIndex.size,
      pendingWrites: this.pendingWrites.size,
      totalUpdates: this.totalUpdates,
      totalWrites: this.totalWrites,
      totalSkipped: this.totalSkipped,
    };
  }
}
