const { denyPfiScoped } = require("../../lib/pfiScope");
const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const { requireRole } = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const schemas = require("../../schemas/people.schema");
const {
  getPeople,
  getHygiene,
  deleteReviewed,
  previewMerge,
  mergePeople,
} = require("../../controllers/administration/people.controller");

/**
 * The merged customers-and-contacts book.
 *
 * Reading it is an ordinary desk activity, so `verifyStaff` — the same gate
 * /api/customers and /api/contacts already sit behind. Deleting records off
 * the back of the hygiene review is not: it removes customer rows, so it takes
 * the admin gate the broadcast endpoint uses. Merging removes customer rows
 * too and is gated the same way, while its PREVIEW writes nothing and is not.
 */
router.get("/", verifyStaff, denyPfiScoped, validate({ query: schemas.listPeople }), getPeople);

// Before any parameterised route — Express matches in declaration order.
router.get("/hygiene", verifyStaff, denyPfiScoped, validate({ query: schemas.listHygiene }), getHygiene);
router.post(
  "/hygiene/delete",
  verifyStaff,
  denyPfiScoped,
  requireRole("admin", "super_admin"),
  validate({ body: schemas.deleteReviewed }),
  deleteReviewed
);

// Folding duplicate records into one. The preview is read-only; the merge
// deletes customer rows, so it takes the admin gate.
router.post("/merge/preview", verifyStaff, denyPfiScoped, validate({ body: schemas.mergePeople }), previewMerge);
router.post(
  "/merge",
  verifyStaff,
  denyPfiScoped,
  requireRole("admin", "super_admin"),
  validate({ body: schemas.mergePeople }),
  mergePeople
);

module.exports = router;
