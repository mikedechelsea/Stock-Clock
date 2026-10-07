// Creates the D1 database (or finds it if it already exists), writes its id into
// wrangler.toml, then loads schema.sql (tables + demo people + routing).
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const run = cmd => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
const toml = new URL("../wrangler.toml", import.meta.url);
let id = null;

try {
  const out = run("npx wrangler d1 create stock-clock --binding DB --no-update-config");
  console.log(out);
  id = (out.match(/database_id["'\s:=]+["']?([0-9a-f-]{36})/i) || [])[1];
} catch (e) {
  const msg = String(e.stdout || "") + String(e.stderr || "");
  if (!/already exists/i.test(msg)) { console.error(msg); process.exit(1); }
  console.log("Database stock-clock already exists. Looking up its id…");
}
if (!id) {
  const list = JSON.parse(run("npx wrangler d1 list --json"));
  id = list.find(d => d.name === "stock-clock")?.uuid;
}
if (!id) { console.error("Could not find the D1 database id. Paste it into wrangler.toml by hand."); process.exit(1); }

const text = readFileSync(toml, "utf8").replace(/database_id = ".*"/, `database_id = "${id}"`);
writeFileSync(toml, text);
console.log(`wrangler.toml updated with database_id ${id}`);

console.log(run("npx wrangler d1 execute stock-clock --remote --file=schema.sql --yes"));
console.log("D1 ready: tables created, demo people and routing loaded.");
