# payload-plugin-polyglot

Keeps all your [Payload](https://payloadcms.com) 3 content translated into every language you
have, a little at a time.

> **Beta (0.x).** Used by Captive Origins. Feedback and issues welcome.

- **Finds your content.** List the fields to translate per collection; they become per-language
  (Payload localization). Slugs, paths, relationships and images stay shared.
- **Translates on publish** (in Next.js, after the response, so saving stays fast) and in a
  **sweep** (`syncAll()`, from a cron or script) that catches anything missed or changed.
- **Pays only for what changed.** A fingerprint of each document's text skips unchanged
  documents; a translation memory of every sentence skips known text, so an edit only sends
  the edited sentences.
- **Never wastes calls on placeholders.** Lorem ipsum (and friends) is never sent.
- **Respects people.** Languages marked "Reviewed by a human" are never overwritten; when the
  source changes they are flagged as stale instead.
- **Free tiers welcome.** Microsoft Translator (free tier, about 2 million characters a month)
  built in; Claude built in (with the half-price Batch API for sweeps); bring your own engine.
  A per-run character cap and clean stops on a used-up quota keep you inside free tiers: the
  next run continues where the last stopped.
- **Do-not-translate list** for product names, brands and scientific names.
- **Engine per language** (`translatorFor`), e.g. one engine for European languages and another
  for the rest.

## Install

```bash
npm install @captiveorigins/payload-plugin-polyglot
```

```ts
import { microsoftTranslator, polyglotPlugin } from '@captiveorigins/payload-plugin-polyglot'

export default buildConfig({
  localization: { locales: ['en', 'de', 'fr', 'ja'], defaultLocale: 'en', fallback: true },
  plugins: [
    // Last, so it sees collections other plugins add.
    polyglotPlugin({
      collections: {
        pages: ['title', 'layout', 'meta'],
        posts: ['title', 'content', 'meta'],
        guides: ['title', 'summary', 'sections.heading', 'sections.body'], // only these parts of each row
      },
      translator: microsoftTranslator({ key: process.env.MS_TRANSLATOR_KEY!, region: 'westeurope' }),
      keep: ['Acme', 'Python regius'],
      maxCharactersPerRun: 200_000,
    }),
  ],
})
```

Run the sweep from a cron job or script:

```ts
import { syncAll } from '@captiveorigins/payload-plugin-polyglot'

const report = await syncAll(payload) // { translated, pending, stopped: 'done' | 'budget' | 'quota', … }
```

Claude instead of Microsoft:

```ts
import { claudeTranslator } from '@captiveorigins/payload-plugin-polyglot/claude'

translator: claudeTranslator({ instructions: 'A website for reptile keepers.' }) // ANTHROPIC_API_KEY
// syncAll(payload, { useBatch: true }) uses the Message Batches API (half price)
```

Show visitors what they are reading: `languageStatus(payload, collection, doc, locale)` returns
`source`, `machine`, `reviewed`, `stale` or `pending`.

## Options

| Option | Default | |
|---|---|---|
| `collections` | (required) | Fields per collection; dotted paths reach into arrays/groups |
| `translator` | (required) | `microsoftTranslator()`, `claudeTranslator()` or your own `{ translate, batch? }` |
| `translatorFor` | | Engine per language |
| `keep` | `[]` | Terms never translated |
| `maxCharactersPerRun` | no cap | Stop a sweep after this many characters |
| `enabled` | always | Whether a request/run may call the engine (keys, environments) |
| `include` | published docs | Which documents to translate |
| `skip` | lorem ipsum | Text never sent |
| `skipKeys` | urls, ids, slugs… | Keys whose strings are never text |
| `identityFields` | `slug`, `generateSlug`, `path` | Never change when another language is saved |
| `memorySlug` / `stateSlug` | `polyglot-memory` / `polyglot-state` | Collections it adds |
| `statusField` | `translations` | Per-document "Reviewed by a human" languages |
| `writeContext` | | Context for writes (e.g. `{ disableRevalidate: true }` in scripts) |
| `onPublish` | `true` | Translate after publishing |

## License

MIT
