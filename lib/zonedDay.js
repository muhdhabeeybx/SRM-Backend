/**
 * Calendar-day arithmetic in a named IANA zone.
 *
 * Soroman trades on a Lagos day, not a UTC one, and several unrelated features
 * need to agree on where that day starts and ends: the daily report's window,
 * and the order-expiry deadline that lapses an unpaid order at the end of the
 * day it was placed. Both were getting this wrong in their own way before it
 * lived in one place — the report by taking UTC midnight either side (see
 * dailyCombinedReport.service.js for the hole that opened), expiry by counting
 * a flat 24 hours from creation and never thinking about a calendar at all.
 *
 * The maths is deliberately Intl-only: no tz database ships with this repo and
 * none needs to, because the runtime already has one. Nigeria has no DST, so
 * every zone-aware step here is strictly speaking unnecessary today — it is
 * written anyway so that a zone which does observe DST (or a Nigeria that ever
 * adopts it) lands on the right instant instead of an hour out twice a year.
 */

const DEFAULT_TZ = () => process.env.REPORT_TIMEZONE || "Africa/Lagos";

/** "2026-09-04" — the calendar date at this instant, in the given zone. */
const localDateStr = (date, tz = DEFAULT_TZ()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

/** How far the zone is ahead of UTC at a given instant, in ms. */
const zoneOffsetMs = (date, tz = DEFAULT_TZ()) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)])
  );
  // `hour` comes back as 24 at midnight under hour12:false in some ICU builds.
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return asIfUtc - Math.floor(date.getTime() / 1000) * 1000;
};

/**
 * The UTC instant at which a given local calendar day begins.
 *
 * Two passes: the first guess uses the offset at UTC midnight, the second
 * re-reads the offset at that guess. Lagos has no DST so one pass would do,
 * but a zone that does would land an hour out on two days a year.
 */
const zonedDayStart = (dayStr, tz = DEFAULT_TZ()) => {
  const guess = new Date(`${dayStr}T00:00:00Z`);
  let instant = new Date(guess.getTime() - zoneOffsetMs(guess, tz));
  instant = new Date(guess.getTime() - zoneOffsetMs(instant, tz));
  return instant;
};

/** The half-open window [start, end) of the local day containing `date`. */
const dayBounds = (date, tz = DEFAULT_TZ()) => {
  const dayStr = localDateStr(date, tz);
  const start = zonedDayStart(dayStr, tz);
  const next = new Date(`${dayStr}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const end = zonedDayStart(localDateStr(next, "UTC"), tz);
  return { start, end, dayStr };
};

/**
 * A given wall-clock time on the local day containing `date`.
 *
 * `zonedTimeOnDay(someInstant, 23, 59)` is "23:59 Lagos on the day that
 * instant falls in" — which is how the order-expiry deadline is expressed.
 * Built from the day's start rather than by string-formatting an hour, so it
 * inherits the two-pass offset resolution above.
 */
const zonedTimeOnDay = (date, hour, minute = 0, second = 0, ms = 0, tz = DEFAULT_TZ()) => {
  const { start } = dayBounds(date, tz);
  return new Date(start.getTime() + ((hour * 60 + minute) * 60 + second) * 1000 + ms);
};

/** Today's date in Lagos, "2026-09-30" — never the UTC date, which is still
 * yesterday for the first hour of every Lagos day. */
const lagosToday = () => localDateStr(new Date());

/** A calendar date shifted by whole days, as a date string. Pure calendar
 * arithmetic — no zone involved. */
const addDaysStr = (dayStr, days) => {
  const d = new Date(`${dayStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One end of a date filter, on a Lagos day.
 *
 * Filters arrive as a bare "2026-09-29" from the date pickers, or as a full
 * instant from code that already worked one out. A bare date is a Lagos day:
 * `start` is its first instant (23:00 UTC the evening before), `end` its last.
 * They used to be read as UTC midnight — `new Date("2026-09-29")` — which put
 * every order placed between midnight and 1am Lagos on the previous day and,
 * for an end date, dropped the whole day after midnight UTC.
 *
 * Anything else is taken as the instant it already is.
 */
const dayEdge = (value, edge, tz = DEFAULT_TZ()) => {
  if (value instanceof Date) return value;
  const raw = String(value);
  if (!DAY_ONLY.test(raw)) return new Date(raw);
  if (edge === "start") return zonedDayStart(raw, tz);
  return new Date(zonedDayStart(addDaysStr(raw, 1), tz).getTime() - 1);
};

module.exports = {
  localDateStr, zoneOffsetMs, zonedDayStart, dayBounds, zonedTimeOnDay, DEFAULT_TZ,
  lagosToday, addDaysStr, dayEdge,
};
