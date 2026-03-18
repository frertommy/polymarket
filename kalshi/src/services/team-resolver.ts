import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_KEY } from "../config.js";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Alias map ──────────────────────────────────────────────

let aliasMap: Record<string, string> = {};

function loadAliasMap(): void {
  const aliasPath = path.resolve(__dirname, "../data/team-aliases.json");
  try {
    const raw = fs.readFileSync(aliasPath, "utf-8");
    aliasMap = JSON.parse(raw);
    log.info(`Loaded ${Object.keys(aliasMap).length} team aliases`);
  } catch {
    log.warn("Could not load team-aliases.json");
    aliasMap = {};
  }
}

loadAliasMap();

// ─── Name cleaning (Kalshi-specific) ────────────────────────

function cleanKalshiName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+(FC|AFC|SC|CF|CFC|SCO|SFC)$/i, "")
    .replace(/^(AFC|FC)\s+/i, "")
    .replace(/\s+\d{4}$/, "")
    .replace(/\s*&\s*/g, " and ")
    .trim();
}

// ─── Normalize for fuzzy matching ───────────────────────────

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalize(name: string): string {
  return stripAccents(name)
    .toLowerCase()
    .replace(
      /\b(fc|cf|afc|sc|ssc|ss|ac|as|us|rc|rcd|ca|sv|vfb|tsg|1\.\s*fc|1\.\s*fsv|bsc|ud|cd|fk|bv|if|sk|nk|ogc|osc|aj|cfc)\b/g,
      ""
    )
    .replace(/\b(de|di)\b/g, "")
    .replace(/\bcalcio\b/g, "")
    .replace(/\b(1[89]\d{2}|0\d)\b/g, "")
    .replace(/[''`.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function resolveTeamName(kalshiName: string): string {
  if (aliasMap[kalshiName]) return aliasMap[kalshiName];
  const cleaned = cleanKalshiName(kalshiName);
  if (aliasMap[cleaned]) return aliasMap[cleaned];
  return cleaned;
}

// ─── Fixture cache (bulk loaded) ────────────────────────────

interface CachedFixture {
  fixture_id: number;
  home_team: string;
  away_team: string;
  date: string;
  home_norm: string;
  away_norm: string;
}

const TRACKED_LEAGUES = [
  "Premier League",
  "La Liga",
  "Bundesliga",
  "Serie A",
  "Ligue 1",
  "Champions League",
];

let cachedFixtures: CachedFixture[] = [];
let supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (!supabase) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return supabase;
}

export async function refreshFixtureCache(): Promise<void> {
  const sb = getSupabase();

  const { data, error } = await sb
    .from("matches")
    .select("fixture_id, home_team, away_team, date, league")
    .in("league", TRACKED_LEAGUES)
    .order("date", { ascending: false })
    .limit(5000);

  if (error) {
    log.error("Failed to fetch fixtures:", error.message);
    return;
  }

  cachedFixtures = (data ?? []).map((m) => ({
    fixture_id: m.fixture_id,
    home_team: m.home_team,
    away_team: m.away_team,
    date: m.date,
    home_norm: normalize(m.home_team),
    away_norm: normalize(m.away_team),
  }));

  const byLeague = TRACKED_LEAGUES.map((l) => {
    const count = (data ?? []).filter((r) => r.league === l).length;
    return `${l}: ${count}`;
  }).join(", ");

  log.info(`Loaded ${cachedFixtures.length} fixtures (${byLeague})`);
}

export function lookupFixtureId(
  homeCanonical: string,
  awayCanonical: string,
  gameDate: string
): number | null {
  const date = new Date(gameDate);
  const homeNorm = normalize(homeCanonical);
  const awayNorm = normalize(awayCanonical);

  for (const f of cachedFixtures) {
    const diff = Math.abs(date.getTime() - new Date(f.date).getTime());
    if (diff > 3 * 86400000) continue;

    if (
      (f.home_team === homeCanonical && f.away_team === awayCanonical) ||
      (f.home_team === awayCanonical && f.away_team === homeCanonical)
    ) {
      return f.fixture_id;
    }

    if (
      (f.home_norm === homeNorm && f.away_norm === awayNorm) ||
      (f.home_norm === awayNorm && f.away_norm === homeNorm)
    ) {
      return f.fixture_id;
    }
  }

  return null;
}
