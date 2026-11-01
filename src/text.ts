import crypto from 'node:crypto'

/** Default placeholder copy that is never translated (nor paid for). */
export const FILLER = /lorem ipsum|dolor sit amet|consectetur adipiscing|sed do eiusmod|ut labore et dolore/i

/** Keys whose string values are never visible text. */
export const SKIP_KEYS = [
  'id', 'url', 'href', 'slug', 'path', 'key', 'type', 'blockType', 'blockName', 'format', 'mode', 'direction', 'version',
  'style', 'detail', 'relationTo', 'value', 'tag', 'listType', 'textFormat', 'textStyle', 'linkType', 'appearance',
  'reference', 'icon', 'status', 'newTab', 'indent', 'start', 'checked', 'language', 'mediaType', 'collection',
]
/** Strings that are links, ids, slugs, option values or dates rather than text. */
const NOT_TEXT = /^(https?:\/\/|mailto:|\/|#)|^[a-f0-9]{24}$|^[a-z0-9]+(-[a-z0-9]+)*$|^\d{4}-\d{2}-\d{2}/

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json }
type Rules = { skip: RegExp; skipKeys: Set<string> }

const isText = (v: string, r: Rules) => Boolean(v.trim()) && !NOT_TEXT.test(v.trim()) && !r.skip.test(v)

/**
 * Visits every visible string in a value: words of rich-text (Lexical) text
 * nodes, and plain strings outside skipped keys. `set` replaces it in place.
 */
export function visitText(node: Json, rules: Rules, onText: (text: string, set: (t: string) => void) => void) {
  if (Array.isArray(node)) {
    node.forEach((child, i) => {
      if (typeof child === 'string') {
        if (isText(child, rules)) onText(child, (t) => (node[i] = t))
      } else visitText(child, rules, onText)
    })
    return
  }
  if (!node || typeof node !== 'object') return
  const lexicalText = node.type === 'text' && typeof node.text === 'string'
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string') {
      const wanted = lexicalText ? k === 'text' && !rules.skip.test(v) && Boolean(v.trim()) : !rules.skipKeys.has(k) && isText(v, rules)
      if (wanted) onText(v, (t) => ((node as Record<string, Json>)[k] = t))
    } else if (v && typeof v === 'object') {
      if (lexicalText || rules.skipKeys.has(k)) continue
      visitText(v, rules, onText)
    }
  }
}

/** All visible strings of the listed paths, in order. */
export function textsOf(source: Record<string, Json>, paths: string[], rules: Rules) {
  const found: string[] = []
  visitPaths(source, paths, rules, (t) => found.push(t))
  return found
}

export const fingerprint = (texts: string[]) => crypto.createHash('sha256').update(JSON.stringify(texts)).digest('hex').slice(0, 32)
export const memoryKey = (locale: string, text: string) => crypto.createHash('sha256').update(`${locale}\u0000${text}`).digest('hex')

/**
 * Visits the text of exactly the listed paths of a document: `title` visits the
 * whole field; `sections.heading` only the heading of each section (other fields
 * of the rows, shared across languages, are never touched).
 */
export function visitPaths(source: Record<string, Json>, paths: string[], rules: Rules, onText: (text: string, set: (t: string) => void) => void) {
  const walk = (holder: Record<string, Json>, segs: string[]) => {
    const [head, ...rest] = segs
    if (!head || !(head in holder)) return
    const value = holder[head]
    if (!rest.length) {
      if (typeof value === 'string') {
        if (isText(value, rules)) onText(value, (t) => (holder[head] = t))
      } else if (value && typeof value === 'object') visitText(value, rules, onText)
      return
    }
    if (Array.isArray(value)) for (const row of value) if (row && typeof row === 'object' && !Array.isArray(row)) walk(row as Record<string, Json>, rest)
    else if (value && typeof value === 'object' && !Array.isArray(value)) walk(value as Record<string, Json>, rest)
  }
  for (const p of paths) walk(source, p.split('.'))
}
