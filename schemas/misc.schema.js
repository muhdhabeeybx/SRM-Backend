const z = require("zod");
const {
  id, money, quantity, numberLike, requiredString, optionalString, optionalEmail,
  enumOf, searchTerm, pagination, typeError,
} = require("./fields");
const { ROLE_MAP } = require("../config/roleMapping");

const ROLE_COUNT = Object.keys(ROLE_MAP).length;

/**
 * Schemas for the remaining CRUD resources. Grouped in one file because each
 * is small and they share a shape; split them out if any grows real rules.
 *
 * Every list schema exists mainly to bound `limit`. Several controllers
 * defaulted to 500, and an unbounded limit is a cheap way to make the database
 * do a lot of work from an unauthenticated-adjacent surface.
 */

const idParam = z.object({ id: id("Id") });

// --- products -------------------------------------------------------------

const productBase = {
  name: optionalString("Name", 255),
  sku: optionalString("Sku", 100),
  category: optionalString("Category", 100),
  gradeClass: optionalString("Grade class", 100),
  description: optionalString("Description", 1000),
  density: optionalString("Density", 50),
  flashPoint: optionalString("Flash point", 50),
  unNumber: optionalString("Un number", 50),
  hazardClass: optionalString("Hazard class", 50),
  stockLevel: money("Stock level").optional(),
  unit: optionalString("Unit", 50),
  supplier: optionalString("Supplier", 255),
};
const createProduct = z.object({ ...productBase, name: requiredString("Name", 255), productType: z.string().trim().max(50).optional() });
const updateProduct = z.object(productBase).partial();
const listProducts = pagination.extend({
  search: searchTerm,
  productType: z.string().trim().max(50).optional(),
});

// --- trucks ---------------------------------------------------------------

const listTrucks = pagination.extend({
  search: searchTerm,
  status: enumOf("Status", ["In Transit", "Idle", "Maintenance", "all"]).optional(),
});

// --- drivers --------------------------------------------------------------

const driverBase = {
  name: optionalString("Name", 255),
  email: optionalEmail(),
  phone: optionalString("Phone", 30),
  licenseNumber: optionalString("License number", 100),
  licenseClass: optionalString("License class", 50),
  licenseExpiry: optionalString("License expiry", 40),
  rating: numberLike("Rating").optional(),
  status: enumOf("Status", ["Active", "On Trip", "Off Duty"]).optional(),
  safetyScore: numberLike("Safety score").optional(),
};
const createDriver = z.object({ ...driverBase, name: requiredString("Name", 255) });
const updateDriver = z.object(driverBase).partial();
const listDrivers = pagination.extend({
  search: searchTerm,
  status: enumOf("Status", ["Active", "On Trip", "Off Duty", "all"]).optional(),
});

// --- PFIs -----------------------------------------------------------------

const listPfis = pagination.extend({
  search: searchTerm,
  status: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(enumOf("Status", ["not_started", "active", "finished", "all"]))
    .optional()
    .or(z.literal("")),
  location: z.union([z.string(), z.number()]).transform((v) => String(v).trim()).optional().or(z.literal("")),
  // Coastal, gantry and delivery batches share one list and read nothing alike
  // — a gantry or delivery row has no BL, no surplus and no vessel — so they
  // need separating.
  //
  // This list MUST accept every value pfiBase does. It did not when 'delivery'
  // was added there: creating a delivery batch worked, and the tab that then
  // listed them answered 400 before the query ran, because a filter the write
  // side accepts and the read side rejects is not a validation rule, it is a
  // batch nobody can look at.
  type: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(enumOf("Type", ["coastal", "gantry", "delivery", "all"]))
    .optional()
    .or(z.literal("")),
});

// --- tickets --------------------------------------------------------------

const listTickets = pagination.extend({
  search: searchTerm,
  status: enumOf("Status", ["Active", "Redeemed", "all"]).optional(),
});
/** Accepts a numeric id or a ticket code, so it stays a bounded string. */
const ticketIdOrCode = z.object({ idOrCode: requiredString("Id or code", 100) });

// --- filling stations -----------------------------------------------------

const stationBase = {
  name: optionalString("Name", 255),
  phone: optionalString("Phone", 30),
  manager: optionalString("Manager", 255),
  street: optionalString("Street", 500),
  city: optionalString("City", 255),
  state: optionalString("State", 255),
  tankCapacity: money("Tank capacity").optional(),
  pumpCount: z.number().int("Pump count must be a whole number").nonnegative("Pump count cannot be negative").optional(),
  creditLimit: money("Credit limit").optional(),
  notes: optionalString("Notes", 1000),
};
const createStation = z.object({ ...stationBase, name: requiredString("Name", 255) });
const updateStation = z.object(stationBase).partial();
const listStations = pagination.extend({ search: searchTerm });

// --- delivery inventory ---------------------------------------------------

/**
 * AUDIT H4 — `update(record.id, req.body)` took the raw body. The whitelist is
 * the fix; `allocationCode` and the account arrays stay settable because the
 * desk genuinely edits them, but nothing outside this list survives.
 */
const inventoryBase = {
  truckId: id("Id").optional(),
  truckNumber: optionalString("Truck number", 100),
  pfiId: id("Id").optional(),
  pfiNumber: optionalString("Pfi number", 100),
  pfiProduct: optionalString("Pfi product", 100),
  depot: optionalString("Depot", 255),
  customerId: id("Id").optional(),
  customerName: optionalString("Customer name", 255),
  quantityAllocated: money("Quantity allocated").optional(),
  rate: money("Rate").optional(),
  dateAllocated: optionalString("Date allocated", 40),
  dateOffloaded: optionalString("Date offloaded", 40),
  loadingStatus: enumOf("Loading status", ["loaded", "offloaded", "empty", ""]).optional(),
  location: optionalString("Location", 255),
  pfiLocation: optionalString("Pfi location", 255),
  allocationCode: optionalString("Allocation code", 64),
  notes: optionalString("Notes", 1000),
  // Trip costs, per truck. Nullable rather than defaulted: clearing a figure
  // back to "not costed" is a real edit, and `money().optional()` alone would
  // silently drop a null instead of applying it.
  agoLitres: money("AGO litres").nullish(),
  agoPrice: money("AGO price").nullish(),
  feedingAllowance: money("Feeding allowance").nullish(),
  productPrice: money("Product price").nullish(),
};
const createInventory = z.object(inventoryBase).partial();
const updateInventory = z.object(inventoryBase).partial();

/**
 * Applying one set of trip costs to several trucks at once.
 *
 * Trucks on a batch usually take the same diesel at the same price on the same
 * day, and entering it twelve times is how twelve rows end up slightly
 * different. The ids are explicit rather than "the whole batch": bulk entry
 * that silently includes a truck somebody already costed by hand would
 * overwrite the careful figure with the convenient one.
 */
const bulkCostInventory = z.object({
  ids: z.array(id("Id")).min(1).max(200),
  agoLitres: money("AGO litres").nullish(),
  agoPrice: money("AGO price").nullish(),
  feedingAllowance: money("Feeding allowance").nullish(),
  productPrice: money("Product price").nullish(),
  /** Without this, a blank field means "leave alone" rather than "clear". */
  clearBlank: z.boolean().optional(),
});
const listInventory = pagination.extend({
  search: searchTerm,
  loading_status: enumOf("Loading status", ["loaded", "offloaded", "empty", "all"]).optional(),
  truck_number: z.string().trim().max(100, "Value is too long").optional(),
});

// --- staff ----------------------------------------------------------------

/**
 * NOTE — this schema does NOT close AUDIT H5.
 *
 * `roles` and `suspended` are legitimately editable here, so validating their
 * shape changes nothing about who may edit them. H5 is that
 * `PATCH /api/admin/:id` carries no `requireRole("super_admin")`, letting any
 * `admin` promote themselves. That is authorization, and it stays open.
 */
const staffBase = {
  first_name: optionalString("First name", 100),
  surname: optionalString("Surname", 100),
  other_names: optionalString("Other names", 200),
  email: optionalEmail(),
  phone_number: optionalString("Phone number", 30),
  roles: z
    .array(
      numberLike("Role").pipe(
        z
          .number()
          .int("A role id must be a whole number")
          .refine((n) => n in ROLE_MAP, "Unknown role id")
      ),
      { error: (iss) => (iss.input === undefined ? "Roles are required" : "Roles must be a list") }
    )
    .min(1, "At least one role is required")
    .max(ROLE_COUNT, `A user cannot have more than ${ROLE_COUNT} roles`)
    .optional(),
  suspended: z.boolean({ error: "Suspended must be true or false" }).optional(),
  // Location/PFI scope and per-page overrides — gated the same way as roles
  // and suspended (see staff.controller.js#updateAdmin's changesPrivileges
  // check), since they equally decide what an account may see or do.
  can_view_all_locations: z.boolean({ error: "can_view_all_locations must be true or false" }).optional(),
  depot_ids: z.array(z.union([id("Depot id"), z.string(), z.number()])).optional(),
  lpg_station_ids: z.array(z.union([id("LPG station id"), z.string(), z.number()])).optional(),
  pfi_ids: z.array(z.union([id("PFI id"), z.string(), z.number()])).optional(),
  filling_station_ids: z.array(z.union([id("Filling station id"), z.string(), z.number()])).optional(),
  page_overrides: z
    .array(
      z.object({
        route_path: requiredString("Route path", 100),
        allowed: z.boolean({ error: "allowed must be true or false" }),
      })
    )
    .max(200, "Too many page overrides")
    .optional(),
};
const createStaff = z.object({
  ...staffBase,
  first_name: requiredString("First name", 100),
  surname: requiredString("Surname", 100),
  email: z.string().trim().min(1).max(255).email(),
});
const updateStaff = z.object(staffBase).partial();
const listStaff = pagination.extend({ search: searchTerm });

/**
 * Self-service profile edit. A whitelist, not staffBase.partial(): schemas
 * strip unknown keys, so email/roles/suspended/scope cannot reach the handler
 * at all rather than merely being ignored by it.
 */
// Genuinely optional, NOT optionalString: that helper turns an absent field
// into "", which on a partial update reads as "clear it" — saving just a name
// change would have wiped the person's phone number and profile picture.
const selfText = (label, max) =>
  z.string({ error: typeError(label, "text") }).trim().max(max, `${label} must be ${max} characters or fewer`).optional();

const updateMyProfile = z.object({
  first_name: requiredString("First name", 100).optional(),
  surname: requiredString("Surname", 100).optional(),
  other_names: selfText("Other names", 200),
  phone_number: selfText("Phone number", 30),
  profile_picture_url: selfText("Profile picture URL", 1000),
  profile_picture_public_id: selfText("Profile picture id", 255),
});

const changeMyPassword = z.object({
  current_password: requiredString("Current password", 200),
  new_password: requiredString("New password", 200).refine(
    (v) => v.length >= 8,
    "Your new password must be at least 8 characters",
  ),
});

// --- bank accounts --------------------------------------------------------

const bankAccountBase = {
  bankName: requiredString("Bank name", 255),
  accountName: requiredString("Account name", 255),
  accountNumber: requiredString("Account number", 50),
  bankCode: optionalString("Bank code", 50),
  branchName: optionalString("Branch name", 255),
  accountType: optionalString("Account type", 50),
  currency: optionalString("Currency", 10),
  status: enumOf("Status", ["Active", "Inactive", "Suspended"]).optional(),
  isDefault: z.boolean({ error: "isDefault must be true or false" }).optional(),
  /**
   * The PFIs that collect into this account. `depotIds` is derived from their
   * locations server-side and is not accepted from a client any more — a
   * location is what the chosen PFIs imply, not a separate choice that could
   * disagree with them.
   */
  pfiIds: z.array(z.union([id("PFI id"), z.string(), z.number()])).optional(),
  lpgStationIds: z.array(z.union([id("Station id"), z.string(), z.number()])).optional(),
  /**
   * Which areas of the app may collect into this account.
   *
   * Missing from this schema until now, and a schema here is a whitelist —
   * unknown keys are stripped before the controller sees them (see
   * middleware/validate.js). So ticking an account on the Expense Bank
   * Accounts list sent `{usage: [...]}`, the validator removed it, the PATCH
   * ran with an empty body, and the API answered 200. The dialog showed
   * success and nothing had been written. Creating an account from that same
   * dialog lost its usage tag the same way, so a new account was added and
   * still did not appear on the list it was added from.
   */
  usage: z.array(enumOf("Usage", ["truck_sales", "expenses"])).optional(),
  notes: optionalString("Notes", 1000),
};
const createBankAccount = z.object(bankAccountBase);
const updateBankAccount = z.object(bankAccountBase).partial();

// --- vendors ----------------------------------------------------------------

const vendorBase = {
  name: requiredString("Vendor name", 255),
  contactPerson: optionalString("Contact person", 255),
  phone: optionalString("Phone", 50),
  email: optionalString("Email", 255),
  address: optionalString("Address", 1000),
  bankName: optionalString("Bank name", 200),
  accountNumber: optionalString("Account number", 50),
  accountName: optionalString("Account name", 255),
  taxId: optionalString("Tax/registration ID", 50),
  status: enumOf("Status", ["Active", "Inactive"]).optional(),
};
const createVendor = z.object(vendorBase);
const updateVendor = z.object(vendorBase).partial();

// --- bank statements ------------------------------------------------------

/** A 0-based column index — unlike `id()`, 0 is valid (the first column). */
const columnIndex = (label) =>
  numberLike(label).pipe(
    z.number().int(`${label} must be a whole number`).min(0, `${label} must be zero or greater`)
  );

const createBankStatement = z.object({
  bankAccountId: id("Bank account"),
  filename: optionalString("Filename", 255),
  rows: z
    .array(
      z.object({
        txnDate: requiredString("Transaction date", 40),
        amount: numberLike("Amount"),
        depositor: optionalString("Depositor", 255),
        bankRef: optionalString("Bank reference", 255),
        narration: optionalString("Narration", 1000),
        /**
         * The row exactly as the bank wrote it.
         *
         * bank_statement_lines.raw_row exists "for traceability" and had been
         * getting nothing: a Zod object strips unknown keys, and this schema
         * never listed rawRow, so validate() deleted it on the way past. The
         * damage is dated — every line imported in July carries its original
         * row, 44% of August's do, and every one of September's 1,433 is an
         * empty array. The column a disputed credit would be checked against
         * was empty for exactly the period anybody would be disputing.
         *
         * Cells only, as strings, and capped: this is evidence, not input,
         * and nothing downstream reads it as anything but text.
         *
         * A blank cell arrives as null and is kept as "". The spreadsheet
         * reader returns a row with an empty leading cell as a sparse array,
         * and a hole becomes null the moment it is serialised — so the day
         * this field started being checked, any statement with a blank first
         * column was refused outright: "rows.2.rawRow.0 — expected string,
         * received null". An empty cell is a true fact about the bank's row,
         * and refusing a whole statement over it loses every line in it.
         */
        rawRow: z
          .array(z.string().max(2000).nullable().transform((v) => v ?? ""))
          .max(100)
          .optional(),
      })
    )
    .min(1, "At least one row is required"),
});
const bankStatementMapping = z.object({
  headerRow: columnIndex("Header row").optional(),
  dateColumn: columnIndex("Date column").optional().nullable(),
  amountColumn: columnIndex("Amount column").optional().nullable(),
  creditColumn: columnIndex("Credit column").optional().nullable(),
  depositorColumn: columnIndex("Depositor column").optional().nullable(),
  referenceColumn: columnIndex("Reference column").optional().nullable(),
  narrationColumn: columnIndex("Narration column").optional().nullable(),
  sampleHeaders: z.array(z.string()).optional(),
});
const matchBankLines = z.object({
  lineIds: z.array(id("Line id")).min(1, "At least one line is required"),
  depositId: id("Deposit"),
});

// --- expenses --------------------------------------------------------------

/**
 * An invoice figure. Blank stays blank — mapping it to "0.00" the way the PFI
 * fields do would turn "no invoice was raised" into "an invoice worth nothing",
 * and those read very differently on a payment schedule.
 */
/** A percentage between 0 and 100. Blank stays blank. */
const optPercent = (label = "Rate") =>
  z
    .union([
      numberLike(label).pipe(
        z.number().min(0, `${label} cannot be negative`).max(100, `${label} cannot exceed 100%`)
      ),
      z.literal(""),
      z.null(),
    ])
    .optional()
    .transform((v) => (v === "" || v === null ? null : v === undefined ? undefined : Number(v)));

const optInvoiceMoney = (label = "Amount") =>
  z
    .union([
      money(label),
      numberLike(label).pipe(z.number().nonnegative(`${label} cannot be negative`)).transform((v) => v.toFixed(2)),
      z.literal(""),
      z.null(),
    ])
    .optional()
    .transform((v) => (v === "" || v === null ? null : v === undefined ? undefined : String(v)));

/**
 * An ISO 4217 code. Upper-cased on the way in, so a requester typing "usd"
 * does not trip the database's own three-upper-case-letters constraint.
 */
const optCurrency = (label = "Currency") =>
  z
    .union([z.string(), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v === "" || v === null || v === undefined ? undefined : String(v).trim().toUpperCase()))
    .refine((v) => v === undefined || /^[A-Z]{3}$/.test(v), {
      message: `${label} must be a three-letter code such as NGN or USD`,
    });

/**
 * Naira per unit of the invoice's currency.
 *
 * Strictly positive. A rate of zero translates a foreign invoice to nothing at
 * all and reads as a free expense, which is the one wrong answer that looks
 * like a right one.
 */
const optRate = (label = "Exchange rate") =>
  z
    .union([
      numberLike(label).pipe(z.number().positive(`${label} must be greater than zero`)),
      z.literal(""),
      z.null(),
    ])
    .optional()
    .transform((v) => (v === "" || v === null ? null : v === undefined ? undefined : Number(v)));

const expenseBase = {
  // A description is genuinely optional — the category, vendor and amount
  // already identify the line, and forcing prose here just gets "expense".
  description: optionalString("Description", 500),
  /**
   * What the vendor is owed, in `currency` below — NOT in naira.
   *
   * The foreign figure is the debt: it is what the invoice says, what the
   * vendor will chase, and what an auditor reads off the document. Naira is a
   * translation of it, derived by the database from `exchange_rate` and never
   * written by this API. See db/migrations/0026.
   */
  amount: money("Amount", { min: 0.01 }),
  currency: optCurrency("Currency"),
  exchange_rate: optRate("Exchange rate"),
  exchangeRate: optRate("Exchange rate"),
  // The GL account the cost is posted to. Accepted as an id in either casing.
  category: id("Category").optional().nullable(),
  category_id: id("Category").optional().nullable(),
  categoryId: id("Category").optional().nullable(),
  // Which cargo carries the cost. Only honoured for a PFI/product-related
  // account — the controller refuses it on any other, so it can never be used
  // to slip an overhead into a batch's landed cost.
  pfi_id: id("PFI").optional().nullable(),
  pfiId: id("PFI").optional().nullable(),
  /**
   * Who the cost was incurred FOR, when it was not the company at large: a
   * filling station or an LPG plant, never both. The controller checks the id
   * exists and that a station really is one; this only lets the field through.
   *
   * Beside a subject, `pfi_id` above stops meaning "this is a cargo cost" and
   * starts meaning "which of that station's loads it sits under". See
   * migration 0055.
   *
   * Accepted under four spellings because the front end and the register do
   * not agree on one, and a name this layer does not know is dropped before
   * the controller ever sees it — which is exactly how the first cut of this
   * silently stored nothing.
   */
  delivery_customer_id: id("Station").optional().nullable(),
  deliveryCustomerId: id("Station").optional().nullable(),
  station_id: id("Station").optional().nullable(),
  stationId: id("Station").optional().nullable(),
  lpg_station_id: id("Plant").optional().nullable(),
  lpgStationId: id("Plant").optional().nullable(),
  plant_id: id("Plant").optional().nullable(),
  plantId: id("Plant").optional().nullable(),
  /**
   * The same, as a list. One bill covering six stations is raised once and
   * divided into six rows — see splitEvenly in the controller.
   */
  station_ids: z.array(id("Station")).optional().nullable(),
  stationIds: z.array(id("Station")).optional().nullable(),
  delivery_customer_ids: z.array(id("Station")).optional().nullable(),
  deliveryCustomerIds: z.array(id("Station")).optional().nullable(),
  plant_ids: z.array(id("Plant")).optional().nullable(),
  plantIds: z.array(id("Plant")).optional().nullable(),
  lpg_station_ids: z.array(id("Plant")).optional().nullable(),
  lpgStationIds: z.array(id("Plant")).optional().nullable(),
  vendor: optionalString("Vendor", 255),
  // Set when the requester picked (or saved) an entry from the vendor list;
  // `vendor` above still carries the name — see expense.controller.js.
  vendor_id: id("Vendor").optional().nullable(),
  vendorId: id("Vendor").optional().nullable(),
  tin_number: optionalString("TIN number", 30),
  tinNumber: optionalString("TIN number", 30),
  invoice_number: optionalString("Invoice number", 100),
  invoiceNumber: optionalString("Invoice number", 100),
  // The invoice behind the payment. `amount` above stays the money paid.
  amount_ex_vat: optInvoiceMoney("Amount excluding VAT"),
  amountExVat: optInvoiceMoney("Amount excluding VAT"),
  vat_amount: optInvoiceMoney("VAT"),
  vatAmount: optInvoiceMoney("VAT"),
  invoice_amount: optInvoiceMoney("Invoice amount"),
  invoiceAmount: optInvoiceMoney("Invoice amount"),
  wht_deduction: optInvoiceMoney("WHT deduction"),
  whtDeduction: optInvoiceMoney("WHT deduction"),
  // The rate behind the deduction, as a percentage. Bounded rather than free:
  // a "50" typed into a percent field is a decimal point away from a disaster.
  wht_rate: optPercent("WHT rate"),
  whtRate: optPercent("WHT rate"),
  bank_code: optionalString("Bank code", 20),
  bankCode: optionalString("Bank code", 20),
  expense_date: optionalString("Expense date", 40),
  expenseDate: optionalString("Expense date", 40),
  bank_paid_from: optionalString("Bank paid from", 255),
  bankPaidFrom: optionalString("Bank paid from", 255),
  receipt_reference: optionalString("Receipt reference", 100),
  receiptReference: optionalString("Receipt reference", 100),
  // Where the money is going — shown to approvers before they authorise.
  payee_bank_name: optionalString("Payee bank", 200),
  payeeBankName: optionalString("Payee bank", 200),
  payee_account_number: optionalString("Payee account number", 50),
  payeeAccountNumber: optionalString("Payee account number", 50),
  payee_account_name: optionalString("Payee account name", 255),
  payeeAccountName: optionalString("Payee account name", 255),
  reference: optionalString("Reference", 100),
  notes: optionalString("Notes", 1000),
};

/**
 * Booking money that has already left the bank, straight in as paid.
 *
 * Super admin only — enforced in the controller against the caller's roles,
 * which is where the question can actually be answered; the schema's job is
 * only to let the fields through. The settlement details ride along in the
 * same body and are validated by the same paymentFor() the mark_paid
 * transition uses, so a direct booking cannot record less than a normal one.
 */
const recordAsPaidFields = {
  record_as_paid: z.boolean().optional(),
  recordAsPaid: z.boolean().optional(),
  amount_paid: optInvoiceMoney("Amount paid"),
  amountPaid: optInvoiceMoney("Amount paid"),
  // The rate on the day it actually cleared, which is not the rate it was
  // raised at. The gap between the two is a real gain or loss and the only
  // way to see it is to keep both.
  paid_exchange_rate: optRate("Payment exchange rate"),
  paidExchangeRate: optRate("Payment exchange rate"),
  payment_reference: optionalString("Payment reference", 100),
  paymentReference: optionalString("Payment reference", 100),
  payment_date: optionalString("Payment date", 40),
  paymentDate: optionalString("Payment date", 40),
  payment_method: optionalString("Payment method", 50),
  paymentMethod: optionalString("Payment method", 50),
  payment_notes: optionalString("Payment notes", 1000),
  paymentNotes: optionalString("Payment notes", 1000),
};

const createExpense = z.object({ ...expenseBase, ...recordAsPaidFields });
const updateExpense = z.object(expenseBase).partial();
const categoryBase = {
  name: requiredString("Category name", 255),
  description: optionalString("Description", 500),
  // The chart fields. Present here or the validator strips them before the
  // controller ever sees them — a whitelist is only a whitelist if it lists
  // everything the endpoint accepts.
  gl_code: optionalString("GL code", 20),
  glCode: optionalString("GL code", 20),
  gl_group: optionalString("GL group", 40),
  glGroup: optionalString("GL group", 40),
  gl_subgroup: optionalString("GL subgroup", 60),
  glSubgroup: optionalString("GL subgroup", 60),
};
const createCategory = z.object(categoryBase);

/**
 * A PATCH must be able to leave a field alone.
 *
 * `optionalString` turns an absent key into "", which is right on create and
 * catastrophic here: a rename that omitted `gl_group` would arrive as a request
 * to clear it. These keep `undefined` undefined, so only what was sent is
 * touched.
 */
const chartField = (label, max) =>
  z.string({ error: `${label} must be text` }).trim().max(max, `${label} must be ${max} characters or fewer`).optional();

const updateCategory = z.object({
  name: chartField("Category name", 255),
  description: chartField("Description", 500),
  gl_code: chartField("GL code", 20),
  glCode: chartField("GL code", 20),
  gl_group: chartField("GL group", 40),
  glGroup: chartField("GL group", 40),
  gl_subgroup: chartField("GL subgroup", 60),
  glSubgroup: chartField("GL subgroup", 60),
});

// --- dangote products -----------------------------------------------------

const dangoteProductBase = {
  name: requiredString("Product name", 255),
  code: optionalString("Code", 50),
  description: optionalString("Description", 1000),
  price: money("Price", { min: 0.01 }).optional(),
  unit: optionalString("Unit", 50),
  isActive: z.boolean().optional(),
};
const createDangoteProduct = z.object(dangoteProductBase);
const updateDangoteProduct = z.object(dangoteProductBase).partial();

// --- PFI create/update ----------------------------------------------------

const optPfiStr = (label, max = 255) =>
  z
    .union([z.string().trim().max(max, `${label} must be ${max} characters or fewer`), z.null()])
    .optional()
    .transform((v) => (v === null ? "" : v));

const optPfiId = (label = "id") =>
  z
    .union([id(label), z.literal(""), z.literal("none"), z.null()])
    .optional()
    .transform((v) => (v === "" || v === "none" || v === null ? null : v === undefined ? undefined : Number(v)));

const optPfiQty = (label = "Quantity") =>
  z
    .union([
      numberLike(label).pipe(z.number().int(`${label} must be a whole number`).nonnegative(`${label} cannot be negative`)),
      z.literal(""),
      z.null(),
    ])
    .optional()
    .transform((v) => (v === "" || v === null ? 0 : v === undefined ? undefined : Number(v)));

const optPfiBlQty = (label = "BL Quantity") =>
  z
    .union([
      numberLike(label).pipe(z.number().int(`${label} must be a whole number`).nonnegative(`${label} cannot be negative`)),
      z.literal(""),
      z.null(),
    ])
    .optional()
    .transform((v) => (v === "" || v === null ? null : v === undefined ? undefined : Number(v)));

const optPfiFloat = (label = "Volume") =>
  z
    .union([
      numberLike(label).pipe(z.number().nonnegative(`${label} cannot be negative`)),
      z.literal(""),
      z.null(),
    ])
    .optional()
    .transform((v) => (v === "" || v === null ? 0 : v === undefined ? undefined : Number(v)));

/** Same as optPfiBlQty (nullable, not zero-defaulted) but without the whole-number constraint. */
const optPfiBlFloat = (label = "Volume") =>
  z
    .union([
      numberLike(label).pipe(z.number().nonnegative(`${label} cannot be negative`)),
      z.literal(""),
      z.null(),
    ])
    .optional()
    .transform((v) => (v === "" || v === null ? null : v === undefined ? undefined : Number(v)));

const optPfiMoney = (label = "Amount") =>
  z
    .union([
      money(label),
      numberLike(label).pipe(z.number().nonnegative(`${label} cannot be negative`)).transform((v) => v.toFixed(2)),
      z.literal(""),
      z.null(),
    ])
    .optional()
    .transform((v) => (v === "" || v === null ? "0.00" : v === undefined ? undefined : typeof v === "number" ? v.toFixed(2) : String(v)));

const optPfiDate = (label = "Date") =>
  z
    .union([
      z.string().trim().max(50),
      z.date(),
      z.literal(""),
      z.null(),
    ])
    .optional()
    .transform((v) => (v === "" || v === null ? null : v === undefined ? undefined : v));

/**
 * A plain calendar day, normalised to YYYY-MM-DD.
 *
 * Stricter than optPfiDate, which takes any string up to 50 characters
 * because the columns behind it are timestamps run through parseDate() in the
 * controller. This one lands in a `date` column, where "not-a-date" is a 500
 * from the driver rather than a validation message.
 *
 * "" and null mean "clear it", which for a collections window means no window
 * at all rather than a date nobody chose.
 */
const optCalendarDay = (label = "Date") =>
  z
    .union([z.string().trim().max(40), z.date(), z.literal(""), z.null()])
    .optional()
    .transform((v, ctx) => {
      if (v === "" || v === null) return null;
      if (v === undefined) return undefined;
      const d = v instanceof Date ? v : new Date(String(v));
      if (Number.isNaN(d.getTime())) {
        ctx.addIssue({ code: "custom", message: `${label} is not a date` });
        return z.NEVER;
      }
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
    });

const pfiBase = {
  pfiNumber: z.string().trim().max(100).optional(),
  pfi_number: z.string().trim().max(100).optional(),
  // Coastal batches arrive by sea and are billed on a BL; gantry batches are
  // an allocation bought at the loading gantry and split into tickets. Absent
  // means coastal — the only kind that existed before the distinction did.
  // 'delivery' is an allocation loaded at one depot and sold at several —
  // see db/migrations/0027. It is a PFI in the same table, not a second thing.
  pfiType: enumOf("PFI type", ["coastal", "gantry", "delivery", "trucking"]).optional(),
  pfi_type: enumOf("PFI type", ["coastal", "gantry", "delivery", "trucking"]).optional(),
  /**
   * A trucking PFI's batch, held until activation. Shape mirrors what the
   * delivery screens already write — see pfis.pending_batch in migration 0046.
   */
  batch: z
    .object({
      code: requiredString("Batch code", 100),
      depotName: optionalString("Depot", 255),
      productName: optionalString("Product", 255),
      dateAllocated: optionalString("Date allocated", 40),
      trucks: z
        .array(
          z.object({
            truckId: id("Truck").optional().nullable(),
            plateNumber: requiredString("Plate number", 30),
            loadedQty: numberLike("Loaded quantity"),
          })
        )
        .min(1, "Pick at least one truck")
        .max(200, "Too many trucks in one batch"),
    })
    .optional(),

  /**
   * The depots that may sell from this batch. Delivery batches only.
   *
   * `locationId` above is where it is LOADED; this is everywhere it may be
   * drawn on. A coastal batch is sold out of the depot it landed at, so the
   * two are the same thing there and this is left empty.
   */
  allowedDepotIds: z.array(id("Depot")).max(50, "Too many locations").optional(),
  allowed_depot_ids: z.array(id("Depot")).max(50, "Too many locations").optional(),
  ticketCount: optPfiBlQty("Number of tickets"),
  ticket_count: optPfiBlQty("Number of tickets"),
  description: optPfiStr("Description", 1000),
  pfiDate: optPfiDate("PFI date"),
  pfi_date: optPfiDate("PFI date"),
  // When this PFI started taking money — the window on the credits offered
  // when confirming an order's payment. See migration 0052.
  collectionsOpenFrom: optCalendarDay("Collections open from"),
  collections_open_from: optCalendarDay("Collections open from"),
  locationId: optPfiId("Location"),
  location_id: optPfiId("Location"),
  depotId: optPfiId("Depot"),
  depot_id: optPfiId("Depot"),
  location: optPfiStr("Location", 255),
  locationName: optPfiStr("Location name", 255),
  location_name: optPfiStr("Location name", 255),
  productId: optPfiId("Product"),
  product_id: optPfiId("Product"),
  productUnit: optPfiStr("Product unit", 50),
  product_unit: optPfiStr("Product unit", 50),
  startingQtyLitres: optPfiQty("Starting quantity"),
  starting_qty_litres: optPfiQty("Starting quantity"),
  blQtyLitres: optPfiBlQty("BL quantity"),
  bl_qty_litres: optPfiBlQty("BL quantity"),
  qtyVolumeMt: optPfiFloat("Quantity volume (MT)"),
  qty_volume_mt: optPfiFloat("Quantity volume (MT)"),
  blQtyMt: optPfiBlFloat("BL quantity (MT)"),
  bl_qty_mt: optPfiBlFloat("BL quantity (MT)"),
  unitPrice: optPfiMoney("Unit price"),
  unit_price: optPfiMoney("Unit price"),
  creditBalance: optPfiMoney("Credit balance"),
  credit_balance: optPfiMoney("Credit balance"),
  auditOfficerId: optPfiId("Audit officer"),
  audit_officer: optPfiId("Audit officer"),
  audit_officer_id: optPfiId("Audit officer"),
  productOfficerId: optPfiId("Product officer"),
  product_officer: optPfiId("Product officer"),
  product_officer_id: optPfiId("Product officer"),
  itComplianceOfficerId: optPfiId("IT compliance officer"),
  it_compliance_officer: optPfiId("IT compliance officer"),
  it_compliance_officer_id: optPfiId("IT compliance officer"),
  securityExitOfficerId: optPfiId("Security exit officer"),
  security_exit_officer: optPfiId("Security exit officer"),
  security_exit_officer_id: optPfiId("Security exit officer"),
  commissionOfficerId: optPfiId("Commission officer"),
  commission_officer: optPfiId("Commission officer"),
  commission_officer_id: optPfiId("Commission officer"),
  salesManagerId: optPfiId("Sales manager"),
  sales_manager: optPfiId("Sales manager"),
  sales_manager_id: optPfiId("Sales manager"),
  vesselBroker: optPfiStr("Vessel broker", 255),
  vessel_broker: optPfiStr("Vessel broker", 255),
  vesselName: optPfiStr("Vessel name", 255),
  vessel_name: optPfiStr("Vessel name", 255),
  surveyorName: optPfiStr("Surveyor name", 255),
  surveyor_name: optPfiStr("Surveyor name", 255),
  surveyorPhone: optPfiStr("Surveyor phone", 50),
  surveyor_phone: optPfiStr("Surveyor phone", 50),
  notes: optPfiStr("Notes", 1000),
  // All three states. `finished` stays reachable here because the PFI detail
  // page closes a batch through this PATCH rather than through /finish — it
  // sends the closure figures in the same request. Narrowing this to the two
  // live states would break that form.
  status: enumOf("Status", ["not_started", "active", "finished"]).optional(),
  closureDate: optPfiDate("Closure date"),
  closure_date: optPfiDate("Closure date"),
  closureBank: optPfiStr("Closure bank", 255),
  closure_bank: optPfiStr("Closure bank", 255),
  closureHandler: optPfiStr("Closure handler", 255),
  closure_handler: optPfiStr("Closure handler", 255),
  closureRemarks: optPfiStr("Closure remarks", 1000),
  closure_remarks: optPfiStr("Closure remarks", 1000),
  totalInflow: optPfiMoney("Total inflow"),
  total_inflow: optPfiMoney("Total inflow"),
  purchaseCost: optPfiMoney("Purchase cost"),
  purchase_cost: optPfiMoney("Purchase cost"),
  aggregateExpenses: optPfiMoney("Aggregate expenses"),
  aggregate_expenses: optPfiMoney("Aggregate expenses"),
  soldQtyLitres: optPfiQty("Sold quantity"),
  sold_qty_litres: optPfiQty("Sold quantity"),
  totalAmount: optPfiMoney("Total amount"),
  total_amount: optPfiMoney("Total amount"),
};

/**
 * One truck on a delivery batch's manifest.
 *
 * `loadedQty` is what actually went on, not what the truck holds. That
 * distinction is the whole point of the manifest: a batch built from
 * capacities overstates itself on every truck that loaded short.
 */
const pfiTruck = z.object({
  truckId: id("Truck").optional().nullable(),
  truck_id: id("Truck").optional().nullable(),
  plateNumber: optionalString("Plate number", 50),
  plate_number: optionalString("Plate number", 50),
  capacity: numberLike("Capacity").pipe(z.number().positive("Capacity must be greater than zero")).optional().nullable(),
  loadedQty: numberLike("Loaded quantity").pipe(z.number().positive("A truck that loaded nothing is not on the manifest")),
  loadedAt: optionalString("Loaded at", 40),
  notes: optionalString("Notes", 500),
});

const setPfiTrucks = z.object({
  trucks: z.array(pfiTruck).max(500, "Too many trucks in one manifest"),
});

const createPfi = z.object(pfiBase).refine(
  (d) => (d.pfiNumber && d.pfiNumber.length > 0) || (d.pfi_number && d.pfi_number.length > 0),
  { message: "PFI number is required", path: ["pfiNumber"] }
);
const updatePfi = z.object(pfiBase);

/**
 * An evacuation surplus: how much, the day it was found, and why. The note is
 * required — stock appearing from nowhere is the figure somebody will ask
 * about, and "why" is the answer. See migration 0053.
 */
const pfiSurplusParam = z.object({ id: id("PFI"), entryId: id("Surplus entry") });
const recordPfiSurplus = z.object({
  qtyLitres: numberLike("Surplus quantity").pipe(
    z.number().int("Surplus quantity must be a whole number").positive("Surplus quantity must be greater than zero"),
  ),
  recordedOn: optCalendarDay("Date found").refine((v) => v != null, "Give the date the surplus was found"),
  note: requiredString("Note", 1000),
});
const voidPfiSurplus = z.object({
  reason: requiredString("Reason", 1000),
});

/**
 * Which accounts a PFI collects into — the whole list, not a change to it.
 * Empty is allowed: it is how a PFI is taken off every account.
 */
const pfiAccountsParam = z.object({ pfiId: id("PFI") });
const setPfiAccounts = z.object({
  bankAccountIds: z.array(z.coerce.number().int().positive()).max(50),
});

module.exports = {
  pfiSurplusParam,
  recordPfiSurplus,
  voidPfiSurplus,
  pfiAccountsParam,
  setPfiAccounts,
  setPfiTrucks,
  idParam,
  createProduct, updateProduct, listProducts,
  listTrucks,
  createDriver, updateDriver, listDrivers,
  listPfis,
  listTickets, ticketIdOrCode,
  createStation, updateStation, listStations,
  createInventory, updateInventory, listInventory, bulkCostInventory,
  createStaff, updateStaff, listStaff, updateMyProfile, changeMyPassword,
  createBankAccount, updateBankAccount,
  createBankStatement, bankStatementMapping, matchBankLines,
  createVendor, updateVendor,
  createExpense, updateExpense, createCategory, updateCategory,
  createDangoteProduct, updateDangoteProduct,
  createPfi, updatePfi,
};
