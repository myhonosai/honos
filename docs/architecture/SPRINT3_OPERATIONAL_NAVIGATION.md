# Sprint 3 operational navigation

This is a frontend composition on local owner-entry checkpoint `70d2b68`, whose production frontend matches reviewed #134. It adds no data reader, command, permission, policy, schema or provider capability.

## User path

The existing login continuation and school verification remain unchanged. Verified school entry now also offers staff invitations and family account access. Its existing CRM, registration, membership, booking and attendance links continue into the reviewed CRM journey; student selection and the membership/class handoff stay inside that journey.

The verified dashboard offers the same school operations navigation. The CRM journey offers dashboard/account navigation only after an explicit authorized lead read, with an identifier-free return to school entry. An empty, idle CRM page also offers that fixed return. New navigation uses native anchors, EN/KO/ES labels and local responsive CSS in all three existing presentation modes. No protected shared visual or asset file changes.

All new scoped URLs carry only `organizationId` and `schoolId`. The helper builds a fixed local route set and serializes only those two fields, even when its caller holds additional verified report metadata. It never serializes student, family, membership, invitation, token, retry, principal or role values.

## Destination selector contract

`apps/web/src/components/operational-navigation.ts` exports:

```ts
parseOperationalSchoolSelectors(query: unknown): {
  initialOrganizationId?: string;
  initialSchoolId?: string;
}
```

Only a complete pair of ordinary UUID strings is accepted and normalized to lowercase. Missing, partial, malformed, duplicate/array or additional query fields yield an empty object. The helper does not fetch, command, persist or claim authorization.

The staff and family workstreams own their destination pages and optional initial props:

- `/staff/team/invitations`: `StaffInvitations`, with inert `initialOrganizationId` / `initialSchoolId`; invitation acceptance remains separate and ignores these selectors.
- `/staff/family-access`: `FamilyAccessWorkspace`, with the same inert props. A family must still be explicitly supplied through the destination's existing workflow; no family directory or inferred family is introduced.

Both workstreams received the helper-only dependency commit and the precise page integration. These destinations are deliberately not reimplemented on this branch. The combined candidate must include their independently authorized routes; navigation does not establish destination availability or command authority.

## Privacy and command lifetime

School entry retains its existing same-identity/exact-school/revision controller. New entry links share its private wrapper, synchronous native `href` retirement and retained-callback guards.

The dashboard wraps its existing navigation, team band and report content in local private areas while retaining their existing relative positions. Blur, hidden visibility, pagehide, session invalidation and school-context changes synchronously hide/inert those areas and remove native link targets. The scope section containing school badges, selectors and authorized choice labels also retires synchronously; its separate privacy key recreates an empty scope form without remounting ordinary input edits. Scope edits and verification changes advance the existing read generation. Late reports and preferences cannot restore old navigation. Focus never restores it; an explicit report verification is required. Session invalidation prevents in-page resumption. Existing selector-free automatic current-school behavior remains unchanged; query prefills do not drive it.

CRM links bind both scope selectors and the live read revision. Drafts, pending/in-flight commands, active reads, required refresh, privacy concealment, session loss and unresolved trial holds disable the new links. Existing toolbar/help/follow-up/registration/membership exits use the same leave guard so they cannot bypass recovery. The existing abandon confirmation and exact command retry remain unchanged. An abandoned unknown trial still retains its negative mounted hold and disables these exits after rereading or switching leads. No new cross-document recovery claim is made: arbitrary browser navigation, reload or document loss retains the existing memory limitations.

Presentation and language changes do not initiate school reads. The existing scoped dashboard presentation save is preserved and independently guarded; this change adds no preference persistence.

## Verification

On this isolated frontend tree:

- 157 focused tests pass across eight suites: operational navigation, school-entry controller/presentation/page session, CRM journey UI/page, dashboard UI and dashboard presentation/scope lifetime. Coverage includes both organizations, strict inert selectors, native anchors/localization, stale callbacks, synchronous concealment, revoked access, late reads, no focus restoration, all modes/languages without school reads, and draft/in-flight/unknown/trial-hold protection.
- Follow-up review added regressions for synchronous retirement of the dashboard scope section and the actual HON band wrapper. The dashboard and HON command suites pass all 80 tests, retaining three-mode/no-fetch band checks and requiring the current verified/private guard. The older exact source-string assertion was updated for that stronger guard.
- Web TypeScript checking passes. Local package artifacts were built from this worktree through the installed TypeScript compiler; `pnpm prepare:workspace` could not initialize its default home store, so it is not recorded as a passing pnpm command.
- The existing owner-entry real API/browser script now maps the helper when transpiling the actual controller, asserts exact staff/family/dashboard URLs for both organizations, and checks keyboard focus/localized account links in its existing three-language/three-mode/three-width matrix. Script syntax passes; the browser/API/database script was not executed here.
- `git diff --check` passes. Backend, schema, configuration, policy and protected visual sources remain unchanged.

Root owns one combined-candidate full workspace/build and real browser/API/disposable PostgreSQL verification after composing the staff, family, HQ and owner-workflow workstreams. No full-candidate, browser, database, deployment, push or hosted-CI success is claimed by these focused results.
