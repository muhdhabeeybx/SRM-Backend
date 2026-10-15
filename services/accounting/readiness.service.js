const { db, client } = require("../../db");
const { landedCosts } = require("../../lib/accounting/landedCost");
const { settings } = require("./posting.service");
const opening = require("./opening.service");

/**
 * What the books still need from people, as a list Finance can work through
 * (the Finance Overview). Each item is something only a desk or Finance can
 * put right, counted, with the page where it is done. An item at nought is
 * done and left off.
 *
 *   posted        the books have been brought up to date at least once
 *   opening       the opening balances are posted
 *   automatic     posting runs by itself every ten minutes
 *                 (LEDGER_POSTING_ENABLED on the API's own environment)
 *   withdrawals   every bank account's statement format reads money out — a
 *                 debit column, or a single signed amount column — so it
 *                 reaches the books. The upload dialog fills a missing debit
 *                 column from the file's headings and remembers it.
 *   statements    every bank account in use has a statement since the books
 *                 started
 *   suppliers     every cargo bought since the books started names who it
 *                 was bought from, so it lands on their statement
 *   unpriced      nothing sold since the books started comes off a PFI whose
 *                 litres cost nothing — no unit price, and no cargo to take
 *                 one from (a trucking batch takes its cargo's)
 *   vendors       expenses naming a vendor only as typed text are on nobody's
 *                 statement (scripts/link-expense-vendors.js links them)
 *   trucks        Fleet Trucks nobody has costed on the Fixed Assets
 *                 register (0088)
 *   approvals     journals waiting for somebody else to approve them
 */
async function readiness() {
  const { booksStart } = await settings();
  const items = [];
  // A yes-or-no item carries no count.
  const add = (key, label, count, to = null, flag = false) => {
    if (count > 0) items.push({ key, label, count: flag ? null : count, to });
  };

  const [{ entries }] = await client`SELECT COUNT(*)::int AS entries FROM journal_entries`;
  add("posted", "The books have not been brought up to date yet — press Post now", entries === 0 ? 1 : 0, "/accounts/chart", true);

  add("opening", "Opening balances at the day before the books started are not posted", (await opening.current()) ? 0 : 1, "/accounts/periods", true);

  add("automatic", "Automatic posting is off — the books move only when somebody presses Post now",
    process.env.LEDGER_POSTING_ENABLED === "true" ? 0 : 1, null, true);

  const [{ n: noDebit }] = await client`
    SELECT COUNT(*)::int AS n FROM bank_accounts b
     WHERE COALESCE(b.status, 'Active') = 'Active'
       AND EXISTS (SELECT 1 FROM bank_statement_lines l WHERE l.bank_account_id = b.id)
       -- A format reads money out from its debit column, or from the negative
       -- amounts of a single signed column.
       AND NOT EXISTS (SELECT 1 FROM bank_statement_column_mappings m
                        WHERE m.bank_account_id = b.id AND (m.debit_column IS NOT NULL OR m.credit_column IS NULL))`;
  add("withdrawals", "Bank accounts whose statement format does not read money out yet — the next upload picks up a Debit column by itself", noDebit, "/bank-statements");

  const [{ n: stale }] = await client`
    SELECT COUNT(*)::int AS n FROM bank_accounts b
     WHERE COALESCE(b.status, 'Active') = 'Active'
       AND EXISTS (SELECT 1 FROM bank_statement_lines l WHERE l.bank_account_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM bank_statement_lines l WHERE l.bank_account_id = b.id AND l.txn_date >= ${booksStart}::date)`;
  add("statements", `Bank accounts in use with no statement since ${booksStart}`, stale, "/bank-statements");

  const [{ n: noSupplier }] = await client`
    SELECT COUNT(*)::int AS n FROM pfis p
     WHERE p.status::text IN ('active', 'finished') AND p.pfi_type::text <> 'trucking'
       AND p.supplier_vendor_id IS NULL AND COALESCE(p.unit_price, 0) > 0
       AND (COALESCE(p.activated_at, p.pfi_date, p.created_at) AT TIME ZONE 'Africa/Lagos')::date >= ${booksStart}::date`;
  add("suppliers", "Cargos bought since the books started with no supplier named", noSupplier, "/pfi");

  const costs = await landedCosts(db);
  const costless = [...costs.values()].filter((c) => !(c.perLitre > 0)).map((c) => c.pfiId);
  const [{ n: unpriced }] = costless.length ? await client`
    SELECT COUNT(*)::int AS n FROM pfis p
     WHERE p.id = ANY(${costless}::int[])
       AND (EXISTS (SELECT 1 FROM orders o WHERE o.pfi_id = p.id AND o.payment_status::text IN ('Paid', 'Part Paid')
                      AND (o.created_at AT TIME ZONE 'Africa/Lagos')::date >= ${booksStart}::date)
            OR EXISTS (SELECT 1 FROM delivery_inventory d WHERE d.pfi_id = p.id AND left(COALESCE(d.date_allocated, ''), 10) >= ${booksStart}))` : [{ n: 0 }];
  add("unpriced", "PFIs selling since the books started whose litres cost nothing — no unit price", unpriced, "/pfi");

  const [{ n: typedVendor }] = await client`
    SELECT COUNT(*)::int AS n FROM pfi_expenses e
      JOIN expense_categories c ON c.id = e.category_id
     WHERE e.deleted_at IS NULL AND e.vendor_id IS NULL AND btrim(COALESCE(e.vendor, '')) <> ''
       AND e.status IN ('admin_approved', 'paid') AND NOT COALESCE(c.is_refund, false)`;
  add("vendors", "Approved expenses naming a vendor only as typed text — on no vendor's statement", typedVendor, "/vendors");

  // Every Fleet Truck is on the Fixed Assets register to cost (0088).
  const [{ n: trucks }] = await client`
    SELECT COUNT(*)::int AS n FROM fleet_trucks t
     WHERE t.is_active
       AND NOT EXISTS (SELECT 1 FROM fixed_assets a WHERE a.fleet_truck_id = t.id AND a.deleted_at IS NULL)`;
  add("trucks", "Fleet trucks with no cost on the Fixed Assets register yet", trucks, "/accounts/fixed-assets");

  const [{ n: waiting }] = await client`SELECT COUNT(*)::int AS n FROM journal_drafts WHERE status = 'waiting'`;
  add("approvals", "Journals waiting for somebody else to approve them", waiting, "/accounts/journals");

  return { booksStart, items };
}

module.exports = { readiness };
