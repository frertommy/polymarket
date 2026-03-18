import { KALSHI_API_KEY } from "./config.js";

/**
 * Fetch wrapper that adds Kalshi API key auth header.
 */
export function kalshiFetch(url: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (KALSHI_API_KEY) {
    headers["Authorization"] = `Bearer ${KALSHI_API_KEY}`;
  }
  return fetch(url, { headers });
}
