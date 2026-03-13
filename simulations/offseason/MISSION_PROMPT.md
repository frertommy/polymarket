# Off-Season B-Layer Seeding Research — Mission Prompt

## Context You Need to Know

You're working on a soccer oracle that prices 122 teams across 5 leagues (EPL, La Liga, Bundesliga, Serie A, Ligue 1) as perpetual contracts. The oracle has a B-layer (permanent strength rating, ELO-based) that was seeded in August 2025 from last season's final ELO ratings. For ~25 teams, this seed is wrong by 100-120+ ELO points because of promotions, relegations, transfers, manager changes, and squad overhauls during the June-August off-season.

The current formula (ΔB = 30 × (S − E_KR)) cannot self-correct because E[ΔB] ≈ 0 by construction. The M1 layer (market overlay) compensates but is clamped at ±120, so many teams are pinned at the cap.

### The Key Question

**Can proper off-season B seeding reduce the worst outlier teams' |M1| below 60, without any formula changes to the in-season settlement?**

### What's Already Been Tested

A previous simulation suite (`simulations/oracle-sim-suite.ts`) tested 60+ scenarios:
- **Baseline K=30**: Mean|M1| = 95, top15_mean = 90.75
- **DynSeed + K=30** (reseed from first fixture R_market): Mean|M1| = 85.73 — only 10% improvement
- **Gravity λ=0.08 clamped** (no reseed): Mean|M1| = 32.75 — the current best
- **DynSeed + Gravity λ=0.08**: Mean|M1| = 31.29 — marginal improvement over gravity alone

The "DynSeed" used the first fixture's R_market only. Your job is to test whether **richer** off-season data sources produce better seeds.

### Available Data Sources

1. **Supabase Database** (access via MCP tools):
   - `team_oracle_state`: 122 teams, current B, M1, published_index
   - `settlement_log`: 2,506 rows (1,253 fixtures × 2 teams), all with b_before, b_after, e_kr, actual_score_s, delta_b
   - `oracle_kr_snapshots`: 1,257 frozen pre-kickoff odds per fixture (home_expected_score, away_expected_score)
   - `odds_snapshots`: 5.8M rows, but only 44,925 before Aug 15, 2025 (earliest: Aug 2, 2025). **No June-July data in DB.**
   - `polymarket_futures`: 31,007 rows, but only from Feb 28, 2026+. **No pre-season polymarket data.**
   - `matches`: 4,765 finished matches across all 5 leagues, going back to Aug 2023
   - `latest_preko_odds`, `latest_odds`: serving tables for current odds

2. **The Odds API** (Mega plan, 5M credits/month):
   - Historical odds endpoint: `GET /v4/historical/sports/{key}/odds/?apiKey=...&regions=eu,uk&markets=outrights&date={iso}`
   - Outright sport keys: `soccer_epl_winner`, `soccer_spain_la_liga_winner`, `soccer_germany_bundesliga_winner`, `soccer_italy_serie_a_winner`, `soccer_france_ligue_one_winner`
   - Match odds sport keys: `soccer_epl`, `soccer_spain_la_liga`, `soccer_germany_bundesliga`, `soccer_italy_serie_a`, `soccer_france_ligue_one`
   - **IMPORTANT**: Check credit usage with `GET /v4/sports/?apiKey=...` (returns remaining credits in headers). Historical queries cost more credits than live ones.
   - API Key is in the Railway scheduler environment as `ODDS_API_KEY`. To get it, use `mcp__railway-mcp-server__list-variables` with workspacePath `/Users/future/Desktop/MSI2026/scheduler` and service `scheduler`.

3. **API-Football** (Pro plan):
   - Previous season standings: `GET /v3/standings?league={id}&season=2024`
   - League IDs: EPL=39, La Liga=140, Bundesliga=78, Serie A=135, Ligue 1=61
   - API Key is in Railway env as `API_FOOTBALL_KEY`
   - Host: `v3.football.api-sports.io`, Header: `x-apisports-key: {key}`

4. **Existing Codebase** (local at `/Users/future/Desktop/MSI2026/`):
   - `simulations/oracle-sim-suite.ts`: Complete replay simulator, reusable
   - `scheduler/src/services/odds-blend.ts`: `powerDevigOdds()`, `median()`, `oddsImpliedStrength()` — core math
   - `scheduler/src/services/oracle-v1-settlement.ts`: Full settlement pipeline
   - `scheduler/src/services/oracle-v1-market.ts`: R_market derivation from match odds
   - `scheduler/src/data/team-aliases.json`: Team name mapping across sources
   - `scheduler/src/utils/team-names.ts`: Team name normalization utilities

### The 25 Worst Outlier Teams (from production)

| Team | seed_b | current_b | M1 | published_idx | gap |
|------|--------|-----------|-----|---------------|-----|
| Borussia Dortmund | 1694 | 1783 | -120 | 1663 | -120 |
| Villarreal | 1718 | 1797 | -120 | 1677 | -120 |
| Eintracht Frankfurt | 1658 | 1675 | -120 | 1555 | -120 |
| Udinese | 1432 | 1457 | +120 | 1577 | +120 |
| 1. FC Köln | 1415 | 1374 | +120 | 1494 | +120 |
| FC St. Pauli | 1426 | 1399 | +120 | 1519 | +120 |
| Elche | 1444 | 1442 | +120 | 1562 | +120 |
| Hellas Verona | 1446 | 1330 | +120 | 1450 | +120 |
| Leeds | 1485 | 1477 | +116 | 1593 | +116 |
| Manchester United | 1569 | 1622 | +115 | 1737 | +115 |
| Torino | 1505 | 1493 | +120 | 1606 | +113 |
| Aston Villa | 1779 | 1857 | -113 | 1745 | -113 |
| Sassuolo | 1388 | 1454 | +110 | 1564 | +110 |
| Crystal Palace | 1747 | 1738 | -105 | 1633 | -105 |
| Napoli | 1761 | 1810 | -108 | 1710 | -101 |

Key observations:
- Many of these are promoted/relegated teams (Köln, St. Pauli, Elche, Sassuolo, Leeds — promoted; Hellas Verona — poor performance)
- Some are teams that made massive transfers (Man United) or underperformed expectations (Aston Villa, Napoli, Borussia Dortmund)
- The M1 cap at ±120 means the market WANTS to push these further but can't

### Core Math Reference

```typescript
// Settlement: ΔB = K × (S − E_KR)
const delta_B = 30 * (actual_s - e_kr);

// Odds-implied strength (from odds-blend.ts):
function oddsImpliedStrength(teamExpectedScore, opponentElo, isHome, homeAdv) {
  const es = Math.max(0.01, Math.min(0.99, teamExpectedScore));
  const rawImplied = opponentElo + 400 * Math.log10(es / (1 - es));
  return isHome ? rawImplied - homeAdv : rawImplied + homeAdv;
}
// HOME_ADVANTAGE_ELO = 65

// Power de-vig: find k where (1/H)^k + (1/D)^k + (1/A)^k = 1
// Then probs are rH^k, rD^k, rA^k

// M1 = eff_conf × (R_market - B), clamped to ±120
// eff_conf = c_books × c_dispersion × c_recency × c_horizon
```

---

## YOUR MISSION

### Phase 1: Data Collection (Parallel)

Spawn agents to collect off-season data from multiple sources simultaneously.

**Agent 1 — The Odds API Historical Outrights:**
- First, get the API key from Railway: use `mcp__railway-mcp-server__list-variables` with workspacePath `/Users/future/Desktop/MSI2026/scheduler` and service `scheduler`
- Check remaining credits: `GET https://api.the-odds-api.com/v4/sports/?apiKey={key}` — check `x-requests-remaining` header
- Query historical outright odds for all 5 leagues at these dates: Jun 1, Jun 15, Jul 1, Jul 15, Aug 1, Aug 10, Aug 14 (2025)
  - `GET https://api.the-odds-api.com/v4/historical/sports/{sport_key}/odds/?apiKey={key}&regions=eu,uk&markets=outrights&date={YYYY-MM-DDTHH:MM:SSZ}`
  - Sport keys: `soccer_epl_winner`, `soccer_spain_la_liga_winner`, `soccer_germany_bundesliga_winner`, `soccer_italy_serie_a_winner`, `soccer_france_ligue_one_winner`
- **CREDIT SAFETY**: Start with ONE league, ONE date. Check credits remaining. If cost is >500 credits per call, reduce to 3 dates only. If >2000, abort and note findings.
- Save raw data to `/Users/future/Desktop/MSI2026/simulations/offseason/data/outrights/`
- For each result: extract team name, raw odds, implied probability (after de-vigging), bookmaker, date

**Agent 2 — The Odds API Historical Pre-Season Match Odds:**
- Same API key retrieval
- Query early-season match odds for Aug 1, 5, 10, 14 (2025)
  - `GET https://api.the-odds-api.com/v4/historical/sports/{sport_key}/odds/?apiKey={key}&regions=eu,uk&markets=h2h&date={YYYY-MM-DDTHH:MM:SSZ}`
  - Sport keys: `soccer_epl`, `soccer_spain_la_liga`, `soccer_germany_bundesliga`, `soccer_italy_serie_a`, `soccer_france_ligue_one`
- Extract: fixture, home_team, away_team, home_odds, draw_odds, away_odds, bookmaker
- Save to `/Users/future/Desktop/MSI2026/simulations/offseason/data/prematch/`

**Agent 3 — API-Football Previous Season Data:**
- Get API key from Railway (same method as Agent 1)
- Query 2024-25 final standings for all 5 leagues:
  - `GET https://v3.football.api-sports.io/standings?league={id}&season=2024` with header `x-apisports-key: {key}`
  - League IDs: 39, 140, 78, 135, 61
- Extract: team, rank, points, goal_difference, wins, draws, losses, goals_for, goals_against
- Also query 2023-24 final standings (season=2023) for the same leagues — this gives us TWO seasons of context
- Save to `/Users/future/Desktop/MSI2026/simulations/offseason/data/api_football/`

**Agent 4 — Mine Existing Supabase Data:**
- Extract all pre-Aug-15 odds from odds_snapshots:
  ```sql
  SELECT fixture_id, source, bookmaker, home_odds, draw_odds, away_odds, snapshot_time
  FROM odds_snapshots
  WHERE snapshot_time < '2025-08-15'
  ORDER BY snapshot_time ASC;
  ```
- Also extract the initial B seeds and settlement trajectory for each team:
  ```sql
  SELECT DISTINCT ON (team_id) team_id, b_before as seed_b
  FROM settlement_log ORDER BY team_id, settled_at ASC;
  ```
- And all settlement_log data for replay:
  ```sql
  SELECT fixture_id, team_id, e_kr, actual_score_s, delta_b, b_before, b_after, settled_at
  FROM settlement_log ORDER BY settled_at ASC;
  ```
- And all KR snapshots:
  ```sql
  SELECT fixture_id, home_expected_score, away_expected_score, bookmaker_count
  FROM oracle_kr_snapshots;
  ```
- And match details:
  ```sql
  SELECT fixture_id, home_team, away_team, league, date, score, status, commence_time
  FROM matches WHERE status = 'finished' ORDER BY date ASC;
  ```
- Save as JSON to `/Users/future/Desktop/MSI2026/simulations/offseason/data/supabase/`

### Phase 2: Convert Raw Data → Implied ELO per Team

For each data source that returned usable data, convert to comparable implied ELO values.

**Outright odds → ELO:**
1. Power de-vig the raw probabilities (use the powerDevigOdds approach — find k where sum of probs^k = 1)
2. For N teams in a league, use Bradley-Terry conversion:
   - Normalize de-vigged outright probabilities to sum to 1
   - Anchor: set league mean implied ELO = league mean seed_b (redistributing within league only)
   - For each team: `implied_elo = league_mean + 400 × log10(p_team / (1/N))` adjusted by a calibration factor
   - Alternative: use the known relationship that outright probability ratios correspond to ELO differences weighted by season length
3. The key calibration: a team at ~30% to win EPL (like Arsenal/Liverpool) should map to ~1850-1900. A team at 0.1% should map to ~1400-1500.

**Pre-season match odds → R_market:**
1. For each fixture, power de-vig the H/D/A odds
2. Compute team expected score = P(win) + 0.5 × P(draw)
3. Use oddsImpliedStrength(expectedScore, opponent_seed_b, isHome, 65) to get R_market
4. If a team has multiple early fixtures, average their R_market values

**Previous season standings → Adjusted ELO:**
1. Use final league position + goal difference as proxy for true strength
2. For promoted teams: `league_mean_elo - 75` (they're typically weaker than avg)
3. For relegated teams: remove or map to new league's distribution
4. Adjust ELO by points earned relative to expectation

### Phase 3: Generate Seed Candidates

Create these seed B vectors (one B value per team, per method):

1. **BASELINE**: Current actual seeds (first `b_before` from settlement_log). This is what we're trying to beat.
2. **OUTRIGHT_PURE**: B = outright-odds-implied ELO from latest pre-season snapshot (closest to Aug 15)
3. **OUTRIGHT_BLEND_50**: B = 0.5 × original_seed + 0.5 × outright_implied
4. **OUTRIGHT_BLEND_70**: B = 0.3 × original_seed + 0.7 × outright_implied
5. **PREMATCH_R**: B = R_market from first fixture odds (like existing DynSeed but with proper pre-season odds)
6. **PREMATCH_AVG**: B = average R_market across first 2-3 fixtures (if available)
7. **STANDINGS_ADJUSTED**: B = standings-based adjusted seed with promotion/relegation handling
8. **BEST_BLEND**: B = 0.5 × outright + 0.3 × prematch + 0.2 × standings
9. **MARKET_CONSENSUS**: B = average of all available market sources (outright + prematch), falling back to standings for missing teams
10. **CONTINUOUS_OFFSEASON**: If weekly outright snapshots available, simulate weekly B updates:
    - Start with end-of-season B
    - Each week, pull B toward that week's outright-implied ELO by 10%
    - 10 weeks of gradual convergence

Save each as JSON: `{ team_id: string, seed_b: number, method: string }[]`
Save to `/Users/future/Desktop/MSI2026/simulations/offseason/seeds/`

### Phase 4: Simulate Full Season with Each Seed

For EACH seed method, replay all 2,506 settlements chronologically using the **original** formula (ΔB = 30 × (S − E_KR), no gravity, no adaptive K).

The simulation logic exists in `simulations/oracle-sim-suite.ts` — **reuse its data loading and replay structure**. The key function is the settlement replay loop. For each fixture in chronological order:
- For each team (home/away):
  - `delta_b = 30 * (actual_s - e_kr)` (from settlement_log)
  - `B[team] += delta_b`
  - Compute implied M1: need R_market from `oddsImpliedStrength(e_kr, B[opponent], isHome, 65)`
  - `implied_m1 = R_market - B[team]`
  - Record everything

For each seed method, compute:
1. **M1 distribution**: Mean|M1|, Median, P90, Max, count with |M1| > 40, > 60, > 80, > 120
2. **Outlier team trajectories**: For the 15 worst teams, show implied M1 at match 1, 5, 10, 15, 20, 25, final
3. **Seed error**: Mean|seed_b - first_fixture_R_market| across all teams
4. **Comparison vs gravity baseline**: Does any seed method achieve Mean|M1| < 35 without formula changes?

Write a TypeScript simulation file to `/Users/future/Desktop/MSI2026/simulations/offseason/offseason-seed-sim.ts`.
Write results to `/Users/future/Desktop/MSI2026/simulations/offseason/results/`

### Phase 5: Hybrid Testing — Best Seed + Gravity

If no seed method alone matches gravity's compression (Mean|M1| < 35), test combinations:
1. Best seed + gravity λ=0.03
2. Best seed + gravity λ=0.05
3. Best seed + gravity λ=0.08

Compare to:
- Gravity λ=0.08 alone (with current bad seeds): Mean|M1| = 32.75
- Best seed alone (no gravity)

### Phase 6: Final Report

Write to `/Users/future/Desktop/MSI2026/simulations/offseason/FINAL_REPORT.md`:

1. **Data Availability Summary**: What sources had usable off-season data? Coverage? Gaps?
2. **Seed Method Comparison Table**: For all methods tested
3. **Outlier Team Deep-Dive**: Per team, which method fixes them?
4. **Head-to-Head vs Gravity**: Does any seed method match gravity λ=0.08?
5. **Recommendation**: One of:
   - "Seeding alone is sufficient" → Mean|M1| < 35 without formula changes
   - "Seeding helps but gravity is still needed" → Mean|M1| 40-60, add light gravity
   - "Seeding doesn't help enough" → ship gravity λ=0.08
   - "Seeding + gravity is better than either alone" → ship both
6. **Implementation Plan**: If seeding wins, what pipeline to build for next off-season?

### Important Notes

- **API credit safety**: The Odds API Mega plan has 5M credits/month. Historical endpoints cost more. Check `x-requests-remaining` header after every call. If < 1M remaining, stop querying.
- **Team name matching**: Use `scheduler/src/data/team-aliases.json` to resolve names across sources. Build a lookup early.
- **Write intermediate results frequently** to avoid losing progress.
- **The simulation code structure from `simulations/oracle-sim-suite.ts` is reusable** — copy its data loading pattern and replay loop.
- **The key metric is the 15 worst outlier teams' Mean|M1|**, not all 122 teams. Top teams (Arsenal, Inter, Barcelona) have small M1 regardless.

### Success Criteria

The mission succeeds if it answers definitively:
**"Can proper off-season B seeding reduce the 15 worst outlier teams' Mean|M1| below 60, without any formula changes?"**

- If yes → we ship off-season seeding and keep the formula pure
- If no → we ship gravity λ=0.08 clamped
- Either answer is valuable
