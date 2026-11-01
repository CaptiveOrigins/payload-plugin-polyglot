import Anthropic from '@anthropic-ai/sdk'

import { QuotaExceededError, type Item, type StopReason, type TranslateArgs, type Translator } from './types.js'

/** Response shape: the same keys, translated (structured output keeps it parseable). */
const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: { type: 'object', properties: { key: { type: 'string' }, text: { type: 'string' } }, required: ['key', 'text'], additionalProperties: false },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const

const RULES = `Rules:
- Translate every item's "text" into the target language; return every key exactly once, unchanged.
- Keep placeholders such as {count} or {name} exactly as written, and keep HTML tags and Markdown.
- Never translate product names, scientific names, codes or URLs.
- Use the forms of address and punctuation natural for websites in that language.
- Keep it concise: interface text should fit where the source fits.`

const placeholders = (s: string) => [...s.matchAll(/\{[a-zA-Z0-9_]+\}/g)].map((m) => m[0]).sort().join(',')

/** Keeps translations whose key was asked for and whose placeholders match the source. */
export function acceptTranslations(source: Item[], raw: string) {
  const asked = new Map(source.map((i) => [i.key, i.text]))
  const accepted = new Map<string, string>()
  let parsed: { items?: Item[] }
  try {
    parsed = JSON.parse(raw) as { items?: Item[] }
  } catch {
    return accepted
  }
  for (const it of parsed.items ?? []) {
    const src = asked.get(it.key)
    if (src !== undefined && typeof it.text === 'string' && it.text.trim() && placeholders(src) === placeholders(it.text)) accepted.set(it.key, it.text)
  }
  return accepted
}

/** Errors no retry fixes: no credits, key refused, spend limit reached. */
export function stopReasonOf(status: number | undefined, type: string | undefined, message: string): StopReason | undefined {
  if (status === 402 || type === 'billing_error' || /credit balance|billing|spend limit|usage limit/i.test(message)) return 'credits'
  if (status === 401 || status === 403 || type === 'authentication_error' || type === 'permission_error') return 'auth'
  return undefined
}

const stopping = (error: unknown) => {
  if (!(error instanceof Anthropic.APIError)) return error
  const type = (error.error as { error?: { type?: string } } | undefined)?.error?.type
  const reason = stopReasonOf(error.status, type, error.message)
  return reason ? new QuotaExceededError(`Claude: ${error.message}`, reason) : error
}

const textOf = (m: Anthropic.Message) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')

export type ClaudeTranslatorOptions = {
  /** An Anthropic client; default `new Anthropic()` (reads ANTHROPIC_API_KEY). */
  client?: Anthropic
  /** Default `claude-haiku-5-5`: fast, very low cost, and close to Opus for website translation. */
  model?: string
  /** Retry refusals on a fallback model (server-side fallback). Default on, except for Haiku models (not supported). */
  fallbacks?: boolean
  /** What your site is about, tone, terms not to translate… */
  instructions?: string
  /** Name a locale code for the model, e.g. `de` → `German (Deutsch)`. */
  languageName?: (locale: string) => string
  /** Thinking effort. Default `low` (translation rarely needs more). */
  effort?: 'low' | 'medium' | 'high'
}

/** Translation with Claude (Haiku by default): structured output, placeholder checks, editors' notes and glossary, server-side fallback on refusals where supported, and the Batch API for sweeps. */
export function claudeTranslator(options: ClaudeTranslatorOptions = {}): Translator {
  const client = () => options.client ?? new Anthropic()
  const model = options.model ?? 'claude-haiku-5-5'
  const fallbacks = options.fallbacks ?? !model.includes('haiku')
  const system = [options.instructions?.trim(), RULES].filter(Boolean).join('\n\n')
  const params = ({ locale, items, context, keep, sourceLocale, instructions, glossary }: TranslateArgs): Anthropic.MessageCreateParamsNonStreaming => ({
    model,
    max_tokens: 32000,
    output_config: { effort: options.effort ?? 'low', format: { type: 'json_schema', schema: SCHEMA as never } },
    system,
    messages: [
      {
        role: 'user',
        content: `Source language: ${options.languageName?.(sourceLocale) ?? sourceLocale}. Target language: ${options.languageName?.(locale) ?? locale}.${context ? `\nContext: ${context}` : ''}${keep.length ? `\nNever translate these terms: ${keep.join(', ')}` : ''}${instructions ? `\nNotes from the site's editors: ${instructions}` : ''}${glossary?.length ? `\nUse these translations: ${glossary.map((g) => `${g.term} → ${g.translation}`).join('; ')}` : ''}\n\nItems (JSON):\n${JSON.stringify({ items })}`,
      },
    ],
  })
  return {
    async translate(args) {
      if (!args.items.length) return new Map()
      let m: Anthropic.Message
      try {
        m = (fallbacks
          ? await client()
              .beta.messages.stream({ ...params(args), betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } as never)
              .finalMessage()
          : await client().messages.stream(params(args)).finalMessage()) as unknown as Anthropic.Message
      } catch (error) {
        throw stopping(error)
      }
      if (m.stop_reason !== 'end_turn') return new Map()
      return acceptTranslations(args.items, textOf(m))
    },
    async batch(requests) {
      if (!requests.length) return []
      const c = client()
      const created = await c.messages.batches
        .create({ requests: requests.map((r, i) => ({ custom_id: `r${i}`, params: params(r) })) })
        .catch((error: unknown) => {
          throw stopping(error)
        })
      for (;;) {
        const b = await c.messages.batches.retrieve(created.id)
        if (b.processing_status === 'ended') break
        await new Promise((res) => setTimeout(res, 30_000))
      }
      const out: Map<string, string>[] = requests.map(() => new Map())
      let stop: QuotaExceededError | undefined
      for await (const result of await c.messages.batches.results(created.id)) {
        const i = Number(result.custom_id.slice(1))
        if (result.result.type === 'succeeded' && result.result.message.stop_reason === 'end_turn')
          out[i] = acceptTranslations(requests[i]!.items, textOf(result.result.message))
        if (result.result.type === 'errored') {
          const e = (result.result.error as { error?: { type?: string; message?: string } }).error
          const reason = stopReasonOf(undefined, e?.type, e?.message ?? '')
          if (reason) stop ??= new QuotaExceededError(`Claude: ${e?.message ?? e?.type}`, reason)
        }
      }
      // Nothing came back because of credits or the key: stop and tell admins (what did succeed is kept by the caller next run).
      if (stop && out.every((m) => m.size === 0)) throw stop
      return out
    },
  }
}
