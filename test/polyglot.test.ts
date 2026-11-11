import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { coverageEndpoint, syncEndpoint } from '../src/endpoints.js'
import { coverage, languageStatus, loadSettings, microsoftTranslator, polyglotPlugin, QuotaExceededError, syncAll, translateDocument, type Item, type Translator } from '../src/index.js'

let payload: Payload
let mongo: MongoMemoryReplSet
const sent: { locale: string; texts: string[]; keep?: string[]; instructions?: string; glossary?: { term: string; translation: string }[] }[] = []
let quotaAfter = Infinity
let stopWith: QuotaExceededError | undefined
const stops: string[] = []
const fake = (locale: string, text: string) => `[${locale}] ${text}`
const translator: Translator = {
  translate: async ({ locale, items, keep, instructions, glossary }) => {
    if (stopWith) throw stopWith
    if (sent.length >= quotaAfter) throw new QuotaExceededError()
    sent.push({ locale, texts: items.map((i) => i.text), keep, instructions, glossary })
    return new Map(items.map((i: Item) => [i.key, fake(locale, i.text)]))
  },
  batch: async (requests) => {
    sent.push({ locale: 'batch', texts: requests.flatMap((r) => r.items.map((i) => i.text)) })
    return requests.map((r) => new Map(r.items.map((i) => [i.key, fake(r.locale, i.text)])))
  },
}
const lexical = (...texts: string[]) => ({
  root: {
    type: 'root',
    version: 1,
    children: texts.map((t) => ({ type: 'paragraph', version: 1, children: [{ type: 'text', text: t, version: 1, format: 0 }] })),
  },
})

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  payload = await getPayload({
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri('polyglot'), ensureIndexes: true }),
      localization: { locales: ['en', 'es', 'fr'], defaultLocale: 'en', fallback: true },
      collections: [
        {
          slug: 'pages',
          versions: { drafts: true },
          fields: [
            { name: 'title', type: 'text', required: true },
            { name: 'slug', type: 'text' },
            { name: 'body', type: 'json' },
            { name: 'links', type: 'array', fields: [{ name: 'label', type: 'text' }, { name: 'url', type: 'text' }] },
            { name: 'sections', type: 'array', fields: [{ name: 'heading', type: 'text' }, { name: 'note', type: 'text' }] },
          ],
        },
      ],
      plugins: [polyglotPlugin({ collections: { pages: ['title', 'body', 'links', 'sections.heading'] }, translator, keep: ['OnePedigree'], onStop: ({ stop }) => void stops.push(stop.reason) })],
    }),
  })
}, 120_000)

afterAll(async () => {
  await payload?.destroy()
  await mongo?.stop()
})

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const read = (id: string, locale: string) => payload.findByID({ collection: 'pages' as never, id, locale: locale as never, depth: 0 }) as Promise<Doc>

describe('microsoft translator', () => {
  it('protects placeholders and kept terms, and stops on a used-up quota', async () => {
    const seen: string[] = []
    const real = globalThis.fetch
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { Text: string }[]
      seen.push(...body.map((b) => b.Text))
      return new Response(JSON.stringify(body.map((b) => ({ translations: [{ text: b.Text.replace('Hello', 'Hola') }] }))), { status: 200 })
    }) as typeof fetch
    try {
      const t = microsoftTranslator({ key: 'k', region: 'westeurope' })
      const out = await t.translate({ locale: 'es', sourceLocale: 'en', keep: ['OnePedigree'], items: [{ key: '0', text: 'Hello {name} & OnePedigree <3' }] })
      expect(seen[0]).toBe('Hello <span translate="no">{name}</span> &amp; <span translate="no">OnePedigree</span> &lt;3')
      expect(out.get('0')).toBe('Hola {name} & OnePedigree <3')
      globalThis.fetch = (async () => new Response('quota', { status: 403 })) as typeof fetch
      await expect(t.translate({ locale: 'es', sourceLocale: 'en', keep: [], items: [{ key: '0', text: 'x' }] })).rejects.toBeInstanceOf(QuotaExceededError)
    } finally {
      globalThis.fetch = real
    }
  })
})

describe('polyglot', () => {
  let id: string

  it('translates every language, leaving links, slugs and placeholder copy alone', async () => {
    const page = await payload.create({
      collection: 'pages' as never,
      data: {
        title: 'Hello world',
        slug: 'hello-world',
        body: lexical('First sentence.', 'Lorem ipsum dolor sit amet.', 'Ut enim ad minim veniam, quis nostrud exercitation.'),
        links: [{ label: 'Read more', url: 'https://example.com/more' }],
        sections: [{ heading: 'Intro', note: 'shared note' }],
        _status: 'published',
      } as never,
    })
    id = String(page.id)
    const r = await translateDocument(payload, 'pages', id)
    expect(r.translated.sort()).toEqual(['es', 'fr'])
    const es = await read(id, 'es')
    expect(es.title).toBe('[es] Hello world')
    expect(es.slug).toBe('hello-world')
    expect(es.body.root.children[0].children[0].text).toBe('[es] First sentence.')
    expect(es.body.root.children[1].children[0].text).toBe('Lorem ipsum dolor sit amet.')
    expect(es.links[0]).toMatchObject({ label: '[es] Read more', url: 'https://example.com/more' })
    expect(es.sections[0]).toMatchObject({ heading: '[es] Intro', note: 'shared note' })
    expect(sent.flatMap((s) => s.texts)).not.toContain('Lorem ipsum dolor sit amet.')
    expect(sent.flatMap((s) => s.texts)).not.toContain('Ut enim ad minim veniam, quis nostrud exercitation.')
    expect(sent[0]!.keep).toEqual(['OnePedigree'])
    expect(await languageStatus(payload, 'pages', { id }, 'es')).toBe('machine')
  })

  it('costs nothing when nothing changed, and sends only changed sentences', async () => {
    sent.length = 0
    const again = await translateDocument(payload, 'pages', id)
    expect(again.upToDate.sort()).toEqual(['es', 'fr'])
    expect(sent).toHaveLength(0)
    await payload.update({ collection: 'pages' as never, id, locale: 'en' as never, data: { title: 'Hello there', _status: 'published' } as never })
    await translateDocument(payload, 'pages', id)
    expect(sent.map((s) => s.texts)).toEqual([['Hello there'], ['Hello there']])
    expect((await read(id, 'fr')).title).toBe('[fr] Hello there')
  })

  it('never overwrites a reviewed language; marks it stale instead', async () => {
    await payload.update({ collection: 'pages' as never, id, locale: 'es' as never, data: { title: 'Hola (revisado)' } as never })
    const en = await read(id, 'en')
    await payload.update({ collection: 'pages' as never, id, locale: 'en' as never, data: { translations: { ...en.translations, reviewed: ['es'] } } as never })
    await payload.update({ collection: 'pages' as never, id, locale: 'en' as never, data: { title: 'Hello again', _status: 'published' } as never })
    const r = await translateDocument(payload, 'pages', id)
    expect(r).toMatchObject({ translated: ['fr'], reviewedStale: ['es'] })
    expect((await read(id, 'es')).title).toBe('Hola (revisado)')
    expect(await languageStatus(payload, 'pages', await read(id, 'en'), 'es')).toBe('stale')
  })

  it('sweeps everything, through the batch API when asked', async () => {
    await payload.create({ collection: 'pages' as never, data: { title: 'Second page', slug: 'second', _status: 'published' } as never })
    await payload.create({ collection: 'pages' as never, data: { title: 'A draft', slug: 'draft', _status: 'draft' } as never })
    expect(await syncAll(payload, { dryRun: true })).toMatchObject({ documents: 2, pending: 2 })
    sent.length = 0
    const r = await syncAll(payload, { useBatch: true })
    expect(r).toMatchObject({ documents: 2, translated: 2, failed: 0 })
    expect(sent.map((s) => s.locale)).toEqual(['batch'])
    expect(await syncAll(payload, { dryRun: true })).toMatchObject({ pending: 0 })
  })

  it('reports coverage and translates by collection and language on request', async () => {
    const page = await payload.create({ collection: 'pages' as never, data: { title: 'Fourth', _status: 'published' } as never })
    const before = (await coverage(payload, { collections: ['pages'] }))[0]!
    expect(before.locales.es!.pending).toBeGreaterThan(0)
    const r = await syncAll(payload, { collections: ['pages'], locales: ['fr'] })
    expect(r.translated).toBeGreaterThan(0)
    expect(await languageStatus(payload, 'pages', { id: page.id }, 'fr')).toBe('machine')
    expect(await languageStatus(payload, 'pages', { id: page.id }, 'es')).toBe('pending')
  })

  it('stops cleanly when the engine quota is used up, and continues next run', async () => {
    await payload.create({ collection: 'pages' as never, data: { title: 'Third page', _status: 'published' } as never })
    sent.length = 0
    quotaAfter = 1
    const first = await syncAll(payload)
    expect(first.stopped).toBe('quota')
    expect(first.pending).toBeGreaterThan(0)
    quotaAfter = Infinity
    expect(await syncAll(payload)).toMatchObject({ stopped: 'done', failed: 0 })
    expect(await syncAll(payload, { dryRun: true })).toMatchObject({ pending: 0 })
  })

  it('tells admins once when credits run out, and clears when translation works again', async () => {
    const o = payload.config.custom.polyglot
    stops.length = 0
    await payload.create({ collection: 'pages' as never, data: { title: 'Credits page', _status: 'published' } as never })
    stopWith = new QuotaExceededError('Claude: Your credit balance is too low', 'credits')
    expect(await syncAll(payload)).toMatchObject({ stopped: 'quota', stopReason: 'credits' })
    await syncAll(payload)
    expect(stops).toEqual(['credits'])
    expect((await loadSettings(payload, o)).stop).toMatchObject({ reason: 'credits', message: 'Claude: Your credit balance is too low' })
    stopWith = undefined
    expect(await syncAll(payload)).toMatchObject({ stopped: 'done', failed: 0 })
    expect((await loadSettings(payload, o)).stop).toBeUndefined()
  })

  it('follows the Translation settings: pause, skipped languages, terms, notes, glossary, usage', async () => {
    const o = payload.config.custom.polyglot
    await payload.updateGlobal({
      slug: 'polyglot-settings' as never,
      data: { paused: true, skipLocales: ['fr'], keep: 'Captive Origins\n', instructions: 'Be formal.', glossary: [{ locale: 'es', term: 'keeper', translation: 'cuidador' }] } as never,
    })
    const page = await payload.create({ collection: 'pages' as never, data: { title: 'Settings page', _status: 'published' } as never })
    expect(await syncAll(payload)).toMatchObject({ stopped: 'paused', translated: 0 })
    sent.length = 0
    const r = await syncAll(payload, { force: true })
    expect(r.stopped).toBe('done')
    expect(sent.map((x) => x.locale)).toEqual(['es'])
    expect(sent[0]).toMatchObject({ keep: ['OnePedigree', 'Captive Origins'], instructions: 'Be formal.', glossary: [{ term: 'keeper', translation: 'cuidador' }] })
    expect(await languageStatus(payload, 'pages', { id: page.id }, 'fr')).toBe('pending')
    const s = await loadSettings(payload, o)
    expect(s.usage.at(-1)!.characters).toBeGreaterThan(0)
  })
})

describe('access and data safety', () => {
  const reset = () =>
    payload.updateGlobal({ slug: 'polyglot-settings' as never, data: { paused: false, skipLocales: [], keep: '', instructions: '', glossary: [], maxCharactersPerRun: null } as never })

  it('refuses the endpoints to signed-out people, people canManage refuses, and when turned off', async () => {
    const status = (p: Promise<unknown>) => p.then(() => 200, (e: { status?: number }) => e.status)
    expect(await status(coverageEndpoint.handler({ payload, user: null, searchParams: new URLSearchParams() } as never) as Promise<unknown>)).toBe(401)
    expect(await status(syncEndpoint.handler({ payload, user: null } as never) as Promise<unknown>)).toBe(401)
    const o = payload.config.custom.polyglot
    const withOptions = (extra: object) => ({ config: { ...payload.config, custom: { polyglot: { ...o, ...extra } } } })
    const user = { id: 'u1', collection: 'users' }
    expect(await status(coverageEndpoint.handler({ payload: withOptions({ canManage: () => false }), user } as never) as Promise<unknown>)).toBe(403)
    expect(await status(syncEndpoint.handler({ payload: withOptions({ canManage: () => false }), user } as never) as Promise<unknown>)).toBe(403)
    expect(await status(syncEndpoint.handler({ payload: withOptions({ enabled: () => false }), user } as never) as Promise<unknown>)).toBe(400)
  })

  it('keeps memory and status hidden from signed-out people, and read-only for everyone', async () => {
    for (const collection of ['polyglot-memory', 'polyglot-state']) {
      await expect(payload.find({ collection: collection as never, overrideAccess: false })).rejects.toThrow()
      await expect(
        payload.create({ collection: collection as never, data: { key: 'x', locale: 'es', source: 'a', text: 'b', collection: 'pages', doc: '1', hash: 'h' } as never, overrideAccess: false, user: { id: 'u1', collection: 'users' } as never }),
      ).rejects.toThrow()
    }
    await expect(payload.findGlobal({ slug: 'polyglot-settings' as never, overrideAccess: false })).rejects.toThrow()
  })

  it('never changes the slug when another language is saved', async () => {
    const page = await payload.create({ collection: 'pages' as never, data: { title: 'Identity', slug: 'identity', _status: 'published' } as never })
    await payload.update({ collection: 'pages' as never, id: page.id, locale: 'es' as never, data: { title: 'Identidad', slug: 'identidad' } as never })
    expect((await read(String(page.id), 'en')).slug).toBe('identity')
  })

  it('writes nothing for a language the engine only half translated, and tries again next run', async () => {
    await reset()
    const page = await payload.create({ collection: 'pages' as never, data: { title: 'Half', sections: [{ heading: 'Part one' }], _status: 'published' } as never })
    const id = String(page.id)
    const real = translator.translate
    translator.translate = async (a) => new Map([...(await real(a))].filter(([, t]) => !t.includes('Part one')))
    const r = await translateDocument(payload, 'pages', id, { locales: ['es'] })
    translator.translate = real
    expect(r.failed).toEqual(['es'])
    expect((await read(id, 'es')).title).toBe('Half') // the default language (fallback), not a partial translation
    expect(await languageStatus(payload, 'pages', { id }, 'es')).toBe('pending')
    expect((await translateDocument(payload, 'pages', id, { locales: ['es'] })).translated).toEqual(['es'])
  })

  it('records an engine error as a failure, not a stop', async () => {
    await reset()
    stops.length = 0
    const page = await payload.create({ collection: 'pages' as never, data: { title: 'Broken engine', _status: 'published' } as never })
    const real = translator.translate
    translator.translate = async () => {
      throw new Error('network down')
    }
    const r = await translateDocument(payload, 'pages', String(page.id), { locales: ['es'] })
    translator.translate = real
    expect(r.failed).toEqual(['es'])
    expect(stops).toEqual([])
    expect((await loadSettings(payload, payload.config.custom.polyglot)).stop).toBeUndefined()
  })

  it('stops a sweep at the character cap from Translation settings', async () => {
    await reset()
    await syncAll(payload) // catch up first
    await payload.create({ collection: 'pages' as never, data: { title: 'A title well over ten characters', _status: 'published' } as never })
    await payload.updateGlobal({ slug: 'polyglot-settings' as never, data: { maxCharactersPerRun: 10 } as never })
    sent.length = 0
    const r = await syncAll(payload)
    expect(r).toMatchObject({ stopped: 'budget', characters: 0 })
    expect(sent).toHaveLength(0)
    await reset()
  })
})
