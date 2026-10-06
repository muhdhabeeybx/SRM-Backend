const { client } = require("../config/db");

/**
 * The PFI a delivery batch belongs to, read off its code.
 *
 * A truck row reaches its PFI through `pfi_id`, and that link is what a
 * PFI-assigned person's Delivery Inventory — and so their Sales Ledger — is
 * filtered by (lib/scopeFilter.js). Allocate Trucks sends only the batch code,
 * so a truck added to a batch after it started selling was saved with no PFI
 * and vanished for everybody on that PFI except a super admin (BWR831XB on
 * PFI-47B, BWR822XB on PFI-41B, October 2026).
 *
 * Two ways a code names its PFI, in order:
 *
 *   1. A PFI holds the code itself — a trucking PFI (PFI-47B is PFI #69).
 *   2. The batch's other trucks all point at one PFI — PFI-14B's trucks point
 *      at the cargo they were drawn from, PFI/14, which must never get a PFI
 *      of its own (see the trucking-batches notes).
 *
 * Anything less certain answers null and the row is saved as it was asked.
 */
const codeOf = (v) => String(v ?? "").trim().toUpperCase();

async function pfiIdForCode(code) {
  const c = codeOf(code);
  if (!c) return null;

  const own = await client`
    SELECT id FROM pfis WHERE upper(trim(allocation_code)) = ${c}`;
  if (own.length === 1) return Number(own[0].id);
  if (own.length > 1) return null;

  const drawn = await client`
    SELECT DISTINCT pfi_id FROM delivery_inventory
     WHERE upper(trim(allocation_code)) = ${c} AND pfi_id IS NOT NULL`;
  return drawn.length === 1 ? Number(drawn[0].pfi_id) : null;
}

module.exports = { pfiIdForCode, codeOf };
