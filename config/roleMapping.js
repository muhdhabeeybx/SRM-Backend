const ROLE_MAP = {
  0: "super_admin",
  1: "admin",
  2: "finance",
  3: "truck_sales",
  4: "ticketing",
  // The gate has two posts: one confirms a truck ENTERED the facility to load,
  // one confirms it EXITED with its load. Replaces the single "security" role.
  5: "security_entry",
  6: "transport",
  7: "release",
  8: "audit",
  9: "sales_manager",
  10: "product_manager",
  11: "lpg_dashboard",
  12: "lpg_plants",
  13: "lpg_stock",
  14: "lpg_sales",
  15: "commissions",
  16: "commission_officer",
  17: "dispatch",
  18: "it_compliance",
  19: "security_exit",

  // Tiered Subroles - Finance Department
20: "finance_viewer",
  21: "finance_operator",
  22: "finance_manager",

  // Tiered Subroles - Transport Department
  23: "transport_viewer",
  24: "transport_operator",
  25: "transport_manager",

  // Tiered Subroles - Security Department
  26: "security_viewer",
  27: "security_operator",
  28: "security_manager",

  // Tiered Subroles - Ticketing Department
  29: "ticketing_viewer",
  30: "ticketing_operator",
  31: "ticketing_manager",

  // Tiered Subroles - Orders Department
  32: "orders_viewer",
  33: "orders_operator",
  34: "orders_manager",

  // Tiered Subroles - Sales Department
  35: "sales_viewer",
  36: "sales_operator",
  37: "sales_manager_tier",

  // Tiered Subroles - Dangote Department
  38: "dangote_viewer",
  39: "dangote_operator",
  40: "dangote_manager",

  // Tiered Subroles - LPG Department
  41: "lpg_viewer",
  42: "lpg_operator",
  43: "lpg_manager",

  // Verifies and pays expenses — the "Expenses Officer" stage of the
  // pfi_expenses approval chain (lib/expenseChain.js ROLE.OFFICER). Was
  // already referenced there and in expenseNotifications.service.js; this is
  // the id that makes it assignable.
  44: "expenditure_officer",

  // Picks the gantry tickets a paid order is sold on, which completes it, and
  // keeps the PFI's ticket list — services/gantryTickets.service.js.
  45: "stock_officer",
};

const mapRolesToBackend = (numericRoles) => {
  return numericRoles
    .map((r) => ROLE_MAP[r])
    .filter(Boolean);
};

module.exports = { ROLE_MAP, mapRolesToBackend };
