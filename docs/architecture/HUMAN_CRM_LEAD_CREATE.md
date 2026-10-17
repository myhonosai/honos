# Direct-human canonical CRM lead intake

## Delivered boundary

`/staff/crm/leads` now includes **Create CRM lead** alongside its existing independently authorized list and CRM-only close. The intake stays idle on mount and URL prefill. The human explicitly supplies the current school's known pipeline UUID, known non-terminal stage UUID, primary contact given/family name and, optionally, email and E.164 phone, then confirms and submits.

No pipeline list/editor, contact directory, generic people search, duplicate matching/merge, campaign/attribution editor or second lead/contact model is introduced. Organization/school URL values remain untrusted selectors. Pipeline/stage/contact values are not accepted from URL prefill.

## Existing POST, narrower browser edge

```text
POST /organizations/:organizationId/schools/:schoolId/crm/leads
```

The closed HTTP body contains only `pipelineId`, `pipelineStageId` and `primaryContact`; the latter contains only required `givenName`/`familyName` and optional `email`/`phoneE164`. Names are nonempty, bounded and free of control/bidi override characters. The server preserves the canonical email validator and phone bounds. Raw JSON is validated before DTO transformation, so prototype-shaped extra keys cannot be silently discarded. Source/campaign/attribution/follow-up/authority/downstream fields are not part of this browser edge. The wider canonical `CreateLeadInput`, original DTO and `LeadService` remain available to their separate existing trusted service callers.

The narrow POST guard requires:

- an exact configured public `Origin` from the existing `configuredPublicOrigin` boundary, never request Host or forwarded headers;
- `POST` and `application/json` (optionally UTF-8 charset);
- exact `Sec-Fetch-Site: same-origin`, `Sec-Fetch-Mode: same-origin`, `Sec-Fetch-Dest: empty`, and no navigation `Sec-Fetch-User`;
- exact `X-HON-Human-Command: crm-lead-create` and a valid bounded UUID `Idempotency-Key`;
- no query, including a bare `?`, extra `x-hon-*` contextual header, supplied principal/source/delegator/action context or non-normalized identity authority fields.

The guard is POST-specific; the existing GET still uses its independent signed-identity and `crm.lead.read` authorization. Every guarded create response/denial, including session denial, is `private, no-store`. Missing/invalid public-Origin configuration fails closed.

**Transport is not authorization.** The unchanged canonical `crm.lead.create` resolver remains decisive for the exact current organization/school/principal. The verified subject is passed explicitly into the existing service's locked human authority recheck. The canonical service still checks active Essential/Core/Complete CRM entitlement, current-school non-terminal stage membership, tenant RLS and idempotency, then atomically creates the existing person/lead and existing redacted audit, inert `crm.lead.created` outbox and idempotency evidence. No new migration, table, resolver, permission, event or service model is added.

## Strict browser lifecycle

The transport uses only the fixed relative same-origin POST, same-origin credentials, no-store cache, redirect rejection, no-referrer and fixed JSON/command headers. A key is generated **only after an explicit confirmed valid submit**, never during render, mount, prefill, confirmation or editing.

The browser accepts a closed `data`/`meta` envelope containing only the six canonical creation facts (`id`, `status`, `pipelineStageId`, `primaryPersonId`, `version`, `createdAt`) and request/correlation/replay metadata. It requires returned creation `OPEN`/v1, exact submitted stage linkage, UUIDs, canonical UTC time, matching correlation IDs, and HTTP 201/new versus HTTP 200/replay consistency. No echoed contact, scope/authority, duplicate or downstream fields are accepted.

Only an uncertain network/server/malformed/unverified response retains the **exact frozen in-memory path/body/key** for a separate manual retry. No automatic retry, polling, persistence, session monitor or list refresh exists. Definitive rejections retain no retry; access/session/entitlement loss discards scoped state. Editing or discarding clears confirmation, retry and receipt and warns that an earlier uncertain command may still have created a lead. Navigation/unmount, scope/filter edits, explicit list load, tab hiding, window blur/pagehide and a changed signed session on server rerender invalidate drafts and pending results. The session-derived opaque React key resets memory only; it is never an API authority token.

## CRM-only facts and independent next steps

> A creation receipt records returned creation facts, not the lead's later current status. It is not duplicate resolution, outreach, task/reminder, trial conclusion, enrollment, student/family, membership/payment, consent, attendance, provider/AI/Action Engine/automation, conversion or revenue evidence.

The creation receipt offers **no close action or handoff links**. Any existing trial/follow-up link on an independently authorized list row remains only inert untrusted selector prefill for a separately authorized destination. Neither intake nor its receipt creates or authorizes those workflows.

Every create attempt marks any previously loaded list as an unrefreshed snapshot and disables row close preparation. The list is never synthesized, appended, refreshed or rewritten from a creation receipt. The human must explicitly use **Load CRM leads** to obtain a newly authorized OPEN row/version before the separate close panel is available again. Delayed reads and old close callbacks cannot cross a scope/list reset.

## Validation evidence

- Focused API/create/close/campaign/entitlement suites: **29/29 tests**, including the **5 new create API/contract tests**; origin/marker/key/fetch-metadata/query/raw-body/context closure, exact scope, canonical service evidence, restricted response, preserved email checks and private/no-store session denial.
- Focused browser intake/transport/list/close suites: **5 files, 23/23 tests**, including **10 new intake UI/transport tests**; idle behavior, generated-key gating, exact uncertain retry, definite rejection, contact/draft clearing, delayed/unmounted responses, session/lifecycle keys, no inferred list changes or receipt close, and independent explicit reload.
- Existing marked disposable localhost close-database setup reused all **145 migrations** and canonical least-privilege grants. The job-local canonical create controller/service proof passed all three tiers, exact scope/current authority/stage checks, normalization, same-key concurrent replay/conflict, duplicate non-resolution, replay denial after revocation/inactivity/entitlement loss and rollback at audit/outbox insertion; **177 other tables stayed unchanged**. Existing close integrity regression passed independently.
- Canonical RLS verifier passed across **182 tracked operational tables** with cleared connection context.
- Disposable local Chromium echo evidence verified that this fetch emits the trusted Origin and actual safe metadata; its destination is the literal **`empty`**, not an empty header, including with `no-referrer`.

The local proof uses only the recognized marked localhost database and credential-scrubbed environment. No remote database, provider, payment, deployment, commit or push is involved. The job-local proof is evidence, not a new product/API capability.
