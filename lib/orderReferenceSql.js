const { sql } = require("drizzle-orm");

/**
 * The customer-facing order reference, in SQL.
 *
 * "HA10831", not "ORD-BB464940706C". The ORD- value in orders.order_number is
 * an opaque internal id minted before the row exists; the reference every
 * screen, invoice, SMS, ticket and QR code shows is computed from the customer's
 * company initials and the order id. Quoting the raw column at somebody names
 * an order they cannot find on any screen — and 511 orders carry an ORD- value,
 * so this is not hypothetical.
 *
 * Read paths through the order repository already get this from
 * formatOrderRow(). Raw SQL elsewhere did not, and that is where the ORD- forms
 * were surfacing: the gate queue, the desk backlogs, the nudges, the PFI order
 * lists, the payment views and several reports.
 *
 * ── Why a second implementation, and how it is kept honest ────────────────
 *
 * This is the SQL twin of generateOrderReference() in utils/helpers.js, and two
 * implementations of one rule can drift. The alternative — selecting the
 * company and the id and decorating every row in JS — means every raw query
 * grows a mapping step that a future caller will forget, which is exactly how
 * the leaks happened. So: one shared fragment, defined here only, with
 * tests/orderReference.test.js asserting the two agree across every order in
 * the database. If they ever diverge, that test fails rather than a customer
 * receiving a reference nobody can look up.
 *
 * The company follows the same precedence formatOrderRow uses: the order's own
 * company_name, then the customer's, then "SO" for neither. NULLIF(btrim(…),'')
 * reproduces the JS `||` chain, where an empty string falls through.
 *
 * @param {string} orderAlias    the orders alias in the query, e.g. "o"
 * @param {string|null} customerAlias the customers alias, or null if not joined
 */
/**
 * The expression as a plain string.
 *
 * Two query builders are in use — Drizzle's `sql` and postgres.js's `client`
 * tagged template — and a fragment built for one cannot be nested in the other.
 * Both wrappers below are built from this one string so the rule itself still
 * exists in exactly one place.
 *
 * It interpolates only fixed aliases chosen by the calling code, never user
 * input, which is why it is safe to inject unescaped.
 *
 * @param {string} orderAlias         the orders alias, e.g. "o"
 * @param {string|null} customerAlias the customers alias, or null when not joined
 */
const orderReferenceExpr = (orderAlias = "o", customerAlias = "c") => {
  const company = customerAlias
    ? `COALESCE(NULLIF(btrim(${orderAlias}.company_name), ''), NULLIF(btrim(${customerAlias}.company_name), ''), '')`
    : `COALESCE(NULLIF(btrim(${orderAlias}.company_name), ''), '')`;

  const words = `regexp_split_to_array(${company}, '\\s+')`;

  return `(
    CASE
      WHEN ${company} = '' THEN 'SO'
      -- More than one word: the first letter of the first two words.
      WHEN array_length(${words}, 1) > 1
        THEN upper(left((${words})[1], 1) || left((${words})[2], 1))
      -- One word: its first two characters.
      ELSE upper(left(${company}, 2))
    END || ${orderAlias}.id::text
  )`;
};

/** For Drizzle queries: `${orderReferenceSql("o", "c")} AS "orderNumber"`. */
const orderReferenceSql = (orderAlias = "o", customerAlias = "c") =>
  sql.raw(orderReferenceExpr(orderAlias, customerAlias));

/**
 * For postgres.js queries: `${orderReferenceClient(client, "o", "c")} AS ref`.
 *
 * Takes the client rather than importing one, so this module stays free of a
 * database connection and can be required from anywhere.
 */
const orderReferenceClient = (client, orderAlias = "o", customerAlias = "c") =>
  client.unsafe(orderReferenceExpr(orderAlias, customerAlias));

module.exports = { orderReferenceSql, orderReferenceExpr, orderReferenceClient };
