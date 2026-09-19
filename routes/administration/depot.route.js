const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const { requireRole } = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const depotSchemas = require("../../schemas/depot.schema");
const {
  getDepots,
  getDepotById,
  createDepot,
  updateDepot,
  deleteDepot,
  updateProductPrice,
  listPriceChanges,
  approvePriceChange,
  rejectPriceChange,
  zeroAllProductPrices,
} = require("../../controllers/administration/depot.controller");

router.get("/", verifyStaff, validate({ query: depotSchemas.listDepots }), getDepots);
/**
 * The approval side of pricing.
 *
 * Setting a price is finance's (the gate on /:id/product-price below);
 * releasing it is not, because a second check by the same desk is not a second
 * check. super_admin and admin approve — the tier that already acts as the
 * approving one elsewhere.
 *
 * NOTE: requireRole is currently a no-op app-wide (see verifyStaff.js), so
 * these names document who the route is FOR rather than refusing anybody. The
 * guarantee that holds today is the second ACT, not the second role: a price
 * cannot go live without a separate approval, and the trail names who gave it.
 *
 * Declared ABOVE "/:id" — a GET for "/price-changes" otherwise matches the id
 * route, fails idParam validation and 400s, which is exactly what happened.
 */
router.get("/price-changes", verifyStaff, listPriceChanges);
router.post(
  "/price-changes/:changeId/approve",
  verifyStaff,
  requireRole("super_admin", "admin", { message: "Only an admin can approve a price change" }),
  approvePriceChange
);
router.post(
  "/price-changes/:changeId/reject",
  verifyStaff,
  requireRole("super_admin", "admin", { message: "Only an admin can reject a price change" }),
  rejectPriceChange
);

router.get("/:id", verifyStaff, validate({ params: depotSchemas.idParam }), getDepotById);
router.post("/", verifyStaff, validate({ body: depotSchemas.createDepot }), createDepot);
router.patch("/:id", verifyStaff, validate({ params: depotSchemas.idParam, body: depotSchemas.updateDepot }), updateDepot);
// Repricing fuel is a money operation. It previously carried no role gate at
// all, so any account holding the generic `admin` role could change the price
// at any depot.
router.patch(
  "/:id/product-price",
  verifyStaff,
  requireRole("super_admin", "finance", { message: "Finance access required" }),
  validate({ params: depotSchemas.idParam, body: depotSchemas.updateProductPrice }),
  updateProductPrice
);
/**
 * Every product off sale, everywhere. Above /:id so the literal path wins.
 *
 * Finance and admin only: it closes the whole trading book in one request, and
 * unlike editing one depot there is no partial state to inspect first.
 */
router.post(
  "/product-prices/zero-all",
  verifyStaff,
  requireRole("super_admin", "admin", "finance", {
    message: "Finance access required to take every product off sale",
  }),
  zeroAllProductPrices
);

router.delete("/:id", verifyStaff, validate({ params: depotSchemas.idParam }), deleteDepot);

module.exports = router;
