#!/usr/bin/env node
/**
 * Record the gate entry and exit for trucks that left without being gated.
 *
 *   node scripts/backfill-gate-events.js --lb-staff=Hafiz --avidor-staff="Iris Aliyu"
 *   node scripts/backfill-gate-events.js --lb-staff=12 --avidor-staff=34 --apply
 *
 * ── What this is ──────────────────────────────────────────────────────────
 *
 * These trucks loaded and left. The gate screen never recorded it, largely
 * because redeeming a ticket used to complete the order (fixed in c848d85) and
 * a completed order is refused at the gate — so the desk could not enter what
 * had happened even by hand.
 *
 * This writes those events after the fact: entry, loading, exit, and then the
 * order completion the last truck out would have triggered. It is a backfill
 * of real events, not an invention of new ones.
 *
 * ── Attribution ──────────────────────────────────────────────────────────
 *
 * Each depot's own security officer is recorded, at the owner's instruction:
 * the people responsible for those gates. The audit rows carry
 * `backfill: true` and name this script, so the trail distinguishes these
 * from events entered at the time — the officer is recorded as responsible,
 * and the record is honest about when it was written.
 *
 * ── Timing ───────────────────────────────────────────────────────────────
 *
 * Stamped on the day the order was created, which is the instruction. Entry,
 * loading and exit are spread across the remainder of that Lagos day so the
 * three are ordered and none escapes into the next date — an order raised at
 * 23:40 gets three timestamps inside its last twenty minutes rather than a
 * gate-out dated the following morning.
 *
 * ── Scope ────────────────────────────────────────────────────────────────
 *
 * Trucks not yet gated out, on orders that are OPEN for gating (Released or
 * Loading), at the two named depots. Trucks on Completed orders are excluded:
 * 2,058 of them sit on 1,202 closed orders at Liquid Bulk, and gating those
 * means reopening most of that depot's history — a separate decision.
 *
 * ── Refuses to run if ────────────────────────────────────────────────────
 *
 * Any affected order holds active wallet funds. Completion converts a hold
 * into a booked debit, which is irreversible in the ledger, and doing that to
 * hundreds of orders in bulk is not something to discover afterwards.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const APPLY = process.argv.includes("--apply");
const TZ = process.env.REPORT_TIMEZONE || "Africa/Lagos";

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const DEPOTS = [
  { key: "avidor", match: "%avidor%", staffArg: arg("avidor-staff") },
  { key: "liquid bulk", match: "%liquid bulk%", staffArg: arg("lb-staff") },
];

if (DEPOTS.some((d) => !d.staffArg)) {
  console.error('usage: --avidor-staff=<id|name> --lb-staff=<id|name> [--apply]');
  process.exitCode = 1;
  process.exit();
}

const n = (v) => Number(v || 0).toLocaleString("en-NG");

/** The last instant of `when`'s calendar day, in the reporting zone. */
const endOfLocalDay = (when) => {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(when);
  // Offset of the zone at that instant, so the boundary is the local one.
  const asUtc = new Date(`${day}T23:59:00Z`);
  const probe = new Date(when);
  const local = new Date(probe.toLocaleString("en-US", { timeZone: TZ }));
  const offsetMs = probe.getTime() - local.getTime();
  return new Date(asUtc.getTime() + offsetMs);
};

/**
 * Three ordered stamps inside the order's own creation day.
 *
 * Normally an hour apart. Compressed into whatever is left of the day when the
 * order was raised close to midnight, so a gate-out never lands on a later
 * date than the instruction allows.
 *
 * ── Real timestamps win ───────────────────────────────────────────────────
 *
 * A truck already `gated_in` or `loaded` carries timestamps somebody actually
 * recorded, and those can be days after the order was raised. Deriving its
 * exit from the order date then puts the exit BEFORE the entry — which the
 * post-write check caught on the first run, on exactly one truck out of 623,
 * and rolled the whole batch back for.
 *
 * So an existing stamp is a floor: the computed times are pushed past anything
 * already on the row. That can carry the exit onto a later date than the
 * order's, and it should — a truck that demonstrably entered on the 14th
 * cannot have left on the 12th, and the instruction about dates was about
 * where to put unknown times, not about overruling known ones.
 */
const stampsFor = (createdAt, truck = {}) => {
  const base = new Date(createdAt);
  const room = Math.max(0, endOfLocalDay(base).getTime() - base.getTime());
  const step = Math.min(60 * 60 * 1000, Math.floor(room / 3));

  const existingEntry = truck.security_entered_at ? new Date(truck.security_entered_at).getTime() : null;
  const existingLoaded = truck.loaded_at ? new Date(truck.loaded_at).getTime() : null;

  // Each stamp is at least a minute after whatever real event precedes it.
  const MINUTE = 60 * 1000;
  const entered = new Date(existingEntry ?? base.getTime() + step);
  const loaded = new Date(
    Math.max(existingLoaded ?? 0, entered.getTime() + MINUTE, base.getTime() + step * 2)
  );
  const exited = new Date(
    Math.max(loaded.getTime() + MINUTE, base.getTime() + step * 3)
  );

  return { entered, loaded, exited };
};

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("BEGIN");

  try {
    // ── Resolve each depot and its officer ──────────────────────────────────
    for (const d of DEPOTS) {
      const { rows: depots } = await client.query(
        `SELECT id, name FROM depots WHERE name ILIKE $1 ORDER BY id`, [d.match]
      );
      if (depots.length !== 1) throw new Error(`"${d.key}" matched ${depots.length} depots`);
      d.depot = depots[0];

      const asId = Number(d.staffArg);
      const { rows: staff } = Number.isInteger(asId) && asId > 0
        ? await client.query(
            `SELECT id, CONCAT(first_name,' ',surname) AS name, is_active, suspended
               FROM staff WHERE id = $1`, [asId])
        : await client.query(
            `SELECT id, CONCAT(first_name,' ',surname) AS name, is_active, suspended
               FROM staff
              WHERE CONCAT(first_name,' ',surname,' ',COALESCE(other_names,'')) ILIKE $1
              ORDER BY id`,
            [`%${String(d.staffArg).trim()}%`]);

      if (!staff.length) throw new Error(`no staff matching "${d.staffArg}" for ${d.depot.name}`);
      if (staff.length > 1) {
        throw new Error(
          `"${d.staffArg}" matches ${staff.length} staff (${staff.map((s) => `${s.id} ${s.name}`).join("; ")}) — use the id`
        );
      }
      d.staff = staff[0];
      // A suspended or deactivated officer is almost certainly the wrong person
      // to attribute hundreds of gate events to, so it is surfaced in the dry
      // run rather than discovered in an audit afterwards.
      if (d.staff.suspended || d.staff.is_active === false) {
        console.log(
          `  NOTE: ${d.staff.name} is ${d.staff.suspended ? "suspended" : "inactive"} — confirm this is the right officer.`
        );
      }
    }

    // ── The trucks ──────────────────────────────────────────────────────────
    //
    // Released and Loading are the gateable statuses (order.controller
    // GATEABLE). Anything else is out of scope by design.
    let total = 0;
    for (const d of DEPOTS) {
      const { rows } = await client.query(
        `SELECT t.id, t.order_id, t.truck_number, t.quantity, t.status::text AS status,
                t.security_entered_at, t.loaded_at, t.security_exited_at,
                o.created_at AS order_created_at, o.quantity AS order_quantity,
                o.status::text AS order_status
           FROM order_trucks t
           JOIN orders o ON o.id = t.order_id
          WHERE o.depot_id = $1
            AND o.status IN ('Released', 'Loading')
            AND t.status <> 'gated_out'
          ORDER BY o.created_at, t.id`,
        [d.depot.id]
      );
      d.trucks = rows;
      total += rows.length;
    }

    if (!total) {
      console.log("\nNothing to gate — no open order at either depot has a truck outstanding.\n");
      await client.query("ROLLBACK");
      await client.end();
      return;
    }

    let orderIds = [...new Set(DEPOTS.flatMap((d) => d.trucks.map((t) => Number(t.order_id))))];

    /**
     * Orders holding wallet funds are left out entirely.
     *
     * Completing an order converts its hold into a booked debit — walletService
     * .convertHold writes a `deposits` row and marks the hold converted. This
     * script writes status directly and does NOT do that, so completing a held
     * order here would finish it while its funds stayed held forever: money out
     * of the customer's balance, against an order the ledger never records a
     * spend for.
     *
     * 25 such orders carry N3,391,148,080 between them. Booking that in a bulk
     * gate backfill is the wrong place for it, and half-doing it is worse, so
     * their trucks are not touched either — an order with every truck gated out
     * and no way left to complete is a worse state than the one it is in now.
     *
     * They are reported by id so they can be finished deliberately, through the
     * app or a purpose-built step that converts the hold properly.
     */
    const { rows: heldRows } = await client.query(
      `SELECT wh.order_id, wh.amount::numeric AS amount
         FROM wallet_holds wh
        WHERE wh.order_id = ANY($1::int[]) AND wh.status = 'active'
        ORDER BY wh.amount::numeric DESC`,
      [orderIds]
    );
    const heldIds = new Set(heldRows.map((r) => Number(r.order_id)));

    if (heldIds.size) {
      const totalHeld = heldRows.reduce((s, r) => s + Number(r.amount), 0);
      for (const d of DEPOTS) d.trucks = d.trucks.filter((t) => !heldIds.has(Number(t.order_id)));
      orderIds = orderIds.filter((id) => !heldIds.has(id));
      total = DEPOTS.reduce((s, d) => s + d.trucks.length, 0);

      console.log(`\n  SKIPPED: ${heldIds.size} order(s) holding ₦${totalHeld.toLocaleString("en-NG")} in active wallet funds.`);
      console.log(`           ${[...heldIds].join(", ")}`);
      console.log(`           Completing these converts the hold to a booked debit; that is not done here.`);

      if (!total) {
        console.log("\n  Nothing left to gate once those are excluded.\n");
        await client.query("ROLLBACK");
        await client.end();
        return;
      }
    }

    // ── Which orders this finishes ─────────────────────────────────────────
    //
    // The same rule gateOutTruck applies: nothing outstanding AND the full
    // quantity ticketed. An order whose trucks do not add up stays Loading,
    // which is correct — it genuinely is not finished.
    const { rows: completable } = await client.query(
      `SELECT o.id, o.quantity, COALESCE(SUM(t.quantity), 0)::numeric AS ticketed
         FROM orders o JOIN order_trucks t ON t.order_id = o.id
        WHERE o.id = ANY($1::int[])
        GROUP BY o.id, o.quantity
       HAVING COALESCE(SUM(t.quantity), 0) >= o.quantity`,
      [orderIds]
    );
    const completableIds = new Set(completable.map((r) => Number(r.id)));

    // ── Report ─────────────────────────────────────────────────────────────
    console.log("");
    for (const d of DEPOTS) {
      const litres = d.trucks.reduce((s, t) => s + Number(t.quantity || 0), 0);
      const orders = new Set(d.trucks.map((t) => Number(t.order_id)));
      console.log(`  ${d.depot.name}`);
      console.log(`    officer   ${d.staff.name}  (staff #${d.staff.id})`);
      console.log(`    trucks    ${d.trucks.length}  ·  ${n(litres)} L  ·  ${orders.size} order(s)`);
      const byStatus = d.trucks.reduce((m, t) => ((m[t.status] = (m[t.status] || 0) + 1), m), {});
      console.log(`    from      ${Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(", ")}`);
      const sample = d.trucks[0];
      if (sample) {
        const s = stampsFor(sample.order_created_at, sample);
        console.log(
          `    example   order ${sample.order_id} raised ${new Date(sample.order_created_at).toISOString().slice(0, 16).replace("T", " ")} →` +
            ` in ${s.entered.toISOString().slice(11, 16)}, loaded ${s.loaded.toISOString().slice(11, 16)}, out ${s.exited.toISOString().slice(11, 16)} (UTC)`
        );
      }
      console.log("");
    }
    console.log(`  ${total} truck(s) across ${orderIds.length} order(s)`);
    console.log(`  ${completableIds.size} order(s) will complete; ${orderIds.length - completableIds.size} stay Loading (trucks do not cover the ordered quantity)`);
    console.log(`  no active wallet holds — nothing will be booked to a ledger`);

    if (!APPLY) {
      await client.query("ROLLBACK");
      console.log("\nDRY RUN — nothing written. Check the two officers above, then re-run with --apply.\n");
      await client.end();
      return;
    }

    // ── Rollback capture ───────────────────────────────────────────────────
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rollbackPath = path.join(__dirname, `rollback-gate-backfill-${stamp}.json`);
    fs.writeFileSync(
      rollbackPath,
      JSON.stringify(
        {
          takenAt: new Date().toISOString(),
          officers: DEPOTS.map((d) => ({ depot: d.depot.name, staffId: d.staff.id, staffName: d.staff.name })),
          trucks: DEPOTS.flatMap((d) =>
            d.trucks.map((t) => ({
              id: t.id, order_id: t.order_id, status: t.status,
              security_entered_at: t.security_entered_at,
              loaded_at: t.loaded_at,
              security_exited_at: t.security_exited_at,
            }))
          ),
          ordersCompleted: [...completableIds],
        },
        null,
        2
      )
    );
    console.log(`\nRollback written to ${rollbackPath}`);

    // ── Write ──────────────────────────────────────────────────────────────
    let written = 0;
    for (const d of DEPOTS) {
      for (const t of d.trucks) {
        const s = stampsFor(t.order_created_at, t);
        // An existing timestamp is a real recorded event and is kept; only the
        // gaps are filled.
        await client.query(
          `UPDATE order_trucks
              SET status = 'gated_out',
                  security_entered_at = COALESCE(security_entered_at, $1),
                  security_entered_by = COALESCE(security_entered_by, $2),
                  loaded_at           = COALESCE(loaded_at, $3),
                  loaded_by           = COALESCE(loaded_by, $2),
                  security_exited_at  = COALESCE(security_exited_at, $4),
                  security_exited_by  = COALESCE(security_exited_by, $2),
                  updated_at = NOW()
            WHERE id = $5`,
          [s.entered, d.staff.id, s.loaded, s.exited, t.id]
        );
        await client.query(
          `INSERT INTO audit_logs (entity_type, entity_id, action, actor_type, actor_staff_id, metadata)
           VALUES ('order_truck', $1, 'order_truck.gated_out', 'staff', $2, $3::jsonb)`,
          [
            t.id,
            d.staff.id,
            JSON.stringify({
              orderId: t.order_id,
              truckNumber: t.truckNumber || t.truck_number,
              depot: d.depot.name,
              fromStatus: t.status,
              backfill: true,
              reason: "Truck loaded and left without the gate being recorded; entered after the fact on the order's own date.",
              via: "scripts/backfill-gate-events.js",
            }),
          ]
        );
        written += 1;
      }
    }

    // ── Complete the orders the last truck out would have ──────────────────
    for (const row of completable) {
      const id = Number(row.id);
      const last = DEPOTS.flatMap((d) => d.trucks)
        .filter((t) => Number(t.order_id) === id)
        .map((t) => stampsFor(t.order_created_at, t).exited)
        .sort((a, b) => b - a)[0];
      await client.query(
        `UPDATE orders
            SET status = 'Completed', completed_at = $1, updated_at = NOW()
          WHERE id = $2 AND status IN ('Released', 'Loading')`,
        [last, id]
      );
      await client.query(
        `INSERT INTO audit_logs (entity_type, entity_id, action, prev_state, new_state, actor_type, metadata)
         VALUES ('order', $1, 'order.completed', 'Loading', 'Completed', 'system', $2::jsonb)`,
        [id, JSON.stringify({ trigger: "gate-backfill", backfill: true, via: "scripts/backfill-gate-events.js" })]
      );
    }

    // ── Post-write invariants ──────────────────────────────────────────────
    const problems = [];
    const truckIds = DEPOTS.flatMap((d) => d.trucks.map((t) => Number(t.id)));

    const [{ not_out }] = (
      await client.query(
        `SELECT COUNT(*)::int AS not_out FROM order_trucks WHERE id = ANY($1::int[]) AND status <> 'gated_out'`,
        [truckIds]
      )
    ).rows;
    if (not_out) problems.push(`${not_out} truck(s) did not reach gated_out`);

    const [{ unstamped }] = (
      await client.query(
        `SELECT COUNT(*)::int AS unstamped FROM order_trucks
          WHERE id = ANY($1::int[])
            AND (security_entered_at IS NULL OR security_exited_at IS NULL
                 OR security_entered_by IS NULL OR security_exited_by IS NULL)`,
        [truckIds]
      )
    ).rows;
    if (unstamped) problems.push(`${unstamped} truck(s) left without a full entry/exit record`);

    // Exit must never precede entry — an out-of-order gate log is worse than none.
    const [{ inverted }] = (
      await client.query(
        `SELECT COUNT(*)::int AS inverted FROM order_trucks
          WHERE id = ANY($1::int[]) AND security_exited_at < security_entered_at`,
        [truckIds]
      )
    ).rows;
    if (inverted) problems.push(`${inverted} truck(s) exit before they entered`);

    const [{ still_open }] = (
      await client.query(
        `SELECT COUNT(*)::int AS still_open FROM orders WHERE id = ANY($1::int[]) AND status <> 'Completed'`,
        [[...completableIds]]
      )
    ).rows;
    if (still_open) problems.push(`${still_open} order(s) should have completed and did not`);

    if (problems.length) {
      console.log(`\nPOST-WRITE CHECKS FAILED:\n  ${problems.join("\n  ")}`);
      throw new Error("post-write invariant broken");
    }

    console.log(`\npost-write checks: all clear — ${written} truck(s) gated, ${completableIds.size} order(s) completed`);
    await client.query("COMMIT");
    console.log("COMMITTED\n");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("ROLLED BACK:", err.message);
    process.exitCode = 1;
  }

  await client.end();
}

main();
