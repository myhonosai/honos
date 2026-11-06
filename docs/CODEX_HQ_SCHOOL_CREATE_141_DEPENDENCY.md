# HQ school creation — isolated frontend composition with #141

This continues the existing #112 UI. Prepared frontend `05fa605a0ff2329dbe0d8ddb8612375bd4b13245` was normally fast-forwarded into the existing local `codex/hq-create-school-integration` branch, preserving its original `a57197f2129ed27846697004df1830e663d430aa` checkpoint (tree `21f27d602c52ec349a1bf3dbd30e74a31de54e71`) and all earlier work. Published #112 remains unchanged.

**Local dependency composition:** isolated `codex/hq-school-create-141-composition` normally merges accepted main `389f7d131192f5734a7a09e1ff08b6af26f8e06b` (197 migrations) and exact [draft #141](https://github.com/myhonosai/honos/pull/141) source `f711ded42d1cc4a9d2076a9339139fb4a0f0a7e1` (tree `efc8665f5822647381c498d6e6b2eda082d7a508`). Composition merge `0ebe029` resolves shared backend overlaps using that exact source. All `apps/api`, `packages` and `infra` bytes equal #141; all 197 accepted-main migration files and checksum entries remain unchanged. Its additional `0206`–`0208` files are inherited without edits, producing 200 checksum-locked migrations.

The workstream handoff records backend source acceptance, including the P3 correction and tracker update. **#141 is still unmerged.** This local source composition does not authorize operational activation or migration application. Merge/stack and final migration allocation, final combined-head verification and owner release gates remain. No push, CI dispatch, PR metadata, remote database, provider call or deployment is included.

## Inspected contract

The exact-head [service](https://github.com/myhonosai/honos/blob/f711ded42d1cc4a9d2076a9339139fb4a0f0a7e1/apps/api/src/hq/hq-onboarding.service.ts), [human guard](https://github.com/myhonosai/honos/blob/f711ded42d1cc4a9d2076a9339139fb4a0f0a7e1/apps/api/src/hq/hq-school-provisioning-human.guard.ts), controller, API tests and [D9 section 5](https://github.com/myhonosai/honos/blob/f711ded42d1cc4a9d2076a9339139fb4a0f0a7e1/docs/architecture/HON_SECURE_HQ_PROVISIONING.md) specify:

- The existing six DTO fields and UUID idempotency key remain unchanged. The POST additionally requires `X-HON-Expected-Principal` from the explicitly verified HQ session. The browser retains same-origin/no-store transport and the existing human command marker.
- Success is exactly `{ data: { organizationId, schoolId, ownerRoleId, replayed, actorPrincipalId, entitlementStatus }, meta: { replayed } }`, HTTP `201` for creation and `200` for replay. The actor UUID must equal the immutable request's expected principal, case-insensitively. The status is exactly `ACTIVE`, `SUSPENDED` or `ARCHIVED`; a fresh receipt must be `SUSPENDED`. Replay status is a response-time observation, not operating-access or payment authority.
- The service maps an expected-actor mismatch to HTTP `409` with exactly `{ code: 'HQ_EXPECTED_PRINCIPAL_MISMATCH' }`. The current attempt is refused before any write. Other 409 codes include conflict and in-progress; an unrecognized, malformed or augmented error does not establish a known refusal.

## Frontend delta and recovery

`hq-onboarding-http.ts` sends the expected principal from the frozen request capsule. Its receipt parser requires every new field and rejects all old four-field receipts, unknown fields, wrong actors, invalid UUIDs, unsupported statuses, non-suspended fresh receipts, inconsistent replay flags and wrong HTTP statuses. There is no old/new contract fallback, alternative endpoint or invented shared contract shim.

An exact recognized mismatch conceals creation details and asks the operator to explicitly verify the original HQ-owner account again. It does not broadcast a global 401 or call a 409 an unknown outcome. The original capsule remains in mounted memory: a mismatch on this attempt cannot erase an earlier unknown attempt or justify a replacement key. Restoration under another principal stays refused; restoration under the original principal still requires human confirmation before the exact same request is sent. A wrong-actor success or any other unverified response preserves unknown-outcome recovery and never exposes its receipt.

The existing privacy events, command lease, read epochs, confirmation reset, pre/post identity verification, EN/KO/ES copy, presentation modes and directory behavior remain. The UI continues to display only the existing creation IDs and replay result; actor/status validation does not create a new access, payment, onboarding or entitlement capability. Atomic expected-actor enforcement belongs to the separately reviewed #141 database path; the frontend checks do not implement it.

## Connected harness and remaining gates

The browser fixture emits only the six-field dependent receipt and records/checks the expected-principal header. It prepares wrong-actor and known-mismatch recovery, refusal to restore another owner, and an unknown outcome followed by a mismatch, privacy concealment and explicit original-owner exact retry. This fixture verifies frontend behavior; its synthetic API does not establish backend authority.

The signed-session API harness loads the actual `HqSchoolProvisioningHumanGuard`, controller, resolver and database path from this same composition. Twelve malformed wire requests cover missing/foreign Origin, Fetch Metadata, missing/wrong marker, missing/invalid expected principal, added authority/bearer headers and missing key, with unchanged whole-table snapshots. Its lost-response case commits through the actual API, then changes only the signed browser cookie to a second real fixture HQ owner at POST dispatch. The real database must refuse the expected-principal mismatch without writes. The actual frontend must conceal it, refuse another owner's restoration, preserve the earlier unknown capsule through privacy, and replay only the original principal/body/key after fresh human confirmation. No authority mock, guard replacement or old-contract fallback is used. These connected checks have not been executed locally.

Preserved preparation evidence at `05fa605`, under Node `v24.19.0`: all 62 focused tests (55 preserved plus seven), web typecheck, the native-ESM loader regression, syntax checks of both harnesses and both loader files, 196 migration checksum validations and `git diff --check` pass. Commands reused installed dependency/generated-config caches; no packages were installed or package source altered:

```bash
# apps/web
node node_modules/vitest/vitest.mjs run test/hq-onboarding.test.tsx test/hq-school-directory-lifecycle.test.ts test/hq-school-directory-ui.test.tsx test/public-plan-catalog.test.ts test/hq-school-management-localization.test.tsx test/hq-school-session-retirement.test.ts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
# repository root
node apps/web/scripts/hq-school-create-frontend-loader-check.mjs
node --check apps/web/scripts/hq-school-create-api-verification.mjs
node --check apps/web/scripts/hq-school-create-browser.mjs
node packages/database/scripts/verify-migrations.mjs
git diff --check
```

Fresh local composition validation under Node `v24.19.0` passes all 1,358 web tests in 152 files, including the 62 HQ/catalog regressions. All six workspace package TypeScript builds, API Nest build, production Next build, and explicit API/web `tsc --noEmit` checks pass. Two socket-free tests from the actual #141 API test file validate its closed receipt and database-error mapping; the listener-based controller test was excluded explicitly:

```bash
# apps/api, after the actual source build
node --test --test-isolation=none --test-name-pattern='^(closed provisioning receipt|database failures)' test/hq-school-provisioning.test.cjs
```

The native-ESM loader regression, four harness/loader syntax checks, 200 migration checksum validations, explicit comparison of all 197 accepted-main checksum entries, exact #141 API/packages/infra tree comparison and `git diff --check` also pass. No local HTTP listener, browser launch, database proof or install retry was attempted. This is local source/build evidence, not a full root test or connected proof result. Pinned-Node-22 combined-head repository and hosted verification remain required.

No HTTP field ambiguity remains in the inspected #141 head. Its source acceptance does not close merge, migration allocation or release gates; any backend revision must be rechecked. Actual signed-session API/disposable-database/browser/accessibility evidence remains unverified for this composition. The shared staff PostgreSQL proof's known line-101 409-versus-503 failure is preserved; it was neither edited nor reclassified here. Existing #112 hosted evidence is historical and does not prove this dependent contract.
