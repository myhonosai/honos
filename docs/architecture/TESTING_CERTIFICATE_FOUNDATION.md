# HON Testing Certificate Foundation

## Purpose and scope

The Testing Certificate foundation permits a qualified human staff member to record one **internal, school-issued testing certificate** for a known testing candidate in the current school. It is a narrow digital record, not a legal credential, downloadable document, e-signature, rank change, belt fulfillment, notification, or external delivery.

A certificate may be issued only when the candidate is currently `PASSED` and its associated human promotion decision is currently `PROMOTED`. Neither grading nor promotion creates a certificate automatically. Issuance cannot edit grade, promotion, current rank, attendance, billing, membership, curriculum progress, roster, or any parent record.

## Authority and tenant boundary

The fixed PostgreSQL scope resolver and command functions require all of the following at call time and again after relevant locks:

- verified direct `HUMAN_USER` from trusted `HUMAN_UI`;
- exactly one current active staff identity and current organization/school scope;
- active Essential, Core, or Complete entitlement;
- exact `testing.certificate.read` or `testing.certificate.issue` permission;
- no Action Engine request, delegation, AI employee, parent/family/student, public, or HQ path.

Clients send only a known school UUID, known testing-candidate UUID, immutable-creation expected versions, a safe bounded title, and an idempotency key. These selectors locate a record; they do not provide authority. The restricted runtime role has no direct table access and can execute only the resolver/read/issue functions.

## Data and immutability

`hon.testing_certificates` stores the candidate, enrollment, curriculum, target rank snapshot, title, issue time, human issuer, and immutable version-one identity. Composite foreign keys and prerequisite triggers keep the candidate, enrollment, rank, school, candidate result, and promotion relationship aligned. Any change that would invalidate an issued certificate's `PASSED` plus `PROMOTED` prerequisite is rejected.

Certificate requests are idempotent per actor/school/key and fingerprint; unchanged replay returns the original receipt. A private certificate evidence row is permanently `INERT` with `execution_allowed = false`. The normal atomic audit record is retained. Neither artifact has a dispatcher or consumer.

## Safe projection and web surface

The server returns only certificate ID, target rank ID/name, title, issue time, immutable version, and issued status, along with the known candidate ID/version and eligibility status. It never returns student/family contact, staff identity, notes, instructor rationale, private documents, payment, attendance, AI, provider, Action Engine, or audit/outbox details.

The authenticated, no-index, same-origin `/staff/testing/certificates` workbench accepts known UUID selectors. It displays explicit unavailable, access, conflict, and no-result states. The three HON presentation modes change only appearance; they do not alter authority or behavior.

## Verification

Use the dedicated local disposable PostgreSQL fixture only:

```bash
export HON_TESTING_CERTIFICATE_RESET=LOCAL_DISPOSABLE_ONLY
export DATABASE_URL='postgresql://hon_testing_certificate_owner:<local-password>@localhost:5432/hon_testing_certificate_validation'
export HON_RUNTIME_DATABASE_URL='postgresql://hon_testing_certificate_runtime:<local-password>@localhost:5432/hon_testing_certificate_validation'
pnpm db:setup-testing-certificates
pnpm db:test-testing-certificates
```

The fixture uses a BYPASSRLS migration owner and a non-superuser, non-BYPASSRLS, non-inheriting, no-createdb, no-createrole runtime role. It cannot target a remote database. Focused API/web tests and canonical RLS/verifier checks supplement this proof.

No provider, AI inference, Action Engine execution, automation, message, payment, or external document delivery is activated by this foundation.
