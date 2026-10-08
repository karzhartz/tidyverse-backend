# wimak-service

The server-side half of **Wimak Total Care**. It does two jobs:

1. **Payments API** — every website booking creates a Stripe Checkout Session,
   Stripe's webhook drives the transaction state, and the customer gets two
   emails (booking received, payment received).
2. **Staff administration CLI** — creates and manages the Supabase accounts that
   sign in to the [Flutter dashboard](../dart/wimak_admin/admin).

Both live here because both need the Supabase **secret** key, which must never
ship in the website bundle or the desktop app.

```sh
npm install
cp .env.example .env          # Supabase + Stripe + email settings
npm start                     # API on http://127.0.0.1:8787
curl http://127.0.0.1:8787/health
```

---

# 1. Payments API

## The flow

```
website  ──POST /api/bookings──►  wimak-service
                                     │  create_public_booking()   (prices it, returns WTC-XXXXXX)
                                     │  begin_booking_checkout()  (claims attempt N)
                                     │  Stripe Checkout Session   (idempotency key = reference)
                                     │  email: "booking received"
                                     ▼
                            { reference, checkout.url }
                                     │
website redirects the customer ──►  Stripe Checkout
                                     │
                                     ├─ paid ──► POST /webhooks/stripe
                                     │              apply_stripe_payment()
                                     │              email: "payment received"
                                     ▼
                            success_url → /booking-confirmed
```

The website never talks to Stripe or to the payment tables directly. It posts a
booking and receives a URL to send the customer to.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/bookings` | Create a booking **and** its Checkout Session; send the first email |
| `POST` | `/api/bookings/:reference/checkout` | (Re)start checkout — after a cancel or an expiry |
| `GET` | `/api/bookings/:reference?email=…` | The booking and its live payment state |
| `POST` | `/webhooks/stripe` | Stripe events; the only thing that settles a payment |
| `POST` | `/api/bookings/:reference/emails/:kind/resend` | Operator resend (`booking` or `payment`), needs `ADMIN_API_TOKEN` |
| `GET` | `/health` | Liveness and the mode it booted in |

A reference is short (`WTC-XXXXXX`) and therefore guessable, so reading a booking
or restarting a checkout needs the email used to make it — or the Stripe Checkout
Session id. Without one of those the answer is `403`.

## Idempotency

The booking reference **is** the Stripe idempotency key for the first Checkout
Session. A retried `POST /api/bookings` that reaches Stripe twice returns the
same session instead of a second chargeable one. Three layers guard the money:

| Layer | What it stops |
| --- | --- |
| Reference-as-idempotency-key | Two sessions from one booking |
| An open session is reused, not recreated | A refresh creating a second session |
| `public.stripe_events.id = evt_…` | A redelivered webhook applying twice |

An expired session genuinely needs a new one, so a later attempt is keyed
`<reference>:retry:<n>` — still derived from the reference, and still stable for
that attempt.

## Stripe events handled

| Event | Result |
| --- | --- |
| `checkout.session.completed` (paid) | `paid`, fees and tax captured |
| `checkout.session.completed` (unpaid) | `pending` — an async method is still clearing |
| `checkout.session.async_payment_succeeded` | `paid` |
| `checkout.session.async_payment_failed` | `failed` |
| `checkout.session.expired` | `expired` |
| `payment_intent.payment_failed` | `failed`, with the decline reason |
| `charge.refunded` | `refunded` / `partially_refunded`, amount reduced |
| `charge.dispute.created` | `disputed` |

Anything else is acknowledged and ignored. A charge event is matched to its
booking through `stripe_payment_intent_id` when it carries no metadata.

## The money fields

The migration adds these to `public.bookings`:

| Column | Meaning |
| --- | --- |
| `payment_status` | `unpaid` → `pending` → `paid`, or `failed` / `expired` / `refunded` / `partially_refunded` / `disputed` |
| `amount_paid` | What Stripe actually captured |
| `fees` | Total cost of the transaction, **inclusive of tax** |
| `net_amount` | `amount_paid − fees`, a generated column — the three can never disagree |
| `tx_meta` | The transaction detail: Stripe fee, tax, card, receipt, last event |
| `stripe_checkout_session_id`, `stripe_payment_intent_id`, `stripe_customer_id` | The Stripe objects behind it |
| `checkout_attempts`, `paid_at` | How many sessions, and when it settled |
| `booking_email_sent_at`, `payment_email_sent_at` | Email idempotency |

`fees` is deliberately the *total* cost of getting paid: Stripe's processing fee
plus tax. `net_amount` is therefore what the business actually keeps. If your
accounting treats tax as a pass-through you would remit rather than a cost, that
is the one line to revisit — it is derived in exactly one place
(`feeBreakdown()` in `src/stripe.mjs`), and the database mirrors it.

The API's JSON calls `tx_meta` **`txMeta`**; the column keeps the schema's
snake_case convention like every other column.

Only `public.apply_stripe_payment()` writes these columns, and it is granted to
`service_role` alone. It locks the booking row, so two events for one booking
cannot interleave.

## Emails

Two messages, both rendered from the database's own figures:

| When | Subject | Contents |
| --- | --- | --- |
| Booking created | `Booking WTC-XXXXXX received — complete your payment` | Reference, service, date/time, address, total, and the pay link |
| Stripe says paid | `Payment received — booking WTC-XXXXXX confirmed` | Appointment date, booking detail, amount paid, card, transaction id, receipt link |

Both have an HTML and a plain-text version. `EMAIL_TRANSPORT` decides where they
go:

| Transport | Use |
| --- | --- |
| `smtp` | **Production.** Delivered through your own mail server. |
| `resend` | Alternative — the Resend HTTP API. Needs `RESEND_API_KEY`. |
| `file` | Writes each message to `EMAIL_LOG_DIR` so you can inspect the rendering |
| `console` | Used when nothing else is configured. Logs the message; nothing is delivered |

Setting `SMTP_HOST` selects SMTP on its own — `EMAIL_TRANSPORT` is only needed to
override that. The two settings that trip people up:

- **`SMTP_SECURE`** — `true` is implicit TLS (port 465). On 587 the connection
  opens in the clear and upgrades with STARTTLS, so it stays `false`; set
  `SMTP_REQUIRE_TLS=true` to refuse to send when the upgrade is unavailable.
  Left blank, it is inferred from the port.
- **`EMAIL_FROM`** — must be an address your mail server accepts for the
  authenticated account, or the message is rejected at send time.

At boot the service calls `verify()` against the mail server — it connects and
authenticates but sends nothing — and logs whether that worked. A failure is a
warning, not a crash: a mail outage must not stop bookings being taken.

The stamp is written only after the provider accepts the message, so a failure
leaves the email "due" rather than lost — a webhook redelivery or the resend
endpoint will pick it up.

## Running it locally

```sh
# 1. the API
cp .env.example .env      # Supabase + Stripe test keys; use EMAIL_TRANSPORT=console locally
npm start                 # http://127.0.0.1:8000

# 2. forward real Stripe events to it (needs the Stripe CLI)
stripe listen --forward-to localhost:8000/webhooks/stripe
#    copy the whsec_… it prints into STRIPE_WEBHOOK_SECRET, then restart

# 3. the website, pointed at the API
cd ../tidyverse-helpers
echo 'VITE_API_BASE_URL=http://127.0.0.1:8000' >> .env.local
npm run dev               # http://localhost:8080
```

The webhook secret is **required**: without it the service refuses to start,
because an unverifiable webhook is worse than no webhook.

## Deploying with Docker

The repository ships a two-stage `Dockerfile` and a `docker-compose.yml` that
runs the API and the website together. The website is built from
`../tidyverse-helpers`, so the two repositories need to sit side by side.

```sh
cd wimak-service
cp .env.example .env          # fill in the live values
docker compose up -d --build
docker compose logs -f api
```

| Service | URL | Image |
| --- | --- | --- |
| API | <http://localhost:8000> | `wimak-service:latest` |
| Website | <http://localhost:8080> | `wimak-website:latest` |

The API image installs from the lockfile (`npm ci --omit=dev`), runs as the
non-root `node` user, and sets `HOST=0.0.0.0` — the service's `127.0.0.1`
default is unreachable from outside a container. Its healthcheck calls
`/health`, and compose waits for that before starting the website. The SMTP
check runs *after* the listener opens, so a slow mail host cannot delay the
healthcheck or hold up bookings.

**The website's configuration is baked in at build time.** Vite inlines `VITE_*`
variables, so they are build arguments, not runtime environment:

```sh
docker build -t wimak-website \
  --build-arg VITE_API_BASE_URL=https://api.wimaktotalcare.com \
  --build-arg VITE_SUPABASE_URL=https://xxxx.supabase.co \
  --build-arg VITE_SUPABASE_ANON_KEY=sb_publishable_... \
  ../tidyverse-helpers
```

Only the **publishable** Supabase key belongs there. `.dockerignore` keeps
`.env` out of both images — the API image contains just `node_modules`,
`package.json` and `src`, so no secret is baked into a layer.

Before going live, three settings matter:

1. `PUBLIC_SITE_URL` — the website's public origin. Stripe sends the customer
   back here after payment.
2. `CORS_ORIGINS` — that same origin, instead of `*`.
3. `STRIPE_WEBHOOK_SECRET` — with the Stripe endpoint pointing at
   `https://<api-host>/webhooks/stripe`.

Two operational notes:

- **No inline comments in `.env`.** Neither Node nor `docker --env-file` strips
  a `#` from the middle of a line, so `SMTP_PORT=587  # 465 for TLS` becomes the
  literal value `587  # 465 for TLS` and the service refuses to start. Comments
  must sit on their own line.
- **`docker compose config` prints secrets in cleartext**, because they live in
  `.env`. Do not run it where the output is captured, such as CI logs.

---

# 2. Staff administration CLI

## Why it exists

Signing in to the dashboard takes **two** things in different places: a Supabase
Auth user, and a `public.staff` row linked to it by `auth_user_id` — which is
what row level security reads. The dashboard's "Add team member" form can only
do the second half; creating a login needs the admin API and a secret key.

This CLI does both halves in one command, and can audit and repair the links
afterwards.

```sh
npm run check
npm run create-admin -- --name "Amara Okafor" --email amara@wimaktotalcare.com --generate-password
```

| Command | What it does |
| --- | --- |
| `check` | Verify the credentials, and report broken staff/auth links |
| `create` | Create an auth login **and** link a `staff` row |
| `list` | Staff rows, login status, and unlinked auth accounts |
| `link` | Link an existing auth account to a staff row |
| `set-role` / `set-active` | Change a role, or deactivate an account |
| `reset-password` | Set a new password |

`create` is idempotent — an existing login is reused and relinked — and it only
resets a password when you pass `--password` / `--generate-password`. A generated
password is printed once and stored nowhere. Deactivating (`--active false`) is
the offboarding path: the login survives, but `is_staff()` is false and the
dashboard shows nothing. There is deliberately no delete command.

Roles: `admin` (everything), `manager` (everything except staff and settings),
`viewer` (read-only), enforced in Postgres by `is_admin()` / `can_edit()`.

---

## Configuration

`.env` is ordinary `KEY=VALUE` (unlike `admin/.env`, which is JSON for Flutter's
`--dart-define-from-file`) and is gitignored. The shell wins over the file.

| Variable | Required | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | yes | The Project URL — not the Postgres connection string |
| `SUPABASE_SECRET_KEY` | yes | `sb_secret_…` or a `service_role` JWT. Bypasses RLS. |
| `STRIPE_SECRET_KEY` | yes | `sk_test_…` / `sk_live_…` |
| `STRIPE_WEBHOOK_SECRET` | yes | `whsec_…` from the endpoint or `stripe listen` |
| `STRIPE_CURRENCY` | no | Default `usd` |
| `STRIPE_TAX_RATE_ID` / `STRIPE_AUTOMATIC_TAX` | no | Attach a tax rate, or let Stripe compute it |
| `STRIPE_SUCCESS_URL` / `STRIPE_CANCEL_URL` | no | `{REFERENCE}` is ours, `{CHECKOUT_SESSION_ID}` is Stripe's |
| `EMAIL_TRANSPORT` | no | `smtp` (auto-selected when `SMTP_HOST` is set), `resend`, `file` or `console` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | for smtp | Mail server. Port defaults to 587, or 465 when `SMTP_SECURE=true` |
| `SMTP_USER` / `SMTP_PASSWORD` | no | Leave both blank for a relay that needs no authentication |
| `SMTP_REQUIRE_TLS` / `SMTP_REJECT_UNAUTHORIZED` / `SMTP_CONNECTION_TIMEOUT_MS` | no | STARTTLS enforcement, certificate checking, timeouts |
| `EMAIL_FROM` / `EMAIL_REPLY_TO` | no | Sender and reply-to; the From must be accepted by the mail server |
| `RESEND_API_KEY` / `EMAIL_LOG_DIR` | no | Only for the `resend` and `file` transports |
| `HOST` / `PORT` | no | Default `127.0.0.1:8787` |
| `PUBLIC_SITE_URL` / `CORS_ORIGINS` | no | Default `http://localhost:8080` |
| `ADMIN_API_TOKEN` | no | Enables the resend endpoint |
| `TRUST_PROXY` / `LOG_LEVEL` | no | Set `TRUST_PROXY=true` behind a TLS proxy |

## Security

- Three secrets live here and nowhere else: the Supabase secret key, the Stripe
  secret key, and the webhook secret. Never put any of them in the website
  (`VITE_*` variables ship to the browser) or the Flutter build.
- `HOST` defaults to loopback for that reason. Run it behind a TLS reverse
  proxy; set `TRUST_PROXY=true` so client IPs and rate limiting see the real
  client.
- The service refuses to start on a publishable/anon Supabase key, a Stripe key
  that is not `sk_`/`rk_`, or a missing webhook secret.
- `.env` is gitignored; only `.env.example` is committed. If a secret has ever
  been pasted into a chat, an issue or a commit, rotate it.
- `POST /api/bookings` is public by design — it is what the website calls. The
  database prices and validates every booking; the request body is a hint only.

## Tests

```sh
npm test        # 85 tests, no network, no credentials
```

They cover the parts where a mistake costs money: minor-unit conversion, the fee
split, the idempotency key, Checkout Session parameters, the Stripe-event →
booking-update mapping, email contents, and configuration validation.

The database side is verified the same way — apply every migration to a throwaway
Postgres, then assert the payment behaviour:

```sh
cd ../dart/wimak_admin/supabase
docker run --rm -d --name wimak-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=wimak \
  --tmpfs /var/lib/postgresql/data:rw,size=512m postgres:17-alpine
# apply migrations in order, then tests/… against it
```

## Layout

```
src/
  server.mjs        entry point; boots with a complete config or not at all
  app.mjs           Express wiring, CORS, error shaping
  routes/
    bookings.mjs    create / checkout / read / resend
    webhooks.mjs    Stripe webhook (raw body, verified)
    health.mjs      liveness
  stripe.mjs        money math, Checkout Sessions, event mapping
  checkout.mjs      reuse an open session or claim a new attempt
  bookings.mjs      the database functions, and the public serialisation
  emails.mjs        the two templates (pure)
  mailer.mjs        resend / file / console transports
  notifications.mjs render → send → stamp
  format.mjs        money, dates, HTML escaping (pure)
  booking-payload.mjs  request shaping (pure)
  logger.mjs        one JSON line per event
  config.mjs        .env loading, key classification, service config
  cli.mjs           the staff administration commands
  supabase.mjs      Auth admin API + PostgREST access
  validate.mjs, args.mjs, output.mjs, errors.mjs
test/               unit tests for every pure module
```

## Related

- [`supabase/README.md`](../dart/wimak_admin/supabase/README.md) — the schema,
  the payments migration, and row level security.
- [`tidyverse-helpers/README.md`](../js/tidyverse-helpers/README.md) — the
  website that calls this API.
- [`admin/README.md`](../dart/wimak_admin/admin/README.md) — the dashboard the
  CLI creates accounts for.
