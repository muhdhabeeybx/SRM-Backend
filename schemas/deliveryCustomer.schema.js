const z = require("zod");
const {
  id, money, quantity, numberLike, requiredString, optionalString, optionalEmail,
  enumOf, searchTerm, pagination,
} = require("./fields");
const { CUSTOMER_TYPES } = require("../lib/customerTypes");

/**
 * AUDIT H4 — `update(id, req.body)` took the raw body, which made these
 * settable from a request. They are the reason it mattered:
 *
 *   virtualAccountNumber  the Paystack webhook matches an incoming payment to
 *                         a customer BY ACCOUNT NUMBER. Overwriting it
 *                         redirects someone else's money.
 *   virtualAccountBank
 *   virtualAccountName
 *   paystackCustomerId
 *
 * All four are absent here; they are written only by the DVA service.
 */
const base = {
  customerType: enumOf("Customer type", CUSTOMER_TYPES).optional(),
  customerCode: optionalString("Customer code", 64),
  name: optionalString("Name", 255),
  phoneNumber: optionalString("Phone number", 30),
  altPhoneNumber: optionalString("Alt phone number", 30),
  email: optionalEmail(),
  homeAddress: optionalString("Home address", 1000),
  officeAddress: optionalString("Office address", 1000),
  contactPerson: optionalString("Contact person", 255),
  contactPersonPhone: optionalString("Contact person phone", 30),
  stationAddress: optionalString("Station address", 1000),
  /**
   * What the site holds — litres at a filling station, kilograms at an LPG
   * plant. A whole number, because the column is an integer.
   *
   * It was money(), which hands the driver "45000.00": Postgres refuses that
   * for an integer column, and every station saved through this route with a
   * capacity — which the dashboard form always sends, 0 when blank — failed
   * with "Invalid identifier or value".
   */
  tankCapacity: numberLike("Tank capacity")
    .pipe(z.number().int("Tank capacity must be a whole number").nonnegative("Tank capacity cannot be negative"))
    .optional(),
  pumpCount: z.number().int("Pump count must be a whole number").nonnegative("Pump count cannot be negative").optional(),
  /**
   * LPG plant only: which of Soroman's plants (lpg_stations) this customer
   * is. Null unlinks it. The controller checks it exists and is not already
   * another customer's — migration 0061.
   */
  lpgStationId: id("LPG plant").nullable().optional(),
  creditLimit: money("Credit limit").optional(),
  /**
   * Where money owed to the customer is paid. Never in this list until now,
   * so validation dropped it and every "settlement account" the dashboard
   * form sent was thrown away — the column holds nothing but empty values.
   */
  bankDetails: z.object({
    bankName: optionalString("Bank name", 255),
    accountNumber: optionalString("Account number", 30),
    accountName: optionalString("Account name", 255),
  }).optional(),
  status: enumOf("Status", ["active", "dormant", "suspended"]).optional(),
  notes: optionalString("Notes", 1000),
};

const createDeliveryCustomer = z.object({ ...base, name: requiredString("Name", 255) });
const updateDeliveryCustomer = z.object(base).partial();

const listDeliveryCustomers = pagination.extend({
  type: enumOf("Type", CUSTOMER_TYPES).optional(),
  search: searchTerm,
  status: enumOf("Status", ["active", "dormant", "suspended", "all"]).optional(),
});

const idParam = z.object({ id: id("Customer id") });

module.exports = {
  createDeliveryCustomer,
  updateDeliveryCustomer,
  listDeliveryCustomers,
  idParam,
};
