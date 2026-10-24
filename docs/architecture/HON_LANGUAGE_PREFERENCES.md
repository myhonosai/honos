# HON interface language persistence (backend)

**Status:** implemented on `claude/language-preferences` (migration `0171`), pending owner approval. Claude owns persistence and authorization. Codex owns the language selector, translation catalogs and every frontend page.

## Rules

| Rule | How it is enforced |
|---|---|
| A personal preference belongs to the verified user | It is stored against `hon.users`, resolved from the authenticated identity subject. No user id is accepted from the browser: there is none in any path, query or body, and unknown fields or `x-hon-*` headers are refused |
| Only you can change yours | The update function resolves the actor from the subject. The identity must have exactly one active human principal and no tenant or action context |
| It persists across sessions, devices, schools and organizations | It is keyed by user, not by school or session. Account and school changes leave it untouched |
| A school default is set only by an authorized owner | Requires `settings.language.manage` at that exact school, through a staff role (never a family, HQ or platform role). The permission is granted to system OWNER roles and to every newly provisioned owner. A revoked grant loses access immediately |
| A default change never overwrites personal preferences | The two values are separate rows. The proof checks that personal rows are unchanged |
| Precedence | Personal preference, then the default of the school named in the request (only when you belong to that school), then English. A multi-school user's school is never guessed: without `?schoolId=` only personal or English apply |
| Audit | Every change (personal and school) writes an append-only history row (prior, next, version, actor, request ids). Records cannot be deleted, and current rows only move forward one version at a time |
| Safe concurrency | Updates carry `expectedVersion` (0 when nothing exists yet); a stale value gets `409 LANGUAGE_VERSION_CONFLICT`. The `Idempotency-Key` makes a retry return the first result (`replayed: true`); the same key with a different request gets `409 IDEMPOTENCY_KEY_REUSED` |
| Independent | Separate from appearance (`principal_interface_preferences`), timezone, currency and billing. No AI, credits, payments or messages |

Languages: `en`, `ko`, `es` (`HON_LANGUAGES`; default `HON_DEFAULT_LANGUAGE = 'en'`).

## API (contracts in `@hon/contracts`, file `language-preferences.ts`)

| Method and route | Request | Response `data` |
|---|---|---|
| `GET /v1/me/language-preference[?schoolId=<uuid>]` | — | `MyLanguagePreferenceView` · `validateMyLanguagePreferenceView` |
| `POST /v1/me/language-preference` | `LanguageUpdateInput` `{ language, expectedVersion }` · header `x-hon-human-command: language-preference-update` | `MyLanguagePreferenceReceipt` · `validateMyLanguagePreferenceReceipt` |
| `GET /v1/schools/:schoolId/language-default` | — | `SchoolLanguageDefaultView` (with `canManage`) · `validateSchoolLanguageDefaultView` |
| `POST /v1/schools/:schoolId/language-default` | `LanguageUpdateInput` · header `x-hon-human-command: school-language-default-update` | `SchoolLanguageDefaultReceipt` · `validateSchoolLanguageDefaultReceipt` |

**Request rules:**
- Commands follow the existing human-UI pattern: same-origin `POST`, `Content-Type: application/json`, the exact command header from `LANGUAGE_COMMANDS`, a UUID `Idempotency-Key`, and no query string.
- Reads are `GET` with no body. Every response is `Cache-Control: private, no-store`.

**Errors:**

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_LANGUAGE_INPUT` | Invalid language, version, key or field |
| 403 | `LANGUAGE_FORBIDDEN` | Not your school, no permission, or an ambiguous or inactive identity. A school you don't belong to looks the same as one that doesn't exist |
| 409 | `LANGUAGE_VERSION_CONFLICT` | Stale `expectedVersion`. Re-read, then retry with the new version |
| 409 | `IDEMPOTENCY_KEY_REUSED` | The same key was used for a different request |

## Integration steps for Codex

1. **On sign-in**, read the active language from `effective.language`:
   - Call `GET /v1/me/language-preference?schoolId=<current school>` when a school is in context (from your verified current-school read).
   - Otherwise call it without `schoolId`.
   - Never compute precedence in the browser.
2. **Language selector:** `POST /v1/me/language-preference` with `{ language, expectedVersion: preference?.version ?? 0 }` and a fresh `Idempotency-Key` per user action. Reuse the key only when retrying an unknown outcome. On `409 LANGUAGE_VERSION_CONFLICT`, re-read and show the current value.
3. **School settings:** `GET /v1/schools/:schoolId/language-default`. Show the editor only when `canManage` is true, then `POST` with `expectedVersion: version` (0 before the first save). The server re-checks authority on every call, so `canManage` is a display hint, not a grant.
4. **Cookie storage** may remain a fast first paint, but the server value wins once it loads.

## Evidence

`test-language-preferences-integrity.mjs`, registered in CI, runs against a disposable PostgreSQL 16 database through the real service. It covers:
- **Identity:** staff, HQ and family users each keep their own preference; ambiguous, inactive and unknown identities are refused.
- **Portability:** the preference follows the user across schools and a fresh service instance.
- **Closed input:** a browser user id, unknown fields, unsupported languages and bad versions or keys are refused.
- **School default:** set only by the exact-school manager. Staff without the permission, another school's owner, HQ, family and ambiguous identities are refused. It never changes personal rows. Reading it requires membership of the school.
- **Precedence:** including a multi-school owner whose school is never guessed.
- **Revocation:** a revoked grant loses access immediately.
- **Audit:** prior and next values recorded; evidence is append-only, and current rows move only one version at a time.
- **Concurrency:** six racing first saves produce exactly one winner, and six same-key calls produce one effect and one audit row.
- **Context:** a tenant or action database context is refused.
- **Appearance:** theme preferences are untouched.
