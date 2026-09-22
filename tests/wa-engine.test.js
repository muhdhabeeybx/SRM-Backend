/**
 * Table-driven coverage of the conversation engine: every state × every
 * inbound kind, the global commands from everywhere, and each of the §7 edge
 * paths. Pure — no DB, no HTTP, no Meta. Assertions are structural (state,
 * reply kinds, button/row ids, effects); exact wording is pinned separately
 * by the copy snapshot test.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert");

const { reduce, parseLitres, nextStep, trucksComplete, minTrucksFor, maxTrucksFor } = require("../whatsapp/engine");
const { STATES, INBOUND, REPLY, EFFECTS, LIMITS, TEMPLATES } = require("../whatsapp/constants");
const { MAX_EXPECTED_PAYMENTS: LIMITS_MAX_EXPECTED } = require("../whatsapp/constants");

// ------------------------------------------------------------------ fixtures

const WARRI = {
  id: 1,
  name: "Warri",
  state: "Delta",
  products: [
    { id: 10, name: "PMS", price: 850, stock: 120000 },
    { id: 11, name: "AGO", price: 1020, stock: 80000 },
  ],
};
const LAGOS = {
  id: 2,
  name: "Lagos",
  state: "Delta", // same state as Warri: the base context is single-state,
  // so depot browsing goes straight to depots (state grouping has its own suite)
  products: [{ id: 10, name: "PMS", price: 870, stock: 50000 }],
};

const LAST_ORDER = {
  id: 99,
  orderNumber: "SOR-99",
  status: "Completed",
  depotId: 1,
  productId: 10,
  quantity: 30000,
  deliveryType: "pickup",
  productName: "PMS",
  depotName: "Warri",
  totalAmount: 25500000,
};

const baseCtx = (over = {}) => ({
  customer: { id: 7, name: "Ada Obi", status: "Active" },
  depots: [WARRI, LAGOS],
  supportPhone: "+2340000000000",
  portalUrl: "https://portal.example",
  withinServiceWindow: true,
  ...over,
});

const manyDepots = () =>
  Array.from({ length: 11 }, (_, i) => ({
    id: i + 1,
    name: `Depot ${i + 1}`,
    state: "Delta",
    products: [{ id: 10, name: "PMS", price: 850, stock: 100000 }],
  }));

const mkSession = (state, cart = {}, extra = {}) => ({
  waPhone: "+2348030000000",
  customerId: 7,
  state,
  cart,
  failureCount: 0,
  ...extra,
});

const txt = (value) => ({ type: INBOUND.TEXT, value });
const btn = (value) => ({ type: INBOUND.BUTTON, value });
const lst = (value) => ({ type: INBOUND.LIST, value });

const kinds = (r) => r.replies.map((x) => x.kind);
const effectTypes = (r) => r.effects.map((e) => e.type);
const rowIds = (reply) => reply.sections.flatMap((s) => s.rows.map((r) => r.id));
const buttonIds = (reply) => reply.buttons.map((b) => b.id);

// A complete pickup cart one tap away from CREATE_ORDER.
const fullPickupCart = () => ({
  depotId: 1,
  productId: 10,
  quantity: 30000,
  companyName: "Acme Fuels Ltd",
  deliveryType: "pickup",
  trucks: [{ quantity: 30000, plate: "ABC-123-XY" }],
});

// ---------------------------------------------------------------- pure helpers

describe("pure helpers", () => {
  it("parseLitres accepts the ways people type litres", () => {
    assert.equal(parseLitres("30000"), 30000);
    assert.equal(parseLitres("30,000"), 30000);
    assert.equal(parseLitres("30 000"), 30000);
    assert.equal(parseLitres("30000L"), 30000);
    assert.equal(parseLitres("30000 litres"), 30000);
    assert.equal(parseLitres("30k"), 30000);
    assert.equal(parseLitres("30.5k"), 30500);
    assert.ok(Number.isNaN(parseLitres("plenty")));
    assert.ok(Number.isNaN(parseLitres("")));
  });

  it("truck arithmetic: implicit single, declared multi, sane bounds", () => {
    assert.equal(trucksComplete({ quantity: 30000, trucks: [{ quantity: 30000, plate: "A1 X" }] }), true);
    assert.equal(trucksComplete({ quantity: 30000 }), false);
    assert.equal(trucksComplete({ quantity: 150000, truckCount: 3, trucks: [{}, {}] }), false);
    assert.equal(trucksComplete({ quantity: 150000, truckCount: 3, trucks: [{}, {}, {}] }), true);
    assert.equal(trucksComplete({ quantity: 150000 }), false); // count undeclared
    assert.equal(minTrucksFor(60000), 1);
    assert.equal(minTrucksFor(60001), 2);
    assert.equal(minTrucksFor(150000), 3);
    assert.equal(maxTrucksFor(150000), 10);
  });

  it("nextStep walks the first unanswered question", () => {
    assert.equal(nextStep({}), STATES.DEPOT);
    assert.equal(nextStep({ depotId: 1 }), STATES.PRODUCT);
    assert.equal(nextStep({ depotId: 1, productId: 10 }), STATES.QUANTITY);
    assert.equal(nextStep({ depotId: 1, productId: 10, quantity: 30000 }), STATES.COMPANY);
    assert.equal(
      nextStep({ depotId: 1, productId: 10, quantity: 30000, companyName: "Acme" }),
      STATES.COLLECT
    );
    assert.equal(
      nextStep({ depotId: 1, productId: 10, quantity: 30000, companyName: "Acme", deliveryType: "pickup" }),
      STATES.LOGISTICS
    );
    assert.equal(
      nextStep({ depotId: 1, productId: 10, quantity: 30000, companyName: "Acme", deliveryType: "pickup", trucksDeferred: true }),
      STATES.CONFIRM
    );
    assert.equal(nextStep(fullPickupCart()), STATES.CONFIRM);
    assert.equal(
      nextStep({ depotId: 1, productId: 10, quantity: 150000, companyName: "Acme", deliveryType: "pickup", truckCount: 3, trucks: [{ quantity: 60000, plate: "A1 X" }] }),
      STATES.LOGISTICS // three trucks declared; only one supplied so far
    );
  });
});

// ------------------------------------------------------------------- identify

describe("IDENTIFY", () => {
  it("unknown wa_id is asked for a name whatever state it claims", () => {
    const r = reduce(mkSession(STATES.QUANTITY, { depotId: 1 }), txt("30000"), baseCtx({ customer: null }));
    assert.equal(r.session.state, STATES.IDENTIFY);
    assert.deepEqual(kinds(r), [REPLY.TEXT]);
  });

  it("a plausible name emits CREATE_CUSTOMER and waits", () => {
    const r = reduce(mkSession(STATES.IDENTIFY), txt("Ada Obi"), baseCtx({ customer: null }));
    assert.deepEqual(effectTypes(r), [EFFECTS.CREATE_CUSTOMER]);
    assert.equal(r.effects[0].payload.name, "Ada Obi");
    assert.equal(r.session.cart.pendingCustomer, true);
  });

  it("digits are not a name", () => {
    const r = reduce(mkSession(STATES.IDENTIFY), txt("08030000000"), baseCtx({ customer: null }));
    assert.equal(r.session.state, STATES.IDENTIFY);
    assert.equal(r.session.failureCount, 1);
    assert.deepEqual(r.effects, []);
  });

  it("a second message while creation is pending does not re-emit the effect", () => {
    const r = reduce(
      mkSession(STATES.IDENTIFY, { pendingCustomer: true }),
      txt("Ada Obi"),
      baseCtx({ customer: null })
    );
    assert.deepEqual(r.effects, []);
    assert.deepEqual(kinds(r), [REPLY.TEXT]);
  });

  it("a greeting during IDENTIFY re-asks the name — never the dead-end menu", () => {
    for (const word of ["hi", "hello", "menu", "start"]) {
      const r = reduce(mkSession(STATES.IDENTIFY), txt(word), baseCtx({ customer: null }));
      assert.equal(r.session.state, STATES.IDENTIFY, `"${word}" must not escape IDENTIFY`);
      assert.deepEqual(kinds(r), [REPLY.TEXT]);
      assert.match(r.replies[0].body, /name/i);
    }
  });

  it("'cancel' during IDENTIFY also stays — there is nothing to cancel yet", () => {
    const r = reduce(mkSession(STATES.IDENTIFY), txt("cancel"), baseCtx({ customer: null }));
    assert.equal(r.session.state, STATES.IDENTIFY);
    assert.match(r.replies[0].body, /name/i);
  });

  it("the old boomerang is gone: greeting → tap → no second welcome loop", () => {
    // Before the fix: "hi" bounced to MENU, and the next tap snapped back to
    // IDENTIFY with the full welcome — reading as chronic amnesia.
    const greeted = reduce(mkSession(STATES.IDENTIFY), txt("hi"), baseCtx({ customer: null }));
    assert.equal(greeted.session.state, STATES.IDENTIFY);
    const named = reduce(greeted.session, txt("Ada Obi"), baseCtx({ customer: null }));
    assert.deepEqual(effectTypes(named), [EFFECTS.CREATE_CUSTOMER], "the flow continues normally");
  });

  it("CUSTOMER_CREATED lands on a personalised MENU", () => {
    const r = reduce(
      mkSession(STATES.IDENTIFY, { pendingCustomer: true }),
      { type: INBOUND.CUSTOMER_CREATED, customer: { id: 41, name: "Ada Obi" } },
      baseCtx({ customer: null })
    );
    assert.equal(r.session.state, STATES.MENU);
    assert.equal(r.session.customerId, 41);
    // Single list: welcome is the body — no separate text then "Hello" menu.
    assert.deepEqual(kinds(r), [REPLY.LIST]);
    assert.match(r.replies[0].body, /account has been set up/i);
    assert.ok(!/Hello Ada Obi/i.test(r.replies[0].body));
  });
});

// ----------------------------------------------------------------------- menu

describe("MENU", () => {
  it("no order history: a short list — track has nothing to show yet", () => {
    const r = reduce(mkSession(STATES.MENU), txt("hello"), baseCtx());
    assert.deepEqual(kinds(r), [REPLY.LIST]);
    assert.deepEqual(rowIds(r.replies[0]), ["order", "prices"]);
  });

  it("with order history: a list including Reorder and Track", () => {
    const r = reduce(mkSession(STATES.MENU), txt("menu"), baseCtx({ lastOrder: LAST_ORDER }));
    assert.deepEqual(kinds(r), [REPLY.LIST]);
    assert.deepEqual(rowIds(r.replies[0]), ["order", "reorder", "prices", "track"]);
  });

  it("configured link URLs append their rows — unset ones stay hidden", () => {
    const ctx = baseCtx({
      lastOrder: LAST_ORDER,
      websiteUrl: "https://soroman.example",
      supportWaUrl: "https://wa.me/2340000000000",
      // communityUrl and appDownloadUrl deliberately unset
    });
    const r = reduce(mkSession(STATES.MENU), txt("menu"), ctx);
    assert.deepEqual(rowIds(r.replies[0]), ["order", "reorder", "prices", "track", "website", "support"]);
  });

  it("all four links + full history still fit WhatsApp's 10-row cap", () => {
    const ctx = baseCtx({
      lastOrder: LAST_ORDER,
      websiteUrl: "https://soroman.example",
      communityUrl: "https://chat.whatsapp.com/abc",
      supportWaUrl: "https://wa.me/2340000000000",
      appDownloadUrl: "https://api.soroman.example/app",
    });
    const r = reduce(mkSession(STATES.MENU), txt("menu"), ctx);
    const ids = rowIds(r.replies[0]);
    assert.equal(ids.length, 8);
    assert.ok(ids.length <= LIMITS.MAX_LIST_ROWS);
  });

  it("tapping a link row answers with a cta_url and stays at MENU", () => {
    const ctx = baseCtx({ websiteUrl: "https://soroman.example" });
    const r = reduce(mkSession(STATES.MENU), lst("website"), ctx);
    assert.equal(r.session.state, STATES.MENU);
    assert.equal(r.session.failureCount, 0, "a link tap is not a fumble");
    assert.deepEqual(kinds(r), [REPLY.CTA]);
    assert.equal(r.replies[0].url, "https://soroman.example");
    assert.ok(r.replies[0].buttonText.length <= LIMITS.MAX_BUTTON_TITLE);
  });

  it("a link id whose URL is not configured falls through to the menu", () => {
    const r = reduce(mkSession(STATES.MENU), lst("community"), baseCtx());
    assert.equal(r.session.failureCount, 1);
    assert.deepEqual(kinds(r), [REPLY.LIST]);
  });

  it("'order' starts a fresh cart at DEPOT", () => {
    const r = reduce(mkSession(STATES.MENU, { stale: true }), btn("order"), baseCtx());
    assert.equal(r.session.state, STATES.DEPOT);
    assert.equal(r.session.cart.stale, undefined);
    assert.deepEqual(kinds(r), [REPLY.LIST]);
  });

  it("'order' with nothing in stock anywhere says so at MENU", () => {
    const r = reduce(mkSession(STATES.MENU), btn("order"), baseCtx({ depots: [] }));
    assert.equal(r.session.state, STATES.MENU);
    assert.deepEqual(kinds(r), [REPLY.TEXT]);
  });

  it("'prices' answers and stays put", () => {
    const r = reduce(mkSession(STATES.MENU), btn("prices"), baseCtx());
    assert.equal(r.session.state, STATES.MENU);
    assert.deepEqual(kinds(r), [REPLY.TEXT]);
    assert.ok(r.replies[0].body.includes("Warri"));
    assert.ok(!r.replies[0].body.includes("📍"), "single state: no geography headers");
  });

  it("'prices' groups by state when there is more than one", () => {
    const IKEJA = { id: 3, name: "Ikeja", state: "Lagos", products: [{ id: 10, name: "PMS", price: 870, stock: 1000 }] };
    const r = reduce(mkSession(STATES.MENU), btn("prices"), baseCtx({ depots: [WARRI, LAGOS, IKEJA] }));
    const body = r.replies[0].body;
    assert.ok(body.includes("*Delta*"));
    assert.ok(body.includes("*Lagos*"));
    assert.ok(body.indexOf("Warri") > body.indexOf("*Delta*"), "depots sit under their state");
    assert.ok(body.indexOf("Ikeja") > body.indexOf("*Lagos*"));
  });

  it("an UNPAID last order offers Finish payment, never Reorder", () => {
    const pending = { ...LAST_ORDER, status: "Pending" };
    const r = reduce(mkSession(STATES.MENU), txt("menu"), baseCtx({ lastOrder: pending }));
    const ids = rowIds(r.replies[0]);
    assert.ok(ids.includes("paylast"));
    assert.ok(!ids.includes("reorder"), "an open tab is not reorder material");
  });

  it("Finish payment re-opens AWAIT_PAYMENT with the order's details", () => {
    const pending = { ...LAST_ORDER, status: "Pending", virtualAccountBank: "Wema Bank", virtualAccountNumber: "9930001111" };
    const r = reduce(mkSession(STATES.MENU), lst("paylast"), baseCtx({ lastOrder: pending }));
    assert.equal(r.session.state, STATES.AWAIT_PAYMENT);
    assert.equal(r.session.cart.awaiting.orderNumber, "SOR-99");
    assert.ok(r.replies[0].body.includes("9930001111"));
    assert.ok(buttonIds(r.replies[0]).includes("cancelorder"));
  });

  it("'reorder' prefills the cart and jumps to what's missing (company, then plates)", () => {
    // Depot, product, quantity and delivery type carry over from the last order;
    // the company is per-order, so reorder still asks for it before anything else.
    const r = reduce(mkSession(STATES.MENU), lst("reorder"), baseCtx({ lastOrder: LAST_ORDER }));
    assert.equal(r.session.state, STATES.COMPANY);
    assert.equal(r.session.cart.quantity, 30000);
    assert.equal(r.session.cart.deliveryType, "pickup");
  });

  it("'reorder' no longer checks stock — it carries the cart forward", () => {
    // Was: fell back to DEPOT "unavailable" whenever the last order exceeded
    // stock, which on a depot with no active PFI (stock 0) meant always, and
    // said the depot was unavailable when the depot was fine.
    const last = { ...LAST_ORDER, quantity: 999999 };
    const r = reduce(mkSession(STATES.MENU), lst("reorder"), baseCtx({ lastOrder: last }));
    assert.notEqual(r.session.state, STATES.DEPOT);
    assert.equal(r.session.cart.quantity, 999999);
  });

  it("'reorder' still falls back to DEPOT when the depot itself is gone", () => {
    const last = { ...LAST_ORDER, depotId: 4242 };
    const r = reduce(mkSession(STATES.MENU), lst("reorder"), baseCtx({ lastOrder: last }));
    assert.equal(r.session.state, STATES.DEPOT);
  });

  it("garbage re-shows the menu and counts a failure", () => {
    const r = reduce(mkSession(STATES.MENU), txt("qwerty"), baseCtx());
    assert.equal(r.session.failureCount, 1);
    assert.deepEqual(kinds(r), [REPLY.LIST]);
  });
});

// ----------------------------------------------------------- global commands

describe("global commands beat state", () => {
  const cart = { depotId: 1, productId: 10 };

  it("'menu' from mid-order returns to MENU (the deliberate reset always wins)", () => {
    const r = reduce(mkSession(STATES.QUANTITY, cart), txt("menu"), baseCtx());
    assert.equal(r.session.state, STATES.MENU);
  });

  it("a bare 'hi' mid-order does NOT discard the cart — it re-shows the step", () => {
    // A stray or post-outage-redelivered greeting must not blow away a
    // half-built order. It's absorbed: same state, cart intact, prompt re-shown.
    const r = reduce(mkSession(STATES.CONFIRM, fullPickupCart()), txt("HI"), baseCtx());
    assert.equal(r.session.state, STATES.CONFIRM);
    assert.deepEqual(r.session.cart, fullPickupCart());
    assert.deepEqual(kinds(r), [REPLY.BUTTONS]); // the confirm summary again
  });

  it("'hi' with an empty cart still opens the menu", () => {
    const r = reduce(mkSession(STATES.MENU, {}), txt("hi"), baseCtx());
    assert.equal(r.session.state, STATES.MENU);
    assert.deepEqual(kinds(r), [REPLY.LIST]);
  });

  it("'cancel' still discards an in-progress order from any step", () => {
    const r = reduce(mkSession(STATES.CONFIRM, fullPickupCart()), txt("cancel"), baseCtx());
    assert.equal(r.session.state, STATES.MENU);
    assert.deepEqual(r.session.cart, {});
  });

  it("'cancel' discards the cart and says so", () => {
    const r = reduce(mkSession(STATES.LOGISTICS, cart), txt("cancel"), baseCtx());
    assert.equal(r.session.state, STATES.MENU);
    assert.deepEqual(r.session.cart, {});
    assert.equal(r.replies.length, 2); // the goodbye + the menu
  });

  it("'help' answers without touching the state", () => {
    const r = reduce(mkSession(STATES.DEPOT, {}), txt("help"), baseCtx());
    assert.equal(r.session.state, STATES.DEPOT);
    assert.deepEqual(kinds(r), [REPLY.TEXT]);
  });

  it("'track' with no orders says so", () => {
    const r = reduce(mkSession(STATES.MENU), txt("track"), baseCtx());
    assert.deepEqual(kinds(r), [REPLY.TEXT]);
  });

  it("an Inactive customer is refused politely, wherever they are", () => {
    const ctx = baseCtx({ customer: { id: 7, name: "Ada", status: "Inactive" } });
    const r = reduce(mkSession(STATES.QUANTITY, cart), txt("30000"), ctx);
    assert.equal(r.session.state, STATES.QUANTITY); // nothing advances
    assert.deepEqual(kinds(r), [REPLY.TEXT]);
    assert.deepEqual(r.effects, []);
  });

  it("a voice note gets the unsupported-media reply plus the state's question again", () => {
    const r = reduce(mkSession(STATES.COLLECT, cart), { type: INBOUND.UNSUPPORTED }, baseCtx());
    assert.equal(r.session.state, STATES.COLLECT);
    assert.equal(r.session.failureCount, 1);
    assert.equal(r.replies.length, 2);
  });

  it("the third fumble in a state offers the menu instead of repeating", () => {
    const s = mkSession(STATES.DEPOT, {}, { failureCount: 2 });
    const r = reduce(s, txt("???"), baseCtx());
    assert.deepEqual(kinds(r), [REPLY.BUTTONS]);
    assert.deepEqual(buttonIds(r.replies[0]), ["menu", "retry"]);
    assert.equal(r.session.failureCount, 0);
  });

  it("'retry' after three strikes re-asks the state's question cleanly", () => {
    const r = reduce(mkSession(STATES.DEPOT, {}), btn("retry"), baseCtx());
    assert.equal(r.session.state, STATES.DEPOT);
    assert.equal(r.session.failureCount, 0);
    assert.deepEqual(kinds(r), [REPLY.LIST]);
  });
});

// ---------------------------------------------------------------------- depot

// ------------------------------------------------------------------- track

describe("track — status in chat", () => {
  const OPEN_PENDING = {
    id: 101,
    orderNumber: "SOR-101",
    status: "Pending",
    quantity: 30000,
    totalAmount: 25500000,
    deliveryType: "pickup",
    virtualAccountBank: "Wema Bank",
    virtualAccountNumber: "9930001111",
    productName: "PMS",
    depotName: "Warri",
  };
  const OPEN_LOADING = {
    id: 102,
    orderNumber: "SOR-102",
    status: "Loading",
    quantity: 45000,
    totalAmount: 38250000,
    deliveryType: "delivery",
    productName: "AGO",
    depotName: "Lagos",
  };

  it("one open order: status answered directly as a portal CTA, state untouched", () => {
    const r = reduce(
      mkSession(STATES.QUANTITY, { depotId: 1 }),
      txt("track"),
      baseCtx({ openOrders: [OPEN_PENDING], lastOrder: LAST_ORDER })
    );
    assert.equal(r.session.state, STATES.QUANTITY);
    assert.deepEqual(kinds(r), [REPLY.CTA]);
    assert.ok(r.replies[0].body.includes("SOR-101"));
    assert.ok(r.replies[0].body.includes("Awaiting payment"));
    assert.ok(r.replies[0].body.includes("9930001111"), "Pending repeats the transfer details");
    assert.equal(r.replies[0].url, "https://portal.example");
  });

  it("multiple open orders: a picker list, one row per order", () => {
    const r = reduce(mkSession(STATES.MENU), txt("track"), baseCtx({ openOrders: [OPEN_PENDING, OPEN_LOADING] }));
    assert.deepEqual(kinds(r), [REPLY.LIST]);
    assert.deepEqual(rowIds(r.replies[0]), ["trackorder:101", "trackorder:102"]);
    const rows = r.replies[0].sections[0].rows;
    assert.equal(rows[0].title, "SOR-101");
    assert.ok(rows[1].description.includes("Loading"));
  });

  it("picking a row answers that order's status — never a fumble", () => {
    const r = reduce(
      mkSession(STATES.MENU),
      lst("trackorder:102"),
      baseCtx({ openOrders: [OPEN_PENDING, OPEN_LOADING] })
    );
    assert.equal(r.session.failureCount, 0);
    assert.deepEqual(kinds(r), [REPLY.CTA]);
    assert.ok(r.replies[0].body.includes("SOR-102"));
    assert.ok(r.replies[0].body.includes("loading for delivery"), "delivery wording for a delivery order");
  });

  it("a stale picker row (order closed since) gets an honest answer", () => {
    const r = reduce(mkSession(STATES.MENU), lst("trackorder:999"), baseCtx({ openOrders: [OPEN_PENDING] }));
    assert.deepEqual(kinds(r), [REPLY.TEXT]);
    assert.match(r.replies[0].body, /could not find/i);
  });

  it("a stale row matching the last order still answers with its final state", () => {
    const r = reduce(
      mkSession(STATES.MENU),
      lst("trackorder:99"),
      baseCtx({ openOrders: [], lastOrder: LAST_ORDER })
    );
    assert.deepEqual(kinds(r), [REPLY.CTA]);
    assert.ok(r.replies[0].body.includes("Completed"));
  });

  it("nothing open: the last order's outcome is shown", () => {
    const r = reduce(mkSession(STATES.MENU), txt("track"), baseCtx({ openOrders: [], lastOrder: LAST_ORDER }));
    assert.deepEqual(kinds(r), [REPLY.CTA]);
    assert.ok(r.replies[0].body.includes("SOR-99"));
    assert.ok(r.replies[0].body.includes("Completed"));
  });

  it("without a portal URL the status arrives as plain text", () => {
    const r = reduce(mkSession(STATES.MENU), txt("track"), baseCtx({ openOrders: [OPEN_PENDING], portalUrl: "" }));
    assert.deepEqual(kinds(r), [REPLY.TEXT]);
    assert.ok(r.replies[0].body.includes("SOR-101"));
  });
});

describe("DEPOT", () => {
  it("a list selection advances to PRODUCT", () => {
    const r = reduce(mkSession(STATES.DEPOT), lst("depot:1"), baseCtx());
    assert.equal(r.session.state, STATES.PRODUCT);
    assert.equal(r.session.cart.depotId, 1);
  });

  it("typing the depot name works too", () => {
    const r = reduce(mkSession(STATES.DEPOT), txt("warri"), baseCtx());
    assert.equal(r.session.state, STATES.PRODUCT);
  });

  it("an unknown depot is a fumble", () => {
    const r = reduce(mkSession(STATES.DEPOT), lst("depot:404"), baseCtx());
    assert.equal(r.session.state, STATES.DEPOT);
    assert.equal(r.session.failureCount, 1);
  });

  it("eleven depots page: nine rows plus More ▸", () => {
    const r = reduce(mkSession(STATES.MENU), btn("order"), baseCtx({ depots: manyDepots() }));
    const ids = rowIds(r.replies[0]);
    assert.equal(ids.length, 10);
    assert.equal(ids[9], "more");
  });

  it("More ▸ turns the page; the last page wraps around", () => {
    const ctx = baseCtx({ depots: manyDepots() });
    const page2 = reduce(mkSession(STATES.DEPOT, { page: 0 }), lst("more"), ctx);
    assert.ok(rowIds(page2.replies[0]).includes("depot:11"));
    const wrapped = reduce(page2.session, lst("more"), ctx);
    assert.ok(rowIds(wrapped.replies[0]).includes("depot:1"));
  });

  it("changing depot mid-edit clears everything priced off it", () => {
    const cart = fullPickupCart();
    const r = reduce(mkSession(STATES.DEPOT, cart), lst("depot:2"), baseCtx());
    assert.equal(r.session.cart.depotId, 2);
    assert.equal(r.session.cart.productId, undefined);
    assert.equal(r.session.cart.quantity, undefined);
    assert.equal(r.session.cart.trucks, undefined);
    assert.equal(r.session.cart.deliveryType, "pickup"); // collection survives
  });
});

// ------------------------------------------------------- state grouping

describe("state-grouped depot browsing", () => {
  const IKEJA = {
    id: 3,
    name: "Ikeja",
    state: "Lagos",
    products: [{ id: 10, name: "PMS", price: 870, stock: 50000 }],
  };
  const multiCtx = () => baseCtx({ depots: [WARRI, LAGOS, IKEJA] });

  it("more than one state: pick the state first", () => {
    const r = reduce(mkSession(STATES.MENU), btn("order"), multiCtx());
    assert.equal(r.session.state, STATES.DEPOT);
    const rows = r.replies[0].sections[0].rows;
    assert.deepEqual(rows.map((x) => x.id), ["state:Delta", "state:Lagos"]);
    assert.equal(rows[0].description, "2 depots");
    assert.equal(rows[1].description, "1 depot");
  });

  it("picking a state shows only its depots, with a way back", () => {
    const picked = reduce(mkSession(STATES.DEPOT), lst("state:Delta"), multiCtx());
    assert.equal(picked.session.cart.region, "Delta");
    const ids = rowIds(picked.replies[0]);
    assert.deepEqual(ids, ["depot:1", "depot:2", "states"]);
  });

  it("⬅ Change state returns to the state list", () => {
    const s = mkSession(STATES.DEPOT, { region: "Delta" });
    const r = reduce(s, lst("states"), multiCtx());
    assert.equal(r.session.cart.region, undefined);
    assert.ok(rowIds(r.replies[0]).every((id) => id.startsWith("state:")));
  });

  it("typing the state name works too", () => {
    const r = reduce(mkSession(STATES.DEPOT), txt("lagos"), multiCtx());
    assert.equal(r.session.cart.region, "Lagos");
    assert.deepEqual(rowIds(r.replies[0]), ["depot:3", "states"]);
  });

  it("a depot picked inside the region advances to PRODUCT", () => {
    const s = mkSession(STATES.DEPOT, { region: "Lagos" });
    const r = reduce(s, lst("depot:3"), multiCtx());
    assert.equal(r.session.state, STATES.PRODUCT);
    assert.equal(r.session.cart.depotId, 3);
  });

  it("a single state skips the grouping entirely", () => {
    const r = reduce(mkSession(STATES.MENU), btn("order"), baseCtx());
    assert.ok(rowIds(r.replies[0]).every((id) => id.startsWith("depot:")));
  });
});

// -------------------------------------------------------------------- product

describe("PRODUCT", () => {
  it("selection advances to QUANTITY — and never reveals our stock level", () => {
    const r = reduce(mkSession(STATES.PRODUCT, { depotId: 1 }), lst("product:10"), baseCtx());
    assert.equal(r.session.state, STATES.QUANTITY);
    assert.ok(r.replies[0].body.includes("PMS"));
    assert.ok(!r.replies[0].body.includes("120,000"), "stock figure is commercial information");
  });

  it("product rows show the price but not the stock", () => {
    const r = reduce(mkSession(STATES.DEPOT), lst("depot:1"), baseCtx());
    const desc = r.replies[0].sections[0].rows[0].description;
    assert.ok(desc.includes("₦850"));
    assert.ok(!desc.includes("120"), "no stock in the row description");
  });

  it("typing the product name works too", () => {
    const r = reduce(mkSession(STATES.PRODUCT, { depotId: 1 }), txt("ago"), baseCtx());
    assert.equal(r.session.state, STATES.QUANTITY);
    assert.equal(r.session.cart.productId, 11);
  });

  it("unknown product: apology plus the list again", () => {
    const r = reduce(mkSession(STATES.PRODUCT, { depotId: 1 }), txt("kerosene"), baseCtx());
    assert.equal(r.session.failureCount, 1);
    assert.deepEqual(kinds(r), [REPLY.TEXT, REPLY.LIST]);
  });

  it("depot gone from context: back to DEPOT, with a word", () => {
    const r = reduce(mkSession(STATES.PRODUCT, { depotId: 404 }), txt("pms"), baseCtx());
    assert.equal(r.session.state, STATES.DEPOT);
    assert.deepEqual(kinds(r), [REPLY.TEXT, REPLY.LIST]);
  });
});

// ------------------------------------------------------------------- quantity

describe("QUANTITY", () => {
  const cart = { depotId: 1, productId: 10 };

  it("a clean number advances to COMPANY", () => {
    const r = reduce(mkSession(STATES.QUANTITY, cart), txt("30,000"), baseCtx());
    assert.equal(r.session.state, STATES.COMPANY);
    assert.equal(r.session.cart.quantity, 30000);
  });

  it("nonsense is a fumble", () => {
    const r = reduce(mkSession(STATES.QUANTITY, cart), txt("plenty"), baseCtx());
    assert.equal(r.session.failureCount, 1);
  });

  it("below the minimum is bounced with the minimum named", () => {
    const r = reduce(mkSession(STATES.QUANTITY, cart), txt("500"), baseCtx());
    assert.equal(r.session.state, STATES.QUANTITY);
    assert.ok(r.replies[0].body.includes("1,000"));
  });

  it("an absurd figure is treated as a typo, not an order", () => {
    const r = reduce(mkSession(STATES.QUANTITY, cart), txt("300000000"), baseCtx());
    assert.equal(r.session.state, STATES.QUANTITY);
  });

  it("a quantity above stock is accepted — the cap is gone", () => {
    // Stock is no longer a bound here. It refused every quantity at a depot
    // with no active PFI, where stock reads 0, and dead-ended the customer
    // with copy that deliberately did not say why. MIN/MAX still apply, and
    // release is still gated downstream where stock is actually reserved.
    const r = reduce(mkSession(STATES.QUANTITY, cart), txt("150000"), baseCtx());
    assert.equal(r.session.state, STATES.COMPANY);
    assert.equal(r.session.cart.quantity, 150000);
  });

  it("declining via Change depot restarts at DEPOT", () => {
    const r = reduce(mkSession(STATES.QUANTITY, cart), btn("changeDepot"), baseCtx());
    assert.equal(r.session.state, STATES.DEPOT);
  });

  it("a quantity under stock still works, unchanged", () => {
    const r = reduce(mkSession(STATES.QUANTITY, cart), txt("40000"), baseCtx());
    assert.equal(r.session.state, STATES.COMPANY);
    assert.equal(r.session.cart.quantity, 40000);
  });
});

// -------------------------------------------------------------------- company

describe("COMPANY", () => {
  const cart = { depotId: 1, productId: 10, quantity: 30000 };

  it("a valid company name advances to COLLECT", () => {
    const r = reduce(mkSession(STATES.COMPANY, cart), txt("  Acme Fuels Ltd "), baseCtx());
    assert.equal(r.session.state, STATES.COLLECT);
    assert.equal(r.session.cart.companyName, "Acme Fuels Ltd", "trimmed and stored");
  });

  it("a company name with digits and punctuation is accepted", () => {
    const r = reduce(mkSession(STATES.COMPANY, cart), txt("7-Eleven Nigeria"), baseCtx());
    assert.equal(r.session.state, STATES.COLLECT);
  });

  it("an empty or too-short company name is bounced, staying in COMPANY", () => {
    const r = reduce(mkSession(STATES.COMPANY, cart), txt("  "), baseCtx());
    assert.equal(r.session.state, STATES.COMPANY);
    assert.equal(r.session.failureCount, 1);
    assert.deepEqual(kinds(r), [REPLY.TEXT]);
  });

  it("a menu selection (non-text) in COMPANY is not a valid name", () => {
    const r = reduce(mkSession(STATES.COMPANY, cart), btn("anything"), baseCtx());
    assert.equal(r.session.state, STATES.COMPANY);
    assert.equal(r.session.failureCount, 1);
  });
});

// ------------------------------------------------------- collect & logistics

describe("COLLECT and LOGISTICS", () => {
  const cart = { depotId: 1, productId: 10, quantity: 30000, companyName: "Acme Fuels Ltd" };

  it("pickup offers declare-now or defer-to-gate", () => {
    const r = reduce(mkSession(STATES.COLLECT, cart), btn("pickup"), baseCtx());
    assert.equal(r.session.state, STATES.LOGISTICS);
    assert.deepEqual(kinds(r), [REPLY.BUTTONS]);
    assert.deepEqual(buttonIds(r.replies[0]), ["declare_trucks", "defer_trucks"]);
  });

  it("typed 'delivery' asks for an address", () => {
    const r = reduce(mkSession(STATES.COLLECT, cart), txt("Delivery"), baseCtx());
    assert.equal(r.session.state, STATES.LOGISTICS);
  });

  it("a real address reaches CONFIRM", () => {
    const s = mkSession(STATES.LOGISTICS, { ...cart, deliveryType: "delivery" });
    const r = reduce(s, txt("14 Airport Road, Warri, Delta"), baseCtx());
    assert.equal(r.session.state, STATES.CONFIRM);
    assert.deepEqual(kinds(r), [REPLY.BUTTONS]);
  });

  it("a too-short address is bounced", () => {
    const s = mkSession(STATES.LOGISTICS, { ...cart, deliveryType: "delivery" });
    const r = reduce(s, txt("Warri"), baseCtx());
    assert.equal(r.session.state, STATES.LOGISTICS);
  });

  it("deferring trucks reaches CONFIRM with an empty fleet", () => {
    const s = mkSession(STATES.LOGISTICS, { ...cart, deliveryType: "pickup" });
    const r = reduce(s, btn("defer_trucks"), baseCtx());
    assert.equal(r.session.state, STATES.CONFIRM);
    assert.equal(r.session.cart.trucksDeferred, true);
    assert.equal(r.session.cart.trucks, undefined);
    assert.match(r.replies[0].body, /truck numbers taken at the gate/i);
  });

  it("declare-now then one plate reaches CONFIRM", () => {
    const choice = reduce(mkSession(STATES.LOGISTICS, { ...cart, deliveryType: "pickup" }), btn("declare_trucks"), baseCtx());
    assert.equal(choice.session.cart.declareTrucks, true);
    assert.deepEqual(buttonIds(choice.replies[0]), ["defer_trucks"], "escape stays on the truck-number prompt");
    const r = reduce(choice.session, txt("abc-123-xy"), baseCtx());
    assert.equal(r.session.state, STATES.CONFIRM);
    assert.deepEqual(r.session.cart.trucks, [{ quantity: 30000, plate: "ABC-123-XY" }]);
  });

  it("an implausible plate is bounced", () => {
    const s = mkSession(STATES.LOGISTICS, { ...cart, deliveryType: "pickup", declareTrucks: true });
    const r = reduce(s, txt("x"), baseCtx());
    assert.equal(r.session.state, STATES.LOGISTICS);
    assert.equal(r.session.failureCount, 1);
  });

  it("Skip now mid-declare clears a partial split", () => {
    const midway = {
      ...cart,
      deliveryType: "pickup",
      declareTrucks: true,
      truckCount: 2,
      trucks: [{ quantity: 60000, plate: "AAA-111-AA" }],
      quantity: 110000,
    };
    const r = reduce(mkSession(STATES.LOGISTICS, midway), btn("defer_trucks"), baseCtx());
    assert.equal(r.session.state, STATES.CONFIRM);
    assert.equal(r.session.cart.trucksDeferred, true);
    assert.equal(r.session.cart.trucks, undefined);
    assert.equal(r.session.cart.truckCount, undefined);
    assert.equal(r.session.cart.declareTrucks, undefined);
  });

  it("above one truck the CUSTOMER declares the fleet: count, litres, plates", () => {
    const big = { depotId: 1, productId: 10, quantity: 110000, companyName: "Acme Fuels Ltd", deliveryType: "pickup" };
    // First: declare/defer choice.
    const s = mkSession(STATES.COLLECT, big);
    const choice = reduce(s, btn("pickup"), baseCtx());
    assert.deepEqual(buttonIds(choice.replies[0]), ["declare_trucks", "defer_trucks"]);

    const asked = reduce(choice.session, btn("declare_trucks"), baseCtx());
    assert.equal(asked.session.state, STATES.LOGISTICS);
    assert.match(asked.replies[asked.replies.length - 1].body, /how many trucks are you sending/i);
    assert.deepEqual(buttonIds(asked.replies[0]), ["defer_trucks"]);

    // 1 truck can't carry 110,000 L.
    const tooFew = reduce(asked.session, txt("1"), baseCtx());
    assert.equal(tooFew.session.cart.truckCount, undefined);

    // 2 trucks accepted → truck 1's litres.
    const counted = reduce(asked.session, txt("2"), baseCtx());
    assert.equal(counted.session.cart.truckCount, 2);
    assert.match(counted.replies[counted.replies.length - 1].body, /Truck 1 of 2/);

    // 70,000 L exceeds a truck.
    const tooMuch = reduce(counted.session, txt("70000"), baseCtx());
    assert.equal(tooMuch.session.cart.currentLitres, undefined);

    // 60,000 L accepted → truck 1's plate.
    const loaded = reduce(counted.session, txt("60,000"), baseCtx());
    assert.equal(loaded.session.cart.currentLitres, 60000);
    const plated = reduce(loaded.session, txt("AAA-111-AA"), baseCtx());
    assert.deepEqual(plated.session.cart.trucks, [{ quantity: 60000, plate: "AAA-111-AA" }]);

    // Last truck takes the remainder automatically — only its plate is asked.
    assert.match(plated.replies[plated.replies.length - 1].body, /remaining 50,000 L/);
    const finished = reduce(plated.session, txt("BBB-222-BB"), baseCtx());
    assert.equal(finished.session.state, STATES.CONFIRM);
    assert.deepEqual(finished.session.cart.trucks, [
      { quantity: 60000, plate: "AAA-111-AA" },
      { quantity: 50000, plate: "BBB-222-BB" },
    ]);
  });

  it("a truck cannot starve or overload the ones after it", () => {
    // Floor: truck 2 of 3 taking ALL 50,000 remaining leaves truck 3 nothing.
    const midway = {
      depotId: 1, productId: 10, quantity: 110000, deliveryType: "pickup",
      declareTrucks: true,
      truckCount: 3, trucks: [{ quantity: 60000, plate: "AAA-111-AA" }],
    };
    const starved = reduce(mkSession(STATES.LOGISTICS, midway), txt("50000"), baseCtx());
    assert.equal(starved.session.cart.currentLitres, undefined);
    assert.equal(starved.session.failureCount, 1);

    // Ceiling: truck 1 of 3 taking only 1,000 L of 130,000 leaves 129,000 —
    // more than two trucks can physically carry.
    const big = { depotId: 1, productId: 10, quantity: 130000, deliveryType: "pickup", declareTrucks: true, truckCount: 3, trucks: [] };
    const overloaded = reduce(mkSession(STATES.LOGISTICS, big), txt("1000"), baseCtx());
    assert.equal(overloaded.session.cart.currentLitres, undefined);
  });

  it("a deferred pickup confirm places the order with no trucks", () => {
    const cartDeferred = { ...cart, deliveryType: "pickup", trucksDeferred: true };
    const r = reduce(mkSession(STATES.CONFIRM, cartDeferred), btn("confirm"), baseCtx());
    assert.deepEqual(effectTypes(r), [EFFECTS.CREATE_ORDER]);
    assert.deepEqual(r.effects[0].payload.trucks, []);
  });
});

// -------------------------------------------------------------------- confirm

describe("CONFIRM", () => {
  it("the summary shows the server-side total", () => {
    const r = reduce(mkSession(STATES.LOGISTICS, { depotId: 1, productId: 10, quantity: 30000, companyName: "Acme Fuels Ltd", deliveryType: "pickup", declareTrucks: true }), txt("ABC-123-XY"), baseCtx());
    assert.ok(r.replies[0].body.includes("25,500,000")); // 30,000 × ₦850
    assert.ok(r.replies[0].body.includes("Acme Fuels Ltd"), "the company is on the summary");
  });

  it("'confirm' emits CREATE_ORDER with the trucks and marks the cart pending", () => {
    const r = reduce(mkSession(STATES.CONFIRM, fullPickupCart()), btn("confirm"), baseCtx());
    assert.deepEqual(effectTypes(r), [EFFECTS.CREATE_ORDER]);
    const payload = r.effects[0].payload;
    assert.equal(payload.state, "Delta"); // from the depot, not the customer
    assert.equal(payload.companyName, "Acme Fuels Ltd"); // the order carries its company
    assert.deepEqual(payload.trucks, [{ truckNumber: "ABC-123-XY", quantity: 30000 }]);
    assert.equal(r.session.cart.pendingOrder, true);
  });

  it("a delivery confirm carries the address instead of trucks", () => {
    const cart = { depotId: 1, productId: 10, quantity: 30000, companyName: "Acme Fuels Ltd", deliveryType: "delivery", address: "14 Airport Road, Warri" };
    const r = reduce(mkSession(STATES.CONFIRM, cart), btn("confirm"), baseCtx());
    assert.equal(r.effects[0].payload.deliveryAddress, "14 Airport Road, Warri");
    assert.equal(r.effects[0].payload.companyName, "Acme Fuels Ltd");
    assert.equal(r.effects[0].payload.trucks, undefined);
  });

  it("a second confirm tap while pending does NOT order twice", () => {
    const s = mkSession(STATES.CONFIRM, { ...fullPickupCart(), pendingOrder: true });
    const r = reduce(s, btn("confirm"), baseCtx());
    assert.deepEqual(r.effects, []);
  });

  it("'edit' offers the five things that can change", () => {
    const r = reduce(mkSession(STATES.CONFIRM, fullPickupCart()), btn("edit"), baseCtx());
    assert.deepEqual(rowIds(r.replies[0]), ["edit:depot", "edit:product", "edit:quantity", "edit:company", "edit:collect"]);
  });

  it("editing quantity clears it (and the trucks sized off it) and re-asks", () => {
    const r = reduce(mkSession(STATES.CONFIRM, fullPickupCart()), lst("edit:quantity"), baseCtx());
    assert.equal(r.session.state, STATES.QUANTITY);
    assert.equal(r.session.cart.quantity, undefined);
    assert.equal(r.session.cart.trucks, undefined);
    assert.equal(r.session.cart.truckCount, undefined);
    assert.equal(r.session.cart.deliveryType, "pickup"); // survives
  });

  it("after an edit, answered steps are skipped on the way back", () => {
    const edited = reduce(mkSession(STATES.CONFIRM, fullPickupCart()), lst("edit:quantity"), baseCtx());
    const r = reduce(edited.session, txt("40000"), baseCtx());
    assert.equal(r.session.state, STATES.LOGISTICS); // declare/defer choice, not COLLECT
    assert.deepEqual(buttonIds(r.replies[0]), ["declare_trucks", "defer_trucks"]);
  });

  it("confirming a cart above stock places the order — no re-ask", () => {
    // Was: bounced back to QUANTITY whenever the cart exceeded stock, which
    // silently discarded a figure the customer had already given. Typed
    // 'confirm' is used rather than a bare button so this tests the stock
    // path and not the summary-fingerprint one, which still applies.
    // Trucks are sized to the quantity (60,000 L each) so this exercises the
    // stock path rather than tripping the truck-declaration check on the way.
    const overStock = {
      ...fullPickupCart(),
      quantity: 150000,
      truckCount: 3,
      trucks: [
        { quantity: 60000, plate: "ABC-123-XY" },
        { quantity: 60000, plate: "ABC-124-XY" },
        { quantity: 30000, plate: "ABC-125-XY" },
      ],
    };
    const r = reduce(mkSession(STATES.CONFIRM, overStock), txt("confirm"), baseCtx());
    assert.notEqual(r.session.state, STATES.QUANTITY);
    assert.deepEqual(effectTypes(r), [EFFECTS.CREATE_ORDER]);
  });

  it("garbage re-shows the summary", () => {
    const r = reduce(mkSession(STATES.CONFIRM, fullPickupCart()), txt("hmm"), baseCtx());
    assert.equal(r.session.failureCount, 1);
    assert.deepEqual(kinds(r), [REPLY.BUTTONS]);
  });

  it("the Confirm button fingerprints the cart it summarises", () => {
    const r = reduce(mkSession(STATES.LOGISTICS, { depotId: 1, productId: 10, quantity: 30000, companyName: "Acme Fuels Ltd", deliveryType: "pickup", declareTrucks: true }), txt("ABC-123-XY"), baseCtx());
    const ids = buttonIds(r.replies[0]);
    assert.match(ids[0], /^confirm:[0-9a-f]+$/);
    assert.deepEqual(ids.slice(1), ["edit", "cancel"]);
  });

  it("tapping the current summary's tokened Confirm places the order", () => {
    const summary = reduce(mkSession(STATES.LOGISTICS, { depotId: 1, productId: 10, quantity: 30000, companyName: "Acme Fuels Ltd", deliveryType: "pickup", declareTrucks: true }), txt("ABC-123-XY"), baseCtx());
    const confirmId = buttonIds(summary.replies[0])[0];
    const r = reduce(summary.session, btn(confirmId), baseCtx());
    assert.deepEqual(effectTypes(r), [EFFECTS.CREATE_ORDER]);
  });

  it("Confirm still matches after jsonb-style key reorder on trucks", () => {
    // Multi-truck carts are the fragile case: token hashes the trucks array,
    // and Postgres jsonb may reshuffle object keys on reload.
    const cart = {
      depotId: 1,
      productId: 10,
      quantity: 80000,
      companyName: "Acme Fuels Ltd",
      deliveryType: "pickup",
      truckCount: 3,
      trucks: [
        { quantity: 20000, plate: "ABC33353" },
        { quantity: 30000, plate: "AFG4464646" },
        { quantity: 30000, plate: "DCR25353" },
      ],
    };
    const summary = reduce(mkSession(STATES.CONFIRM, cart), txt("hmm"), baseCtx());
    const confirmId = buttonIds(summary.replies[0])[0];
    const reloaded = {
      ...summary.session,
      cart: {
        ...summary.session.cart,
        trucks: summary.session.cart.trucks.map((t) => ({ plate: t.plate, quantity: t.quantity })),
      },
    };
    const r = reduce(reloaded, btn(confirmId), baseCtx());
    assert.deepEqual(effectTypes(r), [EFFECTS.CREATE_ORDER], "key order must not invalidate Confirm");
  });

  it("a Confirm from an OUTDATED summary is refused with the current one re-shown", () => {
    // Reach CONFIRM, capture that summary's button…
    const first = reduce(mkSession(STATES.LOGISTICS, { depotId: 1, productId: 10, quantity: 30000, companyName: "Acme Fuels Ltd", deliveryType: "pickup", declareTrucks: true }), txt("ABC-123-XY"), baseCtx());
    const staleId = buttonIds(first.replies[0])[0];
    // …then change the quantity (new summary, new token)…
    const edited = reduce(first.session, lst("edit:quantity"), baseCtx());
    const requoted = reduce(edited.session, txt("40000"), baseCtx());
    const declared = reduce(requoted.session, btn("declare_trucks"), baseCtx());
    const replated = reduce(declared.session, txt("ABC-123-XY"), baseCtx());
    assert.equal(replated.session.state, STATES.CONFIRM);
    // …and tap the OLD button.
    const r = reduce(replated.session, btn(staleId), baseCtx());
    assert.deepEqual(r.effects, [], "the stale tap must not order");
    assert.equal(r.session.state, STATES.CONFIRM);
    assert.deepEqual(kinds(r), [REPLY.TEXT, REPLY.BUTTONS]); // heads-up + fresh summary
    assert.match(r.replies[1].body, /40,000/);
  });

  it("a typed 'confirm' (no token) always means the current cart", () => {
    const r = reduce(mkSession(STATES.CONFIRM, fullPickupCart()), txt("confirm"), baseCtx());
    assert.deepEqual(effectTypes(r), [EFFECTS.CREATE_ORDER]);
  });

  it("a wallet that covers the total announces itself on the summary", () => {
    const ctx = baseCtx({ customer: { id: 7, name: "Ada", status: "Active", balance: "30000000" } });
    const r = reduce(mkSession(STATES.LOGISTICS, { depotId: 1, productId: 10, quantity: 30000, companyName: "Acme Fuels Ltd", deliveryType: "pickup", declareTrucks: true }), txt("ABC-123-XY"), ctx);
    assert.match(r.replies[0].body, /wallet/i);
    assert.match(r.replies[0].body, /30,000,000/);
  });

  it("an insufficient wallet stays out of the summary", () => {
    const ctx = baseCtx({ customer: { id: 7, name: "Ada", status: "Active", balance: "500" } });
    const r = reduce(mkSession(STATES.LOGISTICS, { depotId: 1, productId: 10, quantity: 30000, companyName: "Acme Fuels Ltd", deliveryType: "pickup", declareTrucks: true }), txt("ABC-123-XY"), ctx);
    assert.doesNotMatch(r.replies[0].body, /wallet/i);
  });
});

// ------------------------------------------------ order outcomes and payment

describe("order outcomes", () => {
  const ORDER = {
    id: 501,
    orderNumber: "SOR-501",
    totalAmount: 25500000,
    deliveryType: "pickup",
    virtualAccountBank: "Wema Bank",
    virtualAccountNumber: "9930001111",
    virtualAccountName: "SOROMANNIGERI/ AO",
    invoiceUrl: "https://files.example/invoice.pdf",
    expiresAt: "2026-08-12T15:42:00.000Z",
  };

  it("ORDER_CREATED: invoice, the transfer details with Cancel, the who's-paying ask, then portal hint", () => {
    const s = mkSession(STATES.CONFIRM, { ...fullPickupCart(), pendingOrder: true });
    const r = reduce(s, { type: INBOUND.ORDER_CREATED, order: ORDER }, baseCtx());
    // An unpaid order now stops to ask who is sending the money before it
    // settles into the wait — see handleExpectedPayment.
    assert.equal(r.session.state, STATES.EXPECTED_PAYMENT);
    assert.equal(r.session.lastOrderId, 501);
    // The transfer details ARE the buttons message body — one message, not two,
    // so the "how to pay" copy can't drift from the buttons that action it.
    // The expected-payment ask is its own message with its own buttons.
    assert.deepEqual(kinds(r), [REPLY.DOCUMENT, REPLY.BUTTONS, REPLY.BUTTONS, REPLY.TEXT]);
    assert.ok(r.replies[1].body.includes("9930001111"));
    assert.match(r.replies[1].body, /pay by/i);
    assert.deepEqual(buttonIds(r.replies[2]), ["expectdone", "expectskip"]);
    assert.equal(r.session.cart.awaiting.expiresAt, ORDER.expiresAt);
    // Cancel only. "Pay now" settled the order from wallet balance and went
    // with the rest of that path — the transfer itself is the action now, and
    // the finance desk confirms the order against the statement line it lands
    // on. See engine.awaitPaymentButtonDefs.
    assert.deepEqual(buttonIds(r.replies[1]), ["cancelorder"]);
  });

  it("ORDER_CREATED offers no payment button, funded wallet or not", () => {
    const s = mkSession(STATES.CONFIRM, { ...fullPickupCart(), pendingOrder: true });
    const btns = (x) => x.replies.find((y) => y.kind === REPLY.BUTTONS);
    const empty = reduce(s, { type: INBOUND.ORDER_CREATED, order: ORDER }, baseCtx());
    const funded = reduce(s, { type: INBOUND.ORDER_CREATED, order: ORDER },
      baseCtx({ customer: { id: 7, name: "Ada", status: "Active", balance: "30000000" } }));
    // A covered balance used to be the case FOR offering the button. It is now
    // beside the point: a wallet balance cannot pay for an order at all.
    assert.deepEqual(buttonIds(btns(empty)), ["cancelorder"]);
    assert.deepEqual(buttonIds(btns(funded)), ["cancelorder"]);
  });

  it("a Pay now tap from an old session moves no money and explains the transfer", () => {
    // The button is gone, but a conversation that rendered it before the change
    // can still deliver the tap. It must not fall through to the unknown-input
    // handler, and it must certainly not pay anything.
    const s = mkSession(STATES.AWAIT_PAYMENT, { awaiting: { orderNumber: "SOR-1", totalAmount: 100 } }, { lastOrderId: 501, customerId: 7 });
    const r = reduce(s, btn("paynow"), baseCtx({ customer: { id: 7, name: "Ada", status: "Active", balance: "500" } }));
    assert.deepEqual(effectTypes(r), [], "no effect — nothing pays an order from this side any more");
    assert.equal(r.replies.length, 1);
    assert.match(r.replies[0].body, /send the transfer/i);
  });

  it("a refused wallet payment keeps the order in AWAIT_PAYMENT and points at transfer", () => {
    const s = mkSession(STATES.AWAIT_PAYMENT, { awaiting: { orderNumber: "SOR-1", totalAmount: 100 } }, { lastOrderId: 501 });
    const r = reduce(s, { type: INBOUND.ORDER_FAILED, reason: "pay", message: "Insufficient wallet balance." }, baseCtx());
    assert.equal(r.session.state, STATES.AWAIT_PAYMENT);
    assert.match(r.replies[0].body, /transfer/i);
    assert.deepEqual(effectTypes(r), []);
  });

  it("an expired Pay now leaves AWAIT_PAYMENT and offers reorder", () => {
    const s = mkSession(STATES.AWAIT_PAYMENT, { awaiting: { orderNumber: "SOR-1", totalAmount: 100 } }, { lastOrderId: 501 });
    const r = reduce(
      s,
      {
        type: INBOUND.ORDER_FAILED,
        reason: "expired",
        message: "This order has expired. Please place a new order at current prices.",
      },
      baseCtx()
    );
    assert.equal(r.session.state, STATES.MENU);
    assert.deepEqual(r.session.cart, {});
    assert.deepEqual(kinds(r), [REPLY.BUTTONS]);
    assert.match(r.replies[0].body, /expired/i);
    assert.deepEqual(buttonIds(r.replies[0]), ["reorder", "order"]);
  });

  it("an order already paid from the wallet asks for NO transfer and awaits nothing", () => {
    const paid = { ...ORDER, paymentStatus: "Paid" };
    const s = mkSession(STATES.CONFIRM, { ...fullPickupCart(), pendingOrder: true });
    const r = reduce(s, { type: INBOUND.ORDER_CREATED, order: paid }, baseCtx());
    assert.equal(r.session.state, STATES.MENU); // nothing to await
    assert.deepEqual(r.session.cart, {});
    assert.equal(r.session.lastOrderId, 501);
    const body = r.replies.find((x) => x.kind === REPLY.TEXT).body;
    assert.match(body, /wallet/i);
    assert.doesNotMatch(body, /9930001111/, "no transfer instructions on a paid order");
  });

  it("no invoice URL: no document reply, everything else intact", () => {
    const { invoiceUrl, ...order } = ORDER;
    const s = mkSession(STATES.CONFIRM, { ...fullPickupCart(), pendingOrder: true });
    const r = reduce(s, { type: INBOUND.ORDER_CREATED, order }, baseCtx());
    assert.ok(!kinds(r).includes(REPLY.DOCUMENT));
  });

  it("ORDER_FAILED on a stock race goes back to QUANTITY with the fresh figure", () => {
    const s = mkSession(STATES.CONFIRM, { ...fullPickupCart(), pendingOrder: true });
    const r = reduce(s, { type: INBOUND.ORDER_FAILED, reason: "stock", stock: 45000 }, baseCtx());
    assert.equal(r.session.state, STATES.QUANTITY);
    assert.match(r.replies[0].body, /smaller quantity/i);
    assert.ok(!r.replies[0].body.includes("45,000"), "the fresh stock figure stays private");
    assert.equal(r.session.cart.pendingOrder, undefined);
  });

  it("ORDER_FAILED with zero stock left goes back to DEPOT", () => {
    const s = mkSession(STATES.CONFIRM, { ...fullPickupCart(), pendingOrder: true });
    const r = reduce(s, { type: INBOUND.ORDER_FAILED, reason: "stock", stock: 0 }, baseCtx());
    assert.equal(r.session.state, STATES.DEPOT);
  });

  it("a generic ORDER_FAILED apologises and lets confirm retry", () => {
    const s = mkSession(STATES.CONFIRM, { ...fullPickupCart(), pendingOrder: true });
    const failed = reduce(s, { type: INBOUND.ORDER_FAILED, reason: "unknown" }, baseCtx());
    assert.equal(failed.session.state, STATES.CONFIRM);
    const retried = reduce(failed.session, btn("confirm"), baseCtx());
    assert.deepEqual(effectTypes(retried), [EFFECTS.CREATE_ORDER]);
  });

  it("the order-created buttons offer Cancel only", () => {
    const s = mkSession(STATES.CONFIRM, { ...fullPickupCart(), pendingOrder: true });
    const out = reduce(s, { type: INBOUND.ORDER_CREATED, order: ORDER }, baseCtx());
    const buttonsReply = out.replies.find((r) => r.kind === REPLY.BUTTONS);
    assert.ok(buttonsReply, "order-created always gets a buttons message now");
    assert.deepEqual(buttonIds(buttonsReply), ["cancelorder"]);
  });

  it("a stale 'I've paid' tap does nothing", () => {
    const s = mkSession(STATES.AWAIT_PAYMENT, { awaiting: { orderNumber: "SOR-1" } }, { lastOrderId: 501 });
    const out = reduce(s, btn("devpaid"), baseCtx());
    assert.deepEqual(out.effects, []);
  });

  it("cancelling an unpaid order: confirm first, then a real effect, then MENU", () => {
    const s = mkSession(
      STATES.AWAIT_PAYMENT,
      { awaiting: { orderNumber: "SOR-501" } },
      { lastOrderId: 501 }
    );
    // Typed "cancel" in AWAIT_PAYMENT asks about the ORDER, not a cart.
    const asked = reduce(s, txt("cancel"), baseCtx());
    assert.equal(asked.session.state, STATES.AWAIT_PAYMENT, "nothing cancelled yet");
    assert.deepEqual(buttonIds(asked.replies[0]), ["cancelorder:yes", "keeporder"]);
    assert.deepEqual(asked.effects, []);

    // Keep it → back to the nudge.
    const kept = reduce(asked.session, btn("keeporder"), baseCtx());
    assert.equal(kept.session.state, STATES.AWAIT_PAYMENT);
    assert.deepEqual(kept.effects, []);

    // Confirm the cancel → the effect goes out.
    const confirmed = reduce(asked.session, btn("cancelorder:yes"), baseCtx());
    assert.deepEqual(effectTypes(confirmed), [EFFECTS.CANCEL_ORDER]);
    assert.equal(confirmed.effects[0].payload.orderId, 501);

    // The outcome re-enters: cancelled → MENU with the goodbye.
    const done_ = reduce(confirmed.session, { type: INBOUND.ORDER_CANCELLED, order: { orderNumber: "SOR-501" } }, baseCtx());
    assert.equal(done_.session.state, STATES.MENU);
    assert.match(done_.replies[0].body, /cancelled/i);
  });

  it("a refused cancel (order moved on) says call us and stays put", () => {
    const s = mkSession(STATES.AWAIT_PAYMENT, { awaiting: { orderNumber: "SOR-501" } }, { lastOrderId: 501 });
    const r = reduce(s, { type: INBOUND.ORDER_FAILED, reason: "cancel" }, baseCtx());
    assert.equal(r.session.state, STATES.AWAIT_PAYMENT);
    assert.match(r.replies[0].body, /could not cancel/i);
  });

  it("AWAIT_PAYMENT nudges with the account details on random text", () => {
    const s = mkSession(STATES.AWAIT_PAYMENT, {
      awaiting: { orderNumber: "SOR-501", totalAmount: 25500000, virtualAccountBank: "Wema Bank", virtualAccountNumber: "9930001111" },
    });
    const r = reduce(s, txt("have you seen it?"), baseCtx());
    assert.equal(r.session.state, STATES.AWAIT_PAYMENT);
    assert.ok(r.replies[0].body.includes("9930001111"));
  });

  it("PAYMENT_CONFIRMED inside the window: a warm text, back to MENU", () => {
    const s = mkSession(STATES.AWAIT_PAYMENT, { awaiting: {} });
    const r = reduce(s, { type: INBOUND.PAYMENT_CONFIRMED, order: { orderNumber: "SOR-501" } }, baseCtx());
    assert.equal(r.session.state, STATES.MENU);
    assert.deepEqual(kinds(r), [REPLY.TEXT]);
  });

  it("PAYMENT_CONFIRMED outside the window: the approved template, nothing else", () => {
    const s = mkSession(STATES.AWAIT_PAYMENT, { awaiting: {} });
    const ctx = baseCtx({ withinServiceWindow: false });
    const r = reduce(s, { type: INBOUND.PAYMENT_CONFIRMED, order: { orderNumber: "SOR-501" } }, ctx);
    assert.deepEqual(kinds(r), [REPLY.TEMPLATE]);
    assert.equal(r.replies[0].name, TEMPLATES.PAYMENT_RECEIVED);
  });
});

// ------------------------------------------------------------ expiry & resume

describe("EXPECTED_PAYMENT — who is sending the money", () => {
  const awaiting = () => ({
    awaiting: {
      orderNumber: "SOR-1042",
      totalAmount: 25500000,
      virtualAccountBank: "Wema Bank",
      virtualAccountNumber: "9930001111",
    },
  });
  const mk = (cart = {}) =>
    mkSession(STATES.EXPECTED_PAYMENT, { ...awaiting(), ...cart }, { lastOrderId: 501 });

  it("Skip moves on without writing anything", () => {
    const r = reduce(mk(), btn("expectskip"), baseCtx());
    assert.equal(r.session.state, STATES.AWAIT_PAYMENT);
    assert.deepEqual(effectTypes(r), [], "advisory only — nothing to write");
  });

  it("Done with nothing said is the same as Skip", () => {
    const r = reduce(mk(), btn("expectdone"), baseCtx());
    assert.equal(r.session.state, STATES.AWAIT_PAYMENT);
    assert.deepEqual(effectTypes(r), []);
  });

  it("an entry is read back and held on the cart, not written yet", () => {
    const r = reduce(mk(), txt("5,000,000 Rure Oil and Gas"), baseCtx());
    assert.equal(r.session.state, STATES.EXPECTED_PAYMENT, "stays put for the next one");
    assert.deepEqual(r.session.cart.expected, [{ amount: 5000000, name: "Rure Oil and Gas" }]);
    // Nothing is written until Done: a chat abandoned halfway must not leave a
    // partial split the desk could read as the whole story.
    assert.deepEqual(effectTypes(r), []);
    assert.match(r.replies[0].body, /5,000,000/);
    assert.match(r.replies[0].body, /Rure Oil and Gas/);
  });

  it("every entry is written in ONE effect on Done", () => {
    const ctx = baseCtx();
    let s1 = reduce(mk(), txt("5,000,000 Rure Oil and Gas"), ctx).session;
    let s2 = reduce(s1, txt("2.5m Ukwenu James"), ctx).session;
    const r = reduce(s2, btn("expectdone"), ctx);

    assert.equal(r.session.state, STATES.AWAIT_PAYMENT);
    assert.deepEqual(effectTypes(r), [EFFECTS.NOTE_EXPECTED_PAYMENTS]);
    assert.deepEqual(r.effects[0].payload.entries, [
      { amount: 5000000, name: "Rure Oil and Gas" },
      { amount: 2500000, name: "Ukwenu James" },
    ]);
    assert.equal(r.effects[0].payload.orderId, 501);
    assert.equal(r.effects[0].payload.customerId, 7);
    // The working list is cleared once spent, so a later turn can't resend it.
    assert.equal(r.session.cart.expected, undefined);
  });

  it("an unreadable line re-asks and keeps the buttons, writing nothing", () => {
    const r = reduce(mk(), txt("i will pay soon"), baseCtx());
    assert.equal(r.session.state, STATES.EXPECTED_PAYMENT);
    assert.deepEqual(effectTypes(r), []);
    assert.deepEqual(buttonIds(r.replies[0]), ["expectdone", "expectskip"]);
  });

  it("a name with no usable figure is refused as an amount problem", () => {
    const r = reduce(mk(), txt("0 Rure Oil"), baseCtx());
    assert.equal(r.session.state, STATES.EXPECTED_PAYMENT);
    assert.deepEqual(effectTypes(r), []);
    assert.match(r.replies[0].body, /amount/i);
  });

  it("a bare figure with no name is refused — the name is the whole point", () => {
    const r = reduce(mk(), txt("5,000,000"), baseCtx());
    assert.equal(r.session.state, STATES.EXPECTED_PAYMENT);
    assert.deepEqual(r.session.cart.expected, undefined);
    assert.deepEqual(effectTypes(r), []);
  });

  it("stops accepting entries at the cap rather than growing without end", () => {
    const ctx = baseCtx();
    const full = Array.from({ length: LIMITS_MAX_EXPECTED }, (_, i) => ({
      amount: 1000 * (i + 1),
      name: `Payer ${i + 1}`,
    }));
    const r = reduce(mk({ expected: full }), txt("9,000,000 One Too Many"), ctx);
    assert.equal(r.session.cart.expected.length, LIMITS_MAX_EXPECTED, "not appended");
    assert.deepEqual(effectTypes(r), []);
  });

  it("'cancel' here means the REAL order, not a cart to throw away", () => {
    // The order already exists at this point, exactly as in AWAIT_PAYMENT — so
    // cancel must offer the order-cancel confirmation, never drop to the menu.
    const r = reduce(mk(), txt("cancel"), baseCtx());
    assert.notEqual(r.session.state, STATES.MENU);
    assert.deepEqual(buttonIds(r.replies[0]), ["cancelorder:yes", "keeporder"]);
  });
});

describe("expired sessions", () => {
  const cart = { depotId: 1, productId: 10, quantity: 30000, companyName: "Acme Fuels Ltd" };

  it("an expired cart is offered back, not silently dropped", () => {
    const s = mkSession(STATES.COLLECT, cart, { expired: true });
    const r = reduce(s, txt("pickup"), baseCtx());
    assert.deepEqual(buttonIds(r.replies[0]), ["resume", "startover"]);
    assert.equal(r.session.cart.resumeState, STATES.COLLECT);
  });

  it("an expired cart is offered resume even when the user says 'hi'", () => {
    // Greetings normally re-prompt mid-order; after idle expiry they must
    // not skip the Continue / Start over choice.
    const s = mkSession(STATES.COMPANY, cart, { expired: true });
    const r = reduce(s, txt("hi"), baseCtx());
    assert.deepEqual(buttonIds(r.replies[0]), ["resume", "startover"]);
    assert.equal(r.session.cart.resumeState, STATES.COMPANY);
    assert.match(r.replies[0].body, /expired/i);
  });

  it("'resume' picks up at the first unanswered step", () => {
    const s = mkSession(STATES.MENU, { ...cart, resumeState: STATES.COLLECT });
    const r = reduce(s, btn("resume"), baseCtx());
    assert.equal(r.session.state, STATES.COLLECT);
    assert.equal(r.session.cart.resumeState, undefined);
  });

  it("'resume' keeps a quantity above stock instead of clearing it", () => {
    const s = mkSession(STATES.MENU, { ...cart, quantity: 130000, resumeState: STATES.COLLECT });
    const r = reduce(s, btn("resume"), baseCtx());
    assert.notEqual(r.session.state, STATES.QUANTITY);
    assert.equal(r.session.cart.quantity, 130000);
  });

  it("'startover' clears the cart back to MENU", () => {
    const s = mkSession(STATES.MENU, { ...cart, resumeState: STATES.COLLECT });
    const r = reduce(s, btn("startover"), baseCtx());
    assert.equal(r.session.state, STATES.MENU);
    assert.deepEqual(r.session.cart, {});
  });

  it("an expired empty cart just gets the menu — nothing to resume", () => {
    const s = mkSession(STATES.MENU, {}, { expired: true });
    const r = reduce(s, txt("hi"), baseCtx());
    assert.equal(r.session.state, STATES.MENU);
    assert.deepEqual(kinds(r), [REPLY.LIST]);
  });
});

// -------------------------------------------------------------- window & limits

describe("service window and hard limits", () => {
  it("outside the window every reply is a template — whatever was asked", () => {
    const r = reduce(mkSession(STATES.MENU), txt("menu"), baseCtx({ withinServiceWindow: false }));
    assert.ok(r.replies.every((x) => x.kind === REPLY.TEMPLATE));
  });

  it("depot names longer than a row title are clamped, not rejected", () => {
    const depots = [
      {
        id: 1,
        name: "An Extremely Long Depot Name Beyond Any Row Title Limit",
        state: "Delta",
        products: [{ id: 10, name: "PMS", price: 850, stock: 1000000 }],
      },
    ];
    const r = reduce(mkSession(STATES.MENU), btn("order"), baseCtx({ depots }));
    const title = r.replies[0].sections[0].rows[0].title;
    assert.ok(title.length <= LIMITS.MAX_ROW_TITLE);
  });

  it("a prices body with many depots stays under the body limit", () => {
    const depots = Array.from({ length: 40 }, (_, i) => ({
      id: i,
      name: `Depot With A Fairly Long Name ${i}`,
      state: "Delta",
      products: [
        { id: 1, name: "PMS", price: 850, stock: 1 },
        { id: 2, name: "AGO", price: 1020, stock: 1 },
      ],
    }));
    const r = reduce(mkSession(STATES.MENU), btn("prices"), baseCtx({ depots }));
    assert.ok(r.replies[0].body.length <= LIMITS.MAX_BODY);
  });
});
