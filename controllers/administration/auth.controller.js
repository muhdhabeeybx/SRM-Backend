const crypto = require("crypto");
const asyncHandler = require("express-async-handler");
const { staffRepo, staffScopeRepo, sessionRepo } = require("../../repositories");
const { notify, notifyAndWait } = require("../../notifications");
const sessionService = require("../../services/session.service");
const cookieService = require("../../services/cookie.service");
const { isConfined } = require("../../lib/pfiScope");

const REALM = "staff";

// The sidebar/route-guard need canViewAllLocations and pageOverrides at login
// (not just in the admin-management screens) to decide what this session can
// see — so this payload builder needs the extra lookup, hence async.
const getAdminPayload = async (user) => {
  const ctx = await staffScopeRepo.getAuthContext(user.id);
  const { pageOverrides } = ctx;
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    surname: user.surname,
    roles: user.roles,
    canViewAllLocations: user.canViewAllLocations,
    // Whether this session is confined to its PFIs, decided here by the rule
    // the server actually enforces (lib/pfiScope.js) rather than re-derived on
    // the client. The sidebar hides what a confined person would be refused;
    // the refusal itself is still the server's, this only spares them the
    // dead ends.
    pfiScoped: isConfined(ctx),
    pageOverrides: pageOverrides.map((o) => ({ routePath: o.routePath, allowed: o.allowed })),
    profilePicture: {
      url: user.profilePictureUrl,
      publicId: user.profilePicturePublicId,
    },
  };
};

const handleLogin = asyncHandler(async (req, res) => {
  let { email, password } = req.body;

  if (!email || !password) {
    return res
      .status(400)
      .json({ success: false, message: "Email and password required" });
  }

  email = email.trim().toLowerCase();

  const foundAdmin = await staffRepo.findByEmail(email);
  if (!foundAdmin || !foundAdmin.isActive || foundAdmin.suspended) {
    return res
      .status(401)
      .json({ success: false, message: "Invalid credentials" });
  }

  const match = await staffRepo.comparePassword(foundAdmin, password);
  if (!match) {
    return res
      .status(401)
      .json({ success: false, message: "Invalid credentials" });
  }

  const { accessToken, refreshToken } = await sessionService.issue(
    REALM,
    foundAdmin,
    sessionService.requestContext(req)
  );
  await staffRepo.update(foundAdmin.id, { lastLoginAt: new Date() });

  const { refreshToken: bodyToken, csrfToken } = cookieService.applyIssuedToken(
    req,
    res,
    REALM,
    refreshToken
  );

  res.json({
    success: true,
    message: "Login successful",
    data: {
      user: await getAdminPayload(foundAdmin),
      accessToken,
      // Omitted when the client declared X-Auth-Transport: cookie.
      ...(bodyToken !== undefined ? { refreshToken: bodyToken } : {}),
      ...(csrfToken !== undefined ? { csrfToken } : {}),
    },
  });
});

const handleRefreshToken = asyncHandler(async (req, res) => {
  const { token: presented } = cookieService.readRefreshToken(req, REALM);
  if (!presented) {
    return res
      .status(400)
      .json({ success: false, message: "Refresh token required" });
  }

  const result = await sessionService.rotate(
    REALM,
    presented,
    sessionService.requestContext(req)
  );

  if (!result.ok) {
    cookieService.clearRefreshCookie(res, REALM);
    // Every failure answers identically. Telling the caller whether a token was
    // merely stale, already rotated, or belonged to a suspended account would
    // hand an attacker a probe — and the 403 shape is preserved from the
    // previous implementation, which clients branch on.
    return res.status(403).json({ success: false, message: "Forbidden" });
  }

  const admin = await staffRepo.findById(result.session.staffId);
  const { refreshToken: bodyToken, csrfToken } = cookieService.applyIssuedToken(
    req,
    res,
    REALM,
    result.refreshToken
  );

  res.json({
    success: true,
    message: "Token refreshed",
    data: {
      user: await getAdminPayload(admin),
      accessToken: result.accessToken,
      ...(bodyToken !== undefined ? { refreshToken: bodyToken } : {}),
      ...(csrfToken !== undefined ? { csrfToken } : {}),
    },
  });
});

const handleLogout = asyncHandler(async (req, res) => {
  const { token: presented } = cookieService.readRefreshToken(req, REALM);
  // Cleared regardless of whether the token resolved to a session — a stale
  // cookie should not survive a logout attempt.
  cookieService.clearRefreshCookie(res, REALM);
  if (!presented) return res.sendStatus(204);

  const revoked = await sessionService.revoke(REALM, presented, "logout");
  if (!revoked) return res.sendStatus(204);

  res.status(200).json({ success: true, message: "Logged out" });
});

/** Revoke every session for the caller — the "sign out everywhere" control. */
const handleLogoutAll = asyncHandler(async (req, res) => {
  const revoked = await sessionService.revokeAll(REALM, req.user.id, "logout_all");
  res.json({
    success: true,
    message: "Signed out of all devices",
    data: { revokedCount: revoked.length },
  });
});

/** The caller's live sessions. Never exposes the token hash. */
const handleListSessions = asyncHandler(async (req, res) => {
  const rows = await sessionRepo.listActive(REALM, req.user.id);
  res.json({
    success: true,
    data: {
      sessions: rows.map((s) => ({
        id: s.id,
        deviceName: s.deviceName,
        userAgent: s.userAgent,
        ipAddress: s.ipAddress,
        lastUsedAt: s.lastUsedAt,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        current: req.authSession?.id === s.id,
      })),
    },
  });
});

/** Revoke one device. Ownership is in the WHERE, not a post-fetch check. */
const handleRevokeSession = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ success: false, message: "Invalid session id" });
  }

  const revoked = await sessionRepo.revokeOwnedById(REALM, req.user.id, id, "logout");
  if (!revoked) {
    return res.status(404).json({ success: false, message: "Session not found" });
  }
  res.json({ success: true, message: "Session revoked" });
});

const handleSetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({
      success: false,
      message: "Token and password are required",
    });
  }

  if (password.length < 8) {
    return res.status(400).json({
      success: false,
      message: "Password must be at least 8 characters",
    });
  }

  const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

  const admin = await staffRepo.findByPasswordResetToken(hashedToken);
  if (!admin) {
    return res.status(400).json({
      success: false,
      message: "Invalid or expired token. Please request a new invitation.",
    });
  }

  await staffRepo.update(admin.id, {
    password,
    isPasswordSet: true,
    passwordResetToken: null,
    passwordResetExpires: null,
  });

  // A password change must end every existing session. Otherwise someone who
  // reset the password to lock an intruder out leaves that intruder logged in.
  await sessionService.revokeAll(REALM, admin.id, "password_change");

  // Mandatory in the catalog, so no preference can mute it: an unexpected
  // "your password was changed" is how an account takeover gets noticed. It
  // lands in the inbox and pushes to any registered device — neither of which
  // needs the sessions that were just revoked.
  notify("security.credential_changed", {
    to: { staffId: admin.id },
    data: { credential: "password", at: new Date() },
  });

  res.json({
    success: true,
    message: "Password set successfully. You can now log in.",
  });
});

const handleForgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res
      .status(400)
      .json({ success: false, message: "Email is required" });
  }

  const normalizedEmail = email.trim().toLowerCase();

  const successResponse = () =>
    res.json({
      success: true,
      message:
        "If that email is registered, a password reset link has been sent.",
    });

  const foundAdmin = await staffRepo.findByEmail(normalizedEmail);
  if (!foundAdmin || !foundAdmin.isActive) {
    return successResponse();
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  const hashedToken = crypto
    .createHash("sha256")
    .update(rawToken)
    .digest("hex");

  await staffRepo.update(foundAdmin.id, {
    passwordResetToken: hashedToken,
    passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000),
  });

  const sent = await notifyAndWait("account.password_reset", {
    to: { staffId: foundAdmin.id },
    data: {
      firstName: foundAdmin.firstName,
      resetUrl: `${process.env.CLIENT_URL}/set-password?token=${rawToken}`,
    },
  });

  if (sent.results?.[0]?.channels?.email !== "sent") {
    console.error("Failed to send password reset email to", foundAdmin.email);
    return res.status(500).json({
      success: false,
      message: "Failed to send email. Please try again later.",
    });
  }

  return successResponse();
});

const handleGetMe = asyncHandler(async (req, res) => {
  const admin = await staffRepo.findById(req.user.id);
  if (!admin) {
    return res.status(404).json({ success: false, message: "User not found" });
  }

  const { password, refreshToken, passwordResetToken, passwordResetExpires, ...safeAdmin } = admin;

  res.json({
    success: true,
    data: { user: safeAdmin },
  });
});

module.exports = {
  handleLogin,
  handleRefreshToken,
  handleLogout,
  handleLogoutAll,
  handleListSessions,
  handleRevokeSession,
  handleGetMe,
  handleSetPassword,
  handleForgotPassword,
};
