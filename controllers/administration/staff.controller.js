const crypto = require("crypto");
const asyncHandler = require("express-async-handler");
const { staffRepo, staffScopeRepo } = require("../../repositories");
const { mapRolesToBackend } = require("../../config/roleMapping");
const { notifyAndWait } = require("../../notifications");
const sessionService = require("../../services/session.service");

const REALM = "staff";

const toIdList = (list) => (Array.isArray(list) ? list.map((v) => Number(v)).filter(Number.isFinite) : []);

const generateResetToken = () => {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const hashedToken = crypto
    .createHash("sha256")
    .update(rawToken)
    .digest("hex");
  return { rawToken, hashedToken };
};

const createAdmin = asyncHandler(async (req, res) => {
  const {
    first_name, surname, other_names, email, phone_number, roles, suspended,
    can_view_all_locations, depot_ids, lpg_station_ids, pfi_ids, filling_station_ids, page_overrides,
  } = req.body;

  if (!first_name || !surname || !email) {
    return res.status(400).json({
      success: false,
      message: "First name, surname, and email are required",
    });
  }

  const normalizedEmail = email.trim().toLowerCase();

  const existing = await staffRepo.findByEmail(normalizedEmail);
  if (existing) {
    return res.status(409).json({
      success: false,
      message: "A user with this email already exists",
    });
  }

  const { rawToken, hashedToken } = generateResetToken();

  const backendRoles = roles && roles.length > 0
    ? mapRolesToBackend(roles)
    : ["admin"];

  const admin = await staffRepo.create({
    firstName: first_name.trim(),
    surname: surname.trim(),
    otherNames: (other_names || "").trim(),
    email: normalizedEmail,
    phoneNumber: phone_number || null,
    roles: backendRoles,
    suspended: suspended || false,
    canViewAllLocations: can_view_all_locations ?? true,
    isPasswordSet: false,
    passwordResetToken: hashedToken,
    passwordResetExpires: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  if (depot_ids || lpg_station_ids || pfi_ids || filling_station_ids) {
    await staffScopeRepo.setScope(admin.id, {
      depotIds: toIdList(depot_ids),
      lpgStationIds: toIdList(lpg_station_ids),
      pfiIds: toIdList(pfi_ids),
      fillingStationIds: toIdList(filling_station_ids),
    });
  }
  if (page_overrides) {
    await staffScopeRepo.setPageOverrides(admin.id, page_overrides.map((o) => ({ routePath: o.route_path, allowed: o.allowed })));
  }

  // Through the engine rather than the bare sender, so the send lands in
  // notification_deliveries — "did the invite email actually go out?" is the
  // single most common support question about a new account, and it used to
  // be answerable only from a console line nobody kept.
  await notifyAndWait("account.password_setup", {
    to: { staffId: admin.id },
    data: {
      firstName: admin.firstName,
      setPasswordUrl: `${process.env.CLIENT_URL}/set-password?token=${rawToken}`,
    },
  });

  res.status(201).json({
    success: true,
    message: "User created successfully. A password setup email has been sent.",
    data: {
      id: admin.id,
      email: admin.email,
      firstName: admin.firstName,
      surname: admin.surname,
      roles: admin.roles,
    },
  });
});

const getAllAdmins = asyncHandler(async (req, res) => {
  const { staff, pagination } = await staffRepo.findAll({ page: 1, limit: 1000 });

  const safeStaff = staff.map(({ password, refreshToken, passwordResetToken, passwordResetExpires, ...rest }) => rest);
  const staffIds = safeStaff.map((s) => s.id);
  const [scopeByStaff, overridesByStaff] = await Promise.all([
    staffScopeRepo.getScopeWithNamesForStaffIds(staffIds),
    staffScopeRepo.getPageOverridesForStaffIds(staffIds),
  ]);
  const enriched = safeStaff.map((s) => ({
    ...s,
    ...scopeByStaff.get(s.id),
    pageOverrides: overridesByStaff.get(s.id) || [],
  }));

  res.json({
    success: true,
    // dual-emit: `staff` is the new key, `admins` retained for the existing frontend.
    // Drop `admins` once the dashboard is updated.
    data: { staff: enriched, admins: enriched },
  });
});

const getAdminById = asyncHandler(async (req, res) => {
  const admin = await staffRepo.findById(req.params.id);

  if (!admin) {
    return res.status(404).json({ success: false, message: "User not found" });
  }

  const { password, refreshToken, passwordResetToken, passwordResetExpires, ...safeAdmin } = admin;
  const [scope, pageOverrides] = await Promise.all([
    staffScopeRepo.getScopeWithNames(admin.id),
    staffScopeRepo.getPageOverrides(admin.id),
  ]);

  res.json({
    success: true,
    data: { admin: { ...safeAdmin, ...scope, pageOverrides } },
  });
});

const updateAdmin = asyncHandler(async (req, res) => {
  const {
    first_name, surname, other_names, email, phone_number, roles, suspended,
    can_view_all_locations, depot_ids, lpg_station_ids, pfi_ids, filling_station_ids, page_overrides,
  } = req.body;

  const admin = await staffRepo.findById(req.params.id);
  if (!admin) {
    return res.status(404).json({ success: false, message: "User not found" });
  }

  // --- AUDIT H5: privilege escalation ------------------------------------
  //
  // This endpoint edits ordinary profile fields AND the fields that decide
  // what an account may do. It carried no role gate, so any `admin` could
  // PATCH their own row with roles:[0] and become a super_admin — defeating
  // the super_admin gates on create and delete. Scope and page overrides are
  // gated the same way, for the same reason: either one narrows or widens
  // what an account can see or do.
  //
  // The gate is per-field rather than per-route on purpose. Putting
  // requireRole("super_admin") on the route would fix the escalation and break
  // every staff member's ability to edit their own name and phone number.
  const isSuperAdmin = (req.user?.roles || []).includes("super_admin");
  const changesPrivileges =
    roles !== undefined ||
    suspended !== undefined ||
    can_view_all_locations !== undefined ||
    depot_ids !== undefined ||
    lpg_station_ids !== undefined ||
    pfi_ids !== undefined ||
    filling_station_ids !== undefined ||
    page_overrides !== undefined;

  if (changesPrivileges && !isSuperAdmin) {
    return res.status(403).json({
      success: false,
      message: "Only a super admin can change roles or suspension",
    });
  }

  // Editing somebody else's row is an administrative act, not self-service.
  // Without this, any signed-in staff member could PATCH a colleague's
  // profile — including their email, which is the login identity and the
  // address a password reset is delivered to, i.e. a full account takeover.
  // Your own profile goes through PATCH /staff/me, which cannot touch email
  // at all.
  if (admin.id !== req.user.id && !isSuperAdmin) {
    return res.status(403).json({
      success: false,
      message: "You can only edit your own profile",
    });
  }

  // Email is the login identity: only a super admin reassigns one, never the
  // account holder themselves.
  if (email !== undefined && !isSuperAdmin) {
    return res.status(403).json({
      success: false,
      message: "Your email address can only be changed by a super admin",
    });
  }

  // A super_admin locking themselves out takes everyone with them: the roles
  // that can restore access are exactly the ones being given away.
  if (changesPrivileges && admin.id === req.user.id) {
    if (suspended === true) {
      return res.status(400).json({
        success: false,
        message: "You cannot suspend your own account",
      });
    }
    if (roles && roles.length > 0 && !mapRolesToBackend(roles).includes("super_admin")) {
      return res.status(400).json({
        success: false,
        message: "You cannot remove your own super admin role",
      });
    }
  }

  const updateData = {};
  if (first_name) updateData.firstName = first_name.trim();
  if (surname) updateData.surname = surname.trim();
  if (other_names !== undefined) updateData.otherNames = (other_names || "").trim();
  if (email) {
    const normalizedEmail = email.trim().toLowerCase();
    const existing = await staffRepo.findByEmail(normalizedEmail);
    if (existing && existing.id !== admin.id) {
      return res.status(409).json({ success: false, message: "Email already in use" });
    }
    updateData.email = normalizedEmail;
  }
  if (phone_number !== undefined) updateData.phoneNumber = phone_number || null;
  if (roles && roles.length > 0) updateData.roles = mapRolesToBackend(roles);
  if (suspended !== undefined) updateData.suspended = suspended;
  if (can_view_all_locations !== undefined) updateData.canViewAllLocations = can_view_all_locations;

  const updated = await staffRepo.update(admin.id, updateData);

  if (
    depot_ids !== undefined || lpg_station_ids !== undefined ||
    pfi_ids !== undefined || filling_station_ids !== undefined
  ) {
    const current = await staffScopeRepo.getScopeWithNames(admin.id);
    await staffScopeRepo.setScope(admin.id, {
      depotIds: depot_ids !== undefined ? toIdList(depot_ids) : current.depotIds,
      lpgStationIds: lpg_station_ids !== undefined ? toIdList(lpg_station_ids) : current.lpgStationIds,
      pfiIds: pfi_ids !== undefined ? toIdList(pfi_ids) : current.pfiIds,
      fillingStationIds:
        filling_station_ids !== undefined ? toIdList(filling_station_ids) : current.fillingStationIds,
    });
  }
  if (page_overrides !== undefined) {
    await staffScopeRepo.setPageOverrides(admin.id, page_overrides.map((o) => ({ routePath: o.route_path, allowed: o.allowed })));
  }

  res.json({
    success: true,
    message: "User updated successfully",
    data: {
      id: updated.id,
      email: updated.email,
      firstName: updated.firstName,
      surname: updated.surname,
      roles: updated.roles,
    },
  });
});

/**
 * PATCH /staff/me — a person editing their own profile.
 *
 * Name, other names, phone and profile picture only. Email is deliberately
 * not here: it is the login identity and the address a password reset is
 * sent to, so letting an account rewrite it is an account-takeover primitive.
 * Roles, suspension and scope are likewise absent — those belong to
 * updateAdmin's super_admin path.
 */
const updateMyProfile = asyncHandler(async (req, res) => {
  const { first_name, surname, other_names, phone_number, profile_picture_url, profile_picture_public_id } = req.body;

  const updateData = {};
  if (first_name !== undefined) {
    if (!String(first_name).trim()) {
      return res.status(400).json({ success: false, message: "First name cannot be empty" });
    }
    updateData.firstName = String(first_name).trim();
  }
  if (surname !== undefined) {
    if (!String(surname).trim()) {
      return res.status(400).json({ success: false, message: "Surname cannot be empty" });
    }
    updateData.surname = String(surname).trim();
  }
  if (other_names !== undefined) updateData.otherNames = String(other_names || "").trim();
  if (phone_number !== undefined) updateData.phoneNumber = phone_number || null;
  if (profile_picture_url !== undefined) updateData.profilePictureUrl = profile_picture_url || null;
  if (profile_picture_public_id !== undefined) updateData.profilePicturePublicId = profile_picture_public_id || null;

  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({ success: false, message: "Nothing to update" });
  }

  const updated = await staffRepo.update(req.user.id, updateData);

  res.json({
    success: true,
    message: "Profile updated",
    data: {
      id: updated.id,
      email: updated.email,
      firstName: updated.firstName,
      surname: updated.surname,
      otherNames: updated.otherNames,
      phoneNumber: updated.phoneNumber,
      roles: updated.roles,
      profilePicture: {
        url: updated.profilePictureUrl,
        publicId: updated.profilePicturePublicId,
      },
    },
  });
});

/**
 * POST /staff/me/password — a person changing their own password.
 *
 * The current password is required even though the caller is already
 * authenticated: it is what stops a walked-up-to, still-logged-in browser
 * from being turned into a permanent takeover.
 *
 * Every session is revoked on success, this one included — same posture as
 * the reset flow. Someone changing their password because they think it is
 * compromised expects exactly that, and the caller signs back in with the
 * new one. (revokeAll has no "except this session" mode; adding one for a
 * nicety here would widen a security-critical function for no real gain.)
 */
const changeMyPassword = asyncHandler(async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!current_password || !new_password) {
    return res.status(400).json({
      success: false,
      message: "Both your current and new password are required",
    });
  }
  if (String(new_password).length < 8) {
    return res.status(400).json({
      success: false,
      message: "Your new password must be at least 8 characters",
    });
  }

  const me = await staffRepo.findById(req.user.id);
  if (!me) return res.status(404).json({ success: false, message: "User not found" });

  const matches = await staffRepo.comparePassword(me, current_password);
  if (!matches) {
    return res.status(401).json({ success: false, message: "Your current password is not correct" });
  }
  if (current_password === new_password) {
    return res.status(400).json({
      success: false,
      message: "Your new password must be different from the current one",
    });
  }

  // staffRepo.update hashes `password` on the way in — never store the raw one.
  await staffRepo.update(me.id, {
    password: new_password,
    isPasswordSet: true,
    passwordResetToken: null,
    passwordResetExpires: null,
  });

  await sessionService.revokeAll(REALM, me.id, "password_change");

  // Best effort: a "your password changed" message is how a takeover gets
  // noticed, but failing to send one must not fail the change itself.
  notifyAndWait("account.password_changed", {
    user: me,
    data: { credential: "password", at: new Date() },
  }).catch(() => {});

  res.json({
    success: true,
    message: "Password changed — please sign in again",
    data: { reauthRequired: true },
  });
});

const deleteAdmin = asyncHandler(async (req, res) => {
  const admin = await staffRepo.findById(req.params.id);
  if (!admin) {
    return res.status(404).json({ success: false, message: "User not found" });
  }

  await staffRepo.deleteById(req.params.id);

  res.json({
    success: true,
    message: "User deleted successfully",
  });
});

const resendInvite = asyncHandler(async (req, res) => {
  const admin = await staffRepo.findById(req.params.id);
  if (!admin) {
    return res.status(404).json({ success: false, message: "User not found" });
  }

  if (admin.isPasswordSet) {
    return res.status(400).json({
      success: false,
      message: "User has already set their password",
    });
  }

  const { rawToken, hashedToken } = generateResetToken();
  await staffRepo.update(admin.id, {
    passwordResetToken: hashedToken,
    passwordResetExpires: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  // notifyAndWait, not notify: this endpoint's contract is that it reports a
  // send failure to the operator who pressed "resend", so the outcome has to
  // be known before the response is written.
  const invite = await notifyAndWait("account.password_setup", {
    to: { staffId: admin.id },
    data: {
      firstName: admin.firstName,
      setPasswordUrl: `${process.env.CLIENT_URL}/set-password?token=${rawToken}`,
    },
  });

  if (invite.results?.[0]?.channels?.email !== "sent") {
    console.error("Failed to resend password setup email to", admin.email);
    return res.status(500).json({
      success: false,
      message: "Failed to send email",
    });
  }

  res.json({
    success: true,
    message: "Password setup email resent successfully",
  });
});

module.exports = {
  createAdmin,
  getAllAdmins,
  getAdminById,
  updateAdmin,
  updateMyProfile,
  changeMyPassword,
  deleteAdmin,
  resendInvite,
};
