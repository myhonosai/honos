# HON Parent/Eian Family Scope Resolution

`hon.resolve_parent_family_scope(externalSubject, schoolId)` is the runtime bridge for the future Parent App/Eian. It is a fixed-schema, `SECURITY DEFINER` function; the non-privileged `hon_runtime` role can execute it but cannot directly select the global identity directory or `family_access_grants`.

A result exists only when all conditions are true:

1. The account’s verified `external_subject` maps to an active `HUMAN_USER` principal.
2. That principal has an active, time-bounded `family_access_grant` in the requested school.
3. The result is returned for the grant’s own organization and school, never a client-declared organization.

The resolver returns a distinct family scope and the highest active access level for each family. Parent APIs must still constrain every requested child/student, schedule, document, payment method update, or message to that resolved family scope. A family relationship, email, phone number, shared device, school-staff role, or HQ role alone is insufficient.

Family grant creation/revocation will be a separate staff-authorized, audited command. This prevents the Parent App from creating its own authority or exposing cross-family data.
