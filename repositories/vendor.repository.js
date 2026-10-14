const { client } = require("../db");

const mapVendor = (row) =>
  !row
    ? null
    : {
        id: row.id,
        name: row.name,
        contactPerson: row.contact_person || "",
        phone: row.phone || "",
        email: row.email || "",
        address: row.address || "",
        bankName: row.bank_name || "",
        accountNumber: row.account_number || "",
        accountName: row.account_name || "",
        taxId: row.tax_id || "",
        status: row.status || "Active",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };

const vendorRepo = {
  async findAll({ search, status } = {}) {
    const where = [client`true`];
    if (search) where.push(client`name ILIKE ${"%" + search + "%"}`);
    if (status && status !== "all") where.push(client`status = ${status}`);
    const clause = where.reduce((a, c, i) => (i === 0 ? c : client`${a} AND ${c}`));

    const rows = await client`
      SELECT * FROM vendors WHERE ${clause} ORDER BY name ASC
    `;
    return rows.map(mapVendor);
  },

  async findById(id) {
    const numericId = Number(id);
    if (!Number.isFinite(numericId)) return null;
    const [row] = await client`SELECT * FROM vendors WHERE id = ${numericId} LIMIT 1`;
    return mapVendor(row);
  },

  /**
   * The vendor this name already belongs to, if any. Case, spacing and
   * punctuation are ignored — "Keonamex Marine Ltd." and "KEONAMEX marine ltd"
   * are one vendor, and saving them as two splits its spend in two. The
   * request form matches names the same way (VendorField's vendorKey).
   */
  async findByName(name) {
    const key = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!key) return null;
    const [row] = await client`
      SELECT * FROM vendors
      WHERE regexp_replace(LOWER(name), '[^a-z0-9]', '', 'g') = ${key}
      ORDER BY id LIMIT 1`;
    return mapVendor(row);
  },

  async create(data) {
    const [row] = await client`
      INSERT INTO vendors (
        name, contact_person, phone, email, address,
        bank_name, account_number, account_name, tax_id, status, created_by
      ) VALUES (
        ${data.name}, ${data.contactPerson || ""}, ${data.phone || ""}, ${data.email || ""}, ${data.address || ""},
        ${data.bankName || ""}, ${data.accountNumber || ""}, ${data.accountName || ""}, ${data.taxId || ""},
        ${data.status || "Active"}, ${data.createdBy ?? null}
      )
      RETURNING *
    `;
    return mapVendor(row);
  },

  async update(id, data) {
    const numericId = Number(id);
    if (!Number.isFinite(numericId)) return null;
    const existing = await this.findById(numericId);
    if (!existing) return null;

    const merged = { ...existing, ...data };
    const [row] = await client`
      UPDATE vendors SET
        name = ${merged.name},
        contact_person = ${merged.contactPerson || ""},
        phone = ${merged.phone || ""},
        email = ${merged.email || ""},
        address = ${merged.address || ""},
        bank_name = ${merged.bankName || ""},
        account_number = ${merged.accountNumber || ""},
        account_name = ${merged.accountName || ""},
        tax_id = ${merged.taxId || ""},
        status = ${merged.status || "Active"},
        updated_at = NOW()
      WHERE id = ${numericId}
      RETURNING *
    `;
    return mapVendor(row);
  },

  /**
   * Every vendor's money at a glance, read by the vendor statement's own rules
   * (lib/accounting/sources/vendorExpenses), so a vendor's "owed now" here is
   * its statement's closing balance:
   *
   *   billed    an expense approved for payment (or recorded as paid), at
   *             what the vendor is owed — the invoice less WHT, and less VAT
   *             where we keep it back — on the day it was approved
   *   paid      the same expense paid, on the day it cleared
   *   waiting   still on its way through approval: owed to nobody yet
   *
   * Refund expenses are not a vendor's. Billed, paid and tax kept back are for
   * the period asked for; owed now, waiting and the oldest unpaid bill are as
   * things stand today.
   *
   * @param {{ vendorId?: number, search?: string, status?: string, from?: string, to?: string }} p  Lagos days
   */
  async withMoney({ vendorId = null, search = "", status = "", from = null, to = null } = {}) {
    const rows = await client`
      WITH e AS (
        SELECT e.vendor_id, e.status::text AS status, c.name AS category,
               CASE WHEN COALESCE(e.currency, 'NGN') = 'NGN' THEN 1 ELSE e.exchange_rate END AS rate,
               e.amount, e.amount_ngn, e.amount_paid, e.amount_paid_ngn, e.vat_withheld, e.vat_amount, e.wht_deduction,
               (COALESCE(e.admin_approved_at, e.payment_date, e.expense_date, e.created_at) AT TIME ZONE 'Africa/Lagos')::date AS owed_day,
               (COALESCE(e.payment_date, e.paid_at) AT TIME ZONE 'Africa/Lagos')::date AS paid_day
          FROM pfi_expenses e JOIN expense_categories c ON c.id = e.category_id
         WHERE e.vendor_id IS NOT NULL AND e.deleted_at IS NULL AND NOT COALESCE(c.is_refund, false)
           AND (${vendorId}::int IS NULL OR e.vendor_id = ${vendorId})
      ), m AS (
        SELECT e.*,
               COALESCE(amount_ngn, CASE WHEN rate = 1 THEN amount END) AS owed_ngn,
               COALESCE(amount_paid_ngn, CASE WHEN rate = 1 THEN amount_paid END) AS paid_ngn,
               status IN ('admin_approved', 'paid') AS approved,
               status IN ('pending', 'verified', 'audit_approved', 'changes_requested') AS waiting,
               (${from}::date IS NULL OR owed_day >= ${from}::date) AND (${to}::date IS NULL OR owed_day <= ${to}::date) AS billed_in,
               (${from}::date IS NULL OR paid_day >= ${from}::date) AND (${to}::date IS NULL OR paid_day <= ${to}::date) AS paid_in
          FROM e
      ), agg AS (
        SELECT vendor_id,
               COALESCE(SUM(owed_ngn) FILTER (WHERE approved), 0)
                 - COALESCE(SUM(paid_ngn) FILTER (WHERE status = 'paid' AND paid_day IS NOT NULL), 0) AS owed_now,
               COALESCE(SUM(owed_ngn) FILTER (WHERE approved AND billed_in), 0) AS billed,
               COALESCE(SUM(paid_ngn) FILTER (WHERE status = 'paid' AND paid_day IS NOT NULL AND paid_in), 0) AS paid,
               COALESCE(SUM(CASE WHEN vat_withheld THEN ROUND(COALESCE(vat_amount, 0) * rate, 2) ELSE 0 END) FILTER (WHERE approved AND billed_in), 0) AS vat_kept,
               COALESCE(SUM(ROUND(COALESCE(wht_deduction, 0) * rate, 2)) FILTER (WHERE approved AND billed_in), 0) AS wht_kept,
               COUNT(*) FILTER (WHERE waiting) AS waiting_count,
               COALESCE(SUM(owed_ngn) FILTER (WHERE waiting), 0) AS waiting_amount,
               COUNT(*) FILTER (WHERE status <> 'rejected') AS expense_count,
               MIN(owed_day) FILTER (WHERE status = 'admin_approved') AS oldest_unpaid,
               MAX(paid_day) FILTER (WHERE status = 'paid') AS last_paid,
               MAX(owed_day) FILTER (WHERE approved) AS last_billed,
               MODE() WITHIN GROUP (ORDER BY category) FILTER (WHERE status <> 'rejected') AS usually
          FROM m GROUP BY vendor_id
      )
      SELECT v.*, a.owed_now, a.billed, a.paid, a.vat_kept, a.wht_kept, a.waiting_count, a.waiting_amount,
             a.expense_count, a.oldest_unpaid::text AS oldest_unpaid, a.last_paid::text AS last_paid,
             a.last_billed::text AS last_billed, a.usually
        FROM vendors v LEFT JOIN agg a ON a.vendor_id = v.id
       WHERE (${vendorId}::int IS NULL OR v.id = ${vendorId})
         AND (${search || ""} = '' OR v.name ILIKE ${`%${search || ""}%`} OR v.contact_person ILIKE ${`%${search || ""}%`})
         AND (${status || ""} = '' OR ${status || ""} = 'all' OR v.status = ${status || ""})
       ORDER BY v.name`;
    const money = (x) => Math.round((Number(x) || 0) * 100) / 100;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
    const days = (d) => (d ? Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${d}T12:00:00Z`)) / 86_400_000) : null);
    return rows.map((r) => ({
      ...mapVendor(r),
      money: {
        owedNow: money(r.owed_now),
        billed: money(r.billed),
        paid: money(r.paid),
        vatKept: money(r.vat_kept),
        whtKept: money(r.wht_kept),
        waiting: { count: Number(r.waiting_count) || 0, amount: money(r.waiting_amount) },
        expenseCount: Number(r.expense_count) || 0,
        oldestUnpaidDay: r.oldest_unpaid || null,
        oldestUnpaidDays: days(r.oldest_unpaid),
        lastPaidDay: r.last_paid || null,
        lastBilledDay: r.last_billed || null,
        usually: r.usually || "",
      },
    }));
  },

  /** Totals a vendor's expense history, for the vendor detail page. */
  async summaryFor(vendorId) {
    const numericId = Number(vendorId);
    const APPROVED = client`e.status IN ('admin_approved', 'paid')`;
    const [row] = await client`
      SELECT
        COUNT(*)::int AS expense_count,
        -- Naira, from the generated columns: a vendor billing in dollars and
        -- one billing in naira both roll into the same running total, and
        -- neither is understated by being added as a bare number.
        COALESCE(SUM(e.amount_ngn), 0)::text AS total_requested,
        COALESCE(SUM(e.amount_ngn) FILTER (WHERE ${APPROVED}), 0)::text AS total_approved,
        COALESCE(SUM(e.amount_paid_ngn) FILTER (WHERE e.status = 'paid'), 0)::text AS total_paid,
        MAX(e.payment_date) FILTER (WHERE e.status = 'paid') AS last_payment_date
      FROM pfi_expenses e
      WHERE e.vendor_id = ${numericId} AND e.deleted_at IS NULL
    `;

    const totalApproved = Number(row.total_approved);
    const totalPaid = Number(row.total_paid);
    return {
      expenseCount: row.expense_count,
      totalRequested: Number(row.total_requested),
      totalApproved,
      totalPaid,
      outstanding: Math.max(0, totalApproved - totalPaid),
      lastPaymentDate: row.last_payment_date,
    };
  },

  /** A vendor's expense history, in the same shape the expenses list uses. */
  async expensesFor(vendorId) {
    const numericId = Number(vendorId);
    return client`
      SELECT e.id, e.reference_number, e.expense_date, e.description, e.amount, e.amount_paid,
             e.bank_paid_from, e.status, c.name AS category_name, c.gl_code, p.pfi_number,
             COALESCE(e.currency, 'NGN') AS currency, e.amount_ngn, e.amount_paid_ngn, e.invoice_number,
             e.payment_date, e.admin_approved_at, COALESCE(c.is_refund, false) AS is_refund
      FROM pfi_expenses e
      JOIN expense_categories c ON c.id = e.category_id
      LEFT JOIN pfis p ON p.id = e.pfi_id
      WHERE e.vendor_id = ${numericId} AND e.deleted_at IS NULL
      ORDER BY e.expense_date DESC, e.id DESC
    `;
  },
};

module.exports = vendorRepo;
