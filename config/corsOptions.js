const defaultAllowedOrigins = require("./allowedOrigins");

const normalizeOrigin = (origin) => origin.trim().replace(/\/+$/, "");

const getOriginsList = () => {
  const envOrigins = (process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean);

  const defaultOrigins = defaultAllowedOrigins.map((origin) => normalizeOrigin(origin));
  return new Set([...defaultOrigins, ...envOrigins]);
};

const isOriginAllowed = (origin) => {
  if (!origin) return false;
  const normalized = normalizeOrigin(origin);
  const allowedOriginsSet = getOriginsList();

  if (allowedOriginsSet.has(normalized)) {
    return true;
  }

  // In non-production environments (development / test), permit any localhost or 127.0.0.1 origin
  if (process.env.NODE_ENV !== "production") {
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(normalized)) {
      return true;
    }
  }

  return false;
};

const corsOptions = {
  origin: (origin, callback) => {
    // 1. Allow requests with no Origin header (e.g. Postman, cURL, mobile apps, server-to-server)
    // unless explicitly disabled via CORS_ALLOW_NO_ORIGIN=false
    if (!origin) {
      if (process.env.CORS_ALLOW_NO_ORIGIN === "false") {
        return callback(Object.assign(new Error("Not allowed by CORS"), { status: 403 }));
      }
      return callback(null, true);
    }

    // 2. Validate Origin against allowed list / dev regex
    if (isOriginAllowed(origin)) {
      return callback(null, true);
    }

    return callback(Object.assign(new Error("Not allowed by CORS"), { status: 403 }));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Accept",
    "Origin",
    "X-CSRF-Token",
    "Idempotency-Key",
    "X-Api-Key",
    "X-Auth-Transport",
    // Which dashboard page sent the request — middleware/viewOnlyPages.js.
    "X-Dashboard-Page",
  ],
  exposedHeaders: [
    "Content-Range",
    "X-Content-Range",
    "Set-Cookie",
    "X-Total-Count",
    "X-Request-ID",
  ],
  maxAge: 86400,
  optionsSuccessStatus: 200,
};

/**
 * Pre-CORS middleware that detects mobile-app requests and sets CORS headers
 * directly. The `cors` library only passes `req.headers.origin` (a string) to
 * its origin callback — not the full `req` object — so we cannot inspect
 * mobile-identifying headers (X-Auth-Transport, X-Api-Key) inside that
 * callback. This middleware runs *before* cors() and short-circuits for
 * recognised mobile traffic, letting browser requests fall through to cors()
 * as normal.
 */
const mobileCorsBypass = (req, res, next) => {
  // If the request has an Origin header it's a browser request — let cors() handle it.
  if (req.headers.origin) return next();

  const isMobile =
    req.headers["x-auth-transport"] === "body" ||
    !!req.headers["x-api-key"];

  if (!isMobile) return next(); // not a recognised mobile request → let cors() decide

  // Set CORS headers for the mobile app
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,Authorization,X-Requested-With,Accept,Origin,X-CSRF-Token,Idempotency-Key,X-Api-Key,X-Auth-Transport"
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Range,X-Content-Range,Set-Cookie,X-Total-Count,X-Request-ID"
  );
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  req._mobileCorsBypassed = true;
  next();
};

module.exports = corsOptions;
module.exports.mobileCorsBypass = mobileCorsBypass;
