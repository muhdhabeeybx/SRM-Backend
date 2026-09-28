/**
 * The kinds of delivery customer, in one place.
 *
 * `delivery_customers.customer_type` decides which route a customer's trade
 * takes. A plain customer buys a truck's load outright at a rate. A station
 * takes a load on consignment, sells it down over days and banks the money —
 * and is read as a running account rather than as a row of sales.
 *
 * There are two kinds of station, and they follow the same route:
 *
 *   filling_station  sells fuel, measured in litres
 *   lpg_plant        sells gas, measured in kilograms (migration 0061)
 *
 * Anything that asks "does this customer trade like a station" asks
 * isStationType. Anything that asks "is this a FUEL station" — the filling
 * station register, a label — still compares to 'filling_station' itself.
 *
 * The database enum carries more values than these (third_party, bulk, …),
 * left over from before the dashboard; nothing writes them and the API does
 * not accept them.
 */

const CUSTOMER_TYPES = ["customer", "filling_station", "lpg_plant"];

const STATION_TYPES = ["filling_station", "lpg_plant"];

const isStationType = (type) => STATION_TYPES.includes(type);

/** What a success message or an error calls one of each. */
const TYPE_LABEL = {
  customer: "Customer",
  filling_station: "Filling Station",
  lpg_plant: "LPG Plant",
};

/** The prefix of a generated customer code. */
const CODE_PREFIX = {
  customer: "CUST",
  filling_station: "STN",
  lpg_plant: "LPG",
};

module.exports = { CUSTOMER_TYPES, STATION_TYPES, isStationType, TYPE_LABEL, CODE_PREFIX };
