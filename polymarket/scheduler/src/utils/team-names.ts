import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let aliases: Record<string, string> | null = null;

function getAliases(): Record<string, string> {
  if (aliases) return aliases;
  try {
    const raw = fs.readFileSync(
      path.resolve(__dirname, "../data/team-aliases.json"),
      "utf-8"
    );
    aliases = JSON.parse(raw);
    return aliases!;
  } catch {
    aliases = {};
    return aliases;
  }
}

export function resolveTeamName(name: string): string {
  const map = getAliases();
  return map[name] ?? name;
}
