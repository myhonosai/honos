# HON OS release record

This is the one current release record (launch-readiness review P3 [26]). It replaces the checkpoint lines in older
acceptance documents, which are kept as history. Update this file in the same PR as any change to what is deployed,
what is launch-ready, or how HON is hosted. Facts that can drift carry the date they were checked.

## How to read the current state yourself

| Question | Source of truth |
| --- | --- |
| Which migrations exist on `main` | `ls packages/database/migrations` and `pnpm db:check` (checksum-locked chain) |
| Which migrations a database has | `pnpm db:status` against that database (read-only) |
| What the hosting runs | `render.yaml` and `docs/operations/RENDER_DEPLOYMENT.md`; the deployed commit is the one shown on each Render service |
| Health of a running stack | `GET /api/readiness` on `hon-web` (Render health check since #604: sign-in configured **and** private API + runtime database ready; deploy hon-api before hon-web). `GET /api/identity/readiness` still answers sign-in configuration only |
| Recovery | `docs/operations/BACKUP_RESTORE_AND_RECOVERY.md`. Its fresh-target restore steps are proven in CI by `test-restore-fresh-target-drill.mjs` (#603) |

## Snapshot (checked 2026-11-22 08:20 UTC)

- **Hosting:** Render (`hon-web` public web service, `hon-api` private service) with Supabase Pro PostgreSQL, per
  `render.yaml`. Deploys are manual and owner-approved; commit-triggered deploys and previews are off.
- **`main`:** `ea1b9c0d`. **381** migration files, highest **0632**. Migration numbers are allocated by the project
  coordinator and merge in ascending order.
- **Deployed:** `bd8e1451` (database, `hon-api`, `hon-web`), database top 0632, as reported by the deploy thread on
  2026-11-22 06:10 UTC. Later merges (launch-readiness fixes #593, #594, #601) are **not** deployed yet.
- **Launch readiness:** the external review of 2026-11-22 (pinned `0d476427`) found HON OS **not launch-ready**.
  P1 is merged. P2 fixes are merging one PR per finding; see the "Fix launch-readiness review blockers" project thread.
  Commercial activation (live payments, paid AI, payment-controlled access) stays **off** by design.

## Superseded statements

These older statements are history, not the current state:

- `docs/OWNER_OPERATIONAL_CHECKLIST.md` "Current checkpoint" (`685e23ef`, 201 migrations through 0209, #145/#146).
- Any document that counts migrations, names a "current" main commit, or says hosting is undecided
  (hosting was decided on 2026-11-09: Render + Supabase Pro).
