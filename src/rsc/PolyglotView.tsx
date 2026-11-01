import { DefaultTemplate } from '@payloadcms/next/templates'
import type { AdminViewServerProps, Payload, PayloadRequest } from 'payload'
import React from 'react'

import { PolyglotDashboard } from '../client/PolyglotDashboard.js'
import { polyglotOf } from '../translate.js'

const labelOf = (payload: Payload, slug: string) => {
  const l = payload.collections[slug as never]?.config.labels?.plural
  return typeof l === 'string' ? l : slug
}

/** /admin/polyglot: coverage per collection and language, Translate now. */
export async function PolyglotView({ initPageResult, params, searchParams }: AdminViewServerProps) {
  const { req, permissions, visibleEntities, locale } = initPageResult
  const o = polyglotOf(req.payload)
  const allowed = Boolean(req.user) && (await (o.canManage ?? (() => true))({ req }))
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

/** Nav link, for people who may manage translations. */
export async function PolyglotNavLink({ payload, user }: { payload: Payload; user?: unknown }) {
  const o = polyglotOf(payload)
  if (!user || !(await (o.canManage ?? (() => true))({ req: { user, payload } as unknown as PayloadRequest }))) return null
  return (
    <a className="nav__link" href={`${payload.config.routes.admin}/polyglot`} style={{ display: 'block', marginTop: 'calc(var(--base) / 2)' }}>
      <span className="nav__link-label">Translations</span>
    </a>
  )
}
