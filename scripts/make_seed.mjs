// Builds public/seed.json: a DEMO snapshot shaped exactly like the BigQuery table.
// Used only when KV has no live snapshot yet (and for local testing). Labelled as demo.
import { writeFileSync } from "node:fs";

let s = 42;
const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pick = a => a[Math.floor(rnd() * a.length)];
const DCS = [[1, "Memphis TN"], [2, "Chicago IL"], [3, "Houston TX"], [4, "Los Angeles CA"], [5, "New Orleans LA"],
  [6, "Port Authority of New York/New Jersey NY/NJ"], [7, "Philadelphia PA"], [8, "Mobile AL"], [9, "Charleston SC"], [10, "Savannah GA"]];
const CATS = {
  Women: [["Jeans", ["Levi's", "Joe's Jeans", "Calvin Klein Jeans"], ["High Rise Skinny Jean", "Bootcut Jean", "Mom Jean", "Wide Leg Jean"]],
    ["Dresses", ["Calvin Klein", "Tommy Hilfiger", "Maggy London"], ["Midi Wrap Dress", "Shift Dress", "Sweater Dress"]],
    ["Sweaters", ["Tommy Hilfiger", "Jones New York"], ["Cable Knit Crew", "Cashmere V-Neck", "Cardigan"]],
    ["Outerwear & Coats", ["Columbia", "The North Face"], ["Waterproof Shell", "Puffer Jacket", "Wool Coat"]],
    ["Active", ["Nike", "Under Armour"], ["Sports Bra", "Running Tight", "Training Tank"]],
    ["Intimates", ["Hanes", "Calvin Klein"], ["Seamless Brief 3-Pack", "T-Shirt Bra"]]],
  Men: [["Jeans", ["Levi's", "Lee", "Wrangler"], ["Straight Fit Jean", "Slim Taper Jean", "Relaxed Jean"]],
    ["Fashion Hoodies & Sweatshirts", ["Champion", "Carhartt"], ["Pullover Hoodie", "Crewneck Sweatshirt"]],
    ["Sweaters", ["Nautica", "Polo Ralph Lauren"], ["Merino V-Neck", "Quarter Zip"]],
    ["Outerwear & Coats", ["Carhartt", "Columbia"], ["Canvas Field Jacket", "Fleece Jacket", "Rain Jacket"]],
    ["Active", ["Nike", "adidas"], ["Dri-FIT Tee", "Training Short"]],
    ["Socks", ["Gold Toe", "Hanes"], ["Crew Sock 6-Pack", "Ankle Sock 6-Pack"]]]
};
const COLORS = ["Black", "Navy", "Stone", "Olive", "Rust", "Heather Grey", "Indigo"];
const rows = [];
let n = 0;
for (const dept of ["Women", "Men"]) {
  for (const [cat, brands, styles] of CATS[dept]) {
    for (let i = 0; i < 9; i++) {
      const brand = pick(brands), style = pick(styles), color = pick(COLORS);
      const price = Math.round(18 + rnd() * 140);
      const costPct = 0.38 + rnd() * 0.32 + (rnd() < 0.12 ? 0.22 : 0);
      const cost = Math.round(price * costPct * 100) / 100;
      const daily = rnd() < 0.15 ? 0 : 0.1 + rnd() ** 1.7 * 3.2;
      const weekly = Array.from({ length: 8 }, (_, w) => {
        const lift = rnd() < 0.08 && w >= 6 ? 2.2 : 1;
        return Math.max(0, Math.round(daily * 7 * lift * (0.6 + rnd() * 0.8)));
      });
      const sold_7 = weekly[7], sold_prev_7 = weekly[6];
      const sold_30 = Math.round(weekly.slice(4).reduce((a, b) => a + b, 0) * 30 / 28);
      const shape = rnd();
      let on_hand;
      if (daily === 0) on_hand = Math.round(25 + rnd() * 110);
      else if (shape < 0.10) on_hand = 0;
      else if (shape < 0.30) on_hand = Math.round(daily * (2 + rnd() * 10));
      else if (shape < 0.50) on_hand = Math.round(daily * (14 + rnd() * 14));
      else on_hand = Math.round(daily * (28 + rnd() * 120));
      const received_weekly = weekly.map(w => (rnd() < 0.3 ? Math.round(w * (2 + rnd() * 2)) : 0));
      const [dc_id, dc_name] = pick(DCS);
      const sku = `${cat.slice(0, 3).toUpperCase()}${dept[0]}-${(10000 + n++).toString(16).toUpperCase()}`;
      const row = {
        as_of: "", sku, dc_id, dc_name, name: `${brand} ${dept}'s ${style} ${color}`, brand, category: cat, department: dept,
        price, cost, on_hand, sold_30, sold_7, sold_prev_7,
        received_30: received_weekly.slice(4).reduce((a, b) => a + b, 0), last_received: "",
        weekly, received_weekly
      };
      rows.push(row);
      // a few SKUs also stocked at a second DC, so the transfer playbook has something to show
      if (rnd() < 0.12 && daily > 0) {
        const [d2, n2] = pick(DCS.filter(d => d[0] !== dc_id));
        rows.push({ ...row, dc_id: d2, dc_name: n2, on_hand: Math.round(daily * (60 + rnd() * 60)) });
      }
    }
  }
}
const asOf = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
rows.forEach(r => { r.as_of = asOf; r.last_received = asOf; });
writeFileSync(new URL("../public/seed.json", import.meta.url), JSON.stringify({
  source: "DEMO seed (generated, shaped like thelook_ecommerce). Run run.cmd to load the live BigQuery snapshot.",
  demo: true, as_of: asOf, window_days: 30, rows
}));
console.log(rows.length, "rows");
