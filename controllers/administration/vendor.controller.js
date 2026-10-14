const asyncHandler = require("express-async-handler");
const { vendorRepo, staffRepo } = require("../../repositories");
const statements = require("../../services/accounting/statements.service");
const vendorLinks = require("../../services/vendorLinks.service");

const money = (n) => Math.round(n * 100) / 100;

/**
 * The vendor list. Plain for the pickers that only need names; with money
 * (withMoney=1) for the Vendors page, each vendor with what it is owed, billed
 * and paid, and the totals across them.
 */
const getVendors = asyncHandler(async (req, res) => {
  const { search, status, withMoney, from, to } = req.query;
  if (!withMoney) {
    const vendors = await vendorRepo.findAll({ search, status });
    return res.json({ success: true, data: { vendors, count: vendors.length } });
  }
  const vendors = await vendorRepo.withMoney({ search, status, from, to });
  const sum = (f) => money(vendors.reduce((t, v) => t + f(v.money), 0));
  res.json({
    success: true,
    data: {
      vendors,
      count: vendors.length,
      totals: {
        active: vendors.filter((v) => v.status === "Active").length,
        owedNow: sum((m) => Math.max(0, m.owedNow)),
        paidAhead: sum((m) => Math.max(0, -m.owedNow)),
        owedTo: vendors.filter((v) => v.money.owedNow > 0.005).length,
        billed: sum((m) => m.billed),
        paid: sum((m) => m.paid),
        vatKept: sum((m) => m.vatKept),
        whtKept: sum((m) => m.whtKept),
        waiting: { count: vendors.reduce((t, v) => t + v.money.waiting.count, 0), amount: sum((m) => m.waiting.amount) },
      },
    },
  });
});

/** One vendor: its details, its money over the period, and every expense raised against it. */
const getVendorById = asyncHandler(async (req, res) => {
  const vendor = await vendorRepo.findById(req.params.id);
  if (!vendor) {
    return res.status(404).json({ success: false, message: "Vendor not found" });
  }

  const [summary, expenses, [withMoney]] = await Promise.all([
    vendorRepo.summaryFor(vendor.id),
    vendorRepo.expensesFor(vendor.id),
    vendorRepo.withMoney({ vendorId: Number(vendor.id), from: req.query.from || null, to: req.query.to || null }),
  ]);

  res.json({
    success: true,
    data: { vendor, summary, money: withMoney?.money ?? null, expenses },
  });
});

/** Expenses naming a vendor only as typed text, and how many match a saved vendor (services/vendorLinks). */
const getTypedNames = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await vendorLinks.preview() });
});

const linkTypedNames = asyncHandler(async (req, res) => {
  // Named on each expense's audit as the expense pages name people.
  const staff = req.user?.id ? await staffRepo.findById(req.user.id).catch(() => null) : null;
  const actorName = (staff ? `${staff.firstName || ""} ${staff.surname || ""}`.trim() : "") || req.user?.email || "Vendors page";
  const { linked } = await vendorLinks.apply({ staffId: req.user?.id ?? null, actorName });
  res.json({
    success: true,
    message: linked ? `${linked} expense${linked === 1 ? "" : "s"} linked to ${linked === 1 ? "its vendor" : "their vendors"}` : "Nothing to link",
    data: { linked },
  });
});

/**
 * The vendor's statement: invoices approved and payments made, oldest first,
 * with what we owe them running down the side (services/accounting/statements).
 */
const getVendorStatement = asyncHandler(async (req, res) => {
  const vendor = await vendorRepo.findById(req.params.id);
  if (!vendor) {
    return res.status(404).json({ success: false, message: "Vendor not found" });
  }
  const data = await statements.vendorStatement(vendor.id, { from: req.query.from, to: req.query.to });
  res.json({ success: true, data });
});

const createVendor = asyncHandler(async (req, res) => {
  const existing = await vendorRepo.findByName(req.body.name);
  if (existing) {
    return res.status(200).json({
      success: true,
      message: "A vendor with this name already exists",
      data: { vendor: existing },
    });
  }

  const vendor = await vendorRepo.create({ ...req.body, createdBy: req.user?.id ?? null });

  res.status(201).json({
    success: true,
    message: "Vendor saved",
    data: { vendor },
  });
});

const updateVendor = asyncHandler(async (req, res) => {
  const vendor = await vendorRepo.findById(req.params.id);
  if (!vendor) {
    return res.status(404).json({ success: false, message: "Vendor not found" });
  }

  const updated = await vendorRepo.update(req.params.id, req.body);

  res.json({
    success: true,
    message: "Vendor updated",
    data: { vendor: updated },
  });
});

module.exports = {
  getVendors,
  getVendorById,
  getVendorStatement,
  createVendor,
  updateVendor,
  getTypedNames,
  linkTypedNames,
};
