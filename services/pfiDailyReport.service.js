/**
 * The day's trading, assembled per PFI.
 *
 * The combined report groups by depot, which answers "how did Warri do".
 * This answers the question actually asked at the end of a day: for each
 * batch we are currently trading, what came in, what went out, what is still
 * owed, and what is left. A batch — not a depot — is the thing that gets
 * bought, drawn down and closed, so it is the thing the money hangs off.
 *
 * ── Two identity systems, on purpose ──────────────────────────────────────
 *
 * Depot trading is keyed on `pfis.id`: an order carries a real `pfi_id`, so
 * every figure on that side is exact.
 *
 * Truck sales are not. `delivery_inventory.pfi_id` is populated for the three
 * oldest allocations and NULL for every current one, and the two naming
 * systems do not meet: sales say "PFI-43B", the pfis table says
 * "PFI/43/26/DANGOTE/PMS/3ML/AUG". There is no key joining them and no safe
 * way to infer one — "43B" and "43/26" being the same batch is a business
 * fact, not a string fact.
 *
 * So the truck-sales half is grouped by `allocation_code` and reported as its
 * own set of batches. That is the only identity the data actually has, and it
 * is the one the desk uses out loud. If the link is ever backfilled, the two
 * halves can merge; until then, joining them would be inventing a fact.
 *
 * ── Stations are customers, not places ────────────────────────────────────
 *
 * A filling station is a row in `delivery_customers` with
 * customer_type = 'filling_station', reached through the sale's customer_id.
 *
 * It was briefly grouped on `location` instead — free text on the sale row —
 * which listed DAMATURU and KADUNA as stations. They are cities. Grouping on
 * the customer also retired a whole class of spelling problem (JOS/JOSE,
 * KADUNA/KADUAN) that the location text had, along with the fuzzy matching
 * written to cope with it: a station is now a row with an id.
 */
const { client } = require("../db");
const { dayBounds, REPORT_TZ } = require("./dailyCombinedReport.service");
// The desks, in reading order, and the columns each one's form collects. Shared
// with the combined report so the two cannot describe the same sheet
// differently — see notifications/templates/roleFields.js.
const { ROLE_ORDER, ROLE_LABELS } = require("../notifications/templates/roleFields");

const num = (v) => Number(v || 0);

/**
 * What an expense has actually cost, in naira.
 *
 * A paid request counts for what cleared the bank; anything still in the
 * approval chain has cost nothing yet. `amount_paid_ngn` is null on every row
 * settled before that column existed, hence the fallback to `amount_ngn` —
 * without it, historical spend vanishes and the row reads as unpaid forever.
 *
 * The same expression as repositories/pfiExpense.repository.js's SPEND, except
 * that this one is zero for an unpaid row rather than its billed amount:
 * that file answers "what did this cost", this one answers "what has left the
 * bank", and the difference between them is the report's NOT YET PAID column.
 *
 * Two forms, because one query aliases the table and the other does not.
 */
const paidNgn = (t = "") =>
  client.unsafe(
    `CASE WHEN ${t}status = 'paid' THEN COALESCE(${t}amount_paid_ngn::numeric, ${t}amount_ngn::numeric) ELSE 0 END`
  );
const PAID_NGN = paidNgn();
const PAID_NGN_E = paidNgn("e.");

/**
 * Truck sales roll up to the batch: the customer is not the unit here.
 *
 * Extracted and exported so the three rules below can be tested without a
 * database. Every one of them was got wrong at least once, and none of them
 * throws when it is — they just print a number that is quietly not the number.
 *
 * ── Rolled up from EVERY customer, listed only if one is live ─────────────
 *
 * Those are two different questions, and answering both with the live filter
 * gave a wrong figure rather than a partial one: PFI-14B reported 60 trucks
 * allocated against 62 on the batch, because customers who had finished paying
 * were dropped — so "unsold trucks" came out 34 when it is 36, and the batch's
 * sales value was short by whatever those customers had bought. A batch total
 * that quietly omits the settled customers is not a total.
 *
 * ── The balance is a SUM of debts, not a difference of totals ─────────────
 *
 * Not the same number once somebody has overpaid. Each customer's own balance
 * is clamped at zero by the caller — an overpayment is a real thing, but it is
 * not a debt — and `salesValue - fundsReceived` at the batch level quietly
 * un-clamps it, letting one customer's credit cancel another's debt. On 16
 * September that hid ₦456,452 and, worse, made the headline OUTSTANDING
 * BALANCE disagree with the column of balances printed directly underneath it.
 * A headline that cannot be added up from the rows below is the fastest way to
 * lose a reader.
 *
 * ── Unsold trucks are never negative and never invented ───────────────────
 *
 * More sales than allocations is a real state — a truck sold against an
 * allocation nobody keyed in — and it means "none left to sell", not "minus
 * four trucks". A batch with no allocation rows at all gets null, which the
 * template prints as N/A: a confident 0 against a batch still selling is a
 * worse answer than an honest blank.
 *
 * @param {object[]} all      every delivery row, live and dormant
 * @param {object[]} liveRows the subset that is still trading — see isLive
 */
const rollUpTruckSales = (all, liveRows) => {
  const isTruckSale = (r) => r.customerType !== "filling_station";

  const batches = new Map();
  for (const r of all.filter(isTruckSale)) {
    if (!batches.has(r.code)) {
      batches.set(r.code, {
        code: r.code, customers: 0,
        trucksAllocated: 0, trucksSoldToday: 0, trucksSold: 0,
        salesValue: 0, salesValueToday: 0,
        fundsReceived: 0, fundsReceivedToday: 0, expenses: 0, balance: 0,
      });
    }
    const b = batches.get(r.code);
    b.customers += 1;
    b.trucksAllocated += r.trucksAllocated;
    b.trucksSoldToday += r.loadsToday;
    b.trucksSold += r.loads;
    b.salesValue += r.salesValue;
    b.salesValueToday += r.salesValueToday;
    b.fundsReceived += r.fundsReceived;
    b.fundsReceivedToday += r.fundsReceivedToday;
    b.expenses += r.expenses;
    b.balance += r.balance;
  }

  /** The codes with at least one live customer on them. */
  const liveCodes = new Set(liveRows.filter(isTruckSale).map((r) => r.code));

  return [...batches.values()]
    // '(unassigned)' is sales whose allocation_code was never filled in. It is
    // a data gap wearing the costume of a batch, and listing it invites the
    // reader to treat it as one.
    .filter((b) => b.code !== "(unassigned)" && liveCodes.has(b.code))
    .map((b) => ({
      ...b,
      unsoldTrucks: b.trucksAllocated > 0 ? Math.max(0, b.trucksAllocated - b.trucksSold) : null,
    }))
    .sort((a, b) => b.salesValue - a.salesValue);
};

/**
 * Everything the per-PFI report needs, for one Lagos day.
 *
 * @param {Date} [date] any instant inside the day to report on
 */
const buildPfiDailyReportData = async (date = new Date()) => {
  const { start, end, dayStr } = dayBounds(date);
  // postgres.js takes the bound as a string, as the combined report does.
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  /**
   * The delivery tables date things as text, not as timestamps.
   *
   * `date_loaded` and `date_of_payment` are varchar 'YYYY-MM-DD' — a Lagos
   * calendar date somebody typed on a form, with no time and no zone. Both are
   * clean across all 1,460 rows.
   *
   * They are therefore compared to the report's own day string, not to the
   * UTC instants above. Comparing them to an ISO timestamp is a lexicographic
   * accident that happens to parse: '2026-09-07' < '2026-09-09T23:00:00.000Z'
   * is answering a question about alphabetical order.
   */

  // ── The batches themselves ──────────────────────────────────────────────
  const pfiRows = await client`
    SELECT id, pfi_number, pfi_type::text AS pfi_type, location_name, product_name,
           -- Not every batch is measured in litres: the LPG ones are in kg, and
           -- the column spells the same unit three ways across the live rows
           -- ('Litres', 'Liters', 'kg'). Carried through so the report prints
           -- what the batch is actually traded in rather than assuming.
           product_unit,
           starting_qty_litres, sold_qty_litres, unit_price::numeric AS unit_price,
           ticket_count
      FROM pfis
     WHERE status = 'active'
     ORDER BY id DESC`;

  // ── Depot trading, exact because an order carries a real pfi_id ─────────
  //
  // Cancelled and expired orders are excluded from every figure: neither is
  // trading, and counting them would inflate a batch's sales with orders that
  // will never load.
  const orderRows = await client`
    SELECT o.pfi_id,
           COUNT(*)                                            AS orders_all,
           COALESCE(SUM(o.quantity), 0)                        AS litres_all,
           COALESCE(SUM(o.total_amount::numeric), 0)           AS value_all,
           COALESCE(SUM(o.amount_paid::numeric), 0)            AS paid_all,
           COUNT(*)                    FILTER (WHERE o.created_at >= ${startIso} AND o.created_at < ${endIso}) AS orders_today,
           COALESCE(SUM(o.quantity)    FILTER (WHERE o.created_at >= ${startIso} AND o.created_at < ${endIso}), 0) AS litres_today,
           COALESCE(SUM(o.total_amount::numeric) FILTER (WHERE o.created_at >= ${startIso} AND o.created_at < ${endIso}), 0) AS value_today
      FROM orders o
     WHERE o.pfi_id IS NOT NULL
       AND o.status NOT IN ('Cancelled', 'Expired')
     GROUP BY o.pfi_id`;

  /**
   * What was collected today, from the payment rows themselves.
   *
   * NOT from orders.amount_paid. That column is the cumulative total on the
   * order, and payment_confirmed_at marks only the FIRST payment and never
   * moves after it — so filtering the cached total by that timestamp counts an
   * order's entire payment history on the day its first instalment landed, and
   * counts nothing at all on the days the rest arrived.
   *
   * It read as N9.7bn collected against N3.3bn sold, which is the kind of
   * figure that makes a reader stop believing the page rather than query it.
   *
   * Dated on txn_date — when the money moved at the bank — falling back to the
   * row's own creation for a payment recorded without one.
   */
  const collectionRows = await client`
    SELECT o.pfi_id,
           COALESCE(SUM(op.amount::numeric), 0) AS paid_today
      FROM order_payments op
      JOIN orders o ON o.id = op.order_id
     WHERE o.pfi_id IS NOT NULL
       AND o.status NOT IN ('Cancelled', 'Expired')
       AND COALESCE(op.txn_date, op.created_at) >= ${startIso}
       AND COALESCE(op.txn_date, op.created_at) <  ${endIso}
     GROUP BY o.pfi_id`;

  // ── Gate and gantry movements, from the truck's own timestamps ──────────
  //
  // LOADED and EXITED are two different events and the report shows both. The
  // volume columns hang off `loaded_at` — what actually went into trucks at the
  // gantry — rather than off the exit timestamp, which is the security barrier
  // lifting and can be hours later or (for a truck still on site) never. A
  // "litres loaded today" measured on the way out reports nothing for a truck
  // that loaded at 18:00 and sleeps in the yard.
  const truckRows = await client`
    SELECT o.pfi_id,
           COUNT(*) FILTER (WHERE t.security_entered_at >= ${startIso} AND t.security_entered_at < ${endIso}) AS entered_today,
           COUNT(*) FILTER (WHERE t.loaded_at          >= ${startIso} AND t.loaded_at          < ${endIso}) AS loaded_today,
           COUNT(*) FILTER (WHERE t.security_exited_at >= ${startIso} AND t.security_exited_at < ${endIso}) AS exited_today,
           COALESCE(SUM(t.quantity) FILTER (WHERE t.loaded_at >= ${startIso} AND t.loaded_at < ${endIso}), 0) AS litres_loaded_today,
           COALESCE(SUM(t.quantity) FILTER (WHERE t.security_exited_at >= ${startIso} AND t.security_exited_at < ${endIso}), 0) AS litres_out_today,
           -- On site now: through the gate, not yet back out.
           COUNT(*) FILTER (WHERE t.security_entered_at IS NOT NULL AND t.security_exited_at IS NULL) AS on_site,
           COUNT(*) FILTER (WHERE t.loaded_at IS NOT NULL)                                AS trucks_loaded_all,
           COALESCE(SUM(t.quantity) FILTER (WHERE t.loaded_at IS NOT NULL), 0)            AS litres_loaded_all,
           COUNT(*)                                        AS trucks_all,
           COALESCE(SUM(t.quantity), 0)                    AS litres_ticketed_all
      FROM order_trucks t
      JOIN orders o ON o.id = t.order_id
     WHERE o.pfi_id IS NOT NULL
       AND o.status NOT IN ('Cancelled', 'Expired')
     GROUP BY o.pfi_id`;

  // ── What the batch has cost ─────────────────────────────────────────────
  //
  // Three rules, every one of them learned from a wrong figure on this report.
  //
  // NAIRA, NOT THE INVOICE'S OWN CURRENCY. `amount` is denominated in whatever
  // the invoice was raised in (db/migrations/0026) and two live rows are USD,
  // so summing it added $26,500 to a naira total as though they were the same
  // unit. `amount_ngn` and `amount_paid_ngn` are generated by the database from
  // the amount and its rate, so they cannot be stale or disagree with what they
  // were derived from.
  //
  // A PAID ROW COUNTS FOR WHAT CLEARED, AND `amount_paid` IS NULL ON EVERY ROW
  // SETTLED BEFORE THAT COLUMN EXISTED — 155 of the 279 paid ones. Summing the
  // column alone read those as ₦0 paid, so PFI 34 reported ₦1.28bn still
  // outstanding on a batch whose every expense is settled, and ₦6.1bn of
  // phantom debt showed across the report. The fallback is the same one
  // repositories/pfiExpense.repository.js has always used for spend.
  //
  // A REJECTED REQUEST IS NOT A COST. Four of them, ₦4m, were being counted as
  // money the company owed.
  const expenseRows = await client`
    SELECT pfi_id,
           COUNT(*)                                        AS expenses_all,
           COALESCE(SUM(amount_ngn::numeric), 0)           AS amount_all,
           COALESCE(SUM(${PAID_NGN}), 0)                   AS paid_all,
           COUNT(*)                        FILTER (WHERE expense_date >= ${startIso} AND expense_date < ${endIso}) AS expenses_today,
           COALESCE(SUM(amount_ngn::numeric) FILTER (WHERE expense_date >= ${startIso} AND expense_date < ${endIso}), 0) AS amount_today,
           -- Dated on paid_at, the moment the Expenditure Officer marked it
           -- paid. An expense raised last week and settled today is today's
           -- outflow, and it is the column that says where the money went.
           COALESCE(SUM(${PAID_NGN})       FILTER (WHERE paid_at >= ${startIso} AND paid_at < ${endIso}), 0) AS paid_today
      FROM pfi_expenses
     WHERE pfi_id IS NOT NULL
       AND deleted_at IS NULL
       AND status <> 'rejected'
     GROUP BY pfi_id`;

  /**
   * Commission, per PFI, through the order that earned it.
   *
   * `commissions` carries no pfi_id — it hangs off an order, and the order
   * knows its batch. Pending and paid are kept apart because they answer
   * different questions: what is owed to agents, and what has already gone.
   *
   * SKIPPED IS NOT DUE. A third status exists in the data that the enum in
   * db/schema/enums.js does not list: 29 rows, ₦13.9m, set by
   * services/commission.service.js when somebody decides an order earns nobody
   * anything — "Commission skipped, nobody was credited". `status <> 'paid'`
   * counted every one of them as money owed to agents.
   *
   * TODAY AND TO DATE ARE BOTH CARRIED. The report leads with the day: what
   * today's trading earned, and what actually went out today. The running
   * totals follow, so a reader can see both without the day being buried in
   * them — which is what a single to-date column did.
   */
  const commissionRows = await client`
    SELECT o.pfi_id,
           COUNT(*)                                                                      AS entries,
           COALESCE(SUM(c.commission_amount::numeric) FILTER (WHERE c.status = 'pending'), 0) AS due,
           COALESCE(SUM(c.commission_amount::numeric) FILTER (WHERE c.status = 'paid'), 0)    AS paid,
           COALESCE(SUM(c.quantity), 0)                                                  AS litres,
           -- Earned today: the commission rows today's orders created, whatever
           -- has since happened to them.
           COUNT(*) FILTER (WHERE c.created_at >= ${startIso} AND c.created_at < ${endIso}) AS entries_today,
           COALESCE(SUM(c.commission_amount::numeric)
             FILTER (WHERE c.created_at >= ${startIso} AND c.created_at < ${endIso}), 0)   AS due_today,
           -- Settled today, dated on the settlement rather than on the order:
           -- last week's commission paid this morning is today's outflow.
           COALESCE(SUM(c.commission_amount::numeric)
             FILTER (WHERE c.paid_at >= ${startIso} AND c.paid_at < ${endIso}), 0)        AS paid_today
      FROM commissions c
      JOIN orders o ON o.id = c.order_id
     WHERE o.pfi_id IS NOT NULL
       AND o.status NOT IN ('Cancelled', 'Expired')
     GROUP BY o.pfi_id`;

  /**
   * Expenses that belong to no batch.
   *
   * 68 rows and N187m of them: administrative and general costs that are real
   * money out and were invisible while this report only asked about pfi_id.
   * Grouped by category, because "General Expenses" as one number answers
   * nothing.
   */
  const generalExpenseRows = await client`
    SELECT COALESCE(NULLIF(TRIM(c.name), ''), 'Uncategorised') AS category,
           COUNT(*)                                   AS entries_all,
           COALESCE(SUM(e.amount_ngn::numeric), 0)    AS amount_all,
           COALESCE(SUM(${PAID_NGN_E}), 0)            AS paid_all,
           COUNT(*)                            FILTER (WHERE e.expense_date >= ${startIso} AND e.expense_date < ${endIso}) AS entries_today,
           COALESCE(SUM(e.amount_ngn::numeric) FILTER (WHERE e.expense_date >= ${startIso} AND e.expense_date < ${endIso}), 0) AS amount_today,
           COALESCE(SUM(${PAID_NGN_E})         FILTER (WHERE e.paid_at >= ${startIso} AND e.paid_at < ${endIso}), 0) AS paid_today
      FROM pfi_expenses e
      LEFT JOIN expense_categories c ON c.id = e.category_id
     WHERE e.pfi_id IS NULL
       AND e.deleted_at IS NULL
       AND e.status <> 'rejected'
     GROUP BY 1
     ORDER BY 1`;

  /**
   * Every batch's number, active or not — 61 rows, one trivial query.
   *
   * The report lists active batches, but money does not stop moving on a batch
   * the day it closes: ₦305,000 was raised against a closed PFI on 16
   * September and vanished from EXPENSES entirely, because the table was built
   * by walking the active list. A cost that the company incurred today belongs
   * on today's report whatever the state of the batch it was incurred against.
   */
  const pfiNames = new Map(
    (await client`SELECT id, pfi_number FROM pfis`).map((r) => [Number(r.id), r.pfi_number])
  );

  const byPfi = (rows) => new Map(rows.map((r) => [Number(r.pfi_id), r]));
  const orders = byPfi(orderRows);
  const collections = byPfi(collectionRows);
  const trucks = byPfi(truckRows);
  const expenses = byPfi(expenseRows);
  const commissions = byPfi(commissionRows);

  const pfis = pfiRows.map((p) => {
    const o = orders.get(Number(p.id)) || {};
    const collected = num((collections.get(Number(p.id)) || {}).paid_today);
    const t = trucks.get(Number(p.id)) || {};
    const e = expenses.get(Number(p.id)) || {};
    const cm = commissions.get(Number(p.id)) || {};

    const starting = num(p.starting_qty_litres);
    const sold = num(p.sold_qty_litres);
    const valueAll = num(o.value_all);
    const paidAll = num(o.paid_all);

    /**
     * Opening stock TODAY, derived rather than stored.
     *
     * `sold_qty_litres` is the running total to date, so closing stock is
     * starting − sold and the day opened wherever it closed plus whatever went
     * out today. Derived in that direction on purpose: closing is the figure
     * that has to agree with the batch record, and deriving opening from it
     * means the row reads straight across — opening − sold today = closing —
     * however the two halves were recorded.
     */
    const closing = Math.max(0, starting - sold);
    const soldToday = num(o.litres_today);

    return {
      id: Number(p.id),
      pfiNumber: p.pfi_number,
      type: p.pfi_type,
      location: p.location_name || "",
      product: p.product_name || "",
      /** 'Litres', 'Liters' or 'kg' — see the query. */
      unit: p.product_unit || "Litres",
      unitPrice: num(p.unit_price),

      stock: {
        starting,
        sold,
        openingToday: closing + soldToday,
        soldToday,
        remaining: closing,
        percentSold: starting > 0 ? (sold / starting) * 100 : 0,
      },

      orders: {
        today: { count: Number(o.orders_today || 0), litres: num(o.litres_today), value: num(o.value_today), paid: collected },
        toDate: { count: Number(o.orders_all || 0), litres: num(o.litres_all), value: valueAll, paid: paidAll },
        outstanding: Math.max(0, valueAll - paidAll),
      },

      movements: {
        enteredToday: Number(t.entered_today || 0),
        loadedToday: Number(t.loaded_today || 0),
        exitedToday: Number(t.exited_today || 0),
        litresLoadedToday: num(t.litres_loaded_today),
        litresOutToday: num(t.litres_out_today),
        onSite: Number(t.on_site || 0),
        trucksLoadedToDate: Number(t.trucks_loaded_all || 0),
        litresLoadedToDate: num(t.litres_loaded_all),
        trucksToDate: Number(t.trucks_all || 0),
        litresTicketedToDate: num(t.litres_ticketed_all),
      },

      expenses: {
        today: {
          count: Number(e.expenses_today || 0),
          requested: num(e.amount_today),
          paid: num(e.paid_today),
        },
        toDate: {
          count: Number(e.expenses_all || 0),
          requested: num(e.amount_all),
          paid: num(e.paid_all),
        },
      },

      commission: {
        entries: Number(cm.entries || 0),
        litres: num(cm.litres),
        today: {
          entries: Number(cm.entries_today || 0),
          due: num(cm.due_today),
          paid: num(cm.paid_today),
        },
        due: num(cm.due),
        paid: num(cm.paid),
      },
    };
  });

  /**
   * Delivery trading splits in two, by who bought.
   *
   * `delivery_customers.customer_type` is either 'customer' or
   * 'filling_station', and the two are different businesses wearing the same
   * table. A customer buys a truck; a filling station holds stock and sells it
   * down. So a truck sale is counted in TRUCKS — how many went out, what they
   * were worth, what is still owed — and a station is counted in LITRES, because
   * the question there is how much is left in the ground.
   *
   * An earlier cut grouped both by `location`, which is a free-text town on the
   * sale row. That listed DAMATURU and KADUNA as "stations". They are cities;
   * the station is the customer. Grouping on the customer removes the whole
   * class of spelling problems with it — a station is a row with an id.
   */
  const loadRows = await client`
    WITH loads AS (
      SELECT DISTINCT ON (allocation_code, truck_number, date_loaded, quantity, sales_value)
             COALESCE(NULLIF(TRIM(allocation_code), ''), '(unassigned)') AS code,
             customer_id,
             customer_name,
             truck_number,
             date_loaded,
             quantity,
             sales_value::numeric     AS sales_value,
             expenses_amount::numeric AS expenses_amount
        FROM delivery_sales
    )
    SELECT l.code,
           COALESCE(dc.customer_type, 'customer')                  AS customer_type,
           COALESCE(NULLIF(TRIM(dc.name), ''), NULLIF(TRIM(l.customer_name), ''), '(unnamed)') AS party,
           COUNT(*)                                                AS loads_all,
           COALESCE(SUM(l.quantity), 0)                            AS litres_all,
           COALESCE(SUM(l.sales_value), 0)                         AS value_all,
           COALESCE(SUM(l.expenses_amount), 0)                     AS expenses_all,
           COUNT(*)                  FILTER (WHERE l.date_loaded = ${dayStr}) AS loads_today,
           COALESCE(SUM(l.quantity)  FILTER (WHERE l.date_loaded = ${dayStr}), 0) AS litres_today,
           COALESCE(SUM(l.sales_value) FILTER (WHERE l.date_loaded = ${dayStr}), 0) AS value_today,
           MAX(l.date_loaded)                                      AS last_load
      FROM loads l
      LEFT JOIN delivery_customers dc ON dc.id = l.customer_id
     GROUP BY l.code, COALESCE(dc.customer_type, 'customer'),
              COALESCE(NULLIF(TRIM(dc.name), ''), NULLIF(TRIM(l.customer_name), ''), '(unnamed)')`;

  /** Money, summed across every instalment row. See the header. */
  const paymentRows = await client`
    SELECT COALESCE(NULLIF(TRIM(ds.allocation_code), ''), '(unassigned)') AS code,
           COALESCE(dc.customer_type, 'customer') AS customer_type,
           COALESCE(NULLIF(TRIM(dc.name), ''), NULLIF(TRIM(ds.customer_name), ''), '(unnamed)') AS party,
           COALESCE(SUM(ds.payment_amount::numeric), 0) AS paid_all,
           COALESCE(SUM(ds.payment_amount::numeric) FILTER (
             WHERE COALESCE(NULLIF(ds.date_of_payment, ''),
                            to_char(ds.created_at AT TIME ZONE ${REPORT_TZ}, 'YYYY-MM-DD')) = ${dayStr}), 0) AS paid_today
      FROM delivery_sales ds
      LEFT JOIN delivery_customers dc ON dc.id = ds.customer_id
     GROUP BY 1, 2, 3`;

  /**
   * What has been allocated, per batch and party.
   *
   * This used to ask only about filling stations, because only a station's
   * stock-on-the-ground was being reported. Truck sales need the same rows for
   * a different question: a batch's UNSOLD trucks are the ones allocated to it
   * that have not been sold, and without the allocation there is no
   * denominator — "18 trucks sold" says nothing until you know whether 18 or
   * 65 went out.
   *
   * So the customer-type filter is gone and the type comes back on the row
   * instead, to be split the same way the sales are.
   */
  const stockRows = await client`
    SELECT COALESCE(NULLIF(TRIM(di.allocation_code), ''), '(unassigned)') AS code,
           COALESCE(dc.customer_type, 'customer') AS customer_type,
           COALESCE(NULLIF(TRIM(dc.name), ''), NULLIF(TRIM(di.customer_name), ''), '(unnamed)') AS party,
           COUNT(*)                             AS trucks,
           COALESCE(SUM(di.quantity_allocated), 0) AS allocated
      FROM delivery_inventory di
      LEFT JOIN delivery_customers dc ON dc.id = di.customer_id
     GROUP BY 1, 2, 3`;

  const key = (code, party) => `${code}\u0000${party}`;
  const rowsBy = new Map();
  const at = (code, party, type) => {
    const k = key(code, party);
    if (!rowsBy.has(k)) {
      rowsBy.set(k, {
        code, party, customerType: type,
        loads: 0, loadsToday: 0,
        litres: 0, litresToday: 0,
        salesValue: 0, salesValueToday: 0,
        fundsReceived: 0, fundsReceivedToday: 0,
        expenses: 0,
        allocatedLitres: 0, trucksAllocated: 0,
        lastLoad: null,
      });
    }
    const row = rowsBy.get(k);
    if (type && row.customerType !== type) row.customerType = type;
    return row;
  };

  for (const r of loadRows) {
    const row = at(r.code, r.party, r.customer_type);
    row.loads += Number(r.loads_all || 0);
    row.loadsToday += Number(r.loads_today || 0);
    row.litres += num(r.litres_all);
    row.litresToday += num(r.litres_today);
    row.salesValue += num(r.value_all);
    row.salesValueToday += num(r.value_today);
    row.expenses += num(r.expenses_all);
    if (r.last_load && (!row.lastLoad || r.last_load > row.lastLoad)) row.lastLoad = r.last_load;
  }
  for (const r of paymentRows) {
    const row = at(r.code, r.party, r.customer_type);
    row.fundsReceived += num(r.paid_all);
    row.fundsReceivedToday += num(r.paid_today);
  }
  for (const r of stockRows) {
    const row = at(r.code, r.party, r.customer_type);
    row.allocatedLitres += num(r.allocated);
    row.trucksAllocated += Number(r.trucks || 0);
  }

  const all = [...rowsBy.values()].map((r) => ({
    ...r,
    // Never negative: an overpayment is a real thing, but it is not a debt,
    // and summing it against other lines would understate what is owed.
    balance: Math.max(0, r.salesValue - r.fundsReceived),
    remainingLitres: r.allocatedLitres - r.litres,
    // What was on the ground when the day opened — today's sales put back.
    // Derived from what remains for the same reason the depot's opening stock
    // is: the remaining figure is the one that has to agree with the
    // allocation, so the row reads straight across from it.
    openingLitresToday: r.allocatedLitres - r.litres + r.litresToday,
    stockKnown: r.allocatedLitres > 0 && r.allocatedLitres >= r.litres,
  }));

  /**
   * Live, or finished.
   *
   * Until an allocation carries a state of its own, this is derived: a batch
   * or station is live if it moved today, took money today, or still has stock
   * on the ground. Everything else is finished business and is left out, which
   * is the point — a report carrying nine dormant batches buries the two that
   * matter.
   *
   * A finished line that still owes money is NOT dropped silently; it is
   * summarised in `settled` so the debt stays visible without the detail.
   */
  const isLive = (r) =>
    r.loadsToday > 0 ||
    r.fundsReceivedToday > 0 ||
    (r.stockKnown && r.remainingLitres > 0) ||
    // Sold out but still owed is not finished — it is the line somebody has to
    // chase. Dropping it would hide N1.6bn of debt to tidy the page up.
    r.balance > 0;

  const liveRows = all.filter(isLive);
  const dormant = all.filter((r) => !isLive(r));

  const truckSales = rollUpTruckSales(all, liveRows);

  const stations = liveRows
    .filter((r) => r.customerType === "filling_station")
    // Batch first, then station alphabetically: the batch is what a reader
    // scans for, and within it the name is the only stable order there is.
    .sort((a, b) => a.code.localeCompare(b.code) || a.party.localeCompare(b.party));

  const settled = dormant.reduce(
    (acc, r) => {
      acc.lines += 1;
      acc.salesValue += r.salesValue;
      acc.fundsReceived += r.fundsReceived;
      acc.balance += r.balance;
      return acc;
    },
    { lines: 0, salesValue: 0, fundsReceived: 0, balance: 0 }
  );

  /** pfi_number → the unit that batch trades in, for the sheets filed against it. */
  const unitByPfi = new Map(
    pfis.map((p) => [String(p.pfiNumber || "").trim().toUpperCase().replace(/\s+/g, " "), p.unit])
  );

  /**
   * The sheets each desk filed today.
   *
   * daily_reports carries pfi_number, so a sheet can be read against the batch
   * it was filed for rather than only against a location.
   */
  const staffRows = await client`
    SELECT report_type::text AS role, location, pfi_number, product_name,
           submitted_by_name, status::text AS status, remarks,
           -- Every column the role's own form collects, because the report now
           -- renders each desk under ITS OWN headings (see roleFields.js)
           -- rather than forcing five different sheets through one set of
           -- twelve generic columns. A commission sheet used to arrive as a row
           -- of dashes with its entire point — funds received, commission due,
           -- what is still owed — absent, because the query never asked for it.
           opening_stock::numeric             AS opening_stock,
           received_stock::numeric            AS received_stock,
           litres_sold::numeric               AS litres_sold,
           loading_left_over::numeric         AS loading_left_over,
           tank_balance::numeric              AS tank_balance,
           avg_price::numeric                 AS avg_price,
           total_sales_amount::numeric        AS total_sales_amount,
           amount_paid::numeric               AS amount_paid,
           total_inflow::numeric              AS total_inflow,
           differentials::numeric             AS differentials,
           yesterday_deficit_payment::numeric AS yesterday_deficit_payment,
           yesterday_surplus_payment::numeric AS yesterday_surplus_payment,
           funds_received::numeric            AS funds_received,
           commission_due::numeric            AS commission_due,
           commission_outstanding::numeric    AS commission_outstanding,
           funds_remaining::numeric           AS funds_remaining,
           bank_name, account_number,
           customer_count, order_count, truck_count, trucks_entered,
           price_bands, top_customers
      FROM daily_reports
     WHERE report_date = ${dayStr}
     -- report_type::text, not report_type: it is an enum, and a bare enum sorts
     -- by declaration order, which put SECURITY GATE above IT COMPLIANCE and
     -- looked like no order at all.
     ORDER BY COALESCE(NULLIF(TRIM(pfi_number), ''), 'ZZZZ') ASC,
              report_type::text ASC,
              location ASC`;

  /**
   * A figure somebody typed, or nothing at all.
   *
   * The nullable columns — every commission figure, the gate's trucksEntered —
   * are nullable precisely so that "not filled in yet" stays distinguishable
   * from "the answer is zero" on a sheet filed in stages. Number(null) is 0,
   * so coercing here would destroy exactly the distinction the schema went out
   * of its way to keep, and the template would print a confident 0 where
   * nobody has answered.
   */
  const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));

  /**
   * `daily_reports.pfi_number` is typed on a form, `pfis.pfi_number` is the
   * record — same string in practice, but only after the spacing and case a
   * form picks up are taken off it.
   */
  const pfiKey = (v) => String(v || "").trim().toUpperCase().replace(/\s+/g, " ");

  const staffEntries = staffRows.map((r) => ({
    role: r.role,
    location: r.location || "",
    pfiNumber: r.pfi_number || "",
    productName: r.product_name || "",
    submittedBy: r.submitted_by_name || "",
    status: r.status,
    remarks: r.remarks || "",
    openingStock: numOrNull(r.opening_stock),
    receivedStock: numOrNull(r.received_stock),
    litresSold: numOrNull(r.litres_sold),
    loadingLeftOver: numOrNull(r.loading_left_over),
    tankBalance: numOrNull(r.tank_balance),
    avgPrice: numOrNull(r.avg_price),
    totalSalesAmount: numOrNull(r.total_sales_amount),
    amountPaid: numOrNull(r.amount_paid),
    totalInflow: numOrNull(r.total_inflow),
    differentials: numOrNull(r.differentials),
    yesterdayDeficitPayment: numOrNull(r.yesterday_deficit_payment),
    yesterdaySurplusPayment: numOrNull(r.yesterday_surplus_payment),
    fundsReceived: numOrNull(r.funds_received),
    commissionDue: numOrNull(r.commission_due),
    commissionOutstanding: numOrNull(r.commission_outstanding),
    fundsRemaining: numOrNull(r.funds_remaining),
    bankName: r.bank_name || "",
    accountNumber: r.account_number || "",
    customerCount: numOrNull(r.customer_count),
    orderCount: numOrNull(r.order_count),
    truckCount: numOrNull(r.truck_count),
    trucksEntered: numOrNull(r.trucks_entered),
    priceBands: Array.isArray(r.price_bands) ? r.price_bands : [],
    topCustomers: Array.isArray(r.top_customers) ? r.top_customers : [],
    // The unit belongs to the batch, not to the sheet: a gas sheet's "litres
    // sold" is kilograms, and the form has no column saying so.
    unit: unitByPfi.get(pfiKey(r.pfi_number)) || "Litres",
  }));

  /**
   * Silence is a finding.
   *
   * The section used to list the sheets that arrived and say nothing about the
   * ones that did not — so a desk that filed nothing all day looked exactly
   * like a desk that does not exist, and the reader had to hold eleven batches
   * and five roles in their head to notice. The whole reason this section is
   * read at the end of a day is to see who has NOT reported.
   *
   * So the grid is built from the batches rather than from the rows: every
   * active PFI appears under every role, and one that filed nothing says so in
   * its own row. A sheet filed against a batch that is no longer active is
   * still listed — it was really filed, and dropping it would be the same
   * silence in the other direction.
   */
  const staffReports = ROLE_ORDER.map((type) => {
    const forRole = staffEntries.filter((e) => e.role === type);
    const seen = new Set();
    const rows = [];

    for (const p of pfis) {
      const filed = forRole.filter((e) => pfiKey(e.pfiNumber) === pfiKey(p.pfiNumber));
      filed.forEach((e) => seen.add(e));
      if (filed.length) rows.push(...filed);
      else rows.push({ role: type, pfiNumber: p.pfiNumber, location: p.location, unit: p.unit, reported: false });
    }
    // Filed against something not in the active list — an old batch, or a
    // pfi_number left blank on the form.
    for (const e of forRole) if (!seen.has(e)) rows.push(e);

    return {
      type,
      label: ROLE_LABELS[type],
      filed: forRole.length,
      rows: rows.map((r) => ({ reported: true, ...r })),
    };
  });

  // ── One line for the top of the email ───────────────────────────────────
  const depotTotals = pfis.reduce(
    (acc, p) => {
      acc.ordersToday += p.orders.today.count;
      acc.litresToday += p.orders.today.litres;
      acc.valueToday += p.orders.today.value;
      acc.paidToday += p.orders.today.paid;
      acc.outstanding += p.orders.outstanding;
      acc.exitedToday += p.movements.exitedToday;
      acc.expensesToday += p.expenses.today.requested;
      return acc;
    },
    { ordersToday: 0, litresToday: 0, valueToday: 0, paidToday: 0, outstanding: 0, exitedToday: 0, expensesToday: 0 }
  );

  /**
   * The delivery half, split the way the report shows it.
   *
   * Kept apart so the summary's FUNDS RECEIVED can be checked against the
   * tables underneath it rather than taken on trust: it is exactly depot
   * collections + truck-sales payments + filling-station payments, all for
   * this day only. A headline figure that cannot be reconciled with the rows
   * below it is the fastest way to lose a reader.
   *
   * '(unassigned)' is excluded here as it is in the table — money against a
   * batch nobody recorded is carried in `unassignedReceivedToday` instead of
   * being quietly folded into a total it cannot be traced to.
   */
  const tally = (rows) =>
    rows.reduce(
      (acc, r) => {
        acc.litresToday += r.litresToday;
        acc.valueToday += r.salesValueToday;
        acc.receivedToday += r.fundsReceivedToday;
        acc.balance += r.balance;
        acc.trucksToday += r.loadsToday;
        return acc;
      },
      { litresToday: 0, valueToday: 0, receivedToday: 0, balance: 0, trucksToday: 0 }
    );

  const truckSaleRows = liveRows.filter((r) => r.customerType !== "filling_station" && r.code !== "(unassigned)");
  const stationSaleRows = liveRows.filter((r) => r.customerType === "filling_station");
  const unassignedRows = liveRows.filter((r) => r.code === "(unassigned)" && r.customerType !== "filling_station");

  const truckTotals = tally(truckSaleRows);
  const stationTotals = tally(stationSaleRows);
  const saleTotals = tally([...truckSaleRows, ...stationSaleRows]);
  const unassignedReceivedToday = tally(unassignedRows).receivedToday;

  const generalExpenses = generalExpenseRows.map((g) => ({
    category: g.category,
    today: {
      count: Number(g.entries_today || 0),
      requested: num(g.amount_today),
      paid: num(g.paid_today),
    },
    toDate: {
      count: Number(g.entries_all || 0),
      requested: num(g.amount_all),
      paid: num(g.paid_all),
    },
  }));

  /**
   * The EXPENSES table, already in reading order.
   *
   * Assembled here rather than in the template because it is the one section
   * whose rows do not come from the active-batch list: a closed batch that
   * spent money today belongs on it, and only this file knows that batch's
   * number. Batches first and then general categories, each ordered by what
   * was spent, so the largest movement of the day is the first line read.
   */
  const expenseLines = [
    ...expenseRows.map((e) => ({
      label: pfiNames.get(Number(e.pfi_id)) || `PFI #${e.pfi_id}`,
      today: {
        count: Number(e.expenses_today || 0),
        requested: num(e.amount_today),
        paid: num(e.paid_today),
      },
      toDate: {
        count: Number(e.expenses_all || 0),
        requested: num(e.amount_all),
        paid: num(e.paid_all),
      },
    })),
  ]
    .filter((l) => l.today.requested > 0 || l.today.paid > 0)
    .sort((a, b) => b.today.requested + b.today.paid - (a.today.requested + a.today.paid))
    .concat(
      generalExpenses
        .filter((g) => g.today.requested > 0 || g.today.paid > 0)
        .sort((a, b) => b.today.requested + b.today.paid - (a.today.requested + a.today.paid))
        .map((g) => ({ label: `General — ${g.category}`, today: g.today, toDate: g.toDate }))
    );

  return {
    reportDate: dayStr,
    generatedAt: new Date().toISOString(),
    summary: {
      activePfis: pfis.length,
      activeBatches: truckSales.length,
      activeStations: stations.length,
      litresSold: depotTotals.litresToday + saleTotals.litresToday,
      salesValue: depotTotals.valueToday + saleTotals.valueToday,
      fundsReceived: depotTotals.paidToday + saleTotals.receivedToday,
      balance: depotTotals.outstanding + saleTotals.balance,
      depot: depotTotals,
      delivery: saleTotals,
      /** The three parts of FUNDS RECEIVED, so the headline can be checked. */
      received: {
        depot: depotTotals.paidToday,
        truckSales: truckTotals.receivedToday,
        stations: stationTotals.receivedToday,
        unassigned: unassignedReceivedToday,
      },
      settled,
    },
    pfis,
    generalExpenses,
    expenseLines,
    truckSales,
    stations,
    /** Flat, as filed. */
    staffEntries,
    /** The same sheets as a role × batch grid, including the gaps. */
    staffReports,
  };
};

module.exports = { buildPfiDailyReportData, rollUpTruckSales };
