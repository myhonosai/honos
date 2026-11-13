# HQ alerts at 75%, 90% and 100% of a school's AI cost limit (migration 0343)

Status: built (0343), not deployed. Test providers only. No provider call, no message sent outside HON, no change to any
limit, pause or spend decision. Builds on the per-school cost ceiling in `AI_SCHOOL_COST_CEILING.md` (0288).

This is HON's own provider cost for the included AI team. It is shown only to HQ and never to a school as credits, a
balance or a charge.

## Behaviour

1. **Derived, not written on the spend path.** No trigger is added to the ledger or the invocation tables. An alert exists
   at read time for every level (`WARNING_75`, `WARNING_90`, `CEILING_REACHED`) that the school's committed cost
   (`hon.ai_school_committed_cost_micros`, the same number the spend decision uses) has reached in the current UTC month.
   Only schools with a ceiling above $0 appear: no ceiling means no alert, and a $0 ceiling is an HQ block, not a warning.
   Raising the ceiling clears alerts the new ceiling no longer reaches.
2. **When it was reached.** `crossedAt` is the first ledger time in the window at which the running recorded cost reached the
   level. It is null while only in-flight holds (valued at their worst case) reach the level ("Reached by work still in
   progress").
3. **Read** `GET /v1/hq/ai/school-cost-alerts` (`hon.read_ai_school_cost_alerts_from_hq`): any HQ billing reader. At most 500
   alerts, open first, then the highest level, then the highest share used. `openCount` counts every open alert, including
   any beyond the 500. The authority is checked again after the read.
4. **Acknowledge** `POST /v1/hq/ai/school-cost-alerts/acknowledgements` (`hon.command_ai_school_cost_alert_acknowledgement`):
   human HQ owner only, with `X-HON-Human-Command: ai-school-cost-alert-ack` and an Idempotency-Key. Body is exactly
   `schoolId`, `level`, `windowStart`, `reason` (10–500 characters). Only an alert that is reached now, in the current
   window, can be acknowledged, once per school, level and window. The same key with the same body replays; a reused key with
   another body, a second acknowledgement, an alert not reached or another window is refused with nothing written.
   Acknowledgements are immutable and kept under forced RLS with no runtime table access.
5. **HQ screen.** `/hq/ai-costs` shows the alerts above the usage report (`HqAiCostAlerts`). An unknown outcome keeps the
   exact request so Try again sends the same key; leaving the tab drops it.

## Not in this change

- Editing a school's ceiling from the HQ screen (the API from 0288 exists; the screen is a follow-up).
- Notifying HQ by email or chat when an alert opens. That would be a message outside HON and needs its own approval.
