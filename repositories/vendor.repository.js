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
             e.bank_paid_from, e.status, c.name AS category_name, c.gl_code, p.pfi_number
      FROM pfi_expenses e
      JOIN expense_categories c ON c.id = e.category_id
      LEFT JOIN pfis p ON p.id = e.pfi_id
      WHERE e.vendor_id = ${numericId} AND e.deleted_at IS NULL
      ORDER BY e.expense_date DESC, e.id DESC
    `;
  },
};

module.exports = vendorRepo;
