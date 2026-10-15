# HON Parent/Eian Family Scope Resolution

`hon.resolve_parent_family_scope(externalSubject, schoolId)` is the runtime bridge for the future Parent App/Eian. It is a fixed-schema, `SECURITY DEFINER` function; the non-privileged `hon_runtime` role can execute it but cannot directly select the global identity directory or `family_access_grants`.

A result exists only when all conditions are true:

1. The account’s verified `external_subject` maps to exactly one active `HUMAN_USER` principal; ambiguous or disabled humans fail closed.
2. That principal has an active, time-bounded `family_access_grant` in the requested school.
3. The result is returned for the grant’s own organization and school, never a client-declared organization.
4. The family, school and organization are active. Effective windows use the live clock, including after lock waits.

The resolver returns a distinct family scope and the highest active access level for each family. Parent APIs must still constrain every requested child/student, schedule, document, payment method update, or message to that resolved family scope. A family relationship, email, phone number, shared device, school-staff role, or HQ role alone is insufficient.

Family grant creation/revocation will be a separate staff-authorized, audited command. This prevents the Parent App from creating its own authority or exposing cross-family data.

## Curriculum progress read checkpoint

Migrations 0070–0071 add a fixed `read_parent_curriculum_progress` projection to the existing authenticated student-journey endpoint. The service reauthorizes the verified subject and exact resolved family inside its transaction, holds identity/topology/grant locks and rechecks after waits and before return; a cached scope is not continuing authority. Child enrollments require explicit STUDENT family membership and a profile with the same primary family.

Only current-rank requirement IDs/labels/kinds/required flags and matching-version recorded status/time enter the new child-safe DTO. Missing or superseded observations are null, not invented scores or testing approval. Notes, private descriptions, instructor identity/rationale and historical evidence remain private. MET and PASSED never imply promotion; that remains a separate explicit human instructor command. Reads are private/no-store.

`/parent` now redirects to the authenticated, no-index `/parent/journey` web UI. Its fixed read endpoint uses an internal subject-only discovery wrapper that delegates to this exact resolver, rejects ambiguous families, projects current authorized child data without IDs, and never accepts client scope selectors. See [Parent Student Journey UI](PARENT_STUDENT_JOURNEY_UI.md) for redaction, unavailable receipt/absence reads, theme/lifecycle and deployment details. The native React Native/Expo Parent App and Eian wiring remain open. See [Curriculum, rank and testing foundation](CURRICULUM_TESTING_FOUNDATION.md) for exact API/grant boundaries and remaining workflow/integration work.
