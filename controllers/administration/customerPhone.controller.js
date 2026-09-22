const { assertCustomerVisible } = require("../../lib/pfiScope");
const asyncHandler = require("express-async-handler");
const { customerRepo, customerPhoneRepo } = require("../../repositories");
const { emitEvent } = require("../../services/events");
const { staffActor } = require("../../utils/actor");
const { toE164, classifyPhone } = require("../../utils/phone");

/**
 * The numbers one customer can be reached — and sign in — on.
 *
 * A company buys under the manager's line and the director's; a trader
 * changes SIM and keeps both. Until now each of those was a separate customer
 * row, so only one of them could reach the wallet and the order history the
 * business actually holds for that person. These endpoints are how the desk
 * records the rest, and every number recorded here signs in to the same
 * account (customerRepo.findByAnyPhone).
 *
 * See db/migrations/0019_customer_phone_numbers.sql for why the primary stays
 * on `customers.phone` and only the alternates live in their own table.
 */

/** GET /api/customers/:id/phones — primary first, then the alternates. */
const listPhones = asyncHandler(async (req, res) => {
  // Staff assigned to a PFI reach only its customers. See lib/pfiScope.js.
  await assertCustomerVisible(req.user, req.params.id);
  const phones = await customerPhoneRepo.listAll(req.params.id);
  if (!phones) {
    return res.status(404).json({ success: false, message: "Customer not found" });
  }
  res.json({ success: true, data: { phones } });
});

/**
 * POST /api/customers/:id/phones — add a number to the account.
 *
 * Three refusals, in the order that gives the clearest answer:
 *
 *   1. Not a phone number at all. Rejected outright — an unparseable number is
 *      not a contact detail, it is a typo, and 115 of the 1,380 numbers on the
 *      live book are exactly this.
 *   2. Already held by somebody else. Named, not just refused: "that number is
 *      taken" leaves the desk unable to tell a duplicate of their own customer
 *      from a genuine clash, and the owner's name settles it in one line.
 *   3. Already on this account. Answered as a no-op rather than an error —
 *      adding a number twice is a double-click, not a mistake worth a red box.
 *
 * A landline or VOIP line is ALLOWED through, with a warning attached. It is a
 * real way to reach the customer and worth recording; it just cannot carry an
 * SMS, so it can never be a sign-in number and the response says so.
 */
const addPhone = asyncHandler(async (req, res) => {
  // Staff assigned to a PFI reach only its customers. See lib/pfiScope.js.
  await assertCustomerVisible(req.user, req.params.id);
  const customer = await customerRepo.findById(req.params.id);
  if (!customer) {
    return res.status(404).json({ success: false, message: "Customer not found" });
  }

  const { phone, label } = req.body || {};
  const e164 = toE164(phone);
  if (!e164) {
    return res.status(400).json({
      success: false,
      message:
        "Enter a valid phone number. International numbers must include a country code, e.g. +447400123456",
    });
  }

  const owner = await customerPhoneRepo.findOwner(e164);
  if (owner && owner.customerId !== customer.id) {
    return res.status(409).json({
      success: false,
      message: `${owner.name} already uses ${owner.phone}${owner.isPrimary ? "" : " as one of their numbers"}`,
      data: { existingCustomer: { id: owner.customerId, name: owner.name, phone: owner.phone } },
    });
  }
  if (owner && owner.customerId === customer.id) {
    return res.json({
      success: true,
      message: "That number is already on this account",
      data: { phones: await customerPhoneRepo.listAll(customer.id) },
    });
  }

  const created = await customerPhoneRepo.create({
    customerId: customer.id,
    phone: e164,
    label,
    createdBy: req.user?.id || null,
  });

  emitEvent("customer.phone_added", {
    actor: staffActor(req),
    entityType: "customer",
    entityId: String(customer.id),
    phone: e164,
    label: created.label,
  });

  const { verdict, reason } = classifyPhone(e164);
  res.status(201).json({
    success: true,
    message:
      verdict === "ok"
        ? "Number added — it can now be used to sign in"
        : `Number added, but it cannot receive an SMS: ${reason}`,
    data: {
      phones: await customerPhoneRepo.listAll(customer.id),
      numberStatus: verdict,
      numberReason: reason,
    },
  });
});

/**
 * DELETE /api/customers/:id/phones/:phoneId — drop an alternate.
 *
 * Only ever an alternate: the primary has no row here to delete, and a
 * customer with no number at all could neither sign in nor be told anything.
 * Making a different number primary first is the way to retire the old one.
 */
const deletePhone = asyncHandler(async (req, res) => {
  // Staff assigned to a PFI reach only its customers. See lib/pfiScope.js.
  await assertCustomerVisible(req.user, req.params.id);
  const phone = await customerPhoneRepo.findById(req.params.phoneId);
  if (!phone || phone.customerId !== Number(req.params.id)) {
    return res.status(404).json({ success: false, message: "Number not found on this customer" });
  }

  await customerPhoneRepo.deleteById(phone.id);

  emitEvent("customer.phone_removed", {
    actor: staffActor(req),
    entityType: "customer",
    entityId: String(phone.customerId),
    phone: phone.phone,
  });

  res.json({
    success: true,
    message: "Number removed",
    data: { phones: await customerPhoneRepo.listAll(phone.customerId) },
  });
});

/**
 * POST /api/customers/:id/phones/:phoneId/primary — promote an alternate.
 *
 * The primary is what every SMS sender, the Paystack DVA and the order
 * confirmations read, so this is the number that changes what the customer
 * actually receives — not just how they sign in. The old primary is kept as an
 * alternate rather than discarded: it still signs in, and it is still the
 * number half the order history was confirmed on.
 */
const makePrimary = asyncHandler(async (req, res) => {
  // Staff assigned to a PFI reach only its customers. See lib/pfiScope.js.
  await assertCustomerVisible(req.user, req.params.id);
  const phone = await customerPhoneRepo.findById(req.params.phoneId);
  if (!phone || phone.customerId !== Number(req.params.id)) {
    return res.status(404).json({ success: false, message: "Number not found on this customer" });
  }

  const updated = await customerPhoneRepo.makePrimary(phone.customerId, phone.id);
  if (!updated) {
    return res.status(404).json({ success: false, message: "Number not found on this customer" });
  }

  emitEvent("customer.phone_primary_changed", {
    actor: staffActor(req),
    entityType: "customer",
    entityId: String(phone.customerId),
    phone: phone.phone,
  });

  res.json({
    success: true,
    message: `${phone.phone} is now the main number`,
    data: {
      customer: updated,
      phones: await customerPhoneRepo.listAll(phone.customerId),
    },
  });
});

module.exports = { listPhones, addPhone, deletePhone, makePrimary };
