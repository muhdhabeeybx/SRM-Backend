# Notifications

One engine serves the mobile app, the admin dashboard and the customer web app,
across four channels: **in-app**, **push**, **email** and **SMS**.

Business code never writes copy and never calls a provider. It states a fact:

```js
const { notify } = require("../notifications");

notify("order.released", {
  to: { customerId: order.customerId },
  data: { orderId: order.id, reference, depotName: depot.name },
});
```

Everything else — which channels fire, what the SMS says, whether the recipient
muted the category, whether it is 3 a.m. where they are, and what to record —
is decided downstream.

---

## Why it is built this way

Before this, notifications were fifteen inline `sendXEmail()` / `sendYSMS()`
calls scattered across controllers and services. That worked, but it meant:

- **No in-app or push at all.** The mobile app had no inbox.
- **No record.** A Termii failure printed a line to stdout and vanished, so
  "the customer says they were never told" had no answer.
- **No opt-out.** Nobody could stop an SMS they didn't want.
- **Copy in controllers.** Changing an SMS meant editing a request handler.

The engine fixes all four without changing a single existing customer-facing
email or SMS — see [What was NOT changed](#what-was-not-changed).

---

## Layout

```
notifications/
  index.js          notify() — the public API, and the queue/inline transport
  engine.js         rendering, preference + quiet-hours gating, dispatch
  catalog.js        every notification type: category, channels, copy, links
  recipients.js     { customerId } | { roles: [...] } | { email } → recipients
  listeners.js      the event bus → engine bridge
  worker.js         the pg-boss worker and the nightly retention sweep
  sse.js            the live stream hub
  streamTicket.js   single-use credentials for browser EventSource
  fcm.js            Firebase Cloud Messaging, HTTP v1
  channels/         in-app, push, email, sms
  templates/email.js  the shared branded email shell
```

Five tables: `notifications` (the inbox), `device_tokens`,
`notification_preferences`, `notification_settings`, `notification_deliveries`
(the outbound log). Migration `0040_notifications_engine.sql`.

---

## The catalog

`notifications/catalog.js` is the single file that decides what a notification
type *is*. An entry answers five questions:

| field | meaning |
|---|---|
| `audience` | `"customer"`, `"staff"` or `"both"` |
| `category` | the unit preferences are expressed in — `orders`, `payments`, `security`, … |
| `priority` | `low` / `normal` / `high` / `urgent`. Only `urgent` ignores quiet hours |
| `channels` | the **default** channel set; preferences narrow it, never widen it |
| `title` / `body` | templates, plus optional `sms`, `email`, `push` overrides |

Plus `entity`, `data` (the mobile deep-link payload), `actionUrl` (the web deep
link) and `dedupe`.

Two flags matter:

- **`mandatory: true`** — removes the type from the preference matrix entirely.
  Security notices use it: someone who muted "security" and was then taken over
  would have muted their only warning.
- **`inbox: false`** — no in-app row. Used for credentials in transit (a
  password reset), which are not something to re-read later.

### Adding a type

Add an entry to the catalog and call `notify()`. Nothing else. Templates must
tolerate missing data — `tests/notifications.test.js` asserts every template
renders against `{}`, because an event emitted from a path that forgot a field
should degrade to a vaguer sentence, never throw.

---

## Recipients

```js
to: { customerId: 12 }              // one customer
to: { customer: customerRow }       // …already in hand, no query
to: { staffId: 4 }                  // one staff member
to: { roles: ["admin", "finance_manager"] }  // active staff holding ANY of these
to: { allStaff: true }
to: { email, phone, name }          // a contact with no account behind it
to: [ …any mix of the above ]
```

Resolution is bulk (one query per kind, never one per recipient) and
deduplicated — someone holding two of the named roles is notified once.

A contact with no account can only receive **email and SMS**; it has no inbox
and no devices. That is how ERP delivery customers are reached: they live in
`delivery_customers`, a separate register from the portal `customers` table,
with no app and no account.

---

## How a channel is chosen

For each recipient, in order:

1. The type's default `channels`, or an explicit `channels:` override.
2. Does the recipient have the address at all? No email on file → `skipped`.
3. **Preferences** — `notification_preferences`, per category. Skipped for
   `mandatory` types and when `force: true`.
4. **Master switches** — `notification_settings.pushEnabled` / `emailEnabled` /
   `smsEnabled`.
5. **Quiet hours** — `push` and `sms` only, and never for `urgent`.

Both preference tables store **deviations**. No row means "the defaults are
fine", so a new category ships working without a backfill and a person who
never opens the settings screen costs nothing.

### Quiet hours

Minutes past midnight **in the recipient's own timezone**, and the window may
wrap (22:00 → 07:00 is `start 1320, end 420`). Suppressed, not deferred: a
queue of overnight buzzes that all fire at 07:00 is worse than the notification
waiting quietly in the inbox — which it still does.

---

## Idempotency

Each type may declare a `dedupe(data)` key. The engine scopes it to the
recipient (`customer:12|order.paid:998`) and the partial unique index on
`notifications.dedupe_key` rejects the second insert.

This is what makes the whole fan-out safe to retry: a redelivered queue job
re-runs, finds the inbox row already there, and **stops before sending a second
SMS**.

> The recipient scoping is not cosmetic. A dedupe key scoped to the *event*
> instead of the *(event, recipient)* pair would make the unique index admit the
> first recipient of a broadcast and silently drop everyone else — the fan-out
> would report success and reach one person. There is a test for exactly this.

---

## Transport: inline or queued

| `NOTIFY_QUEUE_ENABLED` | behaviour |
|---|---|
| `true` | `notify()` enqueues a pg-boss job; the worker delivers. Survives a deploy or crash mid-send. **Use in production.** |
| unset / `false` | dispatches in-process, fire-and-forget. Right for dev and tests, which have no worker. |

Both converge on `engine.dispatch()`, so behaviour is identical — only
durability differs. If the queue is unreachable, `notify()` logs and falls back
to an inline send: the notification loses durability for that one call rather
than being lost.

**`notify()` never throws.** A notification is a side effect of an operation
that already committed; letting it reject would turn a delivered order into a
failed request. Use `notifyAndWait()` when you genuinely need the outcome (the
"resend invite" button does, so it can report a failure).

---

## Channels

### In-app

A row in `notifications`, then a best-effort SSE publish. Read via
`GET /api/notifications` (staff) or `GET /api/customer/notifications`.

### Push — two providers, routed by token shape

`channels/push.js` reads each token and sends it where it can actually go.
These are **not** interchangeable, and handing one to the wrong service is a
silent non-delivery:

| token | provider | credentials |
|---|---|---|
| `ExponentPushToken[…]` | Expo (`expoPush.js`) | **none** — Expo authenticates the project, not the caller |
| a raw FCM registration token | FCM HTTP v1 (`fcm.js`) | `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` |

The Expo mobile app mints the first kind, so **the app needs no FCM
credentials on this server** — the APNs key and FCM service account live in EAS,
against the Expo project. Configure the FCM block only for a client that mints
raw FCM tokens. `GET /health` reports which providers are actually configured.

FCM covers Android **and** iOS; iOS is relayed through FCM's APNs bridge, so
there is no separate APNs certificate to renew here. Auth is a service-account
JWT exchanged for an OAuth2 token, cached for 55 minutes. See `.env.example` for
the `FCM_PRIVATE_KEY` newline handling — the usual thing to get wrong.

Two details the mobile app must match:

- **Android notification channels.** `PUSH_ANDROID_CHANNEL_HIGH` and
  `PUSH_ANDROID_CHANNEL_DEFAULT` must be channels the app creates at startup.
  Android silently drops a notification naming a channel that does not exist.
- **The badge is absolute.** iOS shows whatever integer the payload carries, so
  the engine sends the recipient's real unread count on every push.

Token lifecycle: `UNREGISTERED` / `INVALID_ARGUMENT` retires the row
immediately (retrying never succeeds). Transient failures are counted, so one
bad afternoon at Google does not unregister the fleet. A `401`/`403` is *our*
credential and never retires a customer's device.

### Email — Resend

Engine-generated mail renders through the shared shell in
`notifications/templates/email.js` (same teal header and footer as the existing
templates). Resend reports failures in the response body rather than throwing,
which the channel checks — a send treated as successful is a message nobody
receives and nobody notices.

### SMS — Termii

Goes through `services/sms.service.js`, which owns the route decision for every
SMS the platform sends — the engine's channel, the bespoke order senders, and
the OTP path all walk the same `route()`.

Termii's two routes are not a cheap one and an expensive one to try in turn.
They carry different traffic under different rules:

| route | traffic | reaches a DND-registered number? |
|---|---|---|
| `generic` | promotional | **no** — and blocked 8PM–8AM WAT on MTN |
| `dnd` | transactional | yes, and it is the only one that does |

Roughly a third of Nigerian mobile numbers sit on the DND register, so a
payment instruction sent `generic` is one a third of customers never see.
`channels/sms.js` therefore reads the notification's **catalog category**:
everything is transactional — and goes `dnd` first, then `generic` — except the
`marketing` category, which stays on `generic`. A DND registration *is* the
opt-out from promotional SMS; routing promos around it is what gets a sender
ID's DND approval revoked, and the OTPs share that approval. This is what the
broadcast's `system` / `marketing` split buys beyond the mute: an outage notice
reaches a DND-registered customer, an advert correctly does not.

**One sender ID, everywhere.** `TERMII_SENDER_ID` is the only one, on both
routes and on OTPs. Termii approves a sender ID *per route*, and the account
used to fall back to Termii's shared `N-Alert` for the `dnd` leg because the
branded ID was not whitelisted for it — but an unbranded text is one the
customer cannot place, and a verification code nobody recognises is a
verification code nobody trusts. Termii whitelisted `SOROMAN` (all caps) for
the `dnd` route in September 2026; the ID is matched exactly, so `Soroman` is a
different, unapproved sender. If the configured ID is not whitelisted for
DND, that leg comes back `Successfully Sent` and is then rejected by the
carrier, with the `generic` leg still running behind it; the delivery log shows
it as `sender_id` or `rejected` on the `dnd` channel, which is the signal to
chase the whitelisting at Termii.

`TERMII_PROMO_ON_DND=true` would put promos on `dnd` as well — it exists so the
decision is an env var rather than a deploy, not because it is a good idea.

Capped at `NOTIFY_SMS_MAX_LENGTH` (612 = four billed parts) so a runaway
template cannot become a runaway invoice.

---

## The live stream (SSE)

```
POST /api/customer/notifications/stream-ticket   → { ticket, expiresIn }
GET  /api/customer/notifications/stream?ticket=… → text/event-stream
```

Events: `connected`, `notification`, `read`, `unread-count`.

Browsers cannot set headers on `EventSource`, and putting an access token in
the query string would leak it into nginx logs, browser history and `Referer`
— and it is valid for fifteen minutes against every endpoint. So the browser
exchanges its Bearer token for an opaque, **single-use, 30-second** ticket that
grants exactly one capability. Native clients skip this: the stream endpoint
also accepts a normal `Authorization` header.

> **The hub is in-process.** A browser connected to instance A hears nothing
> about a notification written by instance B. That is correct for this
> deployment (one Node process, with the WhatsApp and scheduler workers riding
> inside it). Running more than one instance means sticky sessions, or letting
> clients fall back to polling `/unread-count` — which they should treat as the
> source of truth regardless, since SSE is an optimisation, not the record.

---

## API

Mounted twice, same handlers, scoped by realm:

- `/api/notifications` — staff (`authenticateStaff`, **not** `verifyStaff`: a
  depot manager must be able to read a notification addressed to them)
- `/api/customer/notifications` — customers (`authenticateCustomer`)

| method | path | purpose |
|---|---|---|
| GET | `/` | inbox; `?category=&type=&unreadOnly=&includeArchived=&page=&limit=` |
| GET | `/unread-count` | the badge, plus per-category counts |
| GET | `/:id` | one notification |
| PATCH | `/:id/read` · `/:id/unread` · `/:id/archive` | state |
| DELETE | `/:id` | remove |
| POST | `/read-all` · `/archive-all` | bulk, optionally `{ category }` or `{ ids }` |
| GET/PATCH | `/preferences` | effective preferences + settings |
| POST | `/preferences/reset` | back to catalog defaults |
| GET/POST/DELETE | `/devices` | push registration |
| POST | `/stream-ticket`, GET `/stream` | live stream |
| POST | `/test` | send yourself a test (forced past preferences) |
| GET | `/catalog` | categories + defaults, for building the settings UI |

Admin-only (`verifyStaff`), on the staff mount:

| method | path | purpose |
|---|---|---|
| POST | `/broadcast` | announcement to staff / roles / named recipients |
| GET | `/deliveries` | the outbound log, filterable |
| GET | `/:id/deliveries` | every channel attempt behind one notification |
| GET | `/health` | per-channel success rates, provider config, stream stats |
| GET | `/entity/:type/:id` | everything ever sent about one order |
| POST | `/maintenance/run` | run the retention sweep now |

Every read is scoped in the `WHERE` clause. Another principal's notification is
a **404, not a 403** — a 403 would confirm the row exists.

`/broadcast` has no "all customers" audience. An unbounded blast to every
customer on the platform should not be one mistyped request away; it must be an
explicit list.

It also carries a `category`, `"system"` (the default) or `"marketing"`, which
picks between the two announcement types the catalog builds from one shape.
They say the same thing in the same words; the only difference is which
preference mutes them. A promotion sent as `system` is reaching people who
muted promotions, so label promos `marketing` — that is the entire reason the
opt-out is worth anything.

---

## Observability

`notification_deliveries` records **every** attempt, including the ones that
never ran:

| status | meaning |
|---|---|
| `sent` | the provider accepted it |
| `failed` | the provider refused it — the error is on the row |
| `skipped` | nothing to send to (no email on file, no live device) |
| `suppressed` | the recipient's own preferences or quiet hours refused it |

Telling `skipped` from `suppressed` is the difference between a data problem
and a working opt-out. `GET /health` turns this into per-channel success rates
— a Termii outage shows up there hours before the first support ticket.

Push stores only the token's last 12 characters: a whole FCM token is a live
credential for that device, and this table is readable by anyone with dashboard
access.

---

## Retention

Swept nightly by the worker (`NOTIFY_MAINTENANCE_CRON`, default 03:30) or on
demand via `POST /api/notifications/maintenance/run`:

- notifications — `NOTIFY_RETENTION_DAYS` (180), and **only** rows already read
  or archived. Something the recipient has never seen is never swept out from
  under them, however old.
- delivery log — `NOTIFY_DELIVERY_RETENTION_DAYS` (60)
- retired device tokens — `NOTIFY_DEAD_TOKEN_RETENTION_DAYS` (60). Live tokens
  are never touched, however quiet the device.

---

## What was NOT changed

Deliberately left alone:

- **The eight templates in `services/email.service.js`.** The invoice, the QR
  ticket, the Dangote and LPG confirmations are transactional *documents* whose
  layout is the point. They still send, byte for byte. The catalog entries for
  those flows are `in_app` + `push` only, precisely so nothing is sent twice.
- **The bespoke SMS in `services/sms.service.js`.** Same reasoning; the engine
  adds the inbox row and push alongside them.
- **OTP (`services/otp.service.js`).** It still calls Termii directly, and
  should. An OTP must not sit behind a queue, must not be suppressible by a
  preference, and has its own rate limiting and daily spend cap. Routing it
  through a generic fan-out would add latency and risk to the one message where
  both matter most.

Staff password-setup and reset emails **were** moved onto the engine — they are
internal, and "did the invite actually go out?" is the most common support
question about a new account.

---

## Where notifications come from

Two paths, both ending at the same engine:

1. **The event bus** (`notifications/listeners.js`) — ERP paperwork, security
   events, licences. A service emits `daily_report.approved` and knows nothing
   about SMS.
2. **Direct `notify()` calls** — flows whose data lives inside a transaction
   (an order's invoice, a ticket's QR code). Routing those through the bus
   would mean re-reading rows the caller already holds.

Order status notifications hang off `services/orderStatus.service.js`, the
documented single place `order.status` changes — so a release triggered from
the gate flow, the settlement sweep or a future admin screen all notify
identically, and nobody has to remember to add the call.

---

## Configuration

See the "Notifications engine" block in `.env.example`. The minimum to go live:

```bash
NOTIFY_QUEUE_ENABLED=true      # durability
FCM_PROJECT_ID=…               # push
FCM_CLIENT_EMAIL=…
FCM_PRIVATE_KEY="…"
ADMIN_URL=…                    # deep links (falls back to CLIENT_URL)
PORTAL_URL=…
```

Email and SMS reuse the existing `RESEND_API_KEY` and `TERMII_*` settings.
`NOTIFICATIONS_ENABLED=false` is a master kill switch.
