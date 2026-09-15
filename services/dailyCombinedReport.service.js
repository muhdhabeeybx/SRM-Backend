const { client } = require("../db");
const { orderReferenceClient } = require("../lib/orderReferenceSql");
const { generateOrderReference } = require("../utils/helpers");

/**
 * Assembles the data behind the daily HTML report email — the Node
 * equivalent of Django's `_build_combined_html_report()` query side. The
 * catalog template (`reports.daily` in notifications/catalog.js) is a pure
 * function of what this returns; nothing here touches HTML.
 *
 * Locations are depots, not free text: a PFI's `location_id` and an order's
 * `depot_id` are real foreign keys, so grouping by depot is exact. Only
 * `daily_reports.location` is free text (staff type it on the form), so a
 * report row is matched to a depot by substring — the depot name appears
 * inside what staff typed ("Port Harcourt — Avidor Depot" contains "Avidor
 * Depot") — with any report whose location matches no depot kept under its
 * own literal text rather than silently dropped.
 *
 * Which depots appear: any depot with an active PFI, unioned with any depot a
 * daily report matched to for this date — mirroring the Django rule ("PFIs
 * with status=active, unioned with any location that has a staff entry").
 */

const ROLE_TAGS = [
  { type: "sales_manager", label: "SALES_MANAGER" },
  { type: "product_manager", label: "PRODUCT_MANAGER" },
  { type: "security_gate", label: "SECURITY" },
  { type: "commissions", label: "COMMISSIONS" },
  { type: "it_compliance", label: "IT_COMPLIANCE" },
];

/**
 * The reporting day is a LAGOS day, not a UTC one.
 *
 * This used to take UTC midnight either side, which put the window an hour out
 * from the day the business actually trades: "2026-09-04" meant 01:00 WAT on
 * the 4th to 01:00 WAT on the 5th.
 *
 * On its own that is merely odd. Combined with sending the report at 23:50 WAT
 * it opened a hole: the last 1h10m of each window had not happened yet when the
 * email went out, and the next night's window began after it — so every order
 * placed between 23:50 and 01:00 appeared in NO report, every day. A daily
 * report that is quietly incomplete is worse than one that is late.
 *
 * Anchoring on the Lagos calendar day closes it. `daily_reports.report_date`
 * is the date staff typed on the form in Lagos, so this also makes the staff
 * sheets line up with the orders they were filed against.
 */
const REPORT_TZ = process.env.REPORT_TIMEZONE || "Africa/Lagos";

/** "2026-09-04" — the calendar date at this instant, in the reporting zone. */
const localDateStr = (date, tz = REPORT_TZ) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

/** How far the reporting zone is ahead of UTC at a given instant, in ms. */
const zoneOffsetMs = (date, tz = REPORT_TZ) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)])
  );
  // `hour` comes back as 24 at midnight under hour12:false in some ICU builds.
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return asIfUtc - Math.floor(date.getTime() / 1000) * 1000;
};

/**
 * The UTC instant at which a given local calendar day begins.
 *
 * Two passes: the first guess uses the offset at UTC midnight, the second
 * re-reads the offset at that guess. Lagos has no DST so one pass would do,
 * but a zone that does would land an hour out on two days a year.
 */
const zonedDayStart = (dayStr, tz = REPORT_TZ) => {
  const guess = new Date(`${dayStr}T00:00:00Z`);
  let instant = new Date(guess.getTime() - zoneOffsetMs(guess, tz));
  instant = new Date(guess.getTime() - zoneOffsetMs(instant, tz));
  return instant;
};

const dayBounds = (date, tz = REPORT_TZ) => {
  const dayStr = localDateStr(date, tz);
  const start = zonedDayStart(dayStr, tz);
  const next = new Date(`${dayStr}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const end = zonedDayStart(localDateStr(next, "UTC"), tz);
  return { start, end, dayStr };
};

const num = (v) => Number(v || 0);

/** How many orders each depot lists before the table is trimmed. See below. */
const ORDERS_PER_LOCATION = 60;

/**
 * Match a report's free-text location to a depot.
 *
 * `daily_reports.location` is typed by the filer with no depot list behind it,
 * and the same site is written a different way by almost everybody: "Soroman
 * Warri — Keonamex Depot", "Keonamex Depot Warri", "KEONAMEX DEPOT WARRI" and
 * "KEONAMEX PET WARRI" are all one place in Warri North.
 *
 * The old rule was `typedText.includes(depotName)`, which only matched when
 * somebody happened to type the depot's name verbatim and in the right order.
 * Everything else became its own section, so the report grew phantom locations
 * that read exactly like real depots — "KEONAMEX PET WARRI" appeared beside
 * "KEONAMEX DEPOT WARRI" as though Soroman had a site nobody recognised —
 * while 62 sheets filed as "Soroman Warri — Keonamex Depot" sat outside the
 * depot they belong to.
 *
 * Matching is on DISTINCTIVE words instead: a word appearing in exactly one
 * depot's name identifies that depot ("keonamex", "avidor", "tsl", "calabar"),
 * and a word appearing in several ("port", "harcourt", "depot", "soroman")
 * identifies nothing and is ignored. That is what makes this safe — "Port
 * Harcourt — Liquid Bulk" and "Port Harcourt — Avidor Depot" share both their
 * first two words and are still told apart correctly.
 *
 * A text naming two different depots, or none, stays unmatched and keeps its
 * own section under the words as typed. That is deliberate: filing a sheet
 * under the wrong site silently is worse than showing it under what somebody
 * actually wrote.
 */
const createDepotMatcher = (depots) => {
  const wordsOf = (text) =>
    String(text || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2);

  const depotsByWord = new Map();
  for (const depot of depots) {
    for (const word of new Set(wordsOf(depot.name))) {
      if (!depotsByWord.has(word)) depotsByWord.set(word, new Set());
      depotsByWord.get(word).add(depot.id);
    }
  }

  return (locationText) => {
    const words = new Set(wordsOf(locationText));
    if (words.size === 0) return null;

    const hits = new Set();
    for (const word of words) {
      const owners = depotsByWord.get(word);
      // Only a word belonging to exactly one depot says which depot this is.
      if (owners && owners.size === 1) hits.add([...owners][0]);
    }

    if (hits.size !== 1) return null;
    return depots.find((d) => d.id === [...hits][0]) || null;
  };
};

/**
 * The jsonb columns, made safe to render.
 *
 * Both are filled in by the dashboard's own form and are `'[]'::jsonb` by
 * default, but a row written before the column existed can hold null, and the
 * driver hands back whatever is there. The template must not have to guard
 * against a non-array, so the guarding happens once, here.
 */
const normalisePriceBands = (raw) =>
  (Array.isArray(raw) ? raw : [])
    .map((b) => ({ price: num(b?.price), litres: num(b?.litres) }))
    // A blank row the filer never completed is not a price band.
    .filter((b) => b.price > 0 || b.litres > 0);

const normaliseTopCustomers = (raw) =>
  (Array.isArray(raw) ? raw : [])
    .map((c) => ({
      name: String(c?.name || "").trim(),
      phone: String(c?.phone || "").trim(),
      litres: num(c?.litres),
    }))
    .filter((c) => c.name || c.litres > 0);

const buildCombinedDailyReportData = async (date = new Date()) => {
  const { start, end, dayStr } = dayBounds(date);
  // The Lagos calendar date, NOT start.toISOString() — `start` is now 23:00 UTC
  // on the previous day, so slicing it would name the wrong report date and
  // would not match what staff typed on their sheets.
  const reportDateStr = dayStr;

  const [depots, activePfis, reports, ordersToday, priorDays, pfiLifetimeRevenue, pfiTrading] =
    await Promise.all([
      client`SELECT id, name, city, state FROM depots ORDER BY city ASC`,
      client`
        SELECT id, pfi_number, location_id, product_name, product_unit,
               starting_qty_litres, sold_qty_litres, status
        FROM pfis WHERE status = 'active'
      `,
      // Every column the five report forms can fill in, not the nine the email
      // used to show. A gate report's "trucks entered", a sales sheet's price
      // bands and every commission figure were all being collected and none of
      // them reached the reader — see the per-role column sets in the template.
      client`
        SELECT id, report_type, report_date, location, pfi_number, product_name,
               submitted_by_name, status,
               carried_over_loading, opening_stock, received_stock, litres_sold,
               tank_balance, loading_left_over,
               price_bands, avg_price, total_sales_amount, amount_paid, differentials,
               truck_count, trucks_entered,
               yesterday_deficit_payment, yesterday_surplus_payment, total_inflow,
               funds_received, commission_due, commission_outstanding, funds_remaining,
               customer_count, order_count, rates, top_customers,
               bank_name, account_number, remarks
        FROM daily_reports WHERE report_date = ${reportDateStr}
      `,
      client`
        SELECT o.id, ${orderReferenceClient(client, 'o', 'c')} AS order_number, o.company_name, o.pfi_id, o.depot_id,
               o.quantity, o.price, o.total_amount, o.status, o.payment_status,
               c.name AS customer_name, pr.name AS product_name
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN products pr ON pr.id = o.product_id
        WHERE o.created_at >= ${start.toISOString()} AND o.created_at < ${end.toISOString()}
        ORDER BY o.created_at ASC
      `,
      // The seven days BEFORE this one, a day at a time. The summary needs
      // something to compare today against: a figure on its own says nothing —
      // "190,000 Litres" is only good or bad next to what the other days did.
      // Bucketed in SQL by the reporting zone so the days line up with the
      // report's own window rather than with UTC.
      client`
        SELECT (o.created_at AT TIME ZONE ${REPORT_TZ})::date AS day,
               COUNT(*)::int                       AS order_count,
               COALESCE(SUM(o.quantity), 0)::bigint AS qty,
               COALESCE(SUM(o.total_amount), 0)::text AS value
        FROM orders o
        WHERE o.created_at >= ${new Date(start.getTime() - 7 * 86400000).toISOString()}
          AND o.created_at <  ${start.toISOString()}
        GROUP BY 1
        ORDER BY 1 DESC
      `,
      client`
        SELECT pfi_id, COALESCE(SUM(total_amount), 0)::text AS total
        FROM orders WHERE payment_status = 'Paid' AND pfi_id IS NOT NULL
        GROUP BY pfi_id
      `,
      /**
       * The day's trading, per PFI, plus what left the batch after it.
       *
       * One query and one definition, because the numbers on this row have to
       * agree with each other: opening minus ordered has to equal closing, and
       * it cannot if the quantity comes from one source and the stock level
       * from another.
       *
       * A quantity is attributed to a batch by its allocation row where one
       * exists and by `orders.pfi_id` where it does not. Neither alone is
       * enough: the allocation ledger is the real record (`orders.pfi_id` is
       * the pre-multi-PFI column and disagrees with it on six of the eleven
       * live batches), but 1 September has an order naming a batch with no
       * allocation row at all, which a ledger-only reading drops — 159,060 L
       * of LPG, invisible. No order in the book spans more than one batch
       * (0 of 4,712), so the LEFT JOIN cannot multiply a row and the COALESCE
       * counts every order exactly once.
       *
       * Cancelled and Expired orders are excluded because both hand their
       * reservation back — see releaseOrderResources in order.service.js.
       */
      client`
        WITH attributed AS (
          SELECT COALESCE(a.pfi_id, o.pfi_id)      AS pfi_id,
                 COALESCE(a.quantity, o.quantity)::numeric AS qty,
                 o.total_amount::numeric           AS value,
                 o.payment_status,
                 o.created_at
          FROM orders o
          LEFT JOIN order_pfi_allocations a ON a.order_id = o.id
          WHERE o.status NOT IN ('Cancelled', 'Expired')
            AND COALESCE(a.pfi_id, o.pfi_id) IS NOT NULL
        )
        SELECT pfi_id,
               COALESCE(SUM(qty) FILTER (WHERE created_at >= ${start.toISOString()}
                                           AND created_at <  ${end.toISOString()}), 0)::bigint
                 AS ordered_qty,
               COALESCE(SUM(value) FILTER (WHERE created_at >= ${start.toISOString()}
                                             AND created_at <  ${end.toISOString()}), 0)::text
                 AS ordered_value,
               COALESCE(SUM(qty) FILTER (WHERE created_at >= ${start.toISOString()}
                                           AND created_at <  ${end.toISOString()}
                                           AND payment_status = 'Paid'), 0)::bigint
                 AS confirmed_qty,
               COALESCE(SUM(value) FILTER (WHERE created_at >= ${start.toISOString()}
                                             AND created_at <  ${end.toISOString()}
                                             AND payment_status = 'Paid'), 0)::text
                 AS confirmed_value,
               COALESCE(SUM(qty) FILTER (WHERE created_at >= ${end.toISOString()}), 0)::bigint
                 AS qty_after_day
        FROM attributed
        GROUP BY pfi_id
      `,
    ]);

  const lifetimeRevenueByPfi = new Map(pfiLifetimeRevenue.map((r) => [r.pfi_id, num(r.total)]));
  const tradingByPfi = new Map(
    pfiTrading.map((r) => [
      r.pfi_id,
      {
        orderedQty: num(r.ordered_qty),
        orderedValue: num(r.ordered_value),
        confirmedQty: num(r.confirmed_qty),
        confirmedValue: num(r.confirmed_value),
        qtyAfterDay: num(r.qty_after_day),
      },
    ])
  );

  const matchDepot = createDepotMatcher(depots);

  // ── Group by depot, not city — Port Harcourt has more than one depot, and
  // collapsing them into one "PORT HARCOURT" section would mix PFIs and staff
  // entries that belong to different physical sites. Each depot gets its own
  // section, named for the depot itself; a depot with several active PFIs
  // (e.g. Dangote Refinery) just lists them all as separate PFI Stock rows. ──
  const groups = new Map(); // key -> { name, staffEntries: Map(type->row), pfiIds: Set, orders: [...] }
  const depotKey = (depot) => `depot:${depot.id}`;
  const ensureGroup = (key, name) => {
    if (!groups.has(key)) groups.set(key, { name, staffEntries: new Map(), pfiIds: new Set(), orders: [] });
    return groups.get(key);
  };

  for (const d of depots) {
    if (activePfis.some((p) => p.location_id === d.id)) {
      ensureGroup(depotKey(d), d.name.toUpperCase());
    }
  }

  for (const r of reports) {
    const depot = matchDepot(r.location);
    const key = depot ? depotKey(depot) : `text:${r.location}`;
    const name = depot ? depot.name.toUpperCase() : String(r.location || "UNKNOWN").toUpperCase();
    const group = ensureGroup(key, name);
    /**
     * Every sheet filed for this role, not just the last one.
     *
     * The unique index is on (report_type, report_date, location, pfi_number,
     * submitted_by), so one depot running three PFIs legitimately has three
     * sales sheets for the day — and two people can file the same role. This
     * used to `.set()` them into a single slot, so the second and third
     * submissions were dropped silently: the work was done, the row was in the
     * database, and the report simply did not mention it.
     */
    if (!group.staffEntries.has(r.report_type)) group.staffEntries.set(r.report_type, []);
    group.staffEntries.get(r.report_type).push(r);
  }

  for (const p of activePfis) {
    const depot = depots.find((d) => d.id === p.location_id);
    if (!depot) continue;
    ensureGroup(depotKey(depot), depot.name.toUpperCase()).pfiIds.add(p.id);
  }

  for (const o of ordersToday) {
    const depot = depots.find((d) => d.id === o.depot_id);
    const key = depot ? depotKey(depot) : `depot-orphan:${o.depot_id}`;
    const name = depot ? depot.name.toUpperCase() : "OTHER";
    const group = ensureGroup(key, name);
    group.orders.push(o);
    if (o.pfi_id) group.pfiIds.add(o.pfi_id);
  }

  const locations = [...groups.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((g) => {
      const staffEntries = ROLE_TAGS.map(({ type, label }) => {
        const filed = g.staffEntries.get(type) || [];
        return {
          role: label,
          type,
          entries: filed.map((r) => ({
            // Keyed by the API's own column names, so a role's column set can
            // be declared once (in the template) and read straight off the row.
            submittedBy: r.submitted_by_name || "",
            status: r.status || "",
            pfiNumber: r.pfi_number || "",
            productName: r.product_name || "",

            carriedOverLoading: num(r.carried_over_loading),
            openingStock: num(r.opening_stock),
            receivedStock: num(r.received_stock),
            litresSold: num(r.litres_sold),
            tankBalance: num(r.tank_balance),
            loadingLeftOver: num(r.loading_left_over),

            priceBands: normalisePriceBands(r.price_bands),
            avgPrice: num(r.avg_price),
            totalSalesAmount: num(r.total_sales_amount),
            amountPaid: num(r.amount_paid),
            differentials: num(r.differentials),

            truckCount: num(r.truck_count),
            // Nullable in the schema, and 0 is a real answer distinct from
            // "this role does not report it" — so the null is preserved.
            trucksEntered: r.trucks_entered === null ? null : num(r.trucks_entered),

            yesterdayDeficitPayment: num(r.yesterday_deficit_payment),
            yesterdaySurplusPayment: num(r.yesterday_surplus_payment),
            totalInflow: num(r.total_inflow),

            fundsReceived: r.funds_received === null ? null : num(r.funds_received),
            commissionDue: r.commission_due === null ? null : num(r.commission_due),
            commissionOutstanding:
              r.commission_outstanding === null ? null : num(r.commission_outstanding),
            fundsRemaining: r.funds_remaining === null ? null : num(r.funds_remaining),

            customerCount: r.customer_count === null ? null : num(r.customer_count),
            orderCount: r.order_count === null ? null : num(r.order_count),
            rates: r.rates || "",
            topCustomers: normaliseTopCustomers(r.top_customers),

            bankName: r.bank_name || "",
            accountNumber: r.account_number || "",
            remarks: r.remarks || "",
          })),
        };
      });

      const pfiStock = [...g.pfiIds]
        .map((pfiId) => {
          const pfi = activePfis.find((p) => p.id === pfiId);
          const t = tradingByPfi.get(pfiId) || {
            orderedQty: 0,
            orderedValue: 0,
            confirmedQty: 0,
            confirmedValue: 0,
            qtyAfterDay: 0,
          };

          /**
           * Opening and closing stock, walked BACK from the balance the rest of
           * the system shows rather than re-derived from the ledger.
           *
           * `starting - sold_qty_litres` is what every other screen calls the
           * balance, and that cached counter has drifted from the allocation
           * ledger on six live batches — so rebuilding the level from the
           * ledger would put a different number in this email than the
           * dashboard shows for the same batch, which is worse than the drift.
           *
           * Anchoring instead means today's closing figure IS the dashboard's
           * balance, exactly, and an older date is reconstructed by adding back
           * everything ordered after it. Opening is then closing plus the day's
           * own orders, so the row reads left to right without a subtraction
           * that fails to come out.
           */
          const balanceNow = pfi ? num(pfi.starting_qty_litres) - num(pfi.sold_qty_litres) : 0;
          const closingStock = balanceNow + t.qtyAfterDay;
          const openingStock = closingStock + t.orderedQty;

          return {
            pfiNumber: pfi?.pfi_number || `PFI #${pfiId}`,
            productName: pfi?.product_name || "",
            unit: pfi?.product_unit || "Litres",
            allocation: pfi ? num(pfi.starting_qty_litres) : 0,
            openingStock,
            closingStock,
            orderedQty: t.orderedQty,
            orderedValue: t.orderedValue,
            confirmedQty: t.confirmedQty,
            confirmedValue: t.confirmedValue,
            // Volume-weighted, not the average of the prices: a 500,000 L order
            // at ₦900 and a 1,000 L order at ₦1,200 average to ₦900, not ₦1,050.
            avgRate: t.orderedQty > 0 ? t.orderedValue / t.orderedQty : 0,
            totalRevenue: lifetimeRevenueByPfi.get(pfiId) || 0,
          };
        })
        // Every active batch at this depot is listed, quiet or not: a batch
        // that sold nothing today still has a stock level, and "nothing moved
        // here" is an answer the reader wants at a glance. Previously anything
        // without an order today was dropped entirely.
        .sort((a, b) => a.pfiNumber.localeCompare(b.pfiNumber));

      /**
       * The table is capped; the figures are not.
       *
       * Only the first ORDERS_PER_LOCATION rows are listed — a depot with two
       * hundred orders would otherwise push the message past the 102KB where
       * Gmail clips it, and a clipped report is worse than a capped one. The
       * cap used to be applied BEFORE the totals were taken, though, so a busy
       * depot reported exactly 60 orders and only those orders' litres and
       * value: on 2 September that understated the day by 30 orders. Count and
       * value now come from every order; only the listing is trimmed, and the
       * table says so when it has been.
       */
      const orderCount = g.orders.length;
      const orderLitres = g.orders.reduce((sum, o) => sum + num(o.quantity), 0);
      const orderValue = g.orders.reduce((sum, o) => sum + num(o.total_amount), 0);

      const orders = g.orders
        .slice(0, ORDERS_PER_LOCATION)
        .map((o) => ({
          reference: generateOrderReference(o.company_name, o.id),
          // The company, not the person who placed it. An order belongs to the
          // company being invoiced, and that is the name the desk reconciles a
          // transfer against — a report listing "Ada Obi" where the bank line
          // says "Rure Oil and Gas" is a name nobody can match. Falls back to
          // the customer's own name only when no company is on the order,
          // which is what an individual buyer looks like.
          customer: o.company_name || o.customer_name || "",
          product: o.product_name || "",
          quantity: num(o.quantity),
          rate: num(o.price),
          amount: num(o.total_amount),
          status: o.status,
        }));

      const stock = pfiStock.reduce(
        (acc, r) => {
          acc.opening += r.openingStock;
          acc.closing += r.closingStock;
          acc.orderedQty += r.orderedQty;
          acc.orderedValue += r.orderedValue;
          acc.confirmedQty += r.confirmedQty;
          acc.confirmedValue += r.confirmedValue;
          return acc;
        },
        { opening: 0, closing: 0, orderedQty: 0, orderedValue: 0, confirmedQty: 0, confirmedValue: 0 }
      );

      return { name: g.name, staffEntries, pfiStock, orders, orderCount, orderLitres, orderValue, stock };
    });

  const totals = locations.reduce(
    (acc, loc) => {
      acc.staffEntries += loc.staffEntries.reduce((n, s) => n + s.entries.length, 0);
      acc.orderCount += loc.orderCount;
      acc.qtyLitres += loc.orderLitres;
      acc.amountNaira += loc.orderValue;
      acc.openingStock += loc.stock.opening;
      acc.closingStock += loc.stock.closing;
      acc.confirmedQty += loc.stock.confirmedQty;
      acc.confirmedValue += loc.stock.confirmedValue;
      return acc;
    },
    {
      staffEntries: 0,
      orderCount: 0,
      qtyLitres: 0,
      amountNaira: 0,
      openingStock: 0,
      closingStock: 0,
      confirmedQty: 0,
      confirmedValue: 0,
    }
  );

  /**
   * The seven days before this one, so the summary can say whether today was a
   * good day rather than only what today was.
   *
   * `yesterday` is the immediately preceding day only if it actually traded —
   * a gap in the data must not be reported as "down 100%".
   */
  const history = priorDays.map((r) => ({
    date: typeof r.day === "string" ? r.day : localDateStr(new Date(r.day)),
    orderCount: num(r.order_count),
    qtyLitres: num(r.qty),
    amountNaira: num(r.value),
  }));

  return { reportDate: reportDateStr, totals, locations, history };
};

module.exports = { buildCombinedDailyReportData, createDepotMatcher, ROLE_TAGS, dayBounds, localDateStr, REPORT_TZ };
