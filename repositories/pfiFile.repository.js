const { client } = require("../config/db");

/**
 * Everything about a PFI that is not on its own row — who raised and released
 * it, which accounts it collects into and where its money actually landed,
 * which trucks carried each order — for the PFI file and the two PFI reports.
 *
 * Read-only, and deliberately so. Every figure here is counted off rows that
 * already exist; nothing is stored, so nothing can drift from what it counts.
 *
 * The register variants take many PFIs at once and answer in grouped queries,
 * because the full report lists the whole book and a query per PFI is how a
 * report takes a minute to download.
 */

const ids = (list) => [...new Set((list || []).map(Number).filter(Number.isFinite))];

/**
 * A timestamp as ISO 8601, whatever shape it arrived in.
 *
 * Raw queries on this client return timestamptz as Postgres writes it —
 * "2026-08-03 19:16:08.087+00" — because the Drizzle driver sharing the
 * connection turns date parsing off. Chrome reads that; Safari does not, and
 * a date that reads on one desk and not the next is worse than none. So every
 * instant leaves here as ISO.
 */
const toIso = (v) => {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  const text = String(v).trim().replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** The same, over the named fields of a row. */
const isoFields = (row, fields) => {
  for (const f of fields) if (f in row) row[f] = toIso(row[f]);
  return row;
};

/** "Ada Obi", or "" when the staff row is gone. */
const STAFF_NAME = (alias) => client.unsafe(`NULLIF(btrim(concat_ws(' ', ${alias}.first_name, ${alias}.surname)), '')`);

/** pfi_ids is jsonb and has held both numbers and strings; compared as text. */
const PFI_IDS = client`CASE WHEN jsonb_typeof(ba.pfi_ids) = 'array' THEN ba.pfi_ids ELSE '[]'::jsonb END`;

/**
 * Who raised each PFI and who released it to trade, by name.
 *
 * Both halves exist only on PFIs raised since the review gate (migration
 * 0046); on older ones they are null, and are left null rather than guessed.
 *
 * @returns {Promise<Map<number, object>>}
 */
const peopleFor = async (pfiIds) => {
  const out = new Map();
  const list = ids(pfiIds);
  if (!list.length) return out;
  const rows = await client`
    SELECT p.id,
           p.raised_by AS "raisedById", ${STAFF_NAME("rs")} AS "raisedByName", p.raised_at AS "raisedAt",
           p.activated_by AS "activatedById", ${STAFF_NAME("act")} AS "activatedByName",
           p.activated_at AS "activatedAt",
           p.review_note AS "reviewNote"
      FROM pfis p
      LEFT JOIN staff rs ON rs.id = p.raised_by
      LEFT JOIN staff act ON act.id = p.activated_by
     WHERE p.id = ANY(${list})
  `;
  for (const r of rows) out.set(Number(r.id), isoFields(r, ["raisedAt", "activatedAt"]));
  return out;
};

/**
 * The accounts each PFI collects into, from bank_accounts.pfi_ids — the one
 * source of truth for the assignment. `assignedAt` is read from the stamp
 * beside it (migration 0054) and is null on every assignment made before that
 * stamp existed; it is not invented.
 *
 * @returns {Promise<Map<number, Array<object>>>}
 */
const banksFor = async (pfiIds) => {
  const out = new Map();
  const list = ids(pfiIds);
  if (!list.length) return out;
  const rows = await client`
    SELECT x.pfi_id::int AS "pfiId",
           ba.id, ba.bank_name AS "bankName", ba.account_name AS "accountName",
           ba.account_number AS "accountNumber", ba.status,
           NULLIF(ba.pfi_assigned_at ->> x.pfi_id, '') AS "assignedAt"
      FROM bank_accounts ba
     CROSS JOIN LATERAL jsonb_array_elements_text(${PFI_IDS}) AS x(pfi_id)
     WHERE x.pfi_id = ANY(${list.map(String)})
     ORDER BY ba.bank_name, ba.account_number
  `;
  for (const r of rows) {
    const key = Number(r.pfiId);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push({
      id: r.id,
      bankName: r.bankName,
      accountName: r.accountName,
      accountNumber: r.accountNumber,
      status: r.status,
      assignedAt: r.assignedAt,
    });
  }
  return out;
};

/**
 * Where each PFI's money actually landed — the receiving account on every
 * bank statement line matched to one of its orders.
 *
 * Distinct from `banksFor`, which is where money is SUPPOSED to go. The two
 * disagreeing is worth seeing, which is why both are returned. Statement rows
 * only: a transfer between orders and a pre-ledger row carry no receiving
 * account, and inventing one would be the thing this report exists not to do.
 *
 * @returns {Promise<Map<number, Array<object>>>}
 */
const collectionsFor = async (pfiIds) => {
  const out = new Map();
  const list = ids(pfiIds);
  if (!list.length) return out;
  const rows = await client`
    SELECT o.pfi_id AS "pfiId",
           NULLIF(btrim(op.bank_name), '') AS "bankName",
           NULLIF(btrim(op.account_name), '') AS "accountName",
           NULLIF(btrim(op.account_number), '') AS "accountNumber",
           SUM(op.amount)::text AS amount,
           COUNT(*)::int AS payments,
           MIN(op.txn_date) AS "firstAt",
           MAX(op.txn_date) AS "lastAt"
      FROM order_payments op
      JOIN orders o ON o.id = op.order_id
     WHERE o.pfi_id = ANY(${list}) AND op.source = 'statement'
     GROUP BY o.pfi_id, 2, 3, 4
     ORDER BY o.pfi_id, SUM(op.amount) DESC
  `;
  for (const r of rows) {
    const key = Number(r.pfiId);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(isoFields({ ...r, pfiId: key, amount: Number(r.amount) }, ["firstAt", "lastAt"]));
  }
  return out;
};

/**
 * What each PFI's orders add up to, and when they happened.
 *
 * "Money landed" is Paid together with Part Paid — the finance report's own
 * default set — so the counts here describe the same orders the report lists.
 * `received` is orders.amount_paid, which the payment service keeps equal to
 * the sum of the order's payments, i.e. the finance report's figure.
 *
 * Merged-away orders are Cancelled and empty, and fall out with the rest.
 *
 * @returns {Promise<Map<number, object>>}
 */
const activityFor = async (pfiIds) => {
  const out = new Map();
  const list = ids(pfiIds);
  if (!list.length) return out;

  const [orderRows, paymentRows, truckRows] = await Promise.all([
    client`
      SELECT o.pfi_id AS "pfiId",
             COUNT(*) FILTER (WHERE COALESCE(o.status::text, '') NOT IN ('Cancelled', 'Expired'))::int AS "liveOrders",
             COUNT(*) FILTER (WHERE o.payment_status = 'Paid')::int AS "paidOrders",
             COUNT(*) FILTER (WHERE o.payment_status = 'Part Paid')::int AS "partPaidOrders",
             COUNT(DISTINCT o.customer_id) FILTER (WHERE o.payment_status IN ('Paid', 'Part Paid'))::int AS customers,
             COALESCE(SUM(o.total_amount) FILTER (WHERE o.payment_status IN ('Paid', 'Part Paid')), 0)::text AS "salesValue",
             COALESCE(SUM(o.amount_paid) FILTER (WHERE o.payment_status IN ('Paid', 'Part Paid')), 0)::text AS received,
             COALESCE(SUM(GREATEST(o.total_amount - o.amount_paid, 0))
                        FILTER (WHERE o.payment_status IN ('Paid', 'Part Paid')), 0)::text AS outstanding,
             MIN(o.created_at) FILTER (WHERE o.payment_status IN ('Paid', 'Part Paid')) AS "firstOrderAt",
             MAX(o.created_at) FILTER (WHERE o.payment_status IN ('Paid', 'Part Paid')) AS "lastOrderAt",
             MIN(o.payment_confirmed_at) AS "firstConfirmedAt",
             MAX(o.payment_confirmed_at) AS "lastConfirmedAt"
        FROM orders o
       WHERE o.pfi_id = ANY(${list})
       GROUP BY o.pfi_id
    `,
    client`
      SELECT o.pfi_id AS "pfiId",
             MIN(op.txn_date) AS "firstPaymentAt",
             MAX(op.txn_date) AS "lastPaymentAt",
             COUNT(*)::int AS "statementPayments"
        FROM order_payments op
        JOIN orders o ON o.id = op.order_id
       WHERE o.pfi_id = ANY(${list}) AND op.source = 'statement'
       GROUP BY o.pfi_id
    `,
    client`
      SELECT o.pfi_id AS "pfiId",
             COUNT(t.id)::int AS trucks,
             COUNT(t.id) FILTER (WHERE t.status = 'gated_out')::int AS "trucksOut",
             COALESCE(SUM(t.quantity), 0)::text AS "truckQty"
        FROM order_trucks t
        JOIN orders o ON o.id = t.order_id
       WHERE o.pfi_id = ANY(${list})
       GROUP BY o.pfi_id
    `,
  ]);

  const blank = () => ({
    liveOrders: 0, paidOrders: 0, partPaidOrders: 0, customers: 0,
    salesValue: 0, received: 0, outstanding: 0,
    firstOrderAt: null, lastOrderAt: null, firstConfirmedAt: null, lastConfirmedAt: null,
    firstPaymentAt: null, lastPaymentAt: null, statementPayments: 0,
    trucks: 0, trucksOut: 0, truckQty: 0,
  });
  for (const id of list) out.set(id, blank());

  // Money arrives as numeric text from Postgres and leaves as numbers.
  for (const { pfiId, ...r } of orderRows) {
    Object.assign(out.get(Number(pfiId)), {
      ...r,
      salesValue: Number(r.salesValue),
      received: Number(r.received),
      outstanding: Number(r.outstanding),
    });
  }
  for (const { pfiId, ...r } of paymentRows) Object.assign(out.get(Number(pfiId)), r);
  for (const { pfiId, ...r } of truckRows) {
    Object.assign(out.get(Number(pfiId)), { ...r, truckQty: Number(r.truckQty) });
  }
  for (const v of out.values()) {
    isoFields(v, ["firstOrderAt", "lastOrderAt", "firstConfirmedAt", "lastConfirmedAt", "firstPaymentAt", "lastPaymentAt"]);
  }
  return out;
};

/**
 * Every truck load on every order of one PFI, with its ticket.
 *
 * One row per truck, in the order the order numbers them. A truck's ticket is
 * the one cut for that load; `manualTicketNumber` is the handwritten one the
 * driver may already have been carrying.
 */
const trucksForPfi = async (pfiId) => (await client`
  SELECT t.order_id AS "orderId", t.id, t.truck_index AS "truckIndex",
         t.truck_number AS "truckNumber", t.quantity::float8 AS quantity, t.status,
         COALESCE(NULLIF(t.entry_driver_name, ''), t.driver_name) AS "driverName",
         COALESCE(NULLIF(t.entry_driver_phone, ''), t.driver_phone) AS "driverPhone",
         t.gantry, t.manual_ticket_number AS "manualTicketNumber",
         t.security_entered_at AS "enteredAt", t.loaded_at AS "loadedAt",
         t.security_exited_at AS "exitedAt",
         tk.ticket_number AS "ticketNumber"
    FROM order_trucks t
    JOIN orders o ON o.id = t.order_id
    LEFT JOIN LATERAL (
      SELECT ticket_number FROM tickets WHERE order_truck_id = t.id ORDER BY id DESC LIMIT 1
    ) tk ON true
   WHERE o.pfi_id = ${Number(pfiId)}
   ORDER BY t.order_id, t.truck_index, t.id
`).map((r) => isoFields(r, ["enteredAt", "loadedAt", "exitedAt"]));

/**
 * Tickets cut for a whole order rather than for one truck — how a gantry
 * order is ticketed, and how every order was before per-truck tickets.
 *
 * @returns {Promise<Record<number, string[]>>}
 */
const orderTicketsForPfi = async (pfiId) => {
  const rows = await client`
    SELECT tk.order_id AS "orderId", array_agg(tk.ticket_number ORDER BY tk.id) AS tickets
      FROM tickets tk
      JOIN orders o ON o.id = tk.order_id
     WHERE o.pfi_id = ${Number(pfiId)} AND tk.order_truck_id IS NULL
     GROUP BY tk.order_id
  `;
  const out = {};
  for (const r of rows) out[Number(r.orderId)] = r.tickets;
  return out;
};

/** What the audit log holds about the PFI itself — today, bank account changes. */
const auditFor = async (pfiId) => (await client`
  SELECT a.id, a.action, a.created_at AS "createdAt", a.metadata,
         ${STAFF_NAME("s")} AS "actorName"
    FROM audit_logs a
    LEFT JOIN staff s ON s.id = a.actor_staff_id
   WHERE a.entity_type = 'pfi' AND a.entity_id = ${Number(pfiId)}
   ORDER BY a.created_at ASC, a.id ASC
`).map((r) => isoFields(r, ["createdAt"]));

module.exports = {
  toIso,
  isoFields,
  peopleFor,
  banksFor,
  collectionsFor,
  activityFor,
  trucksForPfi,
  orderTicketsForPfi,
  auditFor,
};
