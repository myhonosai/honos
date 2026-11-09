# CRM times in school time (0236)

Backlog item B-CRM-3. Migration number 0236 was assigned by the coordinator on 2026-11-09, under the owner's delegation.

Before this change, CRM trial and follow-up times were entered in UTC. The runtime cannot read `hon.schools`, so the browser had no trusted school timezone. Now:

- The server names the school's timezone.
- Staff enter and see times in school time.
- Every command still receives an offset-qualified ISO 8601 instant, exactly as before. No command or stored value changes.

## Read

`GET /v1/organizations/:organizationId/schools/:schoolId/crm/school-clock` returns:

```json
{ "data": { "schoolId": "…", "schoolTimezone": "America/Los_Angeles", "localToday": "2026-11-08", "asOf": "2026-11-09T05:40:00.000Z" },
  "meta": { "requestId": "…", "correlationId": "…" } }
```

- **Transport.** GET only. No query string, no `X-HON-Source` or delegation headers, no cross-site fetch, never cached.
- **Scope.** The route resolves scope from the verified session. Its ids are never authority.
- **Authority.** `hon.read_crm_school_clock(subject)` is a SECURITY DEFINER read. It requires a direct human UI session holding, live at the exact school, one of `crm.trial.schedule`, `crm.trial.manage`, `crm.follow_up.manage` or `crm.follow_up.self_manage`.
  - Roles whose code looks like a family, HQ or system role never count.
  - The organization needs ACTIVE ESSENTIAL, CORE or COMPLETE paid access.
  - Authority is decided against `clock_timestamp()` before the read and again after it.
- **Effects.** It writes nothing and takes no lock. The runtime has EXECUTE on the read only; the actor helper stays private.
- **Contract.** `verifyCrmSchoolClock` in `@hon/contracts` (`crm-school-clock.ts`) is a strict closed verifier. It also checks the returned school against the shown school.

## Screens

**Staff CRM journey (`/staff/crm/journey`).**

- After each verified lead load, it reads the clock for that school.
- The trial start and end fields and the follow-up due field then take school time, and their labels name the zone.
- Trial windows are shown in school time.
- A scope change drops the zone.
- If the clock is unavailable, the fields stay explicitly UTC, as before.

**Trial appointments (`/staff/crm/trials`).** This page takes organization and school ids by hand. "Use school time" reads the clock for the entered scope and switches the fields; changing the scope switches them back to UTC.

**Daylight saving.** A time skipped by a daylight-saving change is refused before any command. A time that occurs twice takes its earlier instant (`apps/web/src/components/school-time.ts`).

**Standalone follow-ups (`/staff/crm/follow-ups`).** Its queue carries no organization id, so it reads the session-scoped `GET /v1/staff/crm/school-clock`. That route takes its scope only from the verified follow-up session, the same way `/staff/crm/follow-ups` does, and the definer read re-decides authority. After each verified queue load the page reads the clock for the queue's school. The due field then takes school time and queue and detail due times are shown in school time. A school time skipped by daylight saving is refused before any command. A due time already typed as UTC is stored as an instant, so it keeps its meaning when the zone arrives. If the clock is unavailable, the field stays explicitly UTC.

## Proof

- **Database.** `packages/database/scripts/test-crm-school-clock-integrity.mjs` runs over signed HTTP on the guarded disposable CRM-close fixture and passes 94 checks. It covers each permission, three schools in three zones, every authority refusal (no permission, a family-type role, another school or organization, suspended paid access, a suspended school, a revoked or expired grant, a second active principal, a management role scoped to another school), transport refusals, the session-scoped route (follow-up scope only, no selectors, paid access and school status), no writes, runtime ACL and the 011 section.
- **Web.** `apps/web/test/school-time.test.ts` covers the conversions, including DST gaps and folds. `apps/web/test/crm-journey-ui.test.tsx` shows the converted instants are sent, skipped times are refused, and the UTC fallback holds.
