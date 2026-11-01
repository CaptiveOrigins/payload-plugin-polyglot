import { describe, expect, it } from 'vitest'

import { claudeTranslator } from '../src/claude.js'

describe('claude translator', () => {
  it('uses Haiku without fallbacks, and passes notes and glossary', async () => {
    const calls: { kind: string; params: Record<string, unknown> }[] = []
    const reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ items: [{ key: '0', text: 'Hola {name}' }, { key: '1', text: 'sin marcador' }] }) }] }
    const stream = (kind: string) => (params: Record<string, unknown>) => (calls.push({ kind, params }), { finalMessage: async () => reply })
    const client = { messages: { stream: stream('plain') }, beta: { messages: { stream: stream('beta') } } }
    const t = claudeTranslator({ client: client as never })
    const out = await t.translate({
      locale: 'es',
      sourceLocale: 'en',
      keep: ['OnePedigree'],
      instructions: 'Be formal.',
      glossary: [{ term: 'keeper', translation: 'cuidador' }],
      items: [{ key: '0', text: 'Hello {name}' }, { key: '1', text: 'Hi {name}' }],
    })
    expect(calls[0]!.kind).toBe('plain')
    expect(calls[0]!.params.model).toBe('claude-haiku-5-5')
    const prompt = JSON.stringify(calls[0]!.params.messages)
    expect(prompt).toContain('Be formal.')
    expect(prompt).toContain('keeper → cuidador')
    // A translation that lost its placeholder is refused.
    expect([...out]).toEqual([['0', 'Hola {name}']])
    await claudeTranslator({ client: client as never, model: 'claude-opus-5-5' }).translate({ locale: 'es', sourceLocale: 'en', keep: [], items: [{ key: '0', text: 'Hello {name}' }] })
    expect(calls[1]!.kind).toBe('beta')
  })
})
