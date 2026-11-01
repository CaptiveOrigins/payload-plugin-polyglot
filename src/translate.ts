import type { CollectionSlug, Payload } from 'payload'

import { fingerprint, memoryKey, textsOf, visitPaths, type Json } from './text.js'
import { QuotaExceededError, type DocumentResult, type Item, type ResolvedPolyglot, type TranslateArgs } from './types.js'

type StateRow = { id: string; key: string; locale: string; hash: string; stale?: boolean | null }

export const polyglotOf = (payload: Payload) => payload.config.custom?.polyglot as ResolvedPolyglot

const rulesOf = (o: ResolvedPolyglot) => ({ skip: o.skip, skipKeys: new Set(o.skipKeys) })
const topFields = (o: ResolvedPolyglot, slug: string) => [...new Set((o.collections[slug] ?? []).map((p) => p.split('.')[0]!))]
const stateKey = (collection: string, id: string, locale: string) => `${collection}:${id}:${locale}`
const engineFor = (o: ResolvedPolyglot, locale: string) => o.translatorFor?.(locale) ?? o.translator

/** Is this document one Polyglot translates? */
export function included(o: ResolvedPolyglot, collection: string, doc: Record<string, unknown>) {
  if (!o.collections[collection]) return false
  if (o.include) return o.include({ collection, doc })
  return doc._status === undefined || doc._status === 'published'
}

async function loadSource(payload: Payload, o: ResolvedPolyglot, slug: string, id: string) {
  const doc = (await payload.findByID({
    collection: slug as CollectionSlug,
    id,
    locale: o.defaultLocale as never,
    depth: 0,
    draft: false,
    overrideAccess: true,
    disableErrors: true,
  })) as Record<string, unknown> | null
  if (!doc || !included(o, slug, doc)) return null
  const source = Object.fromEntries(topFields(o, slug).filter((k) => doc[k] !== undefined && doc[k] !== null).map((k) => [k, structuredClone(doc[k]) as Json]))
  const texts = textsOf(source, o.collections[slug]!, rulesOf(o))
  const reviewed = new Set(((doc[o.statusField] as { reviewed?: string[] | null } | undefined)?.reviewed ?? []) as string[])
  const { docs } = await payload.find({
    collection: o.stateSlug as CollectionSlug,
    where: { and: [{ collection: { equals: slug } }, { doc: { equals: id } }] },
    pagination: false,
    depth: 0,
    overrideAccess: true,
  })
  const state = new Map((docs as unknown as StateRow[]).map((r) => [r.locale, r]))
  return { doc, source, texts, hash: fingerprint(texts), state, reviewed }
}

async function saveState(payload: Payload, o: ResolvedPolyglot, collection: string, id: string, locale: string, hash: string, stale: boolean, existing?: StateRow) {
  const data = { key: stateKey(collection, id, locale), collection, doc: id, locale, hash, stale, at: new Date().toISOString() }
  if (existing) await payload.update({ collection: o.stateSlug as CollectionSlug, id: existing.id, data: data as never, overrideAccess: true })
  else await payload.create({ collection: o.stateSlug as CollectionSlug, data: data as never, overrideAccess: true })
}

/** Translations known in memory for these texts in one language. */
async function recall(payload: Payload, o: ResolvedPolyglot, locale: string, texts: string[]) {
  const known = new Map<string, string>()
  if (!texts.length) return known
  const { docs } = await payload.find({
    collection: o.memorySlug as CollectionSlug,
    where: { key: { in: texts.map((t) => memoryKey(locale, t)) } },
    pagination: false,
    depth: 0,
    overrideAccess: true,
    select: { key: true, text: true } as never,
  })
  const byKey = new Map((docs as unknown as { key: string; text: string }[]).map((d) => [d.key, d.text]))
  for (const t of texts) {
    const hit = byKey.get(memoryKey(locale, t))
    if (hit) known.set(t, hit)
  }
  return known
}

async function remember(payload: Payload, o: ResolvedPolyglot, locale: string, pairs: [string, string][]) {
  for (const [source, text] of pairs)
    await payload
      .create({ collection: o.memorySlug as CollectionSlug, data: { key: memoryKey(locale, source), locale, source, text } as never, overrideAccess: true })
      .catch(() => undefined) // already remembered (unique key)
}

const CHUNK = 80
const chunks = <T>(list: T[]) => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK))
const argsFor = (o: ResolvedPolyglot, locale: string, items: Item[], context?: string): TranslateArgs => ({
  locale,
  items,
  context,
  sourceLocale: o.defaultLocale,
  keep: o.keep,
})

/** A per-run character budget (free tiers). */
export class Budget {
  used = 0
  constructor(private readonly max?: number) {}
  allows(chars: number) {
    return this.max === undefined || this.used + chars <= this.max
  }
  spend(chars: number) {
    this.used += chars
  }
}

/**
 * Bring one document up to date in every language (or `locales`). Unchanged
 * source costs nothing (the fingerprint matches); known sentences come from
 * memory; only new ones reach the translator. Reviewed languages are never
 * overwritten: they are marked stale. Languages are written one at a time.
 */
export async function translateDocument(
  payload: Payload,
  collection: string,
  id: string,
  opts: { locales?: string[]; dryRun?: boolean; memoryOnly?: boolean; inRequest?: boolean; budget?: Budget } = {},
): Promise<DocumentResult> {
  const o = polyglotOf(payload)
  const result: DocumentResult = { translated: [], upToDate: [], reviewedStale: [], failed: [], pending: [] }
  const src = await loadSource(payload, o, collection, id)
  if (!src) return result
  const todo: string[] = []
  for (const locale of opts.locales ?? o.locales) {
    const row = src.state.get(locale)
    if (row?.hash === src.hash) result.upToDate.push(locale)
    else if (src.reviewed.has(locale)) {
      result.reviewedStale.push(locale)
      if (!opts.dryRun && row && !row.stale) await saveState(payload, o, collection, id, locale, row.hash, true, row)
    } else todo.push(locale)
  }
  if (opts.dryRun) return { ...result, pending: todo }
  const unique = [...new Set(src.texts)]
  const context = { ...(o.writeContext?.({ inRequest: Boolean(opts.inRequest) }) ?? {}), polyglot: true }
  for (const [n, locale] of todo.entries()) {
    try {
      let known = await recall(payload, o, locale, unique)
      const missing = unique.filter((t) => !known.has(t))
      if (missing.length && !opts.memoryOnly) {
        const chars = missing.reduce((s, t) => s + t.length, 0)
        if (opts.budget && !opts.budget.allows(chars)) {
          result.pending.push(...todo.slice(n))
          break
        }
        for (const part of chunks(missing)) {
          const items = part.map((text, i) => ({ key: String(i), text }))
          const out = await engineFor(o, locale).translate(argsFor(o, locale, items, o.describe?.(collection)))
          opts.budget?.spend(part.reduce((s, t) => s + t.length, 0))
          await remember(payload, o, locale, items.flatMap((it) => (out.get(it.key) ? [[it.text, out.get(it.key)!] as [string, string]] : [])))
        }
        known = await recall(payload, o, locale, unique)
      }
      if (unique.some((t) => !known.has(t))) {
        ;(opts.memoryOnly ? result.pending : result.failed).push(locale)
        continue
      }
      const data = structuredClone(src.source)
      visitPaths(data, o.collections[collection]!, rulesOf(o), (t, set) => set(known.get(t) ?? t))
      await payload.update({
        collection: collection as CollectionSlug,
        id,
        locale: locale as never,
        data: { ...data, ...(src.doc._status ? { _status: 'published' } : {}) } as never,
        overrideAccess: true,
        context,
      })
      await saveState(payload, o, collection, id, locale, src.hash, false, src.state.get(locale))
      result.translated.push(locale)
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        result.pending.push(...todo.slice(n))
        throw Object.assign(error, { result })
      }
      payload.logger.error({ err: error, collection, id, locale }, 'Polyglot: translation failed')
      result.failed.push(locale)
    }
  }
  return result
}

export type SyncReport = {
  documents: number
  upToDate: number
  translated: number
  pending: number
  reviewedStale: number
  failed: number
  characters: number
  stopped: 'done' | 'budget' | 'quota'
}

/**
 * Find all content and bring it up to date (the sweep). With a translator that
 * has `batch` and `useBatch`, every missing sentence of every language goes in
 * one batch first (cheaper), then documents are written from memory. Stops
 * cleanly at `maxCharactersPerRun` or when the engine's quota is used up; the
 * next run continues. `dryRun` only reports what is pending.
 */
export async function syncAll(payload: Payload, opts: { dryRun?: boolean; useBatch?: boolean; limit?: number } = {}): Promise<SyncReport> {
  const o = polyglotOf(payload)
  const report: SyncReport = { documents: 0, upToDate: 0, translated: 0, pending: 0, reviewedStale: 0, failed: 0, characters: 0, stopped: 'done' }
  const budget = new Budget(o.maxCharactersPerRun)
  const targets: { collection: string; id: string }[] = []
  for (const collection of Object.keys(o.collections)) {
    const { docs } = await payload.find({ collection: collection as CollectionSlug, locale: o.defaultLocale as never, depth: 0, pagination: false, overrideAccess: true, draft: false })
    for (const d of docs as Record<string, unknown>[]) if (included(o, collection, d)) targets.push({ collection, id: String(d.id) })
  }
  const work = opts.limit ? targets.slice(0, opts.limit) : targets
  const batching = Boolean(opts.useBatch && o.translator.batch && !o.translatorFor && !opts.dryRun)

  if (batching) {
    const missing = new Map<string, Set<string>>()
    for (const t of work) {
      const src = await loadSource(payload, o, t.collection, t.id)
      if (!src) continue
      for (const locale of o.locales) {
        if (src.state.get(locale)?.hash === src.hash || src.reviewed.has(locale)) continue
        const set = missing.get(locale) ?? new Set<string>()
        for (const text of src.texts) set.add(text)
        missing.set(locale, set)
      }
    }
    const requests: TranslateArgs[] = []
    for (const [locale, set] of missing) {
      const known = await recall(payload, o, locale, [...set])
      for (const part of chunks([...set].filter((t) => !known.has(t)))) {
        const chars = part.reduce((s, t) => s + t.length, 0)
        if (!budget.allows(chars)) {
          report.stopped = 'budget'
          break
        }
        budget.spend(chars)
        requests.push(argsFor(o, locale, part.map((text, i) => ({ key: String(i), text }))))
      }
    }
    if (requests.length) {
      const results = await o.translator.batch!(requests)
      for (const [i, r] of requests.entries())
        await remember(payload, o, r.locale, r.items.flatMap((it) => (results[i]?.get(it.key) ? [[it.text, results[i]!.get(it.key)!] as [string, string]] : [])))
    }
  }
  for (const t of work) {
    let r: DocumentResult
    try {
      r = await translateDocument(payload, t.collection, t.id, { dryRun: opts.dryRun, memoryOnly: batching, budget: batching ? undefined : budget })
    } catch (error) {
      if (!(error instanceof QuotaExceededError)) throw error
      r = (error as QuotaExceededError & { result: DocumentResult }).result
      report.stopped = 'quota'
    }
    report.documents++
    report.upToDate += r.upToDate.length
    report.translated += r.translated.length
    report.pending += r.pending.length
    report.reviewedStale += r.reviewedStale.length
    report.failed += r.failed.length
    if (report.stopped === 'quota') break
    if (!batching && r.pending.length && !opts.dryRun) report.stopped = 'budget'
  }
  report.characters = budget.used
  return report
}

/** Translation status of one document in one language, for notices: source, reviewed, stale, machine or pending. */
export async function languageStatus(payload: Payload, collection: string, doc: Record<string, unknown>, locale: string) {
  const o = polyglotOf(payload)
  if (locale === o.defaultLocale) return 'source' as const
  const reviewed = (((doc[o.statusField] as { reviewed?: string[] | null } | undefined)?.reviewed ?? []) as string[]).includes(locale)
  const { docs } = await payload.find({
    collection: o.stateSlug as CollectionSlug,
    where: { key: { equals: stateKey(collection, String(doc.id), locale) } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const row = docs[0] as unknown as StateRow | undefined
  if (reviewed) return row?.stale ? ('stale' as const) : ('reviewed' as const)
  return row ? ('machine' as const) : ('pending' as const)
}
