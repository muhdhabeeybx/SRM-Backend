/**
 * The whole backend runs on Lagos time.
 *
 * Required first — from app.js and db/index.js, which between them are loaded
 * by the server, the scheduler, every script and every test — so no Date is
 * made before the zone is set.
 *
 * Production hosts run in UTC, so until now anything that read the local
 * clock — setHours(0) for "the start of today", toLocaleString() in an email,
 * the hour on a PDF — was an hour behind Lagos, and the first hour of every
 * Lagos day belonged to the day before. Stored instants are unaffected: a
 * timestamptz or a Date is the same moment in any zone. What changes is how a
 * moment is read as a day or a clock time, and that is now Lagos everywhere.
 *
 * The database session is set to the same zone in db/index.js. REPORT_TIMEZONE
 * overrides both, for a test that needs another zone.
 */
process.env.TZ = process.env.REPORT_TIMEZONE || "Africa/Lagos";
