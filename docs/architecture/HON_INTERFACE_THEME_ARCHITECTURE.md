# HON Interface Theme Architecture

## Locked product decision

HON provides three selectable **presentation modes**, not three products, application tiers, or domain implementations:

| Theme | Intended use | Presentation characteristics |
|---|---|---|
| **Big-Button / Phone Style** | Families, newer staff, on-the-go operations | Mobile-first flow, large touch targets, simple cards, reduced visual density, straightforward navigation |
| **Modern HON Style** | Default for most schools | HON/Ideal OS balance of simplicity, polish, contextual operations, and useful information density |
| **Classic / Agency-Platform Style** | Experienced staff and power users | Traditional CRM/admin workspace with higher density and faster administrative scanning |

## Non-negotiable boundary

A theme changes **presentation only**. It cannot alter tenant scope, role/permission checks, tier entitlement, API shape, action authority, approval requirements, data access, audit evidence, or domain behavior. Each page uses shared feature modules, view models, commands, and query contracts. CSS tokens, layout variants, component composition, and a stored user preference create the variation; HON does not fork the frontend into three independent applications.

The Complete AI Office is a governed workspace available inside any selected theme when entitlement and scope allow it. It is not a fourth theme.

## Delivery behavior

- Onboarding will display a visual preview, concise intended-user explanation, and a recommended default (**Modern HON**).
- Skipping the choice keeps the default and never blocks activation.
- Settings will let a user change their preference later.
- A resolved preference is user-owned presentation state; any organization defaults are a convenience only and cannot affect authorization.
- Every selector must explain that the same school data, permissions, and actions remain in effect.

## Current implementation boundary

The staff shell uses the shared design-system `HON_INTERFACE_THEMES` registry and exposes all three modes from one React component. Backend foundation, CRM commands, and the Action Engine remain shared and untouched by the UI choice.

The authenticated API now persists a per-principal, per-school preference through `GET`/`PUT /v1/organizations/:organizationId/schools/:schoolId/interface-theme`. It derives the principal only from the verified session and server-side scope resolver; it never accepts a principal ID from the client. `PUT` requires a scoped permission and idempotency key, and atomically records the preference, audit evidence, idempotency outcome, and outbox event. The caller declares `ONBOARDING` or `SETTINGS` provenance; no selection returns the non-blocking Modern HON default.
