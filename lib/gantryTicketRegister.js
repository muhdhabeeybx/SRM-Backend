const { sql } = require("drizzle-orm");
const { db } = require("../config/db");

/**
 * Which gantry PFIs are sold ticket by ticket, and how many litres their
 * tickets still have to sell — the two facts order placement, payment and PFI
 * release ask about. The tickets themselves are services/gantryTickets.service.js.
 *
 * Kept apart from that service because order.service needs these answers and
 * the service needs order.service to complete an order; this file depends on
 * neither.
 *
 * ── Before migration 0075 ──────────────────────────────────────────────────
 *
 * The code can reach a server before its migration reaches the database. A
 * query on a missing table fails, and inside a transaction a failed statement
 * aborts the whole transaction even when the error is caught — so these never
 * query the tables until to_regclass says they exist. Until then every PFI
 * reads as not on a register, which is exactly how they all worked before.
 */

const rowsOf = (r) => (Array.isArray(r) ? r : r?.rows ?? []);

/** Once the tables exist they stay; only "not yet" is asked again. */
let ready = false;
const tablesReady = async (tx = db) => {
  if (ready) return true;
  const [row] = rowsOf(await tx.execute(sql`
    SELECT to_regclass('public.gantry_ticket_registers') IS NOT NULL
       AND to_regclass('public.gantry_tickets') IS NOT NULL AS ok
  `));
  ready = row?.ok === true;
  return ready;
};

/** Whether this PFI is sold ticket by ticket. */
const isOn = async (pfiId, tx = db) => {
  if (pfiId == null || !(await tablesReady(tx))) return false;
  const rows = rowsOf(await tx.execute(sql`
    SELECT 1 FROM gantry_ticket_registers WHERE pfi_id = ${Number(pfiId)}
  `));
  return rows.length > 0;
};

/** The ones among these PFIs that are. */
const onFor = async (pfiIds, tx = db) => {
  const ids = [...new Set((pfiIds || []).map(Number).filter(Number.isFinite))];
  if (!ids.length || !(await tablesReady(tx))) return new Set();
  const rows = rowsOf(await tx.execute(sql`
    SELECT pfi_id FROM gantry_ticket_registers
     WHERE pfi_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `));
  return new Set(rows.map((r) => Number(r.pfi_id)));
};

/** Put a PFI on a register. False when the tables are not there yet. */
const start = async (pfiId, staffId = null, tx = db) => {
  if (!(await tablesReady(tx))) return false;
  await tx.execute(sql`
    INSERT INTO gantry_ticket_registers (pfi_id, created_by)
    VALUES (${Number(pfiId)}, ${staffId == null ? null : Number(staffId)})
    ON CONFLICT (pfi_id) DO NOTHING
  `);
  return true;
};

/** Take a PFI off its register. The caller has made sure no ticket is live. */
const stop = async (pfiId, tx = db) => {
  if (!(await tablesReady(tx))) return;
  await tx.execute(sql`DELETE FROM gantry_ticket_registers WHERE pfi_id = ${Number(pfiId)}`);
};

/** Live tickets on a PFI: left, and sold. */
const ticketCount = async (pfiId, tx = db) => {
  if (!(await tablesReady(tx))) return { live: 0, left: 0 };
  const [row] = rowsOf(await tx.execute(sql`
    SELECT COUNT(*)::int AS live, COUNT(*) FILTER (WHERE order_id IS NULL)::int AS "left"
      FROM gantry_tickets
     WHERE pfi_id = ${Number(pfiId)} AND voided_at IS NULL
  `));
  return { live: Number(row?.live) || 0, left: Number(row?.left) || 0 };
};

/**
 * Litres the PFI's tickets can still be sold for: the litres on tickets not
 * yet sold, less what the orders already placed and not yet given tickets
 * will take — Pending ones included, because a Pending order still holds its
 * stock and is expected to be paid.
 *
 * `exceptOrderId` leaves an order out of the second sum, for a check made
 * about an order that is already placed.
 */
const openLitres = async (pfiId, tx = db, { exceptOrderId = null } = {}) => {
  const id = Number(pfiId);
  const [row] = rowsOf(await tx.execute(sql`
    SELECT
      (SELECT COALESCE(SUM(qty_litres), 0) FROM gantry_tickets
        WHERE pfi_id = ${id} AND voided_at IS NULL AND order_id IS NULL)::bigint AS on_tickets,
      (SELECT COALESCE(SUM(o.quantity), 0) FROM orders o
        WHERE o.pfi_id = ${id}
          AND o.status IN ('Pending', 'Paid', 'Released')
          ${exceptOrderId == null ? sql`` : sql`AND o.id <> ${Number(exceptOrderId)}`}
          AND NOT EXISTS (SELECT 1 FROM gantry_tickets t WHERE t.order_id = o.id))::bigint AS spoken_for
  `));
  return {
    onTickets: Number(row?.on_tickets) || 0,
    spokenFor: Number(row?.spoken_for) || 0,
    open: (Number(row?.on_tickets) || 0) - (Number(row?.spoken_for) || 0),
  };
};

module.exports = { tablesReady, isOn, onFor, start, stop, ticketCount, openLitres };
