# Changelog

## 0.3.0 (2026-11-11)

- **Behavior change (2026-11-11): only admin users manage translations by default.** With no `canManage`, any signed-in account of any auth collection, members included, could start translations (which can cost money), change Translation settings, and read or clear the translation memory and status. Now only users of the admin collection (`admin.user` in the Payload config) can. Sites relying on the old default must pass the option.
- **Only an exact `true` from `canManage` or `canConfigure` counts.** Any other truthy answer, an object or an error is a no: 401 or 403 from the endpoints, never a 500, and no view, menu link or banner. The settings global no longer passes the site's answer to Payload as its access.
- The translation memory and status collections are now read and cleared by managers only, not by anyone signed in.
- **Only an exact `true` from `enabled` turns translation on (2026-11-11).** Any other truthy answer, an object or an error now means turned off: no translation on publish, "Translate now" answers 400 rather than a 500, and the dashboard shows it off. With no `enabled`, translation runs as before.
- **`syncAll()` asks `enabled` too (2026-11-11).** A sweep, dry runs included, is skipped unless it answers exactly `true`; it returns `stopped: 'off'` and logs "sweep skipped: translation is off". Before, a scheduled sweep translated (and spent) while translation was off. From a cron or script, `enabled` gets a local request with no user (`createLocalReq`); "Translate now" passes its own request.

Tested: 56 tests (18 new, in `test/enabled.test.ts`), 24 mutation checks (11 for `enabled`), with a fake translator only.

Earlier versions: see the GitHub releases.
