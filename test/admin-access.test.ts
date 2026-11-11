import { describe, expect, it, vi } from 'vitest'

// The admin template and client dashboard pull in CSS; only the access decisions are tested here.
vi.mock('@payloadcms/next/templates', () => ({ DefaultTemplate: ({ children }: { children: unknown }) => children }))
vi.mock('../src/client/PolyglotDashboard.js', () => ({ PolyglotDashboard: () => null }))

const { PolyglotNavLink, PolyglotStopBanner, PolyglotView } = await import('../src/rsc/PolyglotView.js')

const payloadWith = (canManage?: () => unknown) =>
  ({ config: { admin: { user: 'users' }, routes: { admin: '/admin', api: '/api' }, globals: [], custom: { polyglot: { collections: { pages: ['title'] }, settingsSlug: 'polyglot-settings', canManage } } }, collections: {} }) as never

describe('admin view access', () => {
  it('hides the menu link and stop banner from signed-out people and people canManage refuses', async () => {
    expect(await PolyglotNavLink({ payload: payloadWith(), user: undefined })).toBeNull()
    expect(await PolyglotStopBanner({ payload: payloadWith(), user: undefined })).toBeNull()
    expect(await PolyglotNavLink({ payload: payloadWith(() => false), user: { id: 1, collection: 'users' } })).toBeNull()
    expect(await PolyglotStopBanner({ payload: payloadWith(() => false), user: { id: 1, collection: 'users' } })).toBeNull()
    expect(await PolyglotNavLink({ payload: payloadWith(() => true), user: { id: 1, collection: 'users' } })).not.toBeNull()
  })

  it('shows the Translations view only to people who may manage translations', async () => {
    const render = async (user: unknown, canManage?: () => boolean) => {
      const req = { user, payload: payloadWith(canManage), i18n: {} }
      return JSON.stringify(await PolyglotView({ initPageResult: { req, permissions: {}, visibleEntities: {}, locale: undefined }, params: {}, searchParams: {} } as never), (k, v) => (k === '_owner' || k === '_store' ? undefined : v))
    }
    expect(await render(null)).toContain('have access to translations')
    expect(await render({ id: 1, collection: 'users' }, () => false)).toContain('have access to translations')
    expect(await render({ id: 1, collection: 'users' }, () => true)).not.toContain('have access to translations')
  })
})

describe('admin view access (2026-11-11)', () => {
  const admin = { id: 1, collection: 'users' }
  const member = { id: 2, collection: 'members' }
  const render = async (user: unknown, canManage?: () => unknown) => {
    const req = { user, payload: payloadWith(canManage), i18n: {} }
    return JSON.stringify(await PolyglotView({ initPageResult: { req, permissions: {}, visibleEntities: {}, locale: undefined }, params: {}, searchParams: {} } as never), (k, v) => (k === '_owner' || k === '_store' ? undefined : v))
  }
  const noes: [string, () => unknown][] = [
    ['1', () => 1],
    ["'yes'", () => 'yes'],
    ['a query-shaped object', () => ({ id: { exists: true } })],
    ['a thrown error', () => {
      throw new Error('directory down')
    }],
    ['a rejected promise', async () => {
      throw new Error('directory down')
    }],
  ]

  it('by default shows the view, link and banner to admin users only, not members', async () => {
    expect(await render(member)).toContain('have access to translations')
    expect(await PolyglotNavLink({ payload: payloadWith(), user: member })).toBeNull()
    expect(await PolyglotStopBanner({ payload: payloadWith(), user: member })).toBeNull()
    expect(await render(admin)).not.toContain('have access to translations')
    expect(await PolyglotNavLink({ payload: payloadWith(), user: admin })).not.toBeNull()
  })

  it('refuses someone not signed in even when canManage says true', async () => {
    expect(await render(null, () => true)).toContain('have access to translations')
    expect(await PolyglotNavLink({ payload: payloadWith(() => true), user: undefined })).toBeNull()
    expect(await PolyglotStopBanner({ payload: payloadWith(() => true), user: undefined })).toBeNull()
  })

  it('treats anything but an exact true from canManage as no, errors included', async () => {
    for (const [label, answer] of noes) {
      expect(await render(admin, answer), label).toContain('have access to translations')
      expect(await PolyglotNavLink({ payload: payloadWith(answer), user: admin }), label).toBeNull()
      expect(await PolyglotStopBanner({ payload: payloadWith(answer), user: admin }), label).toBeNull()
    }
  })
})
