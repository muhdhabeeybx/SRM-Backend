const { sql } = require("drizzle-orm");
const { db } = require("../config/db");

/**
 * What the system already knows, for a report somebody is about to file.
 *
 * The daily report is typed by hand: a sales manager states the litres sold, a
 * commissions officer states what was paid out, IT compliance states how many
 * orders were raised. Every one of those is also recorded, and until now
 * nobody compared the two. A report saying 1,000,000 litres against a PFI the
 * system has 1,200,000 confirmed on went in, was approved, and the 200,000
 * only surfaced if a person happened to check.
 *
 * ── A comparison, never a correction ───────────────────────────────────────
 *
 * These figures are shown beside what is being typed and are never written
 * over it. The person filing knows things the system does not — a truck that
 * loaded late, a payment that came by transfer nobody has matched yet — and a
 * form that silently replaced their number with the database's would be worse
 * than one that says nothing. It flags, it does not fix.
 *
 * ── Keyed the way the reports are ──────────────────────────────────────────
 *
 * Per PFI and per day, because that is how the desk files. A report with no
 * PFI (compliance can be filed company-wide) gets the day's whole book, which
 * is the honest comparison for what it claims.
 */

/** Orders raised on the day, scoped to a PFI when one is named. */
const ordersOn = (date, pfiId) => sql`
  SELECT o.id, o.quantity, o.price, o.total_amount, o.status, o.payment_status,
         o.customer_id, o.pfi_id
    FROM orders o
   WHERE o.created_at >= ${date}::date
     AND o.created_at < (${date}::date + interval '1 day')
     ${pfiId ? sql`AND o.pfi_id = ${Number(pfiId)}` : sql``}
`;

/**
 * "Loaded" means A TICKET WAS GENERATED.
 *
 * Not the order's status. A ticket is the point at which a specific truck is
 * committed to a specific quantity, and it is the first record of the batch
 * that a person actually signed. Order status moves for other reasons — a
 * gantry order is marked Completed the moment payment clears, with no truck
 * and no ticket anywhere near it — so reading status as "loaded" reports
 * litres out of a tank nobody drew from.
 *
 * The stages after it, in order: pending (ticketed, not yet at the gate),
 * gated_in / loaded (on the yard), gated_out (left).
 */
const TICKETED_IS_LOADED = true;

/**
 * The two batch types that never generate a ticket.
 *
 * A gantry or delivery order is completed on payment — there is no ticket, no
 * gate, no yard. Counting ticketed litres for these would report zero loaded
 * against a batch that sold out, so for these the order itself is the
 * evidence.
 */
const DESKLESS_PFI_TYPES = ["gantry", "delivery"];

const num = (v) => Number(v) || 0;

/**
 * postgres.js hands back a plain array; other drivers wrap it in `{ rows }`.
 * Reading `.rows` alone silently yields nothing on the first, which is exactly
 * what it did here — every figure came back 0 against a day with 40 orders.
 */
const rowsOf = (r) => (Array.isArray(r) ? r : r?.rows ?? []);

/**
 * Everything a report of any type might want to be checked against.
 *
 * One query set rather than one per report type: the figures overlap heavily
 * (litres appear on three sheets), and computing them together means two
 * sheets filed for the same PFI on the same day cannot disagree about what
 * the system said.
 */
const forReport = async ({ date, pfiId = null }) => {
  const rows = rowsOf(await db.execute(ordersOn(date, pfiId)));

  const paidOrders = rows.filter((o) => o.payment_status === "Paid");

  const litresOrdered = rows.reduce((s, o) => s + num(o.quantity), 0);
  const valueOrdered = rows.reduce((s, o) => s + num(o.total_amount), 0);

  /** Which kind of batch this is — it decides what counts as loaded. */
  const batch = pfiId
    ? (rowsOf(await db.execute(sql`
        SELECT pfi_type FROM pfis WHERE id = ${Number(pfiId)}
      `)))[0] || null
    : null;
  const deskless = !!batch && DESKLESS_PFI_TYPES.includes(batch.pfi_type);

  /**
   * Tickets written on the day, and how far each of those trucks has got.
   *
   * Dated by the TICKET, not by its order. A ticket written this morning
   * against an order raised last week is this morning's loading, and the sheet
   * being filed is about what this shift did.
   */
  const tk = (rowsOf(await db.execute(sql`
    SELECT
      COUNT(*)::int AS ticketed,
      COALESCE(SUM(t.quantity), 0) AS litres_ticketed,
      COUNT(*) FILTER (WHERE t.status = 'pending')::int AS awaiting_in,
      COUNT(*) FILTER (WHERE t.status IN ('gated_in', 'loaded'))::int AS on_yard,
      COUNT(*) FILTER (WHERE t.status = 'gated_out')::int AS departed,
      COALESCE(SUM(t.quantity) FILTER (WHERE t.status = 'gated_out'), 0) AS litres_departed
      FROM order_trucks t
      JOIN orders o ON o.id = t.order_id
     WHERE t.created_at >= ${date}::date
       AND t.created_at < (${date}::date + interval '1 day')
       ${pfiId ? sql`AND o.pfi_id = ${Number(pfiId)}` : sql``}
  `)))[0] || {};

  const litresTicketed = num(tk.litres_ticketed);

  /**
   * Litres loaded: the ticketed quantity, or the order's own on a batch that
   * never tickets. Deliberately NOT the order's headline quantity on a
   * ticketed batch — an order for 60,000 with one 30,000 truck ticketed has
   * loaded 30,000, and reporting 60,000 is how the tank and the sheet drift
   * apart.
   */
  const litresLoaded = deskless
    ? rows.filter((o) => o.status === "Completed").reduce((s, o) => s + num(o.quantity), 0)
    : litresTicketed;

  /**
   * Trucks the gate actually saw, on the day — not trucks attached to the
   * day's orders. A truck ticketed yesterday and gated in this morning is
   * this morning's gate activity, and the security sheet is filed about the
   * gate's day rather than about a set of orders.
   */
  const gate = (rowsOf(await db.execute(sql`
    SELECT
      COUNT(*) FILTER (
        WHERE t.security_entered_at >= ${date}::date
          AND t.security_entered_at < (${date}::date + interval '1 day')
      )::int AS entered,
      COUNT(*) FILTER (
        WHERE t.security_exited_at >= ${date}::date
          AND t.security_exited_at < (${date}::date + interval '1 day')
      )::int AS exited
      FROM order_trucks t
      JOIN orders o ON o.id = t.order_id
     WHERE ${pfiId ? sql`o.pfi_id = ${Number(pfiId)}` : sql`TRUE`}
  `)))[0] || { entered: 0, exited: 0 };

  /**
   * Commission recorded against the day's orders on this batch.
   *
   * `due` is everything raised, `paid` only what the desk has marked paid.
   * Skipped rows are in neither: the desk decided they are not owed, so
   * counting them as due would tell the officer they owe money nobody thinks
   * they owe.
   */
  const commission = (rowsOf(await db.execute(sql`
    SELECT
      COALESCE(SUM(c.commission_amount::numeric) FILTER (WHERE c.status <> 'skipped'), 0) AS due,
      COALESCE(SUM(c.commission_amount::numeric) FILTER (WHERE c.status = 'paid'), 0) AS paid,
      COUNT(*) FILTER (WHERE c.status = 'pending')::int AS pending_count
      FROM commissions c
      JOIN orders o ON o.id = c.order_id
     WHERE o.created_at >= ${date}::date
       AND o.created_at < (${date}::date + interval '1 day')
       ${pfiId ? sql`AND o.pfi_id = ${Number(pfiId)}` : sql``}
  `)))[0] || { due: 0, paid: 0, pending_count: 0 };

  /** Money actually received against those orders, from the payment rows. */
  const received = (rowsOf(await db.execute(sql`
    SELECT COALESCE(SUM(op.amount), 0) AS total
      FROM order_payments op
      JOIN orders o ON o.id = op.order_id
     WHERE o.created_at >= ${date}::date
       AND o.created_at < (${date}::date + interval '1 day')
       ${pfiId ? sql`AND o.pfi_id = ${Number(pfiId)}` : sql``}
  `)))[0] || { total: 0 };

  const prices = [...new Set(rows.map((o) => Math.round(num(o.price) * 100) / 100).filter(Boolean))];

  return {
    date,
    pfiId: pfiId ?? null,
    /**
     * Keyed by the FIELD NAME the report form uses, so a client can look up
     * "what does the system say about litresSold" without a mapping table it
     * would then have to keep in step.
     */
    fields: {
      orderCount: rows.length,
      customerCount: new Set(rows.map((o) => o.customer_id).filter(Boolean)).size,
      litresSold: litresLoaded,
      /** Product managers state what was ordered, not what left. */
      receivedStock: litresOrdered,
      totalSalesAmount: valueOrdered,
      avgPrice: litresOrdered ? Math.round((valueOrdered / litresOrdered) * 100) / 100 : 0,
      /** The security sheet's truck count is trucks that LEFT the gate. */
      truckCount: gate.exited,
      trucksEntered: gate.entered,
      /** Tickets written, for whoever states how many trucks were loaded. */
      trucksLoaded: num(tk.ticketed),
      fundsReceived: num(received.total),
      commissionDue: num(commission.due),
      amountPaid: num(commission.paid),
    },
    /**
     * Shown, never compared — either because it varies legitimately (prices)
     * or because no field states it, and its job is to explain a variance
     * rather than to be one. A sheet 30,000 litres light reads very
     * differently once you can see a truck still standing on the yard.
     */
    context: {
      pfiType: batch?.pfi_type ?? null,
      deskless,
      litresOrdered,
      paidOrderCount: paidOrders.length,
      pendingCommissions: commission.pending_count,
      pricesSeen: prices.sort((a, b) => a - b),
      /** Where the day's ticketed trucks actually got to. */
      trucksTicketed: num(tk.ticketed),
      trucksAwaitingIn: num(tk.awaiting_in),
      trucksOnYard: num(tk.on_yard),
      trucksDeparted: num(tk.departed),
      litresTicketed,
      litresDeparted: num(tk.litres_departed),
    },
  };
};

module.exports = { forReport };
