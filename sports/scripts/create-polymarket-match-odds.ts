/**
 * One-time migration: Create polymarket_match_odds table on NBA and MLB Supabase projects.
 * Run with: npx tsx scripts/create-polymarket-match-odds.ts
 *
 * Uses the service_role key to call a bootstrapped SQL function.
 */
import { createClient } from "@supabase/supabase-js";

const TARGETS = [
  {
    name: "NBA",
    url: process.env.SUPABASE_URL_NBA!,
    key: process.env.SUPABASE_KEY_NBA!,
  },
  {
    name: "MLB",
    url: process.env.SUPABASE_URL_MLB!,
    key: process.env.SUPABASE_KEY_MLB!,
  },
];

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS polymarket_match_odds (
  id bigserial PRIMARY KEY,
  league text,
  event_title text,
  polymarket_event_id text,
  fixture_id bigint,
  market_type text,
  market_question text,
  market_status text,
  outcomes jsonb,
  outcome_prices jsonb,
  volume numeric,
  volume_delta numeric DEFAULT 0,
  snapshot_time timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pmo_event_id ON polymarket_match_odds(polymarket_event_id);
CREATE INDEX IF NOT EXISTS idx_pmo_fixture ON polymarket_match_odds(fixture_id);
CREATE INDEX IF NOT EXISTS idx_pmo_snapshot ON polymarket_match_odds(snapshot_time DESC);
`;

async function migrate(name: string, url: string, key: string) {
  if (!url || !key) {
    console.error(`[${name}] Missing SUPABASE_URL or SUPABASE_KEY`);
    return;
  }

  const sb = createClient(url, key);

  // Step 1: Create a temporary RPC function that executes DDL
  const createFn = await sb.rpc("query", { query_text: "SELECT 1" }).maybeSingle();

  // If the rpc doesn't exist, we need to create it first using the REST admin approach
  // Supabase service_role can create functions via PostgREST if we use the right approach

  // Actually, let's use a simpler approach: check if table exists first
  const { data: existing, error: checkErr } = await sb
    .from("polymarket_match_odds")
    .select("id")
    .limit(0);

  if (!checkErr) {
    console.log(`[${name}] polymarket_match_odds table already exists`);
    return;
  }

  if (checkErr.code === "PGRST205") {
    // Table doesn't exist — need to create it
    // Use Supabase Management API approach
    console.log(`[${name}] Table doesn't exist. Creating via SQL...`);

    // Try creating via the pg_net extension or management API
    // Since we can't do DDL via PostgREST, we'll try a different method

    // Method: Use the Supabase SQL API (if available)
    const ref = url.replace("https://", "").replace(".supabase.co", "");
    const sqlUrl = `https://${ref}.supabase.co/sql`;

    try {
      const res = await fetch(sqlUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "apikey": key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: CREATE_TABLE_SQL }),
      });

      if (res.ok) {
        console.log(`[${name}] Table created successfully via SQL API`);
        return;
      }

      const errText = await res.text();
      console.error(`[${name}] SQL API failed (${res.status}): ${errText}`);
    } catch (err) {
      console.error(`[${name}] SQL API error:`, err);
    }

    console.error(`[${name}] Could not create table automatically.`);
    console.error(`[${name}] Please run this SQL manually in the Supabase SQL editor:`);
    console.error(CREATE_TABLE_SQL);
  } else {
    console.error(`[${name}] Unexpected error:`, checkErr);
  }
}

async function main() {
  for (const t of TARGETS) {
    await migrate(t.name, t.url, t.key);
  }
}

main().catch(console.error);
