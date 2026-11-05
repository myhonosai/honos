# Owner operational checklist

**Status: owner acceptance not performed.** Use the canonical [A–G owner journeys in issue #131](https://github.com/myhonosai/honos/issues/131#owner-seven-journey-acceptance-checklist). All seven remain unchecked. The native class-session read currently returns **403: four adult/child × desktop/mobile cases attempted, zero complete**. Booking and attendance are blocked at class selection; earlier synthetic successes do not clear this blocker.

The core checklist describes [#143 at `d8d6ec8a03face51e8178c3b56f5ba5139376a29`](https://github.com/myhonosai/honos/pull/143), tree `98b15bcd28a12a58c0fa0f28e4b4e627afc4ebbf`. Accepted main is now `d8894d830e620c5f865bd125723bc4b0d6fef225` after #140; [#141 at `25fbdd7…`](https://github.com/myhonosai/honos/pull/141) still awaits the owner’s merge decision. The Account & Usage row additionally describes the narrow dependent frontend increment in this PR; its own exact head and verification are reported separately. This is not evidence for a later reconciled head.

## Before an owner test

- [ ] Receive the approved private host, pinned app/API/database version, legitimate HQ/school/recipient identities and secure sign-in instructions from the environment lead. **No owner URL, external identity-provider login or deployment has been verified.**
- [ ] Confirm legitimate operating access. Creating a school at `/hq/schools` with **Verify HQ-owner access → Create school** leaves it **SUSPENDED**; its receipt does not grant operations, subscription or AI access. Do not bypass suspension to complete this checklist.
- [ ] Use the same approved school throughout each journey. School links carry only inert organization/school selectors; every destination verifies access independently. English button names below have Korean/Spanish equivalents; Modern, Classic and Big Button preserve the same operations.

## A–G: record the real owner result

| Check | Actual route and controls | Required observation / current limit |
| --- | --- | --- |
| [ ] **A. Owner signs in and selects a school.** | On the approved host, `/auth/login` continues through `/auth/continue`; authorized HQ identities go to `/hq`, while school owners go to `/staff/entry`. Use **Verify school access** or **Choose and verify school**, then **School operations dashboard**. | Verify the intended identity and exact school. Multiple schools require an explicit choice. Suspended, denied or unavailable access stays blocked. **Actual owner login not tested.** |
| [ ] **B. Staff opens CRM and follows up with a lead.** | Entry/dashboard **CRM leads and follow-up** → `/staff/crm/journey`; **Load / refresh leads → Choose a verified lead → Follow-up → Verify my follow-up access → Save internal follow-up**, with the explicit confirmation. | Confirm a server receipt and fresh authorized records. This saves an internal staff task; it sends no email, SMS or reminder and does not enroll the lead. |
| [ ] **C. Student membership is verified or registered.** | From the selected lead, **Saved CRM memberships → Verify access and find memberships → Review current dates and history · 1 → Load membership dates**. A returned DRAFT uses **Review this DRAFT for activation**, server review, **Review final confirmation**, then **Confirm membership activation**. | Check each adult/child separately. If registration/setup is needed, use **Registration record** or **Existing registration / Resume Setup**. A registration record or lifecycle ACTIVE alone does not prove current effective dates, paid enrollment, agreements or benefits. |
| [ ] **D. Staff selects a class and books a student.** | From saved memberships, **Classes and attendance · 1 → Load class sessions → Select class**, choose **Booking kind**, acknowledge the student/class/kind, then **Confirm booking**. | **BLOCKED:** the native class GET returns 403 before selection. Do not record a booking pass. Once corrected and independently verified, require **Server-confirmed booking receipt**; configured capacity is not remaining availability. |
| [ ] **E. Instructor records attendance.** | In that student’s **Classes and attendance** view, **Refresh current attendance** first; choose **Attendance status** and **Participation category**, acknowledge the exact record, then **Save attendance** and refresh again. | **BLOCKED by the same class-selection failure.** Once unblocked, require the server confirmation and fresh student/session record. Opening the screen or booking never marks attendance. |
| [ ] **F. Owner checks subscription and AI usage, using authoritative available records.** | **Prepared dependent increment, not owner-accepted:** use **School account & usage** → `/staff/account-status`. Confirm the known school reference, then explicitly **Read account and access standing**; separately **Read creative wallet**. The fixed recovery entry is also available when reporting access is unavailable. | Await this increment’s focused signed-session/browser evidence and independent review. Billing recovery can remain authorized while entitlement is suspended; a wallet denial must not hide valid billing facts. A school-specific current AI-team budget report remains unavailable. The historical `/staff/subscription` comparison/test-checkout UI is excluded. No purchase, grant, spending, recovery or access command is offered. |
| [ ] **G. Owner accesses available AI agent interfaces with truthful provider/safety availability; paid calls require separate authority.** | Dashboard **HON AI team** → `/staff/hon`; inspect **AI team**, **Suggested**, **AI work** and **Approvals**. | **Not owner-verified; execution unavailable for this acceptance.** The conversation composer is disabled, planned agents stay planned, and unavailable/denied work stays unavailable. Available draft interfaces do not authorize provider calls, approval execution, communications or AI spending. |

## Account preparation and manual invitations

- Owner account, if needed: authorized HQ uses `/hq/school-owner-invitations` → **Verify access → Load approved schools → Review invitations (latest 50) → Generate private token → Record owner invitation**. The intended owner signs in and accepts at `/account/owner-invitation`.
- Staff: entry/dashboard **Staff team and invitations** → `/staff/team/invitations` → **Verify access and read invitations → Load eligible roles → Choose an eligible role → Read the selected role**. Review email/expiry, **Generate private token**, acknowledge, then **Record staff invitation**. Use **Show private handoff**; the verified recipient uses `/account/staff-invitation` → **Verify signed-in identity → Accept invitation**. Missing roles are not manually invented.
- Family: **Family account access** → `/staff/family-access` → **Verify and load family records → Choose an active family**; choose Primary guardian, Secondary guardian or Viewer, review email/expiry and explicitly **Create invitation**. The intended verified recipient accepts at `/account/family-invitation`. During suspension, lists/invite/accept remain unavailable; only the explicitly authorized **Verify identity for known-reference revoke/end** path may protect access using an independently known invitation reference. Mixed staff/parent identities require school review.
- **HON sends none of these invitations.** Share the fixed acceptance page, invitation ID and private token/code separately through the approved secure channel. Keep secrets out of URLs, screenshots, logs and browser storage. Acceptance is not payment, employment, enrollment, operating access or an AI-credit grant.

## Privacy and UNKNOWN recovery

Blur, hidden tabs and session/school changes conceal private information. Focus alone does not restore it: use the screen’s **Verify access and resume/restore** control with the original identity and school. A confirmed denial is not an empty list.

An in-flight command may settle while concealed. **UNKNOWN is neither success nor failure.** Keep the original document open; reverify and use only its explicit exact-request retry. Do not create a replacement invitation, trial, activation, booking or attendance command. Trial recovery may also require **Read saved trials** before its exact retry. In suspended-family known-reference recovery, identity verification alone cannot reveal settlement: explicit replay must reauthorize the retained command. If the screen requires school review, stop sending.

Leaving/reloading can destroy private retry memory and invitation codes. Deliberate abandonment cannot undo a server action; reconcile authoritative records before any new action. An abandoned unknown trial retains its replacement-scheduling hold in the mounted view. No automatic retry or full-document recovery is promised.

## Evidence to review

[Run 42068818674](https://github.com/myhonosai/honos/actions/runs/42068818674) and its [private report/screenshot artifact 13436242018](https://github.com/myhonosai/honos/actions/runs/42068818674/artifacts/13436242018) concern the pinned source above. Reports include real Next/Nest/disposable-PostgreSQL checks with **signed synthetic identities**, plus separately labelled synthetic API presentation matrices. They do not prove external OIDC login or an owner-device test. The final native failure is recorded in [issue #131](https://github.com/myhonosai/honos/issues/131#issuecomment-6665088176); its report is `native-workflow/owner-workflow-report.json`.

These are **harness-defined artifact paths checked against the scripts**, not manually image-inspected screenshots. The artifact is retained for three days, currently expiring 2026-11-08.

| View | Screenshot path within the artifact |
| --- | --- |
| Verified school entry, English/Modern/mobile | `owner-entry/owner-entry-en-modern-390.png` |
| Staff management, English/Modern/mobile | `staff/staff-invitations-en-modern-390.png` |
| Family management, English/Modern/mobile | `family/family-access-en-modern-390.png` |
| Authorized suspended-family protective receipt | `family/family-access-suspended-protective-receipt.png` |
| Native adult failure, desktop/mobile | `native-workflow/native-workflow-adult-1440-failure.png` · `native-workflow/native-workflow-adult-390-failure.png` |
| Native child failure, desktop/mobile | `native-workflow/native-workflow-child-1440-failure.png` · `native-workflow/native-workflow-child-390-failure.png` |

Record each real test’s version, identity role, school, action, server receipt/current read or refusal, and evidence location without private tokens or personal data. Keep every A–G box unchecked until the approved private owner test supplies that evidence; a passing component test, screenshot or receipt from another identity does not complete it.

The new Account & Usage proof prepares `account-status-report.json` and `account-status-{en|ko|es}-{modern|classic|big}-{390|834|1440}.png` in a **separate** private incremental-run artifact. These are not present in the parent #143 artifact above. Do not mark F complete or claim these images were captured until that run actually supplies them.
