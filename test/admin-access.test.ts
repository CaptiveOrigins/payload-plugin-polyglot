import { describe, expect, it, vi } from 'vitest'

// The admin template and client dashboard pull in CSS; only the access decisions are tested here.
vi.mock('@payloadcms/next/templates', () => ({ DefaultTemplate: ({ children }: { children: unknown }) => children }))
vi.mock('../src/client/PolyglotDashboard.js', () => ({ PolyglotDashboard: () => null }))

const { PolyglotNavLink, PolyglotStopBanner, PolyglotView } = await import('../src/rsc/PolyglotView.js')

const payloadWith = (canManage?: () => boolean) =>
  ({ config: { routes: { admin: '/admin', api: '/api' }, globals: [], custom: { polyglot: { collections: { pages: ['title'] }, settingsSlug: 'polyglot-settings', canManage } } }, collections: {} }) as never

describe('admin view access', () => {
  it('hides the menu link and stop banner from signed-out people and people canManage refuses', async () => {
    expect(await PolyglotNavLink({ payload: payloadWith(), user: undefined })).toBeNull()
    expect(await PolyglotStopBanner({ payload: payloadWith(), user: undefined })).toBeNull()
    expect(await PolyglotNavLink({ payload: payloadWith(() => false), user: { id: 1 } })).toBeNull()
    expect(await PolyglotStopBanner({ payload: payloadWith(() => false), user: { id: 1 } })).toBeNull()
    expect(await PolyglotNavLink({ payload: payloadWith(() => true), user: { id: 1 } })).not.toBeNull()
  })

  it('shows the Translations view only to people who may manage translations', async () => {
    const render = async (user: unknown, canManage?: () => boolean) => {
      const req = { user, payload: payloadWith(canManage), i18n: {} }
      return JSON.stringify(await PolyglotView({ initPageResult: { req, permissions: {}, visibleEntities: {}, locale: undefined }, params: {}, searchParams: {} } as never), (k, v) => (k === '_owner' || k === '_store' ? undefined : v))
    }
    expect(await render(null)).toContain('have access to translations')
    expect(await render({ id: 1 }, () => false)).toContain('have access to translations')
    expect(await render({ id: 1 }, () => true)).not.toContain('have access to translations')
  })
})
