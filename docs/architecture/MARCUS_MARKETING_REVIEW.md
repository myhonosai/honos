# Marcus marketing review (P3, migration 0641)

Status: spec + build, 2026-11-22. Asked for by David ("I want all ai agent backend done and switch them on"). It replaces Marcus's
"Marketing performance analysis: Backend required" line in the Ask HON roster (`apps/web/src/components/hon-command/roster.ts`).
"Publish, advertise or spend" stays human-only. Built the same way as Alex plans (0639) and Jordan follow-through (0640), and
reuses Alex's line and key helpers.

## What it does

A marketing staff member asks Marcus to review the **last 30 or 90 days**, with an optional question ("which campaign should we
keep?"). Marcus reads the school's own marketing numbers and answers with a summary (≤400), 1..6 findings and 1..5 next steps, each
next step optionally tagged with the teammate who can help (`marcus` campaigns, `chad` lead follow-up, `lena` content).

The review is **text only**. Nothing is created, sent, published or spent, and there is no apply step. The person can dismiss it.

## Contract

- Kind (0550): `MARCUS_MARKETING_REVIEW`, agent `marcus`, task class `DRAFT_MARKETING` (Marcus's existing planner class), budgets
  12,000 in / 3,000 out, max provider cost 80,000 micro-USD, result at most 12 KB, caller `HUMAN_UI`, subject `SCHOOL`, usage agent
  `MARKETING_REVIEW` (its own HQ usage line). No S4 function changes. No new tables.
- Who asks: a direct human at the session school with `marketing.assistant.use` (Marcus, 0212), `marketing.campaign.read`,
  `ai.invocation.plan` and an active Complete entitlement. The per-staff agent switch `ai.agent.marcus.use` (0635) is enforced by the
  planner. Who reads: `marketing.campaign.read`, and only the reader's **own** reviews (a review holds that person's question).
- Brief: `{period: 'LAST_30_DAYS' | 'LAST_90_DAYS', question: '' or 1..300 safe characters}`.
- Facts sent to the provider (`hon.marcus_review_facts`, about 8 KB at most), counts only, for leads created in the window:
  - `leads`: total, open, won, lost, registered (a registration conversion exists for the lead).
  - `bySource`: up to 12 sources (the captured attribution source, else the lead's source, else `UNKNOWN`) with leads, won, registered.
  - `campaigns`: up to 12 that are active or paused, or archived and running inside the window (never drafts): code, name, channel,
    status, startedDaysAgo, endsInDays, planned budget (planned, not spent) and currency, and leads, won and registered in the window.
  - `forms`: up to 10 lead forms that are not drafts: name, status, leads in the window and all-time accepted count.
  - Campaign and form names are staff-written and sent as untrusted text. No lead, person, family, student, contact or payment
    row, and no staff name, is ever sent. Other schools are never counted.
- Answer: `{summary, findings: [{title ≤120, detail ≤400}], nextSteps: [{title ≤120, detail ≤400, area marcus|chad|lena|null}]}`,
  one-line texts. Checked in the database (`marcus_review_ok`) and in contracts (`validateMarcusReviewProposal`, plus no links or email
  addresses). Outside the shape: stored empty and RESULT_REJECTED with its usage kept.
- Dismiss: `POST …/marcus/reviews/:id/close {status:'DISMISSED'}`; dismissing again changes nothing.

## API and web

- `apps/api/src/marcus-review/*`: controller under `organizations/:o/schools/:s/marcus/reviews` (scope resolved with
  `marketing.campaign.read`), human commands `marcus.review.read|request|close`, service as for Jordan without apply, provider profile
  at temperature 0.2.
- Web: on Marcus's page in Ask HON, a "Marketing review with Marcus" panel: last 30 or 90 days, optional question, then the summary,
  findings and next steps with the helping teammate, and **Dismiss**. The roster line becomes AVAILABLE.

## Tests

- DB proof `test-marcus-marketing-review.mjs` (MR1, 6 groups): custody, exact facts for 30 and 90 days (drafts and old campaigns
  out, no names, contacts or other school), nothing created or sent, marcus DRAFT_MARKETING plan and one ledger row, rejected
  answers, dismiss, UNKNOWN hold and HQ queue, MARKETING_REVIEW usage, gates (Marcus, campaign reading, AI planning, Complete, own
  reviews only), isolation, 011.
- API unit test `marcus-review.test.cjs`, contracts validators, web test `marcus-review-ui.test.tsx`.
