import { QuotaExceededError, type Translator } from './types.js'

export type MicrosoftTranslatorOptions = {
  /** Azure AI Translator key (the free F0 tier covers about 2 million characters a month). */
  key: string
  /** The resource's region, e.g. `westeurope` (omit for global resources). */
  region?: string
  /** Default `https://api.cognitive.microsofttranslator.com`. */
  endpoint?: string
  /** Map a site locale to Microsoft's code. Defaults handle zh → zh-Hans, zh-TW → zh-Hant. */
  languageCode?: (locale: string) => string
}

const DEFAULT_CODES: Record<string, string> = { zh: 'zh-Hans', 'zh-TW': 'zh-Hant', 'zh-CN': 'zh-Hans', nb: 'nb', pt: 'pt' }
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const unescapeHtml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Microsoft Translator (Azure AI Translator, free tier available). Placeholders
 * like {count} and the `keep` terms are wrapped so they are never translated.
 * A used-up quota stops the run (QuotaExceededError); rate limits are retried.
 */
export function microsoftTranslator(options: MicrosoftTranslatorOptions): Translator {
  const endpoint = options.endpoint ?? 'https://api.cognitive.microsofttranslator.com'
  const code = (l: string) => options.languageCode?.(l) ?? DEFAULT_CODES[l] ?? l
  const protect = (text: string, keep: string[]) => {
    let html = escapeHtml(text).replace(/\{[a-zA-Z0-9_]+\}/g, (m) => `<span translate="no">${m}</span>`)
    for (const term of [...keep].sort((a, b) => b.length - a.length))
      html = html.replace(new RegExp(`(?<![\\w>])${escapeRe(escapeHtml(term))}(?![\\w<])`, 'g'), (m) => `<span translate="no">${m}</span>`)
    return html
  }
  const unprotect = (html: string) => unescapeHtml(html.replace(/<span translate="no">([\s\S]*?)<\/span>/g, '$1'))
  return {
    async translate({ locale, items, keep, sourceLocale }) {
      const out = new Map<string, string>()
      // Requests are limited to 1,000 items and 50,000 characters.
      const groups: (typeof items)[] = [[]]
      let size = 0
      for (const it of items) {
        if (groups.at(-1)!.length >= 900 || size + it.text.length > 40_000) {
          groups.push([])
          size = 0
        }
        groups.at(-1)!.push(it)
        size += it.text.length
      }
      for (const group of groups.filter((g) => g.length)) {
        const url = `${endpoint}/translate?api-version=3.0&from=${encodeURIComponent(code(sourceLocale))}&to=${encodeURIComponent(code(locale))}&textType=html`
        for (let attempt = 0; ; attempt++) {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Ocp-Apim-Subscription-Key': options.key,
              ...(options.region ? { 'Ocp-Apim-Subscription-Region': options.region } : {}),
            },
            body: JSON.stringify(group.map((it) => ({ Text: protect(it.text, keep) }))),
          })
          if (res.status === 429 && attempt < 5) {
            await new Promise((r) => setTimeout(r, Number(res.headers.get('retry-after') ?? 2 ** attempt * 5) * 1000))
            continue
          }
          if (res.status === 401) throw new QuotaExceededError(`Microsoft Translator refused the key: ${await res.text()}`, 'auth')
          if (res.status === 403) throw new QuotaExceededError(`Microsoft Translator quota used up: ${await res.text()}`, 'quota')
          if (!res.ok) throw new Error(`Microsoft Translator ${res.status}: ${await res.text()}`)
          const body = (await res.json()) as { translations: { text: string }[] }[]
          group.forEach((it, i) => {
            const t = body[i]?.translations[0]?.text
            if (t) out.set(it.key, unprotect(t))
          })
          break
        }
      }
      return out
    },
  }
}
