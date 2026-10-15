# HON Family and Student Scope Foundation

The family/student boundary remains **school operational data**: every family, membership, student profile, and family-access grant contains both `organization_id` and `school_id`, is protected with forced PostgreSQL Row-Level Security, and uses composite foreign keys so a UUID from another school cannot be attached accidentally.

## Core separation

| Entity | Purpose | Does not imply |
| --- | --- | --- |
| `people` | An individual person/contact record | Family membership, student status, parent application access, or billing responsibility |
| `families` | A school-owned household/family unit | A shared account across schools or unrestricted school data access |
| `family_members` | A person’s guardian/student/dependent/other relationship within a family | A verified app identity or permission to access the parent app |
| `student_profiles` | Student-specific operational record associated with a person and optional primary family | Automatic promotion, curriculum completion, billing ownership, or parent authorization |
| `family_access_grants` | Time-bounded permission for a verified application principal to use a specific family scope | School-staff permissions, HQ access, or access to another family |

The later Parent App/Eian authorization resolver must require a verified human principal plus an active `family_access_grant`, then apply the derived family and student scope to family-safe APIs. It must never authorize by email, phone, shared device, or a client-submitted family ID. Staff uses ordinary school scope plus named permissions; HQ remains separate.

The foundation intentionally stores access as grants rather than converting school data ownership. A future authorized move/copy creates an explicit, audited workflow that preserves history instead of silently changing a student record’s owner.
