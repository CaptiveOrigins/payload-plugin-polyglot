import { DefaultTemplate } from '@payloadcms/next/templates'
import type { AdminViewServerProps, Payload, PayloadRequest } from 'payload'
import React from 'react'

import { mayManage } from '../access.js'
import { PolyglotDashboard } from '../client/PolyglotDashboard.js'
import { loadSettings, STOP_HELP } from '../settings.js'
import { polyglotOf } from '../translate.js'

const labelOf = (payload: Payload, slug: string) => {
  const l = payload.collections[slug as never]?.config.labels?.plural
  return typeof l === 'string' ? l : slug
}

/** /admin/polyglot: coverage per collection and language, Translate now. */
export async function PolyglotView({ initPageResult, params, searchParams }: AdminViewServerProps) {
  const { req, permissions, visibleEntities, locale } = initPageResult
  const o = polyglotOf(req.payload)
  const allowed = await mayManage(o, req)
  const collections = Object.keys(o.collections)
  return (
    <DefaultTemplate i18n={req.i18n} locale={locale} params={params} payload={req.payload} permissions={permissions} req={req} searchParams={searchParams} user={req.user ?? undefined} visibleEntities={visibleEntities}>
      <div className="gutter--left gutter--right" style={{ paddingBlock: 'calc(var(--base) * 2)' }}>
        <h1>Translations</h1>
        {allowed ? (
          <PolyglotDashboard
            apiRoute={req.payload.config.routes.api}
            collections={collections}
            labels={Object.fromEntries(collections.map((c) => [c, labelOf(req.payload, c)]))}
          />
        ) : (
          <p>You don’t have access to translations.</p>
        )}
      </div>
    </DefaultTemplate>
  )
}

const managerSignedIn = (payload: Payload, user: unknown) => mayManage(polyglotOf(payload), { user, payload } as unknown as PayloadRequest)

/** Nav link, for people who may manage translations (⚠ while translation is stopped). */
export async function PolyglotNavLink({ payload, user }: { payload: Payload; user?: unknown }) {
  if (!(await managerSignedIn(payload, user))) return null
  const { stop } = await loadSettings(payload, polyglotOf(payload))
  return (
    <a className="nav__link" href={`${payload.config.routes.admin}/polyglot`} style={{ display: 'block', marginTop: 'calc(var(--base) / 2)' }} title={stop ? 'Translation has stopped' : undefined}>
      <span className="nav__link-label">Translations{stop ? ' ⚠' : ''}</span>
    </a>
  )
}

/** Dashboard banner while translation is stopped (credits, quota, key), for people who may manage translations. */
export async function PolyglotStopBanner({ payload, user }: { payload: Payload; user?: unknown }) {
  if (!(await managerSignedIn(payload, user))) return null
  const { stop } = await loadSettings(payload, polyglotOf(payload))
  if (!stop) return null
  return <StopNotice stop={stop} href={`${payload.config.routes.admin}/polyglot`} />
}

function StopNotice({ stop, href }: { stop: { reason: keyof typeof STOP_HELP; message: string; at: string }; href?: string }) {
  return (
    <div role="alert" style={{ border: '1px solid var(--theme-error-500)', background: 'var(--theme-error-50)', color: 'var(--theme-error-800)', borderRadius: 4, padding: 'calc(var(--base) / 2) var(--base)', marginBottom: 'var(--base)' }}>
      <strong>Translation stopped {new Date(stop.at).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })}.</strong> {STOP_HELP[stop.reason]}{' '}
      {href && <a href={href}>Open Translations</a>}
      <div style={{ fontSize: '0.85em', opacity: 0.8, marginTop: 4 }}>{stop.message}</div>
    </div>
  )
}
