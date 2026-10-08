/**
 * Upload orders the business already took, from a CSV, onto one PFI.
 *
 *   node scripts/upload-orders.js --pfi 50 --file orders.csv            dry run: what would happen
 *   node scripts/upload-orders.js --pfi 50 --file orders.csv --apply    place them
 *
 *   --pfi    the PFI's id, or a unique part of its number ("PFI/47/")
 *   --staff  the staff id the orders are entered as (default 1)
 *
 * Columns (a header row, any order, case ignored):
 *   date, name, company, phone, product, qty, rate   and optionally delivery (pickup|delivery, default pickup)
 *
 * The orders stay Pending and never lapse (lib/uploadedOrders.js), are dated
 * to each row's day, and no customer is sent anything — every message channel
 * is switched off for this run before anything else loads. Re-running the
 * same file places nothing twice. See services/orderUpload.service.js.
 *
 * It writes to whatever DATABASE_URL resolves to, and says which first.
 */
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.SMS_ENABLED = "false";
process.env.EMAIL_ENABLED = "false";
process.env.WHATSAPP_ENABLED = "false";
require("dotenv").config();

const fs = require("fs");
const { sql } = require("drizzle-orm");

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const APPLY = process.argv.includes("--apply");

/** CSV with quoted fields, commas and doubled quotes inside them. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const HEADERS = {
  date: ["date", "day", "order date"],
  name: ["name", "customer", "customer name"],
  company: ["company", "company name"],
  phone: ["phone", "phone number", "telephone", "mobile"],
  product: ["product"],
  qty: ["qty", "quantity", "litres", "liters", "volume"],
  rate: ["rate", "price", "unit price"],
  deliveryType: ["delivery", "delivery type", "type"],
};

function rowsFrom(file) {
  const [head, ...body] = parseCsv(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  if (!head) throw new Error(`${file} is empty`);
  const at = {};
  head.forEach((h, i) => {
    const key = Object.keys(HEADERS).find((k) => HEADERS[k].includes(h.trim().toLowerCase()));
    if (key) at[key] = i;
  });
  const missing = ["date", "name", "company", "phone", "product", "qty", "rate"].filter((k) => at[k] == null);
  if (missing.length) throw new Error(`the header row has no column for: ${missing.join(", ")}`);
  return body.map((cells) => Object.fromEntries(Object.entries(at).map(([k, i]) => [k, (cells[i] ?? "").trim()])));
}

async function resolvePfi(db, wanted) {
  if (/^\d+$/.test(String(wanted))) return Number(wanted);
  const res = await db.execute(sql`SELECT id, pfi_number FROM pfis WHERE pfi_number ILIKE ${`%${wanted}%`} ORDER BY id`);
  const found = Array.isArray(res) ? res : res.rows;
  if (found.length !== 1) {
    throw new Error(`"${wanted}" matches ${found.length} PFIs${found.length ? `: ${found.map((p) => `#${p.id} ${p.pfi_number}`).join(", ")}` : ""} — give the id`);
  }
  return Number(found[0].id);
}

const naira = (n) => `₦${Number(n).toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;

(async () => {
  const file = arg("file");
  const pfiArg = arg("pfi");
  if (!file || !pfiArg) {
    console.error("usage: node scripts/upload-orders.js --pfi <id|number> --file <orders.csv> [--staff <id>] [--apply]");
    process.exit(2);
  }
  const target = new URL(process.env.DATABASE_URL);
  console.log(`Database: ${target.hostname}${target.pathname}   ${APPLY ? "APPLYING" : "dry run — nothing is written"}`);

  const { db, client } = require("../config/db");
  const upload = require("../services/orderUpload.service");
  try {
    const rows = rowsFrom(file);
    const pfiId = await resolvePfi(db, pfiArg);
    const p = await upload.plan({ pfiId, rows });
    console.log(`PFI: ${p.pfi.pfiNumber} (#${p.pfi.id}) · ${p.pfi.productName} · at ${p.depot.name} · ${p.pfi.sellable.toLocaleString()} left to sell`);
    console.log(`Batch ${p.batch}\n`);
    for (const r of p.rows) {
      const who = r.customer
        ? (r.customer.existing ? `existing #${r.customer.id} ${r.customer.name}` : "NEW customer")
        : "—";
      const state = r.problems.length ? `REFUSED: ${r.problems.join("; ")}` : r.already ? `already placed: ${r.already.orderNumber}` : "will place";
      console.log(`${String(r.row).padStart(3)}  ${r.day || "?"}  ${r.name} / ${r.company || "—"}  ${r.phone || "?"}  ${Number.isFinite(r.qty) ? r.qty.toLocaleString() : "?"} @ ${Number.isFinite(r.rate) ? naira(r.rate) : "?"}  [${who}]  ${state}`);
    }
    const s = p.summary;
    console.log(`\n${s.toPlace} to place (${s.quantity.toLocaleString()} L, ${naira(s.value)}), ${s.already} already placed, ${s.refused} refused, ${s.newCustomers} new customer(s).`);
    if (s.quantity > p.pfi.sellable) console.log(`WARNING: that is more than the ${p.pfi.sellable.toLocaleString()} left on the PFI — later rows will fail.`);

    if (!APPLY) return;
    const out = await upload.apply({ pfiId, rows, staffId: Number(arg("staff", 1)) });
    console.log("");
    for (const r of out.results) {
      console.log(`${String(r.row).padStart(3)}  ${r.outcome.toUpperCase()}${r.orderNumber ? `  ${r.orderNumber} (#${r.orderId})` : ""}${r.reason ? `  ${r.reason}` : ""}`);
    }
    const count = (o) => out.results.filter((r) => r.outcome === o).length;
    console.log(`\nPlaced ${count("placed")}, already there ${count("already")}, refused ${count("refused")}, failed ${count("failed")}.`);
  } catch (err) {
    console.error(`Stopped: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await client.end?.({ timeout: 5 }).catch(() => {});
  }
})();
