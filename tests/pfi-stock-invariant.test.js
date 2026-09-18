const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  DEAD_ORDER_STATUSES,
  holdsStock,
  expectedReservation,
  classifyDrift,
} = require("../lib/pfiStockInvariant");

/**
 * What `pfis.sold_qty_litres` is supposed to equal.
 *
 * Pure rules — no database. These pin the two things that were actually wrong
 * in production: that payment state has nothing to do with the reservation,
 * and that the two directions of drift are different problems.
 */

const order = (quantity, status = "Pending", paymentStatus = "Unpaid") => ({
  quantity,
  status,
  paymentStatus,
});

describe("which orders hold stock", () => {
  test("cancelled and expired orders have given their litres back", () => {
    assert.deepEqual(DEAD_ORDER_STATUSES, ["Cancelled", "Expired"]);
    assert.equal(holdsStock(order(1000, "Cancelled")), false);
    assert.equal(holdsStock(order(1000, "Expired")), false);
  });

  test("every other status holds, whatever the payment state", () => {
    // This is the rule the Create Order page depends on: an unpaid order still
    // takes its litres off the shelf, or the same product is sold twice while
    // somebody is paying for it.
    for (const status of ["Pending", "Paid", "Loading", "Released", "Completed"]) {
      assert.equal(holdsStock(order(1000, status)), true, `${status} must hold its litres`);
    }
    assert.equal(holdsStock(order(1000, "Pending", "Unpaid")), true);
    assert.equal(holdsStock(order(1000, "Completed", "Part Paid")), true);
  });

  test("a missing order holds nothing rather than throwing", () => {
    assert.equal(holdsStock(null), false);
    assert.equal(holdsStock(undefined), false);
  });
});

describe("the expected reservation", () => {
  test("sums the live orders and ignores the dead ones", () => {
    const orders = [
      order(11_000, "Pending", "Unpaid"),
      order(50_000, "Completed", "Part Paid"),
      order(45_000, "Completed", "Unpaid"),
      order(100_000, "Completed", "Paid"),
      order(999_999, "Cancelled", "Unpaid"),
      order(888_888, "Expired", "Unpaid"),
    ];
    assert.equal(expectedReservation(orders), 206_000);
  });

  test("payment state never changes the answer", () => {
    // The same three orders, paid and unpaid, must reserve the same litres.
    const qty = [11_000, 50_000, 45_000];
    const unpaid = qty.map((q) => order(q, "Pending", "Unpaid"));
    const paid = qty.map((q) => order(q, "Completed", "Paid"));
    assert.equal(expectedReservation(unpaid), expectedReservation(paid));
  });

  test("a batch with no orders reserves nothing", () => {
    assert.equal(expectedReservation([]), 0);
    assert.equal(expectedReservation(null), 0);
    assert.equal(expectedReservation(undefined), 0);
  });

  test("quantities arriving as strings still add up", () => {
    // bigint columns come back from the driver as strings.
    assert.equal(expectedReservation([order("11000"), order("50000")]), 61_000);
  });
});

describe("classifying the drift", () => {
  test("a counter that agrees is ok and needs no repair", () => {
    const c = classifyDrift({ counter: 22_640_950, expected: 22_640_950, tank: 23_213_083 });
    assert.equal(c.direction, "ok");
    assert.equal(c.drift, 0);
    assert.equal(c.offeredNow, c.offeredAfter);
  });

  test("under-reserved: the batch is offering litres already on an order", () => {
    // PFI 42 as found in production.
    const c = classifyDrift({ counter: 22_701_988, expected: 25_491_154, tank: 26_654_468 });
    assert.equal(c.direction, "under_reserved");
    assert.equal(c.drift, -2_789_166);
    // Repairing takes stock OFF the shelf — it can only prevent an oversale.
    assert.ok(c.offeredAfter < c.offeredNow);
    assert.equal(c.offeredNow - c.offeredAfter, 2_789_166);
  });

  test("over-reserved: the batch is holding litres nobody can buy", () => {
    // PFI 45 as found in production — the Calabar batch behind the report.
    const c = classifyDrift({ counter: 22_910_950, expected: 22_640_950, tank: 23_213_083 });
    assert.equal(c.direction, "over_reserved");
    assert.equal(c.drift, 270_000);
    // Repairing puts stock BACK on sale, which is why it is opt-in.
    assert.ok(c.offeredAfter > c.offeredNow);
    assert.equal(c.offeredNow, 302_133);
    assert.equal(c.offeredAfter, 572_133);
  });

  test("an oversold batch offers nothing, never a negative", () => {
    // PFI 43: live orders exceed the tank by 3,649 L. "Minus 3,649 available"
    // is not something anyone can sell, and the depot figure clamps the same
    // way, so the classification has to agree with it.
    const c = classifyDrift({ counter: 19_615_193, expected: 20_678_193, tank: 20_674_544 });
    assert.equal(c.direction, "under_reserved");
    assert.equal(c.offeredAfter, 0);
    assert.ok(c.offeredNow > 0, "before repair it was still offering stock");
  });

  test("bigint strings from the driver classify the same as numbers", () => {
    const asText = classifyDrift({ counter: "22910950", expected: "22640950", tank: "23213083" });
    const asNum = classifyDrift({ counter: 22_910_950, expected: 22_640_950, tank: 23_213_083 });
    assert.deepEqual(asText, asNum);
  });
});
