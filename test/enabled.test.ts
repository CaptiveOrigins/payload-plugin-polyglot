import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { translationEnabled } from '../src/access.js'
import { coverageEndpoint, syncEndpoint } from '../src/endpoints.js'
import { polyglotPlugin, syncAll, type Item, type Translator } from '../src/index.js'

// Next's `after()` runs the work here and now, so a translation that starts is seen by the fake translator.
const pending: Promise<unknown>[] = []
vi.mock('next/server.js', () => ({ after: (fn: () => Promise<unknown>) => void pending.push(fn()) }))
const settle = async () => {
  await Promise.all(pending.splice(0))
}

/** A made-up install with a fake translator that only records what it's sent; no translation service is called. */
let payload: Payload
let mongo: MongoMemoryReplSet
const sent: string[] = []
const translator: Translator = {
  translate: async ({ locale, items }) => {
    sent.push(...items.map((i) => `${locale}:${i.text}`))
    return new Map(items.map((i: Item) => [i.key, `[${locale}] ${i.text}`]))
  },
}
let answer: () => unknown = () => true
const asked: { payload?: unknown; req?: { user?: unknown; payload?: unknown } }[] = []

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  payload = await getPayload({
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri('polyglot-enabled'), ensureIndexes: true }),
      localization: { locales: ['en', 'es'], defaultLocale: 'en', fallback: true },
      admin: { user: 'users' },
      collections: [
        { slug: 'users', auth: true, fields: [] },
        { slug: 'pages', versions: { drafts: true }, fields: [{ name: 'title', type: 'text', required: true }] },
      ],
      plugins: [polyglotPlugin({ collections: { pages: ['title'] }, translator, enabled: ((args: (typeof asked)[number]) => (asked.push(args), answer())) as never })],
    }),
  })
}, 120_000)

afterAll(async () => {
  await payload?.destroy()
  await mongo?.stop()
})

const admin = { id: 'a1', collection: 'users' }
const status = (p: unknown) => (p as Promise<unknown>).then(() => 200, (e: { status?: number }) => e.status ?? 500)
const publish = (title: string) => payload.create({ collection: 'pages' as never, data: { title, _status: 'published' } as never })
const reported = async () => ((await (coverageEndpoint.handler({ payload, user: admin, searchParams: new URLSearchParams() } as never) as Promise<Response>)).json() as Promise<{ settings: { enabled: unknown } }>)

const nonAnswers: [string, () => unknown][] = [
  ['1', () => 1],
  ["'yes'", () => 'yes'],
  ['{}', () => ({})],
  ['an array', () => [true]],
  ['a resolved truthy string', async () => 'true'],
  ['a throw', () => { throw new Error('no key here') }],
  ['a rejection', () => Promise.reject(new Error('no key here'))],
]

describe('whether translation may run (2026-11-11)', () => {
  it.each(nonAnswers)('counts %s from enabled as turned off: no publish translation, sync 400, coverage says off', async (_, a) => {
    answer = a
    sent.length = 0
    await publish(`Off page ${_}`)
    await settle()
    expect(await status(syncEndpoint.handler({ payload, user: admin } as never))).toBe(400)
    await settle()
    expect(sent).toEqual([])
    expect((await reported()).settings.enabled).toBe(false)
  })

  it('runs with exactly true, on publish and from translate now', async () => {
    answer = () => true
    sent.length = 0
    await publish('On page')
    await settle()
    expect(sent).toContain('es:On page')
    expect((await reported()).settings.enabled).toBe(true)
    sent.length = 0
    await payload.update({ collection: 'pages' as never, where: { title: { equals: 'On page' } }, data: { title: 'On page, edited' } as never, context: { polyglot: true } })
    expect(await status(syncEndpoint.handler({ payload, user: admin } as never))).toBe(200)
    await settle()
    expect(sent).toContain('es:On page, edited')
  })

  it.each([['false', () => false] as [string, () => unknown], ...nonAnswers])('skips the whole sweep when enabled answers %s: no translator calls', async (_, a) => {
    answer = () => true
    await publish(`Sweep page ${_}`) // published while on, edited below while off, so the sweep would have work
    await settle()
    answer = a
    await payload.update({ collection: 'pages' as never, where: { title: { equals: `Sweep page ${_}` } }, data: { title: `Sweep page ${_}, edited` } as never })
    await settle()
    sent.length = 0
    expect(await syncAll(payload)).toMatchObject({ stopped: 'off', documents: 0, translated: 0 })
    expect(await syncAll(payload, { force: true, dryRun: true })).toMatchObject({ stopped: 'off', documents: 0 })
    expect(sent).toEqual([])
  })

  it('runs the sweep with exactly true, asking enabled with a local request that has no user', async () => {
    answer = () => false
    await publish('Sweep on page')
    answer = () => true
    sent.length = 0
    asked.length = 0
    const r = await syncAll(payload)
    expect(r.stopped).toBe('done')
    expect(r.translated).toBeGreaterThan(0)
    expect(sent).toContain('es:Sweep on page')
    expect(asked[0]?.payload).toBe(payload)
    expect(asked[0]?.req?.payload).toBe(payload)
    expect(asked[0]?.req?.user).toBeFalsy()
  })

  it('runs when the site gives no enabled option', async () => {
    expect(await translationEnabled({ enabled: undefined }, payload)).toBe(true)
  })
})
