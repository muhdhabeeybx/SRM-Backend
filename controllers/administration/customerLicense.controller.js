const { client } = require("../../config/db");
const { scopedPfiIds, assertCustomerVisible } = require("../../lib/pfiScope");

/**
 * A licence belongs to a customer, and staff assigned to a PFI see only that
 * PFI's customers — so a licence is checked through its customer, and one
 * outside their PFI reads as not found.
 */
const assertLicenseVisible = async (user, licenseId) => {
  if (!scopedPfiIds(user)) return;
  const [row] = await client`SELECT customer_id FROM customer_licenses WHERE id = ${Number(licenseId)}`;
  if (!row) return; // the handler answers 404 itself
  try {
    await assertCustomerVisible(user, row.customer_id);
  } catch {
    throw Object.assign(new Error("License not found"), { status: 404, statusCode: 404 });
  }
};
const asyncHandler = require("express-async-handler");
const {
  customerLicenseRepo,
  customerRepo,
} = require("../../repositories");
const customerLicenseService = require("../../services/customerLicense.service");
const { deleteFile } = require("../../services/upload.service");
const { sendServiceResult } = require("../../utils/serviceResult");
const { staffActor } = require("../../utils/actor");

const getLicensesByCustomer = asyncHandler(async (req, res) => {
  await assertCustomerVisible(req.user, req.params.customerId);
  const customer = await customerRepo.findById(req.params.customerId);
  if (!customer) {
    return res
      .status(404)
      .json({ success: false, message: "Customer not found" });
  }

  const licenses = await customerLicenseRepo.findByCustomerId(customer.id);
  res.json({ success: true, data: { licenses } });
});

const getAllLicenses = asyncHandler(async (req, res) => {
  const result = await customerLicenseRepo.findAll({ ...req.query, onlyPfiIds: scopedPfiIds(req.user) });
  res.json({ success: true, data: result });
});

const getLicenseById = asyncHandler(async (req, res) => {
  await assertLicenseVisible(req.user, req.params.id);
  const license = await customerLicenseRepo.findByIdWithCustomer(req.params.id);
  if (!license) {
    return res
      .status(404)
      .json({ success: false, message: "License not found" });
  }
  res.json({ success: true, data: { license } });
});

const createLicense = asyncHandler(async (req, res) => {
  const { customerId, companyName, licenseUrl, licensePublicId, expiryDate } = req.body;
  await assertCustomerVisible(req.user, customerId);

  const customer = await customerRepo.findById(customerId);
  if (!customer) {
    return res
      .status(404)
      .json({ success: false, message: "Customer not found" });
  }

  const license = await customerLicenseRepo.create({
    customerId,
    companyName,
    licenseUrl: licenseUrl || "",
    licensePublicId: licensePublicId || "",
    expiryDate: expiryDate || null,
  });

  res.status(201).json({
    success: true,
    message: "License added successfully",
    data: { license },
  });
});

const updateLicense = asyncHandler(async (req, res) => {
  await assertLicenseVisible(req.user, req.params.id);
  const existing = await customerLicenseRepo.findById(req.params.id);
  if (!existing) {
    return res
      .status(404)
      .json({ success: false, message: "License not found" });
  }

  const updateData = {};
  if (req.body.companyName !== undefined)
    updateData.companyName = req.body.companyName;
  if (req.body.licenseUrl !== undefined)
    updateData.licenseUrl = req.body.licenseUrl;
  if (req.body.licensePublicId !== undefined)
    updateData.licensePublicId = req.body.licensePublicId;
  if (req.body.expiryDate !== undefined)
    updateData.expiryDate = req.body.expiryDate || null;

  // Reset verification status when editing a non-pending license
  if (existing.status !== "pending") {
    updateData.status = "pending";
    updateData.verifiedBy = null;
    updateData.verifiedByName = "";
    updateData.verifiedAt = null;
    updateData.verificationComment = "";
  }

  // If the file is being replaced, delete the old one from Cloudinary
  if (
    req.body.licensePublicId &&
    existing.licensePublicId &&
    req.body.licensePublicId !== existing.licensePublicId
  ) {
    await deleteFile(existing.licensePublicId).catch(() => {});
  }

  const updated = await customerLicenseRepo.update(existing.id, updateData);

  res.json({
    success: true,
    message: "License updated successfully",
    data: { license: updated },
  });
});

const deleteLicense = asyncHandler(async (req, res) => {
  await assertLicenseVisible(req.user, req.params.id);
  const existing = await customerLicenseRepo.findById(req.params.id);
  if (!existing) {
    return res
      .status(404)
      .json({ success: false, message: "License not found" });
  }

  // Clean up Cloudinary file
  if (existing.licensePublicId) {
    await deleteFile(existing.licensePublicId).catch(() => {});
  }

  await customerLicenseRepo.deleteById(existing.id);
  res.json({ success: true, message: "License deleted successfully" });
});

const reviewLicense = asyncHandler(async (req, res) => {
  await assertLicenseVisible(req.user, req.params.id);
  const result = await customerLicenseService.reviewLicense(
    req.params.id,
    req.body,
    { actor: staffActor(req) }
  );
  sendServiceResult(res, result, {
    message: req.body.approve ? "License approved" : "License rejected",
  });
});

module.exports = {
  getLicensesByCustomer,
  getAllLicenses,
  getLicenseById,
  createLicense,
  updateLicense,
  deleteLicense,
  reviewLicense,
};
