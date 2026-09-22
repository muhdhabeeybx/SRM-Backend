/**
 * When an unpaid order (or approved Dangote/LPG request) lapses.
 *
 * ── The policy ─────────────────────────────────────────────────────────────
 *
 * Everything still unpaid expires at 23:59 Africa/Lagos on the day it was
 * placed. Not 24 hours after placement — the END OF ITS DAY.
 *
 * This replaced a rolling 24-hour window, and the reason is stock rather than
 * tidiness. A Pending order holds a reservation against depot stock
 * (releaseOrderResources hands it back on expiry), so under the old rule the
 * quantity available tomorrow morning depended on what time yesterday people
 * happened to order — a 4pm order kept its litres locked until 4pm the next
 * day, invisible to anyone looking at the book at 8am. Clearing at the day
 * boundary means each trading day opens with the depot's real position.
 *
 * The blunt consequence is accepted deliberately: an order placed at 23:50
 * lapses nine minutes later. There is no grace window and no rollover, because
 * a reservation that survives the night is exactly the thing this prevents.
 *
 * ── What it does NOT touch ─────────────────────────────────────────────────
 *
 * Only a WHOLLY UNPAID order lapses. A Part Paid order is funded — money is
 * held against it and it may already have been ticketed — so expiring it would
 * strand that payment on a dead record and release stock somebody has paid
 * toward. See isOrderExpired in services/order.service.js.
 */

const { zonedTimeOnDay, dayBounds } = require("../lib/zonedDay");

const EXPIRY_TZ = () => process.env.ORDER_EXPIRY_TZ || process.env.REPORT_TIMEZONE || "Africa/Lagos";

/**
 * The wall-clock time orders lapse at, as [hour, minute]. "23:59" by default.
 *
 * One setting so the deadline shown to the customer and the cron that enforces
 * it cannot drift apart — jobs/scheduler.js builds its cron expression from
 * this, rather than carrying a second copy of the hour.
 */
const expiryTimeOfDay = () => {
  const raw = String(process.env.ORDER_EXPIRY_AT || "23:59").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!m) return [23, 59];
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) return [23, 59];
  return [hour, minute];
};

/**
 * Kill switch for the whole expiry mechanism — both the sweep and the
 * lazy per-request check. A temporary business call, not a config tune, so
 * it's an explicit flag rather than an implausibly distant deadline: intent
 * ("expiry is off") should be readable in the env, not inferred.
 */
const orderExpiryDisabled = () => String(process.env.ORDER_EXPIRY_DISABLED || "").toLowerCase() === "true";

/**
 * The instant a thing anchored at `anchor` lapses: 23:59 Lagos on the anchor's
 * own Lagos day. `anchor` is an order's createdAt, or a request's reviewedAt.
 *
 * The one exception is the minute AFTER the deadline. An order placed at
 * 23:59:30 has no 23:59 left to reach, and taking the day's deadline literally
 * would make it lapse the instant it was written — created, stock reserved,
 * then expired and the customer texted that it lapsed, all before they could
 * read the account number. That is a bug wearing a policy's clothes, so such
 * an order takes the NEXT day's deadline instead. It costs one night of held
 * stock on at most a minute's worth of orders, which is the cheaper mistake.
 */
/**
 * The deadline instant on the calendar day `at` falls in — no rollover.
 *
 * Kept separate from expiryDeadline because the two answer different
 * questions. This one is "when does today's gate close", which is what the
 * sweep needs; expiryDeadline is "when does THIS order die", which has to step
 * over the case of an order placed after the gate already closed. Passing a
 * clock reading to expiryDeadline and expecting today's deadline back is
 * exactly the bug this split exists to prevent.
 */
const deadlineOnDayOf = (at) => {
  const [hour, minute] = expiryTimeOfDay();
  return zonedTimeOnDay(at, hour, minute, 0, 0, EXPIRY_TZ());
};

const expiryDeadline = (anchor) => {
  const at = anchor instanceof Date ? anchor : new Date(anchor);
  if (Number.isNaN(at.getTime())) return null;
  const [hour, minute] = expiryTimeOfDay();
  const tz = EXPIRY_TZ();

  const sameDay = deadlineOnDayOf(at);
  if (at.getTime() < sameDay.getTime()) return sameDay;

  // Land inside the next Lagos day, then take that day's deadline. Stepping
  // via the day's own end keeps this right in a zone where a day is not
  // exactly 24 hours long.
  const nextDay = new Date(dayBounds(at, tz).end.getTime() + 60 * 60 * 1000);
  return zonedTimeOnDay(nextDay, hour, minute, 0, 0, tz);
};

/** Has the deadline for `anchor` passed at `now`? */
const hasLapsed = (anchor, now = Date.now()) => {
  const deadline = expiryDeadline(anchor);
  return deadline !== null && now >= deadline.getTime();
};

/**
 * A COARSE upper bound for the sweep's `createdAt <= cutoff` query: every row
 * that could have lapsed, and possibly a few that have not. It keeps the sweep
 * to one indexed range scan instead of loading every Pending row; the caller
 * then decides each row exactly with hasLapsed(). Both halves are needed —
 * this one alone would wrongly lapse an order placed in the minute after last
 * night's deadline, whose deadline rolled to tonight.
 *
 * Two cases, and the boundary between them is the whole point:
 *
 *   - At or past today's deadline (23:59 → midnight), today's own orders have
 *     lapsed too, so everything up to now qualifies.
 *   - Before it, only orders from an earlier day have lapsed — today's are
 *     still live however old they are. The cutoff is the last instant of
 *     yesterday, so an order created exactly at 00:00:00.000 today is excluded
 *     rather than swept the moment it is placed.
 */
const sweepCutoff = (now = new Date()) => {
  const at = now instanceof Date ? now : new Date(now);
  // Today's gate-closing instant, NOT expiryDeadline(at) — see deadlineOnDayOf.
  const deadline = deadlineOnDayOf(at);
  if (at.getTime() >= deadline.getTime()) return at;
  return new Date(dayBounds(at, EXPIRY_TZ()).start.getTime() - 1);
};

/**
 * The longest a customer can ever have — a ceiling for public copy, NOT a
 * promise. Anyone stating a real deadline should use the order's own
 * `expiresAt`, or expiryDeadline(new Date()) for a not-yet-placed order.
 */
const orderExpiryHours = () => 24;

module.exports = {
  orderExpiryDisabled,
  expiryDeadline,
  hasLapsed,
  sweepCutoff,
  expiryTimeOfDay,
  orderExpiryHours,
  EXPIRY_TZ,
};
