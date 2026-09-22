/**
 * Every customer-facing string the engine can say, in one reviewable module.
 * The wording IS the product on this channel, so: functions of their
 * variables, no logic beyond formatting, and a snapshot test pins each one —
 * an accidental rewording shows up as a diff in review, not in a customer's
 * chat.
 *
 * Tone (agreed): short, professional, plain. Say the thing and stop. No
 * emojis. The copy used to be written at arm's length — "Please provide the
 * plate number of the truck coming to load", "Would you like to declare your
 * trucks now" — which reads as a form, not as a company you already trade
 * with, and which uses words nobody at Soroman uses.
 *
 * So it says what the desk says. A customer sends TRUCK NUMBERS; he does not
 * "declare plates". He LISTS them. Everything else is trimmed to the sentence
 * that carries the instruction, and the courtesy that survives is the courtesy
 * a busy person actually reads.
 *
 * Support contact arrives as a variable (from SUPPORT_PHONE config) so no
 * real phone number lives in code.
 */

const naira = (amount) =>
  "₦" + Number(amount || 0).toLocaleString("en-NG", { maximumFractionDigits: 2 });

const litres = (qty) => `${Number(qty || 0).toLocaleString("en-NG")} L`;

/** Absolute pay-by time for WhatsApp copy, e.g. "Tue, 12 Aug, 16:42". Always WAT. */
const formatPayBy = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-NG", {
    timeZone: "Africa/Lagos",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
};

/**
 * One line telling the customer how long the price is held.
 *
 * Always an absolute instant, never a duration. Orders lapse at the end of the
 * day they were placed, so "pay within 24 hours" would be wrong for every
 * order but one placed at midnight — and wrong in the customer's favour, which
 * is the expensive direction. No deadline means no line rather than a vague
 * one; a deadline nobody can act on is worse than silence.
 */
const paymentDeadlineLine = ({ expiresAt } = {}) => {
  const until = formatPayBy(expiresAt);
  return until ? `Please pay by *${until}*. After that the price is no longer held.` : null;
};

// ---------------------------------------------------------------- identify

const identifyPrompt = () =>
  "Welcome to Soroman Energy.\n\nPlease send the name to use on your orders.";

const identifyGreeting = () => "Hello. Please send the name to use on your orders.";

const identifyInvalidName = () =>
  "That name is not valid. Please use letters only, between 2 and 60 characters.";

const welcome = (name) =>
  `Thank you, ${name}. Your account has been set up.\n\nWhat would you like to do?`;

// -------------------------------------------------------------------- menu

const menuGreeting = (name) =>
  name ? `Hello ${name}. What would you like to do?` : "Hello. What would you like to do?";

const menuButtons = () => ({
  order: "Place depot order",
  prices: "Check prices",
  track: "Track my order",
});

const reorderRow = (lastOrder) => ({
  title: "Reorder last order",
  description: `${litres(lastOrder.quantity)} ${lastOrder.productName}, ${lastOrder.depotName}`,
});

const payLastRow = (lastOrder) => ({
  title: "Finish payment",
  description: `${lastOrder.orderNumber} is awaiting your transfer`,
});

// Menu rows that open a link. A row only renders when its URL is configured
// (context decides); titles ≤24 chars, CTA button text ≤20 — WhatsApp limits.
const linkRows = () => ({
  website: { title: "Visit our website", description: "Products, depots and news" },
  community: { title: "Join our community", description: "Updates and offers on WhatsApp" },
  support: { title: "Chat with support", description: "We are happy to help" },
  app: { title: "Download mobile app", description: "Order and track on the go" },
});

const linkCtas = () => ({
  website: { body: "All our products, depots and updates are on the website.", button: "Visit website" },
  community: { body: "Join the Soroman community on WhatsApp for updates and offers.", button: "Join community" },
  support: { body: "Our support team is on hand to help.", button: "Chat with support" },
  app: { body: "Get the Soroman app to order and track on the go.", button: "Download the app" },
});

const noStockAnywhere = () =>
  "All depots are out of stock at the moment. Stock is updated through the day, so please check back.";

const inactiveCustomer = (supportPhone) =>
  `Your account is not active, so we cannot take an order now. Please call ${supportPhone}.`;

const helpText = () =>
  "You can use these at any time:\n\n" +
  "• *menu*: back to the main menu\n" +
  "• *track*: check your orders\n" +
  "• *cancel*: cancel the order in progress\n" +
  "• *help*: this message\n\n" +
  "To order, select *Place depot order* from the menu.";

// -------------------------------------------------------------------- track

// Customer-facing names for order statuses. Keys are the order_status enum.
const trackStatusLabel = (status) =>
  ({
    Pending: "Awaiting payment",
    Paid: "Payment received",
    Released: "Released",
    Loading: "Loading",
    Completed: "Completed",
    Cancelled: "Cancelled",
    Expired: "Expired",
  }[status] || String(status || "In progress"));

// What happens next, per status. The status line answers "where is it";
// this line answers "what should I expect or do".
const trackNextStep = (order) => {
  switch (order.status) {
    case "Pending":
      return `We are waiting on ${naira(order.totalAmount)}. Transfer to ${order.virtualAccountBank} ${order.virtualAccountNumber}, then select *Finish payment* from the menu.`;
    case "Paid":
      return "Payment received. Your loading ticket is being prepared, and we will tell you here once your order is released.";
    case "Released":
      return order.deliveryType === "delivery"
        ? "Released and being prepared for delivery."
        : "Released. Your truck can proceed to the depot for loading.";
    case "Loading":
      return order.deliveryType === "delivery"
        ? "Your order is loading for delivery."
        : "Your order is loading at the depot.";
    case "Completed":
      return "This order is complete. Thank you for your patronage.";
    case "Cancelled":
      return "This order was cancelled. Nothing was charged.";
    case "Expired":
      return "Payment did not come in on time, so this order expired. Place a new order at today's price whenever you are ready.";
    default:
      return "We will keep you posted here as your order moves.";
  }
};

const trackStatus = (order) =>
  `Order *${order.orderNumber}*: ${litres(order.quantity)} ${order.productName}, ${order.depotName}.\n\n` +
  `Status: *${trackStatusLabel(order.status)}*\n\n` +
  trackNextStep(order);

const trackPortalButton = () => "View full timeline";

const trackListPrompt = () =>
  "You have more than one order running. Select the one you want to check.";

const trackListButton = () => "Choose an order";

const trackRow = (order) => ({
  title: order.orderNumber,
  description: `${litres(order.quantity)} ${order.productName}, ${order.depotName}. ${trackStatusLabel(order.status)}`,
});

const trackOrderGone = () =>
  "We could not find that order, it may already be complete. Type *track* to see your current orders.";

const trackNoOrder = () =>
  "You have no orders with us yet. Select *Place depot order* from the menu to begin.";

// ------------------------------------------------------------------- prices

const pricesHeader = () => "Today's Prices";

const pricesStateHeader = (stateName) => `\n\n*${stateName}*`;

const pricesDepotLine = (depotName, productParts) => `\n${depotName}: ${productParts.join(", ")}`;

const pricesProductPart = (productName, price) => `${productName} ${naira(price)}/L`;

const pricesFooter = () => "\n\nSelect *Place depot order* when you are ready.";

// -------------------------------------------------------------------- depot

const stateListPrompt = () => "Which state are you ordering from?";

const stateListButton = () => "Choose a state";

const stateRowDescription = (count) => `${count} depot${count === 1 ? "" : "s"}`;

const changeStateRow = () => ({ title: "Change state" });

const depotPrompt = (stateName) =>
  stateName ? `Select a depot in ${stateName}.` : "Which depot are you ordering from?";

const depotListButton = () => "Choose a depot";

const moreRow = () => ({ title: "More", description: "View the next page" });

const depotUnavailable = () =>
  "That depot is not available. Please pick from the depots below.";

// ------------------------------------------------------------------ product

const productPrompt = (depotName) => `Which product do you want at ${depotName}?`;

const productListButton = () => "Choose a product";

const productRowDescription = (price) => `${naira(price)}/L`;

const productUnavailable = (depotName) =>
  `That product is not available at ${depotName}. Please pick from the products below.`;

// ----------------------------------------------------------------- quantity

const quantityPrompt = (productName, depotName) =>
  `How many litres of ${productName} do you want at ${depotName}?`;

const quantityInvalid = () =>
  "Please send the quantity in litres, for example *30000* or *30,000*.";

const quantityBelowMin = (min) =>
  `The minimum order is ${litres(min)}. Please send the number of litres.`;

const quantityAboveCap = (cap) =>
  `That looks too high. The maximum order is ${litres(cap)}. Please send the number of litres.`;

const quantityOverStock = (depotName) =>
  `We cannot supply that quantity at ${depotName} right now. Try a smaller amount, or another depot.`;

const overStockButtons = () => ({
  changeDepot: "Change depot",
  menu: "Back to menu",
});

// ------------------------------------------------------------------ company

const companyPrompt = () => "Which company is this order for?";

const companyInvalid = () =>
  "Please send a valid company name, between 2 and 100 characters.";

// ------------------------------------------------------------------ collect

const collectPrompt = () => "How do you want to receive your order?";

const collectButtons = () => ({ pickup: "Loading by my truck", delivery: "Delivery by Soroman truck" });

// ---------------------------------------------------------------- logistics

// Truck numbers are optional on a pickup: list them now, or leave them for
// security at the gate. Button titles stay ≤20 chars (Cloud API limit).
const truckDeclarePrompt = () =>
  "Do you want to list your truck numbers now, or leave them for security at the gate?";

const truckDeclareButtons = () => ({
  declare_trucks: "List truck numbers",
  defer_trucks: "Skip for now",
});

// Shown on every list-now prompt so a half-finished split can be abandoned.
const truckDeferEscapeButtons = () => ({ defer_trucks: "Skip for now" });

const truckCountPrompt = (quantity, minTrucks, maxTrucks) =>
  `${litres(quantity)} for loading. How many trucks are you sending?\n\nEach truck takes up to ${litres(60000)}, so this quantity needs ${minTrucks === maxTrucks ? minTrucks : `${minTrucks} to ${maxTrucks}`} truck${maxTrucks === 1 ? "" : "s"}.`;

const truckCountInvalid = (minTrucks, maxTrucks) =>
  `Please send a number between ${minTrucks} and ${maxTrucks} for this quantity.`;

const truckLitresPrompt = (index, count, remaining) =>
  `Truck ${index} of ${count}. How many litres will it carry?\n\n${litres(remaining)} left to assign. Each truck takes up to ${litres(60000)}.`;

const truckLitresInvalid = (remaining) =>
  `That quantity does not work. Each truck takes up to ${litres(60000)}, and the other trucks still need an amount. ${litres(remaining)} left to assign.`;

const lastTruckPrompt = (count, remaining) =>
  `Truck ${count} of ${count} takes the remaining ${litres(remaining)}. Send its truck number.`;

const platePrompt = (index, count, litresForTruck) =>
  count > 1
    ? `Truck ${index} of ${count}, ${litres(litresForTruck)}. Send its truck number.`
    : "Send your truck number.";

const plateInvalid = () =>
  "That truck number is not valid. Use letters and numbers only, for example *ABC123XY*.";

const addressPrompt = () => "Please send the full delivery address.";

const addressInvalid = () =>
  "That address looks incomplete. Please send the full delivery address, including the area and state.";

// ------------------------------------------------------------------ confirm

const confirmSummary = ({ productName, quantity, depotName, companyName, deliveryType, unitPrice, total, trucks = [], address }) => {
  const truckLine = trucks
    .map((t) => (trucks.length > 1 ? `${t.plate} (${litres(t.quantity)})` : t.plate))
    .join(", ");
  const collect =
    deliveryType === "delivery"
      ? `Delivery by Soroman truck to: ${address}`
      : trucks.length === 0
        ? "Loading by my truck, truck numbers taken at the gate"
        : `Loading by my truck${trucks.length > 1 ? "s" : ""}: ${truckLine}`;
  return (
    "Please check your order.\n\n" +
    `Product: ${litres(quantity)} ${productName}\n` +
    `Depot: ${depotName}\n` +
    `Company: ${companyName}\n` +
    `${collect}\n` +
    `Price: ${naira(unitPrice)}/L\n` +
    `*Total: ${naira(total)}*\n\n` +
    "Select Confirm for your invoice and payment details."
  );
};

const confirmWalletHint = (balance) =>
  `Your wallet balance is ${naira(balance)}, which covers this order. Once you confirm, you can pay from your wallet in one tap, no transfer needed.`;

const confirmOutdated = () =>
  "Your order has changed since that summary, so the old button no longer works. Here is the updated summary.";

const confirmButtons = () => ({ confirm: "Confirm", edit: "Edit", cancel: "Cancel" });

const editPrompt = () => "What would you like to change?";

const editListButton = () => "Change something";

const editRows = () => ({
  depot: { title: "Depot" },
  product: { title: "Product" },
  quantity: { title: "Quantity" },
  company: { title: "Company" },
  collect: { title: "Collection" },
});

const orderPending = () => "One moment, your order is being created.";

// ----------------------------------------------------- order outcome & payment

const orderCreated = (order) => {
  const deadline = paymentDeadlineLine(order);
  return (
    `Order *${order.orderNumber}* created.\n\n` +
    `*Total: ${naira(order.totalAmount)}*\n\n` +
    (deadline ? `${deadline}\n\n` : "") +
    `Transfer to the account for this order:\n` +
    `Bank: ${order.virtualAccountBank}\n` +
    `Account Number: *${order.virtualAccountNumber}*\n` +
    `Account Name: ${order.virtualAccountName}`
    // Dropped: "Once Soroman confirms your transfer, tap *Pay now* below to
    // confirm your order." The trailing \n\n above went with it — it existed
    // only to separate the account block from that sentence, and left in place
    // it would end every one of these messages on two blank lines.
  );
};

// ------------------------------------------------- expected payment (splits)

/**
 * Asked once, straight after the order exists.
 *
 * The desk has had this for a while — its order wizard offers "Customer told
 * you how they'll pay?" and takes an amount and a company name per deposit.
 * This is that same question on WhatsApp, in the one place the customer is
 * already looking at the account they are about to pay into.
 *
 * Why it earns a turn: a bank transfer arrives carrying nothing but a
 * depositor name and a narration. When three companies each send part of one
 * order, the desk has three lines and no way to know which order they settle.
 * Naming them in advance is what turns that into a match.
 *
 * Optional, and said to be optional — an order is never held up by it.
 */
const expectedPaymentPrompt = () =>
  "One more thing, and it is optional.\n\n" +
  "Who is sending the money? If more than one person or company is paying " +
  "for this order, list each one. That is how we match your transfer when " +
  "it lands.\n\n" +
  "Send them one at a time, amount first:\n" +
  "*5,000,000 Rure Oil and Gas*\n\n" +
  "Tap *Done* when you have listed everyone, or *Skip*.";

const expectedPaymentButtons = () => ({ expectdone: "Done", expectskip: "Skip" });

/** Each entry read back, so a mistyped figure is caught before the transfer. */
const expectedPaymentAdded = (amount, name, remaining) =>
  `Noted, *${naira(amount)}* from *${name}*.\n\n` +
  (remaining > 0
    ? "Add another the same way, or tap *Done*."
    : "That is as many as we can note on one order. Tap *Done* to continue.");

/**
 * Unparseable. Shows the shape rather than naming a rule: the customer needs
 * the example, not the grammar.
 */
const expectedPaymentUnparsed = () =>
  "I did not get that. Send the amount first, then the name it will arrive " +
  "under, like *5,000,000 Rure Oil and Gas*.\n\n" +
  "Or tap *Done* if you have finished, *Skip* to leave it.";

/** A figure that parsed but can't be money. */
const expectedPaymentBadAmount = () =>
  "That amount is not valid. Send it in naira, amount first, like " +
  "*5,000,000 Rure Oil and Gas*.";

const expectedPaymentSaved = (count) =>
  count === 1
    ? "Noted, we will look out for that transfer."
    : `Noted, we will look out for those ${count} transfers.`;

const expectedPaymentSkipped = () => "No problem, pay from whichever account suits you.";

/**
 * The wallet payment couldn't go through — either the transfer hasn't landed
 * yet (a Pay now tapped early) or the balance fell short. Either way the order
 * still stands; point back at the transfer and the same Pay now button.
 */
const payFailed = (message) =>
  message && /balance/i.test(message)
    ? "Not yet, your wallet does not cover this order. Please transfer to the account above; once Soroman confirms it, tap *Pay now* again."
    : "We could not take the payment. Please try again, or transfer to the account above.";

/**
 * Pay now after the payment window closed. The order is Expired; offer reorder
 * rather than pointing at a transfer that can no longer settle this order.
 */
const orderExpired = () =>
  "This order has expired. Payment did not come in on time, so the price is no longer held. Please place a new order at today's price.";

const orderExpiredButtons = () => ({
  reorder: "Reorder",
  order: "Place new order",
});

const orderPaidWallet = (order) =>
  `Order *${order.orderNumber}* created and paid in full.\n\n` +
  `${naira(order.totalAmount)} came from your wallet, so no transfer is needed. ` +
  "Your loading ticket is being prepared, and we will keep you posted at each step.";

const portalManageHint = (portalUrl) =>
  `To change a truck or truck number later, manage this order at ${portalUrl}`;

const invoiceCaption = (orderNumber) => `Invoice for order ${orderNumber}`;

const orderFailedStock = (hasSome, depotName) =>
  hasSome
    ? `Part of that quantity is no longer available at ${depotName}. Please try a smaller quantity.`
    : `This product is no longer available at ${depotName}. Please pick another depot.`;

const orderFailedGeneric = (supportPhone) =>
  `We could not create your order, and nothing was charged. Please try again shortly, or call ${supportPhone}.`;

const awaitPaymentNudge = (order) => {
  const deadline = paymentDeadlineLine(order);
  return (
    `We are still waiting on your transfer for order *${order.orderNumber}*. Amount: ${naira(order.totalAmount)}. Bank: ${order.virtualAccountBank}. Account Number: *${order.virtualAccountNumber}*.` +
    (deadline ? `\n\n${deadline}` : "")
  );
};

const awaitPaymentCancelButton = () => "Cancel this order";
/**
 * The answer to a "Pay now" tap from a session that rendered the button before
 * it was withdrawn. The button itself is gone (see engine.awaitPaymentButtonDefs)
 * and so is the wallet payment path behind it — an order is confirmed against
 * the bank transfer that paid for it, by the finance desk.
 */
const payNowWithdrawn = () =>
  "Just send the transfer to the account on your order, there is nothing to tap. Our finance desk confirms your order the moment your transfer lands, and you will get a message here.";

const cancelOrderConfirm = (orderNumber) =>
  `Cancel ${orderNumber ? `order *${orderNumber}*` : "this order"}? It has not been paid, so nothing will be charged and the stock goes back.`;

const cancelOrderButtons = () => ({ "cancelorder:yes": "Yes, cancel it", keeporder: "Keep my order" });

const orderCancelled = (order) =>
  `Order ${order?.orderNumber ? `*${order.orderNumber}* ` : ""}has been cancelled. Nothing was charged.\n\nWhat would you like to do?`;

const cancelFailed = (supportPhone) =>
  `We could not cancel that order, it may already be processing. Please call ${supportPhone}.`;

const paymentConfirmed = (order) =>
  `Payment received. Order *${order.orderNumber}* is confirmed.\n\nWe will keep you posted at each stage: release, loading and completion.`;

// ---------------------------------------------------------- session & misc

const cancelled = () =>
  "That order has been discarded. Nothing was charged.\n\nWhat would you like to do?";

const expiredResume = ({ productName, quantity, depotName }) => {
  const summary = [quantity && litres(quantity), productName, depotName && `from ${depotName}`]
    .filter(Boolean)
    .join(" ");
  return `Welcome back. Your previous order expired${summary ? `. You were ordering ${summary}` : ""}. Continue from where you stopped?`;
};

const resumeButtons = () => ({ resume: "Continue order", startover: "Start over" });

const unsupportedType = () =>
  "We can only take text messages and menu selections here. Voice notes and photos are not supported.";

const threeStrikes = () => "Let us start again. Please select an option below.";

const threeStrikesButtons = () => ({ menu: "Back to menu", retry: "Try again" });

module.exports = {
  naira,
  litres,
  identifyPrompt,
  identifyGreeting,
  identifyInvalidName,
  welcome,
  menuGreeting,
  menuButtons,
  reorderRow,
  payLastRow,
  linkRows,
  linkCtas,
  noStockAnywhere,
  inactiveCustomer,
  helpText,
  trackStatus,
  trackStatusLabel,
  trackPortalButton,
  trackListPrompt,
  trackListButton,
  trackRow,
  trackOrderGone,
  trackNoOrder,
  pricesHeader,
  pricesStateHeader,
  pricesDepotLine,
  pricesProductPart,
  pricesFooter,
  stateListPrompt,
  stateListButton,
  stateRowDescription,
  changeStateRow,
  depotPrompt,
  depotListButton,
  moreRow,
  depotUnavailable,
  productPrompt,
  productListButton,
  productRowDescription,
  productUnavailable,
  quantityPrompt,
  quantityInvalid,
  quantityBelowMin,
  quantityAboveCap,
  quantityOverStock,
  overStockButtons,
  companyPrompt,
  companyInvalid,
  collectPrompt,
  collectButtons,
  truckDeclarePrompt,
  truckDeclareButtons,
  truckDeferEscapeButtons,
  truckCountPrompt,
  truckCountInvalid,
  truckLitresPrompt,
  truckLitresInvalid,
  lastTruckPrompt,
  platePrompt,
  plateInvalid,
  addressPrompt,
  addressInvalid,
  confirmSummary,
  confirmWalletHint,
  confirmOutdated,
  confirmButtons,
  orderPaidWallet,
  editPrompt,
  editListButton,
  editRows,
  orderPending,
  orderCreated,
  expectedPaymentPrompt,
  expectedPaymentButtons,
  expectedPaymentAdded,
  expectedPaymentUnparsed,
  expectedPaymentBadAmount,
  expectedPaymentSaved,
  expectedPaymentSkipped,
  payFailed,
  orderExpired,
  orderExpiredButtons,
  portalManageHint,
  invoiceCaption,
  orderFailedStock,
  orderFailedGeneric,
  awaitPaymentNudge,
  awaitPaymentCancelButton,
  payNowWithdrawn,
  cancelOrderConfirm,
  cancelOrderButtons,
  orderCancelled,
  cancelFailed,
  paymentConfirmed,
  cancelled,
  expiredResume,
  resumeButtons,
  unsupportedType,
  threeStrikes,
  threeStrikesButtons,
};
