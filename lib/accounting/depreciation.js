/**
 * Wear and tear on a fixed asset — the owner's choice of 15 Oct 2026: what it
 * cost, less what it should fetch at the end, spread evenly over the months
 * of its life.
 *
 *   starts    the month after it was bought
 *   each      (cost − residual) ÷ life, to the kobo; the last month takes
 *             what rounding left, so the months add up exactly
 *   stops     at the end of its life, or before the month it was sold or
 *             written off
 *   never     with no life (land)
 *
 * Only months that have ended are worn: a month's wear is booked on its last
 * day. Pure arithmetic on the asset's own fields — the posting engine
 * (postingSources/assets.js), the register and the report all read it, so
 * they cannot disagree.
 */

/** The lives the form suggests, in months, by kind. Land: none. */
const SUGGESTED_LIFE = {
  truck: 60,
  vehicle: 60,
  generator: 60,
  equipment: 60,
  furniture: 60,
  computer: 36,
  tank: 240,
  building: 300,
  land: null,
  other: 60,
};

const kobo = (v) => Math.round((Number(v) || 0) * 100);
const monthOf = (day) => String(day).slice(0, 7);
const nextMonth = (m) => {
  let [y, mo] = m.split("-").map(Number);
  mo += 1;
  if (mo > 12) { mo = 1; y += 1; }
  return `${y}-${String(mo).padStart(2, "0")}`;
};
const lastDayOf = (m) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
};

/**
 * Every month's wear up to a day: [{ month: 'YYYY-MM', day: its last day, amount }].
 *
 * @param {{ boughtOn: string, cost: number, residual?: number, lifeMonths?: number|null, disposedOn?: string|null }} a
 * @param {string} until  a Lagos day; months ending after it are not worn yet
 */
function wearSchedule(a, until) {
  const life = Number(a.lifeMonths) || 0;
  const spread = kobo(a.cost) - kobo(a.residual || 0);
  if (!a.boughtOn || life <= 0 || spread <= 0) return [];
  const each = Math.floor(spread / life);
  const stopBefore = a.disposedOn ? monthOf(a.disposedOn) : null;
  const out = [];
  let m = nextMonth(monthOf(a.boughtOn));
  for (let i = 0; i < life; i += 1, m = nextMonth(m)) {
    if (stopBefore && m >= stopBefore) break;
    const day = lastDayOf(m);
    if (day > until) break;
    const amount = i === life - 1 ? spread - each * (life - 1) : each;
    out.push({ month: m, day, amount: amount / 100 });
  }
  return out;
}

/** Wear to the end of a day, in naira. */
const wearTo = (a, day) => Math.round(wearSchedule(a, day).reduce((t, w) => t + kobo(w.amount), 0)) / 100;

/** What it stands at in the books at the end of a day: cost less wear. */
const valueOn = (a, day) => (kobo(a.cost) - kobo(wearTo(a, day))) / 100;

module.exports = { SUGGESTED_LIFE, wearSchedule, wearTo, valueOn, lastDayOf, monthOf };
