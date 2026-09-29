/**
 * Company identity that appears inside message copy.
 *
 * This exists because of a specific failure mode in the Django system these
 * templates came from: the company name was written into the copy in three
 * different places — `SOROMAN:` hardcoded at the head of every delivery SMS,
 * "Thank you for choosing Soroman" in the order templates, and a `company`
 * argument that one branch accepted and then ignored. Changing the Termii
 * sender ID moved none of them, so the only way to rebrand was to grep for a
 * string literal and hope you found them all.
 *
 * Everything user-visible now reads from here.
 *
 * SUPPORT_PHONES deliberately has NO fallback. In Django it defaulted to three
 * real Soroman numbers, so any deployment that forgot the setting quietly told
 * its customers to call Soroman. An unset value here renders nothing at all,
 * which is the safe direction to fail.
 */

const clean = (v) => String(v ?? "").trim();

/** Display name used in copy and sign-offs. */
const companyName = () => clean(process.env.COMPANY_NAME) || "Soroman";

/** Longer legal-ish name for email sign-offs. */
const companyLongName = () => clean(process.env.COMPANY_LONG_NAME) || `${companyName()} Energy`;

/**
 * Optional prefix stamped on operational SMS. Off by default: every text now
 * goes out under the whitelisted SOROMAN sender ID, so the handset already
 * says who sent it and "Soroman:" at the head of the body only repeated it.
 * Set SMS_BRAND_PREFIX (e.g. "Soroman:") to bring it back.
 */
const smsPrefix = () => {
  const value = clean(process.env.SMS_BRAND_PREFIX);
  return value ? `${value} ` : "";
};

/**
 * The truck/driver flow's variant — Django opened those texts "SOROMAN:".
 * Off by default for the same reason as smsPrefix; set SMS_BRAND_PREFIX_LOUD
 * to bring it back.
 */
const smsPrefixLoud = () => {
  const value = clean(process.env.SMS_BRAND_PREFIX_LOUD);
  return value ? `${value} ` : "";
};

/**
 * Support numbers printed in customer emails. Comma-separated; empty when unset.
 * @returns {string[]}
 */
const supportPhones = () =>
  clean(process.env.SUPPORT_PHONES)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** "07060659524 | 08035370741" — or "" when nothing is configured. */
const supportPhoneLine = () => supportPhones().join(" | ");

/**
 * The sentence customer mail closes with. Renders to "" rather than to a
 * dangling "please contact:" when no numbers are set.
 */
const supportSentence = () => {
  const line = supportPhoneLine();
  return line ? `For any enquiries, please contact: ${line}` : "";
};

/** Where staff log in. Used by the account emails. */
const dashboardUrl = () =>
  clean(process.env.ADMIN_URL) || clean(process.env.CLIENT_URL) || "";

module.exports = {
  companyName,
  companyLongName,
  smsPrefix,
  smsPrefixLoud,
  supportPhones,
  supportPhoneLine,
  supportSentence,
  dashboardUrl,
};
