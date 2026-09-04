# Running the RentPayEZ demo locally (for today's call with Dorothy)

Railway's free plan is blocking the real cloud deploy right now (see note at
the bottom). Until that's resolved, run the app on your own Mac and share
your screen from there — same app, same UI, just running locally instead
of on a public URL.

**No Postgres install needed.** For this one-time demo we run against an
in-memory database (the same one the automated test suite uses) instead of
a real Postgres server. Trade-off: stopping the server clears the data, so
just re-run the two commands below if you restart it. This is only for
today's demo — the real Railway deploy (with the persistent database
that's already running there) is still the plan for production.

## 1. Start the app

Open Terminal, then:

```bash
cd ~/Downloads/rentpayez-platform
PG_TEST_ADAPTER="$(pwd)/test/pgmem-adapter.js" SESSION_SECRET=local-demo-secret PORT=4000 NODE_ENV=development node server.js
```

Leave this running (you'll see `RentPayEZ platform API listening on :4000`).
Open a **second** Terminal tab for the next step.

## 2. Load demo data

In the second tab:

```bash
cd ~/Downloads/rentpayez-platform
node scripts/seed-demo.js
```

This creates a demo property management company ("Meridian Property Group")
with 2 branches, 3 properties, 12 units, 3 tenants, a recorded rent
payment, an open maintenance request, and a move-in inspection — a
realistic, populated account rather than an empty one. It prints the exact
login credentials at the end; they're also below.

## 3. Open it in your browser

- **Admin console:** http://localhost:4000/admin/login.html
  - email: `demo@rentpayez.com`
  - password: `DemoAdmin2026!`
- **Tenant portal:** http://localhost:4000/tenant/login.html
  - Jordan Blake (unit 101): `jordan.blake@example.com` — password is printed
    by the seed script (it's randomly generated each run, so check your
    terminal output rather than this file)

## What's worth showing Dorothy

- **Admin console → Overview**: portfolio-wide stats (branches, properties,
  units, tenants) at a glance.
- **Bulk Import**: this is how a new customer's entire spreadsheet of
  properties gets loaded in one shot — the CSV you'd use is at
  `~/Downloads/rentpayez-portfolio-template.csv`, or point to your own.
- **Tenants tab**: click into Jordan Blake — shows the open maintenance
  request and the recorded payment.
- **Maintenance tab**: the plumbing request Jordan filed, staff can
  triage/update status from here.
- **Inspections tab**: the move-in inspection on unit 101 with room-by-room
  condition notes.
- **Tenant portal** (open in a separate/incognito window so you can show
  both sides): log in as Jordan Blake — see the unit, rent due date,
  payment history, the maintenance request status, and Coach Ezra (AI chat
  — will show a clean "not set up yet" message unless you've added an
  ANTHROPIC_API_KEY/OPENAI_API_KEY, which is expected and fine for a demo).
- **Mobile**: both the admin console and tenant portal are responsive —
  worth a quick resize of the browser window if Dorothy asks about phone
  use.

## Why this isn't already live on a public URL

The Railway project (`rentpayez-platform`) has a Postgres database already
running, but creating the actual app service hit Railway's free-plan
resource limit. Two ways to unblock it whenever you're ready:
1. Upgrade the Railway plan (Hobby is usually ~$5/mo) — tell me once it's
   done and I'll deploy immediately.
2. Free up a slot by removing something unused from your Railway dashboard.

Once either happens, the deploy takes a few minutes and I'll seed it with
this same demo data (or your real portfolio) automatically.
