// Slack (incoming webhook) + email (Resend) delivery.
// Every fictional owner's alert goes to ONE demo Slack channel and ONE demo inbox,
// with the owner's name in the message — so the public never sees your real address.
import { ROLES, ALERT_TYPES, SEVERITY_RANK } from "../public/engine.js";

const ICON = { critical: "🔴", high: "🟠", medium: "🟡", low: "⚪" };
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function channels(env) {
  return { slack: !!env.SLACK_WEBHOOK_URL, email: !!(env.RESEND_API_KEY && env.ALERT_EMAIL_TO) };
}

export async function sendSlack(env, payload) {
  if (!env.SLACK_WEBHOOK_URL) return { channel: "slack", skipped: true };
  try {
    const r = await fetch(env.SLACK_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    return { channel: "slack", ok: r.ok, status: r.status, detail: r.ok ? "" : (await r.text()).slice(0, 200) };
  } catch (e) { return { channel: "slack", ok: false, detail: String(e.message || e) }; }
}

export async function sendEmail(env, { subject, html, text }) {
  if (!env.RESEND_API_KEY || !env.ALERT_EMAIL_TO) return { channel: "email", skipped: true };
  try {
    const r = await fetch(env.RESEND_API_URL || "https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: env.EMAIL_FROM || "Stock Clock <onboarding@resend.dev>",
        to: String(env.ALERT_EMAIL_TO).split(",").map(s => s.trim()).filter(Boolean),
        subject, html, text
      })
    });
    return { channel: "email", ok: r.ok, status: r.status, detail: r.ok ? "" : (await r.text()).slice(0, 200) };
  } catch (e) { return { channel: "email", ok: false, detail: String(e.message || e) }; }
}

function who(people, id) {
  const p = people.find(x => x.id === id);
  if (!p) return "Unassigned";
  const scope = [p.department, p.category, p.dc_name].filter(Boolean).join(", ");
  return `${p.name} · ${ROLES[p.role] || p.role}${scope ? " (" + scope + ")" : ""}`;
}
function dueIn(iso) {
  const m = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (m < 0) return `overdue ${fmtDur(-m)}`;
  return `due in ${fmtDur(m)}`;
}
function fmtDur(m) { return m < 90 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; }
const link = (base, a) => base ? `${base.replace(/\/$/, "")}/?alert=${encodeURIComponent(a.id)}` : "";

// Build one digest (Slack blocks + email HTML) from new + escalated alerts.
export function buildDigest({ opened = [], escalated = [], people = [], baseUrl = "" }) {
  const sort = (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
  opened = [...opened].sort(sort); escalated = [...escalated].sort(sort);
  const groups = new Map();
  for (const a of opened) {
    const k = a.owner_id ?? "none";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  const headline = `${opened.length} new alert${opened.length === 1 ? "" : "s"}${escalated.length ? ` · ${escalated.length} escalated` : ""}`;
  const blocks = [{ type: "header", text: { type: "plain_text", text: `Stock Clock · ${headline}` } }];
  if (escalated.length) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text:
      "*Escalated (owner did not acknowledge in time)*\n" + escalated.slice(0, 8).map(a =>
        `${ICON[a.severity] || "•"} ${esc(a.title)} → *${esc(who(people, a.escalated_to))}* (owner ${esc(who(people, a.owner_id).split(" · ")[0])})${link(baseUrl, a) ? ` <${link(baseUrl, a)}|open>` : ""}`).join("\n") } });
  }
  let shown = 0;
  for (const [ownerId, list] of groups) {
    if (shown >= 10) break;
    shown++;
    const cc = list[0].cc_ids ? String(list[0].cc_ids).split(",").map(Number).map(id => who(people, id).split(" · ")[0]).join(", ") : "";
    blocks.push({ type: "section", text: { type: "mrkdwn", text:
      `*${esc(who(people, ownerId === "none" ? null : ownerId))}*${cc ? `  _cc ${esc(cc)}_` : ""}\n` +
      list.slice(0, 4).map(a => `${ICON[a.severity] || "•"} ${esc(a.title)} · _${dueIn(a.due_at)}_${link(baseUrl, a) ? ` <${link(baseUrl, a)}|open>` : ""}`).join("\n") +
      (list.length > 4 ? `\n_+${list.length - 4} more_` : "") } });
  }
  if (groups.size > shown) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `+${groups.size - shown} more owners have new alerts.` }] });
  if (baseUrl) blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open Stock Clock" }, url: baseUrl }] });

  const row = a => `<tr><td style="padding:6px 8px;border-bottom:1px solid #e6e0d4">${ICON[a.severity] || ""} ${esc(ALERT_TYPES[a.type]?.label || a.type)}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #e6e0d4"><b>${esc(a.title)}</b><br><span style="color:#6f675c">${esc(a.body)}</span></td>
    <td style="padding:6px 8px;border-bottom:1px solid #e6e0d4;white-space:nowrap">${dueIn(a.due_at)}${link(baseUrl, a) ? `<br><a href="${link(baseUrl, a)}">open</a>` : ""}</td></tr>`;
  let html = `<div style="font-family:Arial,sans-serif;color:#1c1915;max-width:760px">
    <h2 style="font-weight:500;margin:0 0 4px">Stock Clock · ${esc(headline)}</h2>
    <p style="color:#6f675c;margin:0 0 16px">Demo routing: every owner below is a fictional person; all of their alerts arrive in this one inbox.</p>`;
  if (escalated.length) {
    html += `<h3 style="margin:16px 0 6px;color:#b23a1c">Escalated</h3><table style="border-collapse:collapse;width:100%;font-size:14px">` +
      escalated.slice(0, 15).map(a => `<tr><td style="padding:6px 8px;border-bottom:1px solid #e6e0d4">${ICON[a.severity] || ""} <b>${esc(a.title)}</b><br><span style="color:#6f675c">Now with ${esc(who(people, a.escalated_to))}. Owner was ${esc(who(people, a.owner_id))}.</span></td></tr>`).join("") + `</table>`;
  }
  let lines = 0;
  for (const [ownerId, list] of groups) {
    if (lines >= 40) break;
    html += `<h3 style="margin:18px 0 6px">To: ${esc(who(people, ownerId === "none" ? null : ownerId))}</h3><table style="border-collapse:collapse;width:100%;font-size:14px">`;
    for (const a of list.slice(0, 6)) { html += row(a); lines++; }
    html += `</table>` + (list.length > 6 ? `<p style="color:#6f675c;margin:4px 0">+${list.length - 6} more for this owner</p>` : "");
  }
  if (baseUrl) html += `<p style="margin-top:20px"><a href="${baseUrl}" style="background:#1c1915;color:#fff;padding:9px 14px;border-radius:8px;text-decoration:none">Open Stock Clock</a></p>`;
  html += `</div>`;
  const text = `Stock Clock · ${headline}\n\n` + opened.slice(0, 40).map(a => `- [${a.severity}] ${a.title} → ${who(people, a.owner_id)} (${dueIn(a.due_at)})`).join("\n");
  const top = escalated[0] || opened[0];
  return {
    slack: { text: `Stock Clock · ${headline}`, blocks: blocks.slice(0, 48) },
    email: { subject: `[Stock Clock] ${headline}${top ? " · " + top.title : ""}`.slice(0, 150), html, text }
  };
}

// Playbook for one SKU, sent on demand ("Route to owners").
export function buildRoute({ row, steps, metricsLine, baseUrl, actor }) {
  const url = baseUrl ? `${baseUrl.replace(/\/$/, "")}/?sku=${encodeURIComponent(row.sku)}&dc=${row.dc_id}` : "";
  const blocks = [
    { type: "header", text: { type: "plain_text", text: `Playbook · ${String(row.name).slice(0, 120)}` } },
    { type: "context", elements: [{ type: "mrkdwn", text: `${esc(row.dc_name)} · ${esc(metricsLine)} · routed by ${esc(actor || "owner")}` }] },
    ...steps.map((s, i) => ({ type: "section", text: { type: "mrkdwn", text: `*${i + 1}. ${esc(s.who)}*\n${esc(s.text)}` } }))
  ];
  if (url) blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open in Stock Clock" }, url }] });
  const html = `<div style="font-family:Arial,sans-serif;color:#1c1915;max-width:680px">
    <h2 style="font-weight:500;margin:0">Playbook · ${esc(row.name)}</h2>
    <p style="color:#6f675c">${esc(row.dc_name)} · ${esc(metricsLine)}</p>
    <ol>${steps.map(s => `<li style="margin:0 0 10px"><b>${esc(s.who)}</b><br>${esc(s.text)}</li>`).join("")}</ol>
    ${url ? `<p><a href="${url}">Open in Stock Clock</a></p>` : ""}</div>`;
  return {
    slack: { text: `Playbook · ${row.name}`, blocks: blocks.slice(0, 48) },
    email: { subject: `[Stock Clock] Playbook · ${String(row.name).slice(0, 80)} (${row.dc_name})`, html,
      text: steps.map((s, i) => `${i + 1}. ${s.who}: ${s.text}`).join("\n") }
  };
}
