// Stock Clock engine — one file, used by BOTH the Worker (cron alerts) and the browser
// (sliders + sandbox), so the numbers people see are the numbers that trigger alerts.
// Pure functions only: no fetch, no DOM, no storage.

export const DAY = 86400000;

export const DEFAULTS = {
  lead: 14,            // supplier lead time, days
  review: 28,          // how many days one order should cover after it lands
  service: 0.95,       // target in-stock probability -> safety stock z
  mult: 1,             // demand multiplier (what-if)
  marginTarget: 0.20,  // margin floor that triggers finance/merch
  idleWeeks: 26,       // more cover than this = idle capital
  expediteFactor: 0.35,// expedited lead = lead × this
  expediteSurcharge: 0.15, // expedited freight adds 15% of landed cost per unit
  transferDays: 3,
  costAuto: 2,         // |Δ| under 2% approves itself
  costInventory: 5,    // 2–5% inventory manager; above -> finance
  horizon: 90
};

export const ROLES = {
  inventory: "Inventory manager",
  finance: "Finance",
  buyer: "Buyer",
  warehouse: "Warehouse lead",
  merch: "Merchandising",
  ops_head: "Head of operations",
  merch_head: "Head of buying & merch",
  cfo: "CFO"
};

export const ALERT_TYPES = {
  out_of_stock:  { label: "Out of stock now",   short: "Out" },
  stockout_risk: { label: "Stockout risk",      short: "Risk" },
  reorder_due:   { label: "Reorder due",        short: "Reorder" },
  cost_minor:    { label: "Cost change 2–5%",   short: "Cost" },
  cost_major:    { label: "Cost change over 5%",short: "Cost" },
  margin_breach: { label: "Margin breach",      short: "Margin" },
  demand_spike:  { label: "Demand spike",       short: "Spike" },
  idle_stock:    { label: "Idle stock",         short: "Idle" },
  po_late:       { label: "Late delivery",      short: "Late" }
};

export const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

// ---------- small helpers ----------
export const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
export const keyOf = r => `${r.sku}@${r.dc_id}`;
export const fmtInt = n => new Intl.NumberFormat("en-US").format(Math.round(n || 0));
export const fmtMoney = n => {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 10000) return (v < 0 ? "-$" : "$") + new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, notation: "compact" }).format(abs);
  return (v < 0 ? "-$" : "$") + abs.toFixed(2);
};
export function addDays(date, n) { return new Date(new Date(date).getTime() + n * DAY); }
export function dayLabel(date) {
  if (!date) return "—";
  return new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
export function isoDay(date) { return new Date(date).toISOString().slice(0, 10); }

// Inverse normal CDF (Acklam) — turns a service level into a z-score.
export function zFor(p) {
  p = Math.min(0.999, Math.max(0.5, Number(p) || 0.95));
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ---------- landed cost ----------
// The snapshot has one cost number. We split it into parts with a labelled default
// so the inventory manager can revise each part. Duty is charged on the customs
// value = production + freight + insurance (CIF), then handling is added.
export const DEFAULT_SPLIT = { production: 0.70, freight: 0.12, insurance: 0.03, handling: 0.05, duty: 0.10 };

export function defaultCost(fileCost) {
  const c = Number(fileCost) || 0;
  const customs = c * (DEFAULT_SPLIT.production + DEFAULT_SPLIT.freight + DEFAULT_SPLIT.insurance);
  return {
    production: r2(c * DEFAULT_SPLIT.production),
    freight: r2(c * DEFAULT_SPLIT.freight),
    insurance: r2(c * DEFAULT_SPLIT.insurance),
    handling: r2(c * DEFAULT_SPLIT.handling),
    duty_pct: customs > 0 ? Math.round((c * DEFAULT_SPLIT.duty / customs) * 1000) / 10 : 0
  };
}

export function costParts(p) {
  const production = +p.production || 0, freight = +p.freight || 0, insurance = +p.insurance || 0;
  const handling = +p.handling || 0, duty_pct = +p.duty_pct || 0;
  const customs = production + freight + insurance;
  const duty = customs * duty_pct / 100;
  return { production, freight, insurance, duty, handling, duty_pct, customs, total: customs + duty + handling };
}
export const landed = p => costParts(p).total;

export function blendedCost(onHand, oldUnit, incomingQty, newUnit) {
  const q = Math.max(0, onHand) + Math.max(0, incomingQty);
  if (q <= 0) return newUnit;
  return (Math.max(0, onHand) * oldUnit + Math.max(0, incomingQty) * newUnit) / q;
}

export function approvalTier(pct, s = DEFAULTS) {
  const a = Math.abs(pct);
  if (a < s.costAuto) return "auto";
  if (a <= s.costInventory) return "inventory";
  return "finance";
}

export const priceForMargin = (cost, target) => cost / Math.max(0.01, 1 - target);

// ---------- context ----------
// Builds per-SKU adjustments from purchase orders/transfers recorded in the app.
// pos: [{id, sku, dc_id, qty, kind, status, eta, received_at, source_dc_id}]
export function buildAdjust(pos = [], snapshotAsOf, now = Date.now()) {
  const adj = {};
  const asOfMs = new Date(snapshotAsOf + "T23:59:59Z").getTime();
  const get = k => (adj[k] ||= { onHandDelta: 0, arrivals: [], open: [] });
  for (const po of pos) {
    const k = `${po.sku}@${po.dc_id}`;
    if (po.status === "open") {
      const etaMs = new Date(po.eta).getTime();
      const day = Math.max(1, Math.ceil((etaMs - now) / DAY));
      get(k).arrivals.push({ day, qty: +po.qty, kind: po.kind, id: po.id, late: etaMs < now });
      get(k).open.push(po);
      if (po.kind === "transfer" && po.source_dc_id != null) {
        get(`${po.sku}@${po.source_dc_id}`).onHandDelta -= +po.qty;
      }
    } else if (po.status === "received" && po.received_at && new Date(po.received_at).getTime() > asOfMs) {
      get(k).onHandDelta += +po.qty;
    }
  }
  return adj;
}

export function makeCtx(settings = {}, extra = {}) {
  return { ...DEFAULTS, ...settings, ...extra, adjust: extra.adjust || {}, costs: extra.costs || {} };
}

// ---------- per-SKU metrics ----------
export function metrics(row, ctx) {
  const key = keyOf(row);
  const v = Math.max(0, (Number(row.sold_30) || 0) / 30) * ctx.mult;
  const weekly = Array.isArray(row.weekly) ? row.weekly.map(Number) : [];
  let sdDaily;
  if (weekly.length >= 4 && weekly.some(x => x > 0)) {
    const mean = weekly.reduce((s, x) => s + x, 0) / weekly.length;
    const varW = weekly.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, weekly.length - 1);
    sdDaily = Math.max(Math.sqrt(varW / 7), Math.sqrt(v) * 0.5) * ctx.mult;
  } else {
    sdDaily = Math.sqrt(v); // Poisson fallback when there's no history
  }
  const z = zFor(ctx.service);
  const safety = v > 0 ? Math.ceil(z * sdDaily * Math.sqrt(ctx.lead)) : 0;
  const rop = v > 0 ? Math.ceil(v * ctx.lead + safety) : 0;

  const adj = ctx.adjust[key] || { onHandDelta: 0, arrivals: [], open: [] };
  const onHand = Math.max(0, (Number(row.on_hand) || 0) + adj.onHandDelta);
  const arrivals = [...adj.arrivals].sort((a, b) => a.day - b.day);
  const onOrder = arrivals.reduce((s, a) => s + a.qty, 0);
  const position = onHand + onOrder;

  // Day-by-day burn with arrivals; lost sales only count inside the lead time,
  // because anything ordered today can cover demand after that.
  const H = ctx.horizon;
  const curve = [];
  let stock = onHand, zero = null, lost = 0;
  for (let d = 0; d <= H; d++) {
    for (const a of arrivals) if (a.day === d) stock += a.qty;
    curve.push(stock);
    if (d === H) break;
    if (v > 0 && zero === null && stock - v <= 0) zero = stock <= 0 ? d : d + stock / v;
    const sell = Math.min(stock, v);
    if (d < ctx.lead) lost += v - sell;
    stock -= sell;
  }
  const nextArrival = arrivals.length ? arrivals[0].day : null;
  const coverDays = v > 0 ? onHand / v : Infinity;
  const orderBy = v > 0 ? (position - rop) / v : Infinity; // days; negative = overdue
  const orderQty = v > 0 ? Math.max(0, Math.ceil(v * (ctx.lead + ctx.review) + safety - position)) : 0;

  const comp = ctx.costs[key] || defaultCost(row.cost);
  const unit = landed(comp);
  const price = Number(row.price) || 0;
  const margin = price > 0 ? (price - unit) / price : 0;
  const value = onHand * unit;
  const lostRevenue = lost * price;
  const trend = (Number(row.sold_7) || 0) / Math.max(1, Number(row.sold_prev_7) || 0);
  const spike = (Number(row.sold_7) || 0) >= 3 && (Number(row.sold_7) || 0) >= 1.5 * Math.max(1, Number(row.sold_prev_7) || 0);
  const idle = onHand >= 20 && (v === 0 || coverDays > ctx.idleWeeks * 7);
  const marginLow = price > 0 && margin < ctx.marginTarget;

  let status = "ok";
  if (onHand <= 0 && v > 0) status = "out";
  else if (lost >= 1 && zero !== null && zero < ctx.lead && (nextArrival === null || nextArrival > zero)) status = "risk";
  else if (v > 0 && position <= rop) status = "reorder";
  else if (idle) status = "idle";
  else if (marginLow) status = "margin";

  return {
    key, v, sdDaily, safety, rop, onHand, onOrder, position, arrivals, curve, zero, lost, lostRevenue,
    nextArrival, coverDays, weeks: coverDays / 7, orderBy, orderQty, comp, unit, price, margin, value,
    trend, spike, idle, marginLow, status
  };
}

export const STATUS = {
  out:     { label: "Out of stock", rank: 0 },
  risk:    { label: "Stockout risk", rank: 1 },
  reorder: { label: "Reorder", rank: 2 },
  margin:  { label: "Thin margin", rank: 3 },
  idle:    { label: "Idle", rank: 4 },
  ok:      { label: "Covered", rank: 5 }
};

// Same-SKU stock at another DC (transfer) or a close substitute at the same DC.
export function options(row, rows, ctx, mCache = new Map()) {
  const M = r => { const k = keyOf(r); if (!mCache.has(k)) mCache.set(k, metrics(r, ctx)); return mCache.get(k); };
  const transfer = rows
    .filter(o => o.sku === row.sku && o.dc_id !== row.dc_id)
    .map(o => ({ row: o, m: M(o) }))
    .filter(x => x.m.weeks > 6 && x.m.onHand >= 6)
    .sort((a, b) => b.m.onHand - a.m.onHand)[0] || null;
  const price = Number(row.price) || 0;
  const substitute = rows
    .filter(o => o.sku !== row.sku && o.dc_id === row.dc_id && o.category === row.category && o.department === row.department
      && Math.abs((Number(o.price) || 0) - price) <= price * 0.3)
    .map(o => ({ row: o, m: M(o) }))
    .filter(x => x.m.weeks > 4 && x.m.onHand >= 5)
    .sort((a, b) => b.m.weeks - a.m.weeks)[0] || null;
  return { transfer, substitute };
}

// ---------- ownership ----------
// Most specific person wins: DC + department + category beats DC + department, etc.
export function resolvePerson(people, role, scope = {}) {
  let best = null, bestScore = -1;
  for (const p of people) {
    if (p.role !== role || p.active === 0) continue;
    let score = 0, ok = true;
    for (const f of ["dc_id", "department", "category"]) {
      if (p[f] != null && p[f] !== "") {
        if (String(p[f]) !== String(scope[f] ?? "")) { ok = false; break; }
        score++;
      }
    }
    if (ok && score > bestScore) { best = p; bestScore = score; }
  }
  return best;
}

export function routeFor(type, scope, routing, people) {
  const rule = routing.find(r => r.alert_type === type) || { primary_role: "inventory", cc_roles: "", sla_minutes: 1440, severity: "medium" };
  const owner = resolvePerson(people, rule.primary_role, scope);
  const cc = String(rule.cc_roles || "").split(",").map(s => s.trim()).filter(Boolean)
    .map(role => resolvePerson(people, role, scope)).filter(Boolean).filter(p => !owner || p.id !== owner.id);
  return { rule, owner, cc };
}

export function personLabel(p) {
  if (!p) return "Unassigned";
  const scope = [p.department, p.category, p.dc_name].filter(Boolean).join(", ");
  return `${p.name} · ${ROLES[p.role] || p.role}${scope ? " (" + scope + ")" : ""}`;
}

// ---------- alert candidates ----------
// Every rule that is TRUE right now becomes a candidate. The reconcile step below
// decides what is new, what stays open, and what closes on its own.
export function alertCandidates(rows, ctx, { pos = [], revisions = [], now = Date.now(), asOf } = {}) {
  const out = [];
  const asOfDate = new Date((asOf || isoDay(now)) + "T00:00:00Z");
  const scopeOf = r => ({ dc_id: r.dc_id, department: r.department, category: r.category, dc_name: r.dc_name });
  for (const r of rows) {
    const m = metrics(r, ctx);
    const base = { sku: r.sku, dc_id: r.dc_id, dc_name: r.dc_name, name: r.name, department: r.department, category: r.category, scope: scopeOf(r) };
    const nm = shortName(r.name || r.sku);
    if (m.status === "out") {
      out.push({ ...base, type: "out_of_stock", id: `out_of_stock:${m.key}`,
        title: `${nm} is out of stock at ${r.dc_name}`,
        body: `0 on hand, selling ${m.v.toFixed(1)}/day, so about ${fmtMoney(m.v * m.price)}/day in lost sales. Set available-to-promise to 0, show a substitute, expedite stock.`,
        metric: { v: m.v, lostRevenue: m.lostRevenue } });
    } else if (m.status === "risk") {
      out.push({ ...base, type: "stockout_risk", id: `stockout_risk:${m.key}`,
        title: `${nm} hits zero ${dayLabel(addDays(asOfDate, m.zero))} at ${r.dc_name}`,
        body: `${fmtInt(m.onHand)} left at ${m.v.toFixed(1)}/day. A normal order lands too late: about ${fmtInt(Math.ceil(m.lost))} units (${fmtMoney(m.lostRevenue)}) lost inside the ${ctx.lead}-day lead time unless you transfer or expedite.`,
        metric: { zero: m.zero, lost: m.lost, lostRevenue: m.lostRevenue } });
    } else if (m.status === "reorder") {
      out.push({ ...base, type: "reorder_due", id: `reorder_due:${m.key}`,
        title: `Reorder ${nm} for ${r.dc_name}`,
        body: `Stock + on order is ${fmtInt(m.position)} against a reorder point of ${fmtInt(m.rop)}. Order ${fmtInt(m.orderQty)} units (about ${fmtMoney(m.orderQty * m.unit)}) ${m.orderBy < 0 ? "now; it is overdue" : "by " + dayLabel(addDays(asOfDate, m.orderBy))}.`,
        metric: { orderQty: m.orderQty, rop: m.rop, position: m.position } });
    }
    if (m.marginLow && m.v > 0) {
      out.push({ ...base, type: "margin_breach", id: `margin_breach:${m.key}`,
        title: `${nm} margin is ${Math.round(m.margin * 100)}%`,
        body: `Landed ${fmtMoney(m.unit)} vs retail ${fmtMoney(m.price)}. To hold ${Math.round(ctx.marginTarget * 100)}%, price needs to be ${fmtMoney(priceForMargin(m.unit, ctx.marginTarget))} or cost has to come down.`,
        metric: { margin: m.margin } });
    }
    if (m.spike) {
      out.push({ ...base, type: "demand_spike", id: `demand_spike:${m.key}`,
        title: `${nm} demand up ${Math.round((m.trend - 1) * 100)}% week on week`,
        body: `${r.sold_7} sold this week vs ${r.sold_prev_7} last week. Recheck safety stock (${fmtInt(m.safety)} units) and the next order size.`,
        metric: { trend: m.trend } });
    }
    if (m.status === "idle") {
      out.push({ ...base, type: "idle_stock", id: `idle_stock:${m.key}`,
        title: `${fmtMoney(m.value)} idle in ${nm} at ${r.dc_name}`,
        body: `${fmtInt(m.onHand)} units, ${Number.isFinite(m.weeks) ? m.weeks.toFixed(0) + " weeks" : "no sales in 30 days"} of cover. Mark down or move; block new orders.`,
        metric: { value: m.value } });
    }
  }
  const byKey = new Map(rows.map(r => [keyOf(r), r]));
  for (const po of pos) {
    if (po.status !== "open" || new Date(po.eta).getTime() >= now) continue;
    const r = byKey.get(`${po.sku}@${po.dc_id}`) || { sku: po.sku, dc_id: po.dc_id, dc_name: po.dc_name || "", name: po.sku };
    out.push({ sku: r.sku, dc_id: r.dc_id, dc_name: r.dc_name, name: r.name, department: r.department, category: r.category,
      scope: scopeOf(r), type: "po_late", id: `po_late:${po.id}`,
      title: `${po.kind === "transfer" ? "Transfer" : "PO"} #${po.id} for ${shortName(r.name)} is late`,
      body: `${fmtInt(po.qty)} units were due ${dayLabel(po.eta)}. Chase the ${po.kind === "transfer" ? "sending warehouse" : "supplier"} and set a new date.`,
      metric: { po: po.id } });
  }
  for (const rev of revisions) {
    if (rev.status !== "pending") continue;
    const r = byKey.get(`${rev.sku}@${rev.dc_id}`) || { sku: rev.sku, dc_id: rev.dc_id, dc_name: "", name: rev.sku };
    const type = rev.tier === "finance" ? "cost_major" : "cost_minor";
    out.push({ sku: r.sku, dc_id: r.dc_id, dc_name: r.dc_name, name: r.name, department: r.department, category: r.category,
      scope: scopeOf(r), type, id: `${type}:rev${rev.id}`,
      title: `Approve cost change ${rev.pct > 0 ? "+" : ""}${Number(rev.pct).toFixed(1)}% on ${shortName(r.name)}`,
      body: `Landed ${fmtMoney(rev.old_unit)} → ${fmtMoney(rev.new_unit)} from ${dayLabel(rev.effective_date)}. Reason: ${rev.reason || "not given"}.`,
      metric: { revision: rev.id } });
  }
  return out;
}

export function shortName(s) {
  s = String(s || "").trim();
  return s.length > 42 ? s.slice(0, 40).trimEnd() + "…" : s;
}

// ---------- reconcile ----------
// existing: alerts already stored (any status). Returns what to insert/update/resolve/escalate.
// Manual resolutions are respected for 7 days; system resolutions reopen when the rule fires again.
export function reconcile(existing, candidates, routing, people, now = Date.now()) {
  const ex = new Map(existing.map(a => [a.id, a]));
  const seen = new Set();
  const inserts = [], reopens = [], updates = [], resolves = [], escalations = [];
  for (const c of candidates) {
    seen.add(c.id);
    const { rule, owner, cc } = routeFor(c.type, c.scope, routing, people);
    const routed = {
      ...c, severity: rule.severity, sla_minutes: rule.sla_minutes,
      owner_id: owner?.id ?? null, cc_ids: cc.map(p => p.id).join(","),
      due_at: new Date(now + rule.sla_minutes * 60000).toISOString()
    };
    const e = ex.get(c.id);
    if (!e) { inserts.push(routed); continue; }
    if (e.status === "resolved") {
      const manual = e.resolved_by && e.resolved_by !== "system";
      const recent = now - new Date(e.resolved_at).getTime() < 7 * DAY;
      if (manual && recent) continue;
      reopens.push(routed);
    } else if (e.title !== c.title || e.body !== c.body) {
      updates.push({ id: c.id, title: c.title, body: c.body });
    }
  }
  for (const e of existing) {
    if ((e.status === "open" || e.status === "acked") && !seen.has(e.id)) resolves.push({ id: e.id, why: "Condition cleared" });
  }
  for (const e of existing) {
    if (e.status !== "open" || !seen.has(e.id) || (e.escalated || 0) > 0) continue;
    if (new Date(e.due_at).getTime() < now) {
      const owner = people.find(p => p.id === e.owner_id);
      const mgr = owner ? people.find(p => p.id === owner.manager_id) : null;
      escalations.push({ id: e.id, to_id: mgr?.id ?? null, title: e.title, type: e.type, severity: e.severity, owner_id: e.owner_id });
    }
  }
  return { inserts, reopens, updates, resolves, escalations };
}

// ---------- playbook ----------
// "If this SKU runs out" — named steps per owner, built from the routing table.
export function playbook(row, m, ctx, people, rows, asOf) {
  const scope = { dc_id: row.dc_id, department: row.department, category: row.category };
  const who = role => resolvePerson(people, role, scope);
  const nameOf = role => { const p = who(role); return p ? `${p.name} (${ROLES[role]})` : ROLES[role]; };
  const base = new Date((asOf || isoDay(Date.now())) + "T00:00:00Z");
  const opt = options(row, rows, ctx);
  const steps = [];
  const expLead = Math.max(2, Math.round(ctx.lead * ctx.expediteFactor));
  if (m.status === "out" || m.status === "risk") {
    steps.push({ role: "warehouse", who: nameOf("warehouse"),
      text: m.status === "out" ? `Set available-to-promise to 0 now. Stop confirming orders for ${shortName(row.name)}.`
        : `Set available-to-promise to 0 on ${dayLabel(addDays(base, m.zero))}. Promise no more than ${fmtInt(m.onHand)} units.` });
    if (opt.transfer) steps.push({ role: "warehouse", who: "Both warehouse leads",
      text: `Transfer up to ${fmtInt(Math.min(opt.transfer.m.onHand - 4, Math.max(m.orderQty, 6)))} from ${opt.transfer.row.dc_name} (${opt.transfer.m.weeks.toFixed(1)} weeks of cover). Lands in about ${ctx.transferDays} days.` });
    steps.push({ role: "buyer", who: nameOf("buyer"),
      text: `Expedite ${fmtInt(Math.max(m.orderQty, Math.ceil(m.v * expLead)))} units: about ${expLead} days instead of ${ctx.lead}, at roughly +${fmtMoney(m.unit * ctx.expediteSurcharge)} freight per unit.` });
    steps.push({ role: "merch", who: nameOf("merch"),
      text: opt.substitute ? `Show ${shortName(opt.substitute.row.name)} as the substitute on the product page (${opt.substitute.m.weeks.toFixed(1)} weeks of cover).`
        : `No close substitute in stock at ${row.dc_name}. Hide the product or switch it to backorder.` });
    steps.push({ role: "finance", who: nameOf("finance"),
      text: m.marginLow ? `Margin is ${Math.round(m.margin * 100)}% before the expedite surcharge. Approve or block the expedite.`
        : `Margin is ${Math.round(m.margin * 100)}%; after expedite freight it is ${Math.round(((m.price - m.unit * (1 + ctx.expediteSurcharge)) / Math.max(1, m.price)) * 100)}%. The expedite can go.` });
  } else if (m.status === "reorder") {
    steps.push({ role: "buyer", who: nameOf("buyer"), text: `Raise a PO for ${fmtInt(m.orderQty)} units (${fmtMoney(m.orderQty * m.unit)}). It lands in ${ctx.lead} days.` });
    steps.push({ role: "inventory", who: nameOf("inventory"), text: `Check safety stock: ${fmtInt(m.safety)} units at ${Math.round(ctx.service * 100)}% service.` });
    if (m.marginLow) steps.push({ role: "finance", who: nameOf("finance"), text: `Margin is ${Math.round(m.margin * 100)}%. Sign off before the PO goes out.` });
  } else if (m.status === "idle") {
    steps.push({ role: "merch", who: nameOf("merch"), text: `Mark down or bundle: ${fmtMoney(m.value)} is tied up with ${Number.isFinite(m.weeks) ? m.weeks.toFixed(0) + " weeks" : "no sales"} of cover.` });
    steps.push({ role: "inventory", who: nameOf("inventory"), text: `Block new orders for this SKU at ${row.dc_name}.` });
  } else {
    steps.push({ role: "inventory", who: nameOf("inventory"), text: `Covered for ${Number.isFinite(m.weeks) ? m.weeks.toFixed(1) + " weeks" : "a long time"}. No action at these settings.` });
    steps.push({ role: "buyer", who: nameOf("buyer"), text: Number.isFinite(m.orderBy) ? `Next order by ${dayLabel(addDays(base, Math.max(0, m.orderBy)))}.` : "No sales, so no order needed." });
    if (m.marginLow) steps.push({ role: "finance", who: nameOf("finance"), text: `Margin ${Math.round(m.margin * 100)}% is under the ${Math.round(ctx.marginTarget * 100)}% target.` });
  }
  return steps;
}

// Current cost per SKU = latest APPROVED revision whose effective date has arrived.
export function costsFromRevisions(revisions = [], today = isoDay(Date.now())) {
  const out = {}, idOf = {};
  for (const r of revisions) {
    if (r.status !== "approved" || String(r.effective_date) > today) continue;
    const k = `${r.sku}@${r.dc_id}`;
    if (idOf[k] == null || Number(r.id) > idOf[k]) {
      idOf[k] = Number(r.id);
      out[k] = typeof r.new_json === "string" ? JSON.parse(r.new_json) : r.new_json;
    }
  }
  return out;
}

// ETA in days for a new order of this kind, under the current policy.
export function etaDays(kind, ctx) {
  if (kind === "transfer") return ctx.transferDays;
  if (kind === "expedite") return Math.max(2, Math.round(ctx.lead * ctx.expediteFactor));
  return ctx.lead;
}
