# C1: asynchronous creative provider jobs, daily caps and the platform spend guard (migration 0354)

Status: C1a built (database, 0354), 2026-11-14; C1b (API async path, worker, HQ endpoints) is the next PR, no migration. Piece C1 of [CREATIVE_AI_IMAGE_VIDEO_PROVIDERS.md](CREATIVE_AI_IMAGE_VIDEO_PROVIDERS.md).
No provider adapter, network call, key or deploy. Tests use fake runtimes only.

## 1. Problem

The CS1 flow (0216) reserves credits, calls the provider once inside the HTTP request, and records the outcome in the
same request. Real image and video providers answer with a job id and finish minutes later. C1 adds the missing
asynchronous step without changing any money rule:

- a job record ties one generation to one provider job id;
- a worker polls jobs under a lease and records the result **for the generation's requester** through the unchanged
  0216 `record_creative_generation_result` (so the CW1 settle, its evidence actor and every check stay as they are);
- jobs that never finish become UNKNOWN for HQ after 30 minutes, and are never resent;
- schools get daily caps, and HON gets a per-provider daily spend guard checked **before** anything is sent.

## 2. Records (0354)

- `hon.creative_provider_jobs`: one row per generation (`generation_id` unique, same school), `provider_id`,
  `provider_job_id` (unique per provider once set), `status`:
  - `PERMITTED`: the guard allowed a submit, and nothing has been confirmed as sent;
  - `SUBMITTED`: the provider returned a job id;
  - `RECORDED`: the result was recorded through 0216;
  - `TIMED_OUT`: it was recorded UNKNOWN by the deadline;
  - `REQUESTER_UNAVAILABLE`: the requester is no longer an active single-principal human. The reservation stays
    RESERVED for HQ resolution, the existing CW1 path.

  The row also keeps the reserved worst-case cost (micro-USD), `permitted_at`, `submitted_at`,
  `deadline_at` (`permitted_at` + 30 minutes), `next_poll_at`, `poll_count`, `lease_token`, `lease_expires_at` and
  `version`. A guard trigger allows only the forward moves above. Forced RLS, deny-all.
- `hon.creative_school_daily_caps`: optional HQ override per school (`images`, `videos`, `avatar_videos`, 0..1000,
  `version`). Defaults when there is no row: 50 images, 12 videos, 10 avatar videos per UTC day.
- `hon.creative_provider_daily_limits`: per provider, `daily_limit_micros` (0..$10,000), `version`, set by the HQ owner.
  **No row means no real submissions for that provider** (the guard refuses), so a provider can never run without a
  limit David chose.
- `hon.creative_limit_commands`: immutable HQ command log with idempotency (the 0288 shape).

## 3. Functions

Runtime (`hon_runtime`), all by the generation's own requester (the 0216 / CW1 evidence actor):

1. `begin_creative_provider_submission(subject, generation)`: the generation must be `SUBMITTING` with no job yet. It
   takes the provider limit row lock (`FOR UPDATE`, which serializes the guard per provider) and computes today's
   committed cost for that provider:
   - the recorded provider cost of jobs permitted today;
   - plus the worst case of jobs still open (`PERMITTED` or `SUBMITTED`).

   The worst case of one job is its reserved credits × 10,000 micro-USD (1 credit = $0.01). The published rates are
   above provider cost, so this is an upper bound. If committed + this job is over the limit, the call is refused
   with `CREATIVE_PROVIDER_DAILY_LIMIT`. If there is no limit row, the refusal is
   `CREATIVE_PROVIDER_LIMIT_NOT_SET`. Otherwise it inserts the job as `PERMITTED`.
   The API then records the generation NOT_SENT (credits returned, known zero cost), so a refusal never leaves
   credits held.
2. `record_creative_provider_submission(subject, generation, providerJobId)`: `PERMITTED` → `SUBMITTED` with the id
   (1..200 safe characters, unique per provider). Same id again is a replay; a different id is refused.

Worker (`hon_communication_worker`, the existing worker login; no table access):

3. `claim_creative_provider_jobs(limit 1..25, lease 30..300 s)`:
   - Expired jobs come first. A `PERMITTED` or `SUBMITTED` job past its deadline is recorded UNKNOWN
     (`PROVIDER_UNKNOWN`) and becomes `TIMED_OUT`.
   - It then leases due `SUBMITTED` jobs (`next_poll_at` ≤ now, oldest first, `SKIP LOCKED`) and returns the job,
     provider, provider job id, operation, media kind, units and format. It never returns the prompt or the school
     name.
4. `record_creative_provider_job_poll(job, lease, {state: 'PENDING'})`: still running. It frees the lease and sets
   `next_poll_at` with backoff (10, 20, 40, then every 60 s).
5. `record_creative_provider_job_result(job, lease, outcome)`: the 0216 outcome body (SUCCEEDED / FAILED / UNKNOWN).
   It resolves the requester's subject inside the database and calls `record_creative_generation_result`, so the
   same validation, settle and asset rules apply. The job becomes `RECORDED`. If the requester is no longer usable
   (`SAAS_FORBIDDEN`), the job becomes `REQUESTER_UNAVAILABLE`, its lease is released and nothing is settled; the
   HQ owner resolves the reservation with evidence (CW1).

HQ (human HQ owner, `require_saas_hq_actor(subject, true)`, reason 10..500, `expectedVersion`, idempotent):

6. `command_creative_provider_daily_limit(subject, {providerId, dailyLimitMicros, reason, expectedVersion}, key)`.
7. `command_creative_school_daily_caps(subject, {schoolId, images, videos, avatarVideos, reason, expectedVersion}, key)`.
8. `read_creative_limits_from_hq(subject)`: provider limits with today's committed cost and open jobs, plus school
   overrides.

Changes to 0216 behaviour (replacement bodies in 0354):

- `create_creative_generation` adds the daily cap check after the 3-in-progress check, under the same wallet lock. It
  counts the school's generations created in the UTC day that are not NOT_SENT or PROVIDER_FAILED, per class:
  - `IMAGE` media other than `avatar.*`, plus `avatar.create`, count as images;
  - `VIDEO` media other than `avatar.*` count as videos;
  - `avatar.video` and any later `avatar.*` video count as avatar videos.

  Over the cap, the request is refused with `CREATIVE_DAILY_LIMIT_REACHED` and nothing is reserved.
- `record_creative_generation_result` becomes a thin wrapper around a private
  `creative_record_generation_result(subject, generation, outcome, via_job boolean)` that only definer functions can
  call. The runtime wrapper passes `false`. A `SUBMITTED` job refuses every runtime outcome (`CREATIVE_GENERATION_HAS_PROVIDER_JOB`). While the job is
  still `PERMITTED` (no provider job id yet, so only the API knows what happened), the requester may record NOT_SENT,
  FAILED or UNKNOWN, but never SUCCEEDED or INTERRUPTED, and the job closes as `RECORDED`. So only the worker (`true`) records a submitted job.

## 4. API (C1b, next PR)

C1a already maps the new refusals in `SaasBillingService`: `CREATIVE_DAILY_LIMIT_REACHED`, `CREATIVE_PROVIDER_DAILY_LIMIT` and
`CREATIVE_PROVIDER_LIMIT_NOT_SET` are 422, and `CREATIVE_GENERATION_HAS_PROVIDER_JOB` and `CREATIVE_JOB_LEASE_LOST` are 409.


- `CreativeProviderRuntime` gains an optional asynchronous form: `submit(input)` returning `{providerJobId}` and
  `poll(job)` returning `PENDING` or a final `CreativeResult` / `CreativeProviderRuntimeError`. Runtimes that only
  have `generate` (the synthetic one, 0253 HQ) keep the synchronous CS1 path unchanged.
- The create flow for an async runtime:
  1. create (reserve);
  2. begin submission (guard). A refusal records NOT_SENT and answers 422 with the reason.
  3. `submit` once:
     - PRE_SEND → NOT_SENT;
     - FAILED → FAILED;
     - UNKNOWN or a lost answer → UNKNOWN;
     - a job id → record submission.
  4. Return the generation as `GENERATING`. A replay never submits again.
- `CreativeJobWorker`: claim → `poll` → record, one job at a time, the same loop shape as the S2 publish worker. A poll
  error is PENDING until the deadline, never a guess.
- HQ endpoints `GET/POST /v1/hq/creative/limits` (provider limit, school caps).

## 5. Tests

C1a ran: `test-creative-provider-jobs.mjs` J1-J11 pass 11/11. The CS1, A1, A2, HQ Creative Studio and CW1 review
regression proofs pass unchanged. `pnpm test`, `pnpm check` and the staging pins test pass.
The HQ read also lists `requesterUnavailable` jobs whose reservation is still RESERVED, so HQ can resolve them.

Planned coverage:

- DB proof `test-creative-provider-jobs.mjs` (champions-club fixture, restricted runtime and worker roles):
  - The guard refuses without a limit row, and at the limit.
  - Concurrent permits for one provider never pass the limit.
  - Worst case counts open jobs.
  - A NOT_SENT refusal returns the credits.
  - Submission id unique per provider; replay of the same id is accepted, a different id refused.
  - Claim leases only due SUBMITTED jobs. Lease and version mismatches are refused.
  - Poll backoff.
  - A result is recorded once for the requester, and charges the actual units.
  - A requester who lost access → REQUESTER_UNAVAILABLE, reservation still RESERVED.
  - Deadline → UNKNOWN and TIMED_OUT.
  - INTERRUPTED is refused while a job exists, and so is a direct runtime record of a submitted job.
  - Daily caps per class, with the HQ override, at the UTC day boundary.
  - HQ commands: owner only, version, replay, key reuse.
  - Other schools are unaffected.
  - ACLs: runtime and worker have EXECUTE only on their entry points and no table access.
- API unit tests with an async fake runtime: guard refusal, submit outcomes, replay never submits again, the worker
  poll/record loop, and poll errors before and after the deadline.
- Existing proofs (CS1, avatars, avatar videos, website drafts, HQ creative) must pass unchanged. Their runtimes are
  synchronous and never create jobs.
