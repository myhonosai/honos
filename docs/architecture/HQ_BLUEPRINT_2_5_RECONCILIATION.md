# HON HQ Blueprint 2.5 Reconciliation

**Status:** active implementation direction; **not** a claim that HON HQ, voice, executive agents, or SaaS metrics are complete.

> HQ is a separate platform-operator context, not a school super-admin view. It shares HON-owned model routing, Action Engine, durable work, approvals, audit, usage metering, and presentation foundations, while retaining distinct HQ authority, data scope, credit accounting, workspaces, and tools.

## Direction locked by Blueprint v2.5

The HQ interaction hierarchy is:

```text
Platform owner (final human authority and approvals)
  → HON Executive AI Assistant (coordinates, explains, delegates, consolidates)
    → Chase / Mia / Ethan / Olivia / Ryan / Sophia (specialist HQ executives)
      → shared HON Action Engine (permission · policy · approval · execution · audit · cost)
```

This **does not introduce a second AI orchestration system**. HON coordinates specialists; specialists must never be shown as working without persisted work. Consequential customer communications, financial changes, production changes, sensitive support access, subscriptions, refunds, credits, account suspension, permissions, and deployment remain approval-gated through the established Action Engine.

The supplied visual references are design constraints: premium but restrained SaaS density; device-matched light/dark appearance with user override; navy/blue/cyan/white palette; desktop sidebar + content + collapsible assistant rail; mobile navigation + compact HON Core; the futuristic expression is concentrated in the HON Core, not the whole application. HON must be an original product identity—never JARVIS.

## Reconciliation matrix

| Requirement | Current classification | Reuse / gap / governing constraint |
| --- | --- | --- |
| Separate HQ control plane | **Implemented foundation** | Existing HQ operator resolver, isolated HQ provider/catalog/policy/task-profile registry, private HQ evidence and exact function-only runtime boundary; school authority does not confer HQ authority. |
| Shared model routing and provider governance | **Implemented decision foundation** | Existing provider/catalog/policy/profile registry, pure selection, evaluation harness, privacy/cost/tier checks and no-execution result. Provider execution, live health, secret custody and production model changes remain deferred. |
| Durable Action Engine and approval workflow | **Implemented shared foundation** | Existing typed Action Engine, immutable proposals, live reauthorization, approval binding, audited/inert validation. HQ must reuse this rather than create bespoke execution. |
| HQ overview and SaaS KPIs | **Implemented bounded HQ-1 projection** | An HQ-owner/operator-only, fixed aggregate overview now truthfully exposes organization/school/onboarding/provider-state/task-profile counts. MRR/ARR/cash/gross-margin, usage/cost, time filters and drill-downs deliberately render unavailable until separately authoritative sources and semantics are designed. Do not synthesize metrics from unrelated school reads. |
| HON Executive assistant | **Planned / partial presentation** | Existing assistant/AI-team presentation and provider-neutral preferences can be reused. A persisted HQ conversation, real briefing/delegation, citations, task outcomes, owner permissions and text fallback are missing. |
| Chase, Mia, Ethan, Olivia, Ryan, Sophia | **Implemented catalog / workspace planned** | The fixed seven-member catalog (including HON coordinator) and role summaries are now defined separately from school AI employees. Existing portrait/identity assets and work item/action patterns are reusable; scoped tools, persisted workspaces, cost attribution and outcome evidence remain missing. |
| HQ AI team cards/workspaces | **Partial presentation only** | The HQ-1 screen may show the fixed catalog with explicit `NO_RECORDED_WORK`; it cannot show decorative or permanent `WORKING` state. Reuse AI Team presentation patterns, work items, Action approvals, audit and usage ledgers when persisted workspaces are implemented. |
| HON Core visual shell | **Planned visual concept / safe implementation later** | A compact Core, expanded text panel and reduced-motion fallback can be implemented without AI execution. It may not portray fabricated listening, thought, task or voice state. |
| Voice | **Planned; provider-dependent** | UI permission, mute/interrupt and text fallback are safe later. Capture, transcription, streaming response, retention/deletion, voice synthesis and language support require evaluated providers, privacy/cost decisions, server controls and explicit activation. No continuous recording or background listening. |
| HQ School Management | **Implemented bounded directory / broader workflow open** | HQ provisioning/onboarding, global control-plane scope and a fixed owner/operator-only school directory now exist. The directory exposes only organization/school display names, operational status, active entitlement tier and created time; it has no support access, contacts, users, private family/student data, payment/provider data or selector. Account workspace, purpose/time-limited audited support access and safe aggregate access remain open. HQ cannot gain unrestricted student/family/payment/instructional data or bypass RLS. |
| Essential/Core/Complete enforcement | **Implemented across validated slices; cross-feature completion remains open** | Existing per-slice live entitlement checks and Complete AI controls are reusable. HQ consumption must remain operator-costed; schools must not gain HQ tools/data and ordinary included assistant usage must not be silently re-priced. |
| Financial reporting / revenue director | **Planned authoritative projection** | Existing billing and usage ledgers are sources, not a finished HQ financial statement. Annual/lifetime/founder semantics must be explicitly modeled before any MRR/ARR claim. |
| Support access / security oversight | **Planned** | Existing HQ separation, audit and RLS posture are prerequisites. Any access needs purpose, duration, screen identity, revalidation and audit—not impersonation by default. |

## Resolved interpretation changes

1. **HQ identity names:** Blueprint v2.5 replaces the v2.4 pre-lock statement that HQ names may remain configurable. The approved HQ roster is **HON, Chase, Mia, Ethan, Olivia, Ryan, and Sophia**. School-level AI employee identities remain unchanged.
2. **General assistant versus executive system:** HON is a bounded executive coordinator, not an unrestricted super-agent. It inherits the authenticated owner/HQ actor’s permissions and must delegate through the shared work/Action Engine boundary.
3. **Proactivity:** Executives may prepare authorized evidence, anomaly/recommendation drafts and explicitly permitted low-risk internal work only once a persisted HQ task and scope exist. All communications, financial changes, production/deployment and sensitive administration remain approval-gated.
4. **Visual state honesty:** portraits, Core animation, task chips and approval UI must reflect persisted state. A concept/mockup is labeled sample data; it is never represented as working orchestration.

## Immediate sequence

1. **Complete active compatible school work:** the current human retention-review acknowledgement remains independent and continues unchanged.
2. **HQ-1 — delivered contracts and access:** the fixed seven-executive catalog and HQ-only minimized platform overview are now available with no provider call, cross-tenant unrestricted table/browser access, or fake activity. Persisted executive workspaces remain separate work.
3. **HQ-2 — visual proposals and overview shell:** produce reviewable light, dark and mobile visual concepts plus HON Core compact/expanded states, then extend the delivered no-fake-activity overview shell only with real authorized values or explicit unavailable/sample labels.
4. **HQ-3 — durable executive workspaces:** wire cards/workspaces to real persisted HQ work/approval/result/usage evidence via the existing orchestration and Action Engine. Build text interaction before voice.
5. **HQ-4 — school management:** build on the delivered fixed minimized directory with purpose-limited, audited customer/account projections and a separate support-access workflow; never unrestricted impersonation.
6. **HQ-5 — voice and externally activated capabilities:** only after provider evaluation, private transcript/recording lifecycle, cost/latency controls and explicit owner activation.

## Owner approvals still required

| Decision | Why it remains blocked |
| --- | --- |
| Any live provider inference, voice/transcription/synthesis or paid model validation | Requires explicit bounded external-cost authorization and provider/privacy review. |
| Production model default change | Requires exact catalog/capability/privacy/price/availability confirmation, local evaluation and explicit owner approval. |
| Voice provider activation and transcript/recording retention | Requires provider, privacy, cost, retention/deletion and user-consent decisions. |
| Actual customer communication, marketing publication, financial/subscription change, refund/credit, deployment or account suspension | Consequential external actions must use the established approval workflow; no activation is granted here. |
| Full support impersonation | Requires an explicit purpose-limited, time-limited, audited access design; not assumed by HQ authority. |

## Verification standard

Every HQ vertical must demonstrate exact HQ-only scope, separate evidence from school audits, force-RLS/ACL posture, entitlement/permission rechecks, scoped and redacted analytics, durable real task state, Action Engine approval binding for consequences, operator-only cost attribution, non-fake visual states, and fallback to conventional UI when AI or voice is unavailable.

## Related sources

- [HQ AI Provider Control Plane](HQ_AI_PROVIDER_CONTROL_PLANE.md)
- [Durable AI Invocation Planning](AI_INVOCATION_PLANNING.md)
- [HQ Platform Overview](HQ_PLATFORM_OVERVIEW.md)
- [HQ School Directory](HQ_SCHOOL_DIRECTORY.md)
- [Blueprint Update 2.2](BLUEPRINT_UPDATE_2_2_INTEGRATION_MAP.md)
- [Blueprint Update 2.3](BLUEPRINT_UPDATE_2_3_INTEGRATION_MAP.md)
