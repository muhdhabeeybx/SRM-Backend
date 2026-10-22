/**
 * The officer slots a PFI names, and the role each one gives.
 *
 * Six slots are as old as the PFI form. The last four came with migration
 * 0096, so the desks the system already texts per PFI (notifications/
 * deskOfficers.js DESK_ROLES) can be named on the PFI itself rather than only
 * by ticking the PFI on the person in Manage Users.
 *
 * Naming somebody in a slot gives them its role for as long as the PFI is
 * open (services/pfiRoles.service.js), and its pages with it. The labels are
 * the words the PFI form and the PFI file use.
 *
 *   field    the snake_case body field the PFI form sends
 *   idKey    the pfis column, as Drizzle names it
 *   nameKey  where the officer's name is kept beside the id
 *   column   the pfis column, as SQL names it
 */
const PFI_SLOTS = Object.freeze([
  { field: "audit_officer", idKey: "auditOfficerId", nameKey: "auditOfficerName", column: "audit_officer_id", label: "Finance / Audit Officer", role: "finance" },
  { field: "sales_manager", idKey: "salesManagerId", nameKey: "salesManagerName", column: "sales_manager_id", label: "Sales Manager", role: "sales_manager" },
  { field: "product_officer", idKey: "productOfficerId", nameKey: "productOfficerName", column: "product_officer_id", label: "Product Manager", role: "product_manager" },
  { field: "commission_officer", idKey: "commissionOfficerId", nameKey: "commissionOfficerName", column: "commission_officer_id", label: "Commission Officer", role: "commissions" },
  { field: "it_compliance_officer", idKey: "itComplianceOfficerId", nameKey: "itComplianceOfficerName", column: "it_compliance_officer_id", label: "IT Compliance Officer", role: "it_compliance" },
  { field: "security_exit_officer", idKey: "securityExitOfficerId", nameKey: "securityExitOfficerName", column: "security_exit_officer_id", label: "Security Exit Officer", role: "security_exit" },
  { field: "ticketing_officer", idKey: "ticketingOfficerId", nameKey: "ticketingOfficerName", column: "ticketing_officer_id", label: "Ticketing Officer", role: "ticketing" },
  { field: "gate_entry_officer", idKey: "gateEntryOfficerId", nameKey: "gateEntryOfficerName", column: "gate_entry_officer_id", label: "Gate Entry Officer", role: "security_entry" },
  { field: "truck_sales_officer", idKey: "truckSalesOfficerId", nameKey: "truckSalesOfficerName", column: "truck_sales_officer_id", label: "Truck Sales Officer", role: "truck_sales" },
  { field: "stock_officer", idKey: "stockOfficerId", nameKey: "stockOfficerName", column: "stock_officer_id", label: "Stock Officer", role: "stock_officer" },
]);

/** The staff ids a PFI row names, in any slot. */
const officersOn = (pfi) =>
  [...new Set(PFI_SLOTS.map((s) => Number(pfi?.[s.idKey])).filter((id) => Number.isInteger(id) && id > 0))];

module.exports = { PFI_SLOTS, officersOn };
