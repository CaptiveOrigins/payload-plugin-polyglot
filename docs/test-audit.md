# Test audit

Kept by this repo's owning session, per `~/Code/CLAUDE.md` "Test self-audits". Newest first.

## 2026-11-11: `enabled` takes only an exact true

Suite: 38 tests before, 47 after, in 5 files. Closes the `enabled` note under "Skipped" below.

- **The change.** `src/access.ts`: `translationEnabled` (no `enabled` is on; otherwise `exactlyTrue`, so a throw or rejection is off). Used by the publish hook, the coverage endpoint's `enabled` flag and the sync endpoint.
- **Tests.** `test/enabled.test.ts`, its own install with a fake translator and Next's `after()` mocked to run the work at once: seven non-answers (`1`, `'yes'`, `{}`, an array, a resolved `'true'`, a throw, a rejection) mean nothing is translated on publish, sync is 400 (never a 500), and coverage reports off; exactly `true` translates on publish and from sync; no option means on.
- **Mutation checks.** 6, each a Python string replace restored byte for byte (SHA-256 checked); all 6 fail: the helper taking any truthy answer; the old check back in the hook, in sync, or in coverage; the hook's check removed; no option meaning off (survived until the "no enabled option" test was added).
- **Sweep, added the same day.** `syncAll()` asks `enabled` first, with the caller's request or a `createLocalReq` one with no user, and returns `stopped: 'off'` (logged) unless it's exactly `true`, dry runs included. Suite 47 → 56. Tests: `false` and the seven non-answers make no translator calls and read no documents, plain and dry run; `true` sweeps a pending page, and `enabled` saw the payload and a userless local request. Mutation checks, 5, all fail: the check removed, any truthy answer taken, a throw escaping, dry runs let through, no request passed.

## 2026-11-11: managing translations fails closed

Suite: 32 tests before, 38 after, in 4 files (`npx vitest run`, real Payload, in-memory MongoDB, the fake translator only; nothing is sent to a translation service). The test install now has two auth collections, `users` (the admin collection) and `members`.

- **The change.** `src/access.ts`: `exactlyTrue` (only `true` passes; a throw or rejection is `false`), `isAdminUser` (the user's collection equals `admin.user`), `mayManage` and `mayConfigure` (signed in, then the site's rule or, with none, admin users only; exactly `true`). Used by the coverage and sync endpoints (401 or 403, never a 500), the settings global's read and update (it no longer passes the site's answer to Payload), the Translations view, nav link and stop banner, and the memory and status collections' read and delete (before: anyone signed in).
- **Tests.** `polyglot.test.ts` "who manages translations": with the default, a member is 403 at coverage, sync, settings read and update, memory read and status delete, and an admin user gets in (sync checked through `enabled: false`, so nothing is translated); six non-answers from `canManage` (`1`, `'yes'`, `{}`, a query-shaped object, a throw, a rejection) are 403 everywhere; with `true`, the site's rule decides; not signed in is refused even when `canManage` says `true`; the same six from `canConfigure` refuse the settings while managing still works. `admin-access.test.ts`: the view, link and banner by default for a member (no) and an admin (yes), for signed-out people when `canManage` says `true` (no), and for the non-answers (no).
- **Mutation checks.** 13, each a Python string replace restored byte for byte (SHA-256 checked); all 13 fail the suite: truthy passing in `exactlyTrue`; errors rethrown; the old any-signed-in default; `isAdminUser` without the collection check; the sign-in check dropped (survived at first; the signed-out-with-`true` tests were added for it); `canConfigure` ignored; the old truthy check or the site's raw answer back in the settings global; the old check back in the endpoints, the view, and the nav link and banner; memory and status open to anyone signed in.
- **Skipped.** The view is checked through its element tree with Payload's admin shell stubbed, not in a real admin. `enabled` (whether the engine may run here) is a spending switch, not access, and still takes a truthy answer; noted for the lead.

## 2026-11-10: the lead's fixes after the first audit

Suite: 28 → 32 tests in 4 files. In-memory MongoDB and the fake translator only.

**Fixed: dotted paths into groups.** In `visitPaths` (`src/text.ts`), the `else if` for groups belonged to the `if` inside the array loop, so a path like `meta.title` found no text. The field was made per-language but never translated. Arrays and plain fields were fine. The branches now have braces, and a group is walked like a row.

This also closed a half-translation gap: since group text wasn't counted, a document with `meta.title` could be written in a language with its other fields translated and the group left in the default language. Group text now counts, so a language is written only when every listed text, groups included, has a translation.

Existing documents with group paths get a new fingerprint, so the next sweep translates their group text once.

Tests (`polyglot.test.ts`): "translates a dotted path into a group, and leaves the group's other fields shared", "writes nothing for a language whose group text the engine left out", and `visitPaths` "reaches into groups, arrays, groups in arrays and plain fields, and only the listed paths" and "ignores missing paths…". The earlier array, plain-field and half-translation tests still pass.

Mutation check: putting the misplaced `else` back fails all 3 group tests; restored byte for byte.

## 2026-11-10: first audit

Suite before: 11 tests in 2 files. After: 28 tests in 4 files. Every test uses fakes: an in-memory MongoDB, a fake translator, a fake `fetch` for Microsoft and a fake Anthropic client. Nothing reaches a real service.

### Promises and the tests that prove them

| Promise (README, code docs) | Test |
| --- | --- |
| Listed fields become per-language; slugs, links and unlisted row fields stay shared | `polyglot.test.ts` "translates every language, leaving links, slugs and placeholder copy alone" |
| Dotted paths reach into arrays (`sections.heading`) | same test |
| Dotted paths reach into groups | **Gap, failing: see "Bug found"** |
| Identity fields (`slug`, `path`) never change when another language is saved | "never changes the slug when another language is saved" (added) |
| Lorem ipsum is never sent | "translates every language…" |
| Unchanged documents cost nothing; only edited sentences are sent | "costs nothing when nothing changed…" |
| Reviewed languages are never overwritten, and are flagged stale | "never overwrites a reviewed language…" |
| Sweep, batch API, dry run, drafts left out | "sweeps everything, through the batch API when asked" |
| Coverage, and Translate now by collection and language | "reports coverage and translates by collection and language on request" |
| A used-up quota stops cleanly; the next run continues | "stops cleanly when the engine quota is used up…" |
| `onStop` runs once; the stop clears on the next success | "tells admins once when credits run out…" |
| Settings: pause, skipped languages, terms, notes, glossary, usage | "follows the Translation settings…" |
| Per-sweep character cap | "stops a sweep at the character cap from Translation settings" (added) |
| A half-translated language is never written; it retries next run | "writes nothing for a language the engine only half translated…" (added) |
| An ordinary engine error is a failure, not a stop | "records an engine error as a failure, not a stop" (added) |
| Endpoints: signed-out 401, `canManage` refusal 403, `enabled` off 400 | "refuses the endpoints to signed-out people…" (added) |
| Memory and status collections: no reads signed out, no writes by anyone | "keeps memory and status hidden…" (added) |
| Settings global: no reads signed out; `canConfigure` falls back to `canManage` | `engines.test.ts` "Translation settings access" (added) |
| Admin link, stop banner and view only for people who may manage | `admin-access.test.ts` (added) |
| Microsoft: placeholders and kept terms protected; 403 stops | `polyglot.test.ts` "microsoft translator" |
| Microsoft: the key goes only in a header to the configured endpoint, never in URL or body | `engines.test.ts` "sends the key only as a header…" (added) |
| Microsoft: 401 stops as `auth`; 429 retried; other failures are errors | `engines.test.ts` (added) |
| Claude: Haiku default, no fallback on Haiku; notes and glossary sent; lost placeholders refused | `claude.test.ts` |
| Claude: errors that need someone to act are recognized | `claude.test.ts` |
| Claude: replies keep only asked-for keys; bad JSON and cut-off replies give nothing | `engines.test.ts` (added) |
| Claude: a refused key becomes an `auth` stop; overload is not a stop | `engines.test.ts` (added) |
| Claude batch: stops only when credits left nothing; partial results kept | `engines.test.ts` (added) |

### Gaps added

- Endpoint refusals (401, 403, 400 when turned off).
- Access on the memory and status collections and the settings global, including `canConfigure`.
- Admin link, banner and view hidden from people who may not manage translations (template and client component mocked; only the access decision is tested).
- Translation keys don't leak into URLs or request bodies (Microsoft).
- Stop handling: Microsoft 401 and 429, Claude refused key, Claude batch credits.
- Claude output checks: unknown keys, empty text, bad JSON, cut-off replies.
- Data safety: half-translated languages aren't written; engine errors aren't stops; slug stays put; character cap holds.

### Gaps skipped

- Translate on publish inside Next.js (`after()`): needs a running Next.js request. The sweep covers the same `translateDocument` path, and outside Next the hook is a no-op by design.
- Reviewed languages on the batch path: the batch step only fills memory; writes still go through `translateDocument`, which the reviewed test covers.
- `languageStatus` returning `source`, `localizeFields` inside tabs, rows and collapsibles, `describe` and `writeContext` pass-through: trivial or Payload field plumbing.
- Microsoft request grouping (900 items or 40,000 characters): a cost detail, not safety; worth a test if the limits change.
- The client dashboard's rendering: UI, not a promise the README makes beyond "shows coverage".

### Bug found (test left out)

- `src/text.ts:74-75`: in `visitPaths`, the `else if` binds to the inner `if (row && …)` inside the `for` loop, not to `if (Array.isArray(value))`. A dotted path into a **group** (`meta.title`) finds no text, so it is localized but never translated. Paths into arrays work. The README says dotted paths "reach into arrays/groups". A test was written and fails; it was left out so the suite stays green.

### For the lead

- Fix the group-path bug above, then add the test (`visitPaths({ meta: { title: 'Hello there' } }, ['meta.title'], …)` should find the text).
- An end-to-end test of translate on publish under Next.js, so the after-response path is proven.
