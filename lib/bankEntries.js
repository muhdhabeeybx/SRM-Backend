const { sql } = require("drizzle-orm");

/**
 * The bank's own entries on a statement — never money a customer sent.
 *
 * A statement's credit column carries rows the bank wrote for itself: a
 * reversal of its own earlier entry, a fee it charged or took back ("TNS
 * Recovery SEPT 28-30 2026", Keystone, 9 Oct 2026), interest it charged, and
 * interest it paid ("Credit Interest"). In the pool they look exactly like a
 * payment, and matching one to an order invents a payment.
 *
 * Two treatments, by whether the row is money in at all:
 *
 *   left out   reversals, charges, fee recoveries, debit interest. Not money
 *              in, so the upload does not import them (bankStatement
 *              repository partitionRows).
 *   imported   interest paid by the bank. Real money in: the books need it
 *              (the Accounts module reconciles every bank to its printed
 *              balance), so it is imported — but read as the bank's own entry
 *              wherever lines are offered or claimed, never as a payment.
 *
 * An unmatched line answering to any of them is the bank's own entry: off
 * every payment list and pool, and refused by every claim (assertNotBankEntries).
 * A line already matched is left exactly as it was — changes go forward only.
 *
 * ── Whole words, and a narrow list ────────────────────────────────────────
 *
 * The obvious rule — does the text contain "vat" — silently drops
 * 3LCINOVATE ENERGY LIMITED, ten real payments over ₦2.2bn (3LCINO·VAT·E). So
 * every term is a WHOLE word, and a term earns its place by appearing in a
 * bank's own wording, not by sounding financial. Bare "vat" is not here
 * ("STERNOM CONSULT/Refund of VAT" is a real ₦1,376,250 credit, and Keystone
 * prints "VAT -" on every transfer). Nor is bare "credit": on 16 Oct 2026 it
 * appeared on 278 matched customer payments, ₦19.6bn — "CIP CR", "NIP CREDIT"
 * and the like — and on two bank entries, both of which "interest" catches.
 *
 * Checked against every line on the live book that day: the list catches 6
 * unmatched lines (2 Credit Interest, 2 TNS Recovery, an SMS charge, a debit
 * interest) and not one of the 5,818 matched payments.
 *
 * `RSVL` is how the bank usually writes a reversal, a maintenance-fee reversal
 * came through as `REVSL:`, and RVSL is the transposition everyone reaches
 * for — all three are matched, and the spelt-out word.
 */
const RULES = [
  { kind: "reversal", imported: false, terms: ["rsvl", "rvsl", "revsl", "reversal", "reversed"] },
  {
    kind: "bank charge",
    imported: false,
    terms: [
      "charge", "charges", "chrg", "commission", "levy",
      "stamp duty", "sms alert", "maintenance fee", "account maintenance",
      // A fee taken back, and VAT on maintenance.
      "(tns|sms|alert|cot|charges?|fees?|maintenance|vat) recovery", "vatmain",
      // Interest the bank charged. Before "interest" below, which it also says.
      "(debit|dr) int(erest)?", "overdraft interest",
    ],
  },
  { kind: "interest", imported: true, terms: ["interest", "(credit|cr) int"] },
];

// A space in a term is any run of whitespace; the pieces are plain regex that
// JavaScript and PostgreSQL read alike.
const alternatives = (terms) => terms.map((t) => t.replace(/ /g, "\\s+")).join("|");
const MATCHERS = RULES.map((r) => ({ ...r, re: new RegExp(`\\b(?:${alternatives(r.terms)})\\b`, "i") }));
/** PostgreSQL's word boundary is \y — \b there is a backspace. */
const pgWords = (terms) => `\\y(?:${alternatives(terms)})\\y`;
const PG_PATTERN = pgWords(RULES.flatMap((r) => r.terms));

/**
 * The row's own cells, read for the wording too: one account's mapping lands
 * the bank's text in a column it reads nothing from ("SMS CHARGE 28AUG TO
 * 24SEP 2026", account 14, with depositor and narration both "-"). Values
 * only — a row kept as an object is keyed by the file's headings, and
 * "Amount Credit" or a "Charges" column is a heading, not the bank speaking.
 */
const cellText = (raw) => {
  const cells = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
  return cells.filter((v) => typeof v === "string").join(" ");
};

const textOf = (r) =>
  [r.depositor, r.narration, r.bankRef ?? r.bank_ref, cellText(r.rawRow ?? r.raw_row)].filter(Boolean).join(" ");

const ruleFor = (r) => {
  const text = textOf(r);
  return MATCHERS.find((m) => m.re.test(text)) || null;
};

/** What the bank's own entry this row is ("reversal", "bank charge", "interest"), or null. */
const bankEntryKind = (r) => ruleFor(r)?.kind ?? null;

/** Why the upload leaves this row out — not money in at all — or null. */
const leftOutOnUpload = (r) => {
  const rule = ruleFor(r);
  return rule && !rule.imported ? rule.kind : null;
};

/** Strips `"heading":` from a row kept as an object, leaving its values. */
const HEADING = '"(?:[^"\\\\]|\\\\.)*"\\s*:';

/**
 * SQL: the line `alias` is an unmatched bank entry. For the postgres.js
 * `client` (repositories) and for drizzle's `sql` (services) — the same
 * words, bound as parameters.
 */
const textClient = (client, a) => client`(
    ${a}.depositor || ' ' || ${a}.narration || ' ' || ${a}.bank_ref || ' ' ||
    regexp_replace(COALESCE(${a}.raw_row::text, ''), ${HEADING}, ' ', 'g')
  )`;
const bankEntryClient = (client, alias = "l") => {
  const a = client.unsafe(alias);
  return client`(${a}.status = 'UNMATCHED' AND ${textClient(client, a)} ~* ${PG_PATTERN})`;
};
/** SQL: which bank entry the line is ("reversal", "bank charge", "interest"), else null. */
const bankEntryKindClient = (client, alias = "l") => {
  const a = client.unsafe(alias);
  const text = textClient(client, a);
  const whens = RULES.reduce(
    (acc, r) => client`${acc} WHEN ${text} ~* ${pgWords(r.terms)} THEN ${r.kind}::text`,
    client``,
  );
  return client`CASE WHEN ${a}.status = 'UNMATCHED' THEN CASE ${whens} END END`;
};
const bankEntrySql = (alias = "l") => {
  const a = sql.raw(alias);
  return sql`(${a}.status = 'UNMATCHED' AND (
    ${a}.depositor || ' ' || ${a}.narration || ' ' || ${a}.bank_ref || ' ' ||
    regexp_replace(COALESCE(${a}.raw_row::text, ''), ${HEADING}, ' ', 'g')
  ) ~* ${PG_PATTERN})`;
};

const rowsOf = (r) => (Array.isArray(r) ? r : r?.rows ?? []);

/**
 * Refuse a claim naming any of the bank's own entries. Every path that spends
 * a statement line calls this before it claims: orders, truck sales and
 * station deposits, deposits, and the match endpoint.
 */
const assertNotBankEntries = async (db, lineIds) => {
  const ids = [...new Set((lineIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return;
  const found = rowsOf(await db.execute(sql`
    SELECT l.id, l.amount, l.depositor, l.narration, l.bank_ref, l.raw_row
      FROM bank_statement_lines l
     WHERE l.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
       AND ${bankEntrySql("l")}
  `));
  if (!found.length) return;
  const named = found
    .map((l) => `${String(l.depositor || l.narration || "").trim().slice(0, 40) || `line ${l.id}`} (₦${Number(l.amount).toLocaleString("en-NG")})`)
    .join("; ");
  throw Object.assign(
    new Error(`Not a customer payment — the bank's own entry: ${named}. It cannot be used for an order or any other payment.`),
    { status: 409, statusCode: 409, code: "BANK_OWN_ENTRY" },
  );
};

module.exports = {
  RULES,
  PG_PATTERN,
  bankEntryKind,
  leftOutOnUpload,
  bankEntryClient,
  bankEntryKindClient,
  bankEntrySql,
  assertNotBankEntries,
};
