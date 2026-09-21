const { pgEnum } = require("drizzle-orm/pg-core");

// "Pending" is the state POST /auth/register creates into: the customer may
// authenticate and browse, but not order until staff activate them.
const customerStatusEnum = pgEnum("customer_status", [
  "Active",
  "Inactive",
  "Pending",
]);

// A contact is someone we hold a number for who is not a customer. "lead" is
// a sales prospect; "contact" is anyone else worth keeping (a haulier, a
// depot officer, a referrer). Both are messageable — only the first is being
// sold to. There is no "customer" member: becoming one is a phone match
// against the customers table, not a value stored here. See
// db/migrations/0005_contacts_and_leads.sql.
const contactStageEnum = pgEnum("contact_stage", ["lead", "contact"]);

const contactSourceEnum = pgEnum("contact_source", [
  "manual",
  "csv",
  "referral",
  "event",
  "other",
]);

// Which realm a session belongs to. Drives the exclusive arc on `sessions`
// and the domain separation of refresh-token hashes.
const principalTypeEnum = pgEnum("principal_type", ["staff", "customer"]);

const driverStatusEnum = pgEnum("driver_status", [
  "Active",
  "On Trip",
  "Off Duty",
]);

const truckStatusEnum = pgEnum("truck_status", [
  "In Transit",
  "Idle",
  "Maintenance",
]);

const depotStatusEnum = pgEnum("depot_status", [
  "Active",
  "Maintenance",
  "High Capacity",
]);

const orderDeliveryTypeEnum = pgEnum("order_delivery_type", [
  "delivery",
  "pickup",
]);

// Money received, as distinct from where the order is in the pipeline below.
// 'Part Paid' means some of the total has landed and a balance is still
// expected: the order is live and ticketable, but only up to the quantity that
// amount covers (see releasableQuantity in services/order.service.js).
//
// Listed in the database's own order, not the logical one. ALTER TYPE ADD VALUE
// appends, so migration 0020 put 'Part Paid' after 'Paid' in every database
// that already existed — and enum sort order is what an ORDER BY on this column
// actually follows. Writing the logical Unpaid → Part Paid → Paid here would
// describe a type nothing has.
const orderPaymentStatusEnum = pgEnum("order_payment_status", [
  "Unpaid",
  "Paid",
  "Part Paid",
]);

// Pipeline: Pending → Paid → Released → Loading → Completed, with Cancelled as
// an exit. Processing was deliberately not added — the depot confirmed there is
// no distinct action between payment landing and release, so it would be a
// stage with no writer.
/**
 * Whether anyone has agreed what this order costs.
 *
 * A manually written ticket usually carries no price — the customer is given
 * the ticket, the truck loads, and the invoice follows. The sale is real from
 * the moment the truck leaves; only the figure is outstanding.
 *
 * This is a flag and not a zero price on purpose. 0 does not mean "unknown" in
 * this schema, it means free, and every consumer reads it that way — most
 * dangerously findReceivables, which filters on an outstanding balance and
 * would drop a valueless order off the one list built to catch product that
 * left unpaid. On a `pending` order the zeros in price and total_amount are
 * placeholders and are never money. See db/migrations/0049.
 */
const orderPricingStatusEnum = pgEnum("order_pricing_status", ["priced", "pending"]);

const orderStatusEnum = pgEnum("order_status", [
  "Pending",
  "Paid",
  "Released",
  "Loading",
  "Completed",
  "Cancelled",
  // A Pending, unpaid order the customer never funded within the expiry window
  // (ORDER_EXPIRY_HOURS). Distinct from Cancelled — nobody cancelled it, it
  // lapsed — so the two are told apart in history and copy.
  "Expired",
]);

// Who performed an audited action. `system` is the webhook / automatic path;
// the exclusive arc on audit_logs mirrors the sessions table.
const auditActorTypeEnum = pgEnum("audit_actor_type", [
  "staff",
  "customer",
  "system",
]);

// Per-truck movement. Enforced in order: pending → gated_in → loaded → gated_out.
const orderTruckStatusEnum = pgEnum("order_truck_status", [
  "pending",
  "gated_in",
  "loaded",
  "gated_out",
]);

/**
 * A batch's trading life.
 *
 * `not_started` exists because a cargo is bought, shipped and paid for long
 * before it sells anything. Those costs have to land somewhere, and the only
 * place they belong is the batch that incurred them — but a batch that is not
 * selling yet must not answer "how much PMS is on hand", or the stock tiles
 * count product nobody can ship today. So it carries expenses like any other
 * PFI and stays out of every stock and revenue rollup until it is started.
 *
 * Ordered as the lifecycle runs. Nothing depends on the enum's own ordinal —
 * lists are sorted in the application — but a type read straight out of the
 * database should still read in the order the thing actually happens.
 */
const pfiStatusEnum = pgEnum("pfi_status", ["not_started", "active", "finished"]);

/**
 * The expense approval chain.
 *
 * An expense is a payment request, not a record of spending. Only `paid`
 * counts toward a cargo's cost — everything before it is committed money that
 * has not left the bank yet, and is reported separately.
 *
 * `rejected` is terminal; `changes_requested` returns the request to whoever
 * raised it and re-enters the chain at the start when they save.
 */
/**
 * Which of the five daily reports a row is.
 *
 * The system this replaces had no such column — it appended "[SECURITY]" to
 * the submitter's name and filtered on that client-side, which meant the tag
 * leaked into every display of the name and a busy day could push your own
 * reports off the fetched page entirely. A real column filters in SQL.
 */
const reportTypeEnum = pgEnum("report_type", [
  "sales_manager",
  "product_manager",
  "security_gate",
  "commissions",
  "it_compliance",
]);

const expenseStatusEnum = pgEnum("expense_status", [
  "pending",
  "verified",
  "audit_approved",
  "admin_approved",
  "paid",
  "rejected",
  "changes_requested",
]);

const ticketStatusEnum = pgEnum("ticket_status", ["Active", "Redeemed"]);

const depositTypeEnum = pgEnum("deposit_type", ["credit", "debit"]);

// Lifecycle of a wallet hold: money committed at order time ("active"),
// then either spent ("converted", a debit deposit row is written) or
// returned ("released", balance restored with no ledger entry).
const walletHoldStatusEnum = pgEnum("wallet_hold_status", [
  "active",
  "converted",
  "released",
]);

// "customer" is the legacy catch-all; new records should use a specific type.
const deliveryCustomerTypeEnum = pgEnum("delivery_customer_type", [
  "customer",
  "filling_station",
  "third_party",
  "bulk",
  "retail",
  "wholesale",
  "corporate",
  "government",
  "other",
]);

const deliveryCustomerStatusEnum = pgEnum("delivery_customer_status", [
  "active",
  "dormant",
  "suspended",
]);

const deliveryNoteStatusEnum = pgEnum("delivery_note_status", [
  "Pending",
  "In Transit",
  "Delivered",
  "Cancelled",
]);

const loadingStatusEnum = pgEnum("loading_status", [
  "loaded",
  "offloaded",
  "empty",
]);

const depositStatusEnum = pgEnum("deposit_status_enum", [
  "pending",
  "paid",
  "partial",
]);

const paymentMethodEnum = pgEnum("payment_method", [
  "manual",
  "paystack_dva",
]);

/**
 * How a filling-station remittance reached the bank.
 *
 * Kept apart from payment_method, which says who keyed the payment in
 * (a person or the gateway); this says what kind of money movement it was.
 * The column is nullable: every row written before this existed has no
 * channel on record and must not be guessed at, so it reads as unspecified
 * rather than being defaulted into one of these.
 *
 * The pairing is what the ledger reports on — bank charges are the
 * difference between what the POS transacted and what the bank credited,
 * which is only knowable once both sides of a day are entered.
 */
const depositChannelEnum = pgEnum("deposit_channel", [
  "pos",
  "bank_deposit",
]);

const webhookStatusEnum = pgEnum("webhook_status", [
  "pending",
  "processed",
  "failed",
]);

// Fleet ledger entries mirror Django's FleetLedgerEntry: an entry is either
// money spent on a truck or money it earned. Category stays free text there,
// matching the existing workflow.
const fleetEntryTypeEnum = pgEnum("fleet_entry_type", ["expense", "income"]);

// Sign-in providers beyond the phone number (which lives on customers
// itself). One identity row per provider per customer.
const customerIdentityProviderEnum = pgEnum("customer_identity_provider", [
  "email",
  "google",
  "apple",
  "pin",
]);


const dailyReportStatusEnum = pgEnum("daily_report_status", [
  "submitted",
  "approved",
  "rejected",
]);

const incidentTypeEnum = pgEnum("incident_type", [
  "incident",
  "expense",
  "maintenance",
  "observation",
  "compliance",
]);

const incidentStatusEnum = pgEnum("incident_status", [
  "submitted",
  "reviewed",
  "resolved",
  "rejected",
]);

const offlineSaleStatusEnum = pgEnum("offline_sale_status", [
  "pending",
  "approved",
  "rejected",
]);

const releaseStatusEnum = pgEnum("release_status", [
  "pending",
  "confirmed",
  "released",
]);

// Which surface created the customer. Three creation paths now exist and
// telling them apart matters for support and for activation rules — a
// WhatsApp-created customer skipped the OTP because the channel itself
// proved phone control.
const customerCreatedViaEnum = pgEnum("customer_created_via", [
  "desk",
  "portal",
  "whatsapp",
]);

// The conversation engine's states, persisted per session. Mirrors
// whatsapp/constants.js STATES — a session resumes exactly where it stopped.
const waSessionStateEnum = pgEnum("wa_session_state", [
  "IDENTIFY",
  "MENU",
  "DEPOT",
  "PRODUCT",
  "QUANTITY",
  "COMPANY",
  "COLLECT",
  "LOGISTICS",
  "CONFIRM",
  "EXPECTED_PAYMENT",
  "AWAIT_PAYMENT",
]);

const waMessageDirectionEnum = pgEnum("wa_message_direction", [
  "inbound",
  "outbound",
]);

// Inbound: received → processed. Outbound: queued → sent → delivered → read,
// or failed (send exhausted retries) / skipped (kill switch, no template).
// Every hop is recorded — the send path is never fire-and-forget.
const waMessageStatusEnum = pgEnum("wa_message_status", [
  "received",
  "processed",
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
  "skipped",
]);

// Meta owns template approval; this mirrors their verdict locally so an
// outside-window send can check it without a network call.
const waTemplateStatusEnum = pgEnum("wa_template_status", [
  "pending",
  "approved",
  "rejected",
  "paused",
]);

const commissionStatusEnum = pgEnum("commission_status", [
  "pending",
  "paid",
]);

const licenseVerificationStatusEnum = pgEnum("license_verification_status", [
  "pending",
  "approved",
  "rejected",
]);

// ─── Notifications ──────────────────────────────────────────────────────────

// The transports a notification can travel over. `whatsapp` is listed because
// the conversation engine is a real outbound channel and delivery rows need to
// name it; the notification engine does not drive it yet (whatsapp/worker.js
// owns session-window and template rules that a generic fan-out cannot honour).
const notificationChannelEnum = pgEnum("notification_channel", [
  "in_app",
  "push",
  "email",
  "sms",
  "whatsapp",
]);

// Priority drives two decisions and nothing else: whether quiet hours may
// suppress the send, and how the mobile client should present it. `urgent`
// ignores quiet hours — money and security move at any hour.
const notificationPriorityEnum = pgEnum("notification_priority", [
  "low",
  "normal",
  "high",
  "urgent",
]);

// Preferences are stored per CATEGORY, never per type: a customer who mutes
// "marketing" should not have to re-mute it each time a campaign type is added.
// Categories are therefore deliberately coarse and slow-changing.
const notificationCategoryEnum = pgEnum("notification_category", [
  "orders",
  "payments",
  "delivery",
  "tickets",
  "account",
  "security",
  "reports",
  "operations",
  "marketing",
  "system",
]);

const deviceTokenPlatformEnum = pgEnum("device_token_platform", [
  "android",
  "ios",
  "web",
]);

// Per-channel attempt outcome. `skipped` means the channel had nothing to send
// to (no email on file, no live device token); `suppressed` means the
// recipient's preferences or quiet hours refused it. Telling them apart is the
// difference between a data problem and a working opt-out.
const notificationDeliveryStatusEnum = pgEnum("notification_delivery_status", [
  "pending",
  "sent",
  "delivered",
  "failed",
  "skipped",
  "suppressed",
]);

module.exports = {
  customerStatusEnum,
  contactStageEnum,
  contactSourceEnum,
  principalTypeEnum,
  auditActorTypeEnum,
  orderTruckStatusEnum,
  driverStatusEnum,
  truckStatusEnum,
  depotStatusEnum,
  orderDeliveryTypeEnum,
  orderPaymentStatusEnum,
  orderStatusEnum,
  orderPricingStatusEnum,
  pfiStatusEnum,
  expenseStatusEnum,
  reportTypeEnum,
  ticketStatusEnum,
  depositTypeEnum,
  walletHoldStatusEnum,
  deliveryCustomerTypeEnum,
  deliveryCustomerStatusEnum,
  deliveryNoteStatusEnum,
  loadingStatusEnum,
  depositStatusEnum,
  paymentMethodEnum,
  depositChannelEnum,
  webhookStatusEnum,
  fleetEntryTypeEnum,
  customerIdentityProviderEnum,
  dailyReportStatusEnum,
  incidentTypeEnum,
  incidentStatusEnum,
  offlineSaleStatusEnum,
  releaseStatusEnum,
  customerCreatedViaEnum,
  waSessionStateEnum,
  waMessageDirectionEnum,
  waMessageStatusEnum,
  waTemplateStatusEnum,
  commissionStatusEnum,
  licenseVerificationStatusEnum,
  notificationChannelEnum,
  notificationPriorityEnum,
  notificationCategoryEnum,
  deviceTokenPlatformEnum,
  notificationDeliveryStatusEnum,
};
