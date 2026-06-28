# ProfitLoss

A live P&L dashboard that pulls revenue and expenses from every source into one
normalized ledger in Supabase, and renders profit & loss by month, category, and source.

## Architecture

```
TicketSpice ─(cron API pull)─┐
HoneyBook  ─(Zapier webhook)─┤
Genius POS ─(CSV import)─────┼──►  Supabase `transactions`  ──►  React dashboard
Table22    ─(manual upload)──┤      (one normalized ledger)
Bank feed  ─(Plaid/CSV)──────┘
```

Every source upserts into one table: `transactions (source, type, category, amount_cents, txn_date, memo, external_id, raw)`.
`type` (`income`/`expense`) carries direction; `amount_cents` is always a positive magnitude.
`external_id` makes every importer idempotent via the `(source, external_id)` unique index.

## Run the dashboard

```bash
npm install
npm run dev        # http://localhost:5173
```

`.env` holds the Supabase URL + publishable (anon) key — safe for the browser.

## Ingestion: TicketSpice (Webconnex API v2)

TicketSpice runs on the **Webconnex** platform, so the live API is at
`https://api.webconnex.com/v2/public` (shared with RegFox/GivingFuel/RedPodium).
Docs: https://docs.webconnex.io/api/v2/

| | |
|---|---|
| Base URL | `https://api.webconnex.com/v2/public` |
| Auth | request header `apiKey: <YOUR_KEY>` (not Bearer) |
| Endpoint | `GET /search/orders` |
| Incremental | `?dateUpdatedAfter=<ISO timestamp>` |
| Paging | `?startingAfter=<lastId>&limit=50` — response has `totalResults` / `hasMore` |
| Rate limit | 10,000/day, 900 per 15 min (per **account**, not per key) |

**Get your API key:** in TicketSpice, hover **Extras → Integrations → API Keys → Add API Key**,
name it, and **Update Key**. Refresh the page to reveal the generated key.

```bash
# server-side env (Render dashboard or local shell), never the browser:
export SUPABASE_URL=...                 # https://<project>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=...    # service_role key
export TICKETSPICE_API_KEY=...          # the Webconnex key from Integrations

npm run ingest:ticketspice
```

On Render, add this as a **Cron Job** (e.g. every 15 min) running `node ingest/ticketspice.mjs`.
The `ingestion_state` table tracks a per-source `dateUpdatedAfter` cursor so each run only
pulls orders changed since the last run, paging through with `startingAfter`/`hasMore`.

> The endpoint, auth header, and params above are verified against the Webconnex v2 docs.
> Order field names in `mapOrder()` (`total`, `dateCreated`, `dateUpdated`, `billing`,
> `orderNumber`, `formName`) follow the documented response shape — once you drop in a real
> key, run it once and eyeball one row to confirm your account's payload matches. The cursor +
> upsert plumbing is source-agnostic and reusable for HoneyBook, Genius, etc.

## Data model

| column        | purpose                                              |
|---------------|------------------------------------------------------|
| `source`      | which platform the row came from                     |
| `type`        | `income` or `expense`                                |
| `category`    | grouping for the P&L (e.g. Classes, Refunds, Events) |
| `amount_cents`| positive magnitude in cents                          |
| `txn_date`    | date the money moved                                 |
| `external_id` | source's own id — dedupes re-imports                 |
| `raw`         | original payload for audit                           |

## Access control

Data is locked behind Supabase Auth. `transactions` (and `ingestion_state`) require an
**authenticated** user whose email is in `public.allowed_emails`. Anon/public access
returns zero rows, so the static site is safe to host publicly — only a logged-in,
allow-listed account sees anything. The edge-function sync uses the service role, which
bypasses RLS, so it keeps working. To grant someone access:
`insert into allowed_emails(email) values ('person@example.com');`

## Deploy to Render (static site)

`index.html` is the app (login + dashboard). `dashboard.html` just redirects to it.

1. **Supabase → Authentication → Sign In / Providers → Email**: turn **off** "Confirm email"
   so sign-up is instant (no email round-trip). Optional but recommended for a single owner.
2. **Get the files onto GitHub** — either drag `index.html` + `render.yaml` into your repo via
   GitHub's "Add file → Upload files", or push from this folder:
   ```bash
   git init && git add . && git commit -m "ProfitLoss dashboard"
   git remote add origin <your-repo-url> && git push -u origin main
   ```
3. **Render → New → Static Site** (or "Blueprint" to use `render.yaml`): pick the repo,
   Publish directory `.`, Build command empty → Create.
4. Open the Render URL, click **Create account** once with an allow-listed email + a password
   you choose, then log in. Done.
