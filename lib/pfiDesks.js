const { client } = require("../config/db");

/**
 * Who sells a trucking batch's trucks, and who takes their money — read off
 * the officers its PFI named at Start selling.
 *
 * The owner (30 Oct 2026): "we need to have clear sales managers and finance
 * people, lets not have both at a time … check from the pfi officers when we
 * started selling who is who and put that restrictions". So on each batch:
 *
 *   sell    the PFI's Sales Manager or Truck Sales Officer says who bought a
 *           truck and at what rate, and corrects that sale
 *   money   the PFI's Finance / Audit Officer records its payments, changes
 *           or deletes one, and moves an overpayment
 *
 * A job whose slots name nobody stays as it was before: anybody who can see
 * the batch sells, and finance takes the money (deliverySale.controller
 * MONEY_ROLES). An empty slot never reads as "nobody", the same rule as every
 * other assignment here (lib/scopeFilter.js). Admins and super admins may
 * always do either, to correct.
 *
 * A batch's PFI is the one holding its code (a trucking PFI: PFI-47D is
 * PFI/47D/26/MT LESTE…), else the PFI its loads were drawn from — the batches
 * from before trucking PFIs existed (PFI-14B's trucks point at PFI/14). The
 * dashboard reads the same list (GET /api/delivery-sales/desks), so its
 * buttons and these refusals cannot disagree.
 *
 * Depot orders are not covered: their payments stay with anyone in finance
 * (the owner's choice, 30 Oct 2026).
 */

const ALWAYS_ROLES = ["admin", "super_admin"];
const MONEY_ROLES = ["finance", ...ALWAYS_ROLES];
const NOT_FINANCE = "Only finance records a truck sale's payment.";

const rolesOf = (user) => (Array.isArray(user?.roles) ? user.roles : []);
const mayAlways = (user) => rolesOf(user).some((r) => ALWAYS_ROLES.includes(r));
const hasMoneyRole = (user) => rolesOf(user).some((r) => MONEY_ROLES.includes(r));

const codeKey = (v) => String(v || "").trim().toUpperCase();

/** "Ada", "Ada and Bola", "Ada, Bola and Chidi". */
const nameList = (names) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/**
 * Every batch code with its PFI and the people on each job, or only the codes
 * asked for. One row per code: the PFI holding the code wins over the PFI its
 * loads came off.
 */
const listDesks = async (codes = null) => {
  const only = codes === null ? null : [...new Set(codes.map(codeKey).filter(Boolean))];
  if (only !== null && only.length === 0) return [];
  const rows = await client`
    WITH codes AS (
      SELECT upper(trim(p.allocation_code)) AS code, p.id AS pfi_id, 0 AS rank
        FROM pfis p
       WHERE nullif(trim(p.allocation_code), '') IS NOT NULL
      UNION
      SELECT DISTINCT upper(trim(di.allocation_code)), di.pfi_id, 1
        FROM delivery_inventory di
       WHERE di.pfi_id IS NOT NULL AND nullif(trim(di.allocation_code), '') IS NOT NULL
    )
    SELECT DISTINCT ON (c.code)
           c.code,
           p.id AS pfi_id,
           p.pfi_number,
           p.audit_officer_id,
           NULLIF(btrim(concat_ws(' ', fo.first_name, fo.surname)), '') AS audit_officer_name,
           p.sales_manager_id,
           NULLIF(btrim(concat_ws(' ', sm.first_name, sm.surname)), '') AS sales_manager_name,
           p.truck_sales_officer_id,
           NULLIF(btrim(concat_ws(' ', ts.first_name, ts.surname)), '') AS truck_sales_officer_name
      FROM codes c
      JOIN pfis p ON p.id = c.pfi_id
      LEFT JOIN staff fo ON fo.id = p.audit_officer_id
      LEFT JOIN staff sm ON sm.id = p.sales_manager_id
      LEFT JOIN staff ts ON ts.id = p.truck_sales_officer_id
     WHERE ${only === null ? client`true` : client`c.code = ANY(${only}::text[])`}
     ORDER BY c.code, c.rank, p.id`;
  return rows.map((r) => {
    const person = (id, name) => (id == null ? null : { id: Number(id), name: name || `Staff #${id}` });
    const sellers = [person(r.sales_manager_id, r.sales_manager_name), person(r.truck_sales_officer_id, r.truck_sales_officer_name)]
      .filter(Boolean)
      .filter((p, i, all) => all.findIndex((q) => q.id === p.id) === i);
    return {
      code: r.code,
      pfiId: Number(r.pfi_id),
      pfiNumber: r.pfi_number,
      sellers,
      finance: [person(r.audit_officer_id, r.audit_officer_name)].filter(Boolean),
    };
  });
};

const KIND = {
  sell: { people: (d) => d.sellers, words: (code) => `${code}'s trucks are sold by` },
  money: { people: (d) => d.finance, words: (code) => `Payments on ${code}'s trucks are confirmed by` },
};

/**
 * Why this person may not do this job on these batches, or null when they
 * may. A code with no PFI behind it, or a job its PFI names nobody for, falls
 * back to the rule from before: anyone sells, finance takes the money.
 */
const refusalFor = async (user, job, codes) => {
  if (mayAlways(user)) return null;
  const wanted = [...new Set((codes || []).map(codeKey).filter(Boolean))];
  const desks = wanted.length ? await listDesks(wanted) : [];
  const me = Number(user?.id);
  for (const desk of desks) {
    const who = KIND[job].people(desk);
    if (who.length === 0) continue;
    if (!who.some((p) => p.id === me)) return `${KIND[job].words(desk.code)} ${nameList(who.map((p) => p.name))}.`;
  }
  // Each batch here names this person for the money, or names nobody. Where
  // nobody is named (or the row has no batch at all) the old rule stands.
  if (job === "money" && !hasMoneyRole(user)) {
    const named = new Set(desks.filter((d) => d.finance.length).map((d) => d.code));
    if (wanted.length === 0 || wanted.some((c) => !named.has(c))) return NOT_FINANCE;
  }
  return null;
};

const sellRefusal = (user, codes) => refusalFor(user, "sell", codes);
const moneyRefusal = (user, codes) => refusalFor(user, "money", codes);

/**
 * The same person named Finance / Audit Officer and Sales Manager or Truck
 * Sales Officer on one PFI — "lets not have both at a time". Takes the PFI's
 * slots as they would be saved (camelCase ids). Returns the refusal or null.
 * The PFI routes ask it of trucking PFIs only, like the rest of this file.
 */
const doubleDeskRefusal = (slots) => {
  const finance = Number(slots?.auditOfficerId || 0);
  if (!finance) return null;
  const selling = [
    ["Sales Manager", slots?.salesManagerId],
    ["Truck Sales Officer", slots?.truckSalesOfficerId],
  ].find(([, id]) => Number(id || 0) === finance);
  if (!selling) return null;
  return `One person cannot be both the Finance / Audit Officer and the ${selling[0]} on a PFI. Name someone else for one of them.`;
};

module.exports = {
  MONEY_ROLES,
  NOT_FINANCE,
  hasMoneyRole,
  listDesks,
  sellRefusal,
  moneyRefusal,
  doubleDeskRefusal,
};
