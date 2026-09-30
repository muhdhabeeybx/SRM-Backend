#!/usr/bin/env node
/**
 * Give every open refund request raised before migration 0065 its expense.
 *
 * Each goes to the expenses page at "With CFO", as a new request now does,
 * and the CFO desk is told the way it is told about any expense at that stage.
 * A request its order no longer covers is left alone and reported — it should
 * be cancelled, not sent for approval.
 *
 *   node scripts/raise-refund-expenses.js            # dry run
 *   node scripts/raise-refund-expenses.js --apply
 */
require("dotenv").config();
const { client } = require("../config/db");
const refundService = require("../services/orderRefund.service");

const apply = process.argv.includes("--apply");

(async () => {
  console.log(`database: ${new URL(process.env.DATABASE_URL).hostname}${apply ? "" : " (dry run)"}`);
  const open = await client`
    SELECT r.id, r.order_id, r.amount::numeric AS amount, r.destination_name
      FROM order_refunds r
     WHERE r.status = 'requested' AND r.expense_id IS NULL
     ORDER BY r.id`;
  for (const r of open) {
    const { surplus } = await refundService.realSurplus(r.order_id);
    const covered = Number(r.amount) <= surplus + 0.005;
    const line = `refund ${r.id} · order ${r.order_id} · ₦${Number(r.amount).toLocaleString("en-NG")} to ${r.destination_name} · order holds ₦${surplus.toLocaleString("en-NG")}`;
    if (!covered) { console.log(`SKIP  ${line} — no longer covered, cancel it instead`); continue; }
    if (!apply) { console.log(`WOULD ${line}`); continue; }
    try {
      const e = await refundService.raiseExpenseForOpenRefund(r.id);
      console.log(`DONE  ${line} → expense ${e.reference_number || e.id} (With CFO)`);
    } catch (err) {
      console.log(`FAIL  ${line} — ${err.message}`);
    }
  }
  // Give inline notifications a moment to leave before the pool closes.
  await new Promise((res) => setTimeout(res, 4000));
  await client.end();
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
