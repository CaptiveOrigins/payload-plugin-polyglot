import type { GlobalConfig, Payload, PayloadRequest } from 'payload'

import { mayConfigure } from './access.js'
import { polyglotOf } from './translate.js'
import type { EngineStop, QuotaExceededError, ResolvedPolyglot } from './types.js'

export type GlossaryEntry = { locale: string; term: string; translation: string }

/** What admins can change without a deploy (the Translation settings global). */
export type Settings = {
  paused: boolean
  skipLocales: Set<string>
  keep: string[]
  instructions?: string
  glossary: GlossaryEntry[]
  maxCharactersPerRun?: number
  usage: { month: string; characters: number }[]
  /** Set while translation is stopped (credits, quota, key); cleared by the next success. */
  stop?: EngineStop
}

const DEFAULTS: Settings = { paused: false, skipLocales: new Set(), keep: [], glossary: [], usage: [] }
const month = () => new Date().toISOString().slice(0, 7)
const hasGlobal = (payload: Payload, slug: string) => payload.config.globals?.some((g) => g.slug === slug)

export function settingsGlobal(o: ResolvedPolyglot, labels: { label: string; value: string }[]): GlobalConfig {
  // Asked at request time, so the options Payload holds are the ones that decide. Only an exact `true` counts.
  const access = ({ req }: { req: PayloadRequest }) => mayConfigure((req.payload && polyglotOf(req.payload)) || o, req)
  return {
    slug: o.settingsSlug,
    label: 'Translation settings',
    admin: { group: o.settingsGroup, description: 'How automatic translation behaves. Changes apply to the next translation; nothing needs a deploy.' },
    access: { read: access, update: access },
    fields: [
      {
        name: 'paused',
        label: 'Pause automatic translation',
        type: 'checkbox',
        defaultValue: false,
        admin: { description: 'Publishing and the scheduled sweep stop translating. “Translate now” in Translations still works.' },
      },
      {
        name: 'skipLocales',
        label: 'Languages not machine-translated',
        type: 'select',
        hasMany: true,
        options: labels,
        admin: { description: 'Visitors see the default language there until someone translates by hand. Existing translations stay.' },
      },
      {
        name: 'keep',
        label: 'Never translate',
        type: 'textarea',
        admin: { description: 'One term per line (names, brands, product names). Added to the terms set in code.' },
      },
      {
        name: 'instructions',
        label: 'Notes for the translator',
        type: 'textarea',
        admin: { description: 'Tone, audience, words to prefer, e.g. “Address readers formally in German.” Used by AI engines (Claude); ignored by Microsoft.' },
      },
      {
        name: 'glossary',
        label: 'Preferred translations',
        type: 'array',
        admin: { description: 'How a term should be translated in one language. Used by AI engines (Claude); changing it does not re-translate existing text.' },
        fields: [
          {
            type: 'row',
            fields: [
              { name: 'locale', type: 'select', options: labels, required: true },
              { name: 'term', type: 'text', required: true },
              { name: 'translation', type: 'text', required: true },
            ],
          },
        ],
      },
      {
        name: 'maxCharactersPerRun',
        label: 'Characters per sweep (cap)',
        type: 'number',
        min: 0,
        admin: { description: `Stops a sweep after sending this many characters; the next run continues. Empty: ${o.maxCharactersPerRun ? `${o.maxCharactersPerRun.toLocaleString('en')} (set in code)` : 'no cap'}.` },
      },
      {
        name: 'stop',
        label: 'Stopped',
        type: 'group',
        admin: {
          readOnly: true,
          condition: (data) => Boolean(data?.stop?.reason),
          description: 'Translation stopped and is waiting for someone to act. Cleared automatically by the next successful translation.',
        },
        fields: [
          {
            type: 'row',
            fields: [
              { name: 'reason', type: 'select', options: [{ label: 'Out of credits', value: 'credits' }, { label: 'Free quota used up', value: 'quota' }, { label: 'Key refused', value: 'auth' }] },
              { name: 'at', type: 'date', admin: { date: { pickerAppearance: 'dayAndTime' } } },
            ],
          },
          { name: 'message', type: 'textarea' },
        ],
      },
      {
        name: 'usage',
        label: 'Characters sent, by month',
        type: 'array',
        admin: { readOnly: true, description: 'Recorded by Polyglot: characters sent to the translation engine (memory hits and skipped text are free).' },
        fields: [
          {
            type: 'row',
            fields: [
              { name: 'month', type: 'text' },
              { name: 'characters', type: 'number' },
            ],
          },
        ],
      },
    ],
  }
}

/** Current settings (defaults when the settings global is off). */
export async function loadSettings(payload: Payload, o: ResolvedPolyglot): Promise<Settings> {
  if (!hasGlobal(payload, o.settingsSlug)) return { ...DEFAULTS, skipLocales: new Set() }
  const g = (await payload.findGlobal({ slug: o.settingsSlug as never, depth: 0, overrideAccess: true })) as Record<string, unknown>
  return {
    paused: Boolean(g.paused),
    skipLocales: new Set((g.skipLocales as string[] | null) ?? []),
    keep: String(g.keep ?? '')
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean),
    instructions: typeof g.instructions === 'string' && g.instructions.trim() ? g.instructions.trim() : undefined,
    glossary: ((g.glossary as GlossaryEntry[] | null) ?? []).filter((e) => e.locale && e.term && e.translation),
    maxCharactersPerRun: typeof g.maxCharactersPerRun === 'number' ? g.maxCharactersPerRun : undefined,
    usage: ((g.usage as Settings['usage'] | null) ?? []).map(({ month, characters }) => ({ month, characters })),
    stop: (g.stop as EngineStop | null)?.reason ? (g.stop as EngineStop) : undefined,
  }
}

/** Adds characters sent this month (keeps a year of months). */
export async function recordUsage(payload: Payload, o: ResolvedPolyglot, characters: number) {
  if (!characters || !hasGlobal(payload, o.settingsSlug)) return
  const { usage } = await loadSettings(payload, o)
  const now = month()
  const rows = usage.some((u) => u.month === now) ? usage.map((u) => (u.month === now ? { ...u, characters: u.characters + characters } : u)) : [...usage, { month: now, characters }]
  await payload.updateGlobal({ slug: o.settingsSlug as never, data: { usage: rows.slice(-12) } as never, overrideAccess: true, context: { polyglot: true } })
}

export const charactersThisMonth = (s: Settings) => s.usage.find((u) => u.month === month())?.characters ?? 0

/** What admins should do about a stop. */
export const STOP_HELP: Record<EngineStop['reason'], string> = {
  credits: 'The translation engine’s account is out of credits (or hit its spending limit). Add credits, then click Translate now; nothing is lost meanwhile.',
  quota: 'The engine’s free quota for this period is used up. Translation resumes on its own next period, or upgrade the plan.',
  auth: 'The engine refused its key (missing, wrong or revoked). Update the key, then click Translate now.',
}

/** Records that translation stopped; calls `onStop` once (not again until it has recovered). */
export async function recordStop(payload: Payload, o: ResolvedPolyglot, error: QuotaExceededError) {
  const current = (await loadSettings(payload, o)).stop
  const stop: EngineStop = { reason: error.reason, message: error.message.slice(0, 1000), at: new Date().toISOString() }
  payload.logger.error({ reason: stop.reason, message: stop.message }, 'Polyglot: translation stopped')
  if (current?.reason === stop.reason) return
  if (hasGlobal(payload, o.settingsSlug))
    await payload.updateGlobal({ slug: o.settingsSlug as never, data: { stop } as never, overrideAccess: true, context: { polyglot: true } })
  await o.onStop?.({ payload, stop })
}

/** Clears a recorded stop after a successful translation. */
export async function clearStop(payload: Payload, o: ResolvedPolyglot) {
  if (!hasGlobal(payload, o.settingsSlug)) return
  await payload.updateGlobal({ slug: o.settingsSlug as never, data: { stop: { reason: null, message: null, at: null } } as never, overrideAccess: true, context: { polyglot: true } })
  payload.logger.info('Polyglot: translation running again')
}
