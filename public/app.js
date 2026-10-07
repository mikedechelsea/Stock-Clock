// Stock Clock dashboard. Owner mode writes through the Worker API; everyone else gets a
// sandbox where every action runs the same engine locally and nothing leaves the tab.
import * as E from "./engine.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
};
const money = E.fmtMoney, int = E.fmtInt, pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;

// Used only when the API is unreachable (e.g. opened from GitHub Pages). Mirrors schema.sql.
const FALLBACK_PEOPLE = [
  [1, "Folake Adebayo", "ops_head"], [2, "Michael Osei", "cfo"], [3, "Sarah Lin", "merch_head"],
  [10, "Ngozi Okafor", "inventory", null, null, null, null, 1], [11, "Daniel Mensah", "finance", null, null, null, null, 2],
  [12, "Aisha Bello", "buyer", null, null, "Women", null, 3], [13, "Tunde Adeyemi", "buyer", null, null, "Men", null, 3],
  [14, "Chioma Eze", "buyer", null, null, "Women", "Jeans", 3], [15, "Grace Park", "merch", null, null, "Women", null, 3],
  [16, "Luis Romero", "merch", null, null, "Men", null, 3],
  [21, "Marcus Reed", "warehouse", 1, "Memphis TN", null, null, 1], [22, "Priya Shah", "warehouse", 2, "Chicago IL", null, null, 1],
  [23, "Carlos Vega", "warehouse", 3, "Houston TX", null, null, 1], [24, "Emily Tran", "warehouse", 4, "Los Angeles CA", null, null, 1],
  [25, "Andre Thomas", "warehouse", 5, "New Orleans LA", null, null, 1], [26, "Rachel Cohen", "warehouse", 6, "Port Authority NY/NJ", null, null, 1],
  [27, "Kevin Brien", "warehouse", 7, "Philadelphia PA", null, null, 1], [28, "Tasha Williams", "warehouse", 8, "Mobile AL", null, null, 1],
  [29, "James Porter", "warehouse", 9, "Charleston SC", null, null, 1], [30, "Maya Patel", "warehouse", 10, "Savannah GA", null, null, 1],
  [40, "Ola Johnson", "buyer", null, null, null, null, 3], [41, "Hannah Kim", "merch", null, null, null, null, 3], [42, "Yusuf Ali", "warehouse", null, null, null, null, 1]
].map(([id, name, role, dc_id = null, dc_name = null, department = null, category = null, manager_id = null]) =>
  ({ id, name, role, dc_id, dc_name, department, category, manager_id, email: name.toLowerCase().replace(/ /g, ".") + "@stockclock.demo", active: 1 }));
const FALLBACK_ROUTING = [
  ["out_of_stock", "warehouse", "merch,buyer", 60, "critical", "Stock received or substitute shown"],
  ["stockout_risk", "warehouse", "buyer", 240, "high", "Transfer or expedite lands before zero"],
  ["reorder_due", "buyer", "inventory", 2880, "medium", "PO created"],
  ["cost_minor", "inventory", "finance", 1440, "medium", "Cost change approved or rejected"],
  ["cost_major", "finance", "inventory", 1440, "high", "Cost change approved or rejected"],
  ["margin_breach", "finance", "merch", 2880, "medium", "Margin back above target, or accepted"],
  ["demand_spike", "buyer", "inventory", 1440, "medium", "Safety stock reviewed"],
  ["idle_stock", "merch", "inventory", 7200, "low", "Markdown or transfer logged"],
  ["po_late", "buyer", "warehouse", 240, "high", "Received or new date set"]
].map(([alert_type, primary_role, cc_roles, sla_minutes, severity, closes_when]) => ({ alert_type, primary_role, cc_roles, sla_minutes, severity, closes_when }));

const STATUS_TO_TYPE = { out: "out_of_stock", risk: "stockout_risk", reorder: "reorder_due", margin: "margin_breach", idle: "idle_stock", ok: "reorder_due" };
const SEV_VAR = { critical: "var(--out)", high: "var(--risk)", medium: "var(--reorder)", low: "var(--idle)" };
const STATUS_VAR = { out: "var(--out)", risk: "var(--risk)", reorder: "var(--reorder)", margin: "var(--margin)", idle: "var(--idle)", ok: "var(--ok)" };
const REASONS = ["Supplier price change", "Freight rate change", "Tariff / duty change", "Insurance change", "FX rate", "Handling / 3PL rate", "Correction"];

let S = { snap: { rows: [], as_of: "" }, people: [], routing: [], policy: {}, alerts: [], events: [], pos: [], revisions: [], channels: {}, owner: false, offline: false };
const UI = { me: "all", sel: null, dtab: "playbook", btab: "products", qtype: "", qresolved: false, sliders: null,
  f: { dept: "", dc: "", status: "", q: "" }, sort: { k: "zero", dir: 1 }, limit: 150, drafts: {}, firstLoad: true };
let token = store.get("sc-owner");
let seq = 9000;
let R = null; // per-render cache

// ---------------- data ----------------
async function load() {
  try {
    const res = await fetch("/api/state", { headers: token ? { authorization: "Bearer " + token } : {}, cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const d = await res.json();
    S = { snap: d.snapshot, people: d.people, routing: d.routing, policy: d.policy || {}, alerts: d.alerts, events: d.events,
      pos: d.pos, revisions: d.revisions, channels: d.channels || {}, owner: !!d.owner, offline: false };
    if (token && !d.owner) { token = null; store.set("sc-owner", null); toast("Owner token was rejected. Back in sandbox."); }
  } catch {
    const snap = await (await fetch("./seed.json")).json();
    S = { snap, people: FALLBACK_PEOPLE, routing: FALLBACK_ROUTING, policy: {}, alerts: [], events: [], pos: [], revisions: [], channels: {}, owner: false, offline: true };
  }
  if (!UI.sliders) resetSliders();
  if (!S.owner && !S.alerts.length) sandboxRun(false);
}

function resetSliders() {
  const p = { ...E.DEFAULTS, ...S.policy };
  UI.sliders = { lead: p.lead, service: p.service, mult: 1, marginTarget: p.marginTarget };
}

function ctx() {
  return E.makeCtx({ ...S.policy, ...UI.sliders }, {
    adjust: E.buildAdjust(S.pos, S.snap.as_of),
    costs: E.costsFromRevisions(S.revisions)
  });
}

function compute() {
  const c = ctx();
  const list = S.snap.rows.map(r => ({ r, m: E.metrics(r, c) }));
  const byKey = new Map(list.map(x => [x.m.key, x]));
  return { c, list, byKey, asOf: new Date(E.isoDay(Date.now()) + "T00:00:00Z") };
}

const me = () => (UI.me === "all" ? null : S.people.find(p => String(p.id) === UI.me) || null);
const person = id => S.people.find(p => p.id === Number(id));
const actorName = () => me()?.name || (S.owner ? "Owner" : "Visitor");
function inScope(r, p) {
  if (!p) return true;
  for (const f of ["dc_id", "department", "category"]) if (p[f] != null && p[f] !== "" && String(p[f]) !== String(r[f])) return false;
  return true;
}
const ccList = a => String(a.cc_ids || "").split(",").filter(Boolean).map(Number);
const mineAlert = (a, p) => !p || a.owner_id === p.id || ccList(a).includes(p.id) || a.escalated_to === p.id;
const firstName = p => (p ? p.name.split(" ")[0] : "Unassigned");
const roleName = r => E.ROLES[r] || r;
function scopeText(p) { return [p.department, p.category, p.dc_name].filter(Boolean).join(" · ") || "All"; }
const dateAt = d => E.dayLabel(E.addDays(R.asOf, d));

// ---------------- actions ----------------
async function act(kind, payload = {}) {
  if (S.owner) {
    const routes = {
      ack: ["POST", `/api/alerts/${encodeURIComponent(payload.id)}/ack`], resolve: ["POST", `/api/alerts/${encodeURIComponent(payload.id)}/resolve`],
      escalate: ["POST", `/api/alerts/${encodeURIComponent(payload.id)}/escalate`], reopen: ["POST", `/api/alerts/${encodeURIComponent(payload.id)}/reopen`],
      po: ["POST", "/api/po"], receive: ["POST", `/api/po/${payload.id}/receive`], cancel: ["POST", `/api/po/${payload.id}/cancel`],
      cost: ["POST", "/api/costs"], approve: ["POST", `/api/costs/${payload.id}/approve`], reject: ["POST", `/api/costs/${payload.id}/reject`],
      routing: ["PUT", `/api/routing/${payload.alert_type}`], policy: ["PUT", "/api/policy"], run: ["POST", "/api/run"],
      route: ["POST", "/api/route"], test: ["POST", "/api/notify/test"]
    };
    const [method, path] = routes[kind];
    const res = await fetch(path, { method, headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ ...payload, actor: actorName() }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { toast(d.error || `Failed (${res.status})`); return null; }
    await load();
    render();
    return d;
  }
  const out = sandbox[kind]?.(payload);
  if (!["route", "test"].includes(kind)) sandboxRun(false);
  render();
  return out;
}

function logLocal(e) { S.events.unshift({ id: seq++, at: new Date().toISOString(), actor: actorName(), ...e }); }

const sandbox = {
  ack({ id }) { const a = S.alerts.find(x => x.id === id); if (!a) return; Object.assign(a, { status: "acked", acked_at: new Date().toISOString(), acked_by: actorName() }); logLocal({ alert_id: id, sku: a.sku, action: "ack" }); toast("Acknowledged (sandbox)"); },
  resolve({ id }) { const a = S.alerts.find(x => x.id === id); if (!a) return; Object.assign(a, { status: "resolved", resolved_at: new Date().toISOString(), resolved_by: actorName() }); logLocal({ alert_id: id, sku: a.sku, action: "resolve" }); toast("Resolved (sandbox)"); },
  reopen({ id }) { const a = S.alerts.find(x => x.id === id); if (!a) return; Object.assign(a, { status: "open", resolved_at: null, resolved_by: null }); logLocal({ alert_id: id, sku: a.sku, action: "reopen" }); },
  escalate({ id }) {
    const a = S.alerts.find(x => x.id === id); if (!a) return;
    const mgr = person(person(a.owner_id)?.manager_id);
    Object.assign(a, { escalated: 1, escalated_to: mgr?.id ?? null });
    logLocal({ alert_id: id, sku: a.sku, action: "escalate", note: `To ${mgr?.name || "nobody"}` });
    toast(`Escalated to ${mgr?.name || "manager"} (sandbox)`);
  },
  po({ sku, dc_id, qty, kind, source_dc_id }) {
    const x = R.byKey.get(`${sku}@${dc_id}`); if (!x) return;
    const days = E.etaDays(kind, R.c);
    S.pos.unshift({ id: seq++, sku, dc_id, dc_name: x.r.dc_name, qty, kind, source_dc_id: kind === "transfer" ? source_dc_id : null,
      unit_cost: E.r2(x.m.unit * (kind === "expedite" ? 1 + R.c.expediteSurcharge : 1)), status: "open",
      created_at: new Date().toISOString(), created_by: actorName(), eta: new Date(Date.now() + days * E.DAY).toISOString() });
    logLocal({ sku, dc_id, action: `${kind}-created`, note: `${qty} units, ${days} days` });
    toast(`${kind === "po" ? "PO" : kind === "expedite" ? "Expedited PO" : "Transfer"} created (sandbox)`);
  },
  receive({ id }) { const p = S.pos.find(x => x.id === id); if (!p) return; Object.assign(p, { status: "received", received_at: new Date().toISOString() }); logLocal({ sku: p.sku, dc_id: p.dc_id, action: "po-received", note: `#${id}` }); toast("Received (sandbox)"); },
  cancel({ id }) { const p = S.pos.find(x => x.id === id); if (!p) return; p.status = "cancelled"; logLocal({ sku: p.sku, dc_id: p.dc_id, action: "po-cancelled", note: `#${id}` }); },
  cost({ sku, dc_id, components, reason, effective_date }) {
    const x = R.byKey.get(`${sku}@${dc_id}`); if (!x) return;
    const oldUnit = x.m.unit, newUnit = E.landed(components);
    const p = oldUnit > 0 ? ((newUnit - oldUnit) / oldUnit) * 100 : 0;
    const tier = E.approvalTier(p, R.c);
    const status = tier === "auto" ? "approved" : "pending";
    S.revisions.unshift({ id: seq++, sku, dc_id, old_json: JSON.stringify(x.m.comp), new_json: JSON.stringify(components), old_unit: E.r2(oldUnit), new_unit: E.r2(newUnit),
      pct: Math.round(p * 100) / 100, tier, reason, effective_date, submitted_by: actorName(), status, decided_by: status === "approved" ? "auto" : null,
      decided_at: status === "approved" ? new Date().toISOString() : null, created_at: new Date().toISOString() });
    logLocal({ sku, dc_id, action: "cost-submitted", note: `${p.toFixed(1)}% · ${tier}` });
    toast(tier === "auto" ? "Under 2%: approved automatically (sandbox)" : `Sent to ${tier === "finance" ? "Finance" : "the inventory manager"} for approval (sandbox)`);
    return { tier };
  },
  approve({ id }) { const r = S.revisions.find(x => x.id === id); if (!r) return; Object.assign(r, { status: "approved", decided_by: actorName(), decided_at: new Date().toISOString() }); logLocal({ sku: r.sku, dc_id: r.dc_id, action: "cost-approved", note: `#${id}` }); toast("Approved (sandbox)"); },
  reject({ id }) { const r = S.revisions.find(x => x.id === id); if (!r) return; Object.assign(r, { status: "rejected", decided_by: actorName(), decided_at: new Date().toISOString() }); logLocal({ sku: r.sku, dc_id: r.dc_id, action: "cost-rejected", note: `#${id}` }); toast("Rejected (sandbox)"); },
  routing(rule) { const i = S.routing.findIndex(r => r.alert_type === rule.alert_type); if (i >= 0) S.routing[i] = { ...S.routing[i], ...rule }; logLocal({ action: "routing-changed", note: rule.alert_type }); toast("Routing updated (sandbox). New alerts follow it."); },
  run() { const s = sandboxRun(true); toast(`Rules ran: ${s.opened} opened, ${s.resolved} closed, ${s.escalated} escalated (sandbox)`); },
  route({ sku, dc_id }) { previewRoute(sku, dc_id); },
  test() { toast("Sign in as owner to send a real test alert."); }
};

function sandboxRun(log = true) {
  const now = Date.now();
  if (!R) R = compute();
  const c = ctx();
  const cands = E.alertCandidates(S.snap.rows, c, { pos: S.pos, revisions: S.revisions, now, asOf: E.isoDay(now) });
  const plan = E.reconcile(S.alerts, cands, S.routing, S.people, now);
  const at = new Date(now).toISOString();
  for (const a of [...plan.inserts, ...plan.reopens]) {
    const i = S.alerts.findIndex(x => x.id === a.id);
    const row = { ...a, status: "open", opened_at: at, escalated: 0, escalated_to: null, acked_at: null, resolved_at: null, resolved_by: null };
    if (i >= 0) S.alerts[i] = row; else S.alerts.push(row);
    if (log) logLocal({ alert_id: a.id, sku: a.sku, action: "opened", note: `→ ${person(a.owner_id)?.name || "nobody"}` });
  }
  for (const u of plan.updates) Object.assign(S.alerts.find(x => x.id === u.id) || {}, u);
  for (const r of plan.resolves) {
    Object.assign(S.alerts.find(x => x.id === r.id) || {}, { status: "resolved", resolved_at: at, resolved_by: "system" });
    if (log) logLocal({ alert_id: r.id, action: "auto-resolved", note: r.why });
  }
  for (const x of plan.escalations) Object.assign(S.alerts.find(a => a.id === x.id) || {}, { escalated: 1, escalated_to: x.to_id });
  return { opened: plan.inserts.length + plan.reopens.length, resolved: plan.resolves.length, escalated: plan.escalations.length };
}

// ---------------- render ----------------
function render() {
  R = compute();
  if (!UI.sel || !R.byKey.has(UI.sel)) {
    const p = me();
    const first = R.list.filter(x => inScope(x.r, p)).sort((a, b) => E.STATUS[a.m.status].rank - E.STATUS[b.m.status].rank || b.m.lostRevenue - a.m.lostRevenue)[0];
    UI.sel = first?.m.key || R.list[0]?.m.key || null;
  }
  renderHeader(); renderBanner(); renderKpis(); renderPolicy(); renderClock(); renderQueue(); renderDetail(); renderBottom();
  $("#foot").innerHTML = `${esc(String(S.snap.source || "").replace(/\.+$/, ""))}. People are fictional demo staff (thelook has no employee table). Landed-cost parts start from a labelled default split of the file cost: 70% production, 12% freight, 3% insurance, 10% duty, 5% handling.`;
}

function renderHeader() {
  const rows = S.snap.rows.length;
  $("#asof").textContent = `Stock Clock · as of ${S.snap.as_of || "—"} · ${S.snap.demo ? "demo seed" : "live BigQuery"} · ${int(rows)} SKU-warehouse rows`;
  const groups = {};
  for (const p of S.people) (groups[p.role] ||= []).push(p);
  const order = ["inventory", "buyer", "warehouse", "merch", "finance", "ops_head", "merch_head", "cfo"];
  $("#me").innerHTML = `<option value="all">Everyone (all desks)</option>` + order.filter(r => groups[r]).map(r =>
    `<optgroup label="${esc(roleName(r))}">${groups[r].map(p => `<option value="${p.id}" ${String(p.id) === UI.me ? "selected" : ""}>${esc(p.name)}${scopeText(p) !== "All" ? " · " + esc(scopeText(p)) : ""}</option>`).join("")}</optgroup>`).join("");
  $("#me").value = UI.me;
  const mode = $("#mode");
  mode.className = "chip " + (S.owner ? "mode-owner" : "mode-sandbox");
  mode.innerHTML = `<span class="dot"></span>${S.owner ? "Owner mode" : "Sandbox"}`;
  $("#owner-btn").textContent = S.owner ? "Sign out" : "Owner sign-in";
  $("#owner-btn").hidden = S.offline;
}

function renderBanner() {
  const b = $("#banner");
  if (S.owner) {
    const ch = S.channels;
    b.innerHTML = `<span>Owner mode: actions write to the database. New alerts go to Slack ${ch.slack ? "✓" : "(not set)"} and email ${ch.email ? "✓" : "(not set)"} on the next rules run.</span>
      <span class="row-actions" style="margin:0"><button class="btn small" data-g="test">Send test alert</button></span>`;
  } else {
    b.innerHTML = `<span><b>Sandbox.</b> Try anything: create orders, change costs, approve, reroute. It all runs the real rules in your browser, stays in this tab, and nothing is sent.${S.offline ? " (Offline demo: API not reachable, using built-in people and the demo seed.)" : ""}</span>
      <span class="row-actions" style="margin:0"><button class="btn small" data-g="reload">Reset sandbox</button></span>`;
  }
}

function renderKpis() {
  const p = me();
  const list = R.list.filter(x => inScope(x.r, p));
  const atRisk = list.reduce((s, x) => s + x.m.lostRevenue, 0);
  const out = list.filter(x => x.m.status === "out").length;
  const due = list.filter(x => ["out", "risk", "reorder"].includes(x.m.status) && x.m.orderQty > 0).length;
  const pending = S.revisions.filter(r => r.status === "pending").length;
  const idle = list.filter(x => x.m.status === "idle").reduce((s, x) => s + x.m.value, 0);
  const K = [
    ["Revenue at risk", money(atRisk), `lost before a new order can land (${R.c.lead} days)`, "risk"],
    ["Out of stock now", int(out), "still selling, nothing on hand", "out"],
    ["Orders due", int(due), "position at or under reorder point", "reorder"],
    ["Cost changes waiting", int(pending), "need inventory or finance sign-off", "ledger"],
    ["Idle capital", money(idle), `more than ${R.c.idleWeeks} weeks of cover`, "idle"]
  ];
  $("#kpis").innerHTML = K.map(k => `<button class="panel kpi" data-kpi="${k[3]}"><span class="eyebrow">${k[0]}</span><div class="v">${k[1]}</div><div class="s">${k[2]}</div></button>`).join("");
}

function renderPolicy() {
  const s = UI.sliders;
  $("#lead").value = s.lead; $("#service").value = s.service * 100; $("#mult").value = Math.round(s.mult * 100); $("#margin").value = Math.round(s.marginTarget * 100);
  $("#lead-v").textContent = `${s.lead} days`; $("#service-v").textContent = `${(s.service * 100).toFixed(1).replace(/\.0$/, "")}%`;
  $("#mult-v").textContent = `${s.mult.toFixed(2).replace(/0$/, "")}×`; $("#margin-v").textContent = `${Math.round(s.marginTarget * 100)}%`;
  $("#policy-save").hidden = !S.owner;
}

// ---- the clock ----
function renderClock() {
  const W = 1000, H = 190, L = 40, Rm = 16, T = 26, B = 30, D = 60;
  const X = d => L + (W - L - Rm) * Math.max(0, Math.min(D, d)) / D;
  const p = me();
  const pts = R.list.filter(x => inScope(x.r, p) && x.m.v > 0 && x.m.zero !== null && x.m.zero <= D)
    .sort((a, b) => a.m.zero - b.m.zero);
  const lanes = [], laneH = 15, maxLanes = Math.floor((H - T - B - 10) / laneH);
  const placed = pts.map(x => {
    const px = X(x.m.zero);
    let lane = lanes.findIndex(last => px - last >= 12);
    if (lane === -1) lane = lanes.length < maxLanes ? lanes.length : lanes.indexOf(Math.min(...lanes));
    lanes[lane] = px;
    return { x, px, py: T + 12 + lane * laneH };
  });
  const lead = R.c.lead;
  let ticks = "";
  for (let d = 0; d <= D; d += 7) ticks += `<line x1="${X(d)}" x2="${X(d)}" y1="${T}" y2="${H - B}" stroke="var(--line)"/><text x="${X(d)}" y="${H - B + 16}" font-size="11" fill="var(--muted)" text-anchor="middle">${d === 0 ? "Today" : dateAt(d)}</text>`;
  const sel = R.byKey.get(UI.sel);
  let selMarks = "";
  const selPt = placed.find(q => q.x.m.key === UI.sel);
  if (sel) {
    const y = selPt ? selPt.py : H - B - 8;
    if (Number.isFinite(sel.m.orderBy) && sel.m.orderBy <= D) {
      const ox = X(sel.m.orderBy);
      selMarks += `<path d="M${ox} ${y - 7} l7 7 -7 7 -7 -7z" fill="var(--card)" stroke="var(--ink)" stroke-width="2"><title>Order by ${sel.m.orderBy < 0 ? "now (overdue)" : dateAt(sel.m.orderBy)}</title></path>`;
    }
    for (const a of sel.m.arrivals.filter(a => a.day <= D)) selMarks += `<path d="M${X(a.day)} ${H - B - 2} l6 -10 h-12z" fill="var(--ok)"><title>${a.kind} +${a.qty} on ${dateAt(a.day)}</title></path>`;
  }
  const inLead = pts.filter(x => x.m.zero < lead).length;
  $("#clock").innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${pts.length} products hit zero in the next 60 days, ${inLead} of them inside the lead time">
      <rect x="${X(0)}" y="${T}" width="${X(lead) - X(0)}" height="${H - T - B}" fill="var(--risk-bg)" opacity=".55"/>
      ${ticks}
      <line x1="${X(lead)}" x2="${X(lead)}" y1="${T - 8}" y2="${H - B}" stroke="var(--ink)" stroke-dasharray="4 4"/>
      <text x="${X(lead) + 6}" y="${T - 10}" font-size="11.5" fill="var(--ink)">A PO placed today lands here (${lead} days)</text>
      <text x="${X(0) + 4}" y="${T - 10}" font-size="11.5" fill="var(--risk)">Too late for a normal order: ${inLead}</text>
      ${placed.map(q => `<circle data-k="${esc(q.x.m.key)}" cx="${q.px}" cy="${q.py}" r="${q.x.m.key === UI.sel ? 8 : 5.5}" fill="${STATUS_VAR[q.x.m.status]}" stroke="${q.x.m.key === UI.sel ? "var(--ink)" : "var(--card)"}" stroke-width="2" style="cursor:pointer"/>`).join("")}
      ${selMarks}
    </svg><div class="tip" id="clock-tip"></div>`;
  $("#clock-legend").innerHTML = [["out", "Out now"], ["risk", "Stockout risk"], ["reorder", "Reorder"], ["margin", "Thin margin"], ["ok", "Covered"]]
    .map(([s, l]) => `<span><i style="background:${STATUS_VAR[s]}"></i>${l}</span>`).join("") +
    `<span>◆ order-by · <span style="color:var(--ok)">▲</span> delivery (selected)</span><span>${pts.length} hit zero in 60 days</span>`;
  const svg = $("#clock svg"), tip = $("#clock-tip");
  svg.onpointermove = e => {
    const el = e.target.closest("[data-k]");
    if (!el) { tip.style.opacity = 0; return; }
    const x = R.byKey.get(el.dataset.k);
    const box = $("#clock").getBoundingClientRect();
    tip.innerHTML = `<b>${esc(E.shortName(x.r.name))}</b><br>${esc(x.r.dc_name)} · ${x.m.zero <= 0 ? "out now" : "zero " + dateAt(x.m.zero)} · ${x.m.v.toFixed(1)}/day`;
    tip.style.left = `${e.clientX - box.left}px`; tip.style.top = `${e.clientY - box.top - 8}px`; tip.style.opacity = 1;
  };
  svg.onpointerleave = () => (tip.style.opacity = 0);
  svg.onclick = e => { const el = e.target.closest("[data-k]"); if (el) select(el.dataset.k); };
}

// ---- queue ----
function dueText(a) {
  if (a.status === "resolved") return `<span>Resolved by ${esc(a.resolved_by || "")}</span>`;
  const m = Math.round((new Date(a.due_at).getTime() - Date.now()) / 60000);
  const f = n => (n < 90 ? `${n}m` : n < 2880 ? `${Math.round(n / 60)}h` : `${Math.round(n / 1440)}d`);
  return m < 0 ? `<span class="sla over">Overdue ${f(-m)}</span>` : `<span class="sla">Due in ${f(m)}</span>`;
}

function renderQueue() {
  const p = me();
  let list = S.alerts.filter(a => mineAlert(a, p) && (UI.qresolved || a.status !== "resolved"));
  const counts = {};
  list.forEach(a => (counts[a.type] = (counts[a.type] || 0) + 1));
  if (UI.qtype) list = list.filter(a => a.type === UI.qtype || (UI.qtype === "cost" && a.type.startsWith("cost_")));
  const stRank = { open: 0, acked: 1, resolved: 2 };
  list.sort((a, b) => (stRank[a.status] - stRank[b.status]) || ((b.escalated || 0) - (a.escalated || 0)) ||
    (E.SEVERITY_RANK[a.severity] - E.SEVERITY_RANK[b.severity]) || String(a.due_at).localeCompare(String(b.due_at)));
  $("#queue-title").textContent = p ? `${firstName(p)}'s queue · ${list.filter(a => a.status !== "resolved").length}` : `Queue · ${list.filter(a => a.status !== "resolved").length} open`;
  const types = [["", "All"], ["out_of_stock", "Out"], ["stockout_risk", "Risk"], ["reorder_due", "Reorder"], ["cost", "Cost"], ["margin_breach", "Margin"], ["demand_spike", "Spike"], ["idle_stock", "Idle"], ["po_late", "Late"]];
  $("#queue-filters").innerHTML = types.map(([t, l]) => {
    const n = t === "" ? Object.values(counts).reduce((s, x) => s + x, 0) : t === "cost" ? (counts.cost_minor || 0) + (counts.cost_major || 0) : counts[t] || 0;
    return (t === "" || n) ? `<button class="fchip ${UI.qtype === t ? "on" : ""}" data-qt="${t}">${l} ${n}</button>` : "";
  }).join("") + `<button class="fchip ${UI.qresolved ? "on" : ""}" data-qr="1">Show resolved</button>`;
  const shown = list.slice(0, 120);
  $("#queue").innerHTML = shown.length ? shown.map(a => {
    const owner = person(a.owner_id), cc = ccList(a).map(person).filter(Boolean);
    const esc2 = a.escalated ? `<span class="tag s-out">Escalated → ${esc(firstName(person(a.escalated_to)))}</span>` : "";
    const st = a.status === "acked" ? `<span class="tag s-ok">Acked by ${esc(a.acked_by || "")}</span>` : "";
    const key = `${a.sku}@${a.dc_id}`;
    return `<article class="alert ${key === UI.sel ? "sel" : ""} ${a.status === "resolved" ? "resolved" : ""}" style="--sev:${SEV_VAR[a.severity] || "var(--idle)"}" data-key="${esc(key)}" data-id="${esc(a.id)}">
      <div class="meta" style="margin:0 0 4px"><span class="eyebrow" style="color:${SEV_VAR[a.severity]}">${esc(E.ALERT_TYPES[a.type]?.label || a.type)} · ${esc(a.severity)}</span>${esc2}${st}</div>
      <div class="t">${esc(a.title)}</div>
      <div class="b">${esc(a.body)}</div>
      <div class="meta"><span><b style="color:var(--ink)">${esc(owner?.name || "Unassigned")}</b> · ${esc(roleName(owner?.role || ""))}</span>${cc.length ? `<span>cc ${cc.map(c => esc(firstName(c))).join(", ")}</span>` : ""}${dueText(a)}</div>
      <div class="acts">
        ${a.status === "open" ? `<button class="btn small" data-act="ack">Acknowledge</button>` : ""}
        ${a.status !== "resolved" ? `<button class="btn small" data-act="resolve">Resolve</button>` : `<button class="btn small" data-act="reopen">Reopen</button>`}
        ${a.status !== "resolved" && !a.escalated ? `<button class="btn small" data-act="escalate">Escalate</button>` : ""}
      </div></article>`;
  }).join("") + (list.length > shown.length ? `<p class="empty">+${list.length - shown.length} more. Filter by type to see them.</p>` : "")
    : `<p class="empty">${p ? `Nothing for ${esc(firstName(p))} right now.` : "No open alerts. Run the rules or move the sliders."}</p>`;
}

// ---- detail ----
function ownersFor(r) {
  const scope = { dc_id: r.dc_id, department: r.department, category: r.category };
  return ["warehouse", "buyer", "merch", "inventory", "finance"].map(role => ({ role, p: E.resolvePerson(S.people, role, scope) }));
}

function renderDetail() {
  const x = R.byKey.get(UI.sel);
  const el = $("#detail");
  if (!x) { el.innerHTML = `<p class="empty">Pick a product from the clock, the queue or the table.</p>`; return; }
  const { r, m } = x;
  const st = E.STATUS[m.status];
  const stats = [
    ["On hand", int(m.onHand)], ["On order", int(m.onOrder)], ["Sells / day", m.v.toFixed(2)], ["Weeks of cover", Number.isFinite(m.weeks) ? m.weeks.toFixed(1) : "—"],
    ["Hits zero", m.zero === null ? "Not in 90d" : m.zero <= 0 ? "Now" : dateAt(m.zero)], ["Order by", !Number.isFinite(m.orderBy) ? "—" : m.orderBy < 0 ? "Overdue" : dateAt(m.orderBy)],
    ["Reorder point", int(m.rop)], ["Safety stock", int(m.safety)]
  ];
  el.innerHTML = `
    <div class="d-head">
      <div class="eyebrow">${esc(r.brand)} · ${esc(r.category)} · ${esc(r.department)} · ${esc(r.sku)}</div>
      <h2>${esc(r.name)}</h2>
      <div class="meta muted" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:13px">
        <span class="tag s-${m.status}">${st.label}</span><span>${esc(r.dc_name)}</span><span>Retail ${money(m.price)} · landed ${money(m.unit)} · margin ${pct(m.margin)}</span>
        ${m.lostRevenue > 0 ? `<span style="color:var(--risk)">${money(m.lostRevenue)} at risk</span>` : ""}
      </div>
      <div class="owners">${ownersFor(r).map(o => `<span class="chip" title="${esc(o.p ? personLabelLong(o.p) : "")}"><span class="muted">${esc(roleName(o.role))}</span> <b>${esc(o.p?.name || "—")}</b></span>`).join("")}</div>
    </div>
    <div class="stats">${stats.map(s => `<div><span>${s[0]}</span><b>${s[1]}</b></div>`).join("")}</div>
    <div class="chart" id="burn"></div>
    <div class="tabs" role="tablist">
      ${[["playbook", "If it runs out"], ["order", "Order & transfer"], ["cost", "Landed cost"], ["history", "History"]].map(([k, l]) => `<button role="tab" class="${UI.dtab === k ? "on" : ""}" data-dt="${k}">${l}</button>`).join("")}
    </div>
    <div id="dtab"></div>`;
  drawBurn(x);
  ({ playbook: tabPlaybook, order: tabOrder, cost: tabCost, history: tabHistory })[UI.dtab](x);
}
function personLabelLong(p) { return `${p.name} · ${roleName(p.role)} · ${scopeText(p)} · ${p.email || ""}`; }

function drawBurn({ r, m }) {
  const W = 720, H = 250, L = 44, Rm = 14, T = 16, B = 28, D = 60;
  const curve = m.curve.slice(0, D + 1);
  const arrAt = d => m.arrivals.filter(a => a.day === d).reduce((s, a) => s + a.qty, 0);
  const ymax = Math.max(4, ...curve, m.rop * 1.15) * 1.1;
  const X = d => L + (W - L - Rm) * d / D, Y = v => T + (H - T - B) * (1 - v / ymax);
  const pts = [];
  curve.forEach((v, d) => { const a = arrAt(d); if (a && d > 0) pts.push([X(d), Y(v - a)]); pts.push([X(d), Y(v)]); });
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const area = line + ` L${X(D)} ${Y(0)} L${X(0)} ${Y(0)} Z`;
  const step = ymax > 400 ? 100 : ymax > 120 ? 50 : ymax > 40 ? 10 : ymax > 12 ? 5 : 2;
  let grid = "";
  for (let v = 0; v <= ymax; v += step) grid += `<line x1="${L}" x2="${W - Rm}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${L - 6}" y="${Y(v) + 4}" font-size="11" text-anchor="end" fill="var(--muted)">${v}</text>`;
  for (let d = 0; d <= D; d += 14) grid += `<text x="${X(d)}" y="${H - 8}" font-size="11" text-anchor="middle" fill="var(--muted)">${d === 0 ? "Today" : dateAt(d)}</text>`;
  const color = STATUS_VAR[m.status];
  const lead = R.c.lead;
  const zeroMark = m.zero !== null && m.zero <= D ? `<circle cx="${X(m.zero)}" cy="${Y(0)}" r="5" fill="var(--out)" stroke="var(--card)" stroke-width="2"/><text x="${X(m.zero)}" y="${Y(0) - 10}" font-size="11.5" text-anchor="${m.zero > 50 ? "end" : "middle"}" fill="var(--out)">zero ${m.zero <= 0 ? "now" : dateAt(m.zero)}</text>` : "";
  const arr = m.arrivals.filter(a => a.day <= D).map(a => `<path d="M${X(a.day)} ${Y(curve[a.day] ?? 0) - 4} l6 -10 h-12z" fill="var(--ok)"/><text x="${X(a.day) + 8}" y="${Y(curve[a.day] ?? 0) - 6}" font-size="11.5" fill="var(--ok)">+${a.qty} ${a.kind === "po" ? "PO" : a.kind}${a.late ? " (late)" : ""}</text>`).join("");
  $("#burn").innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Projected stock for the next 60 days">
      ${grid}
      <rect x="${L}" y="${Y(m.safety)}" width="${W - L - Rm}" height="${Math.max(0, Y(0) - Y(m.safety))}" fill="var(--band)"/>
      <text x="${W - Rm - 4}" y="${Y(m.safety / 2) + 4}" font-size="11" text-anchor="end" fill="var(--ok)">${m.safety ? "safety stock " + m.safety : ""}</text>
      ${m.rop ? `<line x1="${L}" x2="${W - Rm}" y1="${Y(m.rop)}" y2="${Y(m.rop)}" stroke="var(--reorder)" stroke-dasharray="5 4" stroke-width="1.5"/><text x="${W - Rm - 4}" y="${Y(m.rop) - 5}" font-size="11" text-anchor="end" fill="var(--reorder)">reorder point ${m.rop}</text>` : ""}
      <line x1="${X(lead)}" x2="${X(lead)}" y1="${T}" y2="${Y(0)}" stroke="var(--ink)" stroke-dasharray="3 4" opacity=".6"/>
      <text x="${X(lead) + 5}" y="${T + 10}" font-size="11" fill="var(--ink-2)">PO placed today lands</text>
      <path d="${area}" fill="${color}" opacity=".10"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2.25" stroke-linejoin="round"/>
      ${zeroMark}${arr}
      <line id="bx" x1="0" x2="0" y1="${T}" y2="${Y(0)}" stroke="var(--ink)" opacity="0"/>
      <circle id="bd" r="4.5" fill="${color}" stroke="var(--card)" stroke-width="2" opacity="0"/>
      <rect x="${L}" y="${T}" width="${W - L - Rm}" height="${H - T - B}" fill="transparent" id="bhit"/>
    </svg><div class="tip" id="burn-tip"></div>`;
  const svg = $("#burn svg"), tip = $("#burn-tip");
  $("#bhit").onpointermove = e => {
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
    const d = Math.max(0, Math.min(D, Math.round((loc.x - L) / (W - L - Rm) * D)));
    const v = curve[d];
    $("#bx").setAttribute("x1", X(d)); $("#bx").setAttribute("x2", X(d)); $("#bx").setAttribute("opacity", ".25");
    $("#bd").setAttribute("cx", X(d)); $("#bd").setAttribute("cy", Y(v)); $("#bd").setAttribute("opacity", "1");
    const box = $("#burn").getBoundingClientRect(), sb = svg.getBoundingClientRect();
    tip.innerHTML = `${d === 0 ? "Today" : dateAt(d)} · <b>${int(v)}</b> units${arrAt(d) ? ` · +${arrAt(d)} arrives` : ""}`;
    tip.style.left = `${(X(d) / W) * sb.width + (sb.left - box.left)}px`; tip.style.top = `${(Y(v) / H) * sb.height}px`; tip.style.opacity = 1;
  };
  $("#bhit").onpointerleave = () => { tip.style.opacity = 0; $("#bx").setAttribute("opacity", "0"); $("#bd").setAttribute("opacity", "0"); };
}

function tabPlaybook({ r, m }) {
  const steps = E.playbook(r, m, R.c, S.people, S.snap.rows, E.isoDay(Date.now()));
  $("#dtab").innerHTML = `
    <div class="steps">${steps.map((s, i) => `<div class="step"><span class="n">${i + 1}</span><div><b>${esc(s.who)}</b>${esc(s.text)}</div></div>`).join("")}</div>
    <div class="row-actions">
      <button class="btn primary" data-d="route">${S.owner ? "Send playbook to owners" : "Preview what owners receive"}</button>
      <span class="note" style="margin:0">${S.owner ? "Posts to Slack and emails the demo inbox, with each owner named." : "In owner mode this goes to Slack and email."}</span>
    </div>`;
}

function tabOrder({ r, m }) {
  const opt = E.options(r, S.snap.rows, R.c);
  const exp = E.etaDays("expedite", R.c);
  const qty = UI.drafts.qty?.[m.key] ?? (m.orderQty || Math.max(6, Math.ceil(m.v * R.c.review)));
  const kind = UI.drafts.kind?.[m.key] || (m.status === "out" || m.status === "risk" ? "expedite" : "po");
  const kinds = [["po", `Standard PO · ${R.c.lead} days`, m.unit], ["expedite", `Expedite · ${exp} days`, m.unit * (1 + R.c.expediteSurcharge)]];
  if (opt.transfer) kinds.push(["transfer", `Transfer from ${opt.transfer.r?.dc_name || opt.transfer.row.dc_name} · ${R.c.transferDays} days`, m.unit]);
  const unit = (kinds.find(k => k[0] === kind) || kinds[0])[2];
  const days = E.etaDays(kind, R.c);
  const covers = m.v > 0 ? (m.position + Number(qty)) / m.v : Infinity;
  const open = S.pos.filter(p => p.sku === r.sku && Number(p.dc_id) === Number(r.dc_id) && p.status === "open");
  $("#dtab").innerHTML = `
    <div class="form">
      <label>Order type<select id="o-kind">${kinds.map(k => `<option value="${k[0]}" ${k[0] === kind ? "selected" : ""}>${esc(k[1])}</option>`).join("")}</select></label>
      <label>Quantity<input id="o-qty" type="number" min="1" step="1" value="${qty}"></label>
    </div>
    <div class="split">
      <div><span>Lands</span><b>${dateAt(days)}</b></div>
      <div><span>Unit cost</span><b>${money(unit)}</b></div>
      <div><span>Order value</span><b>${money(unit * qty)}</b></div>
      <div><span>Cover after</span><b>${Number.isFinite(covers) ? (covers / 7).toFixed(1) + " wk" : "—"}</b></div>
    </div>
    ${m.zero !== null && days > m.zero ? `<div class="callout bad">This lands <b>${Math.ceil(days - m.zero)} days after</b> the shelf hits zero. ${kind === "po" ? "Expedite or transfer to close the gap." : "Show a substitute for the gap."}</div>` : ""}
    ${m.marginLow ? `<div class="callout warn">Margin is ${pct(m.margin)}, under the ${pct(R.c.marginTarget)} floor. ${esc(E.resolvePerson(S.people, "finance", {})?.name || "Finance")} should sign off.</div>` : ""}
    <div class="row-actions"><button class="btn primary" data-d="po">Create ${kind === "transfer" ? "transfer" : "order"}</button><span class="note" style="margin:0">The suggestion covers lead time + ${R.c.review} days + safety stock.</span></div>
    <h3 class="eyebrow" style="margin:18px 0 6px">Open orders for this SKU</h3>
    ${open.length ? `<table><thead><tr><th>#</th><th>Type</th><th class="num">Qty</th><th>ETA</th><th></th></tr></thead><tbody>
      ${open.map(p => `<tr><td>${p.id}</td><td>${esc(p.kind)}</td><td class="num">${int(p.qty)}</td><td>${E.dayLabel(p.eta)}${new Date(p.eta) < new Date() ? ' <span class="tag s-out">late</span>' : ""}</td>
      <td style="text-align:right"><button class="btn small" data-po="receive" data-id="${p.id}">Receive</button> <button class="btn small" data-po="cancel" data-id="${p.id}">Cancel</button></td></tr>`).join("")}</tbody></table>`
      : `<p class="muted" style="margin:0;font-size:13px">None open.</p>`}`;
  const rememberAndRender = () => {
    (UI.drafts.qty ||= {})[m.key] = Math.max(1, Math.round(Number($("#o-qty").value) || 1));
    (UI.drafts.kind ||= {})[m.key] = $("#o-kind").value;
    tabOrder({ r, m });
  };
  $("#o-kind").onchange = rememberAndRender;
  $("#o-qty").onchange = rememberAndRender;
}

function tabCost({ r, m }) {
  const cur = m.comp;
  const draft = UI.drafts.cost?.[m.key] || { ...cur, reason: REASONS[1], effective_date: E.isoDay(Date.now()), note: "" };
  const revs = S.revisions.filter(v => v.sku === r.sku && Number(v.dc_id) === Number(r.dc_id));
  const parts = E.costParts(cur);
  $("#dtab").innerHTML = `
    <p class="note" style="margin-top:0">Current landed cost <b>${money(parts.total)}</b> = production ${money(parts.production)} + freight ${money(parts.freight)} + insurance ${money(parts.insurance)} + duty ${money(parts.duty)} (${parts.duty_pct}% of ${money(parts.customs)}) + handling ${money(parts.handling)}.</p>
    <div class="row-actions" style="margin:6px 0 10px">
      <span class="eyebrow">Quick changes</span>
      <button class="btn small" data-preset="freight:1.25">Freight +25%</button>
      <button class="btn small" data-preset="duty_pct:+10">Tariff +10 pts</button>
      <button class="btn small" data-preset="production:1.06">Supplier +6%</button>
      <button class="btn small" data-preset="production:0.95">Supplier −5%</button>
      <button class="btn small" data-preset="reset">Reset</button>
    </div>
    <div class="form" id="cost-form">
      <label>Production $<input type="number" step="0.01" min="0" name="production" value="${draft.production}"></label>
      <label>Inbound freight $<input type="number" step="0.01" min="0" name="freight" value="${draft.freight}"></label>
      <label>Insurance $<input type="number" step="0.01" min="0" name="insurance" value="${draft.insurance}"></label>
      <label>Duty / tax %<input type="number" step="0.1" min="0" name="duty_pct" value="${draft.duty_pct}"></label>
      <label>Handling $<input type="number" step="0.01" min="0" name="handling" value="${draft.handling}"></label>
      <label>Effective from<input type="date" name="effective_date" value="${draft.effective_date}"></label>
      <label>Reason<select name="reason">${REASONS.map(x => `<option ${x === draft.reason ? "selected" : ""}>${x}</option>`).join("")}</select></label>
      <label>Note<input type="text" name="note" maxlength="120" value="${esc(draft.note || "")}" placeholder="Quote #, carrier, HS code…"></label>
    </div>
    <div id="cost-preview"></div>
    <h3 class="eyebrow" style="margin:18px 0 6px">Cost history for this SKU</h3>
    ${revs.length ? `<table><thead><tr><th>When</th><th class="num">Change</th><th>Landed</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>
      ${revs.map(v => revRow(v)).join("")}</tbody></table>` : `<p class="muted" style="margin:0;font-size:13px">No revisions yet. The file cost is in use.</p>`}`;
  const form = $("#cost-form");
  const read = () => {
    const f = Object.fromEntries([...form.querySelectorAll("[name]")].map(i => [i.name, i.value]));
    return { production: +f.production || 0, freight: +f.freight || 0, insurance: +f.insurance || 0, duty_pct: +f.duty_pct || 0, handling: +f.handling || 0,
      effective_date: f.effective_date || E.isoDay(Date.now()), reason: f.reason, note: f.note };
  };
  const preview = () => {
    const d = read();
    (UI.drafts.cost ||= {})[m.key] = d;
    const nu = E.landed(d), ou = m.unit;
    const p = ou > 0 ? (nu - ou) / ou * 100 : 0;
    const tier = E.approvalTier(p, R.c);
    const approver = tier === "finance" ? E.resolvePerson(S.people, "finance", r) : tier === "inventory" ? E.resolvePerson(S.people, "inventory", r) : null;
    const nm = m.price > 0 ? (m.price - nu) / m.price : 0;
    const nextQty = m.orderQty || Math.max(1, Math.ceil(m.v * R.c.review));
    const blended = E.blendedCost(m.onHand, ou, nextQty, nu);
    const future = d.effective_date > E.isoDay(Date.now());
    const holdPrice = E.priceForMargin(nu, R.c.marginTarget);
    let call = "";
    if (Math.abs(nu - ou) < 0.005) call = `<div class="callout">No change from the current cost.</div>`;
    else if (nu > ou) {
      call = `<div class="callout ${nm < R.c.marginTarget ? "bad" : "warn"}">Cost up <b>${money(nu - ou)}</b> per unit. Margin goes from ${pct(m.margin)} to <b>${pct(nm)}</b>.
        ${nm < R.c.marginTarget ? ` That is under the ${pct(R.c.marginTarget)} floor: ${esc(E.resolvePerson(S.people, "merch", r)?.name || "Merchandising")} gets a price review (hold the floor at ${money(holdPrice)}).` : ""}
        ${future ? `<br><b>Buy ahead:</b> ordering ${int(nextQty)} units before ${E.dayLabel(d.effective_date)} at today's cost saves ${money(nextQty * (nu - ou))}.` : ""}</div>`;
    } else {
      call = `<div class="callout good">Cost down <b>${money(ou - nu)}</b> per unit. Margin goes from ${pct(m.margin)} to <b>${pct(nm)}</b>.
        That gives ${esc(E.resolvePerson(S.people, "merch", r)?.name || "Merchandising")} up to ${money(m.price - holdPrice)} off retail for a promotion while staying at the ${pct(R.c.marginTarget)} floor.
        ${future ? `<br>Hold non-urgent orders until ${E.dayLabel(d.effective_date)}.` : ""}</div>`;
    }
    $("#cost-preview").innerHTML = `
      <div class="split">
        <div><span>New landed</span><b>${money(nu)}</b></div>
        <div><span>Change</span><b style="color:${p > 0 ? "var(--risk)" : p < 0 ? "var(--ok)" : "inherit"}">${p > 0 ? "+" : ""}${p.toFixed(1)}%</b></div>
        <div><span>New margin</span><b>${pct(nm)}</b></div>
        <div><span>Blended cost*</span><b>${money(blended)}</b></div>
        <div><span>Approval</span><b>${tier === "auto" ? "Automatic" : esc(approver?.name || tier)}</b></div>
      </div>
      <p class="note">*Weighted average: ${int(m.onHand)} on hand at ${money(ou)} plus the next ${int(nextQty)} received at ${money(nu)}. Stock already on the shelf keeps its old cost; new receipts come in at the new one.</p>
      ${call}
      <div class="row-actions"><button class="btn primary" data-d="cost" ${Math.abs(nu - ou) < 0.005 ? "disabled" : ""}>${tier === "auto" ? "Save (under 2%, approves itself)" : `Submit for ${esc(approver?.name || "approval")}`}</button>
      <span class="note" style="margin:0">Rule: under ${R.c.costAuto}% automatic · ${R.c.costAuto}–${R.c.costInventory}% inventory manager · over ${R.c.costInventory}% finance.</span></div>`;
  };
  form.oninput = preview;
  preview();
  $("#dtab").querySelectorAll("[data-preset]").forEach(b => b.onclick = () => {
    const [field, v] = b.dataset.preset.split(":");
    const inp = n => form.querySelector(`[name=${n}]`);
    if (field === "reset") { Object.entries(cur).forEach(([k, val]) => inp(k) && (inp(k).value = val)); }
    else if (v.startsWith("+")) inp(field).value = (Number(inp(field).value) + Number(v.slice(1))).toFixed(1);
    else inp(field).value = (Number(inp(field).value) * Number(v)).toFixed(2);
    if (field === "freight") form.querySelector("[name=reason]").value = "Freight rate change";
    if (field === "duty_pct") form.querySelector("[name=reason]").value = "Tariff / duty change";
    if (field === "production") form.querySelector("[name=reason]").value = "Supplier price change";
    preview();
  });
}

function revRow(v, withProduct = false) {
  const x = R.byKey.get(`${v.sku}@${v.dc_id}`);
  const approver = v.tier === "finance" ? "Finance" : v.tier === "inventory" ? "Inventory mgr" : "auto";
  const today = E.isoDay(Date.now());
  const st = v.status === "pending" ? `<span class="tag s-reorder">Waiting · ${approver}</span>` : v.status === "approved" ? `<span class="tag s-ok">${v.effective_date > today ? "Scheduled " + E.dayLabel(v.effective_date) : "Approved"} · ${esc(v.decided_by || "")}</span>` : `<span class="tag s-plain">Rejected · ${esc(v.decided_by || "")}</span>`;
  return `<tr ${withProduct ? `class="click" data-key="${esc(v.sku + "@" + v.dc_id)}"` : ""}>
    <td>${E.dayLabel(v.created_at)}${withProduct ? `<br><span class="muted">${esc(E.shortName(x?.r.name || v.sku))}</span>` : ""}</td>
    <td class="num" style="color:${v.pct > 0 ? "var(--risk)" : "var(--ok)"}">${v.pct > 0 ? "+" : ""}${Number(v.pct).toFixed(1)}%</td>
    <td>${money(v.old_unit)} → ${money(v.new_unit)}</td>
    <td>${esc(v.reason || "")}<br><span class="muted">by ${esc(v.submitted_by || "")}</span></td>
    <td>${st}</td>
    <td style="text-align:right;white-space:nowrap">${v.status === "pending" ? `<button class="btn small" data-rev="approve" data-id="${v.id}">Approve</button> <button class="btn small" data-rev="reject" data-id="${v.id}">Reject</button>` : ""}</td></tr>`;
}

function tabHistory({ r, m }) {
  const sold = (r.weekly || []).map(Number), rec = (r.received_weekly || []).map(Number);
  const W = 680, H = 170, L = 34, Rm = 10, T = 14, B = 26, n = Math.max(sold.length, rec.length, 1);
  const ymax = Math.max(2, ...sold, ...rec) * 1.15;
  const gw = (W - L - Rm) / n, bw = Math.max(4, Math.min(22, gw / 2 - 5));
  const Y = v => T + (H - T - B) * (1 - v / ymax);
  let bars = "";
  for (let i = 0; i < n; i++) {
    const x0 = L + gw * i + gw / 2;
    const s = sold[i] || 0, c = rec[i] || 0;
    bars += `<rect x="${x0 - bw - 1}" y="${Y(s)}" width="${bw}" height="${Y(0) - Y(s)}" rx="3" fill="var(--ink-2)"><title>Sold ${s}</title></rect>`;
    bars += `<rect x="${x0 + 1}" y="${Y(c)}" width="${bw}" height="${Y(0) - Y(c)}" rx="3" fill="var(--ok)"><title>Received ${c}</title></rect>`;
    bars += `<text x="${x0}" y="${H - 8}" font-size="11" text-anchor="middle" fill="var(--muted)">${i === n - 1 ? "This wk" : `−${n - 1 - i}w`}</text>`;
  }
  const ev = S.events.filter(e => e.sku === r.sku).slice(0, 12);
  const al = S.alerts.filter(a => a.sku === r.sku && Number(a.dc_id) === Number(r.dc_id));
  $("#dtab").innerHTML = `
    <div class="legend" style="margin-bottom:4px"><span><i style="background:var(--ink-2);border-radius:2px"></i>Units sold</span><span><i style="background:var(--ok);border-radius:2px"></i>Units received</span><span>Last 8 weeks · received = thelook created_at</span></div>
    <div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly units sold and received"><line x1="${L}" x2="${W - Rm}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--line-2)"/>${bars}</svg></div>
    <p class="note">30-day sales ${int(r.sold_30)} · received ${int(r.received_30 || 0)} · this week ${int(r.sold_7)} vs last week ${int(r.sold_prev_7)} (${m.trend >= 1 ? "+" : ""}${Math.round((m.trend - 1) * 100)}%) · daily swing σ ${m.sdDaily.toFixed(2)}</p>
    <h3 class="eyebrow" style="margin:14px 0 6px">Alerts and activity</h3>
    ${(al.length || ev.length) ? `<table><tbody>
      ${al.map(a => `<tr><td>${E.dayLabel(a.opened_at)}</td><td>${esc(E.ALERT_TYPES[a.type]?.label)}</td><td>${esc(person(a.owner_id)?.name || "")}</td><td>${esc(a.status)}</td></tr>`).join("")}
      ${ev.map(e => `<tr><td>${E.dayLabel(e.at)}</td><td>${esc(e.action)}</td><td>${esc(e.actor || "")}</td><td class="muted">${esc(e.note || "")}</td></tr>`).join("")}
    </tbody></table>` : `<p class="muted" style="margin:0;font-size:13px">Nothing logged yet.</p>`}`;
}

// ---- bottom tabs ----
function renderBottom() {
  const pend = S.revisions.filter(r => r.status === "pending").length;
  const openPo = S.pos.filter(p => p.status === "open").length;
  const tabs = [["products", "All products"], ["ledger", `Cost ledger${pend ? " · " + pend : ""}`], ["pos", `Orders${openPo ? " · " + openPo : ""}`], ["routing", "Who handles what"], ["activity", "Activity"]];
  $("#btabs").innerHTML = tabs.map(([k, l]) => `<button role="tab" class="${UI.btab === k ? "on" : ""}" data-bt="${k}">${l}</button>`).join("");
  ({ products: viewProducts, ledger: viewLedger, pos: viewPos, routing: viewRouting, activity: viewActivity })[UI.btab]();
}

function primaryOwner(r, m) {
  const t = STATUS_TO_TYPE[m.status];
  return E.routeFor(t, { dc_id: r.dc_id, department: r.department, category: r.category }, S.routing, S.people).owner;
}

function viewProducts() {
  const p = me(), f = UI.f;
  const depts = [...new Set(S.snap.rows.map(r => r.department))].filter(Boolean).sort();
  const dcs = [...new Set(S.snap.rows.map(r => r.dc_name))].filter(Boolean).sort();
  let list = R.list.filter(x => inScope(x.r, p) && (!f.dept || x.r.department === f.dept) && (!f.dc || x.r.dc_name === f.dc) && (!f.status || x.m.status === f.status)
    && (!f.q || `${x.r.sku} ${x.r.name} ${x.r.brand} ${x.r.category}`.toLowerCase().includes(f.q.toLowerCase())));
  const k = UI.sort.k, dir = UI.sort.dir;
  const val = x => ({ zero: x.m.zero ?? 9999, onhand: x.m.onHand, onorder: x.m.onOrder, v: x.m.v, weeks: Number.isFinite(x.m.weeks) ? x.m.weeks : 9999,
    orderby: Number.isFinite(x.m.orderBy) ? x.m.orderBy : 9999, landed: x.m.unit, margin: x.m.margin, risk: x.m.lostRevenue, status: E.STATUS[x.m.status].rank, name: x.r.name })[k];
  list.sort((a, b) => { const A = val(a), B = val(b); return (typeof A === "string" ? A.localeCompare(B) : A - B) * dir; });
  const cols = [["name", "Product"], ["status", "Status"], [null, "Owner"], ["onhand", "On hand", 1], ["onorder", "On order", 1], ["v", "/day", 1], ["weeks", "Weeks", 1], ["zero", "Zero"], ["orderby", "Order by"], ["landed", "Landed", 1], ["margin", "Margin", 1], ["risk", "At risk", 1]];
  $("#bview").innerHTML = `
    <div class="tbl-tools">
      <select id="f-dept"><option value="">All departments</option>${depts.map(d => `<option ${d === f.dept ? "selected" : ""}>${esc(d)}</option>`).join("")}</select>
      <select id="f-dc"><option value="">All warehouses</option>${dcs.map(d => `<option ${d === f.dc ? "selected" : ""}>${esc(d)}</option>`).join("")}</select>
      <select id="f-status"><option value="">All statuses</option>${Object.entries(E.STATUS).map(([s, v]) => `<option value="${s}" ${s === f.status ? "selected" : ""}>${v.label}</option>`).join("")}</select>
      <input id="f-q" type="search" placeholder="Search SKU, brand, category" value="${esc(f.q)}">
      <span class="muted" style="font-size:13px">${int(list.length)} rows${p ? ` in ${esc(firstName(p))}'s scope` : ""}</span>
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr>${cols.map(c => `<th class="${c[0] ? "sortable" : ""} ${c[2] ? "num" : ""}" ${c[0] ? `data-sort="${c[0]}"` : ""}>${c[1]}${UI.sort.k === c[0] ? (dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead>
      <tbody>${list.slice(0, UI.limit).map(({ r, m }) => {
        const o = primaryOwner(r, m);
        return `<tr class="click ${m.key === UI.sel ? "sel" : ""}" data-key="${esc(m.key)}">
          <td><b style="font-weight:500">${esc(E.shortName(r.name))}</b><br><span class="muted">${esc(r.dc_name)} · ${esc(r.category)}</span></td>
          <td><span class="tag s-${m.status}">${E.STATUS[m.status].label}</span></td>
          <td>${esc(o?.name || "—")}<br><span class="muted">${esc(roleName(o?.role || ""))}</span></td>
          <td class="num">${int(m.onHand)}</td><td class="num">${m.onOrder ? int(m.onOrder) : "—"}</td><td class="num">${m.v.toFixed(1)}</td>
          <td class="num">${Number.isFinite(m.weeks) ? m.weeks.toFixed(1) : "—"}</td>
          <td>${m.zero === null ? "—" : m.zero <= 0 ? "Now" : dateAt(m.zero)}</td>
          <td>${!Number.isFinite(m.orderBy) ? "—" : m.orderBy < 0 ? '<span style="color:var(--out)">Overdue</span>' : dateAt(m.orderBy)}</td>
          <td class="num">${money(m.unit)}</td><td class="num" style="${m.marginLow ? "color:var(--margin)" : ""}">${pct(m.margin)}</td>
          <td class="num">${m.lostRevenue > 0 ? money(m.lostRevenue) : "—"}</td></tr>`;
      }).join("")}</tbody></table>
      ${list.length > UI.limit ? `<div class="empty"><button class="btn small" data-g="more">Show ${Math.min(150, list.length - UI.limit)} more</button></div>` : ""}
      ${!list.length ? `<p class="empty">No products match.</p>` : ""}
    </div>`;
  const f2 = () => { UI.f = { dept: $("#f-dept").value, dc: $("#f-dc").value, status: $("#f-status").value, q: $("#f-q").value }; UI.limit = 150; viewProducts(); };
  $("#f-dept").onchange = f2; $("#f-dc").onchange = f2; $("#f-status").onchange = f2;
  $("#f-q").oninput = () => { clearTimeout(viewProducts.t); viewProducts.t = setTimeout(() => { f2(); $("#f-q").focus(); const q = $("#f-q"); q.setSelectionRange(q.value.length, q.value.length); }, 200); };
}

function viewLedger() {
  const list = [...S.revisions].sort((a, b) => (a.status === "pending" ? -1 : 0) - (b.status === "pending" ? -1 : 0) || Number(b.id) - Number(a.id));
  $("#bview").innerHTML = `
    <p class="note" style="margin-top:0">Every landed-cost change is a revision: old and new parts, reason, start date, who submitted it, who approved it. Nothing is overwritten. Approved changes apply from their effective date.</p>
    <div class="tbl-wrap">${list.length ? `<table><thead><tr><th>When / product</th><th class="num">Change</th><th>Landed</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>${list.map(v => revRow(v, true)).join("")}</tbody></table>`
      : `<p class="empty">No cost changes yet. Open a product's Landed cost tab to make one.</p>`}</div>`;
}

function viewPos() {
  const list = [...S.pos].sort((a, b) => (a.status === "open" ? -1 : 0) - (b.status === "open" ? -1 : 0) || String(a.eta).localeCompare(String(b.eta)));
  $("#bview").innerHTML = `<div class="tbl-wrap">${list.length ? `<table><thead><tr><th>#</th><th>Product</th><th>Type</th><th class="num">Qty</th><th class="num">Unit</th><th>Created</th><th>ETA</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map(p => { const x = R.byKey.get(`${p.sku}@${p.dc_id}`); const late = p.status === "open" && new Date(p.eta) < new Date();
      return `<tr class="click" data-key="${esc(p.sku + "@" + p.dc_id)}"><td>${p.id}</td><td>${esc(E.shortName(x?.r.name || p.sku))}<br><span class="muted">${esc(p.dc_name || "")}</span></td><td>${esc(p.kind)}</td>
      <td class="num">${int(p.qty)}</td><td class="num">${money(p.unit_cost)}</td><td>${E.dayLabel(p.created_at)}<br><span class="muted">${esc(p.created_by || "")}</span></td>
      <td>${E.dayLabel(p.eta)}</td><td><span class="tag ${late ? "s-out" : p.status === "open" ? "s-reorder" : p.status === "received" ? "s-ok" : "s-plain"}">${late ? "late" : p.status}</span></td>
      <td style="text-align:right;white-space:nowrap">${p.status === "open" ? `<button class="btn small" data-po="receive" data-id="${p.id}">Receive</button> <button class="btn small" data-po="cancel" data-id="${p.id}">Cancel</button>` : ""}</td></tr>`; }).join("")}
    </tbody></table>` : `<p class="empty">No orders yet. Create one from a product's Order tab.</p>`}</div>`;
}

function viewRouting() {
  const roles = Object.keys(E.ROLES);
  const open = id => S.alerts.filter(a => a.status !== "resolved" && a.owner_id === id).length;
  const h = m => (m < 120 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`);
  $("#bview").innerHTML = `
    <p class="note" style="margin-top:0">Each alert type has a primary owner role, roles copied in, a response deadline, and a severity. The person is then picked automatically: <b>the most specific match wins</b> (warehouse + department + category beats department alone, which beats company-wide). If nobody acknowledges before the deadline, it goes to that person's manager.</p>
    <div class="tbl-wrap" style="max-height:none"><table>
      <thead><tr><th>Alert</th><th>Owner role</th><th>Copied</th><th>Respond within</th><th>Severity</th><th>Closes when</th><th></th></tr></thead>
      <tbody>${S.routing.map(rt => `<tr data-rt="${rt.alert_type}">
        <td><b style="font-weight:500">${esc(E.ALERT_TYPES[rt.alert_type]?.label || rt.alert_type)}</b></td>
        <td><select name="primary_role">${roles.map(r => `<option value="${r}" ${r === rt.primary_role ? "selected" : ""}>${esc(roleName(r))}</option>`).join("")}</select></td>
        <td><div style="display:flex;flex-wrap:wrap;gap:4px 10px;max-width:280px">${["inventory", "finance", "buyer", "warehouse", "merch"].map(r => `<label style="font-size:12px;white-space:nowrap"><input type="checkbox" name="cc" value="${r}" ${String(rt.cc_roles).split(",").includes(r) ? "checked" : ""}> ${esc(roleName(r))}</label>`).join("")}</div></td>
        <td><select name="sla_minutes">${[30, 60, 120, 240, 480, 1440, 2880, 4320, 7200, 10080].concat([rt.sla_minutes]).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b).map(v => `<option value="${v}" ${v === rt.sla_minutes ? "selected" : ""}>${h(v)}</option>`).join("")}</select></td>
        <td><select name="severity">${["critical", "high", "medium", "low"].map(s => `<option ${s === rt.severity ? "selected" : ""}>${s}</option>`).join("")}</select></td>
        <td class="muted">${esc(rt.closes_when || "")}</td>
        <td><button class="btn small" data-save-rt="${rt.alert_type}">Save</button></td></tr>`).join("")}</tbody></table></div>
    <h3 class="eyebrow" style="margin:20px 0 6px">People (fictional demo staff)</h3>
    <div class="tbl-wrap" style="max-height:420px"><table>
      <thead><tr><th>Name</th><th>Role</th><th>Scope</th><th>Escalates to</th><th>Email (demo)</th><th class="num">Open alerts</th></tr></thead>
      <tbody>${S.people.map(p => `<tr><td><b style="font-weight:500">${esc(p.name)}</b></td><td>${esc(roleName(p.role))}</td><td>${esc(scopeText(p))}</td><td>${esc(person(p.manager_id)?.name || "—")}</td><td class="muted">${esc(p.email || "")}</td><td class="num">${open(p.id) || "—"}</td></tr>`).join("")}</tbody>
    </table></div>`;
}

function viewActivity() {
  $("#bview").innerHTML = `<div class="tbl-wrap">${S.events.length ? `<table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead><tbody>
    ${S.events.slice(0, 150).map(e => `<tr ${e.sku ? `class="click" data-key="${esc(e.sku + "@" + (e.dc_id ?? ""))}"` : ""}><td style="white-space:nowrap">${new Date(e.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td><td>${esc(e.actor || "system")}</td><td>${esc(e.action)}</td><td class="muted">${esc(e.note || e.alert_id || "")}</td></tr>`).join("")}
  </tbody></table>` : `<p class="empty">No activity yet.</p>`}</div>`;
}

// ---------------- modals ----------------
function modal(html) { $("#modal-box").innerHTML = html; $("#modal").classList.add("on"); }
function closeModal() { $("#modal").classList.remove("on"); }
$("#modal").addEventListener("click", e => { if (e.target.id === "modal" || e.target.closest("[data-close]")) closeModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

function previewRoute(sku, dc_id) {
  const x = R.byKey.get(`${sku}@${dc_id}`); if (!x) return;
  const steps = E.playbook(x.r, x.m, R.c, S.people, S.snap.rows, E.isoDay(Date.now()));
  const slack = `*Playbook · ${x.r.name}*\n${x.r.dc_name} · ${int(x.m.onHand)} on hand · ${x.m.v.toFixed(1)}/day · ${E.STATUS[x.m.status].label}\n\n` + steps.map((s, i) => `*${i + 1}. ${s.who}*\n${s.text}`).join("\n\n");
  const email = `Subject: [Stock Clock] Playbook · ${E.shortName(x.r.name)} (${x.r.dc_name})\n\n` + steps.map((s, i) => `${i + 1}. ${s.who}\n   ${s.text}`).join("\n");
  modal(`<div class="panel-head"><h2>What the owners receive</h2><button class="btn small" data-close>Close</button></div>
    <p class="note">Sandbox preview. In owner mode this posts to the demo Slack channel and emails the demo inbox.</p>
    <h3 class="eyebrow">Slack</h3><pre>${esc(slack)}</pre><h3 class="eyebrow">Email</h3><pre>${esc(email)}</pre>`);
}

function ownerSignIn() {
  modal(`<div class="panel-head"><h2>Owner sign-in</h2><button class="btn small" data-close>Close</button></div>
    <p class="note">Paste the OWNER_TOKEN you set with <code>wrangler secret put</code>. It is kept in this browser only.</p>
    <div class="row-actions"><input id="tok" type="password" autocomplete="off" style="flex:1;min-width:200px" placeholder="Owner token"><button class="btn primary" id="tok-go">Sign in</button></div>`);
  setTimeout(() => $("#tok")?.focus(), 30);
  const go = async () => {
    const t = $("#tok").value.trim(); if (!t) return;
    const res = await fetch("/api/whoami", { headers: { authorization: "Bearer " + t } }).catch(() => null);
    const d = res ? await res.json().catch(() => ({})) : {};
    if (!d.owner) { toast("That token didn't work."); return; }
    token = t; store.set("sc-owner", t); closeModal(); await load(); resetSliders(); render(); toast("Owner mode on. Actions now write to the database.");
  };
  $("#tok-go").onclick = go;
  $("#tok").onkeydown = e => { if (e.key === "Enter") go(); };
}

function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), 2800); }

// ---------------- events ----------------
function select(key, scroll = false) {
  UI.sel = key;
  render();
  if (scroll && window.innerWidth < 1100) $("#detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

document.addEventListener("click", async e => {
  const t = e.target;
  const g = t.closest("[data-g]")?.dataset.g;
  if (g === "reload") { await load(); S.alerts = []; S.events = []; if (!S.owner) { S.pos = S.pos.filter(p => p.id < 9000); } sandboxRun(false); render(); toast("Sandbox reset"); return; }
  if (g === "test") { const d = await act("test"); if (d?.results) toast(d.results.map(r => `${r.channel}: ${r.ok ? "sent" : r.skipped ? "not set" : "failed"}`).join(" · ")); return; }
  if (g === "more") { UI.limit += 150; viewProducts(); return; }
  const kpi = t.closest("[data-kpi]")?.dataset.kpi;
  if (kpi) {
    if (kpi === "ledger") UI.btab = "ledger";
    else { UI.btab = "products"; UI.f.status = kpi; UI.sort = kpi === "risk" ? { k: "risk", dir: -1 } : kpi === "idle" ? { k: "landed", dir: -1 } : { k: "zero", dir: 1 }; }
    render(); $("#btabs").scrollIntoView({ behavior: "smooth", block: "start" }); return;
  }
  const qt = t.closest("[data-qt]"); if (qt) { UI.qtype = qt.dataset.qt; renderQueue(); return; }
  if (t.closest("[data-qr]")) { UI.qresolved = !UI.qresolved; renderQueue(); return; }
  const alertEl = t.closest(".alert");
  if (alertEl) {
    const a = t.closest("[data-act]")?.dataset.act;
    if (a) { await act(a, { id: alertEl.dataset.id }); return; }
    if (R.byKey.has(alertEl.dataset.key)) select(alertEl.dataset.key, true);
    return;
  }
  const dt = t.closest("[data-dt]"); if (dt) { UI.dtab = dt.dataset.dt; renderDetail(); return; }
  const bt = t.closest("[data-bt]"); if (bt) { UI.btab = bt.dataset.bt; renderBottom(); return; }
  const srt = t.closest("[data-sort]");
  if (srt) { const k = srt.dataset.sort; UI.sort = UI.sort.k === k ? { k, dir: -UI.sort.dir } : { k, dir: ["risk", "v", "onhand", "landed", "margin"].includes(k) ? -1 : 1 }; viewProducts(); return; }
  const d = t.closest("[data-d]")?.dataset.d;
  if (d) {
    const x = R.byKey.get(UI.sel); if (!x) return;
    if (d === "route") { const res = await act("route", { sku: x.r.sku, dc_id: x.r.dc_id }); if (S.owner && res?.results) toast(res.results.map(r => `${r.channel}: ${r.ok ? "sent" : r.skipped ? "not set" : "failed"}`).join(" · ")); return; }
    if (d === "po") {
      const kind = $("#o-kind").value, qty = Math.max(1, Math.round(Number($("#o-qty").value) || 0));
      const opt = E.options(x.r, S.snap.rows, R.c);
      await act("po", { sku: x.r.sku, dc_id: x.r.dc_id, qty, kind, source_dc_id: kind === "transfer" ? opt.transfer?.row.dc_id : null });
      if (UI.drafts.qty) delete UI.drafts.qty[x.m.key];
      return;
    }
    if (d === "cost") {
      const dr = UI.drafts.cost?.[x.m.key]; if (!dr) return;
      const components = { production: dr.production, freight: dr.freight, insurance: dr.insurance, handling: dr.handling, duty_pct: dr.duty_pct };
      await act("cost", { sku: x.r.sku, dc_id: x.r.dc_id, components, reason: dr.reason + (dr.note ? ` · ${dr.note}` : ""), effective_date: dr.effective_date });
      delete UI.drafts.cost[x.m.key];
      return;
    }
  }
  const po = t.closest("[data-po]"); if (po) { await act(po.dataset.po, { id: Number(po.dataset.id) }); return; }
  const rev = t.closest("[data-rev]"); if (rev) { await act(rev.dataset.rev, { id: Number(rev.dataset.id) }); return; }
  const srt2 = t.closest("[data-save-rt]");
  if (srt2) {
    const tr = srt2.closest("tr");
    await act("routing", { alert_type: srt2.dataset.saveRt, primary_role: tr.querySelector("[name=primary_role]").value,
      cc_roles: [...tr.querySelectorAll("[name=cc]:checked")].map(i => i.value).join(","), sla_minutes: Number(tr.querySelector("[name=sla_minutes]").value),
      severity: tr.querySelector("[name=severity]").value });
    if (S.owner) toast("Routing saved. New alerts follow it.");
    return;
  }
  const row = t.closest("tr.click[data-key]"); if (row && R.byKey.has(row.dataset.key)) { select(row.dataset.key, true); return; }
});

$("#me").onchange = e => { UI.me = e.target.value; UI.sel = null; render(); };
$("#owner-btn").onclick = async () => {
  if (S.owner) { token = null; store.set("sc-owner", null); await load(); render(); toast("Signed out. Sandbox mode."); }
  else ownerSignIn();
};
$("#run-rules").onclick = async () => { const d = await act("run", { notify: true }); if (S.owner && d) toast(`Rules ran: ${d.opened} opened, ${d.resolved} closed, ${d.escalated} escalated`); };
const sliderInput = () => {
  UI.sliders = { lead: +$("#lead").value, service: +$("#service").value / 100, mult: +$("#mult").value / 100, marginTarget: +$("#margin").value / 100 };
  render();
};
["lead", "service", "mult", "margin"].forEach(id => $("#" + id).addEventListener("input", sliderInput));
$("#policy-reset").onclick = () => { resetSliders(); render(); };
$("#policy-save").onclick = async () => {
  const d = await act("policy", { lead: UI.sliders.lead, service: UI.sliders.service, marginTarget: UI.sliders.marginTarget, review: R.c.review });
  if (d) { resetSliders(); render(); toast("Policy saved. The 30-minute rules run now uses it."); }
};

// ---------------- boot ----------------
(async function boot() {
  await load();
  const q = new URLSearchParams(location.search);
  if (q.get("alert")) {
    const a = S.alerts.find(x => x.id === q.get("alert"));
    if (a) { UI.sel = `${a.sku}@${a.dc_id}`; if (a.owner_id) UI.me = String(a.owner_id); }
  } else if (q.get("sku")) UI.sel = `${q.get("sku")}@${q.get("dc")}`;
  if (q.get("as")) UI.me = q.get("as");
  render();
})();
