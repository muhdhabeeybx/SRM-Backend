const { denyPfiScoped } = require("../../lib/pfiScope");
const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const contactSchemas = require("../../schemas/contact.schema");
const {
  getContacts,
  getContactTags,
  getContactById,
  createContact,
  updateContact,
  deleteContact,
  previewImport,
  importContacts,
  convertContact,
} = require("../../controllers/administration/contact.controller");

router.get("/", verifyStaff, denyPfiScoped, validate({ query: contactSchemas.listContacts }), getContacts);

// Both before "/:id" — Express matches in declaration order, so "tags" and
// "import" would otherwise be swallowed as an :id value and fail id
// validation rather than reaching their handlers.
router.get("/tags", verifyStaff, denyPfiScoped, getContactTags);
// The dry run comes before "/import" as well as before "/:id" — a literal
// path nested under another literal path still has to be declared first.
router.post(
  "/import/preview",
  verifyStaff,
  denyPfiScoped,
  validate({ body: contactSchemas.importContacts }),
  previewImport
);
router.post("/import", verifyStaff, denyPfiScoped, validate({ body: contactSchemas.importContacts }), importContacts);

router.get("/:id", verifyStaff, denyPfiScoped, validate({ params: contactSchemas.idParam }), getContactById);
router.post("/", verifyStaff, denyPfiScoped, validate({ body: contactSchemas.createContact }), createContact);
router.patch(
  "/:id",
  verifyStaff,
  denyPfiScoped,
  validate({ params: contactSchemas.idParam, body: contactSchemas.updateContact }),
  updateContact
);
router.delete("/:id", verifyStaff, denyPfiScoped, validate({ params: contactSchemas.idParam }), deleteContact);
router.post("/:id/convert", verifyStaff, denyPfiScoped, validate({ params: contactSchemas.idParam }), convertContact);

module.exports = router;
