# HON HQ subscription account review — first B1–B3 slice

Owner-authorized read-only frontend continuation after PR #20 merged at `40a896806dce778dd301ab68abd348bb3c586f74`. Branch `codex/hq-subscription-review`. No new-PR merge, deployment, financial/provider activation or backend changes are authorized by this implementation.

## Functional boundary

Existing `/hq/revenue` becomes a real subscription account-review workspace in the approved HQ shell. HON bills organizations that may cover several schools; this is separate from school-to-family billing. No school/family endpoint or private table is used.

| Read | Canonical contract | Use |
| --- | --- | --- |
| `/v1/hq/saas/catalog` | `validateSaasCatalogView` | Published plans/offers, server founder inventory; no draft or approved-intent fallback |
| `/v1/hq/saas/subscriptions[?status=]` | `validateSaasSubscriptionList`, closed status filter | Newest 200 matching records, authoritative organization identities; Core, Complete, founder, lifetime and preserved legacy Essential |
| `/v1/hq/saas/credits` | `validateSaasCreditProgramView` | Program state and newest 50 HQ-owner-verified provider-billing cost evidence records; no invented rates/cost totals |
| `/v1/hq/saas/organizations/:id/subscription` | `validateSaasOrganizationSubscription` | Explicitly selected organization's current subscription, actual entitlement row/alignment, newest 50 history events / 20 founder reservations |
| `/v1/hq/saas/organizations/:id/payment-standing` | `validateSaasPaymentStanding` | Server-recorded versus provider-verified standing and evidence counts, never processor confirmation from attestation |
| `/v1/hq/saas/organizations/:id/credits` | `validateSaasOrganizationCredits` | Up to 12 allowance periods, newest 50 reservations, backend balances and ordinary-use UTC-month cost aggregate |

Web requests use the existing same-origin `/api` prefix/rewrites, signed-session HQ layout and independent canonical API authorization. `SaasReadGuard` → `SaasBillingService` → registered runtime operation → fixed forced-RLS database functions. HQ owner or operator with `hq.billing.manage` only; school/family/support/nonhuman/delegated/forged-context authority does not bridge. Codex changes none of those services, guards, contracts or permissions. B3 is verified merged in main despite older handoff prose saying its PR was unmerged.

## Identity, data accuracy and state

- Only explicit human interaction selects an organization from verified subscription records. No URL auto-fetch, arbitrary UUID field, organization assumption from a school directory, preference persistence or client role/scope headers. Search filters only the returned window and does not claim a complete directory or total.
- Overview's three reads fail as a group; account's three reads fail as a group. Error bodies are not read/echoed; closed envelope/contract drift fails closed. School/current-subscription and nested organization mismatches clear scoped facts. The current subscription IDs must agree across the three independent account responses; a race requires refresh. Provider-verified dates cannot appear while B2 verification is unconfigured.
- Render-time request keys clear obsolete facts before effects; AbortController plus cleanup guards discard late results after refresh, filter, selection or unmount. No cached fallback. Separate reads are not atomic; browser retrieval time is not a server as-of timestamp.
- Founder remaining/held/allocated values come directly from inventory. No sums of bounded lists establish official totals, MRR, receipts, provider spend or credits. Null availability stays unavailable/undecided, not zero.
- B1 `IN_SERVICE` means service period recorded, not paid. Its `NOT_BILLED` / `NOT_GRANTED` fields remain record metadata; B2 standing and B3 allowance records are separate authoritative projections, never inferred from price or planned monthly credits. Entitlement rows/dates/alignment are displayed, not turned into functional authority.
- B2 recorded standing includes HQ attestations; verification is not configured, and Champions source stays `NOT_CONNECTED`. Nothing is labeled charged/collected/processor-confirmed. Individual invoice/evidence records are not claimed available in this slice.
- B3 displays each period's returned allowance/consumed/held/expired/available/used-percent values, not a browser balance from reservation history or an assumed current allowance. An old OPEN period is labeled with its dates, and recorded availability is not spend authorization. Unknown outcomes remain unknown/held; missing provider cost is not zero. Ordinary use is not deducted from premium credits.
- Usage-ledger provider cost and HQ-owner-verified billing evidence are separate sources; neither is substituted for the other. USD minor units use exact 2-digit formatting, microunits exact 6-digit formatting, without floating-point rounding or assumed per-credit economics.

## Ownership and UX

Only Codex-owned HQ frontend, focused synthetic test/harness files, the existing restricted temporary workflow, TODO and this handoff are touched. Existing revenue route reused; no route manifest append is needed. Original assets, shared appearance controls, HON assistant, six executive workspaces, Champions functionality, Claude Classic, Manus CRM and school-to-family billing remain intact. Account review appears before the long record window, receives keyboard focus on explicit selection and restores focus on close.

Issue #21 remains open and unchanged for Claude's paginated HQ per-school reward history. No speculative API or browser filtering of global rewards into complete school history. Coordination of billing read consumption is recorded on Claude's PR #18. PR #17 remains future English/Korean/Spanish documentation only; no translations or persistent preference database.

## Deliberately deferred integration

The existing B2 invoice list/detail and individual payment-evidence GETs are available backend services but not connected by this first account-review slice. A next reviewed invoice workflow should use exact invoice/organization/subscription binding, clearly label newest-200 windows and preserve HQ-attestation versus provider confirmation. `/hq/ai-costs` remains its existing planned screen; returned verified cost evidence is available within this subscription review, not a complete company cost dashboard. Company revenue aggregates, complete histories, provider reconciliation, payment collection, top-ups, financial activation, grants, fulfillment and all commands remain unavailable here.

## Verification

Focused transport/closed-contract/identity/current-subscription/denial/precision/empty/render tests and actual production-app browser checks use only authorized synthetic localhost fixtures. The temporary workflow is pinned/read-only/no-secrets, narrowed to same-repository `codex/hq-subscription-review` targeting main. Actual signed sessions, unknown-path/query/body denials and external network blocking remain in the existing harness; canonical backend authorization/calculation is separately tested by full CI's disposable-database proofs. No fixtures enter application source.

Actual results and screenshots will be linked after execution; pending tests are not claimed passed. Manual physical-device keyboard/rotation, screen-reader focus/live announcements and contrast/zoom remain separate from automated accessibility scans. No full WCAG certification claim. Remove temporary verification through a separately reviewed cleanup after owner sign-off.
