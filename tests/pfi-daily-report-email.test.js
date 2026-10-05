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
  expenses: {
    today: { count: 1, requested: 2400000, paid: 0 },
    toDate: { count: 9, requested: 666936121, paid: 15986121 },
  },
  commission: {
    entries: 12, litres: 718000,
    today: { entries: 1, due: 105000, paid: 105000 },
    due: 245000, paid: 1331806,
  },
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
  expenseLines: [],
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

  test("no headline figures stand between the greeting and the first table", () => {
    // The band that used to sit here led with a volume total that added litres
    // of petrol to kilograms of gas. A summary whose first figure is wrong
    // teaches the reader to distrust the tables underneath, which are right.
    const { html, text } = render({ pfis: [pfi(), gasPfi()] });
    const intro = html.slice(0, html.indexOf("DEPOT SALES"));
    assert.doesNotMatch(intro, /₦/, "no money figure before the first table");
    assert.doesNotMatch(intro, /TOTAL VOLUME SOLD|OUTSTANDING BALANCE|AMOUNT RECEIVED TODAY/);
    assert.doesNotMatch(text, /Total sold today|Outstanding balance/);
  });

  test("no attachment is offered and none is referred to", () => {
    const rendered = render();
    assert.equal(rendered.attachments, undefined);
    assert.doesNotMatch(rendered.html, /\.xlsx|attach|workbook|spreadsheet/i);
  });
});

describe("sales & operations report — the sender's note", () => {
  test("a covering note is printed above the report, attributed and escaped", () => {
    const { html, text } = render({ note: "Warri <late> today.\nFigures confirmed.", noteFrom: "Habeeb Suleiman" });
    assert.match(html, /Note from Habeeb Suleiman/);
    assert.match(html, /Warri &lt;late&gt; today\.<br>Figures confirmed\./);
    assert.ok(html.indexOf("Note from") < html.indexOf("DEPOT SALES"), "the note comes before the tables");
    assert.match(text, /Note from Habeeb Suleiman: Warri <late> today/);
  });

  test("no note, no box", () => {
    assert.doesNotMatch(render().html, /Note from/);
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
  const line = (over = {}) => ({
    label: "PFI/46/26/MT BORA/WARRI/16KT",
    today: { count: 1, requested: 2400000, paid: 0 },
    toDate: { count: 9, requested: 666936121, paid: 15986121 },
    ...over,
  });

  test("the day leads, and the running totals follow it", () => {
    const { html } = render({ expenseLines: [line()] });
    const cols = ["REQUESTED TODAY", "PAID TODAY", "TOTAL REQUESTED", "TOTAL PAID", "NOT YET PAID"];
    for (const c of cols) assert.ok(html.includes(c), `${c} is missing from EXPENSES`);
    // Today's figures come first in the row, not after two cumulative ones.
    assert.ok(
      html.indexOf("REQUESTED TODAY") < html.indexOf("TOTAL REQUESTED"),
      "a reader scanning left to right must meet the day before the total"
    );
    assert.match(html, /₦2,400,000/, "what was raised today");
    // 666,936,121 billed less 15,986,121 paid.
    assert.match(html, /₦650,950,000/, "the unpaid balance is worked out, not left to the reader");
  });

  test("expenses outside any batch are money out too", () => {
    const { html } = render({
      expenseLines: [line({ label: "General — Audit Fees" })],
    });
    assert.match(html, /GENERAL — AUDIT FEES/);
  });

  test("what is still owed is red and what has been settled is green", () => {
    const { html } = render({ expenseLines: [line()] });
    const row = html.slice(html.indexOf("₦666,936,121"), html.indexOf("₦650,950,000") + 40);
    assert.ok(row.includes("#15803D"), "the paid figure carries the credit colour");
    assert.ok(row.includes("#B91C1C"), "the outstanding figure carries the balance colour");
  });

  test("a quiet day has no expenses section at all", () => {
    // The service filters `expenseLines` to today's movement, so an empty list
    // is exactly what a day with no expense activity produces. It must not
    // leave a heading with nothing under it.
    const { html } = render({ expenseLines: [] });
    assert.doesNotMatch(html, /REQUESTED TODAY/);
    assert.equal((html.match(/<div\b/g) || []).length, (html.match(/<\/div>/g) || []).length);
  });
});

describe("sales & operations report — commissions", () => {
  test("today's commission leads, and the arrears are labelled as totals", () => {
    const { html } = render();
    for (const c of ["COMMISSION DUE TODAY", "COMMISSION PAID TODAY", "TOTAL STILL DUE", "TOTAL PAID"]) {
      assert.ok(html.includes(c), `${c} is missing from COMMISSIONS`);
    }
    assert.ok(
      html.indexOf("COMMISSION DUE TODAY") < html.indexOf("TOTAL STILL DUE"),
      "the day comes before the arrears"
    );
    assert.match(html, /₦105,000/, "earned today");
    assert.match(html, /₦245,000/, "still owed in total");
  });

  test("a batch carrying only old arrears is not today's news", () => {
    // Nothing sold, nothing earned, nothing settled — but ₦21m of accumulated
    // arrears. Under the old to-date column this batch reported ₦21m
    // "commission due" on a day it earned nobody anything.
    const quiet = pfi({
      orders: { today: { count: 0, litres: 0, value: 0, paid: 0 }, toDate: pfi().orders.toDate, outstanding: 0 },
      commission: { entries: 4, litres: 0, today: { entries: 0, due: 0, paid: 0 }, due: 21718032, paid: 0 },
    });
    const { html } = render({ pfis: [quiet] });
    assert.doesNotMatch(html, /₦21,718,032/);
    assert.doesNotMatch(html, /COMMISSION DUE TODAY/, "no line moved, so there is no table");
  });
});

describe("sales & operations report — truck sales", () => {
  const batch = (over = {}) => ({
    code: "PFI-36C", unit: "Liters",
    trucks: 51, volume: 2525000, soldTrucks: 51, soldQty: 2525000,
    unsoldTrucks: 0, unsoldQty: 0, otherTrucks: 0, otherQty: 0,
    salesValue: 3192604270, paid: 3191970802, unpaid: 790583, overpaid: 0,
    ...over,
  });

  test("a batch reads with the labels its PFI Tracking card uses", () => {
    const { html } = render({ truckSales: [batch()] });
    const section = html.slice(html.indexOf("TRUCK SALES"));
    for (const label of ["TRUCKS ALLOCATED", "VOLUME LOADED", "TRUCKS SOLD", "TRUCKS UNSOLD", "SALES VALUE", "AMOUNT PAID", "AMOUNT UNPAID"]) {
      assert.ok(section.includes(label), `${label} is missing`);
    }
    assert.match(section, /PFI 36C/);
    assert.match(section, /2,525,000 Litres/);
    assert.match(section, /₦790,583/);
  });

  test("an empty-truck column appears only when a batch has one", () => {
    assert.doesNotMatch(render({ truckSales: [batch()] }).html, /TRUCKS EMPTY/);
    assert.match(render({ truckSales: [batch({ otherTrucks: 2 })] }).html, /TRUCKS EMPTY/);
  });

  test("no closed-batch line is printed under the table", () => {
    const { html } = render({ truckSales: [batch()] });
    assert.doesNotMatch(html, /Closed PFIs/);
  });
});

describe("sales & operations report — stations, grouped by station", () => {
  const station = (over = {}) => ({
    stationId: "7", code: "PFI-36C", party: "Ningi Filling Station", customerType: "filling_station", unit: "Liters",
    received: 17000, soldToday: 0, sold: 17000, stockLeft: 0,
    salesValueToday: 0, salesValue: 22173643, banked: 22132208, bankedToday: 0, spent: 0, balance: 41435,
    ...over,
  });

  test("a station leads, and every PFI it holds stock from sits under it", () => {
    const { html } = render({
      stations: [station(), station({ code: "PFI-41B", received: 16000, sold: 0, stockLeft: 16000, salesValue: 0, banked: 0, balance: 0 })],
    });
    const section = html.slice(html.indexOf("FILLING STATIONS"));
    assert.equal(section.split("NINGI FILLING STATION").length - 1, 1, "the name is written once");
    assert.match(section, /rowspan="2"/);
    assert.match(section, /PFI 36C/);
    assert.match(section, /PFI 41B/);
    for (const label of ["RECEIVED", "SOLD TODAY", "TOTAL SOLD", "STOCK LEFT", "AMOUNT BANKED", "BALANCE"]) {
      assert.ok(section.includes(label), `${label} is missing`);
    }
    assert.match(section, /16,000 Litres/);
    assert.match(section, /₦41,435/);
  });

  test("an LPG station has its own section, in the same layout, in kilograms", () => {
    const { html } = render({
      stations: [station(), station({ stationId: "9", party: "Kano LPG Plant", customerType: "lpg_plant", unit: "kg", received: 20000, stockLeft: 5000 })],
    });
    assert.match(html, /LPG STATIONS/);
    const lpg = html.slice(html.indexOf("LPG STATIONS"));
    assert.match(lpg, /KANO LPG PLANT/);
    assert.match(lpg, /20,000 Kg/, "gas is sold by the kilogram");
    assert.doesNotMatch(lpg, /NINGI/);
  });

  test("no LPG station, no LPG section", () => {
    assert.doesNotMatch(render({ stations: [station()] }).html, /LPG STATIONS/);
  });
});

describe("sales & operations report — expense status", () => {
  const line = (items) => ({
    label: "PFI 47B",
    today: { count: 1, requested: 300000, paid: 0 },
    toDate: { count: 2, requested: 1550000, paid: 1250000 },
    items,
  });

  test("each request says where it is in the approval chain", () => {
    const { html } = render({
      expenseLines: [line([
        { reference: "EXP-2026-000414", amount: 300000, status: "audit_approved", statusLabel: "Awaiting final approval" },
        { reference: "EXP-2026-000415", amount: 50000, status: "paid", statusLabel: "Paid" },
      ])],
    });
    assert.match(html, />STATUS</);
    assert.match(html, /₦300,000 &middot; Awaiting final approval/);
    // Paid is money out, and reads in the credit colour like every other.
    assert.match(html, /₦50,000 &middot; <span style="color:#15803D[^"]*">Paid<\/span>/);
  });

  test("a line with no request behind it says so with a dash", () => {
    const { html } = render({ expenseLines: [line([])] });
    const row = html.slice(html.indexOf("PFI 47B"));
    assert.ok(row.includes("—"));
  });
});

describe("sales & operations report — no totals row", () => {
  test("a table ends on its last line, with no TOTAL row under it", () => {
    const { html } = render({ pfis: [pfi(), pfi({ id: 3, pfiNumber: "PFI/47/26/MT LESTE/CALABAR/17KT" })] });
    assert.doesNotMatch(html, /<strong>TOTAL<\/strong>/);
  });
});

/**
 * The batch arithmetic, on its own — the rules the dashboard's PFI Tracking
 * applies, which lib/deliveryBatches.js ports. Each one is a way the old count
 * printed a number that was quietly not the number.
 */
const { summariseBatches } = require("../lib/deliveryBatches");

describe("truck sales — a batch summed the way PFI Tracking sums it", () => {
  const customers = [
    { id: 1, customerType: "customer" },
    { id: 2, customerType: "filling_station" },
    { id: 3, customerType: "customer" },
  ];
  const entry = (id, over = {}) => ({
    id, allocationCode: "PFI-99Z", truckNumber: `TRK ${id}`, dateAllocated: "2026-09-01",
    quantityAllocated: "45000", loadingStatus: "loaded", customerId: 1, rate: "0", ...over,
  });
  const sale = (id, truck, over = {}) => ({
    id, truckNumber: truck, dateLoaded: "2026-09-01", allocationCode: "PFI-99Z",
    customerId: 1, quantity: "45000", rate: "1300", salesValue: "58500000", paymentAmount: "0", ...over,
  });
  const run = (entries, sales) => summariseBatches({ entries, sales, customers }).get("PFI-99Z");

  test("a truck carrying a rate or a payment is sold, whatever its status says", () => {
    const b = run([entry(1), entry(2)], [sale(10, "TRK 1")]);
    assert.equal(b.trucks, 2);
    assert.equal(b.soldTrucks, 1);
    assert.equal(b.unsoldTrucks, 1);
  });

  test("a load to a filling station is sold on assignment", () => {
    const b = run([entry(1, { customerId: 2 })], []);
    assert.equal(b.soldTrucks, 1);
  });

  test("a load paid in three instalments is billed once", () => {
    const b = run([entry(1)], [
      sale(10, "TRK 1", { paymentAmount: "20000000" }),
      sale(11, "TRK 1", { paymentAmount: "20000000" }),
      sale(12, "TRK 1", { paymentAmount: "10000000" }),
    ]);
    assert.equal(b.salesValue, 58500000, "the repeated value is the load's, not three loads'");
    assert.equal(b.paid, 50000000);
    assert.equal(b.unpaid, 8500000);
  });

  test("a station is billed its charge, never its pump sales or deposits", () => {
    const b = run([entry(1, { customerId: 2 })], [
      sale(10, "TRK 1", { customerId: 2, book: "trucking", quantity: "30000", rate: "1100", salesValue: "33000000" }),
      sale(11, "TRK 1", { customerId: 2, book: "trucking", quantity: "0", rate: "0", salesValue: "0", paymentAmount: "33000000", paymentMethod: "station_account" }),
      sale(12, "TRK 1", { customerId: 2, book: "station", quantity: "10000", rate: "1300", salesValue: "13000000" }),
      sale(13, "TRK 1", { customerId: 2, book: "station", quantity: "15000", rate: "1300", salesValue: "19500000" }),
      sale(14, "TRK 1", { customerId: 2, book: "station", quantity: "0", rate: "0", salesValue: "0", paymentAmount: "30000000" }),
    ]);
    assert.equal(b.salesValue, 33000000);
    assert.equal(b.paid, 33000000);
    assert.equal(b.unpaid, 0);
  });

  test("one buyer's overpayment never cancels another's debt", () => {
    const b = run([entry(1), entry(2, { customerId: 3 })], [
      sale(10, "TRK 1", { paymentAmount: "60000000" }),
      sale(11, "TRK 2", { customerId: 3, paymentAmount: "50000000" }),
    ]);
    assert.equal(b.unpaid, 8500000);
    assert.equal(b.overpaid, 1500000);
  });

  test("sales are matched to their own truck and day, not to another trip", () => {
    const b = run([entry(1), entry(2, { truckNumber: "TRK 1", dateAllocated: "2026-09-05" })], [sale(10, "TRK1")]);
    assert.equal(b.soldTrucks, 1, "the plate matches with or without its spaces, on the one date");
    assert.equal(b.unsoldTrucks, 1);
  });
});

/**
 * How it holds up on a phone.
 *
 * The rule the whole approach rests on: the <style> block is an improvement,
 * never a requirement. Gmail strips @import, Outlook ignores @font-face, and
 * several clients drop embedded <style> entirely — so the document has to be
 * correct with that block deleted, and these tests delete it to check.
 */
describe("sales & operations report — on a narrow screen", () => {
  const full = () =>
    render({
      pfis: [pfi(), gasPfi()],
      expenseLines: [{
        label: "PFI/46/26/MT BORA/WARRI/16KT",
        today: { count: 1, requested: 2400000, paid: 0 },
        toDate: { count: 9, requested: 666936121, paid: 15986121 },
      }],
    });

  test("the document shrinks to the screen rather than forcing it wide", () => {
    const { html } = full();
    // `max-width`, not `width`. A pinned 1100px document makes a phone zoom out
    // to fit it and renders every figure at about four pixels.
    assert.match(html, /max-width:1100px/);
    assert.doesNotMatch(html, /[^-]width:\s*1100px/);
  });

  test("every data table scrolls inside its own wrapper", () => {
    const body = full().html.split("</style>")[1];
    const wrappers = (body.match(/overflow-x:auto/g) || []).length;
    const tables = (body.match(/<table[^>]*border="1"/g) || []).length;
    assert.equal(wrappers, tables, "a table that cannot scroll will be cut off, not shrunk");
    assert.ok(tables > 0);
  });

  test("figures never break across two lines mid-number", () => {
    // "₦1,220,979,873" wrapping after "₦1,220" is the single worst thing that
    // happens to this report on a narrow screen. Right-aligned cells are
    // exactly the numeric ones, so the rule needs no markup of its own.
    assert.match(full().html, /td\[align=right\][^}]*white-space:nowrap/);
  });

  test("the report is still correct with the style block deleted", () => {
    const stripped = full().html.replace(/<style>[\s\S]*?<\/style>/, "");
    // Nothing structural may live only in CSS: the font, the palette, the
    // section bars and the cell tints are all inline and survive the cut.
    assert.match(stripped, /font-family:'Satoshi'/);
    assert.match(stripped, /background:#1a1a1a|bgcolor="#1a1a1a"/);
    assert.match(stripped, /#15803D/, "the credit colour is inline");
    assert.match(stripped, /overflow-x:auto/, "the scroll wrapper is inline");
    assert.match(stripped, /DEPOT SALES/);
  });

  test("the narrow-screen rules touch data cells, not the section headings", () => {
    const { html } = full();
    const mq = html.slice(html.indexOf("@media"), html.indexOf("</style>"));
    // A bare `td,th` also catches the section bars, which are single-cell
    // tables — shrinking a heading to 11px turns the one piece of structure the
    // report has into another line of small text.
    assert.match(mq, /table\[border="1"\] td/);
    assert.doesNotMatch(mq, /(^|[;{])\s*td\s*,/);
  });
});
