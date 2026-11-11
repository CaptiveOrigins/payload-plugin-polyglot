import Anthropic from '@anthropic-ai/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { acceptTranslations, claudeTranslator } from '../src/claude.js'
import { microsoftTranslator } from '../src/microsoft.js'
import { settingsGlobal } from '../src/settings.js'
import { QuotaExceededError, type ResolvedPolyglot } from '../src/types.js'

// No test here reaches a real service: fetch and the Anthropic client are fakes.
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

type Call = { url: string; headers: Record<string, string>; body: string }
const fakeFetch = (respond: (n: number) => Response) => {
  const calls: Call[] = []
  globalThis.fetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: init.body })
    return respond(calls.length)
  }) as typeof fetch
  return calls
}
const ok = (texts: string[]) => new Response(JSON.stringify(texts.map((t) => ({ translations: [{ text: t }] }))), { status: 200 })
const args = { locale: 'es', sourceLocale: 'en', keep: [], items: [{ key: '0', text: 'Hello' }] }

describe('microsoft translator: keys and stops', () => {
  it('sends the key only as a header, to the configured endpoint, never in the URL or body', async () => {
    const calls = fakeFetch(() => ok(['Hola']))
    const key = 'fake-key-0123456789'
    const t = microsoftTranslator({ key, region: 'westeurope', endpoint: 'https://translator.example.test' })
    expect((await t.translate(args)).get('0')).toBe('Hola')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url.startsWith('https://translator.example.test/translate?')).toBe(true)
    expect(calls[0]!.url).not.toContain(key)
    expect(calls[0]!.body).not.toContain(key)
    expect(calls[0]!.headers['Ocp-Apim-Subscription-Key']).toBe(key)
    expect(calls[0]!.headers['Ocp-Apim-Subscription-Region']).toBe('westeurope')
  })

  it('stops with reason auth when the key is refused', async () => {
    fakeFetch(() => new Response('bad key', { status: 401 }))
    const error = await microsoftTranslator({ key: 'k' }).translate(args).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(QuotaExceededError)
    expect((error as QuotaExceededError).reason).toBe('auth')
  })

  it('retries a rate limit, and treats other failures as errors, not stops', async () => {
    const calls = fakeFetch((n) => (n === 1 ? new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }) : ok(['Hola'])))
    expect((await microsoftTranslator({ key: 'k' }).translate(args)).get('0')).toBe('Hola')
    expect(calls).toHaveLength(2)
    fakeFetch(() => new Response('oops', { status: 500 }))
    const error = await microsoftTranslator({ key: 'k' }).translate(args).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(QuotaExceededError)
  })
})

describe('claude translator: refuses what it did not ask for', () => {
  it('keeps only keys it asked for, with text, from valid JSON', () => {
    const source = [{ key: '0', text: 'Hello' }, { key: '1', text: 'Bye' }]
    expect(acceptTranslations(source, 'not json')).toEqual(new Map())
    const raw = JSON.stringify({ items: [{ key: '0', text: 'Hola' }, { key: '1', text: '  ' }, { key: '9', text: 'injected' }] })
    expect([...acceptTranslations(source, raw)]).toEqual([['0', 'Hola']])
  })

  const clientWith = (stream: () => { finalMessage: () => Promise<unknown> }) => ({ messages: { stream }, beta: { messages: { stream } } }) as never

  it('returns nothing from a cut-off reply', async () => {
    const reply = { stop_reason: 'max_tokens', content: [{ type: 'text', text: JSON.stringify({ items: [{ key: '0', text: 'Hola' }] }) }] }
    const t = claudeTranslator({ client: clientWith(() => ({ finalMessage: async () => reply })) })
    expect((await t.translate(args)).size).toBe(0)
  })

  it('turns a refused key into a stop, and passes other API errors through', async () => {
    const failing = (status: number, type: string) =>
      claudeTranslator({
        client: clientWith(() => {
          throw new Anthropic.APIError(status, { error: { type } }, `${status} ${type}`, new Headers())
        }),
      })
    const auth = await failing(401, 'authentication_error').translate(args).catch((e: unknown) => e)
    expect(auth).toBeInstanceOf(QuotaExceededError)
    expect((auth as QuotaExceededError).reason).toBe('auth')
    const busy = await failing(529, 'overloaded_error').translate(args).catch((e: unknown) => e)
    expect(busy).toBeInstanceOf(Anthropic.APIError)
    expect(busy).not.toBeInstanceOf(QuotaExceededError)
  })

  const batchClient = (results: unknown[]) =>
    ({
      messages: {
        batches: {
          create: async () => ({ id: 'b1' }),
          retrieve: async () => ({ processing_status: 'ended' }),
          results: async () =>
            (async function* () {
              yield* results
            })(),
        },
      },
    }) as never
  const billing = (i: number) => ({ custom_id: `r${i}`, result: { type: 'errored', error: { error: { type: 'billing_error', message: 'credit balance too low' } } } })

  it('stops a batch only when nothing came back because of credits', async () => {
    const two = [args, { ...args, locale: 'fr' }]
    await expect(claudeTranslator({ client: batchClient([billing(0), billing(1)]) }).batch!(two)).rejects.toMatchObject({ reason: 'credits' })
    const good = { custom_id: 'r0', result: { type: 'succeeded', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ items: [{ key: '0', text: 'Hola' }] }) }] } } }
    const out = await claudeTranslator({ client: batchClient([good, billing(1)]) }).batch!(two)
    expect(out[0]!.get('0')).toBe('Hola')
    expect(out[1]!.size).toBe(0)
  })
})

describe('Translation settings access', () => {
  const access = (o: Partial<ResolvedPolyglot>) => settingsGlobal({ settingsSlug: 'polyglot-settings', settingsGroup: 'Settings', ...o } as ResolvedPolyglot, []).access!
  const req = (user: unknown) => ({ req: { user } }) as never

  it('refuses anyone signed out', async () => {
    const a = access({})
    expect(await a.read!(req(null))).toBe(false)
    expect(await a.update!(req(null))).toBe(false)
  })

  it('uses canConfigure, falling back to canManage', async () => {
    expect(await access({ canManage: () => true, canConfigure: () => false }).update!(req({ id: 1 }))).toBe(false)
    expect(await access({ canManage: () => false }).update!(req({ id: 1 }))).toBe(false)
    expect(await access({ canManage: () => false, canConfigure: () => true }).update!(req({ id: 1 }))).toBe(true)
  })
})
