# School support requests (0335)

Part of the onboarding vision (support recorded and delivered). Implementation matrix item B3.

## What happens
A direct human with `support.request` at the session school (backfilled to every system OWNER role) asks for help with a topic, a subject, a message and the page they asked from. The request becomes an `hq_support_cases` row (0232) for exactly that school: status OPEN, priority NORMAL, opened by the school person, with the school's words as the OPENED note. `hon.school_support_requests` links it one-to-one. HQ works it with the existing support tools and answers through HQ communications (0281).

| School topic | HQ category |
|---|---|
| GETTING_STARTED | ONBOARDING |
| IMPORTING_DATA | DATA_REQUEST |
| BILLING | BILLING |
| ACCOUNT_ACCESS | ACCOUNT_ACCESS |
| PROBLEM | PRODUCT_ISSUE |
| IDEA | FEEDBACK |
| OTHER | OTHER |

## What the school sees
Its last 50 requests, each with topic, subject, status (OPEN, WAITING_ON_SCHOOL, RESOLVED, CLOSED) and the school's own messages. Never HQ notes, the assignee, the priority or an HQ person's name.

A school message on a WAITING_ON_SCHOOL or RESOLVED case adds a NOTE to the HQ history and moves the case back to OPEN with a recorded CHANGED event. A CLOSED case takes no more messages.

## Limits and evidence
- 10 new requests per school, and 30 school messages per request, in any 24 hours (`SUPPORT_RATE_LIMITED`, HTTP 429). The daily count is taken under a per-school lock.
- Every command has an idempotency key with exact replay. Audit (`support.request.submitted` / `.messaged`) and inert outbox payloads carry identifiers only, never the school's words.
- Before access starts (owner decision D3) a school may still ask: the actor check needs no active entitlement.

## API
- `GET /v1/organizations/:org/schools/:school/support-requests`
- `POST /v1/organizations/:org/schools/:school/support-requests` with `X-HON-Human-Command: support.request.submit`, `Idempotency-Key`, body `{topic, subject, message, pageHint}`
- `POST /v1/organizations/:org/schools/:school/support-requests/:requestId/messages` with `X-HON-Human-Command: support.request.message`, body `{message}`

Route ids are never authority: scope is resolved from the verified session and re-proved in the database. Nothing here sends a message or touches billing, access, credits or AI.

## Not in this slice
The school Help panel (next PR), notifying the school when HQ replies, HQ marking a case as from a school.
