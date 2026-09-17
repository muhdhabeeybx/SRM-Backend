// Nothing here queries anything — the template is a pure function of the data
// builder's output. dotenv only so the require chain can construct its client.
require("dotenv").config();

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { renderPfiDailyReportEmail } = require("../notifications/templates/pfiDailyReportEmail");

/**
 * What the SOROMAN Sales & Operations Report actually says.
 *
 * A rendering test, with no database, because every failure being pinned here
 * is a SILENT one: a column that renders a wrong unit, a zero that reads as
 * "unknown", a desk that filed nothing and leaves no trace. None of those
 * throw. None of them show up in a query. They show up in an inbox, once a
 * day, in front of the whole company.
 */

const pfi = (over = {}) => ({
  id: 1,
  pfiNumber: "PFI/46/26/MT BORA/WARRI/16KT",
  type: "coastal",
  location: "Keonamex Depot Warri",
  product: "Petrol",
  unit: "Liters",
  unitPrice: 1340,
  stock: { starting: 21739681, sold: 1899806, openingToday: 20557875, soldToday: 718000, remaining: 19839875, percentSold: 8.7 },
  orders: {
    today: { count: 4, litres: 718000, value: 962120000, paid: 500000000 },
    toDate: { count: 40, litres: 1899806, value: 2500000000, paid: 2093132650 },
    outstanding: 406867350,
  },
  movements: {
    enteredToday: 4, loadedToday: 4, exitedToday: 10,
    litresLoadedToday: 160000, litresOutToday: 310000, onSite: 0,
    trucksLoadedToDate: 42, litresLoadedToDate: 1436806,
    trucksToDate: 42, litresTicketedToDate: 1436806,
  },
  expenses: { today: { count: 1, amount: 500 }, toDate: { count: 9, amount: 666936121, paid: 15986121 } },
  commission: { entries: 12, due: 640000, paid: 936806, litres: 718000 },
  ...over,
});

/** The LPG batch, which is the whole reason units are carried per batch. */
const gasPfi = () =>
  pfi({
    id: 2,
    pfiNumber: "PFI/45/26/DANGOTE/LPG/160T/AUG",
    location: "Dangote Refinery",
    product: "Cooking Gas",
    unit: "kg",
    stock: { starting: 160000, sold: 159060, openingToday: 100940, soldToday: 100000, remaining: 940, percentSold: 99 },
    orders: {
      today: { count: 2, litres: 100000, value: 95000000, paid: 0 },
      toDate: { count: 20, litres: 159060, value: 151211500, paid: 151211500 },
      outstanding: 0,
    },
    movements: { ...pfi().movements, litresLoadedToday: 100000, litresLoadedToDate: 159060 },
  });

const data = (over = {}) => ({
  reportDate: "2026-09-16",
  summary: {
    activePfis: 1, activeBatches: 1, activeStations: 1,
    litresSold: 718000, salesValue: 962120000, fundsReceived: 500000000, balance: 406867350,
  },
  pfis: [pfi()],
  generalExpenses: [],
  truckSales: [],
  stations: [],
  staffReports: [],
  ...over,
});

const render = (over) => renderPfiDailyReportEmail(data(over));

describe("sales & operations report — the envelope", () => {
  test("the subject and the opening line are the ones the desk asked for", () => {
    const { subject, html, text } = render();
    assert.equal(subject, "SOROMAN Sales & Operations Report for 16th September 2026");
    assert.match(html, /Dear Sir,/);
    assert.match(
      html,
      /Please find below the summary of sales and operations across all locations for/
    );
    // The date is in the greeting, not only in the subject: a forwarded report
    // has to say which day it is without its envelope.
    assert.match(html, /16th September 2026/);
    // And the text part carries both, for the clients that render nothing else.
    assert.match(text, /^SOROMAN Sales & Operations Report for 16th September 2026/);
    assert.match(text, /Dear Sir,/);
  });

  test("no attachment is offered and none is referred to", () => {
    const rendered = render();
    assert.equal(rendered.attachments, undefined);
    assert.doesNotMatch(rendered.html, /\.xlsx|attach|workbook|spreadsheet/i);
  });
});

describe("sales & operations report — units belong to the batch", () => {
  test("a gas batch is reported in kilograms, not litres", () => {
    const { html } = render({ pfis: [gasPfi()] });
    assert.match(html, /160,000 Kg/, "the initial stock of an LPG batch is kilograms");
    assert.match(html, /100,000 Kg/, "and so is what it sold today");
    assert.doesNotMatch(html, /160,000 Litres/, "nothing about a gas batch is measured in litres");
  });

  test("a fuel batch and a gas batch in the same table keep their own units", () => {
    const { html } = render({ pfis: [pfi(), gasPfi()] });
    assert.match(html, /21,739,681 Litres/);
    assert.match(html, /160,000 Kg/);
  });
});

describe("sales & operations report — depot sales", () => {
  test("the row reads initial, opening, sold, closing — and reconciles", () => {
    const { html } = render();
    for (const label of [
      "INITIAL STOCK", "OPENING STOCK TODAY", "TOTAL SOLD TODAY",
      "CLOSING STOCK TODAY", "SALES VALUE TODAY", "TOTAL PFI REVENUE",
    ]) {
      assert.ok(html.includes(label), `${label} is missing from DEPOT SALES`);
    }
    const p = pfi();
    assert.equal(
      p.stock.openingToday - p.stock.soldToday,
      p.stock.remaining,
      "the fixture itself must reconcile, or the test proves nothing"
    );
  });

  test("location is on every row, so a reader need not know the PFI numbers", () => {
    const { html } = render();
    assert.match(html, /KEONAMEX DEPOT WARRI/);
  });
});

describe("sales & operations report — loading and exit gate", () => {
  test("the section is named for both events it reports", () => {
    const { html } = render();
    assert.match(html, /LOADING AND EXIT GATE REPORT/);
  });

  test("the volume columns come from loading, not from the barrier", () => {
    // 160,000 loaded today against 310,000 out of the gate today: a truck that
    // loaded yesterday and left this morning belongs to yesterday's loading.
    // Reporting the exit figure under "litres loaded today" would move it.
    const { html } = render();
    const gate = html.slice(html.indexOf("LOADING AND EXIT GATE REPORT"), html.indexOf("EXPENSES"));
    assert.match(gate, /160,000 Litres/, "litres loaded today is the gantry figure");
    assert.doesNotMatch(gate, /310,000/, "the exit-gate volume is not reported as loaded");
  });
});

describe("sales & operations report — expenses", () => {
  test("requested, paid, and the gap between them", () => {
    const { html } = render({
      generalExpenses: [
        { category: "Audit Fees", today: { count: 0, amount: 0 }, toDate: { count: 3, amount: 19359250, paid: 19359250 } },
      ],
    });
    assert.match(html, /TOTAL AMOUNT REQUESTED/);
    assert.match(html, /TOTAL AMOUNT PAID/);
    assert.match(html, /AMOUNT NOT YET PAID/);
    // 666,936,121 billed less 15,986,121 paid.
    assert.match(html, /₦650,950,000/, "the unpaid balance is worked out, not left to the reader");
    assert.match(html, /GENERAL — AUDIT FEES/, "expenses outside any batch are money out too");
  });

  test("what is still owed is red and what has been settled is green", () => {
    const { html } = render();
    const row = html.slice(html.indexOf("₦666,936,121"), html.indexOf("₦650,950,000") + 40);
    assert.ok(row.includes("#15803D"), "the paid figure carries the credit colour");
    assert.ok(row.includes("#B91C1C"), "the outstanding figure carries the balance colour");
  });
});

describe("sales & operations report — truck sales", () => {
  const batch = (over = {}) => ({
    code: "PFI-14B", customers: 10,
    trucksAllocated: 62, trucksSoldToday: 0, trucksSold: 28, unsoldTrucks: 34,
    salesValue: 1836911300, salesValueToday: 0,
    fundsReceived: 1480395100, fundsReceivedToday: 0,
    expenses: 0, balance: 356516200,
    ...over,
  });

  test("the batch code reads as a PFI", () => {
    const { html } = render({ truckSales: [batch()] });
    assert.match(html, /PFI 14B/);
  });

  test("every truck is accounted for: allocated, sold, unsold", () => {
    const { html } = render({ truckSales: [batch()] });
    const section = html.slice(html.indexOf("TRUCK SALES"));
    assert.match(section, /TRUCKS ALLOCATED/);
    assert.match(section, /UNSOLD TRUCKS/);
    assert.match(section, /BALANCE TO BE PAID/);
  });

  test("none left to sell prints 0; not knowing prints N/A", () => {
    const { html } = render({
      truckSales: [batch({ code: "PFI-25C", unsoldTrucks: 0 }), batch({ code: "PFI-99Z", trucksAllocated: 0, unsoldTrucks: null })],
    });
    const section = html.slice(html.indexOf("TRUCK SALES"));
    // A zero here is the best news on the row. An em-dash would put it beside
    // the N/A that means "we never recorded an allocation" and make the two
    // indistinguishable — which is the whole failure this pins.
    assert.match(section, />0</, "a fully sold batch says 0");
    assert.match(section, /N\/A/, "a batch with no allocation on record says so");
  });
});

describe("sales & operations report — filling stations, grouped by PFI", () => {
  const station = (over = {}) => ({
    code: "PFI-14B", party: "Dambam Filling Station", customerType: "filling_station",
    allocatedLitres: 50000, openingLitresToday: 21000, litresToday: 0, litres: 29000,
    remainingLitres: 21000, stockKnown: true,
    salesValueToday: 0, fundsReceived: 26155000, balance: 0,
    ...over,
  });

  test("each PFI gets its own heading and its own column row", () => {
    const { html } = render({
      stations: [station(), station({ code: "PFI-40B", party: "Kano Filling Station" })],
    });
    const section = html.slice(html.indexOf("FILLING STATIONS"));
    assert.match(section, /PFI 14B/);
    assert.match(section, /PFI 40B/);
    // The header row repeats under each PFI — that is the layout, not a bug:
    // a station appears under several batches and the reader scans one batch
    // at a time.
    assert.equal(
      section.split("INITIAL STOCK").length - 1,
      2,
      "one column row per PFI group"
    );
  });

  test("a station that outsold its allocation reports no stock rather than a negative", () => {
    const { html } = render({
      stations: [station({ party: "Kano Filling Station", allocatedLitres: 45000, litres: 90038, remainingLitres: -45038, openingLitresToday: -45038, stockKnown: false })],
    });
    assert.doesNotMatch(html, /-45,038/, "a negative stock figure is never printed");
    assert.match(html, /N\/A/);
  });
});

describe("sales & operations report — staff reports", () => {
  const reports = (over = []) => [
    {
      type: "security_gate",
      label: "Security Gate",
      filed: 1,
      rows: [
        {
          reported: true, role: "security_gate", pfiNumber: "PFI/46/26/MT BORA/WARRI/16KT",
          location: "Keonamex Depot Warri", submittedBy: "Abubakar Aliyu", unit: "Liters",
          trucksEntered: 14, truckCount: 16, remarks: "2 leftover trucks from yesterday.",
        },
        { reported: false, role: "security_gate", pfiNumber: "PFI/42/26/LPG/160MT/AUG", location: "Dangote Refinery", unit: "kg" },
      ],
    },
    ...over,
  ];

  test("each desk is named and each row names the person who filed", () => {
    const { html } = render({ staffReports: reports() });
    assert.match(html, /STAFF REPORTS/);
    assert.match(html, /SECURITY GATE/);
    assert.match(html, /STAFF NAME/);
    assert.match(html, /Abubakar Aliyu/);
  });

  test("a desk reports under its own headings, not a generic twelve", () => {
    const { html } = render({ staffReports: reports() });
    // trucksEntered is the half of the gate's job that a shared column set had
    // no column for at all.
    assert.match(html, /TRUCKS ENTERED/);
    assert.match(html, /TRUCKS EXITED/);
    assert.match(html, />14</);
    assert.match(html, />16</);
  });

  test("a PFI nobody filed for says so instead of being absent", () => {
    const { html } = render({ staffReports: reports() });
    assert.match(html, /Not reported/);
    assert.match(html, /PFI\/42\/26\/LPG\/160MT\/AUG/);
  });

  test("a desk that filed nothing all day still appears, and says so", () => {
    const { html } = render({
      staffReports: [
        {
          type: "commissions", label: "Commissions", filed: 0,
          rows: [{ reported: false, role: "commissions", pfiNumber: "PFI/46/26/MT BORA/WARRI/16KT", location: "Keonamex Depot Warri", unit: "Liters" }],
        },
      ],
    });
    assert.match(html, /COMMISSIONS/);
    assert.match(html, /nothing filed today/);
  });
});

describe("sales & operations report — it has to arrive whole", () => {
  test("the markup is balanced, so no section nests inside the last one", () => {
    const { html } = render({
      pfis: [pfi(), gasPfi()],
      truckSales: [{ code: "PFI-14B", customers: 1, trucksAllocated: 4, trucksSoldToday: 0, trucksSold: 4, unsoldTrucks: 0, salesValue: 1, salesValueToday: 0, fundsReceived: 1, fundsReceivedToday: 0, expenses: 0, balance: 0 }],
      stations: [{ code: "PFI-14B", party: "Dambam Filling Station", customerType: "filling_station", allocatedLitres: 1, openingLitresToday: 1, litresToday: 0, litres: 0, remainingLitres: 1, stockKnown: true, salesValueToday: 0, fundsReceived: 0, balance: 0 }],
      staffReports: [{ type: "commissions", label: "Commissions", filed: 0, rows: [] }],
    });
    const opens = (html.match(/<div\b/g) || []).length;
    const closes = (html.match(/<\/div>/g) || []).length;
    assert.equal(opens, closes, "an unclosed div makes every later section indent one level deeper");
  });

  test("an empty section closes itself rather than swallowing the rest", () => {
    // No PFIs at all — DEPOT SALES has a heading and nothing to put under it.
    const { html } = render({ pfis: [] });
    assert.match(html, /Nothing to report/);
    assert.equal((html.match(/<div\b/g) || []).length, (html.match(/<\/div>/g) || []).length);
  });

  test("it stays well clear of the size at which Gmail clips a message", () => {
    // Gmail cuts at ~102KB and the cut lands mid-table. This fixture is small,
    // so this only pins the floor — the real check is the KB figure the dry
    // run prints — but it catches a template that starts emitting per-cell CSS
    // again, which is what put the first version at 90KB.
    const { html } = render();
    assert.ok(html.length < 40 * 1024, `${Math.round(html.length / 1024)}KB for one PFI is too much`);
  });
});

/**
 * The batch roll-up, on its own.
 *
 * `rollUpTruckSales` is exported from the service precisely so these three
 * rules can be pinned without a database. Each of them was got wrong once, and
 * none of them throws when it is — they print a number that is quietly not the
 * number, which is the only kind of bug a daily report actually has.
 */
const { rollUpTruckSales } = require("../services/pfiDailyReport.service");

describe("truck sales — rolling a batch up from its customers", () => {
  const row = (over = {}) => ({
    code: "PFI-14B", party: "A Customer", customerType: "customer",
    loads: 0, loadsToday: 0, litres: 0, litresToday: 0,
    salesValue: 0, salesValueToday: 0, fundsReceived: 0, fundsReceivedToday: 0,
    expenses: 0, trucksAllocated: 0, balance: 0,
    ...over,
  });

  test("a settled customer still counts towards the batch's totals", () => {
    const owing = row({ party: "Owes", trucksAllocated: 10, loads: 4, salesValue: 100, fundsReceived: 60, balance: 40 });
    const settled = row({ party: "Settled", trucksAllocated: 6, loads: 6, salesValue: 50, fundsReceived: 50, balance: 0 });
    // Only the first is live; the second finished paying and stopped trading.
    const [b] = rollUpTruckSales([owing, settled], [owing]);
    assert.equal(b.trucksAllocated, 16, "dropping the settled customer understates the allocation");
    assert.equal(b.trucksSold, 10);
    assert.equal(b.salesValue, 150);
    assert.equal(b.unsoldTrucks, 6);
  });

  test("one customer's overpayment never cancels another's debt", () => {
    // 100 billed / 60 paid = 40 owed. 50 billed / 90 paid = overpaid, clamped
    // to 0 by the caller. The batch owes 40, not 40 - 40 = 0: a difference of
    // totals would net them and the headline would stop matching the column.
    const owes = row({ party: "Owes", salesValue: 100, fundsReceived: 60, balance: 40 });
    const over = row({ party: "Overpaid", salesValue: 50, fundsReceived: 90, balance: 0 });
    const [b] = rollUpTruckSales([owes, over], [owes]);
    assert.equal(b.balance, 40);
    assert.notEqual(b.balance, b.salesValue - b.fundsReceived, "the difference of totals is the wrong number here");
  });

  test("the batch balances sum to what the headline claims is outstanding", () => {
    const rows = [
      row({ code: "PFI-14B", party: "A", salesValue: 100, fundsReceived: 60, balance: 40 }),
      row({ code: "PFI-14B", party: "B", salesValue: 50, fundsReceived: 90, balance: 0 }),
      row({ code: "PFI-19B", party: "C", salesValue: 80, fundsReceived: 5, balance: 75 }),
    ];
    const live = rows.filter((r) => r.balance > 0);
    const batches = rollUpTruckSales(rows, live);
    // This is exactly the reconciliation the summary band promises: the number
    // at the top is the column underneath it, added up.
    assert.equal(
      batches.reduce((a, b) => a + b.balance, 0),
      rows.reduce((a, r) => a + r.balance, 0)
    );
  });

  test("more sales than allocations means none left, not a negative", () => {
    const r = row({ trucksAllocated: 57, loads: 63, balance: 1 });
    const [b] = rollUpTruckSales([r], [r]);
    assert.equal(b.unsoldTrucks, 0);
  });

  test("no allocation on record is unknown, not zero", () => {
    const r = row({ code: "PFI 14B - A1", trucksAllocated: 0, loads: 43, balance: 1 });
    const [b] = rollUpTruckSales([r], [r]);
    assert.equal(b.unsoldTrucks, null, "a confident 0 here would read as 'all sold'");
  });

  test("a batch with nothing live on it is not listed, and nor is (unassigned)", () => {
    const dormant = row({ code: "PFI-99Z", salesValue: 10, fundsReceived: 10, balance: 0 });
    const orphan = row({ code: "(unassigned)", salesValue: 10, balance: 10 });
    assert.deepEqual(rollUpTruckSales([dormant, orphan], [orphan]), []);
  });

  test("filling stations are reported elsewhere and never roll into a batch", () => {
    const st = row({ party: "Kano Filling Station", customerType: "filling_station", salesValue: 999, balance: 999 });
    const truck = row({ party: "A Customer", salesValue: 1, balance: 1 });
    const [b] = rollUpTruckSales([st, truck], [st, truck]);
    assert.equal(b.salesValue, 1);
    assert.equal(b.customers, 1);
  });
});
