const { client } = require("../config/db");
const { isStationType } = require("./customerTypes");

/**
 * Which book a delivery_sales row is written into — migration 0070.
 *
 *   trucking  the truck sale: who took the load, at what rate, what they paid.
 *             Every customer is on it, a filling station or LPG plant
 *             included — a station is charged for its share like anyone else.
 *   station   a station's or plant's own trade: what it sold at the pump, what
 *             it spent, what it banked.
 *
 * The sales ledger, the delivery inventory, PFI Tracking and the PFI report
 * read the trucking book. The station pages read the station book for the
 * station's days, and the trucking book only to see what it was charged.
 *
 * ── Asked, then derived ───────────────────────────────────────────────────
 *
 * The screens say which book they write: the sales ledger writes the truck
 * sale, the day sheet writes the station's. A row that does not say is placed
 * by the rule the backfill used, so a client that predates the column keeps
 * writing where it always meant to — a station's row carrying money is its
 * own trade, and anything else is the truck sale.
 */

const BOOKS = ["trucking", "station"];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Does this row carry a station's own trade, read the way migration 0070 read it? */
const carriesStationTrade = (row) =>
  num(row?.salesValue ?? row?.sales_value) !== 0
  || num(row?.paymentAmount ?? row?.payment_amount) !== 0
  || num(row?.expensesAmount ?? row?.expenses_amount) !== 0
  || (row?.buyerClass ?? row?.buyer_class) != null
  || !String(row?.truckNumber ?? row?.truck_number ?? "").trim();

/** The book for one row, given its customer's type. Pure. */
const bookOf = (row, customerType) => {
  if (BOOKS.includes(row?.book)) return row.book;
  return isStationType(customerType) && carriesStationTrade(row) ? "station" : "trucking";
};

const customerIdOf = (row) => {
  const v = row?.customerId ?? row?.customer_id;
  return v == null || v === "" ? null : Number(v);
};

/** Customer types by id, for the rows that need one. */
const customerTypes = async (rows) => {
  const ids = [...new Set(
    rows.filter((r) => !BOOKS.includes(r?.book)).map(customerIdOf).filter(Number.isFinite),
  )];
  if (!ids.length) return new Map();
  const found = await client`
    SELECT id, customer_type::text AS type FROM delivery_customers WHERE id = ANY(${ids}::int[])`;
  return new Map(found.map((c) => [Number(c.id), c.type]));
};

/** The rows, each carrying the book it belongs in. */
const withBooks = async (rows) => {
  const types = await customerTypes(rows);
  return rows.map((row) => ({ ...row, book: bookOf(row, types.get(customerIdOf(row))) }));
};

module.exports = { BOOKS, bookOf, carriesStationTrade, withBooks };
