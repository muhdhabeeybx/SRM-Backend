const { scopedPfiIds, customerIdsFor, assertCustomerVisible } = require("../../lib/pfiScope");

/**
 * What a PFI's staff see of a customer outside their PFI, when they search.
 *
 * Raising an order needs the customer found first, and a customer buying from
 * this PFI for the first time — or created a minute ago — has no order on it
 * yet. So a SEARCH finds any customer, but one outside the person's PFI comes
 * back as a name to pick and nothing else: no balance, no history, no email,
 * and opening them answers 404. Browsing without a search shows only the
 * PFI's own customers.
 */
const lookupOnly = (c) => ({
  id: c.id,
  _id: c._id ?? c.id,
  name: c.name,
  phone: c.phone,
  companyName: c.companyName ?? c.company_name ?? "",
  status: c.status,
  balance: null,
  outsideYourPfi: true,
});
const asyncHandler = require("express-async-handler");
const { customerRepo, customerPhoneRepo, orderRepo, depositRepo } = require("../../repositories");
const { toE164 } = require("../../utils/phone");

const getCustomers = asyncHandler(async (req, res) => {
  const {
    search, searchType, status,
    depotId, activity, hasBalance, optedOut, sort,
    page = 1, limit = 50,
  } = req.query;

  const pfiIds = scopedPfiIds(req.user);

  // A search from staff assigned to a PFI: find anyone, see only a name for
  // those outside the PFI. See lookupOnly above.
  if (pfiIds && search && String(search).trim().length >= 2) {
    const found = await customerRepo.findAll({
      search, searchType, status, page, limit: Math.min(Number(limit) || 20, 20),
    });
    const mine = new Set(await customerIdsFor(req.user));
    return res.json({
      success: true,
      data: {
        ...found,
        customers: (found.customers || []).map((c) => (mine.has(Number(c.id ?? c._id)) ? c : lookupOnly(c))),
      },
    });
  }

  const result = await customerRepo.findAll({
    search,
    searchType,
    status,
    depotId,
    activity,
    hasBalance,
    optedOut,
    sort,
    page,
    limit,
    onlyPfiIds: pfiIds,
  });

  res.json({ success: true, data: result });
});

const getCustomerById = asyncHandler(async (req, res) => {
  await assertCustomerVisible(req.user, req.params.id);
  const customer = await customerRepo.findById(req.params.id);

  if (!customer) {
    return res.status(404).json({ success: false, message: "Customer not found" });
  }

  res.json({ success: true, data: { customer } });
});

const createCustomer = asyncHandler(async (req, res) => {
  const { name, email, phone, companyName, address, status, balance, deposit, previousDeposit } = req.body;

  if (!name || !phone) {
    return res.status(400).json({
      success: false,
      message: "Name and phone are required",
    });
  }

  const normalizedPhone = toE164(phone);

  // toE164 returns null for a number that is not valid anywhere. Without this
  // guard the null would reach customers.phone, which is notNull, and surface
  // as a 500 instead of a 400.
  if (!normalizedPhone) {
    return res.status(400).json({
      success: false,
      message:
        "A valid phone number is required. International numbers must include a country code, e.g. +447400123456",
    });
  }

  // Names the customer already holding the number rather than just refusing.
  // "That phone is taken" leaves the desk guessing whether they are looking at
  // a duplicate of their own customer or somebody else's; the row itself
  // answers it, and `existingCustomer` lets the form offer to open them.
  // Across BOTH tables — the number may already be somebody's alternate rather
  // than their primary, and a customer created on it would be a second account
  // that the same person can sign in to. Matched on the normalised key, so
  // "0803…" is refused when "+234803…" is what is on file.
  const owner = await customerPhoneRepo.findOwner(normalizedPhone);
  const phoneOwner = owner ? await customerRepo.findById(owner.customerId) : null;
  if (phoneOwner) {
    return res.status(409).json({
      success: false,
      message: `${phoneOwner.name}${phoneOwner.companyName ? ` (${phoneOwner.companyName})` : ""} already uses ${owner.phone}${owner.isPrimary ? "" : " as one of their numbers"}`,
      data: {
        existingCustomer: {
          id: phoneOwner.id,
          name: phoneOwner.name,
          phone: phoneOwner.phone,
          email: phoneOwner.email,
          companyName: phoneOwner.companyName,
          balance: phoneOwner.balance,
        },
      },
    });
  }

  if (email && email.trim()) {
    const emailOwner = await customerRepo.findByEmail(email);
    if (emailOwner) {
      return res.status(409).json({
        success: false,
        message: `${emailOwner.name}${emailOwner.companyName ? ` (${emailOwner.companyName})` : ""} already uses ${email}`,
        data: {
          existingCustomer: {
            id: emailOwner.id,
            name: emailOwner.name,
            phone: emailOwner.phone,
            email: emailOwner.email,
            companyName: emailOwner.companyName,
            balance: emailOwner.balance,
          },
        },
      });
    }
  }

  const customer = await customerRepo.create({
    name,
    email: email || "",
    phone: normalizedPhone,
    companyName: companyName || "",
    address: address || "",
    status: status || "Active",
    balance: String(balance ?? 0),
    deposit: String(deposit ?? 0),
    previousDeposit: String(previousDeposit ?? 0),
  });

  res.status(201).json({
    success: true,
    message: "Customer created successfully",
    data: { customer },
  });
});

const updateCustomer = asyncHandler(async (req, res) => {
  await assertCustomerVisible(req.user, req.params.id);
  const customer = await customerRepo.findById(req.params.id);

  if (!customer) {
    return res.status(404).json({ success: false, message: "Customer not found" });
  }

  const allowedFields = [
    "name", "email", "phone", "companyName", "address",
    "status", "balance", "deposit", "previousDeposit", "marketingOptOut",
  ];

  // Validate before building updateData, so an invalid number cannot be
  // written as null into the notNull phone column.
  if (req.body.phone !== undefined && !toE164(req.body.phone)) {
    return res.status(400).json({
      success: false,
      message:
        "A valid phone number is required. International numbers must include a country code, e.g. +447400123456",
    });
  }

  const updateData = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      updateData[field] = field === "phone" ? toE164(req.body[field]) : req.body[field];
    }
  }

  if (req.body.phone) {
    const normalizedPhone = toE164(req.body.phone);
    // Same cross-table check as create: another customer's ALTERNATE is just
    // as much a clash as their primary, because both sign in.
    const clash = await customerPhoneRepo.findOwner(normalizedPhone, {
      exceptCustomerId: customer.id,
    });
    if (clash) {
      return res.status(409).json({
        success: false,
        message: `${clash.name} already uses ${clash.phone}${clash.isPrimary ? "" : " as one of their numbers"}`,
      });
    }
  }

  if (req.body.email && req.body.email.trim()) {
    if (await customerRepo.existsByEmail(req.body.email, customer.id)) {
      return res.status(409).json({
        success: false,
        message: `Another customer with email ${req.body.email} already exists`,
      });
    }
  }

  const updated = await customerRepo.update(customer.id, updateData);

  res.json({
    success: true,
    message: "Customer updated successfully",
    data: { customer: updated },
  });
});

/** GET /api/customers/segments — the messaging page's audience preview + recipient source. */
const getCustomerSegment = asyncHandler(async (req, res) => {
  const { depotId, minOrders, sinceDays, inactiveSinceDays, limit } = req.query;

  const result = await customerRepo.findForSegment({
    depotId,
    minOrders,
    sinceDays,
    inactiveSinceDays,
    limit,
  });

  // A segment is who a message goes to. Staff assigned to a PFI reach only
  // that PFI's customers, and the count says how many that is, not how many
  // the whole book has.
  const mine = await customerIdsFor(req.user);
  if (mine !== null) {
    const allowed = new Set(mine);
    const customers = (result.customers || []).filter((c) => allowed.has(Number(c.id ?? c._id)));
    return res.json({ success: true, data: { ...result, customers, count: customers.length } });
  }

  res.json({ success: true, data: result });
});

const deleteCustomer = asyncHandler(async (req, res) => {
  await assertCustomerVisible(req.user, req.params.id);
  const customer = await customerRepo.findById(req.params.id);

  if (!customer) {
    return res.status(404).json({ success: false, message: "Customer not found" });
  }

  const [orderCount, depositCount] = await Promise.all([
    orderRepo.findAll({ customer: customer.id, limit: 1 }).then((r) => r.pagination.total),
    depositRepo.countByCustomer(customer.id),
  ]);

  const references = [];
  if (orderCount > 0) references.push(`${orderCount} order(s)`);
  if (depositCount > 0) references.push(`${depositCount} deposit(s)`);

  if (references.length > 0) {
    return res.status(400).json({
      success: false,
      message: `Cannot delete customer: it is referenced by ${references.join(", ")}`,
    });
  }

  await customerRepo.deleteById(customer.id);

  res.json({ success: true, message: "Customer deleted successfully" });
});

module.exports = { getCustomers, getCustomerById, createCustomer, updateCustomer, deleteCustomer, getCustomerSegment };
