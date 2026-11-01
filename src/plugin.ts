import type { CollectionAfterChangeHook, CollectionBeforeChangeHook, CollectionConfig, Field, Plugin } from 'payload'

import { FILLER, SKIP_KEYS } from './text.js'
import { coverageEndpoint, syncEndpoint } from './endpoints.js'
import { loadSettings, settingsGlobal } from './settings.js'
import { included, translateDocument } from './translate.js'
import type { PolyglotOptions, ResolvedPolyglot } from './types.js'

/** Marks the listed fields localized (paths ignore tabs/rows; `a.b` reaches into array/group `a`). */
export function localizeFields(fields: Field[], targets: Set<string>, prefix = ''): Field[] {
  return fields.map((f) => {
    if (f.type === 'tabs')
      return {
        ...f,
        tabs: f.tabs.map((t) =>
          'name' in t && t.name
            ? targets.has(`${prefix}${t.name}`)
              ? { ...t, localized: true }
              : { ...t, fields: localizeFields(t.fields, targets, `${prefix}${t.name}.`) }
            : { ...t, fields: localizeFields(t.fields, targets, prefix) },
        ),
      }
    if (f.type === 'row' || f.type === 'collapsible') return { ...f, fields: localizeFields(f.fields, targets, prefix) }
    if (!('name' in f)) return f
    const path = `${prefix}${f.name}`
    if (targets.has(path)) return { ...f, localized: true } as Field
    if ((f.type === 'array' || f.type === 'group') && [...targets].some((t) => t.startsWith(`${path}.`)))
      return { ...f, fields: localizeFields(f.fields, targets, `${path}.`) } as Field
    return f
  })
}

const stateCollection = (slug: string): CollectionConfig => ({
  slug,
  labels: { singular: 'Translation status', plural: 'Translation status' },
  admin: { hidden: true },
  access: { read: ({ req }) => Boolean(req.user), create: () => false, update: () => false, delete: ({ req }) => Boolean(req.user) },
  fields: [
    { name: 'key', type: 'text', required: true, unique: true },
    { name: 'collection', type: 'text', required: true, index: true },
    { name: 'doc', type: 'text', required: true, index: true },
    { name: 'locale', type: 'text', required: true },
    { name: 'hash', type: 'text', required: true },
    { name: 'stale', type: 'checkbox', defaultValue: false },
    { name: 'at', type: 'date' },
  ],
  timestamps: false,
})

const memoryCollection = (slug: string): CollectionConfig => ({
  slug,
  labels: { singular: 'Translation', plural: 'Translation memory' },
  admin: { useAsTitle: 'source', defaultColumns: ['locale', 'source', 'text', 'createdAt'], description: 'Every machine-translated sentence, reused so nothing is translated twice.' },
  access: { read: ({ req }) => Boolean(req.user), create: () => false, update: () => false, delete: ({ req }) => Boolean(req.user) },
  fields: [
    { name: 'key', type: 'text', required: true, unique: true, admin: { hidden: true } },
    { name: 'locale', type: 'text', required: true, index: true },
    { name: 'source', type: 'textarea', required: true },
    { name: 'text', type: 'textarea', required: true },
  ],
  timestamps: true,
})

/**
 * Polyglot: keeps your content translated into every language of your Payload
 * localization, a little at a time.
 *
 * - The fields you list become per-language (Payload localization).
 * - Publishing in the default language translates the other languages (in
 *   Next.js after the response); `syncAll()` sweeps everything (cron/script),
 *   optionally through the translator's batch API.
 * - A fingerprint of each document's text skips unchanged documents; a memory of
 *   every sentence skips known text, so edits only pay for what changed.
 * - Placeholder copy (lorem ipsum) is never sent; languages marked "Reviewed by a
 *   human" are never overwritten (they are flagged when the source changes).
 * - Identity fields (slug, path…) never change when another language is saved.
 * - Translation settings (a global) let admins pause translation, skip languages,
 *   add never-translate terms, notes and a glossary, and see characters sent.
 */
export const polyglotPlugin =
  (options: PolyglotOptions): Plugin =>
  (config) => {
    const loc = config.localization
    if (!loc) throw new Error('payload-plugin-polyglot: enable Payload `localization` first.')
    const codes = loc.locales.map((l) => (typeof l === 'string' ? l : l.code))
    const resolved: ResolvedPolyglot = {
      collections: options.collections,
      translator: options.translator,
      enabled: options.enabled,
      include: options.include,
      keep: options.keep ?? [],
      translatorFor: options.translatorFor,
      maxCharactersPerRun: options.maxCharactersPerRun,
      skip: options.skip ?? FILLER,
      skipKeys: [...SKIP_KEYS, ...(options.skipKeys ?? [])],
      identityFields: options.identityFields ?? ['slug', 'generateSlug', 'path'],
      memorySlug: options.memorySlug ?? 'polyglot-memory',
      stateSlug: options.stateSlug ?? 'polyglot-state',
      statusField: options.statusField ?? 'translations',
      writeContext: options.writeContext,
      describe: options.describe,
      onPublish: options.onPublish ?? true,
      canManage: options.canManage,
      canConfigure: options.canConfigure,
      settings: options.settings ?? true,
      settingsSlug: options.settingsSlug ?? 'polyglot-settings',
      settingsGroup: options.settingsGroup ?? 'Settings',
      adminView: options.adminView ?? true,
      defaultLocale: loc.defaultLocale,
      locales: codes.filter((c) => c !== loc.defaultLocale),
    }
    const labels = loc.locales.filter((l) => (typeof l === 'string' ? l : l.code) !== loc.defaultLocale).map((l) =>
      typeof l === 'string' ? { label: l, value: l } : { label: typeof l.label === 'string' ? l.label : l.code, value: l.code },
    )

    const keepIdentity: CollectionBeforeChangeHook = ({ data, originalDoc, req }) => {
      if (!originalDoc || !req.locale || req.locale === resolved.defaultLocale || req.locale === 'all') return data
      for (const k of resolved.identityFields) if (k in originalDoc) data[k] = originalDoc[k]
      return data
    }
    const onPublish: CollectionAfterChangeHook = async ({ collection, doc, req, context }) => {
      if (!resolved.onPublish || context?.polyglot || (req.locale && req.locale !== resolved.defaultLocale)) return doc
      if (!included(resolved, collection.slug, doc)) return doc
      if (resolved.enabled && !(await resolved.enabled({ payload: req.payload, req }))) return doc
      if ((await loadSettings(req.payload, resolved)).paused) return doc
      const run = () => translateDocument(req.payload, collection.slug, String(doc.id), { inRequest: true }).catch((err) => req.payload.logger.error({ err }, 'Polyglot: publish translation failed'))
      try {
        const { after } = await import('next/server.js')
        after(run)
      } catch {
        // Not in a Next.js request (scripts, tests): the sweep picks it up.
      }
      return doc
    }
    const statusField: Field = {
      name: resolved.statusField,
      type: 'group',
      admin: { position: 'sidebar', description: 'Machine translations show a notice until a person reviews them.' },
      fields: [
        {
          name: 'reviewed',
          label: 'Reviewed by a human',
          type: 'select',
          hasMany: true,
          options: labels,
          admin: { description: 'Reviewed languages are never re-translated automatically.' },
        },
      ],
    }

    const components = config.admin?.components ?? {}
    return {
      ...config,
      custom: { ...config.custom, polyglot: resolved },
      endpoints: [...(config.endpoints ?? []), coverageEndpoint, syncEndpoint],
      globals: resolved.settings && !(config.globals ?? []).some((g) => g.slug === resolved.settingsSlug) ? [...(config.globals ?? []), settingsGlobal(resolved, labels)] : config.globals,
      admin: resolved.adminView
        ? {
            ...config.admin,
            components: {
              ...components,
              afterNavLinks: [...(components.afterNavLinks ?? []), '@captiveorigins/payload-plugin-polyglot/rsc#PolyglotNavLink'],
              views: { ...components.views, polyglot: { Component: '@captiveorigins/payload-plugin-polyglot/rsc#PolyglotView', path: '/polyglot' } },
            },
          }
        : config.admin,
      collections: [
        ...(config.collections ?? []).map((c) => {
          const targets = resolved.collections[c.slug]
          if (!targets) return c
          return {
            ...c,
            fields: [...localizeFields(c.fields, new Set(targets)), statusField],
            hooks: {
              ...c.hooks,
              beforeChange: [...(c.hooks?.beforeChange ?? []), keepIdentity],
              afterChange: [...(c.hooks?.afterChange ?? []), onPublish],
            },
          }
        }),
        ...((config.collections ?? []).some((c) => c.slug === resolved.memorySlug) ? [] : [memoryCollection(resolved.memorySlug)]),
        ...((config.collections ?? []).some((c) => c.slug === resolved.stateSlug) ? [] : [stateCollection(resolved.stateSlug)]),
      ],
    }
  }
