# A2P-1 backend contract for Claude frontend

Read `docs/architecture/A2P_REGISTRATION_ASSISTANT.md` and the exact exported
types/validators in `packages/contracts/src/a2p-registration.ts`. Do not import
unmerged runtime code into a merge candidate. Synthetic frontend fixtures must
remain isolated from real authentication and never become public bypass routes.

## Transport

All routes use `/v1/organizations/:organizationId/schools/:schoolId/a2p/` (web
same-origin rewrite `/api/v1/...`). All five are **POST, read-only**, HTTP 200 on
success, with `{data: ...}` and private/no-store responses. No query parameters.

Required: current signed `hon_session`, `Origin` matching `HON_PUBLIC_ORIGIN`,
`Content-Type: application/json`, `X-HON-Human-Command: a2p-prepare`, and browser
Fetch Metadata `Sec-Fetch-Site: same-origin`, `Sec-Fetch-Mode: same-origin`,
`Sec-Fetch-Dest: empty`. Never send provider keys, authority/principal/role/tier
headers, or business facts in URLs. No client-supplied actor or scope in bodies.

| Suffix | Closed input | Response type |
| --- | --- | --- |
| `website-review` | `A2pWebsiteReviewInput` | `A2pWebsiteResponse` |
| `finding-details` | `{review: A2pWebsiteReviewInput, findingCode: A2pFindingCode}` | `A2pFindingResponse` |
| `registration-draft` | `A2pDraftInput` | `A2pDraftResponse` |
| `draft-validation` | `A2pDraftInput` | `A2pValidationResponse` |
| `copy-preparation` | `{input: A2pDraftInput, expectedDigest: string, acknowledgement: A2P_COPY_CONFIRMATION}` | `A2pCopyResponse` |

Unknown/missing object fields are rejected. Explicit null means a missing fact;
it is not replaced with made-up details. Use `validateA2pWebsiteReview`,
`validateA2pDraftInput`, `validateA2pFindingInput` and `validateA2pCopyInput` before
sending. Purpose enums are internal preparation categories, **not approved Twilio
campaign codes**; actual brand/use-case eligibility is always NOT_VERIFIED.

No idempotency header is required because nothing is written or sent. Same
normalized input + school + engine version produces the same digest. A digest
does not authorize access; every request independently resolves current access.
An access denial on a repeated request must not fall back to old results.

## Important frontend states

- Current permission: `communication.a2p.prepare`; current exact-school staff
  permission and active in-window entitlement are required. HQ/parent/AI and
  delegated contexts are refused. OWNER is not a browser authorization shortcut.
- Live inspection is **always UNAVAILABLE** in A2P-1. No hidden env override,
  website fetch, browser crawler or uploaded HTML/fixture selector is accepted.
- PASS concerns a bounded observation, not legal/carrier approval. Fixture
  evidence is visibly SYNTHETIC_FIXTURE; no fixture is a public website check.
- Facts are owner statements, not independently verified consent evidence.
  Only a current school OWNER with the preparation permission may assert the
  fact confirmation or prepare copy. Use the server's `scope.canConfirmOwnerFacts`;
  staff with delegated preparation permission may inspect/check missing facts but
  cannot impersonate owner confirmation. A client role label grants nothing.
  `OWNER_CONFIRMED_FACTS_FOR_DRAFT_ONLY` is explicit draft input, **not saved
  approval or customer consent**. All actual opt-in methods belong in messageFlow.
- Missing business/support/URL/frequency/flow facts, short flows or absent
  confirmation produce NEEDS_INPUT. Do not enable copying incomplete drafts.
- Marketing templates need separate consent confirmation. Service and marketing
  claims cannot be silently substituted. No discount or fee is invented.
- Copy/export must use the most recent digest and
  `COPY_DRAFT_FOR_EXTERNAL_OWNER_REVIEW`. It returns text for deliberate human
  copy/download; no upload, external submission or SMS occurs. Keep the review
  warnings visible. HELP/STOP replies are samples, not actual configuration.
- Every response has `readOnly: true`, `persistence: NONE`; drafts additionally
  have `saved:false`, `submitted:false`, `consentRecorded:false`, `messagesSent:0`.
  Never show Saved/Registered/Approved/Sent or claim history can be recovered.
- Draft/sample language is English in v1. Preserve shared UI localization rather
  than representing all future SMS/template languages as implemented.

## Errors and client safety

401: session unavailable/expired. 403: HUMAN_UI_REQUIRED or
A2P_PREPARATION_FORBIDDEN or A2P_OWNER_FACT_CONFIRMATION_REQUIRED. 400: INVALID_A2P_INPUT, A2P_URL_NOT_ALLOWED or
A2P_CAMPAIGN_MISMATCH. 409: A2P_SCHOOL_CHANGED, A2P_DRAFT_CHANGED or
A2P_DRAFT_INCOMPLETE. 503: A2P_PREPARATION_UNAVAILABLE or
HUMAN_UI_ORIGIN_NOT_CONFIGURED. Never display raw SQL/provider errors.

Use explicit actions, disabled duplicate submission, abortable reads and epoch
guards. On school/session change or focus loss, conceal old facts and results;
restore only after fresh authorized requests. Do not store business drafts,
reviews or receipts in browser storage, URLs or telemetry. Render returned text
as text, not HTML, and open evidence/source links only deliberately with safe
link attributes. Local privacy state is not evidence of permission.

## HON integration and next gates

The frontend can explain finding remediation and cite the ruleset sources without
any paid AI call. `A2pHonExplanationContext` is a future typed context, not an
Action Engine registration or independent sending authority. No tool, model,
provider credential or arbitrary page instruction receives execution privileges.

Separate reviews are needed for durable assessment/history/approval, retention,
live SSRF-safe inspection and actual provider registration. No Twilio/Zernio key,
SMS delivery, account activation, payment, AI spending, public URL inspection or
deployment is authorized by this contract. PRs #78–#80 are unrelated and unchanged.
