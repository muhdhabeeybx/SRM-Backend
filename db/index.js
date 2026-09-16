const { drizzle } = require("drizzle-orm/postgres-js");
const postgres = require("postgres");

const schema = require("./schema");
const relations = require("./relations");

/**
 * There was a patch here that claimed to make PgTimestamp accept strings and
 * numbers as well as Dates. It never ran once.
 *
 * It assigned to `PgTimestamp.prototype.mapToDriverValue`, but drizzle defines
 * that member as an arrow-function CLASS FIELD:
 *
 *   mapToDriverValue = (value) => value.toISOString();
 *
 * A class field is an OWN property set on every instance at construction, so
 * each column shadows the prototype and the patched function was never
 * reachable. Removing it is behaviour-neutral — verified by checking that
 * `orderPayments.txnDate` has its own `mapToDriverValue` and that it is not
 * the patched function.
 *
 * It is gone rather than repaired because the guarantee it advertised is what
 * made migration 0039 look safe: `bank_statement_lines.txn_date` became a
 * `date`, Drizzle started returning "YYYY-MM-DD" strings, and the code copying
 * one into a `timestamptz` column threw `value.toISOString is not a function`
 * on every payment confirmation. Converting at the copy site — where the
 * intended instant is actually known — is the fix; see statementDayToInstant
 * in services/orderPayment.service.js. A blanket coercion here would only have
 * turned that outage into a silent day-shift.
 */

// Under a test run, use TEST_DATABASE_URL when provided so fixtures never touch
// the app's real database. Everything else (the server, migrations, seeds) runs
// against DATABASE_URL as before.

/**
 * Are we running under a test runner?
 *
 * This asked `NODE_ENV === "test"` and nothing else, which is only what the
 * `npm test` script sets. That is not enough, and the gap is not theoretical:
 *
 *   node --test tests/wa-pipeline.test.js
 *
 * is the obvious way to run one suite, and it is what an editor's "run test"
 * button does. It leaves NODE_ENV unset, so `isTest` was false, so the guard
 * below — the entire point of which is to stop this — never evaluated, and the
 * suite connected to DATABASE_URL and inserted its fixtures into production.
 * That is how a depot called "Pipe Depot 7462", a product called "Pipe PMS
 * 7462", a PFI, a customer and a live order reached the dashboard, and how
 * "Dash Depot"/"Cust N" got into the dev database before them.
 *
 * A safety check that only fires when invoked the least convenient way is not
 * a safety check. Node's own runner sets NODE_TEST_CONTEXT in every test child
 * process, so ask that too; the argv checks catch a runner that sets neither.
 */
const isTest =
  process.env.NODE_ENV === "test" ||
  process.env.NODE_TEST_CONTEXT !== undefined ||
  process.argv.includes("--test") ||
  process.argv.some((a) => /\.test\.[cm]?js$/.test(a));
const connectionString =
  isTest && process.env.TEST_DATABASE_URL
    ? process.env.TEST_DATABASE_URL
    : process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is not set");
}

/**
 * Guard against the exact failure that leaked "Dash Depot"/"Cust N" fixtures
 * into the shared dev database: the suites insert real rows and don't clean up,
 * so running them against anything but a throwaway database pollutes it.
 *
 * A localhost Postgres is a throwaway (CI spins one up per run) and is always
 * allowed. A remote host is refused unless TEST_DATABASE_URL points at an
 * isolated database — in which case we're already using it — or the operator
 * explicitly opts in. This lets CI pass untouched while forcing local runs to
 * isolate.
 */
if (isTest && !process.env.TEST_DATABASE_URL && process.env.ALLOW_TESTS_ON_DEV_DB !== "true") {
  let host = "(unparseable)";
  try {
    host = new URL(connectionString).host;
  } catch {
    /* leave placeholder */
  }
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host);
  if (!isLocal) {
    throw new Error(
      `Refusing to run tests against the remote database "${host}" — test fixtures would pollute it.\n` +
        `Set TEST_DATABASE_URL to an isolated database (e.g. a separate Neon database — see .env.example),\n` +
        `or set ALLOW_TESTS_ON_DEV_DB=true to override for a one-off run.`
    );
  }
}

const client = postgres(connectionString, {
  // Neon's pooler kills idle connections aggressively (often ~5 min on free
  // tier, configurable on paid). Recycle ours well before that threshold so
  // queries never hit a server-closed socket.
  idle_timeout: 20,        // seconds — release idle connections after 20 s
  connect_timeout: 10,     // seconds — give up connecting after 10 s
  max: 10,                 // connection-pool ceiling
  max_lifetime: 60 * 30,   // seconds — hard recycle every 30 min
});

const db = drizzle(client, {
  schema: {
    ...schema,
    ...relations,
  },
});

const testConnection = async () => {
  try {
    await client`SELECT 1`;
    console.log("Neon PostgreSQL connected successfully");
  } catch (err) {
    console.error("Neon PostgreSQL connection failed:", err.message);
    throw err;
  }
};

module.exports = { db, client, testConnection };
