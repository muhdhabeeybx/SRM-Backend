#!/usr/bin/env node
/**
 * Fill the message ledger (migration 0064) with everything sent before it
 * existed.
 *
 *   1. The notification engine's own delivery log — every SMS and email it
 *      sent or failed to send, with its type, recipient and campaign.
 *   2. Termii's whole message history — the charge and final status of every
 *      SMS, its text, and the SMS the engine never logged: order and ticket
 *      texts, OTPs, desk nudges, anything sent from Termii's dashboard.
 *   3. Who each message went to, matched by phone and address.
 *
 * Only ever writes to message_log. Dry run by default; --apply writes.
 * Re-running is harmless: step 1 skips rows already imported, step 2 upserts
 * by Termii's message id.
 *
 *   node scripts/backfill-message-log.js            # counts only
 *   node scripts/backfill-message-log.js --apply
 */
require("dotenv").config();
const { sql } = require("drizzle-orm");
const { db } = require("../config/db");
const { syncTermii } = require("../services/messageLog.service");

const apply = process.argv.includes("--apply");

const IMPORTABLE = sql`
  FROM notification_deliveries d
 WHERE d.channel::text IN ('sms', 'email')
   AND d.status::text IN ('sent', 'delivered', 'failed')
   AND NOT EXISTS (
     SELECT 1 FROM message_log m
      WHERE (d.provider_message_id <> '' AND m.provider_message_id = d.provider_message_id)
         OR (m.channel = d.channel::text AND m.recipient = d.destination
             AND m.sent_at = COALESCE(d.sent_at, d.created_at) AND m.type = d.type)
   )`;

async function main() {
  console.log(`database: ${new URL(process.env.DATABASE_URL).hostname}`);
  const counted = await db.execute(sql`SELECT count(*)::int AS n ${IMPORTABLE}`);
  const n = (counted.rows ?? counted)[0].n;
  console.log(`engine deliveries to import: ${n}`);
  if (!apply) {
    console.log("dry run — pass --apply to import them and read Termii's full history");
    process.exit(0);
  }

  await db.execute(sql`
    INSERT INTO message_log (
      channel, provider, provider_message_id, recipient, recipient_name, audience,
      staff_id, customer_id, category, type, campaign_id, status, provider_status,
      error, origin, sent_at, created_at
    )
    SELECT d.channel::text,
           CASE WHEN d.channel::text = 'sms' THEN 'termii' ELSE 'resend' END,
           COALESCE(d.provider_message_id, ''), d.destination, d.recipient_name,
           CASE WHEN d.staff_id IS NOT NULL THEN 'staff'
                WHEN d.customer_id IS NOT NULL THEN 'customer'
                WHEN d.campaign_id IS NOT NULL THEN 'contact'
                ELSE 'unknown' END,
           d.staff_id, d.customer_id,
           CASE WHEN d.campaign_id IS NOT NULL OR d.type = 'system.announcement' THEN 'campaign'
                ELSE 'transactional' END,
           d.type, d.campaign_id,
           CASE WHEN d.status::text = 'delivered' THEN 'delivered' ELSE d.status::text END,
           COALESCE(d.provider_status, ''), d.error, 'app',
           COALESCE(d.sent_at, d.created_at), d.created_at
    ${IMPORTABLE}
    ON CONFLICT DO NOTHING
  `);
  console.log("engine deliveries imported");

  console.log("reading Termii's full history — this takes a few minutes…");
  const result = await syncTermii({ full: true });
  console.log("termii:", JSON.stringify(result));

  const totals = await db.execute(sql`
    SELECT channel, count(*)::int AS messages, COALESCE(SUM(amount), 0)::float AS amount,
           MIN(sent_at)::date AS first, MAX(sent_at)::date AS last
      FROM message_log GROUP BY 1 ORDER BY 1`);
  console.table(totals.rows ?? totals);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
