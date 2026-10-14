const { sql } = require("drizzle-orm");

/**
 * A vendor's money, as dated events: the invoices we approved and what we paid
 * against them. The source the vendor statement reads, and later the general
 * ledger.
 *
 *   invoice   an expense approved for payment (or recorded as already paid),
 *             at what the vendor is owed — `amount`, which is the invoice less
 *             WHT and, where it is kept back (0066), less VAT. In naira, from
 *             the generated `amount_ngn`.
 *   payment   the same expense paid: `amount_paid_ngn`, on the day it cleared
 *             (payment_date), falling back to when it was marked paid.
 *
 * An expense still on its way through approval is owed to nobody yet. It is
 * counted apart, as "awaiting approval", and never in the balance.
 *
 * Refund expenses (0065) are left out. The money went to a customer, not to
 * this vendor, and the customer statement already shows the refund.
 */

const APPROVED = ["admin_approved", "paid"];
const IN_APPROVAL = ["pending", "verified", "audit_approved", "changes_requested"];

const LAGOS_DAY = (col) => sql.raw(`to_char(${col} AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD')`);

async function vendorSources(db, { vendorId }) {
  const id = Number(vendorId);
  const rowsOf = (r) => r.rows ?? r;

  const expenses = rowsOf(await db.execute(sql`
    WITH mine AS (
      SELECT e.*,
             -- When we came to owe it: final approval; for one recorded as
             -- already paid, the day it was paid; failing both, its own date.
             COALESCE(e.admin_approved_at, e.payment_date, e.expense_date, e.created_at) AS owed_at,
             COALESCE(e.payment_date, e.paid_at) AS paid_on,
             -- Naira per unit of the invoice's currency; null for a foreign
             -- invoice nobody has put a rate on yet.
             CASE WHEN COALESCE(e.currency, 'NGN') = 'NGN' THEN 1 ELSE e.exchange_rate END AS rate
        FROM pfi_expenses e
       WHERE e.vendor_id = ${id} AND e.deleted_at IS NULL
    )
    SELECT e.id, e.reference_number AS reference, e.status::text AS status, e.description,
           e.invoice_number AS "invoiceNumber", c.name AS category, p.pfi_number AS "pfiNumber",
           COALESCE(e.currency, 'NGN') AS currency, e.amount::numeric AS amount,
           COALESCE(e.amount_ngn, CASE WHEN e.rate = 1 THEN e.amount END)::numeric AS "owedNgn",
           COALESCE(e.amount_paid_ngn, CASE WHEN e.rate = 1 THEN e.amount_paid END)::numeric AS "paidNgn",
           CASE WHEN e.vat_withheld THEN ROUND(COALESCE(e.vat_amount, 0) * e.rate, 2) ELSE 0 END AS "vatKept",
           ROUND(COALESCE(e.wht_deduction, 0) * e.rate, 2) AS "whtKept",
           e.owed_at AS "owedAt", ${LAGOS_DAY("e.owed_at")} AS "owedDay",
           e.paid_on AS "paidAt", ${LAGOS_DAY("e.paid_on")} AS "paidDay",
           e.bank_paid_from AS "bankPaidFrom", e.payment_reference AS "paymentReference"
      FROM mine e
      JOIN expense_categories c ON c.id = e.category_id
      LEFT JOIN pfis p ON p.id = e.pfi_id
     WHERE NOT COALESCE(c.is_refund, false)
  `));

  const approved = expenses.filter((e) => APPROVED.includes(e.status));
  const inApproval = expenses.filter((e) => IN_APPROVAL.includes(e.status));
  return {
    approved,
    awaitingApproval: {
      count: inApproval.length,
      value: inApproval.reduce((n, e) => n + (Number(e.owedNgn) || 0), 0),
    },
  };
}

module.exports = { vendorSources, APPROVED, IN_APPROVAL };
