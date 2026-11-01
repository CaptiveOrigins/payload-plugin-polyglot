'use client'

import React, { useCallback, useEffect, useState } from 'react'

type Counts = { translated: number; pending: number; reviewed: number; stale: number }
type Row = { collection: string; documents: number; locales: Record<string, Counts> }
type Stop = { reason: string; message: string; at: string; help: string }
type Status = { stop: Stop | null; enabled: boolean; paused: boolean; skipped: string[]; charactersThisMonth: number; url: string | null }

/** Coverage per collection and language, filtered by collection, with Translate now. */
export function PolyglotDashboard({ apiRoute, collections, labels }: { apiRoute: string; collections: string[]; labels: Record<string, string> }) {
  const [filter, setFilter] = useState('')
  const [data, setData] = useState<{ locales: string[]; rows: Row[]; settings?: Status } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const load = useCallback(async () => {
    setData(null)
    const res = await fetch(`${apiRoute}/polyglot/coverage${filter ? `?collections=${filter}` : ''}`, { credentials: 'include' })
    if (res.ok) setData(await res.json())
    else setMessage('Could not load coverage.')
  }, [apiRoute, filter])
  useEffect(() => {
    void load()
  }, [load])
  const run = async (body: { collections?: string[]; locales?: string[] }, what: string) => {
    setMessage(`Translating ${what}…`)
    const res = await fetch(`${apiRoute}/polyglot/sync`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const out = (await res.json().catch(() => null)) as { errors?: { message: string }[] } | null
    setMessage(res.ok ? `Started: ${what}. Refresh in a minute to see progress.` : (out?.errors?.[0]?.message ?? 'Could not start.'))
  }
  const scope = filter ? [filter] : undefined
  const pct = (c: Counts, docs: number) => (docs ? Math.round(((c.translated + c.reviewed) / docs) * 100) : 100)
  const cell = { padding: '4px 8px', borderBottom: '1px solid var(--theme-elevation-100)', textAlign: 'center' as const }
  return (
    <div style={{ display: 'grid', gap: 'var(--base)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <label>
          Collection{' '}
          <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ padding: '4px 8px' }}>
            <option value="">All collections</option>
            {collections.map((c) => (
              <option key={c} value={c}>
                {labels[c] ?? c}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn--style-primary btn--size-small" onClick={() => run({ collections: scope }, filter ? labels[filter] ?? filter : 'everything')}>
          Translate now
        </button>
        <button type="button" className="btn btn--style-secondary btn--size-small" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {data?.settings?.stop && (
        <div role="alert" style={{ border: '1px solid var(--theme-error-500)', background: 'var(--theme-error-50)', color: 'var(--theme-error-800)', borderRadius: 4, padding: 'calc(var(--base) / 2) var(--base)' }}>
          <strong>Translation stopped {new Date(data.settings.stop.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.</strong> {data.settings.stop.help}
          <div style={{ fontSize: '0.85em', opacity: 0.8, marginTop: 4 }}>{data.settings.stop.message}</div>
        </div>
      )}
      {data?.settings && (
        <p style={{ margin: 0 }}>
          <strong>Automatic translation:</strong>{' '}
          {!data.settings.enabled ? 'off here (no engine, or turned off for this environment)' : data.settings.stop ? 'stopped (see above)' : data.settings.paused ? 'paused' : 'on'}
          {' · '}
          {data.settings.charactersThisMonth.toLocaleString()} characters sent this month
          {data.settings.skipped.length ? ` · not machine-translated: ${data.settings.skipped.join(', ')}` : ''}
          {data.settings.url && (
            <>
              {' · '}
              <a href={data.settings.url}>Translation settings</a>
            </>
          )}
        </p>
      )}
      {message && <p>{message}</p>}
      {!data ? (
        <p>Loading coverage…</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: '0.9em' }}>
            <thead>
              <tr>
                <th style={{ ...cell, textAlign: 'start' }}>Collection</th>
                {data.locales.map((l) => (
                  <th key={l} style={cell}>
                    <button type="button" title={`Translate ${l} now`} onClick={() => run({ collections: scope, locales: [l] }, l)} style={{ background: 'none', border: 0, cursor: 'pointer', fontWeight: 600 }}>
                      {l}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.collection}>
                  <td style={{ ...cell, textAlign: 'start' }}>
                    <button type="button" title="Translate this collection now" onClick={() => run({ collections: [r.collection] }, labels[r.collection] ?? r.collection)} style={{ background: 'none', border: 0, cursor: 'pointer', textAlign: 'start' }}>
                      {labels[r.collection] ?? r.collection}
                    </button>{' '}
                    <span style={{ color: 'var(--theme-elevation-500)' }}>({r.documents})</span>
                  </td>
                  {data.locales.map((l) => {
                    const c = r.locales[l]!
                    const p = pct(c, r.documents)
                    if (data.settings?.skipped.includes(l))
                      return (
                        <td key={l} style={{ ...cell, color: 'var(--theme-elevation-400)' }} title="Not machine-translated (Translation settings)">
                          –
                        </td>
                      )
                    return (
                      <td key={l} style={{ ...cell, color: p === 100 ? 'var(--theme-success-600)' : undefined }} title={`${c.translated} machine, ${c.reviewed} reviewed, ${c.stale} reviewed but source changed, ${c.pending} pending`}>
                        {p}%{c.stale ? ' ⚠' : ''}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p style={{ color: 'var(--theme-elevation-500)', fontSize: '0.85em' }}>
        Percent of documents translated (machine or reviewed). ⚠ marks reviewed translations whose source has changed. Click a language or collection to translate just that. – marks languages not machine-translated.
      </p>
    </div>
  )
}
