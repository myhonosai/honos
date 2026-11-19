# School announcements (0576)

Owner ask (2026-11-19): "on main screen we would have announcement that we can push out from crm".

## What it does

- **Staff** with `family_messages.manage` open **Parent app > Announcements** (`/staff/family-messages/announcements`) in the CRM,
  write a title (1-120 characters, one line) and a plain-text message (1-2,000 characters) and post it to every family of the
  verified school. A post is never edited. It can be taken down once, at its exact version.
- **Families** see the school's live announcements from the last 60 days, newest first (at most 20), in an **Announcements**
  section at the top of the HON Family app's Home screen. Every grant level (including VIEWER) can read them. Families never see
  who posted it.
- **Nothing is sent.** No text, email or phone push. Push alerts need a separate Firebase/APNs setup and owner approval.

## Boundaries

| Layer | Detail |
| --- | --- |
| Database | `hon.school_announcements` (forced RLS, no policies, no runtime table privilege). Guard trigger: insert only as PUBLISHED v1; the only update is PUBLISHED to WITHDRAWN with version + 1; never deleted or truncated. |
| Entry points | `read_parent_school_announcements(text)`, `read_school_announcements(text)`, `publish_school_announcement(text,jsonb,text,uuid,uuid)`, `withdraw_school_announcement(text,jsonb,text,uuid,uuid)`; runtime EXECUTE only. |
| Parent scope | 0329 `parent_class_booking_scope(subject,false)`: exactly one live family grant, live school and entitlement. No selector is accepted. |
| Staff scope | 0330 `require_family_messages_actor`, re-checked after every lock and write. The route ids are never authority. |
| Limits | 20 posts per school per rolling day, under a per-school advisory lock (`SCHOOL_ANNOUNCEMENTS_RATE_LIMITED`, 429). |
| Idempotency | Publish and withdraw need an `Idempotency-Key`; an exact repeat replays, a different command under the same key is `IDEMPOTENCY_KEY_REUSED`. |
| Audit / outbox | `school_announcement.publish` / `.withdraw` audit rows and inert `school_announcement.published` / `.withdrawn` outbox events carry ids, status and version only, never the text. |
| API | `GET /v1/parent/announcements` (`parent.announcements.read`); `GET|POST /v1/organizations/:org/schools/:school/announcements` (`school_announcements.read`, `school_announcements.publish`); `POST .../:id/withdraw` (`school_announcements.withdraw`). |

## Evidence

- `packages/database/scripts/test-school-announcements-integrity.mjs` (signed HTTP on the disposable CRM-close fixture).
- `infra/postgres/011_verify_supabase_hon_runtime.sql` section "School announcements exact verification (0576)".
- `apps/api/test/school-announcements.test.cjs`, `apps/web/test/school-announcements-http.test.ts`,
  `apps/parent-mobile/test/announcements-ui.test.tsx`.

Not deployed. Deploys together with the rest of the HON Family work on the owner's OK.
