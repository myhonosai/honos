# HON Visual Module Blueprint Reconciliation

**Sources reconciled:** October 16, 2026 owner visual handoff, HQ Module Blueprint v1.0, School CRM Module Blueprint v1.0, the supplied HQ/mobile and School CRM review PDFs, and the authoritative HON Master Directive plus Blueprint updates 2.1–2.5.

> **Status rule:** supplied screen packages are visual proposals and product-direction evidence, not authorization to activate providers, payments, messaging, advertising, voice capture, production publication, or cross-tenant transfer. Approved text and existing governed behavior prevail over any illustrative mockup label, number, price, activity light, identity, or status.

## Locked visual/product direction

| Decision | Reconciled implementation rule |
|---|---|
| Three Platform Views | **Big-Button / Phone**, **Modern HON**, and **Classic CRM** are presentation-only. They must use the same services, records, permissions, tier gates, tenant scope, Action Engine and audit trail. A view switch may never grant a feature or change authority. |
| Device behavior | Follow system light/dark preference where a module supports it, permit an optional user override, preserve 44px+ touch targets in Big-Button, preserve keyboard density in Classic, and keep equivalent navigation/status/empty/error access in every view. |
| School AI team | School employees remain the established **Alex, Chad, Maya, Marcus, Jordan, Claire and Lena**. Visual portrait style (Realistic, Anime, Chibi) is independent from name, identity, model route, tools, history, cost, memory, permissions and authority. |
| HQ AI team | HQ remains distinct: **HON** coordinates **Chase, Mia, Ethan, Olivia, Ryan and Sophia** through the shared Action Engine. An executive card may show only durable task/approval/result/cost evidence. No permanent or decorative “working” status. |
| HON assistant | HON is text-first and conventional UI remains complete without AI. Voice is an optional, permissioned enhancement with text fallback; wake-word, recording/transcript retention, provider, privacy, latency and cost controls require their separate activation boundary. |
| Tier behavior | Essential/Core/Complete are product entitlements, not visual modes. All tiers receive conventional UI and contextual HON presentation; Complete-only delegation and autonomous operation remain server-enforced. |
| Data claims | Screens show verified facts, explicit unavailable states, or no recorded work. They must not synthesize SaaS KPIs, financial results, AI spend, agent activity, renewal outcomes, attendance, promotion, payment or external delivery. |
| School CRM visual language | The supplied School CRM concept set establishes a **deep navy/black command surface, electric cyan HON focal color, restrained glass/panel layering, dense operational columns for Classic, and clear large-tap cards for Big-Button**. It is direction—not sample data approval. Implement its hierarchy, contrast and responsive structure through HON design tokens while keeping verified facts and unavailable states visibly distinct from illustrative neon status lights. |

## Current implementation reconciliation

| Visual/functional area | Current governed implementation | Remaining work |
|---|---|---|
| Owner first-value path | `/staff/launch` now supports verified school context, program, class, adult or guardian/child registration, canonical first-class booking, membership **DRAFT** creation and receipt-bound saved confirmations. The staff dashboard shows bounded saved student/class/booking/DRAFT progress only after scope alignment. | Membership activation remains intentionally blocked for explicit owner policy on consent/terms, schedule, tier/permissions, confirmation and drift review. Public sign-up and parent account activation remain separate flows. |
| School dashboard and Command Center | Current-school read-only operations dashboard, safe owner-specific confirmation cards, explicit unavailable aggregates and links to existing workflows. The separate aggregate-only School Command Center supplies deterministic count facts, formulas and navigation recommendations. Each mounts the shared Platform View selector only after its own report/projection independently verifies the organization/school scope. | Add only approved aggregate sources to the Command Center. Do not merge member-level retention attention alerts into a school aggregate without a separate governed aggregate contract; no sample KPI cards or simulated agent activity. |
| Three-view system | Shared contracts and `InterfaceThemePicker` exist; Owner Launch persists the current user’s preference through the existing scoped settings boundary. Staff Dashboard and School Command Center now read/save that same current-principal/current-verified-school preference using closed `selectedVia: SETTINGS` provenance after their separate verified scopes resolve. Big-Button / Phone, Modern HON and Classic CRM vary only touch targets, card layout and density; report/owner reads or aggregate formulas, permissions, links, audit/security behavior and authority are unchanged. | Roll out the verified selector to another appropriate school context only after its independent verified scope is available. HQ/global and parent/family persistence remain intentionally deferred pending distinct verified scope design; never silently reuse a school preference across an unrelated HQ or family context. |
| HQ overview | `/hq`, `/hq/executives`, `/hq/schools` provide separate HQ resolver-backed aggregate/minimized views with no invented financial/AI/durable-work data. | HQ command-center visual hierarchy, real durable executive workspaces, school profile/support access and honest KPIs need independently governed data sources. |
| Parent experience | Family-safe Home, Journey, billing, testing, documents, planned absence, ClassPass read, curriculum links and testing-interest navigation are live bounded routes. | Parent messages, account activation, broader student app and any push/voice features require their own consent/delivery/identity boundaries. |
| Curriculum/media | Metadata-only parent-audienced HTTPS resource library; browser-only deliberate external links, no HON fetch/embed/transcription. | Uploaded media/storage, private video delivery and Claire-assisted lesson preparation require separate storage/provider and instructor policy work. |
| ClassPass/kiosk | Nonfinancial manual ClassPass and bounded public kiosk handoff are governed and tested. | Payment-backed issuance, autonomous redemption/attendance, guest waivers and conversion must stay blocked pending payment/reconciliation/consent policy. |

## Delivery sequence after visual reconciliation

1. **Platform View rollout:** Staff Dashboard and School Command Center are the delivered first two verified current-user/current-school selectors. Continue only with another high-use school module that independently establishes the same scope; validate Big-Button, Modern and Classic responsive semantics without changing data or actions. HQ/global and parent/family persistence are separate future scope designs.
2. **School Command Center truthfulness:** the existing Command Center remains an aggregate-only deterministic surface. Add retention only through an approved school-level aggregate—not by browsing member alerts—and keep unavailable KPIs/agent work unavailable.
3. **Entitlement matrix:** finish explicit Essential/Core/Complete server enforcement evidence before exposing any Complete-only assistant/delegation controls as usable.
4. **HQ command center:** add durable task evidence before executive workspaces or spoken/daily briefing claims. Preserve the separate HQ resolver and no school-data bypass.
5. **Core journeys:** extend first-value onboarding only through unblocked conventional flows; keep membership activation and public/parent account creation on their explicit policy/identity tracks.
6. **Provider-dependent experiences:** voice, Meta/Google, processor reconciliation, content generation and school-branded apps remain blocked until their provider/privacy/consent/approval contracts are approved and activated.

## Non-negotiable visual acceptance rules

- No visual control is a permission or entitlement check; server-side policy remains authoritative.
- Every screen state must be one of verified data, clearly unavailable, empty, loading, denied, or error—never fake-success or placeholder operational data.
- Navigation may link only to a real established route. A visual route does not create a generic selector, search, queue, roster, raw provider access or hidden authority.
- Wide/dense desktop views and touch/mobile views remain equivalent in data and actions; visual density is the only difference.
- Source screenshots/previews are review materials. Do not copy illustrative pricing, capacity, agent identity, usage, or “live” status into product data.

## Evidence references

- [HQ Blueprint 2.5 reconciliation](HQ_BLUEPRINT_2_5_RECONCILIATION.md)
- [Blueprint Update 2.3 integration map](BLUEPRINT_UPDATE_2_3_INTEGRATION_MAP.md)
- [Owner launch lifecycle](OWNER_LAUNCH_LIFECYCLE.md)
- [AI employee regression validation](AI_EMPLOYEE_REGRESSION_VALIDATION.md)
- [HON Master Directive](../HON_MASTER_DIRECTIVE.md)
