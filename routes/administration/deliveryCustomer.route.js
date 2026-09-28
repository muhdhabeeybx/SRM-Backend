const express = require("express");
const router = express.Router();
const verifyStaff = require("../../middleware/verifyStaff");
const validate = require("../../middleware/validate");
const dcSchemas = require("../../schemas/deliveryCustomer.schema");
const {
  createDeliveryCustomer,
  getDeliveryCustomerById,
  getDeliveryCustomers,
  createDeliveryNote,
  updateDeliveryCustomer,
  deleteDeliveryCustomer,
} = require("../../controllers/customer/deliveryCustomer.controller");

router.get("/", verifyStaff, validate({ query: dcSchemas.listDeliveryCustomers }), getDeliveryCustomers);
router.get("/:id", verifyStaff, validate({ params: dcSchemas.idParam }), getDeliveryCustomerById);
router.post("/", verifyStaff, validate({ body: dcSchemas.createDeliveryCustomer }), createDeliveryCustomer);
router.patch("/:id", verifyStaff, validate({ params: dcSchemas.idParam, body: dcSchemas.updateDeliveryCustomer }), updateDeliveryCustomer);
router.put("/:id", verifyStaff, validate({ params: dcSchemas.idParam, body: dcSchemas.updateDeliveryCustomer }), updateDeliveryCustomer);
router.delete("/:id", verifyStaff, validate({ params: dcSchemas.idParam }), deleteDeliveryCustomer);
router.post("/delivery-notes", verifyStaff, createDeliveryNote);

module.exports = router;
