/**
 * The day's trading, assembled per PFI.
 *
 * The combined report groups by depot, which answers "how did Warri do".
 * This answers the question actually asked at the end of a day: for each
 * batch we are currently trading, what came in, what went out, what is still
 * owed, and what is left. A batch — not a depot — is the thing that gets
 * bought, drawn down and closed, so it is the thing the money hangs off.
 *
 * ── Depot trading and delivery trading ───────────────────────────────────
 *
 * Depot trading is keyed on `pfis.id`: an order carries a real `pfi_id`, so
 * every figure on that side is exact, and it is summed here in SQL.
 *
 * Delivery trading — truck sales and stations — is keyed on the batch's
 * allocation code, and is summed by ports of the dashboard's own arithmetic
 * (lib/deliveryBatches.js, lib/stationAccounts.js) over the rows exactly as
 * the API serves them, so a batch reads the same here as on PFI Tracking and a
 * station the same as on its own page. See the note where they are called.
 *
 * ── Stations are customers, not places ────────────────────────────────────
 *
 * A filling station is a row in `delivery_customers` with
 * customer_type = 'filling_station'; an LPG plant ('lpg_plant', migration
 * 0061) is a station too, reported in its own table in the same layout.
 */
const { client } = require("../db");
const { stockQty } = require("../lib/pfiStock");
const { dayBounds, REPORT_TZ } = require("./dailyCombinedReport.service");
// The desks, in reading order, and the columns each one's form collects. Shared
// with the combined report so the two cannot describe the same sheet
// differently — see notifications/templates/roleFields.js.
const { ROLE_ORDER, ROLE_LABELS } = require("../notifications/templates/roleFields");
const { summariseBatches } = require("../lib/deliveryBatches");
const { stationPositions, restockClosure } = require("../lib/stationAccounts");
const { deliveryInventoryRepo, deliverySaleRepo, deliveryCustomerRepo } = require("../repositories");
const { STATUS_LABELS } = require("../lib/expenseChain");

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
           starting_qty_litres, evacuation_surplus_litres, operational_loss_litres, sold_qty_litres, unit_price::numeric AS unit_price,
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
           COALESCE(SUM(o.total_amount::numeric) FILTER (WHERE o.created_at >= ${startIso} AND o.created_at < ${endIso}), 0) AS value_today,
           -- Out before payment (the manual ticket). Unpriced by quantity only:
           -- their naira figures are placeholders.
           COUNT(*)                    FILTER (WHERE o.pricing_status = 'pending') AS unpriced_orders,
           COALESCE(SUM(o.quantity)    FILTER (WHERE o.pricing_status = 'pending'), 0) AS unpriced_litres,
           COUNT(*)                    FILTER (WHERE o.credit_qty > 0 AND o.pricing_status = 'priced' AND o.payment_status::text <> 'Paid') AS credit_orders,
           COALESCE(SUM(o.quantity)    FILTER (WHERE o.credit_qty > 0 AND o.pricing_status = 'priced' AND o.payment_status::text <> 'Paid'), 0) AS credit_litres,
           COALESCE(SUM(GREATEST(o.total_amount::numeric - o.amount_paid::numeric, 0))
                                       FILTER (WHERE o.credit_qty > 0 AND o.pricing_status = 'priced' AND o.payment_status::text <> 'Paid'), 0) AS credit_owed
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
       -- Refunds sit under their PFI but are never its cost (migration 0065).
       AND NOT EXISTS (SELECT 1 FROM expense_categories rc WHERE rc.id = pfi_expenses.category_id AND rc.is_refund)
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
   *
   * ── EARNED IS DATED ON THE ORDER, NOT ON THE COMMISSION ROW ─────────────
   *
   * A commission is earned by an order, so it belongs to the ORDER's day. The
   * commission row is written whenever the desk gets to it, which is routinely
   * the next morning: 133 of 592 live rows (22%) carry a date different from
   * the order that earned them, and both of the commissions this report showed
   * as "earned today" on 16 September belong to orders placed on the 15th.
   *
   * It matters more than the lag, because `orders.created_at` is EDITABLE
   * (services/order.service.js) and is what every other figure on this report
   * is keyed to. Correcting an order's date moves its litres, its sales value
   * and its stock movement to the corrected day; keyed on `c.created_at` the
   * commission stayed behind on the day somebody happened to key it in, and
   * the two halves of the same trade ended up on different reports.
   *
   * PAID stays on `c.paid_at`. Settling a commission is its own event on its
   * own day — money left the bank when it left the bank, whatever date the
   * order it belongs to now carries.
   */
  const commissionRows = await client`
    SELECT o.pfi_id,
           COUNT(*)                                                                      AS entries,
           COALESCE(SUM(c.commission_amount::numeric) FILTER (WHERE c.status = 'pending'), 0) AS due,
           COALESCE(SUM(c.commission_amount::numeric) FILTER (WHERE c.status = 'paid'), 0)    AS paid,
           COALESCE(SUM(c.quantity), 0)                                                  AS litres,
           -- Earned today: what today's ORDERS earned, whatever day the
           -- commission row was keyed in and whatever has since happened to it.
           COUNT(*) FILTER (WHERE o.created_at >= ${startIso} AND o.created_at < ${endIso}) AS entries_today,
           COALESCE(SUM(c.commission_amount::numeric)
             FILTER (WHERE o.created_at >= ${startIso} AND o.created_at < ${endIso}), 0)   AS due_today,
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
       -- A customer refund is money returned, not overhead (migration 0065).
       AND NOT COALESCE(c.is_refund, false)
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

  const activePfis = pfiRows.map((p) => {
    const o = orders.get(Number(p.id)) || {};
    const collected = num((collections.get(Number(p.id)) || {}).paid_today);
    const t = trucks.get(Number(p.id)) || {};
    const e = expenses.get(Number(p.id)) || {};
    const cm = commissions.get(Number(p.id)) || {};

    // `starting` stays the batch as landed — the email's Initial stock column,
    // which never changes. Closing runs off landed plus any evacuation surplus
    // found since, because that is what the batch has had to sell.
    const starting = num(p.starting_qty_litres);
    const surplus = num(p.evacuation_surplus_litres);
    const loss = num(p.operational_loss_litres);
    const stock = stockQty(p);
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
    const closing = Math.max(0, stock - sold);
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
        surplus,
        loss,
        sold,
        openingToday: closing + soldToday,
        soldToday,
        remaining: closing,
        percentSold: stock > 0 ? (sold / stock) * 100 : 0,
      },

      orders: {
        today: { count: Number(o.orders_today || 0), litres: num(o.litres_today), value: num(o.value_today), paid: collected },
        toDate: { count: Number(o.orders_all || 0), litres: num(o.litres_all), value: valueAll, paid: paidAll },
        outstanding: Math.max(0, valueAll - paidAll),
      },

      /** Product out before payment — awaiting a price, or released on credit and unpaid. */
      beforePayment: {
        unpricedOrders: Number(o.unpriced_orders || 0),
        unpricedLitres: num(o.unpriced_litres),
        creditOrders: Number(o.credit_orders || 0),
        creditLitres: num(o.credit_litres),
        creditOwed: num(o.credit_owed),
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
   * The depot side of the report: every active batch EXCEPT the trucking ones.
   *
   * A trucking PFI trades through `delivery_sales`, never through orders, so
   * on every depot table it is a row of structural zeros — "0 Litres" of
   * closing stock against a batch that is out on the road selling. It is
   * reported where its trade actually happens, under TRUCK SALES and the
   * station tables, and nowhere else.
   */
  const pfis = activePfis.filter((p) => p.type !== "trucking");

  /**
   * Truck sales and stations, read the way the dashboard reads them.
   *
   * This half used to be summed here from its own SQL: loads counted as
   * distinct sale rows, allocations matched to buyers by name. It printed
   * PFI-36C as 70 trucks sold against 49 allocated — a batch whose PFI
   * Tracking card reads 51 and 51 — and stations as "N/A" wherever a truck
   * had been split between two of them. Two screens giving two answers for
   * the same batch is the one thing a daily report cannot do.
   *
   * So the rows are read exactly as the API hands them to the dashboard, and
   * summed by ports of the dashboard's own arithmetic: lib/deliveryBatches.js
   * (PFI Tracking, Delivery Inventory) and lib/stationAccounts.js (the
   * station pages). Checked on 2026-09-28 against the dashboard's code on the
   * same production rows: 11 of 11 batches and 36 of 36 station restocks
   * identical, figure for figure.
   */
  const everyRow = async (fetchPage, pick) => {
    const out = [];
    for (let page = 1; ; page++) {
      const rows = pick(await fetchPage({ page, limit: 1000 })) || [];
      out.push(...rows);
      if (rows.length < 1000) return out;
    }
  };
  // Through JSON so dates and decimals arrive as the dashboard receives them —
  // the arithmetic compares dates as strings, as the dashboard does.
  const apiShape = (rows) => JSON.parse(JSON.stringify(rows));
  const [deliveryEntries, deliverySales, deliveryCustomers] = (
    await Promise.all([
      everyRow((q) => deliveryInventoryRepo.findAll(q), (r) => r.loadings),
      everyRow((q) => deliverySaleRepo.findAll(q), (r) => r.sales),
      everyRow((q) => deliveryCustomerRepo.findAll(q), (r) => r.customers),
    ])
  ).map(apiShape);

  /**
   * Closed, the way the station pages decide it (useRestockClosure): the desk
   * closed the batch on Delivery Inventory, or the PFI behind it is finished.
   * The same rule decides which truck-sales batches are listed, so a batch is
   * on both tables or on neither.
   */
  const completedCodes = (await client`SELECT code FROM delivery_batches WHERE status = 'completed'`)
    .map((r) => r.code);
  const allPfiRows = await client`
    SELECT id, pfi_number, allocation_code, status::text AS status, product_unit FROM pfis`;
  const finishedPfis = allPfiRows
    .filter((p) => p.status === "finished")
    .map((p) => ({ id: Number(p.id), pfiNumber: p.pfi_number, allocationCode: p.allocation_code }));
  const isClosed = restockClosure({ completedCodes, finishedPfis });

  const unitByPfiId = new Map(allPfiRows.map((p) => [Number(p.id), p.product_unit || null]));
  const unitByCode = new Map(
    allPfiRows.filter((p) => p.allocation_code).map((p) => [String(p.allocation_code).trim().toUpperCase(), p.product_unit || null])
  );

  // The PFIs each batch's trucks were drawn against.
  const batchPfiIds = new Map();
  for (const e of deliveryEntries) {
    const code = String(e.allocationCode || "").trim().toUpperCase();
    if (!batchPfiIds.has(code)) batchPfiIds.set(code, new Set());
    if (e.pfiId != null) batchPfiIds.get(code).add(Number(e.pfiId));
  }
  const batchUnit = (code) => {
    for (const id of batchPfiIds.get(code) || []) if (unitByPfiId.get(id)) return unitByPfiId.get(id);
    return unitByCode.get(code) || "Litres";
  };
  const batchClosed = (code) =>
    isClosed({ allocationCode: code }) ||
    [...(batchPfiIds.get(code) || [])].some((id) => isClosed({ pfiId: id }));

  const truckSales = [
    ...summariseBatches({ entries: deliveryEntries, sales: deliverySales, customers: deliveryCustomers }).values(),
  ]
    // A truck with no code on it belongs to no batch anybody can name.
    .filter((b) => b.code && !batchClosed(b.code))
    .map((b) => ({ ...b, unit: batchUnit(b.code) }))
    // The order Delivery Inventory lists them in: Z to A, numerically.
    .sort((a, b) => b.code.localeCompare(a.code, undefined, { numeric: true, sensitivity: "base" }));

  const stations = stationPositions({
    entries: deliveryEntries,
    sales: deliverySales,
    customers: deliveryCustomers,
    dayStr,
    isClosed,
  })
    .flatMap((st) =>
      st.pfis.map((raw) => {
        // Pump volumes are floats summed over hundreds of rows; a stock of
        // 1.8e-12 litres is a rounding crumb, not stock, and must not print
        // red. Two places, as a pump meter reads.
        const l = Object.fromEntries(
          Object.entries(raw).map(([k, v]) => [k, typeof v === "number" && k !== "pfiId" ? Math.round(v * 100) / 100 : v])
        );
        return {
        stationId: st.stationId,
        party: st.name,
        customerType: st.customerType,
        code: l.code,
        unit: (l.pfiId != null && unitByPfiId.get(Number(l.pfiId))) || batchUnit(l.code) ||
          (st.customerType === "lpg_plant" ? "kg" : "Litres"),
        received: l.quantity,
        soldToday: l.soldToday,
        sold: l.quantitySold,
        stockLeft: l.stockLeft,
        salesValueToday: l.salesValueToday,
        salesValue: l.salesValue,
        banked: l.deposits,
        bankedToday: l.depositsToday,
        spent: l.expenses,
        // Sold at the pump and neither banked nor spent on the station's own
        // running: the money that is still at the station.
        balance: Math.max(0, Math.round((l.salesValue - l.deposits - l.expenses) * 100) / 100),
      };
      })
    )
    .sort((a, b) => a.party.localeCompare(b.party) || a.code.localeCompare(b.code, undefined, { numeric: true }));

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
  /**
   * Scoped to the depot batches — active and not trucking — and nothing else.
   *
   * A trucking PFI has no desk filing against it the way a depot batch does,
   * so under every role it was a column of "Not reported" rows that could
   * never be anything else. Sheets filed against a closed or trucking batch
   * are not lost: the Reports Hub's Filed sheets view lists every sheet as
   * filed. This section answers one question — which live depot batch has
   * not reported — and anything outside that is noise in it.
   */
  const depotPfiKeys = new Set(pfis.map((p) => pfiKey(p.pfiNumber)));
  const staffReports = ROLE_ORDER.map((type) => {
    const forRole = staffEntries.filter((e) => e.role === type && depotPfiKeys.has(pfiKey(e.pfiNumber)));
    const rows = [];

    for (const p of pfis) {
      const filed = forRole.filter((e) => pfiKey(e.pfiNumber) === pfiKey(p.pfiNumber));
      if (filed.length) rows.push(...filed);
      else rows.push({ role: type, pfiNumber: p.pfiNumber, location: p.location, unit: p.unit, reported: false });
    }

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
  /**
   * Every request behind today's expense figures, with where it has got to.
   *
   * A line's "₦300,000 requested today" says money was asked for; it does not
   * say whether anybody has signed it, which is the question a reader asks
   * next. So each line carries its requests and the stage each one is at, in
   * the chain's own words (lib/expenseChain.js) — named after whoever has to
   * act next, which is the only thing a status is read for.
   *
   * The same two filters as the figures: raised today, or paid today.
   */
  const expenseItemRows = await client`
    SELECT e.pfi_id,
           COALESCE(NULLIF(TRIM(c.name), ''), 'Uncategorised') AS category,
           e.reference_number,
           e.status::text                AS status,
           e.amount_ngn::numeric         AS amount,
           COALESCE(e.description, '')   AS description
      FROM pfi_expenses e
      LEFT JOIN expense_categories c ON c.id = e.category_id
     WHERE e.deleted_at IS NULL
       AND e.status <> 'rejected'
       AND NOT COALESCE(c.is_refund, false)
       AND ((e.expense_date >= ${startIso} AND e.expense_date < ${endIso})
         OR (e.paid_at      >= ${startIso} AND e.paid_at      < ${endIso}))
     ORDER BY e.amount_ngn DESC NULLS LAST, e.id`;

  const itemsBy = new Map();
  for (const r of expenseItemRows) {
    const key = r.pfi_id != null ? `pfi:${Number(r.pfi_id)}` : `cat:${r.category}`;
    if (!itemsBy.has(key)) itemsBy.set(key, []);
    itemsBy.get(key).push({
      reference: r.reference_number || "",
      amount: num(r.amount),
      status: r.status,
      statusLabel: STATUS_LABELS[r.status] || r.status,
      description: String(r.description || "").trim(),
    });
  }

  const expenseLines = [
    ...expenseRows.map((e) => ({
      items: itemsBy.get(`pfi:${Number(e.pfi_id)}`) || [],
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
        .map((g) => ({
          label: `General — ${g.category}`,
          today: g.today,
          toDate: g.toDate,
          items: itemsBy.get(`cat:${g.category}`) || [],
        }))
    );

  return {
    reportDate: dayStr,
    generatedAt: new Date().toISOString(),
    summary: {
      activePfis: pfis.length,
      activeBatches: truckSales.length,
      activeStations: new Set(stations.map((s) => s.stationId)).size,
      // Today's trade the report can date: depot orders and station pumps.
      // A truck sale carries a load date, not a sale date, so it is counted
      // in its batch's running totals rather than guessed onto a day.
      litresSold: depotTotals.litresToday,
      salesValue: depotTotals.valueToday + stations.reduce((a, s) => a + s.salesValueToday, 0),
      fundsReceived: depotTotals.paidToday + stations.reduce((a, s) => a + s.bankedToday, 0),
      balance:
        depotTotals.outstanding +
        truckSales.reduce((a, b) => a + b.unpaid, 0) +
        stations.reduce((a, s) => a + s.balance, 0),
      depot: depotTotals,
    },
    pfis,
    generalExpenses,
    expenseLines,
    /** Every open batch, summed as PFI Tracking sums it. */
    truckSales,
    /** One row per station per open batch, as the station pages read it. */
    stations,
    /** Flat, as filed. */
    staffEntries,
    /** The same sheets as a role × batch grid, including the gaps. */
    staffReports,
  };
};

module.exports = { buildPfiDailyReportData };
