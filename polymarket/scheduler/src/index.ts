import { validateEnv } from "./config.js";
import { Scheduler } from "./scheduler.js";
import { log } from "./logger.js";

validateEnv();

const scheduler = new Scheduler();

process.on("SIGINT", () => {
  log.info("Received SIGINT, shutting down...");
  scheduler.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  log.info("Received SIGTERM, shutting down...");
  scheduler.stop();
  process.exit(0);
});

scheduler.start().catch((err) => {
  log.error("Scheduler failed to start", err);
  process.exit(1);
});
