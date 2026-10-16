# Private curriculum reference library

## Immutable boundary

Migration **0132_private_curriculum_resource_library.sql** adds conventional, human-approved **metadata references**, not media integration. A reference has a fixed `VIDEO`/`LINK` kind, fixed HTTPS URL, curriculum and optional exact rank. Those identity fields cannot change; corrections require archiving and creating a different reference. Title (160 characters), plain description (600 characters) and `STAFF`/`PARENT` audience may receive explicit versioned edits. Archive is final, bounded state—not deletion. Every version, command receipt and local fact is immutable, including against privileged accidental UPDATE/DELETE/TRUNCATE.

**No fetching, copying, player, iframe, preview, transcription, summarization, analysis, AI access, storage upload or provider integration exists.** References never become requirements, practice completion, readiness, testing, promotion, payment, messages, Action Engine work, assignments or automation triggers. School approval is the direct authorized human's act of recording the metadata; HON does not verify remote content. External browsing happens only through a verified anchor with `target="_blank" rel="noopener noreferrer"`. No server follows a resource URL.

URL validation is **lexical only**, identically enforced in shared contracts and PostgreSQL. Only lowercase ASCII, multi-label DNS hostnames and a bounded HTTPS path/query alphabet are accepted. Credentials, ports, fragments, whitespace/control characters, backslashes, percent encoding, IP literals (including numeric/IPv6 forms), unsafe/empty labels and local/reserved hostname suffixes are rejected. There is **no DNS resolution** or guarantee about remote content or a hostname's eventual DNS destination. This boundary intentionally prevents server-side URL invocation rather than implementing a crawler or media sandbox.

## Authorization and persistence

Staff routes require one **known school UUID**, existing exact school-scoped `curriculum.manage`, a unique active `HUMAN_USER`, `HUMAN_UI`, no action/delegation, active school/organization and a current active **Essential/Core/Complete** entitlement. No HQ permission fallback or school/staff/student/family directory is introduced. Organization/principal are derived from the verified external subject and live authorized scope, never from a body.

`hon.lock_curriculum_resource_actor(text)` follows the 0070 curriculum lock order: organization, school, user, principal, grants, roles, role-permission rows and entitlement. It rechecks authority after waits. Commands recheck again after curriculum/rank or resource locks, before writing and before replay. Create expects version `0`; update/archive expect the current positive version. Scoped immutable idempotency receipts bind actor, tenant, key and exact command fingerprint. Identical authorized retries return the original receipt; conflicting keys/versions fail.

All operations use transaction-local tenant/principal/request/source GUCs through the established runtime transaction helper. Only three dedicated SECURITY DEFINER runtime boundaries are executable:

- `hon.read_staff_curriculum_library(text)`
- `hon.mutate_curriculum_resource(text,text,uuid,jsonb,text,uuid,uuid)`
- `hon.read_parent_curriculum_library(text,uuid)` — family argument is **server-derived**, not an HTTP selector.

All four new tables use **forced, deny-all RLS with no policies**, no PUBLIC/runtime/client table or column ACLs, and private helpers. Exact canonical grants and verifier entries cover trusted owners, restricted runtime posture, fixed search path/body hashes, exact function-only ACLs, immutable guards, scoped receipt key and rank relationship. Existing RLS/ACLs and all earlier migrations are unchanged.

A mutation atomically records the resource version, **redacted audit**, idempotency receipt and `hon.curriculum_resource_facts`. These facts have a permanently checked `state='INERT'` and `internal_only=true`, contain identifiers/version/operation only, and are **not** the general outbox. They have no delivery status, worker/consumer grant, dispatch route or downstream handler. Their existence is local immutable evidence only.

## Parent view

`GET /v1/parent/curriculum-library` accepts **no** query, body, tenant/family/child/resource selectors or `x-hon-*` action/authority headers. The service derives exactly one current verified family from the authenticated external subject. Zero or ambiguous scopes fail closed. SQL locks and revalidates identity, live family grant/topology and entitlement; the service checks the same scope again before returning.

Only `ACTIVE`, `PARENT` references join a current `ACTIVE` child profile, explicit `STUDENT` family membership, matching primary family, active enrollment and exact curriculum; a rank-specific reference must match that enrollment's current rank. Null-rank references cover any current rank in that curriculum, including an unranked enrollment. Other-family, other-school, staff-only, archived, other-curriculum and other-rank material is omitted or denied. Results are strictly whitelisted: **title, plain sanitized description, kind, URL, curriculum name, optional rank name and child display name** (consistent with existing parent conventions). There are no IDs, staff identities, audit/history/evidence, provider metadata, progress, testing/readiness, billing or private directory fields.

## UI

- `/staff/curriculum/library`: known-school verification, local curriculum/rank choices, create, versioned metadata edit and archive.
- `/parent/curriculum-library`: selector-free verified read, explicit reverify, no previous protected result after error/blur/pagehide and stale-response suppression.
- Parent Home exposes **Curriculum References** only after a separate selector-free library read succeeds; the Home discards the response, links to the library route and clears/hides the destination on lost scope. This composition does not grant a Home authority or reuse a Journey/testing/billing response as library proof.

Both are authenticated, no-index, no-store routes with synchronized `manus-routes.json`. Big-Button / Modern / Classic affect **presentation only**. Links appear only from strictly verified response data; neither screen contains a player, preview or iframe.

## Validation

The committed fixture setup refuses inherited database URLs, nonlocal targets, provider/execution variables and credential-like environment variables. It requires the exact marked `localhost:5432/hon_curriculum_library_validation` database and transient credentials in a fresh mode-0600 file under a mode-0700 `/home/ubuntu/jobs/...` directory. It never uses normal development/production data. Setup applies all migrations and canonical least-privilege grants twice. Tests use synthetic data only; network traps permit PostgreSQL localhost:5432 only. Synthetic relationship variants and verifier-tampering tests are confined to this marked disposable fixture and restore their guards/ACLs.

From the repository root, using a fresh private job directory and a sanitized environment:

```sh
# The directory must already exist, be owned by the caller and be mode 0700.
env -i PATH="$PATH" HOME=/home/ubuntu LANG=C.UTF-8 \
  HON_CURRICULUM_LIBRARY_VALIDATION_TARGET=postgresql://localhost:5432/hon_curriculum_library_validation \
  HON_CURRICULUM_LIBRARY_ENV_FILE=/home/ubuntu/jobs/YOUR_PRIVATE_JOB/library.env \
  pnpm db:setup-curriculum-library

# Never print/source credentials in a shared shell; use an isolated child shell.
env -i PATH="$PATH" HOME=/home/ubuntu LANG=C.UTF-8 bash --noprofile --norc -c \
  'source /home/ubuntu/jobs/YOUR_PRIVATE_JOB/library.env; pnpm db:test-curriculum-library; pnpm db:verify-rls'

pnpm --filter @hon/contracts build
pnpm --filter @hon/api build
(cd apps/api && node --test test/curriculum-library.test.cjs)
pnpm --filter @hon/web check
pnpm --filter @hon/web exec vitest run test/curriculum-library-ui.test.tsx
node packages/database/scripts/verify-migrations.mjs
```

Integrity evidence covers multiple schools/organizations, deny-all RLS and raw-source denial, exact function posture/ACLs (including tamper rejection), direct-human authority and live revocation after locks, URL filters and curriculum/rank integrity, replay/key/version conflicts and concurrency, archive/history immutability, audit+inert-fact rollback, current parent family/rank/topology and strict redaction, unchanged forbidden domain tables, cleared transaction context and **zero external I/O attempts**. No publication, provider/storage activation or real customer data is claimed.
