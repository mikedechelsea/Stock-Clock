-- Stock Clock · Cloudflare D1 schema + demo seed
-- Run once:  npx wrangler d1 execute stock-clock --remote --file=schema.sql
-- Safe to re-run: tables are created if missing; demo people and routing are re-seeded.
-- All people below are FICTIONAL demo staff. thelook has no employee table.

CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,            -- inventory | finance | buyer | warehouse | merch | ops_head | merch_head | cfo
  dc_id INTEGER,                 -- scope: NULL = all warehouses
  dc_name TEXT,
  department TEXT,               -- scope: NULL = all departments
  category TEXT,                 -- scope: NULL = all categories
  email TEXT,                    -- display only; real email goes to ALERT_EMAIL_TO
  slack TEXT,
  manager_id INTEGER,
  backup_id INTEGER,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS routing (
  alert_type TEXT PRIMARY KEY,
  primary_role TEXT NOT NULL,
  cc_roles TEXT NOT NULL DEFAULT '',
  sla_minutes INTEGER NOT NULL,
  severity TEXT NOT NULL,        -- critical | high | medium | low
  closes_when TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,           -- type:sku@dc  (stable, so the same problem never alerts twice)
  type TEXT NOT NULL,
  sku TEXT, dc_id INTEGER, dc_name TEXT, name TEXT, department TEXT, category TEXT,
  title TEXT NOT NULL,
  body TEXT,
  severity TEXT,
  owner_id INTEGER,
  cc_ids TEXT,
  status TEXT NOT NULL DEFAULT 'open',   -- open | acked | resolved
  opened_at TEXT NOT NULL,
  due_at TEXT,
  acked_at TEXT, acked_by TEXT,
  resolved_at TEXT, resolved_by TEXT,
  escalated INTEGER NOT NULL DEFAULT 0,
  escalated_to INTEGER,
  notified_at TEXT
);
CREATE INDEX IF NOT EXISTS alerts_status ON alerts(status);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  alert_id TEXT, sku TEXT, dc_id INTEGER,
  actor TEXT,
  action TEXT NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS events_at ON events(at);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL, dc_id INTEGER NOT NULL, dc_name TEXT,
  qty INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'po',       -- po | expedite | transfer
  unit_cost REAL,
  source_dc_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open',   -- open | received | cancelled
  created_at TEXT NOT NULL, created_by TEXT,
  eta TEXT NOT NULL,
  received_at TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS cost_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL, dc_id INTEGER NOT NULL,
  old_json TEXT NOT NULL, new_json TEXT NOT NULL,
  old_unit REAL NOT NULL, new_unit REAL NOT NULL,
  pct REAL NOT NULL,
  tier TEXT NOT NULL,                    -- auto | inventory | finance
  reason TEXT,
  effective_date TEXT NOT NULL,
  submitted_by TEXT,
  status TEXT NOT NULL DEFAULT 'pending',-- pending | approved | rejected
  decided_by TEXT, decided_at TEXT,
  created_at TEXT NOT NULL
);

-- ---------- demo people ----------
DELETE FROM people;
INSERT INTO people (id, name, role, dc_id, dc_name, department, category, email, slack, manager_id, backup_id) VALUES
 (1,  'Folake Adebayo', 'ops_head',   NULL, NULL, NULL, NULL, 'folake.adebayo@stockclock.demo', '@folake', NULL, NULL),
 (2,  'Michael Osei',   'cfo',        NULL, NULL, NULL, NULL, 'michael.osei@stockclock.demo',   '@michael', NULL, NULL),
 (3,  'Sarah Lin',      'merch_head', NULL, NULL, NULL, NULL, 'sarah.lin@stockclock.demo',      '@sarah', NULL, NULL),
 (10, 'Ngozi Okafor',   'inventory',  NULL, NULL, NULL, NULL, 'ngozi.okafor@stockclock.demo',   '@ngozi', 1, NULL),
 (11, 'Daniel Mensah',  'finance',    NULL, NULL, NULL, NULL, 'daniel.mensah@stockclock.demo',  '@daniel', 2, NULL),
 (12, 'Aisha Bello',    'buyer',      NULL, NULL, 'Women', NULL, 'aisha.bello@stockclock.demo', '@aisha', 3, 14),
 (13, 'Tunde Adeyemi',  'buyer',      NULL, NULL, 'Men',   NULL, 'tunde.adeyemi@stockclock.demo', '@tunde', 3, NULL),
 (14, 'Chioma Eze',     'buyer',      NULL, NULL, 'Women', 'Jeans', 'chioma.eze@stockclock.demo', '@chioma', 3, 12),
 (15, 'Grace Park',     'merch',      NULL, NULL, 'Women', NULL, 'grace.park@stockclock.demo',  '@grace', 3, NULL),
 (16, 'Luis Romero',    'merch',      NULL, NULL, 'Men',   NULL, 'luis.romero@stockclock.demo', '@luis', 3, NULL),
 (21, 'Marcus Reed',    'warehouse',  1,  'Memphis TN',      NULL, NULL, 'marcus.reed@stockclock.demo',   '@marcus', 1, NULL),
 (22, 'Priya Shah',     'warehouse',  2,  'Chicago IL',      NULL, NULL, 'priya.shah@stockclock.demo',    '@priya', 1, NULL),
 (23, 'Carlos Vega',    'warehouse',  3,  'Houston TX',      NULL, NULL, 'carlos.vega@stockclock.demo',   '@carlos', 1, NULL),
 (24, 'Emily Tran',     'warehouse',  4,  'Los Angeles CA',  NULL, NULL, 'emily.tran@stockclock.demo',    '@emily', 1, NULL),
 (25, 'Andre Thomas',   'warehouse',  5,  'New Orleans LA',  NULL, NULL, 'andre.thomas@stockclock.demo',  '@andre', 1, NULL),
 (26, 'Rachel Cohen',   'warehouse',  6,  'Port Authority NY/NJ', NULL, NULL, 'rachel.cohen@stockclock.demo', '@rachel', 1, NULL),
 (27, 'Kevin Brien',    'warehouse',  7,  'Philadelphia PA', NULL, NULL, 'kevin.brien@stockclock.demo',   '@kevin', 1, NULL),
 (28, 'Tasha Williams', 'warehouse',  8,  'Mobile AL',       NULL, NULL, 'tasha.williams@stockclock.demo','@tasha', 1, NULL),
 (29, 'James Porter',   'warehouse',  9,  'Charleston SC',   NULL, NULL, 'james.porter@stockclock.demo',  '@james', 1, NULL),
 (30, 'Maya Patel',     'warehouse',  10, 'Savannah GA',     NULL, NULL, 'maya.patel@stockclock.demo',    '@maya', 1, NULL),
 -- fallback buyer/merch for any department not listed above
 (40, 'Ola Johnson',    'buyer',      NULL, NULL, NULL, NULL, 'ola.johnson@stockclock.demo', '@ola', 3, NULL),
 (41, 'Hannah Kim',     'merch',      NULL, NULL, NULL, NULL, 'hannah.kim@stockclock.demo',  '@hannah', 3, NULL),
 (42, 'Yusuf Ali',      'warehouse',  NULL, NULL, NULL, NULL, 'yusuf.ali@stockclock.demo',   '@yusuf', 1, NULL);

-- ---------- routing: who owns each alert ----------
DELETE FROM routing;
INSERT INTO routing (alert_type, primary_role, cc_roles, sla_minutes, severity, closes_when, updated_at) VALUES
 ('out_of_stock',  'warehouse', 'merch,buyer',     60,   'critical', 'Stock received or substitute shown', datetime('now')),
 ('stockout_risk', 'warehouse', 'buyer',           240,  'high',     'Transfer or expedite lands before zero', datetime('now')),
 ('reorder_due',   'buyer',     'inventory',       2880, 'medium',   'PO created', datetime('now')),
 ('cost_minor',    'inventory', 'finance',         1440, 'medium',   'Cost change approved or rejected', datetime('now')),
 ('cost_major',    'finance',   'inventory',       1440, 'high',     'Cost change approved or rejected', datetime('now')),
 ('margin_breach', 'finance',   'merch',           2880, 'medium',   'Margin back above target, or accepted', datetime('now')),
 ('demand_spike',  'buyer',     'inventory',       1440, 'medium',   'Safety stock reviewed', datetime('now')),
 ('idle_stock',    'merch',     'inventory',       7200, 'low',      'Markdown or transfer logged', datetime('now')),
 ('po_late',       'buyer',     'warehouse',       240,  'high',     'Received or new date set', datetime('now'));

INSERT OR IGNORE INTO settings (k, v) VALUES
 ('policy', '{"lead":14,"review":28,"service":0.95,"marginTarget":0.2}');
