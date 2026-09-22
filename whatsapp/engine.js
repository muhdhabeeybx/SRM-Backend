/**
 * The conversation engine — a pure function.
 *
 *   reduce(session, inbound, context) → { session, replies, effects }
 *
 * No database, no HTTP, no Date.now(), no randomness. The caller loads
 * `context` (customer, orderable depots/products, service window), performs
 * any `effects` this returns (CREATE_ORDER, CREATE_CUSTOMER), and re-enters
 * with the outcome as a new inbound — so order creation is two turns of the
 * same loop and failure is an ordinary path with its own copy.
 *
 * Design rules enforced here, not in the client:
 *  - WhatsApp's limits (3 buttons, 10 rows, title lengths, 1024-char body)
 *    are respected by construction; reply constructors clamp.
 *  - Outside the 24-hour service window only `template` replies leave.
 *  - Global commands beat state; no state can swallow "menu".
 *  - No input, in any state, throws.
 */

const {
  STATES,
  LIMITS,
  PAGE_SIZE,
  COMMANDS,
  INBOUND,
  REPLY,
  EFFECTS,
  TEMPLATES,
  MIN_ORDER_LITRES,
  MAX_ORDER_LITRES,
  TRUCK_CAPACITY_LITRES,
  MAX_TRUCKS,
  MAX_FAILURES,
  MAX_EXPECTED_PAYMENTS,
} = require("./constants");
const copy = require("./copy");

// The states where a cart is actively being built. A stray or redelivered
// greeting ("hi"/"hello"/"start") in one of these must NOT discard the
// half-built order — only the explicit "menu" and "cancel" commands do that.
const ORDER_BUILDING_STATES = new Set([
  STATES.DEPOT,
  STATES.PRODUCT,
  STATES.QUANTITY,
  STATES.COMPANY,
  STATES.COLLECT,
  STATES.LOGISTICS,
  STATES.CONFIRM,
]);

// ---------------------------------------------------------------- reply kit

const clamp = (str, max) => {
  const s = String(str ?? "");
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
};

// Titles must be 1..max chars; blank data must not become an invalid message.
const clampTitle = (str, max) => {
  const s = clamp(str, max);
  return s.trim().length > 0 ? s : "—";
};

const text = (body) => ({ kind: REPLY.TEXT, body: clamp(body, LIMITS.MAX_BODY) });

const buttons = (body, defs) => ({
  kind: REPLY.BUTTONS,
  body: clamp(body, LIMITS.MAX_BODY),
  buttons: Object.entries(defs)
    .slice(0, LIMITS.MAX_BUTTONS)
    .map(([id, title]) => ({ id, title: clampTitle(title, LIMITS.MAX_BUTTON_TITLE) })),
});

const list = (body, button, rows) => {
  if (!rows || rows.length === 0) {
    // A zero-row list is an API rejection at send time. Never build one.
    return text(body);
  }
  return listUnchecked(body, button, rows);
};

const listUnchecked = (body, button, rows) => ({
  kind: REPLY.LIST,
  body: clamp(body, LIMITS.MAX_BODY),
  button: clampTitle(button, LIMITS.MAX_LIST_BUTTON),
  sections: [
    {
      title: "",
      rows: rows.slice(0, LIMITS.MAX_LIST_ROWS).map((r) => ({
        id: r.id,
        title: clampTitle(r.title, LIMITS.MAX_ROW_TITLE),
        description: r.description ? clamp(r.description, LIMITS.MAX_ROW_DESCRIPTION) : undefined,
      })),
    },
  ],
});

// One URL button per message — a Cloud API rule, not ours. The URL is not
// clamped: a truncated link is worse than none, and these come from env
// config, not user input.
const cta = (body, buttonText, url) => ({
  kind: REPLY.CTA,
  body: clamp(body, LIMITS.MAX_BODY),
  buttonText: clampTitle(buttonText, LIMITS.MAX_BUTTON_TITLE),
  url,
});

const document = (link, filename, caption) => ({
  kind: REPLY.DOCUMENT,
  link,
  filename,
  caption: caption ? clamp(caption, LIMITS.MAX_BODY) : undefined,
});

const template = (name, variables) => ({ kind: REPLY.TEMPLATE, name, variables });

// -------------------------------------------------------------- input reading

/** Lower-cased trimmed value of a user inbound; '' for anything else. */
const valueOf = (inbound) =>
  typeof inbound.value === "string" ? inbound.value.trim().toLowerCase() : "";

const isUserInput = (inbound) =>
  inbound.type === INBOUND.TEXT || inbound.type === INBOUND.BUTTON || inbound.type === INBOUND.LIST;

/**
 * "30000", "30,000", "30 000", "30.000", "30000L", "30k", "30.5k" → whole
 * litres. NaN when it isn't a quantity at all.
 *
 * The `k` suffix is what disambiguates a dot. WITH `k`, the dot is a decimal
 * point applied before the ×1000 multiplier ("30.5k" → 30500, "1.5k" → 1500).
 * WITHOUT `k`, litres are always whole numbers, so a dot is a thousands
 * separator, NOT a decimal — stripped like the comma/space. Without this,
 * "30.000" parsed as the float 30 (thirty litres, not thirty thousand) and
 * "1.500" as 1.5 → a silent, badly wrong quantity.
 */
const parseLitres = (raw) => {
  let s = String(raw ?? "").trim().toLowerCase();
  s = s.replace(/(liters|litres|ltrs|ltr|l)$/i, "").trim();
  if (s.endsWith("k")) {
    // k present → the value is a plain decimal scaled by 1000.
    const n = s.slice(0, -1).replace(/[,\s]/g, "");
    if (!/^\d+(\.\d+)?$/.test(n)) return NaN;
    return Math.round(Number(n) * 1000);
  }
  // No multiplier → every dot/comma/space is thousands grouping.
  s = s.replace(/[,\s.]/g, "");
  if (!/^\d+$/.test(s)) return NaN;
  return Number(s);
};

// Forgiving: real plates vary; the gate audits and can correct them later.
const isPlausiblePlate = (raw) => {
  const s = String(raw ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9\s-]{3,14}$/.test(s) && /[A-Za-z]/.test(s) && /\d/.test(s);
};

const isPlausibleName = (raw) => {
  const s = String(raw ?? "").trim();
  return s.length >= 2 && s.length <= 60 && /[A-Za-z]/.test(s) && !/^\d+$/.test(s);
};

// A company name is freer than a person's — digits and punctuation are common
// ("7-Eleven", "A.G. Leventis") — but it must contain a letter and be a
// sensible length. The backend caps company_name at 255; the chat keeps it
// tighter so the confirm summary stays readable.
const isPlausibleCompany = (raw) => {
  const s = String(raw ?? "").trim();
  return s.length >= 2 && s.length <= 100 && /[A-Za-z]/.test(s);
};

/**
 * "5,000,000 Rure Oil and Gas" -> { amount: 5000000, name: "Rure Oil and Gas" }.
 *
 * Amount first, because that is the order the desk wizard asks in and the
 * order people say it out loud. Everything after the figure is the name the
 * transfer will arrive under, with a leading dash or colon dropped so
 * "5m - Rure Oil" reads the same as "5m Rure Oil".
 *
 * The dot is the trap, exactly as in parseLitres but worse: money HAS a
 * decimal, so a dot cannot simply be stripped. A trailing ".dd" is kobo; any
 * other dot is thousands grouping. Without that split "5.000.000" parses as 5
 * and a customer's five million becomes five naira in the desk's matching hint.
 *
 * Returns null when there is no leading figure at all. A figure with an
 * unusable name, or a name with an unusable figure, comes back with that field
 * empty so the caller can say which half it could not read.
 */
const parseExpectedAmount = (rawNumber, suffix) => {
  let n = String(rawNumber).replace(/[,\s]/g, "");
  if (!/^\d+\.\d{1,2}$/.test(n)) n = n.replace(/\./g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(n)) return NaN;
  const value = Number(n);
  if (!suffix) return value;
  return value * (/k/i.test(suffix) ? 1_000 : 1_000_000);
};

const parseExpectedSplit = (raw) => {
  const m = /^\s*(?:₦|ngn\s*)?\s*(\d[\d.,\s]*)\s*(k|m)?\s*(.+)$/i.exec(String(raw ?? "").trim());
  if (!m) return null;
  const amount = parseExpectedAmount(m[1], m[2]);
  const name = String(m[3] || "").trim().replace(/^[-–—:,]+\s*/, "").trim();
  return {
    amount: Number.isFinite(amount) && amount > 0 ? amount : NaN,
    // isPlausibleCompany also rejects the digit-only tail left behind when the
    // whole message was a bare figure ("5,000,000" -> name "0").
    name: isPlausibleCompany(name) ? name : "",
  };
};

// ------------------------------------------------------------- context reading

const depotsOf = (context) => (Array.isArray(context.depots) ? context.depots : []);

const findDepot = (context, id) => depotsOf(context).find((d) => String(d.id) === String(id));

const productsOf = (depot) => (depot && Array.isArray(depot.products) ? depot.products : []);

const findProduct = (depot, id) => productsOf(depot).find((p) => String(p.id) === String(id));

/**
 * When the customer opts to declare trucks, they say how many and how many
 * litres each carries. One truck is implicit when the whole order fits in it;
 * the last truck always takes the exact remainder. Declaration is optional —
 * they can defer plates to the gate (portal parity).
 */
const trucksNeeded = (cart) =>
  Number(cart.quantity) <= TRUCK_CAPACITY_LITRES ? 1 : Number(cart.truckCount) || null;

const litresAssigned = (cart) => (cart.trucks || []).reduce((s, t) => s + Number(t.quantity), 0);

const trucksComplete = (cart) => {
  const needed = trucksNeeded(cart);
  return Boolean(needed && (cart.trucks || []).length >= needed);
};

/** True once the customer has either deferred to the gate or finished declaring. */
const pickupLogisticsDone = (cart) => Boolean(cart.trucksDeferred) || trucksComplete(cart);

/**
 * Mid-declare (including a resumed session that already has a partial fleet)
 * vs still on the declare/defer choice.
 */
const isDeclaringTrucks = (cart) =>
  Boolean(
    cart.declareTrucks ||
      cart.truckCount ||
      cart.currentLitres ||
      ((cart.trucks || []).length > 0 && !cart.trucksDeferred)
  );

const minTrucksFor = (quantity) => Math.max(1, Math.ceil(Number(quantity) / TRUCK_CAPACITY_LITRES));

// Can't exceed MAX_TRUCKS, and every truck must carry at least a litre.
const maxTrucksFor = (quantity) => Math.max(1, Math.min(MAX_TRUCKS, Math.floor(Number(quantity))));

// --------------------------------------------------------------- cart & steps

const emptyCart = () => ({});

/**
 * The first unanswered step, in order. Edits jump back by clearing a field
 * (plus its dependents); this sends the customer forward again through only
 * what is missing, then straight to CONFIRM.
 */
const nextStep = (cart) => {
  if (!cart.depotId) return STATES.DEPOT;
  if (!cart.productId) return STATES.PRODUCT;
  if (!cart.quantity) return STATES.QUANTITY;
  if (!cart.companyName) return STATES.COMPANY;
  if (!cart.deliveryType) return STATES.COLLECT;
  if (cart.deliveryType === "delivery" && !cart.address) return STATES.LOGISTICS;
  if (cart.deliveryType === "pickup" && !pickupLogisticsDone(cart)) return STATES.LOGISTICS;
  return STATES.CONFIRM;
};

/**
 * A cart can outlive its context — a resumed session, or a confirm racing a
 * stock change. Drop whatever context no longer supports, with a line of copy
 * saying so, and let nextStep() walk the customer forward from what survived.
 */
const revalidateCart = (cart, ctx) => {
  if (cart.depotId && !findDepot(ctx, cart.depotId)) {
    return { cart: clearDepot(cart), lead: [text(copy.depotUnavailable())] };
  }
  const depot = findDepot(ctx, cart.depotId);
  if (cart.productId && depot && !findProduct(depot, cart.productId)) {
    return { cart: clearProduct(cart), lead: [text(copy.productUnavailable(depot.name))] };
  }
  // A quantity is no longer revalidated against stock: it silently cleared a
  // figure the customer had already given, on a depot whose stock reads 0
  // because it has no active PFI. Depot and product still have to exist.
  return { cart, lead: [] };
};

// Clearing a field invalidates everything priced/sized off it. (Truck
// declarations hang off both the quantity and the collection choice.)
const clearTruckFields = (cart) => {
  const { trucks, truckCount, currentLitres, declareTrucks, trucksDeferred, ...rest } = cart;
  return rest;
};
const clearDepot = (cart) => {
  const { depotId, productId, quantity, ...rest } = clearTruckFields(cart);
  return rest;
};
const clearProduct = (cart) => {
  const { productId, quantity, ...rest } = clearTruckFields(cart);
  return rest;
};
const clearQuantity = (cart) => {
  const { quantity, ...rest } = clearTruckFields(cart);
  return rest;
};
const clearCollect = (cart) => {
  const { deliveryType, address, ...rest } = clearTruckFields(cart);
  return rest;
};

/** Defer plates to the gate — drops any half-finished declaration. */
const deferTrucksToGate = (cart) => ({ ...clearTruckFields(cart), trucksDeferred: true });

/** Opt into the declare-now path (clears a prior defer). */
const startDeclareTrucks = (cart) => {
  const { trucksDeferred, ...rest } = cart;
  return { ...rest, declareTrucks: true };
};

/** Wrap a declare-now prompt with the abandon-to-gate escape button. */
const declarePrompt = (body) => buttons(body, copy.truckDeferEscapeButtons());

// Company is order-level: it hangs off nothing priced or sized, so clearing
// depot/product/quantity/collect leaves it intact. Only an explicit edit drops it.
const clearCompany = (cart) => {
  const { companyName, ...rest } = cart;
  return rest;
};

/**
 * A short deterministic fingerprint of the order-defining cart fields. The
 * CONFIRM button carries it (`confirm:<token>`), so a tap on a summary sent
 * before the cart changed is detectable — WhatsApp buttons live forever in
 * the chat history, and confirming a total the customer never saw is the one
 * stale-tap case the state machine alone cannot catch. FNV-1a: pure, tiny,
 * and stable — no randomness, per the engine's ground rules.
 *
 * Canonicalise before hashing: Postgres jsonb does not preserve object key
 * order, so a cart saved as `{quantity, plate}` can reload as `{plate,
 * quantity}`. JSON.stringify would then disagree with the token embedded in
 * the Confirm button even though nothing the customer cares about changed
 * (observed on multi-truck pickup confirms).
 */
const cartToken = (cart) => {
  const trucks = (cart.trucks || []).map((t) => [String(t.plate || ""), Number(t.quantity) || 0]);
  const key = JSON.stringify([
    String(cart.depotId ?? ""),
    String(cart.productId ?? ""),
    Number(cart.quantity) || 0,
    String(cart.companyName || ""),
    String(cart.deliveryType || ""),
    trucks,
    String(cart.address || ""),
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
};

// ------------------------------------------------------------------- prompts

/** The question a state asks — reused on entry, resume and re-prompt. */
const promptFor = (state, session, context) => {
  const cart = session.cart || {};
  switch (state) {
    case STATES.IDENTIFY:
      return [text(copy.identifyPrompt())];
    case STATES.MENU:
      return [menuReply(session, context)];
    case STATES.DEPOT:
      return [depotList(cart, context)];
    case STATES.PRODUCT: {
      const depot = findDepot(context, cart.depotId);
      if (!depot || productsOf(depot).length === 0) return [depotList({}, context)];
      return [
        list(
          copy.productPrompt(depot.name),
          copy.productListButton(),
          productsOf(depot).map((p) => ({
            id: `product:${p.id}`,
            title: p.name,
            description: copy.productRowDescription(p.price),
          }))
        ),
      ];
    }
    case STATES.QUANTITY: {
      const depot = findDepot(context, cart.depotId);
      const product = findProduct(depot, cart.productId);
      if (!depot || !product) return [depotList({}, context)];
      return [text(copy.quantityPrompt(product.name, depot.name))];
    }
    case STATES.COMPANY:
      return [text(copy.companyPrompt())];
    case STATES.COLLECT:
      return [buttons(copy.collectPrompt(), copy.collectButtons())];
    case STATES.LOGISTICS: {
      if (cart.deliveryType === "delivery") return [text(copy.addressPrompt())];
      // Choice first: declare now, or leave plates for the gate.
      if (!isDeclaringTrucks(cart)) {
        return [buttons(copy.truckDeclarePrompt(), copy.truckDeclareButtons())];
      }
      const q = Number(cart.quantity) || 0;
      // Single truck is implicit when the whole order fits in one.
      if (q <= TRUCK_CAPACITY_LITRES) return [declarePrompt(copy.platePrompt(1, 1, q))];
      if (!cart.truckCount)
        return [declarePrompt(copy.truckCountPrompt(q, minTrucksFor(q), maxTrucksFor(q)))];
      const trucks = cart.trucks || [];
      const index = trucks.length + 1;
      const remaining = q - litresAssigned(cart);
      if (cart.currentLitres)
        return [declarePrompt(copy.platePrompt(index, cart.truckCount, cart.currentLitres))];
      if (index === cart.truckCount)
        return [declarePrompt(copy.lastTruckPrompt(cart.truckCount, remaining))];
      return [declarePrompt(copy.truckLitresPrompt(index, cart.truckCount, remaining))];
    }
    case STATES.CONFIRM:
      return [confirmReply(session, context)];
    case STATES.EXPECTED_PAYMENT:
      return [buttons(copy.expectedPaymentPrompt(), copy.expectedPaymentButtons())];
    case STATES.AWAIT_PAYMENT: {
      if (!cart.awaiting) return [text(copy.helpText())];
      return [buttons(copy.awaitPaymentNudge(cart.awaiting), awaitPaymentButtonDefs(cart, context))];
    }
    default:
      return [menuReply(session, context)];
  }
};

/**
 * The buttons on an unpaid order. Cancel only, now.
 *
 * "Pay now" used to settle the order from the customer's wallet balance. It is
 * gone with the rest of the wallet payment path (db/migrations/0021): an order
 * is confirmed by the finance desk against the bank statement line that paid
 * for it, so there is nothing for a customer to tap — the transfer itself is
 * the action, and the confirmation follows it.
 *
 * The button did more harm than the convenience was worth even before that. It
 * invited a tap the moment a transfer was sent, which either failed for want
 * of a recorded deposit or succeeded against unrelated balance and left the
 * finance report unable to say which payment had settled which order.
 */
const awaitPaymentButtonDefs = (cart, context) => ({
  cancelorder: copy.awaitPaymentCancelButton(),
});

const cancelOrderConfirmReply = (session) =>
  buttons(copy.cancelOrderConfirm(session.cart.awaiting?.orderNumber), copy.cancelOrderButtons());

/** Which link rows this deployment offers: unset env → no row, no dead taps. */
const linkTargets = (context) => ({
  website: context.websiteUrl,
  community: context.communityUrl,
  support: context.supportWaUrl,
  app: context.appDownloadUrl,
});

/** Main menu. Optional `body` replaces the usual greeting (e.g. post-signup welcome). */
const menuReply = (session, context, body) => {
  const name = context.customer ? context.customer.name : null;
  if (depotsOf(context).length === 0) {
    return buttons(copy.noStockAnywhere(), { track: copy.menuButtons().track, help: "Help" });
  }
  const b = copy.menuButtons();
  const rows = [{ id: "order", title: b.order }];
  if (context.lastOrder) {
    // An UNPAID last order is not reorder material — it's an open tab. Offer
    // to finish (or cancel) it instead of quietly duplicating it.
    const last = context.lastOrder;
    rows.push(
      last.status === "Pending"
        ? { id: "paylast", ...copy.payLastRow(last) }
        : { id: "reorder", ...copy.reorderRow(last) }
    );
  }
  rows.push({ id: "prices", title: b.prices });
  // Track is contextual too — a customer with no orders has nothing to track.
  if (context.lastOrder) rows.push({ id: "track", title: b.track });
  const targets = linkTargets(context);
  const labels = copy.linkRows();
  for (const key of Object.keys(targets)) {
    if (targets[key]) rows.push({ id: key, ...labels[key] });
  }
  return list(body || copy.menuGreeting(name), "Menu", rows);
};

// ------------------------------------------------------------------- track

/** One order's status, with the portal a tap away when it is configured. */
const trackStatusReply = (order, ctx) =>
  ctx.portalUrl
    ? cta(copy.trackStatus(order), copy.trackPortalButton(), ctx.portalUrl)
    : text(copy.trackStatus(order));

const trackReply = (ctx) => {
  const open = ctx.openOrders || [];
  if (open.length === 1) return trackStatusReply(open[0], ctx);
  if (open.length > 1) {
    return list(
      copy.trackListPrompt(),
      copy.trackListButton(),
      open.map((o) => ({ id: `trackorder:${o.id}`, ...copy.trackRow(o) }))
    );
  }
  // Nothing in flight: the last order's outcome, or a first-order nudge.
  if (ctx.lastOrder) return trackStatusReply(ctx.lastOrder, ctx);
  return text(copy.trackNoOrder());
};

const trackOrderReply = (ctx, rawId) => {
  const id = Number(rawId);
  const open = ctx.openOrders || [];
  const order = open.find((o) => Number(o.id) === id)
    || (ctx.lastOrder && Number(ctx.lastOrder.id) === id ? ctx.lastOrder : null);
  // A stale row (order closed since the list was sent) gets an honest answer.
  return order ? trackStatusReply(order, ctx) : text(copy.trackOrderGone());
};

const orderableDepots = (context) => depotsOf(context).filter((d) => productsOf(d).length > 0);

const statesOf = (context) => [
  ...new Set(orderableDepots(context).map((d) => String(d.state || "Other"))),
];

/** Page a row set: whole list when it fits, else a slice + "More ▸" (wraps). */
const pageRows = (rows, page, extraRows = []) => {
  if (rows.length + extraRows.length <= LIMITS.MAX_LIST_ROWS) {
    return [...rows, ...extraRows];
  }
  const perPage = LIMITS.MAX_LIST_ROWS - extraRows.length - 1; // room for More ▸
  const pages = Math.ceil(rows.length / perPage);
  const current = ((Number(page) || 0) % pages + pages) % pages; // wraps, never strands
  const slice = rows.slice(current * perPage, current * perPage + perPage);
  const more = copy.moreRow();
  return [...slice, { id: "more", title: more.title, description: more.description }, ...extraRows];
};

/**
 * Depot browsing, grouped by state: more than one state → pick the state
 * first, then a depot within it (with "⬅ Change state" to hop back). A single
 * state skips the grouping entirely. cart.region holds the choice; cart.page
 * pages whichever list is showing.
 */
const depotList = (cart, context) => {
  const depots = orderableDepots(context);
  if (depots.length === 0) {
    // Nothing orderable anywhere — say so rather than render an empty list.
    return buttons(copy.noStockAnywhere(), { track: copy.menuButtons().track, help: "Help" });
  }
  const states = statesOf(context);
  const region = states.length === 1 ? states[0] : cart.region;

  if (!region || !states.includes(region)) {
    const rows = states.map((s) => ({
      id: `state:${s}`,
      title: s,
      description: copy.stateRowDescription(depots.filter((d) => String(d.state || "Other") === s).length),
    }));
    return list(copy.stateListPrompt(), copy.stateListButton(), pageRows(rows, cart.page));
  }

  const rows = depots
    .filter((d) => String(d.state || "Other") === region)
    .map((d) => ({ id: `depot:${d.id}`, title: d.name }));
  const back = states.length > 1 ? [{ id: "states", ...copy.changeStateRow() }] : [];
  return list(
    copy.depotPrompt(states.length > 1 ? region : null),
    copy.depotListButton(),
    pageRows(rows, cart.page, back)
  );
};

const confirmReply = (session, context) => {
  const cart = session.cart || {};
  const depot = findDepot(context, cart.depotId);
  const product = findProduct(depot, cart.productId);
  if (!depot || !product) {
    // Context shifted under the cart (price pulled, stock gone) — re-pick.
    return depotList({}, context);
  }
  const total = (Number(product.price) || 0) * (Number(cart.quantity) || 0);
  let body = copy.confirmSummary({
    productName: product.name,
    quantity: cart.quantity,
    depotName: depot.name,
    companyName: cart.companyName,
    deliveryType: cart.deliveryType,
    unitPrice: product.price,
    total,
    trucks: cart.trucks || [],
    address: cart.address,
  });
  // A wallet that covers the order pays it instantly inside placeOrder — say
  // so BEFORE the tap, so "already paid" never reads as a surprise.
  const balance = Number(context.customer?.balance) || 0;
  if (total > 0 && balance >= total) {
    body += `\n\n${copy.confirmWalletHint(balance)}`;
  }
  const b = copy.confirmButtons();
  // The confirm id fingerprints the cart this summary describes.
  return buttons(body, {
    [`confirm:${cartToken(cart)}`]: b.confirm,
    edit: b.edit,
    cancel: b.cancel,
  });
};

// --------------------------------------------------------------------- reduce

const reduce = (session, inbound, context) => {
  // Totality: whatever arrives, work with a well-formed view of it.
  const s = session && typeof session === "object" ? session : {};
  const inb = inbound && typeof inbound === "object" ? inbound : { type: INBOUND.UNSUPPORTED };
  const ctx = context && typeof context === "object" ? context : {};
  const state = Object.values(STATES).includes(s.state) ? s.state : STATES.MENU;
  const base = {
    waPhone: s.waPhone,
    customerId: s.customerId,
    state,
    cart: s.cart && typeof s.cart === "object" ? { ...s.cart } : emptyCart(),
    lastOrderId: s.lastOrderId,
    failureCount: Number(s.failureCount) || 0,
  };

  const result = reduceInner(base, inb, ctx, Boolean(s.expired));
  return { ...result, replies: gateReplies(result.replies, ctx) };
};

/** Outside the 24-hour window, only approved templates may leave. */
const gateReplies = (replies, ctx) => {
  if (ctx.withinServiceWindow !== false) return replies;
  return replies.map((r) =>
    r.kind === REPLY.TEMPLATE ? r : template(TEMPLATES.ORDER_UPDATE, { body: r.body || "" })
  );
};

/**
 * Drop undefined-valued keys, recursively. The session persists as jsonb, and
 * JSON has no undefined — a key that would vanish in storage must not exist
 * in the returned object either, or "what we returned" and "what we stored"
 * silently disagree.
 */
const deepCompact = (value) => {
  if (Array.isArray(value)) return value.map(deepCompact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = deepCompact(v);
    }
    return out;
  }
  return value;
};

const done = (session, replies, effects = []) => ({
  session: deepCompact(session),
  replies,
  effects,
});

/** A successful transition: new state, prompt for it, failure counter reset. */
const goTo = (session, state, ctx, leadReplies = [], effects = []) => {
  const next = { ...session, state, failureCount: 0 };
  return done(next, [...leadReplies, ...promptFor(state, next, ctx)], effects);
};

/** An unparseable input: count it; the third offers the menu instead. */
const fumble = (session, ctx, replies) => {
  const failureCount = session.failureCount + 1;
  const next = { ...session, failureCount };
  if (failureCount >= MAX_FAILURES && next.state !== STATES.IDENTIFY) {
    return done({ ...next, failureCount: 0 }, [
      buttons(copy.threeStrikes(), copy.threeStrikesButtons()),
    ]);
  }
  return done(next, replies);
};

const reduceInner = (session, inbound, ctx, expired) => {
  // 1. Outcomes of effects and payments re-enter here, whatever the state.
  switch (inbound.type) {
    case INBOUND.CUSTOMER_CREATED: {
      const customer = inbound.customer || {};
      const next = {
        ...session,
        customerId: customer.id,
        state: STATES.MENU,
        cart: emptyCart(),
        failureCount: 0,
      };
      // One list: welcome is the body, menu rows attached. context.customer
      // may not be loaded this turn — greet from the payload.
      return done(next, [
        menuReply(next, { ...ctx, customer }, copy.welcome(customer.name || "")),
      ]);
    }
    case INBOUND.ORDER_CREATED: {
      const order = inbound.order || {};
      // A covering wallet balance pays the order inside placeOrder itself —
      // it arrives here already Paid. Nothing to await, nothing to transfer.
      const paidFromWallet = order.paymentStatus === "Paid";
      const next = {
        ...session,
        state: paidFromWallet ? STATES.MENU : STATES.EXPECTED_PAYMENT,
        lastOrderId: order.id,
        failureCount: 0,
        cart: paidFromWallet
          ? emptyCart()
          : {
            awaiting: {
              orderNumber: order.orderNumber,
              totalAmount: order.totalAmount,
              virtualAccountBank: order.virtualAccountBank,
              virtualAccountNumber: order.virtualAccountNumber,
              expiresAt: order.expiresAt,
            },
          },
      };
      const replies = [];
      if (order.invoiceUrl) {
        replies.push(
          document(order.invoiceUrl, `invoice-${order.orderNumber}.pdf`, copy.invoiceCaption(order.orderNumber))
        );
      }
      if (paidFromWallet) {
        replies.push(text(copy.orderPaidWallet(order)));
      } else {
        // One message, not two: the order + payment-account details ARE the
        // body of the Pay now / Cancel buttons, so the "how to pay" copy and
        // the buttons that action it can't drift apart or repeat each other.
        replies.push(buttons(copy.orderCreated(order), awaitPaymentButtonDefs(next.cart, ctx)));
        // Then, separately, who is sending it. Its own message because it is
        // its own question with its own buttons — folded into the one above,
        // the account details and the ask would compete for the same tap.
        replies.push(buttons(copy.expectedPaymentPrompt(), copy.expectedPaymentButtons()));
      }
      if (order.deliveryType === "pickup" && ctx.portalUrl) {
        replies.push(text(copy.portalManageHint(ctx.portalUrl)));
      }
      return done(next, replies);
    }
    case INBOUND.ORDER_FAILED: {
      const cart = { ...session.cart };
      delete cart.pendingOrder;
      const next = { ...session, cart };
      if (inbound.reason === "stock") {
        const stock = Number(inbound.stock) || 0;
        const depot = findDepot(ctx, cart.depotId);
        const depotName = depot ? depot.name : "that depot";
        if (stock > 0) {
          return goTo({ ...next, cart: clearQuantity(cart) }, STATES.QUANTITY, ctx, [
            text(copy.orderFailedStock(true, depotName)),
          ]);
        }
        return goTo({ ...next, cart: clearDepot(cart) }, STATES.DEPOT, ctx, [
          text(copy.orderFailedStock(false, depotName)),
        ]);
      }
      if (inbound.reason === "cancel") {
        // The cancel was refused (already moved on) — stay put, say so.
        return done(session, [
          text(copy.cancelFailed(ctx.supportPhone || "our support line")),
          ...promptFor(session.state, session, ctx),
        ]);
      }
      if (inbound.reason === "pay") {
        // Wallet payment failed (usually the balance dropped after the button
        // was shown). The order still stands — keep it in AWAIT_PAYMENT and
        // point at the transfer path.
        return done(session, [
          text(copy.payFailed(inbound.message)),
          ...promptFor(STATES.AWAIT_PAYMENT, session, ctx),
        ]);
      }
      if (inbound.reason === "expired") {
        // The payment window closed — order is Expired. Leave AWAIT_PAYMENT
        // and offer reorder / place new so they aren't stuck on Pay now.
        const next = { ...session, state: STATES.MENU, cart: emptyCart(), failureCount: 0 };
        return done(next, [
          buttons(copy.orderExpired(), copy.orderExpiredButtons()),
        ]);
      }
      return done({ ...next, state: STATES.CONFIRM }, [
        text(copy.orderFailedGeneric(ctx.supportPhone || "our support line")),
        confirmReply(next, ctx),
      ]);
    }
    case INBOUND.ORDER_CANCELLED: {
      const order = inbound.order || {};
      const next = { ...session, state: STATES.MENU, cart: emptyCart(), failureCount: 0 };
      return done(next, [text(copy.orderCancelled(order)), menuReply(next, ctx)]);
    }
    case INBOUND.PAYMENT_CONFIRMED: {
      const order = inbound.order || {};
      const next = { ...session, state: STATES.MENU, cart: emptyCart(), failureCount: 0 };
      if (ctx.withinServiceWindow === false) {
        return done(next, [template(TEMPLATES.PAYMENT_RECEIVED, { orderNumber: order.orderNumber || "" })]);
      }
      return done(next, [text(copy.paymentConfirmed(order))]);
    }
    default:
      break;
  }

  // 2. Nobody orders without an identity; nobody Inactive orders at all.
  if (!ctx.customer && session.state !== STATES.IDENTIFY) {
    return goTo({ ...session, cart: emptyCart() }, STATES.IDENTIFY, ctx);
  }
  if (ctx.customer && ctx.customer.status && ctx.customer.status !== "Active") {
    return done(session, [text(copy.inactiveCustomer(ctx.supportPhone || "our support line"))]);
  }

  // 3. Media we cannot read is a real case with a real reply, not a crash.
  if (!isUserInput(inbound)) {
    return fumble(session, ctx, [
      text(copy.unsupportedType()),
      ...promptFor(session.state, session, ctx),
    ]);
  }

  const value = valueOf(inbound);

  // 4. Global commands beat state — one word that always works.
  //
  // With ONE exception: while a customer is still nameless (IDENTIFY), the
  // menu/cancel escapes lead nowhere real — every menu action needs an
  // identity, so "hi" would bounce them to a menu that snaps straight back
  // here on the next tap (observed in UAT as "it keeps re-introducing
  // itself"). Greetings during IDENTIFY just get the name question, warmly.
  const nameless = session.state === STATES.IDENTIFY && !ctx.customer;
  // "menu" is the deliberate reset and always wins. The greeting words
  // ("hi"/"hello"/"start") normally open the menu too, but NOT when a cart is
  // being built — a stray or post-outage-redelivered greeting must not blow away
  // a half-finished order. There, we absorb it and re-show the current step.
  // Once the cart has timed out, though, fall through to the resume offer:
  // "hi" after 30+ minutes idle is how people re-engage, not a stray tap.
  const explicitMenu = value === "menu";
  const greeting = COMMANDS.MENU.includes(value) && !explicitMenu;
  const buildingOrder =
    ORDER_BUILDING_STATES.has(session.state) && Object.keys(session.cart).length > 0;
  if (explicitMenu || (greeting && !buildingOrder)) {
    if (nameless) return done(session, [text(copy.identifyGreeting())]);
    return goTo(session, STATES.MENU, ctx);
  }
  if (greeting && buildingOrder && !expired) {
    return done(session, promptFor(session.state, session, ctx));
  }
  if (COMMANDS.CANCEL.includes(value)) {
    if (nameless) return done(session, [text(copy.identifyGreeting())]);
    // In AWAIT_PAYMENT there is no cart to discard — there is a REAL unpaid
    // order. "cancel" means cancelling that, which deserves a confirmation.
    if (
      (session.state === STATES.AWAIT_PAYMENT || session.state === STATES.EXPECTED_PAYMENT) &&
      session.lastOrderId
    ) {
      return done(session, [cancelOrderConfirmReply(session)]);
    }
    return goTo({ ...session, cart: emptyCart() }, STATES.MENU, ctx, [text(copy.cancelled())]);
  }
  if (COMMANDS.HELP.includes(value)) {
    return done(session, [text(copy.helpText())]);
  }
  if (COMMANDS.TRACK.includes(value)) {
    // Status in chat, state untouched: one open order answers directly, more
    // than one offers a picker, none falls back to the last order's outcome.
    return done(session, [trackReply(ctx)]);
  }
  if (value.startsWith("trackorder:")) {
    // A picker row — global like `track` itself, so a tap on yesterday's list
    // still answers after the session moved on. Never a fumble.
    return done(session, [trackOrderReply(ctx, value.slice("trackorder:".length))]);
  }
  if (value === "retry") {
    // The three-strikes "Try again" button: re-ask, with the slate clean.
    const next = { ...session, failureCount: 0 };
    return done(next, promptFor(session.state, next, ctx));
  }

  // 5. A timed-out cart is offered back, not silently dropped.
  if (expired && Object.keys(session.cart).length > 0 && !session.cart.resumeState) {
    const depot = findDepot(ctx, session.cart.depotId);
    const product = findProduct(depot, session.cart.productId);
    const next = {
      ...session,
      state: STATES.MENU,
      cart: { ...session.cart, resumeState: session.state },
    };
    return done(next, [
      buttons(
        copy.expiredResume({
          productName: product ? product.name : undefined,
          quantity: session.cart.quantity,
          depotName: depot ? depot.name : undefined,
        }),
        copy.resumeButtons()
      ),
    ]);
  }
  if (session.cart.resumeState) {
    if (value === "resume") {
      const { resumeState, ...stale } = session.cart;
      const { cart, lead } = revalidateCart(stale, ctx);
      return goTo({ ...session, cart }, nextStep(cart), ctx, lead);
    }
    if (value === "startover") {
      return goTo({ ...session, cart: emptyCart() }, STATES.MENU, ctx);
    }
  }

  // 6. The state switch.
  switch (session.state) {
    case STATES.IDENTIFY:
      return handleIdentify(session, inbound, ctx, value);
    case STATES.MENU:
      return handleMenu(session, ctx, value);
    case STATES.DEPOT:
      return handleDepot(session, ctx, value);
    case STATES.PRODUCT:
      return handleProduct(session, ctx, value);
    case STATES.QUANTITY:
      return handleQuantity(session, inbound, ctx, value);
    case STATES.COMPANY:
      return handleCompany(session, inbound, ctx);
    case STATES.COLLECT:
      return handleCollect(session, ctx, value);
    case STATES.LOGISTICS:
      return handleLogistics(session, inbound, ctx);
    case STATES.CONFIRM:
      return handleConfirm(session, ctx, value);
    case STATES.EXPECTED_PAYMENT:
      return handleExpectedPayment(session, inbound, ctx, value);
    case STATES.AWAIT_PAYMENT:
      return handleAwaitPayment(session, ctx, value);
    default:
      return goTo(session, STATES.MENU, ctx);
  }
};

/**
 * Collecting who is paying, one depositor per message.
 *
 * Entries accumulate on the cart and are written in a SINGLE effect when the
 * customer taps Done — not one row per message. A chat that stalls halfway
 * leaves no half-declared order behind, and the desk never sees a partial
 * split it might read as the whole story.
 *
 * Every exit lands in AWAIT_PAYMENT, which re-shows the account and the cancel
 * button. Skipping and finishing with nothing said are the same outcome: the
 * step is optional and an order is never held up by it.
 */
const handleExpectedPayment = (session, inbound, ctx, value) => {
  const cart = session.cart || {};
  const entries = Array.isArray(cart.expected) ? cart.expected : [];
  const withoutEntries = { ...cart };
  delete withoutEntries.expected;

  // Typed as readily as tapped. The buttons carry these two words, and a
  // customer who writes what the button says means what the button means —
  // without this, "done" falls through and is read as a failed split.
  const isSkip = value === "expectskip" || value === "skip" || value === "none";
  const isDone = value === "expectdone" || value === "done" || value === "finished";

  if (isSkip || (isDone && entries.length === 0)) {
    return goTo({ ...session, cart: withoutEntries }, STATES.AWAIT_PAYMENT, ctx, [
      text(copy.expectedPaymentSkipped()),
    ]);
  }

  if (isDone) {
    return goTo(
      { ...session, cart: withoutEntries },
      STATES.AWAIT_PAYMENT,
      ctx,
      [text(copy.expectedPaymentSaved(entries.length))],
      [
        {
          type: EFFECTS.NOTE_EXPECTED_PAYMENTS,
          payload: {
            orderId: session.lastOrderId,
            customerId: session.customerId,
            entries,
          },
        },
      ]
    );
  }

  const retryButtons = (body) => buttons(body, copy.expectedPaymentButtons());

  // The RAW text, not the lower-cased command value: this name is read back to
  // a human against a bank statement, and "rure oil and gas" is not what the
  // narration will say. Buttons above still match on the normalised value.
  const raw = typeof inbound.value === "string" ? inbound.value.trim() : "";
  if (inbound.type !== INBOUND.TEXT) {
    return fumble(session, ctx, [retryButtons(copy.expectedPaymentUnparsed())]);
  }

  const split = parseExpectedSplit(raw);
  if (!split) return fumble(session, ctx, [retryButtons(copy.expectedPaymentUnparsed())]);
  if (!Number.isFinite(split.amount)) {
    return fumble(session, ctx, [retryButtons(copy.expectedPaymentBadAmount())]);
  }
  if (!split.name) return fumble(session, ctx, [retryButtons(copy.expectedPaymentUnparsed())]);

  // At the cap the entry is refused rather than silently dropped — the reply
  // says so and Done is the only way on.
  if (entries.length >= MAX_EXPECTED_PAYMENTS) {
    return done(session, [
      retryButtons(copy.expectedPaymentAdded(split.amount, split.name, 0)),
    ]);
  }

  const nextEntries = [...entries, { amount: split.amount, name: split.name }];
  const next = {
    ...session,
    cart: { ...cart, expected: nextEntries },
    failureCount: 0,
  };
  return done(next, [
    retryButtons(
      copy.expectedPaymentAdded(split.amount, split.name, MAX_EXPECTED_PAYMENTS - nextEntries.length)
    ),
  ]);
};

const handleAwaitPayment = (session, ctx, value) => {
  // "Pay now" is no longer offered (see awaitPaymentButtonDefs), but a session
  // that rendered the old buttons can still deliver the tap. Answer it with the
  // transfer instructions rather than an unknown-input fallthrough.
  if (value === "paynow" && session.lastOrderId) {
    return done(session, [text(copy.payNowWithdrawn())]);
  }
  // Cancelling an unpaid order: confirm first, then a real effect.
  if (value === "cancelorder" && session.lastOrderId) {
    return done(session, [cancelOrderConfirmReply(session)]);
  }
  if (value === "cancelorder:yes" && session.lastOrderId) {
    return done(
      session,
      [],
      [
        {
          type: EFFECTS.CANCEL_ORDER,
          payload: { orderId: session.lastOrderId, customerId: session.customerId },
        },
      ]
    );
  }
  if (value === "keeporder") {
    return done(session, promptFor(STATES.AWAIT_PAYMENT, session, ctx));
  }
  return done(session, promptFor(STATES.AWAIT_PAYMENT, session, ctx));
};

// ------------------------------------------------------------ state handlers

const handleIdentify = (session, inbound, ctx, value) => {
  if (session.cart.pendingCustomer) {
    return done(session, [text(copy.orderPending())]);
  }
  const name = typeof inbound.value === "string" ? inbound.value.trim() : "";
  if (inbound.type === INBOUND.TEXT && isPlausibleName(name)) {
    const next = { ...session, cart: { pendingCustomer: true } };
    return done(next, [], [
      { type: EFFECTS.CREATE_CUSTOMER, payload: { name, waPhone: session.waPhone } },
    ]);
  }
  // No menu escape hatch here — there is nothing a nameless menu can do.
  return done({ ...session, failureCount: session.failureCount + 1 }, [
    text(copy.identifyInvalidName()),
  ]);
};

const handleMenu = (session, ctx, value) => {
  if (value === "order") {
    if (depotsOf(ctx).length === 0) {
      return done(session, [text(copy.noStockAnywhere())]);
    }
    return goTo({ ...session, cart: emptyCart() }, STATES.DEPOT, ctx);
  }
  if (value === "prices") {
    return done(session, [pricesReply(ctx)]);
  }
  if (value === "paylast" && ctx.lastOrder && ctx.lastOrder.status === "Pending") {
    // Re-open the unpaid order: back to AWAIT_PAYMENT with its details, where
    // the payment nudge, the cancel option (and the dev button) all live.
    const last = ctx.lastOrder;
    const next = {
      ...session,
      lastOrderId: last.id,
      cart: {
        awaiting: {
          orderNumber: last.orderNumber,
          totalAmount: last.totalAmount,
          virtualAccountBank: last.virtualAccountBank,
          virtualAccountNumber: last.virtualAccountNumber,
          expiresAt: last.expiresAt,
        },
      },
    };
    return goTo(next, STATES.AWAIT_PAYMENT, ctx);
  }
  const links = linkTargets(ctx);
  if (links[value]) {
    // Stay in MENU — the link message is a leaf, not a state.
    const c = copy.linkCtas()[value];
    return done(session, [cta(c.body, c.button, links[value])]);
  }
  if (value === "reorder" && ctx.lastOrder) {
    const last = ctx.lastOrder;
    const depot = findDepot(ctx, last.depotId);
    const product = findProduct(depot, last.productId);
    // Depot and product must still exist; their stock level must not — see the
    // quantity handler. A reorder failing on stock sent the customer back to
    // depot selection with "unavailable", which was never true of the depot.
    if (!depot || !product) {
      return goTo({ ...session, cart: emptyCart() }, STATES.DEPOT, ctx, [
        text(copy.depotUnavailable()),
      ]);
    }
    const cart = {
      depotId: last.depotId,
      productId: last.productId,
      quantity: last.quantity,
      deliveryType: last.deliveryType,
    };
    return goTo({ ...session, cart }, nextStep(cart), ctx);
  }
  return fumble(session, ctx, [menuReply(session, ctx)]);
};

const pricesReply = (ctx) => {
  const depots = orderableDepots(ctx);
  if (depots.length === 0) return text(copy.noStockAnywhere());
  const states = statesOf(ctx);
  let body = copy.pricesHeader();
  for (const stateName of states) {
    // A single-state operation needs no geography headers.
    if (states.length > 1) body += copy.pricesStateHeader(stateName);
    for (const depot of depots.filter((d) => String(d.state || "Other") === stateName)) {
      const parts = productsOf(depot).map((p) => copy.pricesProductPart(p.name, p.price));
      if (parts.length > 0) body += copy.pricesDepotLine(depot.name, parts);
    }
  }
  return text(body + copy.pricesFooter());
};

const handleDepot = (session, ctx, value) => {
  if (value === "more") {
    const cart = { ...session.cart, page: (Number(session.cart.page) || 0) + 1 };
    return done({ ...session, cart, failureCount: 0 }, [depotList(cart, ctx)]);
  }
  if (value === "states") {
    const { region, page, ...rest } = session.cart;
    return done({ ...session, cart: rest, failureCount: 0 }, [depotList(rest, ctx)]);
  }
  const states = statesOf(ctx);
  const pickedState = value.startsWith("state:")
    ? value.slice("state:".length)
    : states.find((s) => s.toLowerCase() === value);
  // Meta echoes list-row ids verbatim (case preserved); typed names match too.
  const region = states.find((s) => s.toLowerCase() === String(pickedState).toLowerCase());
  if (region) {
    const cart = { ...session.cart, region, page: 0 };
    return done({ ...session, cart, failureCount: 0 }, [depotList(cart, ctx)]);
  }
  const id = value.startsWith("depot:") ? value.slice("depot:".length) : null;
  const depot = id
    ? findDepot(ctx, id)
    : depotsOf(ctx).find((d) => String(d.name).toLowerCase() === value);
  if (depot) {
    const cart = { ...clearDepot(session.cart), depotId: depot.id };
    return goTo({ ...session, cart }, nextStep(cart), ctx);
  }
  return fumble(session, ctx, [depotList(session.cart, ctx)]);
};

const handleProduct = (session, ctx, value) => {
  const depot = findDepot(ctx, session.cart.depotId);
  if (!depot) {
    // Depot vanished from context (price pulled, stock gone) — re-pick.
    return goTo({ ...session, cart: clearDepot(session.cart) }, STATES.DEPOT, ctx, [
      text(copy.depotUnavailable()),
    ]);
  }
  const id = value.startsWith("product:") ? value.slice("product:".length) : null;
  const product = id
    ? findProduct(depot, id)
    : productsOf(depot).find((p) => String(p.name).toLowerCase() === value);
  if (product) {
    const cart = { ...clearProduct(session.cart), productId: product.id };
    return goTo({ ...session, cart }, nextStep(cart), ctx);
  }
  return fumble(session, ctx, [
    text(copy.productUnavailable(depot.name)),
    ...promptFor(STATES.PRODUCT, session, ctx),
  ]);
};

const handleQuantity = (session, inbound, ctx, value) => {
  const depot = findDepot(ctx, session.cart.depotId);
  const product = findProduct(depot, session.cart.productId);
  if (!depot || !product) {
    return goTo({ ...session, cart: clearDepot(session.cart) }, STATES.DEPOT, ctx, [
      text(copy.depotUnavailable()),
    ]);
  }

  // The over-stock reply offers this button; typing a smaller number works too.
  if (value === "changedepot") {
    return goTo({ ...session, cart: clearDepot(session.cart) }, STATES.DEPOT, ctx);
  }

  const qty = parseLitres(inbound.value);
  if (Number.isNaN(qty) || qty <= 0) {
    return fumble(session, ctx, [text(copy.quantityInvalid())]);
  }
  if (qty < MIN_ORDER_LITRES) {
    return fumble(session, ctx, [text(copy.quantityBelowMin(MIN_ORDER_LITRES))]);
  }
  if (qty > MAX_ORDER_LITRES) {
    return fumble(session, ctx, [text(copy.quantityAboveCap(MAX_ORDER_LITRES))]);
  }
  /**
   * No stock cap here, deliberately.
   *
   * A depot with no active PFI reports stock 0, so this refused EVERY quantity
   * — the customer browsed to the depot, picked the product, typed a number
   * and was bounced, with copy that deliberately does not say why. Being
   * dead-ended without explanation is worse than the depot not being listed.
   *
   * The website and the mobile app already sell without this check; leaving it
   * on WhatsApp alone meant the same order succeeded or failed depending on
   * which client placed it. This is the overselling guard, and removing it is
   * a deliberate trade made with that understood: MIN/MAX_ORDER_LITRES above
   * still bound the order, and release is still gated downstream, where stock
   * is actually reserved against a PFI.
   */
  const cart = { ...clearQuantity(session.cart), quantity: qty };
  return goTo({ ...session, cart }, nextStep(cart), ctx);
};

const handleCompany = (session, inbound, ctx) => {
  const raw = typeof inbound.value === "string" ? inbound.value.trim() : "";
  if (inbound.type === INBOUND.TEXT && isPlausibleCompany(raw)) {
    const cart = { ...session.cart, companyName: raw };
    return goTo({ ...session, cart }, nextStep(cart), ctx);
  }
  return fumble(session, ctx, [text(copy.companyInvalid())]);
};

const handleCollect = (session, ctx, value) => {
  if (value === "pickup" || value === "delivery") {
    const cart = { ...clearCollect(session.cart), deliveryType: value };
    return goTo({ ...session, cart }, nextStep(cart), ctx);
  }
  return fumble(session, ctx, promptFor(STATES.COLLECT, session, ctx));
};

const handleLogistics = (session, inbound, ctx) => {
  const cart = session.cart;
  if (cart.deliveryType === "delivery") {
    const address = typeof inbound.value === "string" ? inbound.value.trim() : "";
    if (inbound.type === INBOUND.TEXT && address.length >= 10) {
      const next = { ...cart, address };
      return goTo({ ...session, cart: next }, nextStep(next), ctx);
    }
    return fumble(session, ctx, [text(copy.addressInvalid())]);
  }

  const value = valueOf(inbound);

  // Escape / defer: clear any partial split and continue to confirm.
  if (value === "defer_trucks") {
    const next = deferTrucksToGate(cart);
    return goTo({ ...session, cart: next }, nextStep(next), ctx);
  }

  // Opt into declare-now (also re-shown if they fumble the choice).
  if (value === "declare_trucks") {
    const next = startDeclareTrucks(cart);
    return goTo({ ...session, cart: next }, STATES.LOGISTICS, ctx);
  }

  // Still on the declare/defer choice — anything else re-prompts it.
  if (!isDeclaringTrucks(cart)) {
    return fumble(session, ctx, promptFor(STATES.LOGISTICS, session, ctx));
  }

  // Declare-now: how many trucks, litres on each, and each plate. The last
  // truck always takes the exact remainder. "Skip now" stays on
  // every prompt via declarePrompt().
  const q = Number(cart.quantity) || 0;
  const raw = typeof inbound.value === "string" ? inbound.value.trim() : "";
  const plate = raw.toUpperCase();
  const trucks = cart.trucks || [];

  // Single truck implicit: the whole order fits in one.
  if (q <= TRUCK_CAPACITY_LITRES) {
    if (inbound.type === INBOUND.TEXT && isPlausiblePlate(plate)) {
      const next = { ...cart, trucks: [{ quantity: q, plate }] };
      return goTo({ ...session, cart: next }, nextStep(next), ctx);
    }
    return fumble(session, ctx, [declarePrompt(copy.plateInvalid())]);
  }

  // Multi-truck: first, how many trucks?
  if (!cart.truckCount) {
    const n = parseLitres(raw); // reuses the forgiving number parser
    const min = minTrucksFor(q);
    const max = maxTrucksFor(q);
    if (!Number.isNaN(n) && n >= min && n <= max) {
      const next = { ...cart, truckCount: n, trucks: [] };
      return goTo({ ...session, cart: next }, nextStep(next), ctx);
    }
    return fumble(session, ctx, [declarePrompt(copy.truckCountInvalid(min, max))]);
  }

  const remaining = q - litresAssigned(cart);
  const index = trucks.length + 1;

  // A truck's litres are pending — this message should be its plate.
  if (cart.currentLitres) {
    if (inbound.type === INBOUND.TEXT && isPlausiblePlate(plate)) {
      const { currentLitres, ...restCart } = cart;
      const next = { ...restCart, trucks: [...trucks, { quantity: currentLitres, plate }] };
      return goTo({ ...session, cart: next }, nextStep(next), ctx);
    }
    return fumble(session, ctx, [declarePrompt(copy.plateInvalid())]);
  }

  // The last truck takes the remainder — only its plate is asked.
  if (index === cart.truckCount) {
    if (inbound.type === INBOUND.TEXT && isPlausiblePlate(plate)) {
      const next = { ...cart, trucks: [...trucks, { quantity: remaining, plate }] };
      return goTo({ ...session, cart: next }, nextStep(next), ctx);
    }
    return fumble(session, ctx, [declarePrompt(copy.plateInvalid())]);
  }

  // Otherwise: this truck's litres. Must fit the truck, and leave the
  // remaining trucks a workable share (≥1 L each, ≤ capacity each).
  const v = parseLitres(raw);
  const trucksAfter = cart.truckCount - index;
  const valid =
    !Number.isNaN(v) &&
    v >= 1 &&
    v <= TRUCK_CAPACITY_LITRES &&
    remaining - v >= trucksAfter &&
    remaining - v <= trucksAfter * TRUCK_CAPACITY_LITRES;
  if (valid) {
    return goTo({ ...session, cart: { ...cart, currentLitres: v } }, STATES.LOGISTICS, ctx);
  }
  return fumble(session, ctx, [declarePrompt(copy.truckLitresInvalid(remaining))]);
};

const handleConfirm = (session, ctx, value) => {
  const cart = session.cart;

  if (cart.pendingOrder) {
    // The effect is out; a second tap must not order twice.
    return done(session, [text(copy.orderPending())]);
  }

  if (value.startsWith("edit:")) {
    const field = value.slice("edit:".length);
    const cleared =
      field === "depot"
        ? clearDepot(cart)
        : field === "product"
          ? clearProduct(cart)
          : field === "quantity"
            ? clearQuantity(cart)
            : field === "company"
              ? clearCompany(cart)
              : field === "collect"
                ? clearCollect(cart)
                : null;
    if (cleared) {
      return goTo({ ...session, cart: cleared }, nextStep(cleared), ctx);
    }
  }

  if (value === "edit") {
    const rows = copy.editRows();
    return done(session, [
      list(copy.editPrompt(), copy.editListButton(), [
        { id: "edit:depot", title: rows.depot.title },
        { id: "edit:product", title: rows.product.title },
        { id: "edit:quantity", title: rows.quantity.title },
        { id: "edit:company", title: rows.company.title },
        { id: "edit:collect", title: rows.collect.title },
      ]),
    ]);
  }

  if (value === "confirm" || value.startsWith("confirm:")) {
    // A tokened tap must match the CURRENT cart: WhatsApp buttons never
    // expire, and an old summary's Confirm must not commit a cart the
    // customer never saw. A typed "confirm" (no token) means "what's
    // current" and always passes.
    const token = value.startsWith("confirm:") ? value.slice("confirm:".length) : null;
    if (token && token !== cartToken(cart)) {
      return done(session, [text(copy.confirmOutdated()), confirmReply(session, ctx)]);
    }
    const { cart: valid, lead } = revalidateCart(cart, ctx);
    if (valid !== cart || nextStep(valid) !== STATES.CONFIRM) {
      // Context shifted under the cart — walk the missing step, don't fail.
      return goTo({ ...session, cart: valid }, nextStep(valid), ctx, lead);
    }
    const depot = findDepot(ctx, cart.depotId);
    const product = findProduct(depot, cart.productId);
    const payload = {
      customerId: session.customerId,
      state: depot.state,
      depotId: cart.depotId,
      productId: cart.productId,
      quantity: cart.quantity,
      companyName: cart.companyName,
      deliveryType: cart.deliveryType,
    };
    if (cart.deliveryType === "pickup") {
      // truckNumber, not plateNumber: this payload feeds placeOrder verbatim.
      payload.trucks = (cart.trucks || []).map((t) => ({
        truckNumber: t.plate,
        quantity: t.quantity,
      }));
    } else {
      // deliveryAddress — placeOrder's field name, not the cart's "address".
      payload.deliveryAddress = cart.address;
    }
    const next = { ...session, cart: { ...cart, pendingOrder: true } };
    return done(next, [text(copy.orderPending())], [{ type: EFFECTS.CREATE_ORDER, payload }]);
  }

  return fumble(session, ctx, [confirmReply(session, ctx)]);
};

module.exports = {
  reduce,
  // Pure helpers exported for direct unit- and property-testing.
  parseLitres,
  parseExpectedSplit,
  nextStep,
  trucksComplete,
  minTrucksFor,
  maxTrucksFor,
  isPlausiblePlate,
  isPlausibleName,
  isPlausibleCompany,
};
