// Stock Clock · Cloudflare Worker
// - Static dashboard from /public (Workers Static Assets)
// - /api/state           public read (people, routing, alerts, POs, cost ledger, snapshot)
// - owner-only writes    Authorization: Bearer <OWNER_TOKEN>
// - cron                 runs the rules, opens/closes/escalates alerts, sends Slack + email digests
import * as E from "./public/engine.js";
import { buildDigest, buildRoute, sendSlack, sendEmail, channels } from "./lib/notify.js";

const HEAD = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const J = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: HEAD });
const nowIso = () => new Date().toISOString();

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      return await api(req, env, url, ctx);
    } catch (e) {
      return J({ error: String(e?.message || e) }, e?.status || 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(evaluate(env, { trigger: "cron", notify: true }));
  }
};

// ---------- auth ----------
function isOwner(req, env) {
  const want = env.OWNER_TOKEN || "";
  const got = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!want || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}
function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

// ---------- data ----------
async function loadSnapshot(env) {
  const raw = env.STOCK_KV ? await env.STOCK_KV.get("stock_clock") : null;
  if (raw) {
    const snap = JSON.parse(raw);
    if (snap.rows?.length) return { ...snap, demo: false };
  }
  const res = await env.ASSETS.fetch(new Request("https://assets.local/seed.json"));
  return await res.json();
}

async function all(env, sql, ...binds) {
  const r = await env.DB.prepare(sql).bind(...binds).all();
  return r.results || [];
}

async function loadCore(env) {
  const cutoff = new Date(Date.now() - 8 * E.DAY).toISOString();
  const [people, routing, settings, alerts, pos, revisions] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM people WHERE active = 1 ORDER BY id"),
    env.DB.prepare("SELECT * FROM routing ORDER BY sla_minutes"),
    env.DB.prepare("SELECT * FROM settings"),
    env.DB.prepare("SELECT * FROM alerts WHERE status != 'resolved' OR resolved_at > ? ORDER BY opened_at DESC").bind(cutoff),
    env.DB.prepare("SELECT * FROM purchase_orders WHERE status = 'open' OR created_at > ? ORDER BY id DESC").bind(new Date(Date.now() - 60 * E.DAY).toISOString()),
    env.DB.prepare("SELECT * FROM cost_revisions ORDER BY id DESC LIMIT 500")
  ]);
  const policyRow = (settings.results || []).find(s => s.k === "policy");
  return {
    people: people.results || [], routing: routing.results || [],
    policy: policyRow ? JSON.parse(policyRow.v) : {},
    alerts: alerts.results || [], pos: pos.results || [], revisions: revisions.results || []
  };
}

function ctxFor(snap, core, now = Date.now()) {
  return E.makeCtx(core.policy, {
    adjust: E.buildAdjust(core.pos, snap.as_of, now),
    costs: E.costsFromRevisions(core.revisions, E.isoDay(now))
  });
}

async function logEvent(env, e) {
  await env.DB.prepare("INSERT INTO events (at, alert_id, sku, dc_id, actor, action, note) VALUES (?,?,?,?,?,?,?)")
    .bind(nowIso(), e.alert_id ?? null, e.sku ?? null, e.dc_id ?? null, e.actor ?? "system", e.action, e.note ?? null).run();
}

async function runBatches(env, stmts) {
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
}

// ---------- the rules engine run ----------
export async function evaluate(env, { trigger = "manual", notify = true } = {}) {
  const now = Date.now(), at = new Date(now).toISOString();
  const snap = await loadSnapshot(env);
  const core = await loadCore(env);
  const ctx = ctxFor(snap, core, now);
  const cands = E.alertCandidates(snap.rows, ctx, { pos: core.pos, revisions: core.revisions, now, asOf: E.isoDay(now) });
  const plan = E.reconcile(core.alerts, cands, core.routing, core.people, now);
  const s = [];
  const upsert = env.DB.prepare(`INSERT OR REPLACE INTO alerts
    (id, type, sku, dc_id, dc_name, name, department, category, title, body, severity, owner_id, cc_ids, status, opened_at, due_at, escalated, notified_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'open', ?, ?, 0, NULL)`);
  const ev = env.DB.prepare("INSERT INTO events (at, alert_id, sku, dc_id, actor, action, note) VALUES (?,?,?,?,?,?,?)");
  for (const a of [...plan.inserts, ...plan.reopens]) {
    s.push(upsert.bind(a.id, a.type, a.sku, a.dc_id, a.dc_name || null, a.name || null, a.department || null, a.category || null,
      a.title, a.body, a.severity, a.owner_id, a.cc_ids, at, a.due_at));
    s.push(ev.bind(at, a.id, a.sku, a.dc_id, "system", "opened", `Routed to ${core.people.find(p => p.id === a.owner_id)?.name || "nobody"} (${trigger})`));
  }
  for (const u of plan.updates) s.push(env.DB.prepare("UPDATE alerts SET title = ?, body = ? WHERE id = ?").bind(u.title, u.body, u.id));
  for (const r of plan.resolves) {
    s.push(env.DB.prepare("UPDATE alerts SET status = 'resolved', resolved_at = ?, resolved_by = 'system' WHERE id = ?").bind(at, r.id));
    s.push(ev.bind(at, r.id, null, null, "system", "auto-resolved", r.why));
  }
  for (const x of plan.escalations) {
    s.push(env.DB.prepare("UPDATE alerts SET escalated = 1, escalated_to = ?, notified_at = NULL WHERE id = ?").bind(x.to_id, x.id));
    s.push(ev.bind(at, x.id, null, null, "system", "escalated", `To ${core.people.find(p => p.id === x.to_id)?.name || "nobody"} after the deadline passed`));
  }
  await runBatches(env, s);
  let delivery = [];
  if (notify) delivery = await notifyPending(env, core.people);
  return {
    trigger, at, rows: snap.rows.length, candidates: cands.length,
    opened: plan.inserts.length + plan.reopens.length, updated: plan.updates.length,
    resolved: plan.resolves.length, escalated: plan.escalations.length, delivery
  };
}

// Sends one digest with every alert that has not been announced yet.
async function notifyPending(env, people) {
  const pending = await all(env, "SELECT * FROM alerts WHERE status IN ('open','acked') AND notified_at IS NULL");
  if (!pending.length) return [];
  const ch = channels(env);
  if (!ch.slack && !ch.email) return [{ channel: "none", skipped: true, detail: "No SLACK_WEBHOOK_URL or RESEND_API_KEY set" }];
  const opened = pending.filter(a => !a.escalated);
  const escalated = pending.filter(a => a.escalated);
  const d = buildDigest({ opened, escalated, people, baseUrl: env.PUBLIC_URL || "" });
  const results = await Promise.all([sendSlack(env, d.slack), sendEmail(env, d.email)]);
  if (results.some(r => r.ok)) {
    const at = nowIso();
    const stmts = pending.map(a => env.DB.prepare("UPDATE alerts SET notified_at = ? WHERE id = ?").bind(at, a.id));
    await runBatches(env, stmts);
    await logEvent(env, { action: "digest-sent", note: `${opened.length} new, ${escalated.length} escalated · ${results.map(r => r.channel + ":" + (r.ok ? "ok" : r.skipped ? "off" : "fail")).join(" ")}` });
  }
  return results;
}

// ---------- API ----------
async function body(req) { try { return await req.json(); } catch { return {}; } }

async function api(req, env, url, ctx) {
  const path = url.pathname.replace(/\/+$/, "");
  const m = req.method;

  if (path === "/api/state" && m === "GET") {
    const [snap, core] = await Promise.all([loadSnapshot(env), loadCore(env)]);
    const events = await all(env, "SELECT * FROM events ORDER BY id DESC LIMIT 80");
    return J({ snapshot: snap, ...core, events, channels: channels(env), server_time: nowIso(), owner: isOwner(req, env) });
  }
  if (path === "/api/whoami") return J({ owner: isOwner(req, env), channels: channels(env) });

  // ---- everything below needs the owner token ----
  if (!isOwner(req, env)) fail(401, "Owner token required. Public visitors use sandbox mode.");
  const b = m === "GET" ? {} : await body(req);
  const actor = String(b.actor || "Owner").slice(0, 80);
  let seg;

  if (path === "/api/run" && m === "POST") return J(await evaluate(env, { trigger: "manual", notify: b.notify !== false }));

  if ((seg = path.match(/^\/api\/alerts\/(.+)\/(ack|resolve|escalate|reopen)$/)) && m === "POST") {
    const id = decodeURIComponent(seg[1]), action = seg[2], at = nowIso();
    const a = (await all(env, "SELECT * FROM alerts WHERE id = ?", id))[0];
    if (!a) fail(404, "Alert not found");
    if (action === "ack") await env.DB.prepare("UPDATE alerts SET status = 'acked', acked_at = ?, acked_by = ? WHERE id = ?").bind(at, actor, id).run();
    if (action === "resolve") await env.DB.prepare("UPDATE alerts SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE id = ?").bind(at, actor, id).run();
    if (action === "reopen") await env.DB.prepare("UPDATE alerts SET status = 'open', resolved_at = NULL, resolved_by = NULL WHERE id = ?").bind(id).run();
    if (action === "escalate") {
      const people = await all(env, "SELECT * FROM people");
      const owner = people.find(p => p.id === a.owner_id);
      await env.DB.prepare("UPDATE alerts SET escalated = 1, escalated_to = ?, notified_at = NULL WHERE id = ?").bind(owner?.manager_id ?? null, id).run();
    }
    await logEvent(env, { alert_id: id, sku: a.sku, dc_id: a.dc_id, actor, action, note: b.note || null });
    if (action === "escalate") ctx.waitUntil(notifyPending(env, await all(env, "SELECT * FROM people")));
    return J({ ok: true });
  }

  if (path === "/api/po" && m === "POST") {
    const snap = await loadSnapshot(env), core = await loadCore(env);
    const row = snap.rows.find(r => r.sku === b.sku && Number(r.dc_id) === Number(b.dc_id));
    if (!row) fail(404, "SKU not in snapshot");
    const kind = ["po", "expedite", "transfer"].includes(b.kind) ? b.kind : "po";
    const qty = Math.max(1, Math.min(100000, Math.round(Number(b.qty) || 0)));
    const c = ctxFor(snap, core);
    const unit = E.metrics(row, c).unit * (kind === "expedite" ? 1 + c.expediteSurcharge : 1);
    const eta = new Date(Date.now() + E.etaDays(kind, c) * E.DAY).toISOString();
    const r = await env.DB.prepare(`INSERT INTO purchase_orders (sku, dc_id, dc_name, qty, kind, unit_cost, source_dc_id, status, created_at, created_by, eta, note)
      VALUES (?,?,?,?,?,?,?, 'open', ?,?,?,?)`).bind(row.sku, row.dc_id, row.dc_name, qty, kind, E.r2(unit),
      kind === "transfer" ? Number(b.source_dc_id) : null, nowIso(), actor, eta, b.note || null).run();
    await logEvent(env, { sku: row.sku, dc_id: row.dc_id, actor, action: `${kind}-created`, note: `${qty} units, ETA ${eta.slice(0, 10)}` });
    const run = await evaluate(env, { trigger: "po", notify: false });
    return J({ ok: true, id: r.meta?.last_row_id, run });
  }

  if ((seg = path.match(/^\/api\/po\/(\d+)\/(receive|cancel)$/)) && m === "POST") {
    const id = Number(seg[1]), at = nowIso();
    const po = (await all(env, "SELECT * FROM purchase_orders WHERE id = ?", id))[0];
    if (!po) fail(404, "PO not found");
    if (seg[2] === "receive") await env.DB.prepare("UPDATE purchase_orders SET status = 'received', received_at = ? WHERE id = ?").bind(at, id).run();
    else await env.DB.prepare("UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?").bind(id).run();
    await logEvent(env, { sku: po.sku, dc_id: po.dc_id, actor, action: seg[2] === "receive" ? "po-received" : "po-cancelled", note: `#${id}` });
    const run = await evaluate(env, { trigger: "po", notify: false });
    return J({ ok: true, run });
  }

  if (path === "/api/costs" && m === "POST") {
    const snap = await loadSnapshot(env), core = await loadCore(env);
    const row = snap.rows.find(r => r.sku === b.sku && Number(r.dc_id) === Number(b.dc_id));
    if (!row) fail(404, "SKU not in snapshot");
    const c = ctxFor(snap, core);
    const oldComp = c.costs[E.keyOf(row)] || E.defaultCost(row.cost);
    const n = b.components || {};
    const newComp = { production: E.r2(n.production), freight: E.r2(n.freight), insurance: E.r2(n.insurance), handling: E.r2(n.handling), duty_pct: Math.round((Number(n.duty_pct) || 0) * 10) / 10 };
    const oldUnit = E.landed(oldComp), newUnit = E.landed(newComp);
    const pct = oldUnit > 0 ? ((newUnit - oldUnit) / oldUnit) * 100 : 0;
    const tier = E.approvalTier(pct, c);
    const eff = /^\d{4}-\d{2}-\d{2}$/.test(b.effective_date || "") ? b.effective_date : E.isoDay(Date.now());
    const status = tier === "auto" ? "approved" : "pending";
    const at = nowIso();
    const r = await env.DB.prepare(`INSERT INTO cost_revisions (sku, dc_id, old_json, new_json, old_unit, new_unit, pct, tier, reason, effective_date, submitted_by, status, decided_by, decided_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(row.sku, row.dc_id, JSON.stringify(oldComp), JSON.stringify(newComp), E.r2(oldUnit), E.r2(newUnit),
      Math.round(pct * 100) / 100, tier, String(b.reason || "").slice(0, 300), eff, actor, status, status === "approved" ? "auto" : null, status === "approved" ? at : null, at).run();
    await logEvent(env, { sku: row.sku, dc_id: row.dc_id, actor, action: "cost-submitted", note: `${pct.toFixed(1)}% · ${tier}` });
    const run = await evaluate(env, { trigger: "cost", notify: true });
    return J({ ok: true, id: r.meta?.last_row_id, tier, status, pct, run });
  }

  if ((seg = path.match(/^\/api\/costs\/(\d+)\/(approve|reject)$/)) && m === "POST") {
    const id = Number(seg[1]);
    const rev = (await all(env, "SELECT * FROM cost_revisions WHERE id = ?", id))[0];
    if (!rev) fail(404, "Revision not found");
    if (rev.status !== "pending") fail(409, "Already decided");
    await env.DB.prepare("UPDATE cost_revisions SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?")
      .bind(seg[2] === "approve" ? "approved" : "rejected", actor, nowIso(), id).run();
    await logEvent(env, { sku: rev.sku, dc_id: rev.dc_id, actor, action: seg[2] === "approve" ? "cost-approved" : "cost-rejected", note: `#${id} ${Number(rev.pct).toFixed(1)}%` });
    const run = await evaluate(env, { trigger: "cost", notify: true });
    return J({ ok: true, run });
  }

  if ((seg = path.match(/^\/api\/routing\/([a-z_]+)$/)) && m === "PUT") {
    const roles = Object.keys(E.ROLES);
    if (!roles.includes(b.primary_role)) fail(400, "Unknown role");
    const cc = String(b.cc_roles || "").split(",").map(s => s.trim()).filter(r => roles.includes(r)).join(",");
    const sla = Math.max(5, Math.min(43200, Math.round(Number(b.sla_minutes) || 60)));
    const sev = ["critical", "high", "medium", "low"].includes(b.severity) ? b.severity : "medium";
    await env.DB.prepare("UPDATE routing SET primary_role = ?, cc_roles = ?, sla_minutes = ?, severity = ?, updated_at = ? WHERE alert_type = ?")
      .bind(b.primary_role, cc, sla, sev, nowIso(), seg[1]).run();
    await logEvent(env, { actor, action: "routing-changed", note: `${seg[1]} → ${b.primary_role}${cc ? " cc " + cc : ""}, ${sla}m, ${sev}` });
    return J({ ok: true });
  }

  if (path === "/api/policy" && m === "PUT") {
    const p = {
      lead: Math.max(1, Math.min(120, Math.round(Number(b.lead) || 14))),
      review: Math.max(7, Math.min(120, Math.round(Number(b.review) || 28))),
      service: Math.max(0.5, Math.min(0.995, Number(b.service) || 0.95)),
      marginTarget: Math.max(0, Math.min(0.8, Number(b.marginTarget) || 0.2))
    };
    await env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('policy', ?)").bind(JSON.stringify(p)).run();
    await logEvent(env, { actor, action: "policy-saved", note: `lead ${p.lead}d · service ${Math.round(p.service * 100)}% · margin ${Math.round(p.marginTarget * 100)}%` });
    const run = await evaluate(env, { trigger: "policy", notify: false });
    return J({ ok: true, policy: p, run });
  }

  if (path === "/api/notify/test" && m === "POST") {
    const people = await all(env, "SELECT * FROM people");
    const fake = { id: "test", type: "out_of_stock", severity: "critical", title: "Test alert from Stock Clock", body: "If you can read this, routing works.", owner_id: 10, cc_ids: "11", due_at: new Date(Date.now() + 3600000).toISOString() };
    const d = buildDigest({ opened: [fake], people, baseUrl: env.PUBLIC_URL || "" });
    const results = await Promise.all([sendSlack(env, d.slack), sendEmail(env, d.email)]);
    await logEvent(env, { actor, action: "test-sent", note: results.map(r => r.channel + ":" + (r.ok ? "ok" : r.skipped ? "off" : "fail")).join(" ") });
    return J({ ok: true, results });
  }

  if (path === "/api/route" && m === "POST") {
    const snap = await loadSnapshot(env), core = await loadCore(env);
    const row = snap.rows.find(r => r.sku === b.sku && Number(r.dc_id) === Number(b.dc_id));
    if (!row) fail(404, "SKU not in snapshot");
    const c = ctxFor(snap, core);
    const mm = E.metrics(row, c);
    const steps = E.playbook(row, mm, c, core.people, snap.rows, E.isoDay(Date.now()));
    const line = `${E.fmtInt(mm.onHand)} on hand · ${mm.v.toFixed(1)}/day · ${E.STATUS[mm.status].label}`;
    const msg = buildRoute({ row, steps, metricsLine: line, baseUrl: env.PUBLIC_URL || "", actor });
    const results = await Promise.all([sendSlack(env, msg.slack), sendEmail(env, msg.email)]);
    await logEvent(env, { sku: row.sku, dc_id: row.dc_id, actor, action: "playbook-routed", note: results.map(r => r.channel + ":" + (r.ok ? "ok" : r.skipped ? "off" : "fail")).join(" ") });
    return J({ ok: true, results, steps });
  }

  fail(404, "Unknown endpoint");
}
