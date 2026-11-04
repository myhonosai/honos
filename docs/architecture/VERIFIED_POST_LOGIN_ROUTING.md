# Verified owner entry integration

This continues PR #111 on reviewed integration #129 `c14a2b110bce4e04b63cd3fe218a560fdcf246e9` and accepted main `8257ad26afde65896d3aa1adcb0aabed08d75051`. The normal main-ancestry merge preserves #129’s exact reviewed source tree. No backend, shared contract, migration, canonical ACL or existing CRM/membership/booking/attendance component is changed.

## Working path

The existing callback retains OIDC/PKCE/state/nonce/issuer/verified-email checks and issues the normal HON session, then redirects to `/auth/continue`. That fixed no-store route accepts no query or role/school hints and verifies the session before and after bounded server reads.

- A verified `GET /v1/hq/session` resolves to `/hq`. Other HQ errors do not fall through to another authority plane.
- HQ 403 followed by canonical `GET /v1/staff/current-reporting-school` RESOLVED resolves to `/staff/entry` without IDs in the redirect.
- An exact MANUAL_ENTRY_REQUIRED result may consult canonical `GET /v1/staff/reporting-schools`. Only its closed, bounded SELECTION_REQUIRED result opens entry for explicit school selection. It never chooses the first school.
- Any 401 returns to sign-in. Unsupported, suspended, unresolved or unavailable scope stays neutral at `/auth/access`, which is localized EN/KO/ES. No parent-content reader is probed.

The school entry screen independently checks same-subject identity, canonical current/choice reads, the exact organization/school operations-report validator and same-subject identity again. Only then are workflow links shown. Aggregate values are not retained or displayed. Authorized multi-school labels come only from the existing bounded reader; no directory is fabricated for exact-one resolution.

CRM, registration, membership recovery, student booking and attendance all enter the existing connected CRM journey with inert organization/school selectors. Staff select a lead, recover individual memberships and use the already reviewed student-bound handoff. No student/membership ID, role, authority, retry request or secret is added to a URL. Every destination independently authorizes; navigation is not proof of payment, effective benefits, registration, booking or attendance. Dashboard scope is also reverified there, with explicit multi-school reselection.

## Privacy and failure boundaries

Blur, hidden visibility, pagehide, shared session invalidation, school-context changes and unmount synchronously hide/inert the private DOM, abort reads and advance ownership revisions. Retained links/choice callbacks cannot act under an old revision. Focus alone never restores data. Restoration explicitly performs fresh identity and school checks. A confirmed session loss disables in-page restoration; a new authenticated document must perform fresh reads. Local 403 remains local denial. No browser storage or business mutation is introduced; presentation/language changes never read school data.

Existing consequential command ownership, exact UNKNOWN URL/body/key retries and synchronous attendance callback retirement remain byte-identical to #129. There is no new global navigation control that discards their private recovery memory. Full-document loss retains its existing limitations.

## Verification and remaining gates

New controller/HTTP/session/presentation regressions cover both organizations, stale/aborted reads, live scope denial, 401 versus 403, no fabricated empty list and all translations. The dedicated additions to the existing four-job integration workflow run actual Next + signed synthetic HON sessions + real Nest identity/HQ/staff resolvers + restricted marked disposable PostgreSQL, followed by mounted browser navigation/accessibility in all three languages, modes and 390/834/1440 widths. Test-only synthetic ACTIVE entitlements are created only inside the established disposable fixture, never through a runtime access exception or approval record. These are not external OIDC-provider or deployment evidence.

Local Node uses the installed cached dependencies; full pnpm and PostgreSQL evidence must come from the supported hosted workflow. Record actual final results in the PR, never infer them from source or a skipped job.

Accepted backend sequence remains #108 → #109 → #110 → #118 → #119 → #120 → #122; #129/#126/#127 are unmerged dependencies, not merge authorization. Claude owns #130 (`50ed01f…`) and its timestamp-order correction. This candidate preserves the existing HTTP 500 reproduction on the unchanged backend; once the approved correction is accepted, flip that harness assertion to a positive exact-source read in a separately reviewed delta. Do not weaken response validation or normalize production precision.

New schools remain suspended. This screen neither grants an exception nor approves D10 policies, trial enrollment, paid access, subscriptions, providers or AI spending. Private environment hosting, normal identity-provider setup, legitimate test-school access and owner merge authorization remain separate gates.

## Precise Claude/backend dependency — not implemented

Add a minimal selector-free, signed-session `GET /v1/parent/current-access` only after independent contract/security review. Proposed closed response: `{data:{state:'RESOLVED'|'NO_ACCESS'|'SELECTION_REQUIRED'}}`, with **no** principal, organization, school, family, child, contact, schedule, billing or document fields. Return private/no-store before authentication errors; reject query/body/authority/delegation/command inputs. Invalid identity is 401; infrastructure/unverifiable state is unavailable, never a successful negative classification.

Reuse [guardian discovery](../../packages/database/migrations/0087_parent_journey_read_scope.sql), the [live exact-family resolver](../../packages/database/migrations/0071_curriculum_progress_read_and_integrity.sql) and current restricted runtime posture. Verify a unique active human and current active school/organization/family topology, non-expired explicit grant, exact-scope revalidation and `PRIMARY_GUARDIAN` or `SECONDARY_GUARDIAN` access. Preserve multiple-family ambiguity; do not select the first family. `VIEWER` access must not be relabelled guardian. The new read must have no writes, audit/outbox effect, impersonation, school entitlement shortcut or broader family-content access.

The existing [Parent Journey API](../../apps/api/src/families/parent-journey-view.service.ts) already discovers family scope, but also retrieves children, curriculum, schedules, awards and documents and permits viewer access. It is deliberately **not** probed for login routing. No guardian endpoint is invented or called by this frontend. Once the minimal reader is independently delivered, connect its verified `RESOLVED` result to `/parent` in a separate integration, with denied/viewer/ambiguous/revoked/expired/cross-family and no-content/no-write proofs.

## Review and release boundary

The original #111 standalone synthetic routing harness remains available as a focused diagnostic, updated for the three permitted fixed reads. Its old separate workflow is superseded by the existing four-job integrated verification workflow to avoid an additional duplicate dispatch. Historical #111 results are not fresh evidence for this candidate.

The external identity provider, private environment, legitimate test-school access, backend acceptance, source merge and deployment require their own checkpoints. Staff/parent invitation gaps and public signup remain outside this slice.
