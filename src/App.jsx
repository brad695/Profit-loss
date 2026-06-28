import { useEffect, useMemo, useState } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  Legend, Line, ComposedChart,
} from 'recharts'
import { supabase } from './lib/supabase'

const SOURCES = ['ticketspice', 'honeybook', 'genius', 'table22', 'bank', 'registrations', 'manual']
const usd = (cents) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const monthKey = (d) => d.slice(0, 7) // YYYY-MM
const monthLabel = (k) => {
  const [y, m] = k.split('-')
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
}

export default function App() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [sourceFilter, setSourceFilter] = useState('all')

  async function load() {
    setLoading(true)
    setError(null)
    const { data, error } = await supabase
      .from('transactions')
      .select('id, source, type, category, amount_cents, txn_date, memo')
      .order('txn_date', { ascending: false })
    if (error) setError(error.message)
    else setRows(data || [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const filtered = useMemo(
    () => (sourceFilter === 'all' ? rows : rows.filter((r) => r.source === sourceFilter)),
    [rows, sourceFilter]
  )

  const totals = useMemo(() => {
    let income = 0, expense = 0
    for (const r of filtered) {
      if (r.type === 'income') income += r.amount_cents
      else expense += r.amount_cents
    }
    return { income, expense, net: income - expense }
  }, [filtered])

  const monthly = useMemo(() => {
    const map = new Map()
    for (const r of filtered) {
      const k = monthKey(r.txn_date)
      if (!map.has(k)) map.set(k, { month: k, income: 0, expense: 0 })
      const m = map.get(k)
      if (r.type === 'income') m.income += r.amount_cents
      else m.expense += r.amount_cents
    }
    return [...map.values()]
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((m) => ({
        ...m,
        label: monthLabel(m.month),
        incomeUsd: m.income / 100,
        expenseUsd: m.expense / 100,
        netUsd: (m.income - m.expense) / 100,
      }))
  }, [filtered])

  const byCategory = useMemo(() => {
    const map = new Map()
    for (const r of filtered) {
      const key = `${r.type}:${r.category}`
      if (!map.has(key)) map.set(key, { type: r.type, category: r.category, cents: 0, count: 0 })
      const c = map.get(key)
      c.cents += r.amount_cents
      c.count += 1
    }
    return [...map.values()].sort((a, b) => b.cents - a.cents)
  }, [filtered])

  return (
    <div className="wrap">
      <header className="top">
        <div>
          <h1>ProfitLoss</h1>
          <div className="sub">Live P&amp;L across every revenue and expense source</div>
        </div>
        <div className="controls">
          <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
            <option value="all">All sources</option>
            {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button onClick={load}>Refresh</button>
        </div>
      </header>

      {error && <div className="err">Couldn’t load transactions: {error}</div>}
      {loading ? (
        <div className="loading">Loading…</div>
      ) : (
        <>
          <div className="cards">
            <div className="card">
              <div className="label">Revenue</div>
              <div className="value income">{usd(totals.income)}</div>
            </div>
            <div className="card">
              <div className="label">Expenses</div>
              <div className="value expense">{usd(totals.expense)}</div>
            </div>
            <div className="card">
              <div className="label">Net profit</div>
              <div className={`value net ${totals.net < 0 ? 'negative' : ''}`}>{usd(totals.net)}</div>
            </div>
          </div>

          <div className="panel">
            <h2>Profit &amp; loss by month</h2>
            {monthly.length === 0 ? (
              <div className="empty">No transactions yet.</div>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <ComposedChart data={monthly} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid stroke="#243049" vertical={false} />
                  <XAxis dataKey="label" stroke="#8a96ad" fontSize={12} />
                  <YAxis stroke="#8a96ad" fontSize={12} tickFormatter={(v) => `$${v.toLocaleString()}`} />
                  <Tooltip
                    contentStyle={{ background: '#1a2233', border: '1px solid #243049', borderRadius: 8, color: '#e6ebf5' }}
                    formatter={(v, n) => [`$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2 })}`, n]}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="incomeUsd" name="Revenue" fill="#34d399" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="expenseUsd" name="Expenses" fill="#f87171" radius={[4, 4, 0, 0]} />
                  <Line dataKey="netUsd" name="Net" stroke="#60a5fa" strokeWidth={2} dot={{ r: 3 }} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="grid-2">
            <div className="panel">
              <h2>By category</h2>
              {byCategory.length === 0 ? (
                <div className="empty">No data.</div>
              ) : (
                <table>
                  <thead>
                    <tr><th>Category</th><th></th><th className="num">Amount</th><th className="num">#</th></tr>
                  </thead>
                  <tbody>
                    {byCategory.map((c) => (
                      <tr key={`${c.type}:${c.category}`}>
                        <td>{c.category}</td>
                        <td><span className="pill">{c.type}</span></td>
                        <td className={`num ${c.type === 'income' ? 'pos' : 'neg'}`}>
                          {c.type === 'income' ? '' : '−'}{usd(c.cents)}
                        </td>
                        <td className="num">{c.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="panel">
              <h2>Add a transaction</h2>
              <ManualEntry onSaved={load} />
            </div>
          </div>

          <div className="panel">
            <h2>Recent transactions</h2>
            {filtered.length === 0 ? (
              <div className="empty">Nothing here yet.</div>
            ) : (
              <table>
                <thead>
                  <tr><th>Date</th><th>Source</th><th>Category</th><th>Memo</th><th className="num">Amount</th></tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 50).map((r) => (
                    <tr key={r.id}>
                      <td>{r.txn_date}</td>
                      <td><span className="pill">{r.source}</span></td>
                      <td>{r.category}</td>
                      <td>{r.memo}</td>
                      <td className={`num ${r.type === 'income' ? 'pos' : 'neg'}`}>
                        {r.type === 'income' ? '' : '−'}{usd(r.amount_cents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="foot">
            {filtered.length} transactions · auto-synced sources upsert into the same ledger
          </div>
        </>
      )}
    </div>
  )
}

function ManualEntry({ onSaved }) {
  const today = new Date().toISOString().slice(0, 10)
  const [form, setForm] = useState({ type: 'expense', category: '', amount: '', txn_date: today, memo: '', source: 'manual' })
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  async function save() {
    setMsg(null)
    const amountCents = Math.round(parseFloat(form.amount) * 100)
    if (!form.category.trim() || !Number.isFinite(amountCents) || amountCents < 0) {
      setMsg('Enter a category and a valid amount.')
      return
    }
    setSaving(true)
    const { error } = await supabase.from('transactions').insert({
      source: form.source,
      type: form.type,
      category: form.category.trim(),
      amount_cents: amountCents,
      txn_date: form.txn_date,
      memo: form.memo.trim(),
    })
    setSaving(false)
    if (error) { setMsg(error.message); return }
    setForm((f) => ({ ...f, category: '', amount: '', memo: '' }))
    setMsg('Saved.')
    onSaved?.()
  }

  return (
    <div>
      <div className="entry-row">
        <select value={form.type} onChange={set('type')}>
          <option value="expense">Expense</option>
          <option value="income">Income</option>
        </select>
        <input placeholder="Category" value={form.category} onChange={set('category')} style={{ width: 130 }} />
        <input placeholder="0.00" value={form.amount} onChange={set('amount')} inputMode="decimal" style={{ width: 90 }} />
        <input type="date" value={form.txn_date} onChange={set('txn_date')} />
        <select value={form.source} onChange={set('source')}>
          {['manual', 'table22', 'genius', 'honeybook', 'bank'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input className="memo" placeholder="Memo (optional)" value={form.memo} onChange={set('memo')} />
        <button className="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Add'}</button>
      </div>
      {msg && <div className="sub" style={{ marginTop: 10, color: msg === 'Saved.' ? '#34d399' : '#f87171' }}>{msg}</div>}
    </div>
  )
}
