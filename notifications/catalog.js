const {
  escapeHtml,
  formatMoney,
  formatQuantity,
  formatDate,
  detailRows,
  callToAction,
  callout,
  layout,
} = require("./templates/email");
const { renderDailyReportEmail } = require("./templates/dailyReportEmail");
const { renderPfiDailyReportEmail } = require("./templates/pfiDailyReportEmail");
// SMS is written differently from email: plain sentences, nothing in brackets,
// and N rather than ₦ so the body stays in GSM-7 and bills as one part rather
// than two. Shared with services/sms.service.js — see templates/sms.js.
const {
  money: smsMoney,
  quantity: smsQuantity,
  rateClause: smsRate,
  payTo: smsPayTo,
  thanks: smsThanks,
} = require("./templates/sms");
const {
  companyName,
  companyLongName,
  smsPrefix,
  smsPrefixLoud,
  supportSentence,
} = require("../config/brand");

/**
 * The notification catalog — every kind of notification the platform can send,
 * declared in one file.
 *
 * An entry answers five questions and nothing else:
 *
 *   who is it for   → `audience` ("customer" | "staff")
 *   what is it about→ `category` (the unit preferences are expressed in)
 *   how loud is it  → `priority` (drives quiet-hours suppression)
 *   where does it go→ `channels` (the DEFAULT set; preferences narrow it)
 *   what does it say→ `title` / `body`, plus optional per-channel overrides
 *
 * Business code never writes copy. It calls
 * `notify("order.released", { recipient, data })` and the wording, the routing
 * and the deep link are decided here. That is what makes it possible to change
 * an SMS, add push to a flow, or mute a whole category without touching a
 * controller.
 *
 * DATA CONTRACT: each entry documents the `data` fields its templates read.
 * Templates must tolerate missing fields — an event emitted from a code path
 * that forgot a field should degrade to a vaguer sentence, never throw, because
 * a template crash would take out the notification AND everything queued
 * behind it.
 */

const CHANNELS = Object.freeze({
  IN_APP: "in_app",
  PUSH: "push",
  EMAIL: "email",
  SMS: "sms",
});

// The common shapes, named so entries read as intent rather than as arrays.
const ALL = [CHANNELS.IN_APP, CHANNELS.PUSH, CHANNELS.EMAIL, CHANNELS.SMS];
const APP_ONLY = [CHANNELS.IN_APP, CHANNELS.PUSH];
const APP_AND_EMAIL = [CHANNELS.IN_APP, CHANNELS.PUSH, CHANNELS.EMAIL];
const APP_AND_SMS = [CHANNELS.IN_APP, CHANNELS.PUSH, CHANNELS.SMS];
const EMAIL_ONLY = [CHANNELS.EMAIL];
const SMS_ONLY = [CHANNELS.SMS];
const EMAIL_AND_SMS = [CHANNELS.IN_APP, CHANNELS.EMAIL, CHANNELS.SMS];

// ─── Link helpers ───────────────────────────────────────────────────────────

const trimSlash = (s) => String(s || "").replace(/\/+$/, "");

/** The admin dashboard's origin. */
const adminBase = () => trimSlash(process.env.ADMIN_URL || process.env.CLIENT_URL || "");
/** The customer portal / web app's origin. */
const portalBase = () => trimSlash(process.env.PORTAL_URL || process.env.CLIENT_URL || "");

const adminLink = (path) => (adminBase() ? `${adminBase()}${path}` : null);
const portalLink = (path) => (portalBase() ? `${portalBase()}${path}` : null);

// ─── Copy helpers ───────────────────────────────────────────────────────────

const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "";
/** "Dear Ada, " or "" — never "Dear undefined, ". */
const greet = (name, { formal = true } = {}) => {
  const n = String(name || "").trim();
  if (!n) return "";
  return formal ? `Dear ${n}, ` : `Hi ${firstName(n)}, `;
};
const ref = (d) => d.reference || d.orderNumber || d.requestNumber || d.ticketNumber || "";

/** The generic branded email used when a type has no bespoke document. */
const simpleEmail = ({ subtitle, heading, intro, rows = [], cta, note, tone, subject }) => ({
  subject: subject || heading,
  html: layout({
    subtitle,
    heading,
    intro,
    bodyHtml: [
      rows.length ? detailRows(rows) : "",
      cta?.url ? callToAction(cta.url, cta.label) : "",
      note ? callout(escapeHtml(note), tone || "info") : "",
    ].join(""),
    footNote: supportSentence() || "If you have any questions, please contact our support team.",
  }),
});

/**
 * Paragraph copy, ported verbatim from the Django templates.
 *
 * Those bodies were authored as plain text and wrapped at send time. Rather
 * than re-flow them into detail tables — which would change wording customers
 * already recognise — the sentences are kept and rendered as paragraphs inside
 * the same branded shell every other notification uses.
 *
 * This is deliberately the ONLY renderer for ported copy. In Django three
 * templates (Order Delivered, Payment Failed, Low Stock) were authored as raw
 * HTML, so the sender detected `<html>` and passed them through unwrapped:
 * they arrived as bare Arial with a green or red `<h2>`, visibly a different
 * product from the rest of the mail. Porting them through here is what closes
 * that gap.
 */
const proseEmail = ({ subject, subtitle, heading, paragraphs = [], rows = [], cta, note, tone }) => {
  const text = (p) =>
    `<p style="margin:0 0 16px;color:#475569;font-size:15px;line-height:1.6;">${escapeHtml(p)}</p>`;
  return {
    subject,
    html: layout({
      subtitle,
      heading,
      bodyHtml: [
        paragraphs.filter(Boolean).map(text).join(""),
        rows.length ? detailRows(rows) : "",
        cta?.url ? callToAction(cta.url, cta.label) : "",
        note ? callout(escapeHtml(note), tone || "info") : "",
      ].join(""),
      footNote: `${companyLongName()} • This is an automated notification.`,
    }),
  };
};

/** "1,000 Litres" with the unit Django used in its order copy. */
const unitLabel = (d) => d.unit || d.unitLabel || "Litres";

/**
 * The middle paragraph of the payment-confirmation email.
 *
 * Django branched on `release_type` and produced one of three sentences. The
 * third is not a fallback for a bug — an order can legitimately be confirmed
 * before the customer has settled on collection or delivery — so it stays as a
 * real branch rather than being collapsed into one of the others.
 */
const releaseSentence = (d) => {
  const type = String(d.deliveryType || "").toLowerCase();
  const where = [d.deliveryAddress || d.address, d.state].filter(Boolean).join(", ");

  if (type === "delivery" && where) {
    return (
      `Your order has been approved and scheduled for delivery to ${where}. ` +
      "Our logistics team will contact you with dispatch and estimated delivery details shortly."
    );
  }
  if (type === "pickup" && d.depotName) {
    return (
      "Your order has been approved and released for processing. " +
      `You may proceed to ${d.depotName} for product loading in line with your schedule.`
    );
  }
  return (
    "You may proceed to the selected Depot for product loading, or await delivery to " +
    "the address provided during checkout, as applicable."
  );
};

// ─── Scheduled reports ──────────────────────────────────────────────────────

/**
 * The report mails: Django's "Dear Sir," greeting and "Soroman System"
 * sign-off, with the workbook attached.
 *
 * The attachment rides on the rendered email as `attachments`, which
 * channels/email.js forwards to Resend. `attachmentBase64` rather than a
 * Buffer because the payload crosses the pg-boss queue as JSON, and a Buffer
 * does not survive that round trip intact.
 */
const reportEmail = ({ subject, heading, rows = [], emptyNote, d = {} }) => {
  const mail = proseEmail({
    subject,
    subtitle: "Scheduled Report",
    heading,
    paragraphs: [
      "Dear Sir,",
      emptyNote ||
        "Please find the report for today attached. A summary is shown below.",
    ],
    rows,
    note: d.filename ? `Attached: ${d.filename}` : null,
  });
  return {
    ...mail,
    ...(d.attachmentBase64 && d.filename
      ? { attachments: [{ filename: d.filename, content: d.attachmentBase64 }] }
      : {}),
  };
};

// ─── Expense approval chain ─────────────────────────────────────────────────

/** "Expense #41" — the reference every stage quotes. */
const expenseRef = (d) => `Expense #${d.expenseId ?? d.id ?? ""}`.trim();

/** The payee line Django printed as "name · bank · number". */
const payeeLine = (d) =>
  [d.payeeAccountName, d.payeeBankName, d.payeeAccountNumber].filter(Boolean).join(" · ");

/**
 * The six approval stages, generated from one spec so the six emails cannot
 * drift apart in footer, sign-off or payee formatting — which is exactly how
 * the Django set ended up with three different layouts.
 */
function expenseStages() {
  const base = {
    audience: "staff",
    category: "payments",
    entity: (d) => ({ type: "pfi_expense", id: d.expenseId }),
    data: (d) => ({ screen: "ExpenseDetail", expenseId: d.expenseId }),
    actionUrl: (d) => adminLink(`/expenses?expense=${d.expenseId}`),
  };

  /** Every stage email is the same document with a different lead sentence. */
  const mail = (d, { subject, heading, lead, rows, note, tone }) =>
    proseEmail({
      subject: `${subject} — ${expenseRef(d)}`,
      subtitle: "Expenses",
      heading,
      paragraphs: [lead],
      rows: [
        { label: "Reference", value: expenseRef(d) },
        { label: "Amount", value: formatMoney(d.amount), strong: true },
        ...(rows || []),
      ],
      note,
      tone,
      cta: { url: adminLink(`/expenses?expense=${d.expenseId}`), label: "Open Expense" },
    });

  const payeeRows = (d) => [{ label: "Payee", value: payeeLine(d) }];
  const who = (d) => d.actorName || "A colleague";
  const what = (d) => d.description || d.category || "expense";

  return {
    "expense.pending": {
      ...base,
      priority: "normal",
      channels: EMAIL_AND_SMS,
      title: () => "New expense awaiting verification",
      body: (d) => `${formatMoney(d.amount)} — ${what(d)}`,
      email: (d) =>
        mail(d, {
          subject: "New expense request awaiting verification",
          heading: "An expense request needs your verification",
          lead: "A new expense request needs your verification.",
          rows: [
            { label: "Category", value: d.category },
            { label: "Vendor", value: d.vendor },
            { label: "Submitted by", value: d.submitterName },
          ],
          note: "Please review it on the Expenses page.",
        }),
      sms: (d) => `${smsPrefix()}${expenseRef(d)} for ${what(d)} is awaiting your verification.`,
    },

    "expense.verified": {
      ...base,
      priority: "normal",
      channels: EMAIL_AND_SMS,
      title: () => "Expense verified — your approval needed",
      body: (d) => `${formatMoney(d.amount)} — ${what(d)}`,
      email: (d) =>
        mail(d, {
          subject: "Expense verified — awaiting CFO approval",
          heading: "An expense is awaiting your CFO approval",
          lead: `${who(d)} has verified an expense request. It now needs CFO approval.`,
          rows: payeeRows(d),
        }),
      sms: (d) => `${smsPrefix()}${expenseRef(d)} for ${what(d)} has been verified and is awaiting your CFO approval.`,
    },

    "expense.audit_approved": {
      ...base,
      priority: "normal",
      channels: EMAIL_AND_SMS,
      title: () => "Expense approved — final sign-off needed",
      body: (d) => `${formatMoney(d.amount)} — ${what(d)}`,
      email: (d) =>
        mail(d, {
          subject: "Expense CFO-approved — awaiting final approval",
          heading: "An expense is awaiting your final approval",
          lead: `${who(d)} (CFO) approved an expense for payment. It now needs your final approval.`,
          rows: payeeRows(d),
        }),
      sms: (d) =>
        `${smsPrefix()}${expenseRef(d)} for ${what(d)} has CFO approval and is awaiting your final approval.`,
    },

    "expense.admin_approved": {
      ...base,
      priority: "high",
      channels: EMAIL_AND_SMS,
      title: () => "Expense authorised — ready to pay",
      body: (d) => `${formatMoney(d.amount)} — ${what(d)}`,
      email: (d) =>
        mail(d, {
          subject: "Expense approved for payment",
          heading: "This expense is approved for payment",
          lead: `${who(d)} (Admin) gave final approval. You can now make the payment and mark it paid.`,
          rows: [
            { label: "Pay to", value: d.payeeAccountName },
            { label: "Bank", value: d.payeeBankName },
            { label: "Account", value: d.payeeAccountNumber },
          ],
        }),
      sms: (d) =>
        `${smsPrefix()}${expenseRef(d)} for ${what(d)} is approved for payment. Please pay it and mark it paid.`,
    },

    "expense.paid": {
      ...base,
      priority: "normal",
      channels: EMAIL_AND_SMS,
      title: () => "Expense paid",
      body: (d) => `${formatMoney(d.amount)} — ${what(d)}`,
      email: (d) =>
        mail(d, {
          subject: "Expense paid",
          heading: "This expense has been paid",
          lead: `${who(d)} marked this expense as paid. It now counts towards the PFI's cost.`,
          rows: [
            { label: "Paid to", value: [d.payeeAccountName, d.payeeBankName].filter(Boolean).join(" · ") },
          ],
        }),
      sms: (d) => `${smsPrefix()}${expenseRef(d)} for ${what(d)} has been paid.`,
    },

    "expense.rejected": {
      ...base,
      priority: "high",
      channels: EMAIL_AND_SMS,
      title: () => "Expense rejected",
      body: (d) => `${formatMoney(d.amount)} — ${what(d)}${d.note ? ` — "${d.note}"` : ""}`,
      email: (d) =>
        mail(d, {
          subject: "Expense rejected",
          heading: "This expense request was rejected",
          lead: `${who(d)} rejected this expense request.`,
          rows: [{ label: "Reason", value: d.note }],
          note: "You can edit and resubmit it from the Expenses page.",
          tone: "danger",
        }),
      sms: (d) =>
        `${smsPrefix()}${expenseRef(d)} for ${what(d)} was rejected.${d.note ? ` Reason: ${d.note}` : ""}`,
    },

    "expense.changes_requested": {
      ...base,
      priority: "high",
      channels: EMAIL_AND_SMS,
      title: () => "Expense sent back for changes",
      body: (d) => `${formatMoney(d.amount)} — ${what(d)}${d.note ? ` — "${d.note}"` : ""}`,
      email: (d) =>
        mail(d, {
          subject: "Expense sent back for changes",
          heading: "This expense request was sent back",
          lead: `${who(d)} sent this expense request back for changes.`,
          rows: [{ label: "Reason", value: d.note }],
          note: "You can edit and resubmit it from the Expenses page.",
          tone: "warning",
        }),
      sms: (d) =>
        `${smsPrefix()}${expenseRef(d)} for ${what(d)} was sent back for changes.` +
        `${d.note ? ` Reason: ${d.note}` : ""}`,
    },

    /**
     * Someone said something on the request. Email only: a comment is a
     * conversation, and texting every participant on every remark is how people
     * learn to ignore the channel that also carries the approvals.
     */
    "expense.comment": {
      ...base,
      priority: "normal",
      channels: APP_AND_EMAIL,
      title: (d) => `${who(d)} commented on an expense`,
      body: (d) => d.note || what(d),
      email: (d) =>
        mail(d, {
          subject: "New comment on an expense request",
          heading: `${who(d)} commented on this expense request`,
          lead: `${who(d)} left a comment on a request you are involved in.`,
          rows: [
            { label: "Comment", value: d.note },
            { label: "Stage", value: d.label },
          ],
          note: "Reply from the Expenses page — everyone on the request will see it.",
        }),
    },
  };
}

// ─── Delivery / truck flow ──────────────────────────────────────────────────

/**
 * The nine driver/customer/payer texts, ported verbatim.
 *
 * SMS-only and addressed by phone: a driver is rarely a system user, so there
 * is no inbox to write to and no preference row to consult.
 */
function deliverySms() {
  const P = () => smsPrefixLoud();

  /**
   * The truck number, unbracketed.
   *
   * These texts used to print every value inside square brackets — "your truck
   * [ABC123XY] has been assigned for loading at [Calabar Depot] depot" — and
   * every phone number inside parentheses. A driver reading that on a feature
   * phone is reading a database row, not a message. The brackets are gone and
   * the values sit in the sentence.
   *
   * "TBA" rather than an em-dash when it is unknown: — is not in GSM-7, so one
   * missing truck number was silently doubling the cost of the message.
   * `plateNumber` is still read first because that is what the delivery rows
   * are keyed on; the word the customer sees is "truck".
   */
  const truck = (d) => String(d.plateNumber || d.truckNumber || "").trim() || "TBA";
  /** " on 08012345678" — or nothing, never an empty bracket. */
  const on = (phone) => (phone ? ` on ${phone}` : "");
  const entity = (d) => ({ type: "delivery_inventory", id: d.inventoryId });

  const make = (title, sms, priority = "normal") => ({
    audience: "customer",
    category: "delivery",
    priority,
    channels: SMS_ONLY,
    title: () => title,
    body: (d) => sms(d),
    entity,
    sms,
  });

  return {
    "delivery.truck_loaded": make(
      "Truck assigned for loading",
      (d) =>
        `${P()}your truck ${truck(d)} has been assigned for loading at ` +
        `${d.depotName || "the depot"}. Please report for loading.` +
        `${d.inventoryId ? ` Reference INV-${d.inventoryId}.` : ""}`
    ),

    "delivery.assigned_driver": make(
      "Customer assigned to your truck",
      (d) =>
        `${P()}your truck ${truck(d)} has been assigned to deliver to ` +
        `${d.customerName || "a customer"}${on(d.customerPhone)}. Await further instructions.`
    ),

    "delivery.assigned_customer": make(
      "A truck is assigned to your order",
      (d) =>
        `${P()}truck ${truck(d)} has been assigned to deliver your order.` +
        `${d.driverName ? ` The driver is ${d.driverName}${on(d.driverPhone)}.` : ""}` +
        " You will be notified when loading is confirmed."
    ),

    "delivery.paid_driver": make(
      "Product sold — contact the customer",
      (d) =>
        `${P()}the product in your truck ${truck(d)} has been sold to ` +
        `${d.payerName || "the payer"}${on(d.payerPhone)}. ` +
        `Please contact ${d.customerName || "the customer"}${on(d.customerPhone)} for delivery details.`,
      "high"
    ),

    "delivery.paid_customer": make(
      "Payment received for your delivery",
      (d) =>
        `${P()}payment received for truck ${truck(d)}. ` +
        `Please contact the driver ${d.driverName || ""}${on(d.driverPhone)}`.replace(/ +/g, " ").trimEnd() +
        " to arrange delivery.",
      "high"
    ),

    // Only sent when the payer is not the customer — the caller decides that;
    // sending it unconditionally would text the same person twice.
    "delivery.paid_payer": make(
      "Payment confirmed",
      (d) =>
        `${P()}payment confirmed. Truck ${truck(d)} is on the way with your product.` +
        `${d.driverName ? ` The driver is ${d.driverName}${on(d.driverPhone)}.` : ""}`,
      "high"
    ),

    "delivery.release_confirmed": make(
      "Release confirmed",
      (d) => `${P()}release confirmed for truck ${truck(d)}. Proceed to the exit gate.`,
      "high"
    ),

    "delivery.ticket_driver": make(
      "Ticket generated — cleared for departure",
      (d) =>
        `${P()}${d.ticketNumber ? `ticket ${d.ticketNumber} has been generated` : "your ticket has been generated"}` +
        ` for truck ${truck(d)}. You are cleared for departure.`,
      "high"
    ),

    "delivery.ticket_customer": make(
      "Your delivery is on the way",
      (d) =>
        `${P()}Dear ${d.customerName || "Customer"}, your delivery is on the way on truck ${truck(d)}` +
        `${d.ticketNumber ? `, ticket ${d.ticketNumber}` : ""}.`,
      "high"
    ),
  };
}

/**
 * The admin broadcast, built once and registered under two categories.
 *
 * Copy comes from the sender rather than from here, which is exactly why these
 * are the only entries whose title/body are pass-through.
 *
 * `system.announcement` is operational news nobody should miss — a depot
 * closure, a price change, a maintenance window. `marketing.announcement` is a
 * promotion. They differ ONLY in `category`, which is the unit preferences are
 * expressed in, and that difference is the whole point: a customer who does not
 * want the promos can mute `marketing` and still be told the depot is shut.
 * Before the split, both rode on `system` and muting the adverts meant muting
 * the outage notices too, so nobody sensibly could.
 *
 * Sharing the builder is what stops the two drifting — the deep link, the
 * pass-through copy and the SMS shape have to stay identical, because the
 * category is a routing decision and not a difference in the message.
 *
 * data: title, body, actionUrl, imageUrl, announcementId, link
 */
const announcement = (category) => ({
  audience: "both",
  category,
  priority: "normal",
  channels: APP_ONLY,
  title: (d) => d.title || "Announcement",
  body: (d) => d.body || "",
  entity: (d) => ({ type: "announcement", id: d.announcementId || "" }),
  data: (d) => ({ screen: "Announcement", ...(d.link ? { link: d.link } : {}) }),
  actionUrl: (d) => d.actionUrl || null,
  imageUrl: (d) => d.imageUrl || null,
  // Only reached when a caller overrides `channels` to include email/sms
  // (e.g. the messaging page) — the default APP_ONLY set above never
  // touches either of these.
  // proseEmail, not simpleEmail: the messaging composer's body can be
  // multi-line (e.g. an inserted price list), and simpleEmail's `intro` is
  // one <p> that would collapse every line break into a single paragraph.
  email: (d) =>
    proseEmail({
      subject: d.title || "Announcement",
      subtitle: "Announcement",
      heading: d.title || "Announcement",
      paragraphs: String(d.body || "").split("\n"),
      cta: d.actionUrl ? { url: d.actionUrl, label: "Learn more" } : undefined,
    }),
  // Without this, the engine's defaultSmsText fallback sends
  // "Soroman: {title}. {body}" — doubling up the title (composed for the
  // email subject/in-app heading, not for a 160-char text) ahead of the
  // body the sender actually wrote. Just the brand prefix + body instead.
  sms: (d) => `${smsPrefix()}${String(d.body || d.title || "").trim()}`,
});

// ─── The catalog ────────────────────────────────────────────────────────────

const CATALOG = {
  // ═══ Orders (customer) ════════════════════════════════════════════════════

  /** data: orderId, orderNumber, reference, customerName, product, quantity, unit,
   *        totalAmount, depotName, deliveryType, accountNumber, bankName, accountName */
  "order.created": {
    audience: "customer",
    category: "orders",
    priority: "high",
    // Still APP_ONLY: order.service sends the invoice email and the summary SMS
    // for this event, and routing them here too would double-send. The Django
    // copy is carried below so the wording lives in one place and the day that
    // bespoke path is retired, flipping this to ALL is the whole change.
    channels: APP_ONLY,
    title: (d) => `Order ${ref(d)} received`,
    body: (d) =>
      `Your order for ${formatQuantity(d.quantity, d.unit)} of ${d.product || "fuel"} is awaiting payment` +
      (d.totalAmount ? ` — ${formatMoney(d.totalAmount, { decimals: 0 })}.` : "."),
    entity: (d) => ({ type: "order", id: d.orderId }),
    data: (d) => ({ screen: "OrderDetail", orderId: d.orderId, orderNumber: ref(d) }),
    actionUrl: (d) => portalLink(`/orders/${d.orderId}`),
    dedupe: (d) => (d.orderId ? `order.created:${d.orderId}` : null),

    // Django: "Payment Request & Order Confirmation | Ref: {order_reference}"
    email: (d) =>
      proseEmail({
        subject: `Payment Request & Order Confirmation | Ref: ${ref(d)}`,
        subtitle: "Order Confirmation",
        heading: "Thank you for your order",
        paragraphs: [
          `Dear ${d.customerName || "Customer"},`,
          "Thank you for your order. Please find the summary below:",
        ],
        rows: [
          { label: "Order Reference", value: ref(d) },
          { label: "Product", value: d.product },
          { label: "Quantity", value: formatQuantity(d.quantity, unitLabel(d)) },
          { label: "Total Amount Payable", value: formatMoney(d.totalAmount), strong: true },
          { label: "Bank Name", value: d.bankName },
          { label: "Account Name", value: d.accountName },
          { label: "Account Number", value: d.accountNumber },
        ],
        note:
          "Kindly proceed with payment using the details above to enable immediate processing. " +
          "Once payment is confirmed, your order will be processed promptly.",
        cta: { url: portalLink(`/orders/${d.orderId}`), label: "View Order" },
      }),

    // Django build_short_sms("order_created") — kept near 160 chars for credit cost.
    // No fallback bank details: Django fell back to a hardcoded account, which on
    // any other deployment silently told customers to pay the wrong company.
    // Here the account is a per-order virtual account, so if it is missing the
    // line is simply omitted and the customer is pointed at the portal.
    //
    // One sentence, no bracketed asides and no four-line block of account
    // details: what we received, at what rate, what to pay, where to pay it.
    // The reference is dropped from the account path on purpose — the account
    // IS the reference, being issued per order, and a customer who is told to
    // quote one into a virtual-account transfer is being given work that
    // changes nothing. It stays on the no-account path, where it is the only
    // thing identifying the order.
    sms: (d) => {
      const head =
        `${greet(d.customerName)}we have received your order of ` +
        `${smsQuantity(d.quantity, unitLabel(d))} of ${d.product || "fuel"}` +
        `${smsRate(d.price ?? d.unitPrice, unitLabel(d))}.`;
      const account = smsPayTo(d);
      if (!account) {
        return `${head} Open the ${companyName()} app to complete payment. Your reference is ${ref(d)}.`;
      }
      const ask = d.totalAmount
        ? `Please pay ${smsMoney(d.totalAmount)} to ${account}.`
        : `Please pay to ${account}.`;
      return `${head} ${ask} ${smsThanks()}`;
    },
  },

  /** data: orderId, orderNumber, reference, customerName, totalAmount, amountPaid */
  "order.paid": {
    audience: "customer",
    category: "payments",
    priority: "urgent", // money landed; never hold this for quiet hours
    channels: ALL,
    title: (d) => `Payment confirmed for ${ref(d)}`,
    body: (d) =>
      `We've received your payment${d.amountPaid ? ` of ${formatMoney(d.amountPaid, { decimals: 0 })}` : ""}. ` +
      `Your order is now being prepared.`,
    entity: (d) => ({ type: "order", id: d.orderId }),
    data: (d) => ({ screen: "OrderDetail", orderId: d.orderId, orderNumber: ref(d) }),
    actionUrl: (d) => portalLink(`/orders/${d.orderId}`),
    dedupe: (d) => (d.orderId ? `order.paid:${d.orderId}` : null),
    // Django build_short_sms("payment_received")
    sms: (d) =>
      `${greet(d.customerName)}we have received your payment` +
      `${d.amountPaid ? ` of ${smsMoney(d.amountPaid)}` : ""}` +
      ` for ${smsQuantity(d.quantity, unitLabel(d))} of ${d.product || "Petrol"}` +
      `${d.depotName ? ` at ${d.depotName}` : ""}. ` +
      `Your order is confirmed. ${smsThanks()}`,

    // Django: "Payment Confirmation & Order Processing – {order_reference}"
    email: (d) =>
      proseEmail({
        subject: `Payment Confirmation & Order Processing – ${ref(d)}`,
        subtitle: "Payment Confirmed",
        heading: "We have received your payment",
        paragraphs: [
          `Dear ${d.customerName || "Customer"},`,
          `We confirm receipt of ${formatMoney(d.amountPaid ?? d.totalAmount)} for Order Ref: ${ref(d)}.`,
          releaseSentence(d),
          supportSentence(),
          "Thank you for your continued patronage.",
        ],
        cta: { url: portalLink(`/orders/${d.orderId}`), label: "View Order" },
      }),
  },

  /** data: orderId, orderNumber, reference, customerName, depotName, ticketNumber */
  "order.released": {
    audience: "customer",
    category: "orders",
    priority: "high",
    channels: APP_AND_SMS,
    title: (d) => `Order ${ref(d)} released`,
    body: (d) =>
      `Your order has been released${d.depotName ? ` at ${d.depotName}` : ""} and is ready for loading.`,
    entity: (d) => ({ type: "order", id: d.orderId }),
    data: (d) => ({ screen: "OrderDetail", orderId: d.orderId, orderNumber: ref(d) }),
    actionUrl: (d) => portalLink(`/orders/${d.orderId}`),
    dedupe: (d) => (d.orderId ? `order.released:${d.orderId}` : null),
    sms: (d) =>
      `${greet(d.customerName)}your order ${ref(d)} has been released` +
      `${d.depotName ? ` at ${d.depotName}` : ""} and is ready for loading. ${smsThanks()}`,
  },

  /** data: orderId, reference, customerName, truckNumber, depotName */
  "order.loading": {
    audience: "customer",
    category: "orders",
    priority: "normal",
    channels: APP_ONLY,
    title: (d) => `Loading started for ${ref(d)}`,
    body: (d) =>
      `${d.truckNumber ? `Truck ${d.truckNumber} has` : "Your first truck has"} gated in` +
      `${d.depotName ? ` at ${d.depotName}` : ""}. Loading is under way.`,
    entity: (d) => ({ type: "order", id: d.orderId }),
    data: (d) => ({ screen: "OrderDetail", orderId: d.orderId, orderNumber: ref(d) }),
    actionUrl: (d) => portalLink(`/orders/${d.orderId}`),
    dedupe: (d) => (d.orderId ? `order.loading:${d.orderId}` : null),
  },

  /** data: orderId, reference, customerName, quantity, unit, product */
  "order.completed": {
    audience: "customer",
    category: "orders",
    priority: "normal",
    channels: APP_AND_SMS,
    title: (d) => `Order ${ref(d)} completed`,
    body: (d) =>
      `All trucks have gated out. Your order${d.quantity ? ` of ${formatQuantity(d.quantity, d.unit)}` : ""} is complete.`,
    entity: (d) => ({ type: "order", id: d.orderId }),
    data: (d) => ({ screen: "OrderDetail", orderId: d.orderId, orderNumber: ref(d) }),
    actionUrl: (d) => portalLink(`/orders/${d.orderId}`),
    dedupe: (d) => (d.orderId ? `order.completed:${d.orderId}` : null),

    // Django build_short_sms("released"). Note: that branch accepted a
    // `company` argument and then ignored it, hardcoding the name — reading it
    // from config/brand is the fix.
    sms: (d) =>
      `${greet(d.customerName)}your order ${ref(d)} is complete. ` +
      `${smsThanks()} We look forward to serving you again.`,

    // Django: "Order Successfully Completed – {order_reference}"
    email: (d) =>
      proseEmail({
        subject: `Order Successfully Completed – ${ref(d)}`,
        subtitle: "Order Complete",
        heading: "Your order is complete",
        paragraphs: [
          `Dear ${d.customerName || "Customer"},`,
          `Your order (Ref: ${ref(d)}) has been successfully completed.`,
          "In accordance with your selected option, the product has either been loaded at the " +
            `designated ${companyName()} depot or delivered to your specified address.`,
          `Thank you for your prompt payment and continued trust in ${companyLongName()}.`,
          supportSentence(),
          "We look forward to serving you again.",
        ],
        cta: { url: portalLink(`/orders/${d.orderId}`), label: "View Order" },
      }),
  },

  /** data: orderId, reference, customerName, reason */
  "order.cancelled": {
    audience: "customer",
    category: "orders",
    priority: "high",
    channels: APP_AND_SMS,
    title: (d) => `Order ${ref(d)} cancelled`,
    body: (d) => `Your order has been cancelled.${d.reason ? ` Reason: ${d.reason}` : ""}`,
    entity: (d) => ({ type: "order", id: d.orderId }),
    data: (d) => ({ screen: "OrderDetail", orderId: d.orderId, orderNumber: ref(d) }),
    actionUrl: (d) => portalLink(`/orders/${d.orderId}`),
    dedupe: (d) => (d.orderId ? `order.cancelled:${d.orderId}` : null),
    sms: (d) =>
      `${greet(d.customerName)}your ${companyName()} order ${ref(d)} has been cancelled.` +
      `${d.reason ? ` Reason: ${d.reason}` : ""}`,
  },

  /** data: orderId, orderNumber, reference, customerName — SMS is sent by order.service */
  "order.expired": {
    audience: "customer",
    category: "orders",
    priority: "high",
    channels: APP_ONLY,
    title: (d) => `Order ${ref(d)} expired`,
    body: () =>
      "Payment wasn't received in time, so the price is no longer held. " +
      "Place a new order at today's prices whenever you're ready.",
    entity: (d) => ({ type: "order", id: d.orderId }),
    data: (d) => ({ screen: "OrderDetail", orderId: d.orderId, orderNumber: ref(d) }),
    actionUrl: (d) => portalLink(`/orders/${d.orderId}`),
    dedupe: (d) => (d.orderId ? `order.expired:${d.orderId}` : null),
  },

  /** data: orderId, ticketId, ticketNumber, reference, customerName, deliveryType, depotName */
  "ticket.issued": {
    audience: "customer",
    category: "tickets",
    priority: "high",
    channels: APP_ONLY, // the QR-code email + SMS are ticket.service's bespoke pair
    title: (d) =>
      d.deliveryType === "delivery" ? `Order ${ref(d)} confirmed` : `Pickup ticket ${d.ticketNumber} ready`,
    body: (d) =>
      d.deliveryType === "delivery"
        ? `Your order is confirmed and being prepared for delivery.`
        : `Present this ticket at ${d.depotName || "the depot"} to collect your product.`,
    entity: (d) => ({ type: "ticket", id: d.ticketId || d.ticketNumber }),
    data: (d) => ({
      screen: "TicketDetail",
      ticketId: d.ticketId,
      ticketNumber: d.ticketNumber,
      orderId: d.orderId,
    }),
    actionUrl: (d) => portalLink(`/orders/${d.orderId}`),
    dedupe: (d) => (d.ticketNumber ? `ticket.issued:${d.ticketNumber}` : null),
  },

  /** data: ticketId, ticketNumber, orderId, customerName, redeemedAt, depotName */
  "ticket.redeemed": {
    audience: "customer",
    category: "tickets",
    priority: "normal",
    channels: APP_ONLY,
    title: (d) => `Ticket ${d.ticketNumber} redeemed`,
    body: (d) =>
      `Your ticket was scanned${d.depotName ? ` at ${d.depotName}` : ""}. ` +
      `If this wasn't you, contact Soroman immediately.`,
    entity: (d) => ({ type: "ticket", id: d.ticketId || d.ticketNumber }),
    data: (d) => ({ screen: "TicketDetail", ticketId: d.ticketId, ticketNumber: d.ticketNumber }),
    dedupe: (d) => (d.ticketNumber ? `ticket.redeemed:${d.ticketNumber}` : null),
  },

  // ═══ Dangote bulk requests (customer) ═════════════════════════════════════

  /** data: requestId, requestNumber, customerName, product, quantity, quantityUnit */
  "dangote.request_received": {
    audience: "customer",
    category: "orders",
    priority: "normal",
    channels: APP_ONLY, // the bespoke "received" email is sent by the controller
    title: (d) => `Request ${d.requestNumber} received`,
    body: (d) =>
      `Your Dangote delivery request${d.quantity ? ` for ${formatQuantity(d.quantity, d.quantityUnit)}` : ""} ` +
      `is under review. We'll confirm pricing shortly.`,
    entity: (d) => ({ type: "dangote_request", id: d.requestId }),
    data: (d) => ({ screen: "DangoteOrderDetail", requestId: d.requestId, requestNumber: d.requestNumber }),
    actionUrl: (d) => portalLink(`/dangote-orders/${d.requestId}`),
    dedupe: (d) => (d.requestId ? `dangote.request_received:${d.requestId}` : null),
  },

  /** data: requestId, requestNumber, customerName, totalAmount, product, quantity, quantityUnit */
  "dangote.confirmed": {
    audience: "customer",
    category: "orders",
    priority: "high",
    channels: APP_ONLY, // bespoke confirmation email + SMS sent by the controller
    title: (d) => `Dangote order ${d.requestNumber} confirmed`,
    body: (d) =>
      `Your request has been approved${d.totalAmount ? ` at ${formatMoney(d.totalAmount, { decimals: 0 })}` : ""}. ` +
      `Payment details have been sent to you.`,
    entity: (d) => ({ type: "dangote_request", id: d.requestId }),
    data: (d) => ({ screen: "DangoteOrderDetail", requestId: d.requestId, requestNumber: d.requestNumber }),
    actionUrl: (d) => portalLink(`/dangote-orders/${d.requestId}`),
    dedupe: (d) => (d.requestId ? `dangote.confirmed:${d.requestId}` : null),
  },

  /** data: requestId, requestNumber, customerName — SMS sent by requestExpiry.service */
  "dangote.expired": {
    audience: "customer",
    category: "orders",
    priority: "high",
    channels: APP_ONLY,
    title: (d) => `Dangote order ${d.requestNumber} expired`,
    body: () =>
      "Payment wasn't received in time, so the price is no longer held. " +
      "Submit a new request at today's prices whenever you're ready.",
    entity: (d) => ({ type: "dangote_request", id: d.requestId }),
    data: (d) => ({ screen: "DangoteOrderDetail", requestId: d.requestId, requestNumber: d.requestNumber }),
    dedupe: (d) => (d.requestId ? `dangote.expired:${d.requestId}` : null),
  },

  /** data: requestId, requestNumber, customerName, reason */
  "dangote.rejected": {
    audience: "customer",
    category: "orders",
    priority: "high",
    channels: APP_AND_SMS,
    title: (d) => `Dangote request ${d.requestNumber} declined`,
    body: (d) => `We couldn't proceed with this request.${d.reason ? ` Reason: ${d.reason}` : ""}`,
    entity: (d) => ({ type: "dangote_request", id: d.requestId }),
    data: (d) => ({ screen: "DangoteOrderDetail", requestId: d.requestId, requestNumber: d.requestNumber }),
    dedupe: (d) => (d.requestId ? `dangote.rejected:${d.requestId}` : null),
    sms: (d) =>
      `${greet(d.customerName)}your Dangote request ${d.requestNumber} was declined.` +
      `${d.reason ? ` Reason: ${d.reason}` : ""} Please contact ${companyName()} for help.`,
  },

  // ═══ LPG cooking gas (customer) ═══════════════════════════════════════════

  /** data: requestId, requestNumber, customerName, cylinderSizeKg, cylinderQuantity */
  "lpg.request_received": {
    audience: "customer",
    category: "orders",
    priority: "normal",
    channels: APP_ONLY,
    title: (d) => `LPG request ${d.requestNumber} received`,
    body: (d) =>
      `Your cooking gas request` +
      `${d.cylinderQuantity ? ` for ${d.cylinderQuantity} × ${d.cylinderSizeKg}kg cylinder(s)` : ""}` +
      ` is under review. We'll confirm pricing shortly.`,
    entity: (d) => ({ type: "lpg_request", id: d.requestId }),
    data: (d) => ({ screen: "LpgOrderDetail", requestId: d.requestId, requestNumber: d.requestNumber }),
    actionUrl: (d) => portalLink(`/lpg-orders/${d.requestId}`),
    dedupe: (d) => (d.requestId ? `lpg.request_received:${d.requestId}` : null),
  },

  /** data: requestId, requestNumber, customerName, totalAmount, cylinderSizeKg, cylinderQuantity */
  "lpg.confirmed": {
    audience: "customer",
    category: "orders",
    priority: "high",
    channels: APP_ONLY,
    title: (d) => `LPG order ${d.requestNumber} confirmed`,
    body: (d) =>
      `Your cooking gas order has been approved` +
      `${d.totalAmount ? ` at ${formatMoney(d.totalAmount, { decimals: 0 })}` : ""}. ` +
      `Payment details have been sent to you.`,
    entity: (d) => ({ type: "lpg_request", id: d.requestId }),
    data: (d) => ({ screen: "LpgOrderDetail", requestId: d.requestId, requestNumber: d.requestNumber }),
    actionUrl: (d) => portalLink(`/lpg-orders/${d.requestId}`),
    dedupe: (d) => (d.requestId ? `lpg.confirmed:${d.requestId}` : null),
  },

  /** data: requestId, requestNumber, customerName — SMS sent by requestExpiry.service */
  "lpg.expired": {
    audience: "customer",
    category: "orders",
    priority: "high",
    channels: APP_ONLY,
    title: (d) => `LPG order ${d.requestNumber} expired`,
    body: () =>
      "Payment wasn't received in time, so the price is no longer held. " +
      "Submit a new order at today's prices whenever you're ready.",
    entity: (d) => ({ type: "lpg_request", id: d.requestId }),
    data: (d) => ({ screen: "LpgOrderDetail", requestId: d.requestId, requestNumber: d.requestNumber }),
    dedupe: (d) => (d.requestId ? `lpg.expired:${d.requestId}` : null),
  },

  /** data: requestId, requestNumber, customerName, deliveredAt */
  "lpg.delivered": {
    audience: "customer",
    category: "delivery",
    priority: "normal",
    channels: APP_AND_SMS,
    title: (d) => `LPG order ${d.requestNumber} delivered`,
    body: () => "Your cooking gas has been delivered. Thank you for choosing Soroman!",
    entity: (d) => ({ type: "lpg_request", id: d.requestId }),
    data: (d) => ({ screen: "LpgOrderDetail", requestId: d.requestId, requestNumber: d.requestNumber }),
    dedupe: (d) => (d.requestId ? `lpg.delivered:${d.requestId}` : null),
    sms: (d) =>
      `${greet(d.customerName)}your LPG order ${d.requestNumber} has been delivered. ${smsThanks()}`,
  },

  // ═══ Wallet & payments (customer) ═════════════════════════════════════════

  /** data: amount, balanceAfter, reference, description, customerName */
  "wallet.credited": {
    audience: "customer",
    category: "payments",
    priority: "urgent",
    channels: APP_AND_SMS,
    title: (d) => `${formatMoney(d.amount, { decimals: 0 })} credited`,
    body: (d) =>
      `Your Soroman wallet has been credited.` +
      `${d.balanceAfter !== undefined ? ` New balance: ${formatMoney(d.balanceAfter, { decimals: 0 })}.` : ""}`,
    entity: (d) => ({ type: "wallet", id: d.reference || "" }),
    data: (d) => ({ screen: "Wallet", reference: d.reference, amount: d.amount }),
    actionUrl: () => portalLink("/wallet"),
    dedupe: (d) => (d.reference ? `wallet.credited:${d.reference}` : null),
    sms: (d) =>
      `${greet(d.customerName)}your ${companyName()} wallet has been credited with ${smsMoney(d.amount)}.` +
      `${d.balanceAfter !== undefined ? ` Your new balance is ${smsMoney(d.balanceAfter)}.` : ""}`,
  },

  /** data: amount, balanceAfter, reference, description, customerName */
  "wallet.debited": {
    audience: "customer",
    category: "payments",
    priority: "high",
    channels: APP_ONLY,
    title: (d) => `${formatMoney(d.amount, { decimals: 0 })} debited`,
    body: (d) =>
      `${d.description || "A debit was applied to your wallet."}` +
      `${d.balanceAfter !== undefined ? ` New balance: ${formatMoney(d.balanceAfter, { decimals: 0 })}.` : ""}`,
    entity: (d) => ({ type: "wallet", id: d.reference || "" }),
    data: (d) => ({ screen: "Wallet", reference: d.reference, amount: d.amount }),
    actionUrl: () => portalLink("/wallet"),
    dedupe: (d) => (d.reference ? `wallet.debited:${d.reference}` : null),
  },

  /** data: commissionId, orderNumber, commissionAmount, customerName */
  "commission.earned": {
    audience: "customer",
    category: "payments",
    priority: "normal",
    channels: APP_ONLY,
    title: (d) => `Commission earned: ${formatMoney(d.commissionAmount, { decimals: 0 })}`,
    body: (d) => `You earned commission on order ${d.orderNumber || ""}. It's pending payout.`,
    entity: (d) => ({ type: "commission", id: d.commissionId }),
    data: (d) => ({ screen: "Commissions", commissionId: d.commissionId }),
    actionUrl: () => portalLink("/commissions"),
    dedupe: (d) => (d.commissionId ? `commission.earned:${d.commissionId}` : null),
  },

  /** data: commissionId, commissionAmount, customerName, accountNumber, bankName */
  "commission.paid": {
    audience: "customer",
    category: "payments",
    priority: "high",
    channels: APP_AND_SMS,
    title: (d) => `Commission paid: ${formatMoney(d.commissionAmount, { decimals: 0 })}`,
    body: (d) =>
      `Your commission has been paid out` +
      `${d.bankName ? ` to your ${d.bankName} account` : ""}.`,
    entity: (d) => ({ type: "commission", id: d.commissionId }),
    data: (d) => ({ screen: "Commissions", commissionId: d.commissionId }),
    actionUrl: () => portalLink("/commissions"),
    dedupe: (d) => (d.commissionId ? `commission.paid:${d.commissionId}` : null),
    // Django build_short_sms("commission_paid"). Falls back to the bare phrase
    // "your commission" when no amount is supplied, as Django did.
    sms: (d) => {
      const amount = smsMoney(d.commissionAmount);
      return (
        `${greet(d.customerName)}${amount ? `your commission of ${amount}` : "your commission"}` +
        `${ref(d) ? ` for order ${ref(d)}` : ""} has been paid. ${smsThanks()}`
      );
    },
  },

  // ═══ Delivery / ERP (customer) ════════════════════════════════════════════

  /** data: allocationCode, truckNumber, quantityAllocated, customerName, deliveryId */
  "delivery.released": {
    audience: "customer",
    category: "delivery",
    priority: "high",
    channels: APP_AND_SMS,
    title: (d) => `Delivery ${d.allocationCode || ""} released`.trim(),
    body: (d) =>
      `Truck ${d.truckNumber || "TBA"} has been released with ` +
      `${Number(d.quantityAllocated || 0).toLocaleString()}L.`,
    entity: (d) => ({ type: "delivery", id: d.deliveryId || d.allocationCode }),
    data: (d) => ({ screen: "DeliveryDetail", allocationCode: d.allocationCode, truckNumber: d.truckNumber }),
    dedupe: (d) => (d.allocationCode ? `delivery.released:${d.allocationCode}` : null),
    sms: (d) =>
      `${smsPrefix()}your delivery ${d.allocationCode || ""} has been released on truck ` +
      `${d.truckNumber || "TBA"} with ${smsQuantity(d.quantityAllocated, "Litres")}.`,
  },

  /** data: allocationCode, truckNumber, customerName, deliveryId */
  "delivery.confirmed": {
    audience: "customer",
    category: "delivery",
    priority: "normal",
    channels: APP_ONLY,
    title: (d) => `Delivery ${d.allocationCode || ""} confirmed`.trim(),
    body: (d) => `Your delivery has been confirmed${d.truckNumber ? ` on truck ${d.truckNumber}` : ""}.`,
    entity: (d) => ({ type: "delivery", id: d.deliveryId || d.allocationCode }),
    data: (d) => ({ screen: "DeliveryDetail", allocationCode: d.allocationCode }),
    dedupe: (d) => (d.allocationCode ? `delivery.confirmed:${d.allocationCode}` : null),
  },

  /** data: allocationCode, customerName, reason, deliveryId */
  "delivery.rejected": {
    audience: "customer",
    category: "delivery",
    priority: "high",
    channels: APP_ONLY,
    title: (d) => `Delivery ${d.allocationCode || ""} rejected`.trim(),
    body: (d) => `This delivery was rejected.${d.reason ? ` Reason: ${d.reason}` : ""}`,
    entity: (d) => ({ type: "delivery", id: d.deliveryId || d.allocationCode }),
    data: (d) => ({ screen: "DeliveryDetail", allocationCode: d.allocationCode }),
    dedupe: (d) => (d.allocationCode ? `delivery.rejected:${d.allocationCode}` : null),
  },

  // ═══ Account & security (both realms) ═════════════════════════════════════

  /** data: customerName, licenseId, licenseType, reason */
  "license.approved": {
    audience: "customer",
    category: "account",
    priority: "normal",
    channels: APP_AND_EMAIL,
    title: () => "Licence approved",
    body: (d) => `Your ${d.licenseType || "licence"} has been verified and approved.`,
    entity: (d) => ({ type: "customer_license", id: d.licenseId }),
    data: (d) => ({ screen: "Licenses", licenseId: d.licenseId }),
    actionUrl: () => portalLink("/licenses"),
    dedupe: (d) => (d.licenseId ? `license.approved:${d.licenseId}` : null),
    email: (d) =>
      simpleEmail({
        subtitle: "Licence Verification",
        heading: "Your licence has been approved",
        intro: `${greet(d.customerName)}we've verified your ${d.licenseType || "licence"}. No further action is needed.`,
        cta: { url: portalLink("/licenses"), label: "View Licences" },
      }),
  },

  /** data: customerName, licenseId, licenseType, reason */
  "license.rejected": {
    audience: "customer",
    category: "account",
    priority: "high",
    channels: APP_AND_EMAIL,
    title: () => "Licence needs attention",
    body: (d) =>
      `Your ${d.licenseType || "licence"} could not be verified.` +
      `${d.reason ? ` Reason: ${d.reason}` : " Please upload a clearer copy."}`,
    entity: (d) => ({ type: "customer_license", id: d.licenseId }),
    data: (d) => ({ screen: "Licenses", licenseId: d.licenseId }),
    actionUrl: () => portalLink("/licenses"),
    dedupe: (d) => (d.licenseId ? `license.rejected:${d.licenseId}` : null),
    email: (d) =>
      simpleEmail({
        subtitle: "Licence Verification",
        heading: "Your licence could not be verified",
        intro: `${greet(d.customerName)}we were unable to verify your ${d.licenseType || "licence"}.`,
        note: d.reason || "Please upload a clearer copy from your account.",
        tone: "warning",
        cta: { url: portalLink("/licenses"), label: "Upload Again" },
      }),
  },

  /** data: customerName, status */
  "account.activated": {
    audience: "customer",
    category: "account",
    priority: "high",
    channels: APP_AND_EMAIL,
    title: () => "Your account is active",
    body: () => "You can now place orders on Soroman.",
    entity: (d) => ({ type: "customer", id: d.customerId }),
    data: () => ({ screen: "Home" }),
    actionUrl: () => portalLink("/"),
    dedupe: (d) => (d.customerId ? `account.activated:${d.customerId}` : null),
    email: (d) =>
      simpleEmail({
        subtitle: "Account Activated",
        heading: "Welcome to Soroman",
        intro: `${greet(d.customerName)}your account is active and you can now place orders.`,
        cta: { url: portalLink("/"), label: "Start Ordering" },
      }),
  },

  /**
   * Security notices are never suppressible — `mandatory` removes them from
   * the preference matrix entirely. Someone who muted "security" and then had
   * their account taken over would have muted the only warning they'd get.
   * data: provider, deviceName, ipAddress, at, principalName
   */
  "security.new_login": {
    audience: "both",
    category: "security",
    priority: "urgent",
    mandatory: true,
    channels: APP_ONLY,
    title: () => "New sign-in to your account",
    body: (d) =>
      `A new sign-in${d.provider ? ` via ${d.provider}` : ""}` +
      `${d.deviceName ? ` from ${d.deviceName}` : ""}` +
      `${d.at ? ` on ${formatDate(d.at, { withTime: true })}` : ""}. ` +
      `If this wasn't you, change your password immediately.`,
    entity: (d) => ({ type: "session", id: d.sessionId || "" }),
    data: (d) => ({ screen: "Security", provider: d.provider }),
    dedupe: (d) => (d.sessionId ? `security.new_login:${d.sessionId}` : null),
  },

  /** data: provider, principalName */
  "security.identity_linked": {
    audience: "both",
    category: "security",
    priority: "high",
    mandatory: true,
    channels: APP_ONLY,
    title: (d) => `${d.provider || "A sign-in method"} linked`,
    body: (d) =>
      `${d.provider || "A new sign-in method"} was linked to your account. ` +
      `If this wasn't you, contact Soroman immediately.`,
    entity: (d) => ({ type: "customer_identity", id: d.identityId || "" }),
    data: (d) => ({ screen: "Security", provider: d.provider }),
  },

  /** data: provider, principalName */
  "security.identity_unlinked": {
    audience: "both",
    category: "security",
    priority: "high",
    mandatory: true,
    channels: APP_ONLY,
    title: (d) => `${d.provider || "A sign-in method"} removed`,
    body: (d) =>
      `${d.provider || "A sign-in method"} was removed from your account. ` +
      `If this wasn't you, contact Soroman immediately.`,
    entity: (d) => ({ type: "customer_identity", id: d.identityId || "" }),
    data: (d) => ({ screen: "Security", provider: d.provider }),
  },

  /** data: principalName, at — password/PIN change confirmation */
  "security.credential_changed": {
    audience: "both",
    category: "security",
    priority: "urgent",
    mandatory: true,
    channels: APP_ONLY,
    title: (d) => `Your ${d.credential || "password"} was changed`,
    body: (d) =>
      `Your ${d.credential || "password"} was changed${d.at ? ` on ${formatDate(d.at, { withTime: true })}` : ""}. ` +
      `All other sessions have been signed out. If this wasn't you, contact Soroman immediately.`,
    entity: (d) => ({ type: "credential", id: d.credential || "password" }),
    data: () => ({ screen: "Security" }),
  },

  // ═══ Staff: operations ════════════════════════════════════════════════════

  // ═══ Staff: desks with a backlog ══════════════════════════════════════════
  //
  // One digest per desk per sweep, carrying the count and the oldest few — not
  // a notification per row. A queue that is 75 deep is one fact about the
  // desk, and 75 separate messages is how somebody learns to ignore the bell.
  //
  // Sent only when there IS a backlog. Silence is the right output of a clear
  // queue; a daily "0 pending" trains people to delete these unread.

  /** data: count, hours, oldestHours, examples[], depots[] */
  "staff.tickets_pending": {
    audience: "staff",
    category: "operations",
    priority: "high",
    channels: APP_ONLY,
    title: (d) => `${d.count} order${d.count === 1 ? "" : "s"} waiting on tickets`,
    body: (d) =>
      `${d.count === 1 ? "An order has" : `${d.count} orders have`} been paid for and released without tickets` +
      `${d.oldestHours ? `, the oldest ${d.oldestHours >= 48 ? `${Math.floor(d.oldestHours / 24)} days` : `${d.oldestHours} hours`} ago` : ""}` +
      `${d.depots?.length ? ` (${d.depots.join(", ")})` : ""}.` +
      ` Product cannot leave until they are generated.`,
    entity: () => ({ type: "queue", id: "tickets" }),
    data: () => ({ screen: "Tickets" }),
    actionUrl: () => adminLink(`/ticket`),
    // One per desk per day: a sweep that runs more often must not re-send the
    // same backlog, and the count changing is not new news.
    dedupe: (d) => `staff.tickets_pending:${new Date().toISOString().slice(0, 10)}:${d.count}`,
  },

  /** data: count, hours, oldestHours, examples[], depots[] */
  "staff.trucks_awaiting_entry": {
    audience: "staff",
    category: "operations",
    priority: "normal",
    channels: APP_ONLY,
    title: (d) => `${d.count} truck${d.count === 1 ? "" : "s"} expected at the gate`,
    body: (d) =>
      `${d.count} ticketed truck${d.count === 1 ? " has" : "s have"} not been gated in` +
      `${d.depots?.length ? ` (${d.depots.join(", ")})` : ""}.` +
      ` Gate them in as they arrive so the yard record stays true.`,
    entity: () => ({ type: "queue", id: "gate-entry" }),
    data: () => ({ screen: "SecurityEntry" }),
    actionUrl: () => adminLink(`/security/entry`),
    dedupe: (d) => `staff.trucks_awaiting_entry:${new Date().toISOString().slice(0, 10)}:${d.count}`,
  },

  /** data: count, hours, oldestHours, examples[], depots[] */
  "staff.trucks_on_yard": {
    audience: "staff",
    category: "operations",
    priority: "normal",
    channels: APP_ONLY,
    title: (d) => `${d.count} truck${d.count === 1 ? "" : "s"} still on the yard`,
    body: (d) =>
      `${d.count} truck${d.count === 1 ? " was" : "s were"} gated in and never gated out` +
      `${d.oldestHours ? `, the oldest ${d.oldestHours >= 48 ? `${Math.floor(d.oldestHours / 24)} days` : `${d.oldestHours} hours`} ago` : ""}.` +
      ` Until they are cleared, the yard record says they are still here.`,
    entity: () => ({ type: "queue", id: "gate-exit" }),
    data: () => ({ screen: "SecurityExit" }),
    actionUrl: () => adminLink(`/security/exit`),
    dedupe: (d) => `staff.trucks_on_yard:${new Date().toISOString().slice(0, 10)}:${d.count}`,
  },

  /** data: orderId, reference, customerName, totalAmount, depotName, product, quantity, unit */
  "staff.order_placed": {
    audience: "staff",
    category: "operations",
    priority: "normal",
    channels: APP_AND_EMAIL, // Django mailed the finance team on every order
    title: (d) => `New order ${ref(d)}`,
    body: (d) =>
      `${d.customerName || "A customer"} ordered ${formatQuantity(d.quantity, d.unit)}` +
      `${d.product ? ` of ${d.product}` : ""}` +
      `${d.totalAmount ? ` — ${formatMoney(d.totalAmount, { decimals: 0 })}` : ""}` +
      `${d.depotName ? ` at ${d.depotName}` : ""}.`,
    entity: (d) => ({ type: "order", id: d.orderId }),
    data: (d) => ({ screen: "OrderDetail", orderId: d.orderId }),
    actionUrl: (d) => adminLink(`/orders/${d.orderId}`),
    dedupe: (d) => (d.orderId ? `staff.order_placed:${d.orderId}` : null),

    // Django: "New Order Received – Payment Processing Required ({order_reference})"
    email: (d) =>
      proseEmail({
        subject: `New Order Received – Payment Processing Required (${ref(d)})`,
        subtitle: "Finance",
        heading: "A new order requires payment verification",
        paragraphs: [
          "Dear Finance Team,",
          "A new order has been received and requires payment verification before processing.",
        ],
        rows: [
          { label: "Reference", value: ref(d) },
          { label: "Customer", value: d.customerName },
          { label: "Product", value: d.product },
          { label: "Quantity", value: formatQuantity(d.quantity, unitLabel(d)) },
          { label: "Total Amount", value: formatMoney(d.totalAmount), strong: true },
          { label: "Bank", value: d.bankName },
          { label: "Account Name", value: d.accountName },
          { label: "Account Number", value: d.accountNumber },
        ],
        note:
          "Kindly monitor the designated account and confirm receipt on the dashboard once " +
          "payment reflects, to enable immediate processing.",
        cta: { url: adminLink(`/orders/${d.orderId}`), label: "Open Order" },
      }),
  },

  /** data: orderId, reference, customerName, amountPaid */
  "staff.payment_received": {
    audience: "staff",
    category: "payments",
    priority: "high",
    channels: APP_AND_EMAIL, // Django mailed the release desk on confirmation
    title: (d) => `Payment received — ${ref(d)}`,
    body: (d) =>
      `${d.customerName || "A customer"} paid ${formatMoney(d.amountPaid, { decimals: 0 })}. ` +
      `The order is ready to release.`,
    entity: (d) => ({ type: "order", id: d.orderId }),
    data: (d) => ({ screen: "OrderDetail", orderId: d.orderId }),
    actionUrl: (d) => adminLink(`/orders/${d.orderId}`),
    dedupe: (d) => (d.orderId ? `staff.payment_received:${d.orderId}` : null),

    // Django: "Payment Confirmed – {order_reference}"
    email: (d) =>
      proseEmail({
        subject: `Payment Confirmed – ${ref(d)}`,
        subtitle: "Release Desk",
        heading: `Payment has been confirmed for order ${ref(d)}`,
        rows: [
          { label: "Product", value: d.product },
          { label: "Quantity", value: formatQuantity(d.quantity, unitLabel(d)) },
          { label: "Amount", value: formatMoney(d.amountPaid ?? d.totalAmount), strong: true },
          { label: "Customer", value: d.customerName },
          // Django printed one line or the other depending on the route the
          // order takes; detailRows drops whichever is empty.
          { label: "Depot", value: d.depotName },
          {
            label: "Delivery",
            value: [d.deliveryAddress || d.address, d.state].filter(Boolean).join(", "),
          },
        ],
        paragraphs: [
          "Order is approved and released.",
          "Kindly proceed with loading/delivery arrangements accordingly.",
        ],
        cta: { url: adminLink(`/orders/${d.orderId}`), label: "Open Order" },
      }),
  },

  /** data: requestId, requestNumber, kind ("Dangote"|"LPG"), customerName, quantity, quantityUnit */
  "staff.request_submitted": {
    audience: "staff",
    category: "operations",
    priority: "normal",
    channels: APP_ONLY,
    title: (d) => `New ${d.kind || ""} request ${d.requestNumber}`.replace(/\s+/g, " ").trim(),
    body: (d) =>
      `${d.customerName || "A customer"} submitted a request awaiting pricing and approval.`,
    entity: (d) => ({ type: d.entityType || "request", id: d.requestId }),
    data: (d) => ({ screen: d.screen || "Requests", requestId: d.requestId }),
    actionUrl: (d) => adminLink(d.adminPath || `/requests/${d.requestId}`),
    dedupe: (d) => (d.requestId && d.kind ? `staff.request_submitted:${d.kind}:${d.requestId}` : null),
  },

  /** data: reportId, location, reportDate, submitterName */
  "staff.daily_report_submitted": {
    audience: "staff",
    category: "reports",
    priority: "normal",
    channels: APP_ONLY,
    title: (d) => `Daily report — ${d.location || "site"}`,
    body: (d) =>
      `${d.submitterName || "A staff member"} submitted the report for ${d.reportDate || "today"}. ` +
      `It's awaiting review.`,
    entity: (d) => ({ type: "daily_report", id: d.reportId }),
    data: (d) => ({ screen: "DailyReportDetail", reportId: d.reportId }),
    actionUrl: (d) => adminLink(`/daily-reports/${d.reportId}`),
    dedupe: (d) => (d.reportId ? `staff.daily_report_submitted:${d.reportId}` : null),
  },

  /**
   * The nightly report did not go out.
   *
   * data: reason, at
   *
   * The whole value of an automated report is that nobody has to remember it,
   * which is exactly why silent failure is the dangerous mode: the first sign
   * is somebody noticing weeks later that they have not seen one in a while.
   * SMS as well as email, because the most likely cause of a failed report
   * email is that email itself is not working.
   */
  "staff.report_send_failed": {
    audience: "staff",
    category: "reports",
    priority: "urgent",
    channels: EMAIL_AND_SMS,
    title: () => "Daily report FAILED to send",
    body: (d) => `Tonight's daily report did not go out.${d.reason ? ` ${d.reason}` : ""}`,
    // One alert per day however many times the job retries.
    dedupe: (d) => `staff.report_send_failed:${String(d.at || "").slice(0, 10)}`,
    email: (d) =>
      simpleEmail({
        subject: "ACTION NEEDED — the daily report did not send",
        subtitle: "Scheduled reports",
        heading: "Tonight's daily report failed to send",
        intro:
          "The scheduled 23:50 send did not complete. It will be retried automatically, " +
          "but if this alert repeats the report needs a look.",
        rows: [
          { label: "Reason", value: d.reason },
          { label: "Time", value: d.at },
        ],
        note: "Run `npm run report:daily` to send it by hand once the cause is fixed.",
        tone: "danger",
      }),
    sms: (d) => {
      // The reason comes from an exception message and may or may not end in a
      // full stop; without this the alert reads "...returned 401 It will retry".
      const reason = String(d.reason || "").trim();
      const because = reason ? ` ${reason.replace(/[.\s]*$/, "")}.` : "";
      return `${smsPrefix()}tonight's daily report did not send.${because} It will retry automatically.`;
    },
  },

  /** data: reportId, location, reportDate — to the SUBMITTER */
  "staff.daily_report_approved": {
    audience: "staff",
    category: "reports",
    priority: "normal",
    channels: APP_AND_SMS,
    title: (d) => `Report approved — ${d.location || "site"}`,
    body: (d) => `Your daily report for ${d.reportDate || "the period"} was approved.`,
    entity: (d) => ({ type: "daily_report", id: d.reportId }),
    data: (d) => ({ screen: "DailyReportDetail", reportId: d.reportId }),
    actionUrl: (d) => adminLink(`/daily-reports/${d.reportId}`),
    dedupe: (d) => (d.reportId ? `staff.daily_report_approved:${d.reportId}` : null),
    // Wording preserved from the previous notification.service.js listener.
    sms: (d) =>
      `${smsPrefix()}your daily report for ${d.location || "your site"}` +
      `${d.reportDate ? ` on ${d.reportDate}` : ""} was approved.`,
  },

  /** data: reportId, location, reportDate, comment — to the SUBMITTER */
  "staff.daily_report_rejected": {
    audience: "staff",
    category: "reports",
    priority: "high",
    channels: APP_AND_SMS,
    title: (d) => `Report rejected — ${d.location || "site"}`,
    body: (d) =>
      `Your daily report for ${d.reportDate || "the period"} was rejected.` +
      `${d.comment ? ` Reason: ${d.comment}` : ""}`,
    entity: (d) => ({ type: "daily_report", id: d.reportId }),
    data: (d) => ({ screen: "DailyReportDetail", reportId: d.reportId }),
    actionUrl: (d) => adminLink(`/daily-reports/${d.reportId}`),
    dedupe: (d) => (d.reportId ? `staff.daily_report_rejected:${d.reportId}` : null),
    sms: (d) =>
      `${smsPrefix()}your daily report for ${d.location || "your site"}` +
      `${d.reportDate ? ` on ${d.reportDate}` : ""} was rejected.` +
      `${d.comment ? ` Reason: ${d.comment}` : ""}`,
  },

  /** data: incidentId, incidentType, severity, location, submitterName, summary */
  "staff.incident_submitted": {
    audience: "staff",
    category: "operations",
    // Incidents are the one operational event worth waking someone for.
    priority: "urgent",
    channels: APP_ONLY,
    title: (d) => `${d.incidentType || "Incident"} reported${d.location ? ` — ${d.location}` : ""}`,
    body: (d) =>
      `${d.submitterName || "A staff member"} logged ${d.incidentType || "an incident"}.` +
      `${d.summary ? ` ${d.summary}` : ""}`,
    entity: (d) => ({ type: "incident", id: d.incidentId }),
    data: (d) => ({ screen: "IncidentDetail", incidentId: d.incidentId }),
    actionUrl: (d) => adminLink(`/incidents/${d.incidentId}`),
    dedupe: (d) => (d.incidentId ? `staff.incident_submitted:${d.incidentId}` : null),
  },

  /** data: incidentId, status, incidentType, reviewerName — to the SUBMITTER */
  "staff.incident_updated": {
    audience: "staff",
    category: "operations",
    priority: "normal",
    channels: APP_ONLY,
    title: (d) => `Incident ${d.status || "updated"}`,
    body: (d) =>
      `Your ${d.incidentType || "incident"} report was marked ${d.status || "updated"}` +
      `${d.reviewerName ? ` by ${d.reviewerName}` : ""}.`,
    entity: (d) => ({ type: "incident", id: d.incidentId }),
    data: (d) => ({ screen: "IncidentDetail", incidentId: d.incidentId }),
    actionUrl: (d) => adminLink(`/incidents/${d.incidentId}`),
    dedupe: (d) => (d.incidentId && d.status ? `staff.incident_updated:${d.incidentId}:${d.status}` : null),
  },

  /** data: saleId, reference, status, amount, submitterName */
  "staff.offline_sale_updated": {
    audience: "staff",
    category: "operations",
    priority: "normal",
    channels: APP_ONLY,
    title: (d) => `Offline sale ${d.status || "updated"}`,
    body: (d) =>
      `Sale ${d.reference || `#${d.saleId}`}` +
      `${d.amount ? ` (${formatMoney(d.amount, { decimals: 0 })})` : ""} was ${d.status || "updated"}.`,
    entity: (d) => ({ type: "offline_sale", id: d.saleId }),
    data: (d) => ({ screen: "OfflineSaleDetail", saleId: d.saleId }),
    actionUrl: (d) => adminLink(`/offline-sales/${d.saleId}`),
    dedupe: (d) => (d.saleId && d.status ? `staff.offline_sale_updated:${d.saleId}:${d.status}` : null),
  },

  /** data: truckNumber, truckId, action, actorName */
  "staff.fleet_updated": {
    audience: "staff",
    category: "operations",
    priority: "low",
    channels: [CHANNELS.IN_APP], // ambient; never worth a buzz
    title: (d) => `Truck ${d.truckNumber || ""} ${d.action || "updated"}`.replace(/\s+/g, " ").trim(),
    body: (d) => `${d.actorName || "Someone"} ${d.action || "updated"} truck ${d.truckNumber || ""}.`.trim(),
    entity: (d) => ({ type: "fleet_truck", id: d.truckId }),
    data: (d) => ({ screen: "TruckDetail", truckId: d.truckId }),
    actionUrl: (d) => adminLink(`/fleet/${d.truckId}`),
  },

  /** data: licenseId, customerName, licenseType */
  "staff.license_pending": {
    audience: "staff",
    category: "operations",
    priority: "normal",
    channels: APP_ONLY,
    title: () => "Licence awaiting verification",
    body: (d) =>
      `${d.customerName || "A customer"} uploaded a ${d.licenseType || "licence"} for verification.`,
    entity: (d) => ({ type: "customer_license", id: d.licenseId }),
    data: (d) => ({ screen: "LicenseDetail", licenseId: d.licenseId }),
    actionUrl: (d) => adminLink(`/customer-licenses/${d.licenseId}`),
    dedupe: (d) => (d.licenseId ? `staff.license_pending:${d.licenseId}` : null),
  },

  // ═══ Transactional email only (no inbox row) ══════════════════════════════

  /**
   * `inbox: false` — these are credentials in transit, not something to
   * re-read later. An inbox row would be noise at best; at worst it would
   * surface a reset link inside an account that may already be compromised.
   * data: email, token, firstName
   */
  "account.password_setup": {
    audience: "staff",
    category: "security",
    priority: "urgent",
    mandatory: true,
    inbox: false,
    channels: EMAIL_ONLY,
    title: () => "Set your password",
    body: () => "An account has been created for you on the Soroman Dashboard.",
    email: (d) =>
      simpleEmail({
        subtitle: "Account Setup",
        heading: `Welcome, ${firstName(d.firstName) || "there"}!`,
        intro:
          "An account has been created for you on the Soroman Dashboard. " +
          "To get started, please set your password using the button below.",
        cta: { url: d.setPasswordUrl, label: "Set Your Password" },
        note: "This link will expire in 24 hours. If you did not expect this email, please ignore it.",
        tone: "warning",
      }),
  },

  /** data: email, token, firstName, resetUrl */
  "account.password_reset": {
    audience: "staff",
    category: "security",
    priority: "urgent",
    mandatory: true,
    inbox: false,
    channels: EMAIL_ONLY,
    title: () => "Reset your password",
    body: () => "We received a request to reset your password.",
    email: (d) =>
      simpleEmail({
        subtitle: "Password Reset",
        heading: `Hello, ${firstName(d.firstName) || "there"}!`,
        intro:
          "We received a request to reset your password. " +
          "Click the button below to set a new one.",
        cta: { url: d.resetUrl, label: "Reset Your Password" },
        note:
          "This link will expire in 1 hour. If you did not request a password reset, " +
          "please ignore this email — your password will remain unchanged.",
        tone: "warning",
      }),
  },

  // ═══ System ═══════════════════════════════════════════════════════════════

  /** See the `announcement` builder above for both of these. */
  "system.announcement": announcement("system"),

  // ═══ Marketing ════════════════════════════════════════════════════════════
  // Separately mutable by design — see the builder's note.
  "marketing.announcement": announcement("marketing"),

  // ═══ Ported from Django's raw-HTML templates ══════════════════════════════
  // These three were authored as HTML in Django, so the sender saw a leading
  // <html> and passed them through unwrapped. They arrived as bare Arial with a
  // #4CAF50 or #FF0000 <h2> — recognisably a different product from every other
  // message. Rendering them through the shared shell is the whole point of
  // porting them here rather than copying the markup across.

  /** data: orderId, reference, customerName, deliveryAddress */
  "order.delivered": {
    audience: "customer",
    category: "delivery",
    priority: "high",
    channels: APP_AND_EMAIL,
    title: (d) => `Order ${ref(d)} delivered`,
    body: () => "Your order has been delivered. Please inspect the product on arrival.",
    entity: (d) => ({ type: "order", id: d.orderId }),
    data: (d) => ({ screen: "OrderDetail", orderId: d.orderId }),
    actionUrl: (d) => portalLink(`/orders/${d.orderId}`),
    dedupe: (d) => (d.orderId ? `order.delivered:${d.orderId}` : null),
    email: (d) =>
      proseEmail({
        subject: `Order ${ref(d)} Delivered Successfully`,
        subtitle: "Delivery Complete",
        heading: "Order delivered",
        paragraphs: [
          `Dear ${d.customerName || "Customer"},`,
          `This is to confirm that your order ${ref(d)} has been delivered successfully` +
            `${d.deliveryAddress ? ` to ${d.deliveryAddress}` : " to your address"}.`,
          "Please inspect the product upon delivery. If there are any concerns, please let us " +
            "know within 24 hours.",
          "We appreciate your business and look forward to serving you again.",
        ],
        cta: { url: portalLink(`/orders/${d.orderId}`), label: "View Order" },
      }),
  },

  /** data: orderId, reference, customerName, reason */
  "payment.failed": {
    audience: "customer",
    category: "payments",
    priority: "urgent",
    channels: APP_AND_EMAIL,
    title: (d) => `Payment not successful — ${ref(d)}`,
    body: (d) =>
      `We could not process your payment.${d.reason ? ` ${d.reason}` : ""} ` +
      "Your order stays pending until payment is confirmed.",
    entity: (d) => ({ type: "order", id: d.orderId }),
    data: (d) => ({ screen: "OrderDetail", orderId: d.orderId }),
    actionUrl: (d) => portalLink(`/orders/${d.orderId}`),
    email: (d) =>
      proseEmail({
        subject: `Payment Not Successful – Order ${ref(d)}`,
        subtitle: "Payment Failed",
        heading: "Payment failed",
        paragraphs: [
          `Dear ${d.customerName || "Customer"},`,
          `We attempted to process your payment for Order ${ref(d)}, but it was not successful.`,
          "Please try again using another method, or contact our support team for help. " +
            "Your order will remain pending until payment is confirmed.",
          "Thank you for your understanding.",
        ],
        note: d.reason || null,
        tone: "danger",
        cta: { url: portalLink(`/orders/${d.orderId}`), label: "Retry Payment" },
      }),
  },

  /** data: productName, location, stockQuantity, minimumRequired */
  "stock.low": {
    audience: "staff",
    category: "operations",
    priority: "high",
    channels: APP_AND_EMAIL,
    title: (d) => `Low stock — ${d.productName || "product"}`,
    body: (d) =>
      `${d.productName || "A product"} has dropped below its minimum level` +
      `${d.location ? ` at ${d.location}` : ""}.`,
    entity: (d) => ({ type: "product", id: d.productId }),
    data: (d) => ({ screen: "Inventory", productId: d.productId }),
    actionUrl: () => adminLink("/products"),
    // One alert per product per location per day; without this a depot sitting
    // just under the threshold re-alerts on every stock read.
    dedupe: (d) =>
      d.productId
        ? `stock.low:${d.productId}:${d.location || ""}:${new Date().toISOString().slice(0, 10)}`
        : null,
    email: (d) =>
      proseEmail({
        subject: `Low Stock Alert – ${d.productName || "Product"}`,
        subtitle: "Inventory",
        heading: "Low stock alert",
        paragraphs: [
          "Dear Team,",
          `Please be informed that ${d.productName || "a product"} has dropped below the ` +
            `minimum stock level${d.location ? ` at ${d.location}` : ""}.`,
        ],
        rows: [
          { label: "Current Level", value: formatQuantity(d.stockQuantity, d.unit) },
          { label: "Minimum Required", value: formatQuantity(d.minimumRequired, d.unit) },
        ],
        note: "Kindly take the necessary steps to restock as soon as possible to avoid any disruption.",
        tone: "warning",
        cta: { url: adminLink("/products"), label: "Open Inventory" },
      }),
  },

  // ═══ Expense approval chain (staff) ═══════════════════════════════════════
  // Django paired every stage with a one-line SMS. The in-app rows already
  // existed here; the email and SMS below are what was missing, and routing
  // them through the catalog is what gets them logged in
  // notification_deliveries and gated by each officer's preferences.
  ...expenseStages(),

  // ═══ Scheduled reports (email) ═════════════════════════════════════════════
  //
  // NOTHING DISPATCHES THE NEXT THREE TYPES. The nightly send and the Reports
  // Hub's button both go through `reports.pfi_daily` below — one report, one
  // format. These are the depot-grouped report Django sent, its on-demand twin,
  // and the staff-sales workbook mail, kept as working code rather than deleted
  // because the format took a long time to get right and a rollback should be a
  // one-line change in services/dailyReportDispatch rather than an archaeology
  // exercise. Do not wire one of them back up without deciding which report the
  // desk is meant to be reading — two daily reports in one inbox is how both
  // get ignored.
  //
  // Django sent these from Celery Beat as a bare, unbranded HTML email — staff
  // entries, PFI stock and orders, one section per depot — built by
  // _build_combined_html_report()/send_report_email() (administration/tasks.py).
  //
  // Deliberately NOT run through reportEmail()/layout(): the source format has
  // no wrapper, no CSS classes, no branding — every style is inline, matched to
  // the letter (see notifications/templates/dailyReportEmail.js). data comes
  // straight from services/dailyCombinedReport.service.js's
  // buildCombinedDailyReportData(): { reportDate, totals, locations }.

  "reports.daily": {
    audience: "staff",
    category: "reports",
    priority: "normal",
    channels: EMAIL_ONLY,
    title: (d) => `Daily Report - ${formatDate(d.reportDate)}`,
    body: (d) =>
      `${d.totals?.orderCount ?? 0} order(s) across ${d.locations?.length ?? 0} location(s).`,
    entity: (d) => ({ type: "report", id: String(d.reportDate || "") }),
    email: (d) => renderDailyReportEmail(d),
  },

  "reports.daily_staff_sales": {
    audience: "staff",
    category: "reports",
    priority: "normal",
    channels: EMAIL_ONLY,
    title: (d) => `Daily Staff Sales Report - ${formatDate(d.reportDate)}`,
    body: (d) => `${d.rowCount ?? 0} staff sales report(s) submitted.`,
    entity: (d) => ({ type: "report", id: String(d.reportDate || "") }),
    email: (d) =>
      reportEmail({
        subject: `Daily Staff Sales Report - ${formatDate(d.reportDate)}`,
        heading: `Daily Staff Sales Report — ${formatDate(d.reportDate)}`,
        rows: [{ label: "Reports submitted", value: String(d.rowCount ?? 0) }],
        emptyNote: !d.rowCount ? "No staff sales reports today." : null,
        d,
      }),
  },

  // WAS sent on demand from the Reports Hub's "Email report" button — the same
  // combined report as `reports.daily`, to a recipient list typed in on the
  // spot. That button now sends `reports.pfi_daily`; see the note above.
  //
  // data: reportDate, totals, locations — identical shape to reports.daily.
  "reports.hub_email": {
    audience: "staff",
    category: "reports",
    priority: "normal",
    channels: EMAIL_ONLY,
    title: (d) => `Daily Report - ${formatDate(d.reportDate)}`,
    body: (d) =>
      `${d.totals?.orderCount ?? 0} order(s) across ${d.locations?.length ?? 0} location(s).`,
    entity: (d) => ({ type: "report", id: String(d.reportDate || "") }),
    // The same readable summary the scheduled report sends, with no attachment
    // — deliberately. The Hub's xlsx is for the operator who wants to work the
    // numbers, and that is what "Download report" is for; the email is for
    // reading.
    email: (d) => renderDailyReportEmail(d),
  },

  /**
   * THE daily report: the day's trading assembled per PFI.
   *
   * Sent by the 23:50 cron (services/dailyReportDispatch) and by the Reports
   * Hub's "Email report" button, which is the point — one report, one format,
   * whether it goes out on a schedule or on a click. It replaced the
   * depot-grouped `reports.daily` above, which is kept only for the Hub's
   * older on-demand path.
   *
   * data comes from services/pfiDailyReport.service.js's
   * buildPfiDailyReportData(): { reportDate, summary, pfis, truckSales,
   * stations, staffReports }.
   *
   * No attachment. It used to carry the Hub's workbook when the client sent
   * one; the body now says everything the workbook did, and a spreadsheet
   * nobody opens is a spreadsheet that makes the email look like homework.
   * The Hub's Download button still produces it for anyone who wants to work
   * the numbers at a desk.
   */
  "reports.pfi_daily": {
    audience: "staff",
    category: "reports",
    priority: "normal",
    channels: EMAIL_ONLY,
    title: (d) => `SOROMAN Sales & Operations Report for ${formatDate(d.reportDate)}`,
    body: (d) =>
      `${d.summary?.activePfis ?? 0} active PFI(s), ${d.summary?.activeBatches ?? 0} truck-sales batch(es).`,
    entity: (d) => ({ type: "report", id: String(d.reportDate || "") }),
    email: (d) => renderPfiDailyReportEmail(d),
  },

  // ═══ Delivery / truck flow (SMS) ══════════════════════════════════════════
  // Recipients are drivers, customers and payers who often have no account, so
  // these are addressed by phone and are SMS-only. Every message opens with the
  // brand prefix and wraps identifiers in [brackets], as Django did — the
  // prefix now comes from config/brand rather than a string literal.
  ...deliverySms(),
};

// ─── Accessors ──────────────────────────────────────────────────────────────

/**
 * The fallback for an unknown type.
 *
 * A typo in a `notify()` call must not silently drop the notification — the
 * recipient still gets something readable and the delivery row still names the
 * type, so the mistake is visible in the log rather than invisible in a
 * swallowed exception.
 */
const UNKNOWN = {
  audience: "both",
  category: "system",
  priority: "normal",
  channels: [CHANNELS.IN_APP],
  title: (d) => d.title || "Notification",
  body: (d) => d.body || "",
};

const getType = (type) => CATALOG[type] || null;
const getTypeOrDefault = (type) => CATALOG[type] || UNKNOWN;
const isKnownType = (type) => Object.prototype.hasOwnProperty.call(CATALOG, type);
const listTypes = () => Object.keys(CATALOG);

/** The categories a given audience can actually receive — powers the settings UI. */
const categoriesFor = (audience) => {
  const set = new Set();
  for (const entry of Object.values(CATALOG)) {
    if (entry.mandatory) continue; // not user-controllable, so not shown
    if (entry.audience === audience || entry.audience === "both") set.add(entry.category);
  }
  return [...set].sort();
};

/** Default channel toggles per category, for rendering an untouched settings screen. */
const defaultPreferencesFor = (audience) => {
  const byCategory = {};
  for (const entry of Object.values(CATALOG)) {
    if (entry.mandatory) continue;
    if (entry.audience !== audience && entry.audience !== "both") continue;
    const current = (byCategory[entry.category] ||= {
      inApp: false,
      push: false,
      email: false,
      sms: false,
    });
    // A category offers a channel if ANY of its types uses it.
    for (const channel of entry.channels || []) {
      if (channel === CHANNELS.IN_APP) current.inApp = true;
      if (channel === CHANNELS.PUSH) current.push = true;
      if (channel === CHANNELS.EMAIL) current.email = true;
      if (channel === CHANNELS.SMS) current.sms = true;
    }
  }
  return byCategory;
};

module.exports = {
  CATALOG,
  CHANNELS,
  UNKNOWN,
  getType,
  getTypeOrDefault,
  isKnownType,
  listTypes,
  categoriesFor,
  defaultPreferencesFor,
  // Exported for the engine's renderers and for tests.
  helpers: { greet, firstName, ref, simpleEmail, adminLink, portalLink },
};
