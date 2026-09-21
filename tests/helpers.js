require("dotenv").config();
const { staffRepo, customerRepo } = require("../repositories");
const { client } = require("../config/db");

/**
 * Declares the native-app transport, which is the only mode that returns the
 * refresh token in the response body. Browsers get an httpOnly cookie instead,
 * so any test that needs to hold a refresh token must ask for this — exactly
 * as the mobile client does.
 */
const NATIVE_TRANSPORT = { "X-Auth-Transport": "body" };

const TEST_CUSTOMER = {
  name: "Test Customer",
  // Must be a MOBILE number, not TOLL_FREE — the OTP path requires an
  // SMS-capable type, so a toll-free fixture would pass storage and fail send.
  phone: "+2348099999999",
  companyName: "Test Co",
};

const TEST_STAFF = {
  firstName: "Test",
  surname: "Staff",
  email: "test-staff@soroman.test",
  password: "TestPassw0rd!",
  roles: ["admin", "super_admin"],
};

/** Idempotently ensure a login-capable staff row exists. */
async function ensureTestStaff() {
  const existing = await staffRepo.findByEmail(TEST_STAFF.email);
  if (existing) {
    // Always reset the credential so a half-written row from an earlier run
    // cannot poison the suite. update() hashes `password` itself.
    await staffRepo.update(existing.id, {
      password: TEST_STAFF.password,
      isPasswordSet: true,
      roles: TEST_STAFF.roles,
      isActive: true,
      suspended: false,
    });
    return staffRepo.findByEmail(TEST_STAFF.email);
  }
  // NOTE: staffRepo.create hashes `password` itself — pass it in plaintext.
  return staffRepo.create({
    firstName: TEST_STAFF.firstName,
    surname: TEST_STAFF.surname,
    email: TEST_STAFF.email,
    password: TEST_STAFF.password,
    isPasswordSet: true,
    roles: TEST_STAFF.roles,
    isActive: true,
    suspended: false,
  });
}

/**
 * The postgres pool keeps the event loop alive; tests must close it.
 * Idempotent — several test files each register an after() hook.
 */
let closed = false;
async function closeDb() {
  if (closed) return;
  closed = true;
  await client.end({ timeout: 5 });
}

/**
 * A staff row holding exactly the given roles, plus a real access token for it.
 *
 * Hand-signing a JWT no longer works: tokens must carry a `sid` bound to a live
 * session, so tests have to go through the real issue path.
 */
async function staffTokenWithRoles(roles, email = "test-weak-staff@soroman.test") {
  const sessionService = require("../services/session.service");
  const existing = await staffRepo.findByEmail(email);
  const staffRow = existing
    ? await staffRepo.update(existing.id, { roles, isActive: true, suspended: false })
    : await staffRepo.create({
        firstName: "Weak",
        surname: "Staff",
        email,
        password: "TestPassw0rd!",
        isPasswordSet: true,
        roles,
        isActive: true,
        suspended: false,
      });

  const { accessToken, refreshToken } = await sessionService.issue("staff", staffRow, {});
  return { staff: staffRow, accessToken, refreshToken };
}

/** Log in and return an access token. */
async function staffToken(request, app) {
  await ensureTestStaff();
  const res = await request(app)
    .post("/api/auth/login")
    .send({ email: TEST_STAFF.email, password: TEST_STAFF.password });
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.accessToken;
}

/** Idempotently ensure a customer row exists, for session/OTP fixtures. */
async function ensureTestCustomer() {
  const existing = await customerRepo.findByPhone(TEST_CUSTOMER.phone);
  if (existing) return existing;
  return customerRepo.create({
    name: TEST_CUSTOMER.name,
    phone: TEST_CUSTOMER.phone,
    companyName: TEST_CUSTOMER.companyName,
    status: "Pending",
  });
}


/**
 * Pay an order the only way an order can now be paid: against a bank statement
 * line recorded on it.
 *
 * Fixtures used to do this with `orderService.payOrder({ orderId, actor })`,
 * which credited a wallet and drew the order's total back out of it. That path
 * is gone (see db/migrations/0021), and with it the ability to mark an order
 * paid without saying what paid for it.
 *
 * So the helper manufactures the evidence: one UNMATCHED statement line for
 * exactly `amount` (the order's outstanding balance by default), on a bank
 * account shared by the whole test run, then confirms the order against it.
 * Passing a smaller `amount` produces a part payment, which is the shape a
 * real part payment has too.
 *
 * @param {number} orderId
 * @param {number} [amount]  defaults to whatever the order still owes
 * @returns the updated order
 */
let sharedBankAccount = null;
let sharedStatement = null;
let statementLineSeq = 0;

/** The one bank account and statement every payment fixture hangs off. */
async function ensureFixtureBankAccount() {
  if (sharedBankAccount) return sharedBankAccount;
  const { db } = require("../config/db");
  const { bankAccounts, bankStatements } = require("../db/schema");
  const stamp = Date.now().toString().slice(-8);
  [sharedBankAccount] = await db
    .insert(bankAccounts)
    .values({
      bankName: "Test Bank",
      accountName: "SOROMAN TEST FIXTURES",
      accountNumber: `90${stamp}`,
      status: "Active",
    })
    .returning();
  [sharedStatement] = await db
    .insert(bankStatements)
    .values({ bankAccountId: sharedBankAccount.id, filename: `fixtures-${stamp}.csv` })
    .returning();
  return sharedBankAccount;
}

/**
 * Today as a statement day — "YYYY-MM-DD", in Lagos.
 *
 * bank_statement_lines.txn_date is a `date` column, which Drizzle binds as a
 * string. The fixtures passed a Date object, which postgres.js refuses outright
 * ("The string argument must be of type string… Received an instance of Date"),
 * so every test built on a statement line failed at setup — 26 of them across
 * order-payments, partial-payment and payment-after-delivery — while reading as
 * though the payment code under test were broken.
 *
 * Lagos rather than UTC because a statement day is the bank's calendar day,
 * and between midnight and 1am WAT the UTC date is still yesterday.
 */
function todayStatementDay() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
}

async function payOrderWithStatementLine(orderId, amount = null) {
  // Required late: config/db must not be reached before dotenv has run, and
  // these modules pull it in transitively.
  const { db } = require("../config/db");
  const { eq } = require("drizzle-orm");
  const {
    orders, bankStatementLines,
  } = require("../db/schema");
  const orderService = require("../services/order.service");

  await ensureFixtureBankAccount();

  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw new Error(`payOrderWithStatementLine: order ${orderId} not found`);
  const owing = Number(order.totalAmount) - Number(order.amountPaid || 0);
  const value = amount == null ? owing : Number(amount);

  statementLineSeq += 1;
  const key = `${Date.now().toString(36)}-${statementLineSeq}`;
  const [line] = await db
    .insert(bankStatementLines)
    .values({
      statementId: sharedStatement.id,
      bankAccountId: sharedBankAccount.id,
      txnDate: todayStatementDay(),
      amount: String(value),
      depositor: "TEST FIXTURE PAYER",
      narration: `Fixture payment for order ${orderId}`,
      bankRef: `FIXREF-${key}`,
      dedupKey: `FIXDEDUP-${key}`,
      status: "UNMATCHED",
    })
    .returning();

  return orderService.confirmOrderPayment({
    orderId,
    bankAccountId: sharedBankAccount.id,
    lineIds: [line.id],
    actor: { type: "system" },
    notifyWhatsApp: false,
  });
}


/**
 * A wallet hold as the old payment path left one: the balance already debited,
 * an `active` row against the order.
 *
 * placeHold() is gone — orders are no longer paid out of a wallet (see
 * db/migrations/0021) — but holds placed under that flow are still active in
 * the live data and have to resolve correctly when their orders are cancelled
 * or deleted. Tests covering that resolution need to be able to create one, so
 * the fixture writes it directly rather than through a function that no longer
 * exists.
 */
async function seedLegacyHold({ customerId, orderId, amount, description = "legacy hold" }) {
  const { db } = require("../config/db");
  const { walletHolds } = require("../db/schema");
  const { customerRepo: repo } = require("../repositories");

  const debited = await repo.debitBalance(customerId, Number(amount));
  if (!debited) throw new Error("seedLegacyHold: customer balance cannot cover the hold");
  const [hold] = await db
    .insert(walletHolds)
    .values({ customerId, orderId, amount: String(amount), description })
    .returning();
  return hold;
}


/**
 * An UNMATCHED bank statement line for `amount`, on the shared fixture
 * account — the raw material a payment is made of.
 *
 * For tests that drive the HTTP surface (`POST /api/orders/:id/payments`) and
 * so need the ids rather than a finished payment.
 */
async function makeStatementLine(amount, depositor = "TEST FIXTURE PAYER") {
  const { db } = require("../config/db");
  const { bankStatementLines } = require("../db/schema");

  await ensureFixtureBankAccount();
  statementLineSeq += 1;
  const key = `${Date.now().toString(36)}-${statementLineSeq}`;
  const [line] = await db
    .insert(bankStatementLines)
    .values({
      statementId: sharedStatement.id,
      bankAccountId: sharedBankAccount.id,
      txnDate: todayStatementDay(),
      amount: String(amount),
      depositor,
      narration: `NIP/${depositor}/${key}`,
      bankRef: `FIXREF-${key}`,
      dedupKey: `FIXDEDUP-${key}`,
      status: "UNMATCHED",
    })
    .returning();
  return { line, bankAccountId: sharedBankAccount.id, lineIds: [line.id] };
}

module.exports = {
  NATIVE_TRANSPORT,
  TEST_STAFF,
  TEST_CUSTOMER,
  ensureTestStaff,
  ensureTestCustomer,
  staffToken,
  staffTokenWithRoles,
  closeDb,
  payOrderWithStatementLine,
  seedLegacyHold,
  makeStatementLine,
};
