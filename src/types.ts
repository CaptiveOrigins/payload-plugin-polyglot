import type { Payload, PayloadRequest, RequestContext } from 'payload'

/** One piece of text to translate, with a caller-chosen key. */
export type Item = { key: string; text: string }

/**
 * A translation engine. `translate` returns translations by key (missing keys
 * stay untranslated). `batch` (optional) translates many requests at once,
 * usually at a lower price and more slowly; the sweep prefers it.
 */
export type TranslateArgs = {
  locale: string
  items: Item[]
  context?: string
  sourceLocale: string
  keep: string[]
  /** Editors' notes (tone, audience); AI engines use them, others may ignore them. */
  instructions?: string
  /** Preferred translations for this language; AI engines use them, others may ignore them. */
  glossary?: { term: string; translation: string }[]
}
export type Translator = {
  translate: (args: TranslateArgs) => Promise<Map<string, string>>
  batch?: (requests: TranslateArgs[]) => Promise<Map<string, string>[]>
}

/** Why an engine stopped: out of credits (paid), a free quota used up, or the key refused. */
export type StopReason = 'credits' | 'quota' | 'auth'

/**
 * Thrown by a translator when it cannot continue until someone acts (credits,
 * quota, key): the run stops cleanly, admins are told why, and the next run
 * after the fix continues.
 */
export class QuotaExceededError extends Error {
  constructor(
    message = 'Translation quota used up',
    readonly reason: StopReason = 'quota',
  ) {
    super(message)
    this.name = 'QuotaExceededError'
  }
}

/** A recorded stop, shown to admins until a translation succeeds again. */
export type EngineStop = { reason: StopReason; message: string; at: string }

export type PolyglotOptions = {
  /** Fields to keep in every language, per collection. Dotted paths reach into arrays/groups: `sections.heading`. */
  collections: Record<string, string[]>
  translator: Translator
  /** May this request/run call the translator? Default: always. Use it for keys, budgets or environments. Only an exact `true` turns it on; any other answer, or an error, is off. */
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
  /**
   * Who may see coverage, start translations and read the translation memory. Only an exact `true` counts; anything
   * else, an error included, is no. Default (since 2026-11-11): users of the admin collection (`admin.user`) only.
   */
  canManage?: (args: { req: PayloadRequest }) => boolean | Promise<boolean>
  /** Who may read and change Translation settings (pause, languages, glossary…). Only `true` counts. Default: `canManage`. */
  canConfigure?: (args: { req: PayloadRequest }) => boolean | Promise<boolean>
  /** Add the Translation settings global (admin-editable pause, skipped languages, glossary, usage). Default true. */
  settings?: boolean
  /** Slug of the settings global. Default `polyglot-settings`. */
  settingsSlug?: string
  /** Admin group of the settings global. Default `Settings`. */
  settingsGroup?: string
  /** Add the Polyglot admin view (coverage per collection and language, Translate now). Default true. */
  adminView?: boolean
  /** Translate after a document is published (in Next.js, after the response). Default true. */
  onPublish?: boolean
  /** Called once when translation stops (credits, quota, key), e.g. to email admins. Not called again until it has recovered. */
  onStop?: (args: { payload: Payload; stop: EngineStop }) => void | Promise<void>
}

export type ResolvedPolyglot = Required<Omit<PolyglotOptions, 'enabled' | 'include' | 'writeContext' | 'describe' | 'translatorFor' | 'maxCharactersPerRun' | 'canManage' | 'canConfigure' | 'onStop'>> &
  Pick<PolyglotOptions, 'enabled' | 'include' | 'writeContext' | 'describe' | 'translatorFor' | 'maxCharactersPerRun' | 'canManage' | 'canConfigure' | 'onStop'> & { defaultLocale: string; locales: string[] }

export type DocumentResult = { translated: string[]; upToDate: string[]; reviewedStale: string[]; failed: string[]; pending: string[] }
