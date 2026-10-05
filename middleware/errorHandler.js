const { logEvents } = require("./logger");

/**
 * PostgreSQL SQLSTATE codes that represent a *client* mistake rather than a
 * server fault. Anything not listed here is treated as a 500.
 *
 * The handler previously checked `err.code === 11000` — a MongoDB duplicate-key
 * code — which cannot occur on this stack. Every constraint violation therefore
 * fell through to a 500 carrying the driver's message, which on Postgres
 * includes the full failing statement and its column list.
 */
const PG_STATUS = {
  "23505": 409, // unique_violation
  "23503": 409, // foreign_key_violation — referenced row missing or still referenced
  "23514": 400, // check_violation — e.g. balance >= 0
  "23502": 400, // not_null_violation
  "22P02": 400, // invalid_text_representation — e.g. /customers/abc against a serial id
  "22003": 400, // numeric_value_out_of_range
  "22007": 400, // invalid_datetime_format
};

/** Friendly text per class, so a 4xx never echoes the driver's SQL. */
const PG_MESSAGE = {
  "23505": "That value is already in use",
  "23503": "A referenced record does not exist, or is still in use",
  "23514": "That change is not allowed",
  "23502": "A required field is missing",
  "22P02": "Invalid identifier or value",
  "22003": "A numeric value is out of range",
  "22007": "Invalid date format",
};

/**
 * Redaction fails CLOSED.
 *
 * The previous logic redacted only when NODE_ENV === "production", so an unset
 * or misspelled NODE_ENV in production streamed stack traces and SQL to
 * unauthenticated callers. Detail is now shown only when the environment is
 * *explicitly* one of the known non-production values.
 */
const DEV_ENVS = new Set(["development", "test"]);
const isDetailAllowed = () => DEV_ENVS.has(process.env.NODE_ENV);

/**
 * Find the SQLSTATE code, which is rarely on the error you are handed.
 *
 * Drizzle wraps driver errors: the thrown object is a plain Error whose
 * message is "Failed query: UPDATE …" — SQL and all — and whose `.cause` is
 * the real PostgresError carrying `.code`. Reading `err.code` directly finds
 * `undefined` every time, so every constraint violation falls through to a 500
 * and the wrapper's message leaks the statement.
 *
 * Walks a bounded number of links so a self-referential cause cannot loop.
 */
function pgCodeOf(err, depth = 4) {
  let current = err;
  for (let i = 0; i < depth && current; i++) {
    if (typeof current.code === "string" && PG_STATUS[current.code]) return current.code;
    current = current.cause;
  }
  return null;
}

/**
 * The message Drizzle throws is a wrapper — "Failed query: select …" plus the
 * parameters — and the actual reason lives on `.cause`. Logging only the
 * wrapper records WHICH query failed and never WHY, which is how a log full of
 * "Failed query" lines across unrelated tables says nothing at all: a dropped
 * connection, a missing column and a constraint violation all read identically.
 *
 * Walks the same bounded chain as pgCodeOf so a self-referential cause cannot
 * loop. Log only — the response body is unchanged, and a 5xx still tells the
 * caller nothing about the schema.
 */
function causeChain(err, depth = 4) {
  const parts = [];
  let current = err?.cause;
  for (let i = 0; i < depth && current; i++) {
    const code = current.code ? `[${current.code}] ` : "";
    if (current.message) parts.push(`${code}${current.message}`);
    current = current.cause;
  }
  return parts.length ? ` <- ${parts.join(" <- ")}` : "";
}

const errorHandler = (err, req, res, next) => {
  logEvents(
    `${err.name}: ${err.message}${causeChain(err)}\t${req.method}\t${req.url}\t${req.headers.origin}`,
    "errLog.log"
  );

  let status = 500;
  let message = "An internal server error occurred";
  const pgCode = pgCodeOf(err);

  // 1. An explicit status set by the thrower always wins.
  const explicit = Number(err.status || err.statusCode);
  if (Number.isInteger(explicit) && explicit >= 400 && explicit < 600) {
    status = explicit;
    message = err.message || message;
  }
  // 2. A recognised Postgres constraint violation is a client error.
  else if (pgCode) {
    status = PG_STATUS[pgCode];
    message = PG_MESSAGE[pgCode];
  }
  // 3. A validation layer that reports its own issues (zod and friends).
  else if (err.name === "ValidationError" || err.name === "ZodError") {
    status = 400;
    message = "Validation failed";
  }
  // 4. Anything else stays a 500 with a generic message. The real one is in
  //    the log, and is never returned — a 5xx means we do not know what
  //    happened, so anything we say about it is a guess that may leak schema.
  else if (status >= 500) {
    console.error(err.stack || err);
  }

  const body = { success: false, message };

  // Field-level detail from a validation error is safe and useful in any
  // environment — it describes the request, not the server.
  if (Array.isArray(err.issues)) {
    body.errors = err.issues.map((i) => ({
      path: Array.isArray(i.path) ? i.path.join(".") : String(i.path ?? ""),
      message: i.message,
    }));
  }

  // A client error may say what it needs answered — a code and the facts the
  // screen asks the person about. Set deliberately by the thrower, never from
  // the error's own fields, and never on a 5xx.
  if (status < 500 && err.details && typeof err.details === "object") {
    body.details = err.details;
  }

  if (isDetailAllowed() && status >= 500) {
    body.detail = err.message;
    body.stack = err.stack;
  }

  res.status(status).json(body);
};

module.exports = errorHandler;
