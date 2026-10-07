# Stock Clock

A warehouse inventory dashboard that shows **when each SKU hits zero**, **who owns the fix**, and **what a change in cost does to margin**. It pushes alerts to the right person on Slack and email, and escalates them to that person's manager if nobody responds in time.

Everything is JavaScript: BigQuery → Node pipeline → Cloudflare KV + D1 → Worker (API + cron) → static dashboard.

```
BigQuery thelook_ecommerce ──sql/01_sku_snapshot.sql──► stock_clock.sku_dc
        │  pipeline_engine.js (run.cmd or GitHub Action, daily)
        ▼
Cloudflare KV  "stock_clock" (snapshot)          Cloudflare D1 (people, routing, alerts,
        │                                         purchase orders, cost ledger, activity)
        └──────────────► worker.js ◄──────────────┘
                         ├─ /            dashboard (public/)
                         ├─ /api/state   public read
                         ├─ /api/*       owner-only writes (OWNER_TOKEN)
                         └─ cron 30 min  rules → open / close / escalate → Slack + email digest
```

## Files

| File | What it does |
|---|---|
| `sql/01_sku_snapshot.sql` | BigQuery snapshot. Includes out-of-stock SKUs, 8 weeks of sales and receipts |
| `sql/02_check.sql` | Sanity check after 01 |
| `pipeline_engine.js` | Reads the snapshot, writes KV, then asks the Worker to run the rules |
| `public/engine.js` | **The engine**: metrics, safety stock, landed cost, alert rules, owner matching. The Worker and the browser share it |
| `public/app.js`, `public/index.html` | Dashboard |
| `public/seed.json` | Demo data, used only until the first live sync (`npm run seed` rebuilds it) |
| `worker.js`, `lib/notify.js` | API, cron, Slack and Resend delivery |
| `schema.sql` | D1 tables, plus the fictional demo staff and the routing table |
| `setup.cmd`, `deploy.cmd`, `run.cmd`, `install.cmd` | One-click Windows scripts |
| `github-action-sync.yml` | Optional daily sync. Move it to `.github/workflows/sync.yml` before pushing to GitHub |

## Setup (about 15 minutes)

1. **Slack webhook.** Go to api.slack.com/apps → Create New App → From scratch. Then Incoming Webhooks → On → Add New Webhook → pick a channel (e.g. `#stock-clock`) → copy the URL.
2. **Resend.** Sign up at resend.com with the email you want alerts sent to, then go to API Keys → Create. You don't need a domain: the test sender `onboarding@resend.dev` delivers to the email you signed up with. The free plan allows 100 emails a day, and Stock Clock sends one digest per run, not one email per alert.
3. **BigQuery.** Run `sql/01_sku_snapshot.sql` in the BigQuery console, then `sql/02_check.sql`. You want `out_of_stock > 0`.
4. Double-click **`install.cmd`**.
5. Double-click **`setup.cmd`**. It logs in to Cloudflare, creates the D1 database, loads the tables and demo staff, asks for the four secrets, and deploys.
6. Copy the `https://stock-clock.<you>.workers.dev` URL into `PUBLIC_URL` in `wrangler.toml` (so Slack and email links work), then run **`deploy.cmd`**.
7. Add `PUBLIC_URL` and `OWNER_TOKEN` to `.env`, then double-click **`run.cmd`**. It loads the live snapshot and fires the first rules run. The first digest will list every open alert.
8. Open the site → **Owner sign-in** → paste your `OWNER_TOKEN` → **Send test alert**.

Optional: push to GitHub (the `.gitignore` already keeps `.env` and `gcp-key.json` out) and move `github-action-sync.yml` to `.github/workflows/sync.yml` and add the secrets listed at its top, for a daily 07:15 Lagos sync.

## How it decides

**Metrics, per SKU and warehouse.** Daily sales = 30-day sales ÷ 30 × the demand slider. Safety stock = z(service level) × σ(daily sales) × √(lead time), where σ comes from the 8 weekly sales numbers. Reorder point = daily sales × lead time + safety stock. The projected stock curve includes open POs, expedites and transfers. **Revenue at risk** = sales lost before an order placed today could land.

**Statuses:** Out of stock (0 on hand and still selling), Stockout risk (hits zero inside the lead time with nothing arriving in time), Reorder (stock + on order ≤ reorder point), Idle (more than 26 weeks of cover), Thin margin (below the floor), Covered.

**Who handles what.** Each alert type in the `routing` table has an owner role, the roles copied in, a response deadline and a severity. The person is picked from `people`, and the **most specific scope wins**: warehouse + department + category beats department, which beats company-wide. For example, a Women's Jeans reorder goes to Chioma (Women · Jeans), not Aisha (Women). You can edit the rules in the **Who handles what** tab.

**Lifecycle.** The rules run every 30 minutes, after each sync, and after owner actions. New problems open an alert and go into the next digest. Problems that have gone away close themselves (for example, a reorder alert closes once a PO exists). An alert nobody acknowledges before its deadline escalates to the owner's manager and is announced again. An alert someone resolves by hand stays closed for 7 days.

**Landed cost (COGS).** The single snapshot cost is split into production, freight, insurance, duty and handling. The starting split is a labelled default: 70 / 12 / 3 / 10 / 5. Duty is charged on production + freight + insurance (the CIF value). Every change is saved as a revision with a reason and an effective date:

- under 2%: approves itself
- 2–5%: inventory manager approves
- over 5%: Finance approves

The dashboard then shows:
- the new margin
- the **blended cost**: a weighted average where stock already on hand keeps its old cost and new receipts come in at the new cost
- the price needed to hold the margin floor (which triggers a merchandising review if margin falls below it)
- for a future increase, the saving from **buying ahead**; for a decrease, the room for a promotion

## Sandbox vs owner mode

Public visitors get a **sandbox**. Every action (orders, cost changes, approvals, routing edits, running the rules) runs the real engine in their browser. Nothing is saved or sent, and "Send playbook" shows a preview of the Slack message and email. When you sign in with `OWNER_TOKEN`, the same buttons write to D1 and deliver for real.

## Notes

- thelook has no staff, PO or supplier tables. The people are fictional, POs exist only in this app, and "received" in the History tab means `inventory_items.created_at`, which thelook generates.
- In thelook each SKU ships from a single warehouse, so the transfer option only appears when the same SKU is stocked at two warehouses (the demo seed includes a few).
- Costs: Workers Paid ($5/month) includes D1 (25B rows read, 50M rows written and 5 GB per month), KV and cron. This app uses a tiny fraction of that.
- Local testing: `npm run db:init:local`, put `OWNER_TOKEN=...` in `.dev.vars`, then `npm run dev`.
