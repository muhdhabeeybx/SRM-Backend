const { client } = require("../db");

const DEFAULT_BANK_CODES = {
  "Zenith Bank": "057",
  "Guaranty Trust Bank (GTBank)": "058",
  "GTBank": "058",
  "First Bank of Nigeria": "011",
  "First Bank": "011",
  "Access Bank": "044",
  "United Bank for Africa (UBA)": "033",
  "UBA": "033",
  "Wema Bank": "035",
  "Sterling Bank": "232",
  "Fidelity Bank": "070",
  "Union Bank": "032",
  "Stanbic IBTC Bank": "221",
  "Kuda Bank": "50211",
  "Moniepoint Microfinance Bank": "50515",
  "OPay": "999992",
  "Ecobank Nigeria": "050",
  "First City Monument Bank (FCMB)": "214",
  "Providus Bank": "101",
};

function resolveBankCode(bankName, providedCode) {
  const trimmedName = bankName ? String(bankName).trim() : "";
  if (trimmedName && DEFAULT_BANK_CODES[trimmedName]) {
    return DEFAULT_BANK_CODES[trimmedName];
  }
  if (providedCode && String(providedCode).trim()) return String(providedCode).trim();
  return "";
}

let tableInitialized = false;

async function ensureTableExists() {
  if (tableInitialized) return;
  try {
    await client`
      CREATE TABLE IF NOT EXISTS bank_accounts (
        id SERIAL PRIMARY KEY,
        bank_name VARCHAR(100) NOT NULL,
        account_name VARCHAR(255) NOT NULL,
        account_number VARCHAR(50) NOT NULL,
        bank_code VARCHAR(50) DEFAULT '',
        branch_name VARCHAR(150) DEFAULT '',
        currency VARCHAR(10) DEFAULT 'NGN' NOT NULL,
        status VARCHAR(20) DEFAULT 'Active' NOT NULL,
        is_default BOOLEAN DEFAULT false NOT NULL,
        depot_ids JSONB DEFAULT '[]'::jsonb NOT NULL,
        lpg_station_ids JSONB DEFAULT '[]'::jsonb NOT NULL,
        notes TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      );
    `;
    await client`
      ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS lpg_station_ids JSONB DEFAULT '[]'::jsonb NOT NULL;
    `;
    await client`
      ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS usage JSONB DEFAULT '[]'::jsonb NOT NULL;
    `;
    tableInitialized = true;
  } catch (err) {
    console.error("Failed to initialize bank_accounts table:", err.message);
  }
}

async function attachDepotsToAccount(account) {
  if (!account) return account;
  const depotIds = Array.isArray(account.depotIds)
    ? account.depotIds
    : typeof account.depot_ids === "string"
    ? JSON.parse(account.depot_ids)
    : account.depot_ids || [];

  const numericDepotIds = depotIds
    .map((id) => Number(id))
    .filter((id) => !isNaN(id) && id > 0);

  let depots = [];
  if (numericDepotIds.length > 0) {
    try {
      const rows = await client`
        SELECT id, name, code, city, state, country, status
        FROM depots
        WHERE id = ANY(${numericDepotIds})
      `;
      depots = rows.map((r) => ({
        id: r.id,
        name: r.name,
        code: r.code,
        city: r.city,
        state: r.state,
        country: r.country,
        status: r.status,
      }));
    } catch (e) {
      console.error("Failed to fetch depots for bank account:", e.message);
    }
  }

  const lpgStationIds = Array.isArray(account.lpgStationIds)
    ? account.lpgStationIds
    : typeof account.lpg_station_ids === "string"
    ? JSON.parse(account.lpg_station_ids)
    : account.lpg_station_ids || [];

  const numericStationIds = lpgStationIds
    .map((id) => Number(id))
    .filter((id) => !isNaN(id) && id > 0);

  let lpgStations = [];
  if (numericStationIds.length > 0) {
    try {
      const rows = await client`
        SELECT id, name, code, city, state, country, status
        FROM lpg_stations
        WHERE id = ANY(${numericStationIds})
      `;
      lpgStations = rows.map((r) => ({
        id: r.id,
        name: r.name,
        code: r.code,
        city: r.city,
        state: r.state,
        country: r.country,
        status: r.status,
      }));
    } catch (e) {
      console.error("Failed to fetch lpg stations for bank account:", e.message);
    }
  }

  const usage = Array.isArray(account.usage)
    ? account.usage
    : typeof account.usage === "string"
    ? JSON.parse(account.usage)
    : account.usage || [];

  // Read the same defensive way depot_ids is: 15 accounts once held a
  // stringified array here (migration 0012), and nothing stops it recurring.
  const rawPfiIds = Array.isArray(account.pfiIds)
    ? account.pfiIds
    : typeof account.pfi_ids === "string"
    ? JSON.parse(account.pfi_ids)
    : account.pfi_ids || [];
  const numericPfiIds = rawPfiIds
    .map((id) => Number(id))
    .filter((id) => !isNaN(id) && id > 0);

  const rawAssignedAt = typeof account.pfi_assigned_at === "string"
    ? JSON.parse(account.pfi_assigned_at)
    : account.pfi_assigned_at || account.pfiAssignedAt || {};
  const assignedAt = rawAssignedAt && typeof rawAssignedAt === "object" && !Array.isArray(rawAssignedAt)
    ? rawAssignedAt
    : {};

  return {
    id: account.id,
    bankName: account.bank_name || account.bankName,
    accountName: account.account_name || account.accountName,
    accountNumber: account.account_number || account.accountNumber,
    bankCode: account.bank_code || account.bankCode || "",
    branchName: account.branch_name || account.branchName || "",
    currency: account.currency || "NGN",
    status: account.status || "Active",
    isDefault: Boolean(account.is_default ?? account.isDefault),
    /**
     * The cargoes this account collects for, and when each was attached.
     *
     * Both were missing from this projection while four screens read
     * `pfiIds` — the accounts list, the collection panel, the assignment
     * table and the edit form — so every account arrived looking unassigned.
     * The edit form was the dangerous one: it loaded the empty list into its
     * selection and sent it straight back on save, which clears the real
     * assignment in the database.
     */
    pfiIds: numericPfiIds,
    pfiAssignedAt: assignedAt,
    depotIds: numericDepotIds,
    depots,
    lpgStationIds: numericStationIds,
    lpgStations,
    usage: usage.map((u) => String(u)).filter(Boolean),
    notes: account.notes || "",
    createdAt: account.created_at || account.createdAt,
    updatedAt: account.updated_at || account.updatedAt,
  };
}

const bankAccountRepo = {
  async findAll({ search, status, depotId, lpgStationId, usage } = {}) {
    await ensureTableExists();

    let rows = await client`
      SELECT * FROM bank_accounts
      ORDER BY is_default DESC, id DESC
    `;

    let results = await Promise.all(rows.map(attachDepotsToAccount));

    if (search) {
      const query = search.toLowerCase().trim();
      results = results.filter((acc) => {
        const inBank = acc.bankName?.toLowerCase().includes(query);
        const inName = acc.accountName?.toLowerCase().includes(query);
        const inNumber = acc.accountNumber?.toLowerCase().includes(query);
        const inDepot = acc.depots?.some((d) =>
          d.name?.toLowerCase().includes(query) || d.code?.toLowerCase().includes(query)
        );
        const inStation = acc.lpgStations?.some((s) =>
          s.name?.toLowerCase().includes(query) || s.code?.toLowerCase().includes(query)
        );
        return inBank || inName || inNumber || inDepot || inStation;
      });
    }

    if (status) {
      results = results.filter((acc) => acc.status === status);
    }

    if (depotId) {
      const targetId = Number(depotId);
      /**
       * Two ways an account covers a depot, and the second is resolved live.
       *
       * `depot_ids` is derived from the assigned PFIs, but only at the moment
       * an account is saved (see depotsForPfis). Editing a delivery batch's
       * allowlist afterwards does not touch any account, so the derived column
       * goes stale the moment a batch is lent somewhere new — and the thing it
       * silently breaks is an order at that location finding no payment
       * account. Asking the allowlist directly here cannot go stale.
       *
       * The derived column is still what the accounts list and staff scope
       * read, so both halves are kept: this is a widening of the match, not a
       * replacement for the derivation.
       */
      let lentIds = new Set();
      try {
        const lent = await client`
          SELECT ba.id
            FROM bank_accounts ba
           WHERE EXISTS (
                   SELECT 1
                     FROM pfi_allowed_locations al
                    WHERE al.depot_id = ${targetId}
                      AND EXISTS (
                            -- Compared as text, and guarded against a pfi_ids
                            -- that is not an array: 15 accounts held depot_ids
                            -- as a stringified array once (migration 0012),
                            -- and nothing stops the same happening here.
                            SELECT 1 FROM jsonb_array_elements_text(
                              CASE WHEN jsonb_typeof(ba.pfi_ids) = 'array'
                                   THEN ba.pfi_ids ELSE '[]'::jsonb END
                            ) AS e(v)
                             WHERE e.v = al.pfi_id::text
                          )
                 )
        `;
        lentIds = new Set(lent.map((r) => Number(r.id)));
      } catch (e) {
        // A missing pfi_allowed_locations (migration 0027 not yet applied)
        // must not take the payment-account lookup down with it. Falling back
        // to the derived column is exactly the old behaviour.
        console.error("Failed to resolve lent batches for depot lookup:", e.message);
      }

      results = results.filter(
        (acc) => acc.depotIds.includes(targetId) || lentIds.has(Number(acc.id)),
      );
    }

    // An area asking for its own accounts gets only the ones tagged for it.
    // Untagged accounts are excluded on purpose: the point of the tag is that
    // the truck sales and expense pickers stop offering the whole company's
    // banking, so treating "untagged" as "allowed" would defeat it.
    if (usage) {
      const wanted = String(usage).trim();
      results = results.filter((acc) => acc.usage.includes(wanted));
    }

    if (lpgStationId) {
      const targetId = Number(lpgStationId);
      results = results.filter((acc) => acc.lpgStationIds.includes(targetId));
    }

    return results;
  },

  async findById(id) {
    await ensureTableExists();
    const numericId = Number(id);
    if (isNaN(numericId)) return null;

    const rows = await client`
      SELECT * FROM bank_accounts
      WHERE id = ${numericId}
      LIMIT 1
    `;

    if (rows.length === 0) return null;
    return await attachDepotsToAccount(rows[0]);
  },

  async create(data) {
    await ensureTableExists();

    const {
      bankName,
      accountName,
      accountNumber,
      bankCode = "",
      branchName = "",
      currency = "NGN",
      status = "Active",
      isDefault = false,
      depotIds = [],
      lpgStationIds = [],
      usage = [],
      notes = "",
    } = data;

    const cleanUsage = Array.isArray(usage)
      ? [...new Set(usage.map((u) => String(u).trim()).filter(Boolean))]
      : [];
    const jsonUsage = JSON.stringify(cleanUsage);

    const numericDepotIds = Array.isArray(depotIds)
      ? depotIds.map((i) => Number(i)).filter((i) => !isNaN(i))
      : [];
    const jsonDepotIds = JSON.stringify(numericDepotIds);

    const numericStationIds = Array.isArray(lpgStationIds)
      ? lpgStationIds.map((i) => Number(i)).filter((i) => !isNaN(i))
      : [];
    const jsonStationIds = JSON.stringify(numericStationIds);

    const finalBankCode = resolveBankCode(bankName, bankCode);

    if (isDefault) {
      await client`UPDATE bank_accounts SET is_default = false`;
    }

    const rows = await client`
      INSERT INTO bank_accounts (
        bank_name,
        account_name,
        account_number,
        bank_code,
        branch_name,
        currency,
        status,
        is_default,
        depot_ids,
        lpg_station_ids,
        usage,
        notes,
        created_at,
        updated_at
      ) VALUES (
        ${bankName},
        ${accountName},
        ${accountNumber},
        ${finalBankCode},
        ${branchName},
        ${currency},
        ${status},
        ${isDefault},
        ${jsonDepotIds}::jsonb,
        ${jsonStationIds}::jsonb,
        ${jsonUsage}::jsonb,
        ${notes},
        NOW(),
        NOW()
      )
      RETURNING *
    `;

    const result = await attachDepotsToAccount(rows[0]);

    // Sync subaccounts for newly linked depots and stations
    const { syncSubaccountForDepot, syncSubaccountForStation } = require("../services/subaccount.service");
    if (numericDepotIds.length > 0) {
      for (const depotId of numericDepotIds) {
        syncSubaccountForDepot(depotId).catch((err) =>
          console.error(`[bankAccount.create] subaccount sync failed for depot ${depotId}:`, err.message)
        );
      }
    }
    if (numericStationIds.length > 0) {
      for (const stationId of numericStationIds) {
        syncSubaccountForStation(stationId).catch((err) =>
          console.error(`[bankAccount.create] subaccount sync failed for station ${stationId}:`, err.message)
        );
      }
    }

    return result;
  },

  async update(id, data) {
    await ensureTableExists();
    const numericId = Number(id);
    if (isNaN(numericId)) return null;

    const existing = await this.findById(numericId);
    if (!existing) return null;

    const bankName = data.bankName !== undefined ? data.bankName : existing.bankName;
    const accountName = data.accountName !== undefined ? data.accountName : existing.accountName;
    const accountNumber = data.accountNumber !== undefined ? data.accountNumber : existing.accountNumber;
    const rawBankCode = data.bankCode !== undefined ? data.bankCode : existing.bankCode;
    const bankCode = resolveBankCode(bankName, rawBankCode);
    const branchName = data.branchName !== undefined ? data.branchName : existing.branchName;
    const currency = data.currency !== undefined ? data.currency : existing.currency;
    const status = data.status !== undefined ? data.status : existing.status;
    const isDefault = data.isDefault !== undefined ? Boolean(data.isDefault) : existing.isDefault;
    const depotIds = data.depotIds !== undefined ? data.depotIds : existing.depotIds;
    const lpgStationIds = data.lpgStationIds !== undefined ? data.lpgStationIds : existing.lpgStationIds;
    const usage = data.usage !== undefined ? data.usage : existing.usage;
    const notes = data.notes !== undefined ? data.notes : existing.notes;

    const cleanUsage = Array.isArray(usage)
      ? [...new Set(usage.map((u) => String(u).trim()).filter(Boolean))]
      : [];
    const jsonUsage = JSON.stringify(cleanUsage);

    const numericDepotIds = Array.isArray(depotIds)
      ? depotIds.map((i) => Number(i)).filter((i) => !isNaN(i))
      : [];
    const jsonDepotIds = JSON.stringify(numericDepotIds);

    const numericStationIds = Array.isArray(lpgStationIds)
      ? lpgStationIds.map((i) => Number(i)).filter((i) => !isNaN(i))
      : [];
    const jsonStationIds = JSON.stringify(numericStationIds);

    const oldDepotIds = (existing.depotIds || []).map(Number);
    const oldStationIds = (existing.lpgStationIds || []).map(Number);

    if (isDefault && !existing.isDefault) {
      await client`UPDATE bank_accounts SET is_default = false WHERE id != ${numericId}`;
    }

    const rows = await client`
      UPDATE bank_accounts
      SET
        bank_name = ${bankName},
        account_name = ${accountName},
        account_number = ${accountNumber},
        bank_code = ${bankCode},
        branch_name = ${branchName},
        currency = ${currency},
        status = ${status},
        is_default = ${isDefault},
        depot_ids = ${jsonDepotIds}::jsonb,
        lpg_station_ids = ${jsonStationIds}::jsonb,
        usage = ${jsonUsage}::jsonb,
        notes = ${notes},
        updated_at = NOW()
      WHERE id = ${numericId}
      RETURNING *
    `;

    if (rows.length === 0) return null;
    const result = await attachDepotsToAccount(rows[0]);

    // Sync subaccounts for affected depots and stations
    const { syncSubaccountForDepot, syncSubaccountForStation } = require("../services/subaccount.service");
    const affectedDepots = [...new Set([...numericDepotIds, ...oldDepotIds])];
    if (affectedDepots.length > 0) {
      for (const depotId of affectedDepots) {
        syncSubaccountForDepot(depotId).catch((err) =>
          console.error(`[bankAccount.update] subaccount sync failed for depot ${depotId}:`, err.message)
        );
      }
    }

    const affectedStations = [...new Set([...numericStationIds, ...oldStationIds])];
    if (affectedStations.length > 0) {
      for (const stationId of affectedStations) {
        syncSubaccountForStation(stationId).catch((err) =>
          console.error(`[bankAccount.update] subaccount sync failed for station ${stationId}:`, err.message)
        );
      }
    }

    return result;
  },

  async delete(id) {
    await ensureTableExists();
    const numericId = Number(id);
    if (isNaN(numericId)) return false;

    // Fetch the account first so we know which locations to sync after deletion
    const existing = await this.findById(numericId);

    const rows = await client`
      DELETE FROM bank_accounts
      WHERE id = ${numericId}
      RETURNING id
    `;

    if (rows.length > 0 && existing) {
      const { syncSubaccountForDepot, syncSubaccountForStation } = require("../services/subaccount.service");
      const affectedDepotIds = (existing.depotIds || []).map(Number).filter((d) => !isNaN(d));
      if (affectedDepotIds.length > 0) {
        for (const depotId of affectedDepotIds) {
          syncSubaccountForDepot(depotId).catch((err) =>
            console.error(`[bankAccount.delete] subaccount sync failed for depot ${depotId}:`, err.message)
          );
        }
      }
      const affectedStationIds = (existing.lpgStationIds || []).map(Number).filter((s) => !isNaN(s));
      if (affectedStationIds.length > 0) {
        for (const stationId of affectedStationIds) {
          syncSubaccountForStation(stationId).catch((err) =>
            console.error(`[bankAccount.delete] subaccount sync failed for station ${stationId}:`, err.message)
          );
        }
      }
    }

    return rows.length > 0;
  },
};

module.exports = bankAccountRepo;
