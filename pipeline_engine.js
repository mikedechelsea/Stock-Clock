// Stock Clock pipeline: BigQuery snapshot -> Cloudflare KV -> (optional) run the alert rules now.
// Run from your PC with run.cmd, or on a schedule with the GitHub Action in .github/workflows/sync.yml.
import { BigQuery } from "@google-cloud/bigquery";
import dotenv from "dotenv";

dotenv.config();

const projectId = process.env.PROJECT_ID || "beaming-might-319312";
const bqOptions = { projectId };
if (process.env.GCP_KEY_JSON) bqOptions.credentials = JSON.parse(process.env.GCP_KEY_JSON); // GitHub Actions secret
else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) bqOptions.keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const bigquery = new BigQuery(bqOptions);

function num(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "object" && v.value != null) return num(v.value);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function day(v) {
  if (!v) return "";
  if (typeof v === "object" && v.value) return String(v.value).slice(0, 10);
  return String(v).slice(0, 10);
}
const arr = v => (Array.isArray(v) ? v.map(num) : []);

async function pushKv(key, body) {
  const accountId = process.env.KV_ACCOUNT_ID;
  const namespaceId = process.env.KV_NAMESPACE_ID;
  const apiToken = process.env.KV_API_TOKEN;
  if (!accountId || !namespaceId || !apiToken) {
    throw new Error("Missing KV_ACCOUNT_ID, KV_NAMESPACE_ID or KV_API_TOKEN in .env");
  }
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${key}`;
  const response = await fetch(endpoint, {
    method: "PUT",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body
  });
  if (!response.ok) throw new Error(`KV write ${key} failed (${response.status}): ${await response.text()}`);
}

async function run() {
  console.log(`[${new Date().toISOString()}] Stock Clock pipeline ${projectId}`);
  const [rows] = await bigquery.query({
    query: `SELECT * FROM \`${projectId}.stock_clock.sku_dc\` ORDER BY sold_30 DESC`
  });
  if (!rows.length) throw new Error("0 rows. Run sql/01_sku_snapshot.sql in BigQuery, then run.cmd again.");

  const payload = {
    source: `bigquery-public-data.thelook_ecommerce → ${projectId}.stock_clock.sku_dc`,
    as_of: day(rows[0].as_of),
    window_days: 30,
    synced_at: new Date().toISOString(),
    rows: rows.map(r => ({
      sku: String(r.sku || ""),
      dc_id: num(r.dc_id),
      dc_name: String(r.dc_name || ""),
      name: String(r.name || ""),
      brand: String(r.brand || ""),
      category: String(r.category || ""),
      department: String(r.department || ""),
      price: num(r.price),
      cost: num(r.cost),
      on_hand: num(r.on_hand),
      sold_30: num(r.sold_30),
      sold_7: num(r.sold_7),
      sold_prev_7: num(r.sold_prev_7),
      received_30: num(r.received_30),
      last_received: day(r.last_received),
      weekly: arr(r.weekly),
      received_weekly: arr(r.received_weekly)
    }))
  };
  const sold = payload.rows.reduce((s, r) => s + r.sold_30, 0);
  const onHand = payload.rows.reduce((s, r) => s + r.on_hand, 0);
  const out = payload.rows.filter(r => r.on_hand === 0 && r.sold_30 > 0).length;
  console.log(`${payload.rows.length} SKU-warehouse rows · as of ${payload.as_of}`);
  console.log(`on hand ${onHand} · sold in 30 days ${sold} · out of stock ${out}`);
  if (sold === 0) throw new Error("Refusing to publish 0 sales. Check sql/02_check.sql.");

  await pushKv("stock_clock", JSON.stringify(payload));
  console.log("KV updated: stock_clock");

  // Ask the Worker to run the rules right away (otherwise the 30-minute cron picks it up).
  if (process.env.PUBLIC_URL && process.env.OWNER_TOKEN) {
    const res = await fetch(process.env.PUBLIC_URL.replace(/\/$/, "") + "/api/run", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.OWNER_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ notify: true })
    });
    console.log("Rules run:", res.status, (await res.text()).slice(0, 300));
  }
}

run().catch(err => {
  console.error("Pipeline failed:", err.message || err);
  process.exit(1);
});
