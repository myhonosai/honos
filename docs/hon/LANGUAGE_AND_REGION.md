# Language & Region — approved product roadmap requirement

**Owner direction:** 2026-10-18. **Delivery status:** planned; no localization implementation, preference endpoint or migration is introduced by this document. Engineering proposal: [shared localization architecture](../architecture/LANGUAGE_AND_REGION_PLAN.md).

HON will provide **Settings → Language & Region** within the existing application and shared HON design system. Initial display languages are **English** (`en`, default), **한국어** (`ko`) and **Español** (`es`). This is a conventional product capability for every tier, including supported legacy Essential; it consumes no AI credits and requires no paid upgrade.

## Required behavior

1. Each user chooses their own interface language. A confirmed server save persists across sign-ins and devices. Another user's selection never changes it.
2. The same selection works in Big Button, Modern and Classic, across HON HQ, school staff and parent-facing experiences. Language and AI portrait style are independent presentation choices.
3. A permitted school administrator may set a default language for new users. It only initializes a previously uninitialized new user's preference. Existing users, personal choices and users switching schools are never silently reset. A later school-default change is not a bulk preference update.
4. Use one centralized catalog and shared localization infrastructure; do not create separate applications or translated page copies. Localize navigation, controls, forms, validation/error messages, dates and numbers. Missing or invalid translations fall back to the English catalog.
5. Keep **display language, region/formatting conventions, currency and timezone separate**. Changing language never converts money, changes a billing currency, rewrites stored instants or changes a business reporting period. Preserve explicit UTC qualification months in Champions Club.
6. HON and other AI assistants should use the verified display language for their responses where the existing capability supports it. This is not a claim that an unavailable assistant, voice language or translation service is operational. Existing AI permissions, approvals and spending controls apply.
7. Do not automatically translate or send external messages, legal documents or customer-entered content. Any future translation/delivery workflow requires explicit scope, content review, appropriate consent and the existing authorization controls. Stored content and approved originals remain intact.

## Settings experience and acceptance

- Present a labeled language selector with native names and explicit save/pending/error states. Show success only after a valid persistence receipt; retain the prior verified selection on a failed save. If persistence is unavailable, explain that the choice could not be saved and retain the verified language or English fallback.
- Expose region, currency and timezone as distinct fields only when their authorized contracts exist; otherwise describe their status truthfully. A personal language setting cannot grant permission to change school financial or scheduling settings.
- Keep native language names discoverable, keyboard controls accessible and text readable at mobile widths, 200% zoom and with longer Korean/Spanish labels. Set the document language correctly and preserve original user-entered names and text.
- Release each supported experience only with catalog coverage, English fallback, server/client consistency and cross-device persistence verified. Acceptance includes all three views, HQ/staff/parent authority boundaries, new-user school-default initialization and proof that existing preferences are not overwritten.

## Coordination and scope

Codex prepares shared UI and catalog adoption; the backend owner must approve the persistent user identity, personal preference and school-default contracts before implementation. Coordinate with Manus and Claude and inspect active PR file ownership before touching shared layouts, design-system exports or settings. No current data model, permissions, application files, assets, customer content, credits or services change through this roadmap update. Implementation will proceed in separately assigned, reviewable slices.
