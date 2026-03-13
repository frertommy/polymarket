/**
 * Per-Team Lambda vs Global Lambda Off-Season Drift Simulation
 *
 * Compares three off-season drift strategies:
 *   A) Global lambda = 0.02 for all teams (current production)
 *   B) Per-team lambda based on bookmaker odds dispersion
 *      - High cross-bookmaker stdev -> higher lambda (bookies disagree -> B needs more correction)
 *      - Low cross-bookmaker stdev  -> lower lambda  (bookies agree   -> B is already close)
 *   C) Per-team lambda based on Polymarket volume
 *      - High volume -> higher lambda (confident market signal -> drift faster)
 *      - Low volume  -> lower lambda  (thin market -> drift cautiously)
 *
 * For each strategy, we use ClubElo as the drift target R_futures,
 * replay the 2025/26 season settlements, and compare Mean |M1|.
 *
 * The "off-season drift" is simulated as a one-shot B adjustment BEFORE
 * the season starts: B_new = B_old + lambda * (R_clubelo - B_old)
 * This is equivalent to N days of daily drift with effective lambda.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Paths ───────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "data");
const RESULTS_DIR = path.join(__dirname, "results");
fs.mkdirSync(RESULTS_DIR, { recursive: true });

// ─── Constants ───────────────────────────────────────────
const K = 30;
const HOME_ADV = 65;

// ─── Team alias mapping ─────────────────────────────────
const aliasPath = path.join(__dirname, "..", "..", "scheduler", "src", "data", "team-aliases.json");
const ALIASES = JSON.parse(fs.readFileSync(aliasPath, "utf-8"));

function normalizeName(name) {
  if (ALIASES[name]) return ALIASES[name];
  const trimmed = name.trim();
  if (ALIASES[trimmed]) return ALIASES[trimmed];
  return trimmed;
}

// ─── ClubElo name mapping ────────────────────────────────
const CLUBELO_NAME_MAP = {
  "Man City": "Manchester City",
  "Man United": "Manchester United",
  "Paris SG": "Paris Saint Germain",
  "Bayern": "Bayern München",
  "Leverkusen": "Bayer Leverkusen",
  "Dortmund": "Borussia Dortmund",
  "Frankfurt": "Eintracht Frankfurt",
  "Stuttgart": "VfB Stuttgart",
  "Freiburg": "SC Freiburg",
  "Wolfsburg": "VfL Wolfsburg",
  "Gladbach": "Borussia Mönchengladbach",
  "Augsburg": "FC Augsburg",
  "Hoffenheim": "1899 Hoffenheim",
  "Mainz": "FSV Mainz 05",
  "Werder": "Werder Bremen",
  "St Pauli": "FC St. Pauli",
  "Heidenheim": "1. FC Heidenheim",
  "Koeln": "1. FC Köln",
  "Hamburg": "Hamburger SV",
  "Holstein": "Holstein Kiel",
  "Bochum": "VfL Bochum",
  "Forest": "Nottingham Forest",
  "Newcastle": "Newcastle",
  "Atletico": "Atletico Madrid",
  "Bilbao": "Athletic Club",
  "Sociedad": "Real Sociedad",
  "Betis": "Real Betis",
  "Celta": "Celta Vigo",
  "Inter": "Inter",
  "Milan": "AC Milan",
  "Roma": "AS Roma",
  "Verona": "Hellas Verona",
  "Brest": "Stade Brestois 29",
  "Monaco": "Monaco",
  "Marseille": "Marseille",
  "Lens": "Lens",
  "Lyon": "Lyon",
  "Rennes": "Rennes",
  "Strasbourg": "Strasbourg",
  "Toulouse": "Toulouse",
  "Nice": "Nice",
  "Auxerre": "Auxerre",
  "Le Havre": "Le Havre",
  "Nantes": "Nantes",
  "Reims": "Reims",
  "Lille": "Lille",
  "Saint-Etienne": "Saint-Etienne",
  "Angers": "Angers",
  "RB Leipzig": "RB Leipzig",
  "Osasuna": "Osasuna",
  "Sevilla": "Sevilla",
  "Mallorca": "Mallorca",
  "Getafe": "Getafe",
  "Espanyol": "Espanyol",
  "Valladolid": "Valladolid",
  "Leganes": "Leganes",
  "Girona": "Girona",
  "Rayo Vallecano": "Rayo Vallecano",
  "Alaves": "Alaves",
  "Valencia": "Valencia",
  "Sunderland": "Sunderland",
  "Burnley": "Burnley",
  "Leeds": "Leeds",
  "Como": "Como",
  "Cagliari": "Cagliari",
  "Torino": "Torino",
  "Lecce": "Lecce",
  "Parma": "Parma",
  "Empoli": "Empoli",
  "Genoa": "Genoa",
  "Venezia": "Venezia",
  "Monza": "Monza",
  "Sassuolo": "Sassuolo",
  "Udinese": "Udinese",
  "Oviedo": "Oviedo",
  "Elche": "Elche",
  "Paris FC": "Paris FC",
  "Lorient": "Lorient",
  "Metz": "Metz",
};

function normalizeClubEloName(name) {
  if (CLUBELO_NAME_MAP[name]) return normalizeName(CLUBELO_NAME_MAP[name]);
  return normalizeName(name);
}

// ─── Polymarket name → oracle name mapping ───────────────
const POLY_NAME_MAP = {
  "Man City": "Manchester City",
  "Man United": "Manchester United",
  "PSG": "Paris Saint Germain",
  "Bayern München": "Bayern München",
  "Leverkusen": "Bayer Leverkusen",
  "Dortmund": "Borussia Dortmund",
  "Stuttgart": "VfB Stuttgart",
  "Hoffenheim": "1899 Hoffenheim",
  "Roma": "AS Roma",
  "Betis": "Real Betis",
  "Athletic Club": "Athletic Club",
  "Stade Brestois 29": "Stade Brestois 29",
};

function normalizePolyName(name) {
  if (POLY_NAME_MAP[name]) return normalizeName(POLY_NAME_MAP[name]);
  return normalizeName(name);
}

// ─── Core math ───────────────────────────────────────────
function oddsImpliedStrength(teamExpectedScore, opponentElo, isHome) {
  const es = Math.max(0.01, Math.min(0.99, teamExpectedScore));
  const rawImplied = opponentElo + 400 * Math.log10(es / (1 - es));
  return isHome ? rawImplied - HOME_ADV : rawImplied + HOME_ADV;
}

function r2(v) { return Math.round(v * 100) / 100; }
function r1(v) { return Math.round(v * 10) / 10; }

// ─── Per-team odds dispersion data ───────────────────────
// From SQL: per-team weighted standard deviation of implied win probabilities
// across bookmakers. Higher = more bookmaker disagreement.
const ODDS_DISPERSION = {
  "Atletico Madrid": 0.024348,
  "Bayern München": 0.019280,
  "Real Betis": 0.016942,
  "Real Madrid": 0.016914,
  "Marseille": 0.016212,
  "Manchester City": 0.015901,
  "Lens": 0.015895,
  "Inter": 0.015643,
  "Villarreal": 0.015612,
  "Barcelona": 0.015473,
  "Paris Saint Germain": 0.015241,
  "Monaco": 0.014834,
  "Rennes": 0.014770,
  "Napoli": 0.014627,
  "RB Leipzig": 0.014590,
  "Bayer Leverkusen": 0.014507,
  "Lecce": 0.014506,
  "Atalanta": 0.014355,
  "Lazio": 0.014278,
  "AC Milan": 0.014186,
  "Juventus": 0.014080,
  "Borussia Dortmund": 0.014068,
  "Real Sociedad": 0.013814,
  "Liverpool": 0.013704,
  "Lorient": 0.013566,
  "Bologna": 0.013539,
  "Arsenal": 0.013536,
  "Como": 0.013459,
  "Fiorentina": 0.013442,
  "Lille": 0.013358,
  "Athletic Club": 0.013201,
  "Chelsea": 0.012946,
  "AS Roma": 0.012881,
  "VfB Stuttgart": 0.012803,
  "FC Augsburg": 0.012764,
  "Newcastle": 0.012664,
  "1899 Hoffenheim": 0.012219,
  "Lyon": 0.012033,
  "Rayo Vallecano": 0.012030,
  "Manchester United": 0.012028,
  "Werder Bremen": 0.012021,
  "Eintracht Frankfurt": 0.011985,
  "Bournemouth": 0.011927,
  "Valencia": 0.011927,
  "FSV Mainz 05": 0.011829,
  "Genoa": 0.011782,
  "Strasbourg": 0.011753,
  "Tottenham": 0.011742,
  "Brighton": 0.011687,
  "Crystal Palace": 0.011654,
  "Levante": 0.011633,
  "Cagliari": 0.011628,
  "Celta Vigo": 0.011600,
  "Sassuolo": 0.011534,
  "Toulouse": 0.011466,
  "Mallorca": 0.011448,
  "Sevilla": 0.011432,
  "Torino": 0.011403,
  "SC Freiburg": 0.011332,
  "Le Havre": 0.011315,
  "VfL Wolfsburg": 0.011313,
  "Espanyol": 0.011297,
  "Nice": 0.011182,
  "Wolves": 0.011148,
  "Parma": 0.011075,
  "Aston Villa": 0.011045,
  "Alaves": 0.011039,
  "Everton": 0.011000,
  "Udinese": 0.010905,
  "Osasuna": 0.010876,
  "Nottingham Forest": 0.010840,
  "Girona": 0.010835,
  "1. FC Köln": 0.010802,
  "Borussia Mönchengladbach": 0.010740,
  "Stade Brestois 29": 0.010732,
  "Paris FC": 0.010716,
  "Hellas Verona": 0.010715,
  "Union Berlin": 0.010697,
  "Hamburger SV": 0.010635,
  "Cremonese": 0.010633,
  "Fulham": 0.010592,
  "FC St. Pauli": 0.010399,
  "Elche": 0.010399,
  "Pisa": 0.010312,
  "1. FC Heidenheim": 0.010306,
  "Getafe": 0.010264,
  "Brentford": 0.010225,
  "Auxerre": 0.010211,
  "Oviedo": 0.010122,
  "Angers": 0.010020,
  "Leeds": 0.009875,
  "West Ham": 0.009697,
  "Nantes": 0.009652,
  "Metz": 0.009140,
  "Sunderland": 0.009070,
  "Burnley": 0.009038,
};

// ─── Per-team Polymarket volumes (USD) ───────────────────
// From polymarket_futures table, latest snapshot.
// Team names here use Polymarket naming; we'll normalize when looking up.
const POLYMARKET_VOLUME_RAW = {
  "Chelsea": 67269078,
  "Athletic Club": 30953021,
  "Atletico Madrid": 25666007,
  "Villarreal": 19685106,
  "Everton": 18250152,
  "Aston Villa": 17637936,
  "Brentford": 14186106,
  "Man United": 12906814,
  "Fulham": 12228712,
  "Lens": 11548167,
  "Bournemouth": 10999568,
  "Liverpool": 10613469,
  "Sunderland": 9844131,
  "Espanyol": 9496009,
  "Arsenal": 7033671,
  "Man City": 6822022,
  "Getafe": 5675157,
  "Betis": 5111083,
  "Osasuna": 4676223,
  "Celta Vigo": 4447737,
  "Real Sociedad": 4418721,
  "Barcelona": 1856392,
  "Real Madrid": 1672034,
  "Napoli": 454765,
  "Stuttgart": 331924,
  "RB Leipzig": 262449,
  "Hoffenheim": 252049,
  "Monaco": 197180,
  "Roma": 150207,
  "Dortmund": 146820,
  "Angers": 130784,
  "Bayern München": 130715,
  "PSG": 126591,
  "Leverkusen": 125659,
  "Lyon": 123863,
  "Inter": 109727,
  "Marseille": 104501,
  "Juventus": 103908,
  "AC Milan": 103045,
  "Como": 99569,
  "Strasbourg": 82552,
  "Stade Brestois 29": 79552,
  "Rennes": 78508,
  "Bologna": 61176,
  "Toulouse": 48115,
  "Atalanta": 45712,
  "Lille": 42883,
  "Lorient": 0,
  "Sassuolo": 0,
  "Lazio": 0,
};

// Normalize Polymarket volumes to oracle team names
const POLYMARKET_VOLUME = {};
for (const [polyName, vol] of Object.entries(POLYMARKET_VOLUME_RAW)) {
  const canonical = normalizePolyName(polyName);
  POLYMARKET_VOLUME[canonical] = vol;
}

// ─── Load data ───────────────────────────────────────────
console.log("=== Per-Team Lambda vs Global Lambda Off-Season Drift Simulation ===\n");

// Settlement log
const settlements = JSON.parse(
  fs.readFileSync(path.join(DATA_DIR, "supabase", "settlement_log.json"), "utf-8")
);

// Matches
const matchesRaw = JSON.parse(
  fs.readFileSync(path.join(DATA_DIR, "supabase", "matches.json"), "utf-8")
);
const matchMap = new Map();
for (const m of matchesRaw) matchMap.set(m.fixture_id, m);

// KR snapshots
const krRaw = JSON.parse(
  fs.readFileSync(path.join(DATA_DIR, "supabase", "kr_snapshots.json"), "utf-8")
);
const krMap = new Map();
for (const kr of krRaw) krMap.set(kr.fixture_id, kr);

// Initial seeds
const initialSeedsRaw = JSON.parse(
  fs.readFileSync(path.join(DATA_DIR, "supabase", "initial_seeds.json"), "utf-8")
);
const initialSeeds = new Map();
for (const s of initialSeedsRaw) {
  initialSeeds.set(s.team_id, Number(s.seed_b));
}

// ClubElo ratings
const clubeloRaw = JSON.parse(
  fs.readFileSync(path.join(DATA_DIR, "clubelo", "clubelo_summer_2025.json"), "utf-8")
);
const clubeloTeams = clubeloRaw.dates["2025-06-01"];

// Build ClubElo map (canonical name -> elo)
const clubeloMapped = new Map();
for (const [ceName, data] of Object.entries(clubeloTeams)) {
  const canonical = normalizeClubEloName(ceName);
  clubeloMapped.set(canonical, data.elo);
}

console.log(`  ${settlements.length} settlement rows`);
console.log(`  ${matchMap.size} matches`);
console.log(`  ${krMap.size} KR snapshots`);
console.log(`  ${initialSeeds.size} initial seeds`);
console.log(`  ${Object.keys(clubeloTeams).length} ClubElo teams`);
console.log(`  ${Object.keys(ODDS_DISPERSION).length} teams with odds dispersion data`);
console.log(`  ${Object.keys(POLYMARKET_VOLUME).length} teams with Polymarket volume data\n`);

// ─── Group settlements by fixture ────────────────────────
const fixtureSettlements = new Map();
for (const s of settlements) {
  const fid = Number(s.fixture_id);
  if (!fixtureSettlements.has(fid)) fixtureSettlements.set(fid, []);
  fixtureSettlements.get(fid).push({
    fixture_id: fid,
    team_id: s.team_id,
    e_kr: Number(s.e_kr),
    actual_score_s: Number(s.actual_score_s),
    delta_b: Number(s.delta_b),
    b_before: Number(s.b_before),
    b_after: Number(s.b_after),
    settled_at: s.settled_at,
  });
}

// ─── Order fixtures chronologically ──────────────────────
const fixtureOrder = [...fixtureSettlements.keys()]
  .filter(fid => matchMap.has(fid) && krMap.has(fid))
  .sort((a, b) => {
    const ma = matchMap.get(a);
    const mb = matchMap.get(b);
    const ta = ma.commence_time || (ma.date + "T23:59:59Z");
    const tb = mb.commence_time || (mb.date + "T23:59:59Z");
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });

console.log(`  ${fixtureOrder.length} fixtures in chronological order`);
const firstMatch = matchMap.get(fixtureOrder[0]);
const lastMatch = matchMap.get(fixtureOrder[fixtureOrder.length - 1]);
console.log(`  First: ${firstMatch.commence_time} (${firstMatch.home_team} vs ${firstMatch.away_team})`);
console.log(`  Last:  ${lastMatch.commence_time} (${lastMatch.home_team} vs ${lastMatch.away_team})\n`);

// ─── Collect all teams ───────────────────────────────────
const allTeams = new Set();
for (const [, setts] of fixtureSettlements) {
  for (const s of setts) allTeams.add(s.team_id);
}

// ─── League detection ────────────────────────────────────
const teamLeague = new Map();
for (const [fid, setts] of fixtureSettlements) {
  const match = matchMap.get(fid);
  if (match) {
    for (const s of setts) {
      teamLeague.set(s.team_id, match.league);
    }
  }
}

// ─── Compute dispersion statistics ───────────────────────
const dispersionValues = [...allTeams]
  .map(t => ODDS_DISPERSION[t] ?? null)
  .filter(v => v !== null);

const dispMean = dispersionValues.reduce((s, v) => s + v, 0) / dispersionValues.length;
const dispStd = Math.sqrt(dispersionValues.reduce((s, v) => s + (v - dispMean) ** 2, 0) / dispersionValues.length);
const dispMin = Math.min(...dispersionValues);
const dispMax = Math.max(...dispersionValues);

console.log("=== ODDS DISPERSION STATISTICS ===");
console.log(`  Mean:   ${r2(dispMean * 1000)} (x1000)`);
console.log(`  Std:    ${r2(dispStd * 1000)} (x1000)`);
console.log(`  Min:    ${r2(dispMin * 1000)} (x1000) — bookmakers most agree`);
console.log(`  Max:    ${r2(dispMax * 1000)} (x1000) — bookmakers most disagree`);
console.log(`  Range:  ${r2((dispMax - dispMin) * 1000)} (x1000)\n`);

// ─── Compute volume statistics ───────────────────────────
const volumeValues = [...allTeams]
  .map(t => POLYMARKET_VOLUME[t] ?? null)
  .filter(v => v !== null && v > 0);

const volMean = volumeValues.reduce((s, v) => s + v, 0) / volumeValues.length;
const volMax = Math.max(...volumeValues);
const volMin = Math.min(...volumeValues.filter(v => v > 0));

console.log("=== POLYMARKET VOLUME STATISTICS ===");
console.log(`  Mean:   $${Math.round(volMean).toLocaleString()}`);
console.log(`  Min:    $${Math.round(volMin).toLocaleString()}`);
console.log(`  Max:    $${Math.round(volMax).toLocaleString()}`);
console.log(`  Teams with volume: ${volumeValues.length}\n`);

// ═══════════════════════════════════════════════════════════
// STRATEGY DEFINITIONS
// ═══════════════════════════════════════════════════════════

const GLOBAL_LAMBDA = 0.02;
const OFFSEASON_DAYS = 50; // approximate off-season duration

/**
 * Compute effective lambda for each team under each strategy.
 *
 * The off-season drift equation is:
 *   B_new = B_old + effective_total_drift * (R_target - B_old)
 *
 * For daily drift over N days:
 *   effective_total = 1 - (1 - lambda_daily)^N
 *
 * Strategy A: lambda_daily = 0.02 for all
 * Strategy B: lambda_daily = base * (1 + k * z_dispersion)
 *   where z_dispersion = (team_disp - mean_disp) / std_disp
 * Strategy C: lambda_daily = base * (1 + k * z_volume)
 *   where z_volume = (log(team_vol) - mean_log_vol) / std_log_vol
 */

function computeLambdaB(teamId) {
  const disp = ODDS_DISPERSION[teamId];
  if (disp === undefined) return GLOBAL_LAMBDA; // fallback

  // Normalize dispersion to z-score
  const z = (disp - dispMean) / dispStd;

  // Scale factor: k=0.5 means a team 1 std above mean gets 50% higher lambda
  const k = 0.5;
  const lambda = GLOBAL_LAMBDA * (1 + k * z);

  // Clamp to reasonable range [0.005, 0.05]
  return Math.max(0.005, Math.min(0.05, lambda));
}

function computeLambdaC(teamId) {
  const vol = POLYMARKET_VOLUME[teamId];
  if (!vol || vol <= 0) return GLOBAL_LAMBDA * 0.5; // low confidence fallback

  // Use log-volume for normalization (volume is very skewed)
  const logVol = Math.log(vol);
  const logVols = volumeValues.map(v => Math.log(v));
  const logMean = logVols.reduce((s, v) => s + v, 0) / logVols.length;
  const logStd = Math.sqrt(logVols.reduce((s, v) => s + (v - logMean) ** 2, 0) / logVols.length);

  const z = (logVol - logMean) / logStd;

  // k=0.4: a team 1 std above mean log-volume gets 40% higher lambda
  const k = 0.4;
  const lambda = GLOBAL_LAMBDA * (1 + k * z);

  return Math.max(0.005, Math.min(0.05, lambda));
}

// ─── Print per-team lambda comparison ────────────────────
console.log("=== PER-TEAM LAMBDA COMPARISON ===");
console.log(
  "Team".padEnd(30) +
  "League".padEnd(18) +
  "Disp(x1k)".padStart(12) +
  "Vol($k)".padStart(12) +
  "Lam_A".padStart(8) +
  "Lam_B".padStart(8) +
  "Lam_C".padStart(8)
);
console.log("-".repeat(96));

const sampleTeams = [
  "Arsenal", "Liverpool", "Manchester City", "Chelsea", "Tottenham",
  "Manchester United", "Nottingham Forest", "Bournemouth",
  "Bayern München", "Bayer Leverkusen", "Borussia Dortmund",
  "Real Madrid", "Barcelona", "Atletico Madrid",
  "Inter", "Napoli", "AC Milan", "Juventus",
  "Paris Saint Germain", "Marseille", "Monaco",
  "FC St. Pauli", "Burnley", "Sunderland",
];

for (const team of sampleTeams) {
  if (allTeams.has(team)) {
    const disp = ODDS_DISPERSION[team] ?? 0;
    const vol = POLYMARKET_VOLUME[team] ?? 0;
    const lamA = GLOBAL_LAMBDA;
    const lamB = computeLambdaB(team);
    const lamC = computeLambdaC(team);
    console.log(
      team.padEnd(30) +
      (teamLeague.get(team) || "?").padEnd(18) +
      (r2(disp * 1000)).toString().padStart(12) +
      Math.round(vol / 1000).toString().padStart(12) +
      lamA.toFixed(3).padStart(8) +
      lamB.toFixed(3).padStart(8) +
      lamC.toFixed(3).padStart(8)
    );
  }
}

// ═══════════════════════════════════════════════════════════
// BUILD SEED VECTORS (with off-season drift applied)
// ═══════════════════════════════════════════════════════════

console.log("\n=== BUILDING SEED VECTORS WITH OFF-SEASON DRIFT ===\n");

// For each strategy, start from the oracle initial seed (polymarket-derived)
// and drift toward ClubElo as R_target.

function effectiveDrift(lambdaDaily, days) {
  // Total fraction of gap closed after N days of exponential drift
  return 1 - Math.pow(1 - lambdaDaily, days);
}

// Strategy A: Global lambda = 0.02
const seedA = new Map();
const driftInfoA = [];
for (const team of allTeams) {
  const B_start = initialSeeds.get(team) ?? 1500;
  const R_target = clubeloMapped.get(team);
  if (R_target !== undefined) {
    const totalDrift = effectiveDrift(GLOBAL_LAMBDA, OFFSEASON_DAYS);
    const B_new = B_start + totalDrift * (R_target - B_start);
    seedA.set(team, B_new);
    driftInfoA.push({ team, B_start, R_target, B_new, lambda: GLOBAL_LAMBDA, totalDrift: r2(totalDrift), delta: r1(B_new - B_start) });
  } else {
    seedA.set(team, B_start);
  }
}

// Strategy B: Per-team lambda from odds dispersion
const seedB = new Map();
const driftInfoB = [];
for (const team of allTeams) {
  const B_start = initialSeeds.get(team) ?? 1500;
  const R_target = clubeloMapped.get(team);
  if (R_target !== undefined) {
    const lambdaDaily = computeLambdaB(team);
    const totalDrift = effectiveDrift(lambdaDaily, OFFSEASON_DAYS);
    const B_new = B_start + totalDrift * (R_target - B_start);
    seedB.set(team, B_new);
    driftInfoB.push({ team, B_start, R_target, B_new, lambda: r2(lambdaDaily * 1000) / 1000, totalDrift: r2(totalDrift), delta: r1(B_new - B_start) });
  } else {
    seedB.set(team, B_start);
  }
}

// Strategy C: Per-team lambda from Polymarket volume
const seedC = new Map();
const driftInfoC = [];
for (const team of allTeams) {
  const B_start = initialSeeds.get(team) ?? 1500;
  const R_target = clubeloMapped.get(team);
  if (R_target !== undefined) {
    const lambdaDaily = computeLambdaC(team);
    const totalDrift = effectiveDrift(lambdaDaily, OFFSEASON_DAYS);
    const B_new = B_start + totalDrift * (R_target - B_start);
    seedC.set(team, B_new);
    driftInfoC.push({ team, B_start, R_target, B_new, lambda: r2(lambdaDaily * 1000) / 1000, totalDrift: r2(totalDrift), delta: r1(B_new - B_start) });
  } else {
    seedC.set(team, B_start);
  }
}

// ─── Print drift comparison for sample teams ─────────────
console.log("Drift applied (50-day off-season, target = ClubElo):");
console.log(
  "Team".padEnd(30) +
  "B_seed".padStart(10) +
  "R_elo".padStart(10) +
  "B_A".padStart(10) +
  "B_B".padStart(10) +
  "B_C".padStart(10) +
  "dA".padStart(8) +
  "dB".padStart(8) +
  "dC".padStart(8)
);
console.log("-".repeat(104));

for (const team of sampleTeams) {
  if (seedA.has(team) && clubeloMapped.has(team)) {
    const B0 = initialSeeds.get(team) ?? 1500;
    const Re = clubeloMapped.get(team);
    console.log(
      team.padEnd(30) +
      r1(B0).toString().padStart(10) +
      r1(Re).toString().padStart(10) +
      r1(seedA.get(team)).toString().padStart(10) +
      r1(seedB.get(team)).toString().padStart(10) +
      r1(seedC.get(team)).toString().padStart(10) +
      r1(seedA.get(team) - B0).toString().padStart(8) +
      r1(seedB.get(team) - B0).toString().padStart(8) +
      r1(seedC.get(team) - B0).toString().padStart(8)
    );
  }
}

// Also add a "no drift" baseline (Strategy 0)
const seed0 = new Map();
for (const team of allTeams) {
  seed0.set(team, initialSeeds.get(team) ?? 1500);
}

// ═══════════════════════════════════════════════════════════
// SIMULATION ENGINE
// ═══════════════════════════════════════════════════════════

function runSimulation(label, seedVector) {
  const teamStates = new Map();
  for (const [team, b] of seedVector) {
    teamStates.set(team, {
      b: b,
      initialB: b,
      settlements: 0,
      m1History: [],
      absM1History: [],
    });
  }

  for (const fixtureId of fixtureOrder) {
    const setts = fixtureSettlements.get(fixtureId);
    if (!setts || setts.length < 2) continue;

    const match = matchMap.get(fixtureId);
    const kr = krMap.get(fixtureId);
    if (!match || !kr) continue;

    const homeSett = setts.find(s => s.team_id === match.home_team);
    const awaySett = setts.find(s => s.team_id === match.away_team);
    if (!homeSett || !awaySett) continue;

    const homeState = teamStates.get(match.home_team);
    const awayState = teamStates.get(match.away_team);
    if (!homeState || !awayState) continue;

    const E_KR_home = Number(kr.home_expected_score);
    const E_KR_away = Number(kr.away_expected_score);

    const R_market_home = oddsImpliedStrength(E_KR_home, awayState.b, true);
    const R_market_away = oddsImpliedStrength(E_KR_away, homeState.b, false);

    for (const { team, E_KR, R_market, S } of [
      { team: match.home_team, E_KR: E_KR_home, R_market: R_market_home, S: Number(homeSett.actual_score_s) },
      { team: match.away_team, E_KR: E_KR_away, R_market: R_market_away, S: Number(awaySett.actual_score_s) },
    ]) {
      const state = teamStates.get(team);
      if (!state) continue;

      const m1 = R_market - state.b;
      const deltaB = K * (S - E_KR);
      state.b += deltaB;
      state.settlements++;
      state.m1History.push(m1);
      state.absM1History.push(Math.abs(m1));
    }
  }

  return teamStates;
}

// ─── Run all simulations ─────────────────────────────────
console.log("\n=== RUNNING SIMULATIONS ===\n");

const strategies = [
  { label: "0: No Drift (baseline)", seeds: seed0 },
  { label: "A: Global λ=0.02", seeds: seedA },
  { label: "B: Dispersion λ", seeds: seedB },
  { label: "C: Volume λ", seeds: seedC },
];

const results = strategies.map(s => {
  console.log(`  Running ${s.label}...`);
  const teamStates = runSimulation(s.label, s.seeds);
  return { label: s.label, teamStates };
});

// ═══════════════════════════════════════════════════════════
// ANALYSIS
// ═══════════════════════════════════════════════════════════

console.log("\n=== RESULTS ===\n");

// ─── Milestone table ─────────────────────────────────────
const milestones = [5, 10, 15, 20, 25, 30];

function getMetricsAtMilestone(teamStates, matchNum) {
  const values = [];
  for (const [team, state] of teamStates) {
    if (state.absM1History.length >= matchNum) {
      const windowAbsM1 = state.absM1History.slice(0, matchNum);
      const avg = windowAbsM1.reduce((s, v) => s + v, 0) / windowAbsM1.length;
      values.push({ team, avg });
    }
  }
  values.sort((a, b) => a.avg - b.avg);
  const absAvgs = values.map(v => v.avg);
  const n = absAvgs.length;
  const mean = absAvgs.reduce((s, v) => s + v, 0) / n;
  const median = absAvgs[Math.floor(n / 2)];
  const worst20pct = absAvgs.slice(Math.floor(n * 0.8));
  const outlierMean = worst20pct.reduce((s, v) => s + v, 0) / worst20pct.length;

  // Spot M1 at this match number
  const spotAbsM1 = [];
  for (const [, state] of teamStates) {
    if (state.absM1History.length >= matchNum) {
      spotAbsM1.push(state.absM1History[matchNum - 1]);
    }
  }
  const spotMean = spotAbsM1.reduce((s, v) => s + v, 0) / spotAbsM1.length;

  return { mean: r2(mean), median: r2(median), outlierMean: r2(outlierMean), spotMean: r2(spotMean), n };
}

console.log("--- Mean |M1| Over Time (cumulative average up to match N) ---");
console.log("Match#".padEnd(10) + strategies.map(s => s.label.padStart(22)).join(""));
console.log("-".repeat(10 + strategies.length * 22));

for (const ms of milestones) {
  const row = [ms.toString().padEnd(10)];
  for (const r of results) {
    const m = getMetricsAtMilestone(r.teamStates, ms);
    row.push(`${m.mean} (n=${m.n})`.padStart(22));
  }
  console.log(row.join(""));
}

// Spot M1 table
console.log("\n--- Spot |M1| at Match N (instantaneous) ---");
console.log("Match#".padEnd(10) + strategies.map(s => s.label.padStart(22)).join(""));
console.log("-".repeat(10 + strategies.length * 22));

for (const ms of milestones) {
  const row = [ms.toString().padEnd(10)];
  for (const r of results) {
    const m = getMetricsAtMilestone(r.teamStates, ms);
    row.push(`${m.spotMean}`.padStart(22));
  }
  console.log(row.join(""));
}

// Outlier table
console.log("\n--- Outlier Mean |M1| (worst 20% of teams) ---");
console.log("Match#".padEnd(10) + strategies.map(s => s.label.padStart(22)).join(""));
console.log("-".repeat(10 + strategies.length * 22));

for (const ms of milestones) {
  const row = [ms.toString().padEnd(10)];
  for (const r of results) {
    const m = getMetricsAtMilestone(r.teamStates, ms);
    row.push(`${m.outlierMean}`.padStart(22));
  }
  console.log(row.join(""));
}

// ─── Full season summary ─────────────────────────────────
console.log("\n--- Full Season Summary ---");
console.log(
  "Strategy".padEnd(25) +
  "Mean|M1|".padStart(12) +
  "Med|M1|".padStart(12) +
  "Outlier".padStart(12) +
  ">60".padStart(8) +
  ">80".padStart(8) +
  ">100".padStart(8)
);
console.log("-".repeat(89));

const summaries = [];
for (const r of results) {
  const teamAvgs = [];
  for (const [team, state] of r.teamStates) {
    if (state.settlements > 0) {
      const avg = state.absM1History.reduce((s, v) => s + v, 0) / state.absM1History.length;
      teamAvgs.push({ team, avg });
    }
  }

  const avgs = teamAvgs.map(t => t.avg).sort((a, b) => a - b);
  const n = avgs.length;
  const mean = avgs.reduce((s, v) => s + v, 0) / n;
  const median = avgs[Math.floor(n / 2)];
  const worst20 = avgs.slice(Math.floor(n * 0.8));
  const outlierMean = worst20.reduce((s, v) => s + v, 0) / worst20.length;
  const over60 = avgs.filter(v => v > 60).length;
  const over80 = avgs.filter(v => v > 80).length;
  const over100 = avgs.filter(v => v > 100).length;

  summaries.push({ label: r.label, mean: r2(mean), median: r2(median), outlierMean: r2(outlierMean), over60, over80, over100, n });

  console.log(
    r.label.padEnd(25) +
    r2(mean).toString().padStart(12) +
    r2(median).toString().padStart(12) +
    r2(outlierMean).toString().padStart(12) +
    over60.toString().padStart(8) +
    over80.toString().padStart(8) +
    over100.toString().padStart(8)
  );
}

// ─── Per-league breakdown ────────────────────────────────
console.log("\n--- Per-League Mean |M1| ---");
const leagues = ["Premier League", "Bundesliga", "La Liga", "Serie A", "Ligue 1"];

console.log("League".padEnd(20) + strategies.map(s => s.label.padStart(22)).join(""));
console.log("-".repeat(20 + strategies.length * 22));

for (const league of leagues) {
  const row = [league.padEnd(20)];
  for (const r of results) {
    const leagueAvgs = [];
    for (const [team, state] of r.teamStates) {
      if (teamLeague.get(team) === league && state.settlements > 0) {
        const avg = state.absM1History.reduce((s, v) => s + v, 0) / state.absM1History.length;
        leagueAvgs.push(avg);
      }
    }
    const mean = leagueAvgs.length > 0 ? leagueAvgs.reduce((s, v) => s + v, 0) / leagueAvgs.length : 0;
    row.push(`${r2(mean)} (n=${leagueAvgs.length})`.padStart(22));
  }
  console.log(row.join(""));
}

// ─── Per-team comparison: B vs A ─────────────────────────
console.log("\n--- Per-Team: Dispersion Lambda (B) vs Global Lambda (A) ---");
console.log("(Showing teams where B differs most from A)\n");

const teamComparisons = [];
for (const team of allTeams) {
  const state0 = results[0].teamStates.get(team);
  const stateA = results[1].teamStates.get(team);
  const stateB = results[2].teamStates.get(team);
  const stateC = results[3].teamStates.get(team);
  if (!stateA || !stateB || !stateC || !state0 || stateA.settlements === 0) continue;

  const avg0 = state0.absM1History.reduce((s, v) => s + v, 0) / state0.absM1History.length;
  const avgA = stateA.absM1History.reduce((s, v) => s + v, 0) / stateA.absM1History.length;
  const avgB = stateB.absM1History.reduce((s, v) => s + v, 0) / stateB.absM1History.length;
  const avgC = stateC.absM1History.reduce((s, v) => s + v, 0) / stateC.absM1History.length;

  const bestIdx = [avg0, avgA, avgB, avgC].indexOf(Math.min(avg0, avgA, avgB, avgC));
  const bestLabel = ["0", "A", "B", "C"][bestIdx];

  teamComparisons.push({
    team,
    league: teamLeague.get(team) || "?",
    avg0: r1(avg0),
    avgA: r1(avgA),
    avgB: r1(avgB),
    avgC: r1(avgC),
    diffBA: r1(avgB - avgA),
    diffCA: r1(avgC - avgA),
    bestLabel,
    lambdaB: computeLambdaB(team),
    lambdaC: computeLambdaC(team),
    dispersion: ODDS_DISPERSION[team] ?? null,
    volume: POLYMARKET_VOLUME[team] ?? null,
    settlements: stateA.settlements,
  });
}

teamComparisons.sort((a, b) => a.diffBA - b.diffBA);

console.log("Teams where Dispersion-Lambda BEATS Global Lambda (negative = B better):");
console.log(
  "Team".padEnd(28) +
  "League".padEnd(16) +
  "|M1|_A".padStart(10) +
  "|M1|_B".padStart(10) +
  "Diff".padStart(8) +
  "lam_B".padStart(8) +
  "Disp".padStart(10) +
  "Best".padStart(6)
);
console.log("-".repeat(96));

for (const tc of teamComparisons.slice(0, 12)) {
  console.log(
    tc.team.padEnd(28) +
    tc.league.padEnd(16) +
    tc.avgA.toString().padStart(10) +
    tc.avgB.toString().padStart(10) +
    tc.diffBA.toString().padStart(8) +
    tc.lambdaB.toFixed(3).padStart(8) +
    ((tc.dispersion ?? 0) * 1000).toFixed(1).padStart(10) +
    tc.bestLabel.padStart(6)
  );
}

console.log("\nTeams where Global Lambda BEATS Dispersion-Lambda (positive = A better):");
console.log(
  "Team".padEnd(28) +
  "League".padEnd(16) +
  "|M1|_A".padStart(10) +
  "|M1|_B".padStart(10) +
  "Diff".padStart(8) +
  "lam_B".padStart(8) +
  "Disp".padStart(10) +
  "Best".padStart(6)
);
console.log("-".repeat(96));

for (const tc of teamComparisons.slice(-12).reverse()) {
  console.log(
    tc.team.padEnd(28) +
    tc.league.padEnd(16) +
    tc.avgA.toString().padStart(10) +
    tc.avgB.toString().padStart(10) +
    tc.diffBA.toString().padStart(8) +
    tc.lambdaB.toFixed(3).padStart(8) +
    ((tc.dispersion ?? 0) * 1000).toFixed(1).padStart(10) +
    tc.bestLabel.padStart(6)
  );
}

// ─── Win count ───────────────────────────────────────────
const wins0 = teamComparisons.filter(tc => tc.bestLabel === "0").length;
const winsA = teamComparisons.filter(tc => tc.bestLabel === "A").length;
const winsB = teamComparisons.filter(tc => tc.bestLabel === "B").length;
const winsC = teamComparisons.filter(tc => tc.bestLabel === "C").length;
console.log(`\nWin count (best strategy per team): 0=${wins0}, A=${winsA}, B=${winsB}, C=${winsC} out of ${teamComparisons.length}`);

// ─── Early season analysis ───────────────────────────────
console.log("\n--- Early Season Analysis (first 10 matches) ---");
console.log(
  "Strategy".padEnd(25) +
  "Mean|M1|".padStart(12) +
  "Med|M1|".padStart(12) +
  "Outlier20%".padStart(14) +
  ">60".padStart(8) +
  ">80".padStart(8)
);
console.log("-".repeat(79));

for (const r of results) {
  const earlyAvgs = [];
  for (const [, state] of r.teamStates) {
    const n = Math.min(10, state.absM1History.length);
    if (n > 0) {
      const avg = state.absM1History.slice(0, n).reduce((s, v) => s + v, 0) / n;
      earlyAvgs.push(avg);
    }
  }
  earlyAvgs.sort((a, b) => a - b);
  const nE = earlyAvgs.length;
  const mean = earlyAvgs.reduce((s, v) => s + v, 0) / nE;
  const median = earlyAvgs[Math.floor(nE / 2)];
  const worst20 = earlyAvgs.slice(Math.floor(nE * 0.8));
  const outlierMean = worst20.reduce((s, v) => s + v, 0) / worst20.length;
  const over60 = earlyAvgs.filter(v => v > 60).length;
  const over80 = earlyAvgs.filter(v => v > 80).length;

  console.log(
    r.label.padEnd(25) +
    r2(mean).toString().padStart(12) +
    r2(median).toString().padStart(12) +
    r2(outlierMean).toString().padStart(14) +
    over60.toString().padStart(8) +
    over80.toString().padStart(8)
  );
}

// ─── Lambda sensitivity sweep ────────────────────────────
console.log("\n--- Lambda Sensitivity: Dispersion Strategy with Different k Values ---");
console.log("(k controls how much dispersion affects lambda: lambda = base * (1 + k * z))");
console.log(
  "k".padEnd(8) +
  "Mean|M1|".padStart(12) +
  "Med|M1|".padStart(12) +
  "Outlier".padStart(12) +
  "Early10".padStart(12) +
  "Wins".padStart(8)
);
console.log("-".repeat(64));

for (const kVal of [0.0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0]) {
  // Build seeds with this k
  const seedK = new Map();
  for (const team of allTeams) {
    const B_start = initialSeeds.get(team) ?? 1500;
    const R_target = clubeloMapped.get(team);
    if (R_target !== undefined) {
      const disp = ODDS_DISPERSION[team];
      let lambdaDaily = GLOBAL_LAMBDA;
      if (disp !== undefined) {
        const z = (disp - dispMean) / dispStd;
        lambdaDaily = GLOBAL_LAMBDA * (1 + kVal * z);
        lambdaDaily = Math.max(0.005, Math.min(0.05, lambdaDaily));
      }
      const totalDrift = effectiveDrift(lambdaDaily, OFFSEASON_DAYS);
      seedK.set(team, B_start + totalDrift * (R_target - B_start));
    } else {
      seedK.set(team, B_start);
    }
  }

  const statesK = runSimulation(`k=${kVal}`, seedK);

  // Compute metrics
  const teamAvgs = [];
  for (const [, state] of statesK) {
    if (state.settlements > 0) {
      const avg = state.absM1History.reduce((s, v) => s + v, 0) / state.absM1History.length;
      teamAvgs.push(avg);
    }
  }
  const avgs = teamAvgs.sort((a, b) => a - b);
  const mean = avgs.reduce((s, v) => s + v, 0) / avgs.length;
  const median = avgs[Math.floor(avgs.length / 2)];
  const worst20 = avgs.slice(Math.floor(avgs.length * 0.8));
  const outlier = worst20.reduce((s, v) => s + v, 0) / worst20.length;

  // Early season
  const earlyAvgs = [];
  for (const [, state] of statesK) {
    const n = Math.min(10, state.absM1History.length);
    if (n > 0) {
      earlyAvgs.push(state.absM1History.slice(0, n).reduce((s, v) => s + v, 0) / n);
    }
  }
  const earlyMean = earlyAvgs.reduce((s, v) => s + v, 0) / earlyAvgs.length;

  // Win count vs global (stateA)
  let wins = 0;
  for (const [team, state] of statesK) {
    const stateA = results[1].teamStates.get(team);
    if (stateA && state.settlements > 0 && stateA.settlements > 0) {
      const avgK = state.absM1History.reduce((s, v) => s + v, 0) / state.absM1History.length;
      const avgAteam = stateA.absM1History.reduce((s, v) => s + v, 0) / stateA.absM1History.length;
      if (avgK < avgAteam) wins++;
    }
  }

  console.log(
    kVal.toFixed(2).padEnd(8) +
    r2(mean).toString().padStart(12) +
    r2(median).toString().padStart(12) +
    r2(outlier).toString().padStart(12) +
    r2(earlyMean).toString().padStart(12) +
    `${wins}/${teamAvgs.length}`.padStart(8)
  );
}

// ─── Volume lambda sensitivity sweep ─────────────────────
console.log("\n--- Lambda Sensitivity: Volume Strategy with Different k Values ---");
console.log(
  "k".padEnd(8) +
  "Mean|M1|".padStart(12) +
  "Med|M1|".padStart(12) +
  "Outlier".padStart(12) +
  "Early10".padStart(12) +
  "Wins".padStart(8)
);
console.log("-".repeat(64));

for (const kVal of [0.0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.5]) {
  const seedK = new Map();
  const logVols = volumeValues.map(v => Math.log(v));
  const logMean = logVols.reduce((s, v) => s + v, 0) / logVols.length;
  const logStd = Math.sqrt(logVols.reduce((s, v) => s + (v - logMean) ** 2, 0) / logVols.length);

  for (const team of allTeams) {
    const B_start = initialSeeds.get(team) ?? 1500;
    const R_target = clubeloMapped.get(team);
    if (R_target !== undefined) {
      const vol = POLYMARKET_VOLUME[team];
      let lambdaDaily = GLOBAL_LAMBDA;
      if (vol && vol > 0) {
        const z = (Math.log(vol) - logMean) / logStd;
        lambdaDaily = GLOBAL_LAMBDA * (1 + kVal * z);
        lambdaDaily = Math.max(0.005, Math.min(0.05, lambdaDaily));
      } else {
        lambdaDaily = GLOBAL_LAMBDA * 0.5;
      }
      const totalDrift = effectiveDrift(lambdaDaily, OFFSEASON_DAYS);
      seedK.set(team, B_start + totalDrift * (R_target - B_start));
    } else {
      seedK.set(team, B_start);
    }
  }

  const statesK = runSimulation(`vol_k=${kVal}`, seedK);

  const teamAvgs = [];
  for (const [, state] of statesK) {
    if (state.settlements > 0) {
      const avg = state.absM1History.reduce((s, v) => s + v, 0) / state.absM1History.length;
      teamAvgs.push(avg);
    }
  }
  const avgs = teamAvgs.sort((a, b) => a - b);
  const mean = avgs.reduce((s, v) => s + v, 0) / avgs.length;
  const median = avgs[Math.floor(avgs.length / 2)];
  const worst20 = avgs.slice(Math.floor(avgs.length * 0.8));
  const outlier = worst20.reduce((s, v) => s + v, 0) / worst20.length;

  const earlyAvgs = [];
  for (const [, state] of statesK) {
    const n = Math.min(10, state.absM1History.length);
    if (n > 0) {
      earlyAvgs.push(state.absM1History.slice(0, n).reduce((s, v) => s + v, 0) / n);
    }
  }
  const earlyMean = earlyAvgs.reduce((s, v) => s + v, 0) / earlyAvgs.length;

  let wins = 0;
  for (const [team, state] of statesK) {
    const stateA = results[1].teamStates.get(team);
    if (stateA && state.settlements > 0 && stateA.settlements > 0) {
      const avgK = state.absM1History.reduce((s, v) => s + v, 0) / state.absM1History.length;
      const avgAteam = stateA.absM1History.reduce((s, v) => s + v, 0) / stateA.absM1History.length;
      if (avgK < avgAteam) wins++;
    }
  }

  console.log(
    kVal.toFixed(2).padEnd(8) +
    r2(mean).toString().padStart(12) +
    r2(median).toString().padStart(12) +
    r2(outlier).toString().padStart(12) +
    r2(earlyMean).toString().padStart(12) +
    `${wins}/${teamAvgs.length}`.padStart(8)
  );
}

// ─── Correlation analysis ────────────────────────────────
console.log("\n--- Correlation: Does dispersion predict which teams benefit from drift? ---");

// For each team, compute: improvement from drift (|M1|_noDrift - |M1|_globalDrift)
// Then correlate with dispersion
const corrData = [];
for (const tc of teamComparisons) {
  if (tc.dispersion !== null) {
    const improvement0A = tc.avg0 - tc.avgA; // positive = drift helped
    const improvementAB = tc.avgA - tc.avgB; // positive = dispersion lambda helped over global
    corrData.push({
      team: tc.team,
      dispersion: tc.dispersion,
      improvement0A,
      improvementAB,
    });
  }
}

// Pearson correlation
function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  return num / Math.sqrt(dx2 * dy2);
}

const dispValues = corrData.map(d => d.dispersion);
const imp0A = corrData.map(d => d.improvement0A);
const impAB = corrData.map(d => d.improvementAB);

console.log(`  r(dispersion, drift_benefit):     ${r2(pearson(dispValues, imp0A))}`);
console.log(`  r(dispersion, B_over_A_benefit):   ${r2(pearson(dispValues, impAB))}`);

// Volume correlation
const corrDataV = [];
for (const tc of teamComparisons) {
  if (tc.volume !== null && tc.volume > 0) {
    const improvement0A = tc.avg0 - tc.avgA;
    const improvementAC = tc.avgA - tc.avgC;
    corrDataV.push({
      team: tc.team,
      logVolume: Math.log(tc.volume),
      improvement0A,
      improvementAC,
    });
  }
}

if (corrDataV.length > 5) {
  const logVolValues = corrDataV.map(d => d.logVolume);
  const imp0AV = corrDataV.map(d => d.improvement0A);
  const impACV = corrDataV.map(d => d.improvementAC);
  console.log(`  r(log_volume, drift_benefit):     ${r2(pearson(logVolValues, imp0AV))}`);
  console.log(`  r(log_volume, C_over_A_benefit):   ${r2(pearson(logVolValues, impACV))}`);
}

// ─── Save results ────────────────────────────────────────
const outputData = {
  metadata: {
    description: "Per-team lambda vs global lambda off-season drift simulation",
    offseason_days: OFFSEASON_DAYS,
    global_lambda: GLOBAL_LAMBDA,
    dispersion_k: 0.5,
    volume_k: 0.4,
    drift_target: "ClubElo summer 2025",
  },
  dispersion_stats: {
    mean: r2(dispMean * 1000),
    std: r2(dispStd * 1000),
    min: r2(dispMin * 1000),
    max: r2(dispMax * 1000),
  },
  summaries,
  team_comparisons: teamComparisons,
  per_team_lambdas: [...allTeams].map(t => ({
    team: t,
    lambda_global: GLOBAL_LAMBDA,
    lambda_dispersion: r2(computeLambdaB(t) * 1000) / 1000,
    lambda_volume: r2(computeLambdaC(t) * 1000) / 1000,
    dispersion: ODDS_DISPERSION[t] ?? null,
    volume: POLYMARKET_VOLUME[t] ?? null,
  })),
};

fs.writeFileSync(
  path.join(RESULTS_DIR, "lambda_dispersion_comparison.json"),
  JSON.stringify(outputData, null, 2)
);
console.log(`\nResults saved to ${RESULTS_DIR}/lambda_dispersion_comparison.json`);

// ═══════════════════════════════════════════════════════════
// FINAL VERDICT
// ═══════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(70));
console.log("                         FINAL VERDICT");
console.log("=".repeat(70) + "\n");

for (const s of summaries) {
  console.log(`  ${s.label}: Mean |M1| = ${s.mean}, Median = ${s.median}, Outlier = ${s.outlierMean}`);
}

const best = summaries.reduce((b, s) => s.mean < b.mean ? s : b);
const bestEarly = (() => {
  let bestLabel = "";
  let bestMean = Infinity;
  for (const r of results) {
    const earlyAvgs = [];
    for (const [, state] of r.teamStates) {
      const n = Math.min(10, state.absM1History.length);
      if (n > 0) earlyAvgs.push(state.absM1History.slice(0, n).reduce((s, v) => s + v, 0) / n);
    }
    const mean = earlyAvgs.reduce((s, v) => s + v, 0) / earlyAvgs.length;
    if (mean < bestMean) { bestMean = mean; bestLabel = r.label; }
  }
  return { label: bestLabel, mean: r2(bestMean) };
})();

console.log(`\n  BEST (Full Season):  ${best.label} (Mean |M1| = ${best.mean})`);
console.log(`  BEST (Early Season): ${bestEarly.label} (Mean |M1| = ${bestEarly.mean})`);
console.log(`  Win count: 0=${wins0}, A=${winsA}, B=${winsB}, C=${winsC}`);

const diffBA = r2(summaries[2].mean - summaries[1].mean);
const diffCA = r2(summaries[3].mean - summaries[1].mean);
console.log(`\n  Delta (Dispersion vs Global):  ${diffBA > 0 ? "+" : ""}${diffBA}`);
console.log(`  Delta (Volume vs Global):      ${diffCA > 0 ? "+" : ""}${diffCA}`);

if (diffBA < -0.5) {
  console.log("\n  => Dispersion-based lambda OUTPERFORMS global lambda.");
  console.log("     Teams with high bookmaker disagreement benefit from faster drift.");
} else if (diffBA > 0.5) {
  console.log("\n  => Global lambda OUTPERFORMS dispersion-based lambda.");
  console.log("     Uniform drift speed is more robust than dispersion-adaptive.");
} else {
  console.log("\n  => Dispersion-based lambda is SIMILAR to global lambda.");
  console.log("     The signal from odds dispersion does not significantly improve drift.");
}

if (diffCA < -0.5) {
  console.log("  => Volume-based lambda OUTPERFORMS global lambda.");
} else if (diffCA > 0.5) {
  console.log("  => Global lambda OUTPERFORMS volume-based lambda.");
} else {
  console.log("  => Volume-based lambda is SIMILAR to global lambda.");
}

console.log("\nDone.");
