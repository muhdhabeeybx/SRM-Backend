const z = require("zod");
const {
  id, money, quantity, requiredString, optionalString, optionalEmail,
  enumOf, searchTerm, pagination,
} = require("./fields");

/**
 * AUDIT H4 — this controller called `deliverySaleRepo.create(req.body)` and
 * `update(id, req.body)` with the raw body. Three columns made that dangerous,
 * and all three are deliberately absent from these schemas:
 *
 *   paystackReference  pre-claiming a reference poisons webhook idempotency,
 *                      so a real incoming payment is later dropped as a
 *                      duplicate and the money is never credited
 *   paystackDetails    attacker-authored payment metadata
 *   depositStatus      forge a fully-paid sale outright
 *
 * They are written by the payment pipeline, never by a request. Because zod
 * strips unknown keys, sending them now removes them rather than ignoring them.
 */
const base = {
  truckNumber: optionalString("Truck number", 100),
  dateLoaded: optionalString("Date loaded", 40),
  depotLoaded: optionalString("Depot loaded", 255),
  customerId: id("Customer").optional(),
  customerName: optionalString("Customer name", 255),
  location: optionalString("Location", 255),
  quantity: quantity("Quantity").optional(),
  rate: money("Rate").optional(),
  salesValue: money("Sales value").optional(),
  paymentAmount: money("Payment amount").optional(),
  expensesAmount: money("Expenses amount").optional(),
  balance: money("Balance").optional(),
  payerName: optionalString("Payer name", 255),
  bank: optionalString("Bank", 255),
  // Which managed bank account the money went into. Safe to accept from a
  // request in a way depositStatus is not: it names where the money landed,
  // it does not assert that any money landed.
  bankAccountId: id("Bank account").optional().nullable(),
  // Nullable as well as optional: clearing a channel back to "unspecified"
  // has to be expressible, otherwise a mis-keyed POS entry can never be
  // corrected to anything but the other channel.
  depositChannel: enumOf("Deposit channel", ["pos", "bank_deposit"]).optional().nullable(),
  dateOfPayment: optionalString("Date of payment", 40),
  phoneNumber: optionalString("Phone number", 30),
  remarks: optionalString("Remarks", 1000),
  enteredBy: optionalString("Entered by", 255),
  allocationCode: optionalString("Allocation code", 64),
  paymentMethod: enumOf("Payment method", ["manual", "paystack_dva"]).optional(),
};

/**
 * Confirming a hand-recorded deposit, on its own route.
 *
 * depositStatus stays out of `base` for the reason in the audit note above —
 * accepting it on a general update lets a request forge a fully-paid sale by
 * mass assignment. But a filling-station deposit is keyed in by a person and
 * genuinely has to be confirmable by one, and the UI's toggle was silently
 * doing nothing: it sent depositStatus on the update route, zod stripped it,
 * and the toast reported success anyway.
 *
 * So it moves to a route of its own that accepts this one field and nothing
 * else, which is the narrow permission the toggle actually needs.
 */
const setDepositStatus = z.object({
  depositStatus: enumOf("Deposit status", ["pending", "paid", "partial"]),
});

/**
 * `lineIds` turns this into a bank-matched payment.
 *
 * When present, the amount, payer, date and reference are taken from the
 * statement lines rather than from the request — see the controller — so a
 * body carrying both is not a conflict, it is a body whose typed figures are
 * simply not consulted. Capped at 50 because that is a payment, not an import.
 */
const createDeliverySale = z.object({
  ...base,
  truckNumber: requiredString("Truck number", 100),
  lineIds: z.array(id("Statement line")).max(50, "Too many credits in one payment").optional(),
});
const updateDeliverySale = z.object(base).partial();

const listDeliverySales = pagination.extend({
  search: searchTerm,
  customer: searchTerm,
  truck_number: z.string().trim().max(100, "Truck number is too long").optional(),
  date_from: z.string().trim().max(40, "Start date is too long").optional(),
  date_to: z.string().trim().max(40, "End date is too long").optional(),
});

const idParam = z.object({ id: id("Sale id") });

/**
 * One end of a transfer — enough to place a leg in the right truck-cycle.
 *
 * Deliberately identified by truck, load date and customer rather than by a
 * sale id: a cycle is a group of payment rows, not a row, and naming one of
 * them would tie the transfer to whichever payment happened to be first.
 */
const transferCycle = z.object({
  truckNumber: requiredString("Truck number", 100),
  dateLoaded: optionalString("Date loaded", 40),
  depotLoaded: optionalString("Depot loaded", 255),
  customerId: id("Customer").optional().nullable(),
  customerName: optionalString("Customer name", 255),
  location: optionalString("Location", 255),
  allocationCode: optionalString("Allocation code", 100),
});

/**
 * The amount is validated here for shape only. Whether it is actually
 * available is decided in the repository against the table, because the
 * surplus is a fact about the ledger and not something a request can assert.
 */
const transferOverpayment = z.object({
  from: transferCycle,
  to: z
    .array(transferCycle.extend({ amount: money("Amount") }))
    .min(1, "Choose at least one truck to move it to")
    .max(20, "Too many destinations in one transfer"),
})

const cycleStandingQuery = z.object({
  truckNumber: z.string().trim().max(100, "Truck number is too long"),
  dateLoaded: z.string().trim().max(40, "Date loaded is too long").optional(),
  customerId: z.coerce.number().int().positive().optional(),
});

module.exports = {
  createDeliverySale,
  updateDeliverySale,
  setDepositStatus,
  listDeliverySales,
  idParam,
  transferOverpayment,
  cycleStandingQuery,
};
