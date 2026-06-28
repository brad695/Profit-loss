/**
 * TicketSpice (Webconnex API v2) -> Supabase transactions ingestion.
 *
 * TicketSpice runs on the Webconnex platform, so the real API lives at
 * https://api.webconnex.com/v2/public and is shared with RegFox/GivingFuel/RedPodium.
 * Verified against https://docs.webconnex.io/api/v2/ (June 2026).
 *
 *   Base URL : https://api.webconnex.com/v2/public
 *   Auth     : header  apiKey: <YOUR_KEY>          (NOT Bearer)
 *   Endpoint : GET /search/orders
 *   Incremental: ?dateUpdatedAfter=<ISO timestamp>
 *   Paging   : ?startingAfter=<lastId>&limit=50    (response has totalResults / hasMore)
 *   Rate cap : 10,000/day, 900 per 15 min (per account, not per key)
 *
 * Usage:
 *   node ingest/ticketspice.mjs            # sync into Supabase
 *   node ingest/ticketspice.mjs --dry-run  # fetch ONE page, print mapped rows, write nothing
 *
 * Env (server-side only, never the browser). Loaded from ingest/.env.local if present:
 *   SUPABASE_URL                 https://<project>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY    preferred for production writes
 *   SUPABASE_ANON_KEY            fallback (works because transactions RLS is permissive)
 *   TICKETSPICE_API_KEY          Webconnex/TicketSpice API key
 *   WEBCONNEX_API_BASE           optional override (default below)
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

// Tiny .env.local loader (no dependency) so `node ingest/ticketspice.mjs` just works.
try {
  const envPath = new URL('./.env.local', import.meta.url)
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch { /* no .env.local — rely on real env vars (e.g. Render) */ }

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY,
  TICKETSPICE_API_KEY,
  WEBCONNEX_API_BASE = 'https://api.webconnex.com/v2/public',
} = process.env

const SUPABASE_KEY = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY
const DRY_RUN = process.argv.includes('--dry-run')
const SOURCE = 'ticketspice'
const PAGE_LIMIT = 50

function requireEnv() {
  const missing = []
  if (!SUPABASE_URL) missing.push('SUPABASE_URL')
  if (!SUPABASE_KEY && !DRY_RUN) missing.push('SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY')
  if (!TICKETSPICE_API_KEY) missing.push('TICKETSPICE_API_KEY')
  if (missing.length) {
    console.error('Missing env:', missing.join(', '))
    process.exit(1)
  }
}

const supabase = () =>
  createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

async function getCursor(db) {
  const { data } = await db.from('ingestion_state').select('cursor').eq('source', SOURCE).maybeSingle()
  return data?.cursor || '1970-01-01T00:00:00Z'
}

async function setCursor(db, cursor, status = 'ok', notes = '') {
  await db.from('ingestion_state').upsert({
    source: SOURCE, cursor, last_run_at: new Date().toISOString(), last_status: status, notes,
  })
}

/** Map a Webconnex order into one `transactions` row. */
function mapOrder(o) {
  const id = o.id ?? o.orderId
  const dollars = Number(o.total ?? o.amount ?? 0)
  const cents = Math.round(dollars * 100)
  const buyer = [o.billing?.firstName, o.billing?.lastName].filter(Boolean).join(' ') || o.email || 'order'
  const refunded = String(o.status || '').toLowerCase().includes('refund') || dollars < 0
  return {
    source: SOURCE,
    type: refunded ? 'expense' : 'income',
    category: refunded ? 'Refunds' : (o.formName ? `Events: ${o.formName}` : 'Events'),
    amount_cents: Math.abs(cents),
    txn_date: (o.dateCreated || o.dateUpdated || new Date().toISOString()).slice(0, 10),
    memo: `${o.formName || 'TicketSpice'} — ${buyer} (#${o.orderNumber || id})`,
    external_id: String(id),
    raw: o,
  }
}

async function fetchPage({ dateUpdatedAfter, startingAfter }) {
  const url = new URL(`${WEBCONNEX_API_BASE}/search/orders`)
  url.searchParams.set('dateUpdatedAfter', dateUpdatedAfter)
  url.searchParams.set('limit', String(PAGE_LIMIT))
  url.searchParams.set('sort', 'asc')
  if (startingAfter != null) url.searchParams.set('startingAfter', String(startingAfter))

  const res = await fetch(url, { headers: { apiKey: TICKETSPICE_API_KEY, Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Webconnex API ${res.status}: ${await res.text()}`)
  const body = await res.json()
  return {
    orders: Array.isArray(body.data) ? body.data : [],
    hasMore: Boolean(body.hasMore),
    startingAfter: body.startingAfter,
  }
}

async function main() {
  requireEnv()

  if (DRY_RUN) {
    console.log('[dry-run] fetching one page of orders updated after 1970-01-01 …')
    const { orders, hasMore } = await fetchPage({ dateUpdatedAfter: '1970-01-01T00:00:00Z', startingAfter: null })
    console.log(`[dry-run] ${orders.length} order(s) returned, hasMore=${hasMore}`)
    if (orders.length) {
      console.log('\n--- first raw order ---')
      console.log(JSON.stringify(orders[0], null, 2))
      console.log('\n--- mapped transaction rows (first 3) ---')
      console.log(JSON.stringify(orders.slice(0, 3).map(mapOrder), null, 2))
    }
    console.log('\n[dry-run] nothing was written to Supabase.')
    return
  }

  const db = supabase()
  const cursor = await getCursor(db)
  console.log(`[${SOURCE}] pulling orders updated after ${cursor}`)

  try {
    let after = null
    let total = 0
    let newestUpdated = cursor

    while (true) {
      const { orders, hasMore } = await fetchPage({ dateUpdatedAfter: cursor, startingAfter: after })
      if (orders.length === 0) break

      const rows = orders.map(mapOrder)
      const { error } = await db.from('transactions').upsert(rows, { onConflict: 'source,external_id' })
      if (error) throw error
      total += rows.length

      for (const o of orders) {
        if (o.dateUpdated && o.dateUpdated > newestUpdated) newestUpdated = o.dateUpdated
      }
      after = orders[orders.length - 1].id ?? orders[orders.length - 1].orderId
      if (!hasMore) break
    }

    await setCursor(db, newestUpdated, 'ok', `${total} orders`)
    console.log(`[${SOURCE}] done. ${total} orders upserted. cursor -> ${newestUpdated}`)
  } catch (e) {
    await setCursor(db, cursor, 'error', String(e.message || e))
    console.error(`[${SOURCE}] failed:`, e.message || e)
    process.exit(1)
  }
}

main()
