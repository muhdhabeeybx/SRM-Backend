require("dotenv").config();

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  expiryDeadline,
  hasLapsed,
  sweepCutoff,
  expiryTimeOfDay,
  orderExpiryDisabled,
} = require("../config/orderExpiry");
const { zonedTimeOnDay, dayBounds } = require("../lib/zonedDay");

/**
 * The end-of-day expiry rule, tested without a database.
 *
 * These are the cases that decide whether a customer's order is alive, so they
 * are pinned to explicit instants rather than "now" — a rule about midnight
 * cannot be tested relative to whenever the suite happens to run.
 *
 * Lagos is UTC+1 year-round, so 23:59 WAT is 22:59Z the same date. Every
 * expectation below is written in UTC to keep the offset visible.
 */
describe("order expiry — the deadline is the end of the day, not a rolling window", () => {
  const saved = {};
  beforeEach(() => {
    for (const k of ["ORDER_EXPIRY_AT", "ORDER_EXPIRY_TZ", "ORDER_EXPIRY_DISABLED"]) saved[k] = process.env[k];
    delete process.env.ORDER_EXPIRY_AT;
    delete process.env.ORDER_EXPIRY_TZ;
    delete process.env.ORDER_EXPIRY_DISABLED;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("every order placed on the same Lagos day shares one deadline", () => {
    const morning = new Date("2026-09-22T07:00:00Z"); // 08:00 WAT
    const evening = new Date("2026-09-22T21:00:00Z"); // 22:00 WAT
    const expected = "2026-09-22T22:59:00.000Z"; // 23:59 WAT

    assert.equal(expiryDeadline(morning).toISOString(), expected);
    assert.equal(expiryDeadline(evening).toISOString(), expected);
  });

  test("an order placed at 23:50 lapses nine minutes later — no grace, no rollover", () => {
    const late = new Date("2026-09-22T22:50:00Z"); // 23:50 WAT

    assert.equal(expiryDeadline(late).toISOString(), "2026-09-22T22:59:00.000Z");
    assert.equal(hasLapsed(late, Date.parse("2026-09-22T22:58:59Z")), false, "alive at 23:58:59");
    assert.equal(hasLapsed(late, Date.parse("2026-09-22T22:59:00Z")), true, "lapsed at 23:59:00");
  });

  test("the Lagos day boundary is what counts, not the UTC one", () => {
    // 23:30 UTC on the 22nd is already 00:30 WAT on the 23rd, so this order
    // belongs to the 23rd and must live until the 23rd's 23:59.
    const afterLagosMidnight = new Date("2026-09-22T23:30:00Z");

    assert.equal(expiryDeadline(afterLagosMidnight).toISOString(), "2026-09-23T22:59:00.000Z");
    assert.equal(
      hasLapsed(afterLagosMidnight, Date.parse("2026-09-23T00:00:00Z")),
      false,
      "a UTC-midnight rollover must not lapse it"
    );
  });

  test("the deadline holds across a month end", () => {
    assert.equal(
      expiryDeadline(new Date("2026-09-30T10:00:00Z")).toISOString(),
      "2026-09-30T22:59:00.000Z"
    );
  });

  describe("the sweep cutoff", () => {
    test("before the deadline it spares today and takes every earlier day", () => {
      const midday = new Date("2026-09-22T11:00:00Z"); // 12:00 WAT
      const cutoff = sweepCutoff(midday);

      // The last instant of the 21st in Lagos — 22:59:59.999Z, because the
      // Lagos day 2026-09-22 opens at 2026-09-21T23:00:00Z.
      assert.equal(cutoff.toISOString(), "2026-09-21T22:59:59.999Z");

      const todayStart = dayBounds(midday).start;
      assert.equal(
        cutoff.getTime() < todayStart.getTime(),
        true,
        "an order placed at 00:00:00.000 Lagos today is NOT swept"
      );
    });

    test("at the deadline it takes today's orders too", () => {
      const atDeadline = new Date("2026-09-22T22:59:00Z");
      assert.equal(sweepCutoff(atDeadline).getTime(), atDeadline.getTime());
    });

    test("between the deadline and midnight it still takes today's orders", () => {
      const lateNight = new Date("2026-09-22T22:59:30Z"); // 23:59:30 WAT
      assert.equal(sweepCutoff(lateNight).getTime(), lateNight.getTime());
    });

    test("a sweep that never ran still catches the backlog the next day", () => {
      // Placed on the 20th, nothing swept that night, run at midday on the 22nd.
      const stale = new Date("2026-09-20T09:00:00Z");
      const cutoff = sweepCutoff(new Date("2026-09-22T11:00:00Z"));
      assert.equal(stale.getTime() <= cutoff.getTime(), true, "yesterday's stragglers are still caught");
    });
  });

  describe("the minute after the gate closes", () => {
    // 23:59:00–23:59:59 is the one window where "the end of the day it was
    // placed on" has already gone. Taken literally it would kill the order at
    // birth, so it rolls to the next night — and the sweep has to keep agreeing
    // with that, which is where this first went wrong.
    const bornLate = new Date("2026-09-22T22:59:30Z"); // 23:59:30 WAT

    test("an order placed after the deadline takes the NEXT night's", () => {
      assert.equal(expiryDeadline(bornLate).toISOString(), "2026-09-23T22:59:00.000Z");
    });

    test("it is not born expired", () => {
      assert.equal(hasLapsed(bornLate, bornLate.getTime()), false);
      assert.equal(hasLapsed(bornLate, Date.parse("2026-09-23T10:00:00Z")), false, "alive all next day");
      assert.equal(hasLapsed(bornLate, Date.parse("2026-09-23T22:59:00Z")), true, "dies the next night");
    });

    test("the rollover does not drag the sweep's cutoff forward a day", () => {
      // sweepCutoff asks "when does TODAY's gate close", not "when would an
      // order created now die" — those differ by 24h inside this minute, and
      // conflating them stopped the 23:59 sweep taking any of today's orders.
      const atDeadline = new Date("2026-09-22T22:59:00Z");
      assert.equal(sweepCutoff(atDeadline).getTime(), atDeadline.getTime());
      assert.equal(sweepCutoff(bornLate).getTime(), bornLate.getTime());
    });

    test("and the morning sweep does not take it by mistake", () => {
      // It sits inside the next morning's coarse cutoff (created before that
      // day began), so only the exact hasLapsed check keeps it alive. This is
      // why the sweep filters rows as well as bounding the query.
      const nextMorning = new Date("2026-09-23T09:00:00Z");
      assert.equal(
        bornLate.getTime() <= sweepCutoff(nextMorning).getTime(),
        true,
        "inside the query's range"
      );
      assert.equal(hasLapsed(bornLate, nextMorning.getTime()), false, "but not actually due");
    });
  });

  describe("configuration", () => {
    test("ORDER_EXPIRY_AT moves the deadline", () => {
      process.env.ORDER_EXPIRY_AT = "18:30";
      assert.deepEqual(expiryTimeOfDay(), [18, 30]);
      assert.equal(
        expiryDeadline(new Date("2026-09-22T07:00:00Z")).toISOString(),
        "2026-09-22T17:30:00.000Z" // 18:30 WAT
      );
    });

    test("a malformed or out-of-range ORDER_EXPIRY_AT falls back to 23:59", () => {
      for (const bad of ["not-a-time", "25:00", "12:99", "", "7"]) {
        process.env.ORDER_EXPIRY_AT = bad;
        assert.deepEqual(expiryTimeOfDay(), [23, 59], `"${bad}" should fall back`);
      }
    });

    test("a zone that observes DST lands on 23:59 local on both sides of the change", () => {
      process.env.ORDER_EXPIRY_TZ = "Europe/London";
      // BST (UTC+1) in July, GMT (UTC+0) in December — 23:59 local either way.
      assert.equal(expiryDeadline(new Date("2026-07-15T12:00:00Z")).toISOString(), "2026-07-15T22:59:00.000Z");
      assert.equal(expiryDeadline(new Date("2026-12-15T12:00:00Z")).toISOString(), "2026-12-15T23:59:00.000Z");
    });

    test("ORDER_EXPIRY_DISABLED is read live, not captured at import", () => {
      assert.equal(orderExpiryDisabled(), false);
      process.env.ORDER_EXPIRY_DISABLED = "true";
      assert.equal(orderExpiryDisabled(), true);
    });

    test("an unparseable anchor yields no deadline rather than an Invalid Date", () => {
      assert.equal(expiryDeadline("not a date"), null);
      assert.equal(hasLapsed("not a date"), false, "a bad anchor must never lapse an order");
    });
  });

  test("zonedTimeOnDay underpins the deadline and agrees with it", () => {
    const at = new Date("2026-09-22T07:00:00Z");
    assert.equal(zonedTimeOnDay(at, 23, 59).getTime(), expiryDeadline(at).getTime());
  });
});
