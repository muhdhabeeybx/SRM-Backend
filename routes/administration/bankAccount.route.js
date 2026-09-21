const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const misc = require("../../schemas/misc.schema");
const {
  setAccountsForPfi,
  getBankAccounts,
  getBankAccountById,
  createBankAccount,
  updateBankAccount,
  deleteBankAccount,
} = require("../../controllers/administration/bankAccount.controller");

router.get("/", verifyStaff, getBankAccounts);
router.get("/:id", verifyStaff, getBankAccountById);
router.post("/", verifyStaff, validate({ body: misc.createBankAccount }), createBankAccount);
router.patch("/:id", verifyStaff, validate({ params: misc.idParam, body: misc.updateBankAccount }), updateBankAccount);
router.delete("/:id", verifyStaff, validate({ params: misc.idParam }), deleteBankAccount);

// Which accounts a PFI collects into, set from the PFI's side.
router.put(
  "/for-pfi/:pfiId",
  verifyStaff,
  validate({ params: misc.pfiAccountsParam, body: misc.setPfiAccounts }),
  setAccountsForPfi,
);

module.exports = router;
