import type { Payload, PayloadRequest } from 'payload'

import type { ResolvedPolyglot } from './types.js'

/** Only an answer of exactly `true` passes; anything else, a thrown or rejected error included, is no. */
export async function exactlyTrue(check: () => unknown): Promise<boolean> {
  try {
    return (await check()) === true
  } catch {
    return false
  }
}

/**
 * May translation run here: with no `enabled`, yes; otherwise only an answer of exactly `true` (since 2026-11-11).
 * A truthy non-`true` answer, a throw or a rejection means turned off.
 */
export const translationEnabled = (o: Pick<ResolvedPolyglot, 'enabled'>, payload: Payload, req?: PayloadRequest): Promise<boolean> =>
  o.enabled ? exactlyTrue(() => o.enabled!({ payload, req })) : Promise.resolve(true)

/** The signed-in user belongs to the admin collection (`admin.user` in the Payload config). No admin collection: no. */
export const isAdminUser = (payload: Payload | undefined, user: unknown): boolean => {
  const adminCollection = payload?.config?.admin?.user
  return typeof adminCollection === 'string' && adminCollection !== '' && (user as { collection?: unknown } | null | undefined)?.collection === adminCollection
}

type Rule = ((args: { req: PayloadRequest }) => unknown) | undefined

const decide = (rule: Rule, req: PayloadRequest): Promise<boolean> =>
  req.user ? exactlyTrue(() => (rule ? rule({ req }) : isAdminUser(req.payload, req.user))) : Promise.resolve(false)

/**
 * May see coverage and start translations: signed in, and `canManage` answered exactly `true`. With no `canManage`
 * (since 2026-11-11), only users of the admin collection; members of other auth collections are refused.
 */
export const mayManage = (o: Pick<ResolvedPolyglot, 'canManage'>, req: PayloadRequest) => decide(o.canManage, req)

/** May read and change Translation settings: `canConfigure`, else `canManage`, else admin users only; exactly `true`. */
export const mayConfigure = (o: Pick<ResolvedPolyglot, 'canManage' | 'canConfigure'>, req: PayloadRequest) => decide(o.canConfigure ?? o.canManage, req)
