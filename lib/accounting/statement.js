/**
 * A statement: a party's dated money events, oldest first, with a running
 * balance.
 *
 * One builder for every kind of party. A customer's events are their sales
 * and the money that came in against them; a vendor's are the invoices we
 * approved and what we paid. Each event carries a signed amount: positive
 * raises the balance, negative lowers it. What the balance MEANS is the
 * caller's — a customer's is what they owe us, a vendor's is what we owe them.
 *
 * ── Why the balance is worked over the whole history ──────────────────────
 *
 * A period is a window onto the statement, never a fresh start. Everything
 * before it is carried in as one "brought forward" figure, so the balance on
 * the first row of October is the balance the customer actually had, not a
 * subtotal that pretends September never happened.
 *
 * ── Why kobo ───────────────────────────────────────────────────────────────
 *
 * Thousands of naira amounts with two decimals, added one after another in
 * floating point, drift by a kobo here and there. Summed as whole kobo they
 * cannot, so the closing balance always equals brought forward plus the rows.
 */

const toKobo = (v) => Math.round((Number(v) || 0) * 100);
const fromKobo = (k) => k / 100;

/**
 * Same day: what was charged comes before what settled it, so a sale paid the
 * day it was placed reads "owed, then paid" rather than "in credit, then owed".
 * Callers name each event's place with `order`; anything unnamed sorts last.
 */
const byDate = (a, b) =>
  (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) ||
  (a.order ?? 9) - (b.order ?? 9) ||
  String(a.at ?? "").localeCompare(String(b.at ?? "")) ||
  String(a.id).localeCompare(String(b.id), "en", { numeric: true });

/**
 * @param {Array<{id: string, day: string, at?: string, order?: number, amount: number}>} events
 *        `day` is a Lagos calendar day, yyyy-MM-dd. Any other fields ride along.
 * @param {{from?: string, to?: string}} period  inclusive Lagos days; either may be open.
 */
function buildStatement(events, { from, to } = {}) {
  const sorted = [...events].sort(byDate);

  let running = 0;
  let broughtForward = 0;
  let up = 0;
  let down = 0;
  const rows = [];

  for (const e of sorted) {
    if (to && e.day > to) break;
    const k = toKobo(e.amount);
    running += k;
    if (from && e.day < from) {
      broughtForward = running;
      continue;
    }
    if (k > 0) up += k;
    else down -= k;
    rows.push({ ...e, amount: fromKobo(k), balance: fromKobo(running) });
  }

  return {
    broughtForward: fromKobo(broughtForward),
    rows,
    totals: {
      /** Everything that raised the balance in the period. */
      up: fromKobo(up),
      /** Everything that lowered it, as a positive figure. */
      down: fromKobo(down),
    },
    closing: fromKobo(running),
  };
}

module.exports = { buildStatement, toKobo };
