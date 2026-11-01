import { APIError, addDataAndFileToRequest, type Endpoint, type PayloadRequest } from 'payload'

import { charactersThisMonth, loadSettings } from './settings.js'
import { coverage, polyglotOf, syncAll } from './translate.js'

const allowed = async (req: PayloadRequest) => {
  const o = polyglotOf(req.payload)
  if (!req.user) throw new APIError('Sign in first.', 401, undefined, true)
  if (!(await (o.canManage ?? (() => true))({ req }))) throw new APIError('Not allowed.', 403, undefined, true)
  return o
}
const list = (v: unknown) => (typeof v === 'string' && v ? v.split(',') : Array.isArray(v) ? v.map(String) : undefined)

/** GET /api/polyglot/coverage?collections=pages,posts */
export const coverageEndpoint: Endpoint = {
  path: '/polyglot/coverage',
  method: 'get',
  handler: async (req) => {
    const o = await allowed(req)
    const rows = await coverage(req.payload, { collections: list(req.searchParams?.get('collections')) })
    const s = await loadSettings(req.payload, o)
    const enabled = o.enabled ? await o.enabled({ payload: req.payload, req }) : true
    return Response.json({
      locales: o.locales,
      rows,
      settings: { enabled, paused: s.paused, skipped: [...s.skipLocales], charactersThisMonth: charactersThisMonth(s), url: o.settings ? `${req.payload.config.routes.admin}/globals/${o.settingsSlug}` : null },
    })
  },
}

/** POST /api/polyglot/sync { collections?, locales? }: translate now (after the response in Next.js). */
export const syncEndpoint: Endpoint = {
  path: '/polyglot/sync',
  method: 'post',
  handler: async (req) => {
    const o = await allowed(req)
    if (o.enabled && !(await o.enabled({ payload: req.payload, req }))) throw new APIError('Translation is turned off here.', 400, undefined, true)
    await addDataAndFileToRequest(req)
    const filters = { collections: list(req.data?.collections), locales: list(req.data?.locales) }
    const run = () => syncAll(req.payload, { ...filters, force: true }).then((r) => req.payload.logger.info({ ...r, ...filters }, 'Polyglot: translate now'))
    try {
      const { after } = await import('next/server.js')
      after(run)
      return Response.json({ started: true })
    } catch {
      return Response.json({ started: true, report: await run() })
    }
  },
}
