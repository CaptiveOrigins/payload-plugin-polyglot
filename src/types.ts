import type { Payload, PayloadRequest, RequestContext } from 'payload'

/** One piece of text to translate, with a caller-chosen key. */
export type Item = { key: string; text: string }

/**
 * A translation engine. `translate` returns translations by key (missing keys
 * stay untranslated). `batch` (optional) translates many requests at once,
 * usually at a lower price and more slowly; the sweep prefers it.
 */
export type TranslateArgs = { locale: string; items: Item[]; context?: string; sourceLocale: string; keep: string[] }
export type Translator = {
  translate: (args: TranslateArgs) => Promise<Map<string, string>>
  batch?: (requests: TranslateArgs[]) => Promise<Map<string, string>[]>
}

/** Thrown by a translator when its quota (e.g. a free tier) is used up: the run stops and resumes next time. */
export class QuotaExceededError extends Error {
  constructor(message = 'Translation quota used up') {
    super(message)
    this.name = 'QuotaExceededError'
  }
}

export type PolyglotOptions = {
  /** Fields to keep in every language, per collection. Dotted paths reach into arrays/groups: `sections.heading`. */
  collections: Record<string, string[]>
  translator: Translator
  /** May this request/run call the translator? Default: always. Use it for keys, budgets or environments. */
  enabled?: (args: { payload: Payload; req?: PayloadRequest }) => boolean | Promise<boolean>
  /** Which documents to translate. Default: published ones (or all, without drafts). */
  include?: (args: { collection: string; doc: Record<string, unknown> }) => boolean
  /** Terms never translated: product names, brands, scientific names… */
  keep?: string[]
  /** Engine per language (e.g. DeepL for European languages, another for the rest). Default: `translator`. */
  translatorFor?: (locale: string) => Translator | undefined
  /** Stop a sweep after sending this many characters (stay inside a free tier). Default: no cap. */
  maxCharactersPerRun?: number
  /** Text never sent (placeholders). Default: lorem ipsum and friends. */
  skip?: RegExp
  /** Keys whose string values are never text (urls, ids, option values…). Added to the defaults. */
  skipKeys?: string[]
  /** Fields that must never change when another language is saved (computed from the default language). */
  identityFields?: string[]
  /** Slug of the translation memory collection. Default `polyglot-memory`. */
  memorySlug?: string
  /** Slug of the per-language fingerprint collection. Default `polyglot-state`. */
  stateSlug?: string
  /** Name of the per-document status group (reviewed languages + fingerprints). Default `translations`. */
  statusField?: string
  /** Context for writes of translated languages, e.g. `{ disableRevalidate: true }` outside a web request. */
  writeContext?: (args: { inRequest: boolean }) => RequestContext
  /** Short description for the translator ("Content of a page on a reptile-care website"). */
  describe?: (collection: string) => string
  /** Translate after a document is published (in Next.js, after the response). Default true. */
  onPublish?: boolean
}

export type ResolvedPolyglot = Required<Omit<PolyglotOptions, 'enabled' | 'include' | 'writeContext' | 'describe' | 'translatorFor' | 'maxCharactersPerRun'>> &
  Pick<PolyglotOptions, 'enabled' | 'include' | 'writeContext' | 'describe' | 'translatorFor' | 'maxCharactersPerRun'> & { defaultLocale: string; locales: string[] }

export type DocumentResult = { translated: string[]; upToDate: string[]; reviewedStale: string[]; failed: string[]; pending: string[] }
