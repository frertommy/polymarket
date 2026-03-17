import { POLYMARKET_POLL_INTERVAL } from "./config.js";
import { log } from "./logger.js";
import {
  pollPolymarketMatches,
  pollPolymarketFutures,
} from "./services/polymarket-poller.js";

export class Scheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private cycleCount = 0;

  async start(): Promise<void> {
    this.running = true;
    log.info("Polymarket scheduler starting...");

    // Run first cycle immediately
    await this.runCycle();

    // Schedule next
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    log.info(`Scheduler stopped after ${this.cycleCount} cycles`);
  }

  private scheduleNext(): void {
    if (!this.running) return;

    const minutes = (POLYMARKET_POLL_INTERVAL / 60000).toFixed(1);
    log.info(`Next Polymarket poll in ${minutes} min`);

    this.timer = setTimeout(async () => {
      if (!this.running) return;
      await this.runCycle();
      this.scheduleNext();
    }, POLYMARKET_POLL_INTERVAL);
  }

  private async runCycle(): Promise<void> {
    this.cycleCount++;
    const cycleStart = Date.now();
    log.info(`═══ Cycle #${this.cycleCount} starting ═══`);

    try {
      const matchResult = await pollPolymarketMatches();
      const futuresResult = await pollPolymarketFutures();

      const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
      log.info(
        `═══ Cycle #${this.cycleCount} complete in ${elapsed}s ` +
        `(matches: ${matchResult.rowsInserted}, futures: ${futuresResult.rowsInserted}) ═══`
      );
    } catch (err) {
      log.error(
        `Cycle #${this.cycleCount} failed`,
        err instanceof Error ? err.message : err
      );
    }
  }
}
