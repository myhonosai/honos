# Operator verification before deploying 0201 (UTC billing periods, Issue #100)

**Purpose:** find any HON SaaS billing period that production stored while a session ran in a non-UTC time zone, *before* 0201 is deployed, so the owner can decide what to do about each one.
**Read only.** Nothing here changes data. Do not correct historical financial records automatically. That covers subscription periods, immutable history, invoices and payment evidence. Every row found goes to the owner for a decision.

## Who runs it and when

- **Who:** an operator with read access to the production database. A read-only role is preferred. The `hon_runtime` role cannot read these tables.
- **When:** run it once immediately before the deploy that applies 0201. Run it again right after the deploy, before the next renewal or `ADVANCE_PERIOD` for any affected subscription.
- **Where the queries live:** `packages/database/scripts/saas-billing-utc-operator-check.mjs`. The proofs execute exactly this text:
  - `test-saas-billing-utc-periods-integrity.mjs` covers the HQ command path.
  - `test-saas-billing-utc-webhook-periods.mjs` covers the Stripe webhook path.

## Step 1: record the session time zones (evidence)

```sql
SHOW TimeZone;                                                     -- in a session as the runtime role
SELECT datname, setconfig FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase;   -- database defaults
SELECT rolname, rolconfig FROM pg_roles WHERE rolname IN ('hon_runtime', current_user);            -- role defaults
```

**What the result means:**
- **Always UTC:** if the runtime role, the database default and the pooler's startup options were UTC for the whole time billing ran, no stored period can have drifted. Step 2 should then return no rows.
- **Not proof of history:** the current setting does not show past settings, or a `SET TimeZone` leaked on a pooled connection. Step 2 is the real check.

## Step 2: run the three checks in one read-only transaction

```sql
BEGIN TRANSACTION READ ONLY;

-- (a) current period of each monthly/annual subscription
SELECT s.id, s.organization_id, s.billing_interval, s.period_index, s.current_period_start, s.current_period_end,
  ((s.period_anchor_at AT TIME ZONE 'UTC') + make_interval(months => (s.period_index) * CASE s.billing_interval WHEN 'ANNUAL' THEN 12 ELSE 1 END)) AT TIME ZONE 'UTC' AS utc_period_start,
  ((s.period_anchor_at AT TIME ZONE 'UTC') + make_interval(months => (s.period_index + 1) * CASE s.billing_interval WHEN 'ANNUAL' THEN 12 ELSE 1 END)) AT TIME ZONE 'UTC' AS utc_period_end
FROM hon.saas_subscriptions s
WHERE s.billing_interval IN ('MONTHLY','ANNUAL') AND s.period_index IS NOT NULL AND s.period_anchor_at IS NOT NULL
  AND (s.current_period_start, s.current_period_end) IS DISTINCT FROM
    (((s.period_anchor_at AT TIME ZONE 'UTC') + make_interval(months => (s.period_index) * CASE s.billing_interval WHEN 'ANNUAL' THEN 12 ELSE 1 END)) AT TIME ZONE 'UTC',
     ((s.period_anchor_at AT TIME ZONE 'UTC') + make_interval(months => (s.period_index + 1) * CASE s.billing_interval WHEN 'ANNUAL' THEN 12 ELSE 1 END)) AT TIME ZONE 'UTC')
ORDER BY s.id;

-- (b) immutable subscription history rows that recorded a period
SELECT h.subscription_id, h.version, h.period_index, h.current_period_start, h.current_period_end,
  ((s.period_anchor_at AT TIME ZONE 'UTC') + make_interval(months => (h.period_index) * CASE s.billing_interval WHEN 'ANNUAL' THEN 12 ELSE 1 END)) AT TIME ZONE 'UTC' AS utc_period_start,
  ((s.period_anchor_at AT TIME ZONE 'UTC') + make_interval(months => (h.period_index + 1) * CASE s.billing_interval WHEN 'ANNUAL' THEN 12 ELSE 1 END)) AT TIME ZONE 'UTC' AS utc_period_end
FROM hon.saas_subscription_history h JOIN hon.saas_subscriptions s ON s.id = h.subscription_id
WHERE s.billing_interval IN ('MONTHLY','ANNUAL') AND h.period_index IS NOT NULL AND s.period_anchor_at IS NOT NULL
  AND (h.current_period_start, h.current_period_end) IS DISTINCT FROM
    (((s.period_anchor_at AT TIME ZONE 'UTC') + make_interval(months => (h.period_index) * CASE s.billing_interval WHEN 'ANNUAL' THEN 12 ELSE 1 END)) AT TIME ZONE 'UTC',
     ((s.period_anchor_at AT TIME ZONE 'UTC') + make_interval(months => (h.period_index + 1) * CASE s.billing_interval WHEN 'ANNUAL' THEN 12 ELSE 1 END)) AT TIME ZONE 'UTC')
ORDER BY h.subscription_id, h.version;

-- (c) subscription-period invoices (HQ drafts and provider-paid invoices)
SELECT i.id, i.subscription_id, i.status, i.period_index, i.service_period_start, i.service_period_end,
  ((s.period_anchor_at AT TIME ZONE 'UTC') + make_interval(months => (i.period_index) * CASE s.billing_interval WHEN 'ANNUAL' THEN 12 ELSE 1 END)) AT TIME ZONE 'UTC' AS utc_period_start,
  ((s.period_anchor_at AT TIME ZONE 'UTC') + make_interval(months => (i.period_index + 1) * CASE s.billing_interval WHEN 'ANNUAL' THEN 12 ELSE 1 END)) AT TIME ZONE 'UTC' AS utc_period_end
FROM hon.saas_invoices i JOIN hon.saas_subscriptions s ON s.id = i.subscription_id
WHERE i.kind = 'SUBSCRIPTION_PERIOD' AND s.billing_interval IN ('MONTHLY','ANNUAL') AND s.period_anchor_at IS NOT NULL
  AND (i.service_period_start, i.service_period_end) IS DISTINCT FROM
    (((s.period_anchor_at AT TIME ZONE 'UTC') + make_interval(months => (i.period_index) * CASE s.billing_interval WHEN 'ANNUAL' THEN 12 ELSE 1 END)) AT TIME ZONE 'UTC',
     ((s.period_anchor_at AT TIME ZONE 'UTC') + make_interval(months => (i.period_index + 1) * CASE s.billing_interval WHEN 'ANNUAL' THEN 12 ELSE 1 END)) AT TIME ZONE 'UTC')
ORDER BY i.subscription_id, i.period_index, i.id;

ROLLBACK;
```

**Scope of the checks:**
- **Covered:** monthly and annual subscriptions with a period anchor.
- **Not covered:** lifetime terms have no periods. The creative and AI-credit allowance windows (0156, 0202) already compute in UTC and are not part of this check.

## Step 3: interpret and report (no correction)

| Result | Meaning | Action |
|---|---|---|
| All three empty | No stored period differs from UTC month arithmetic | Record the evidence and deploy |
| Rows found | A period was stored by a non-UTC session; it differs by up to about a day (local month-end clamping) or by the DST hour | Send the list to the owner. **Do not edit, void or reissue anything automatically.** |

**What the owner needs for each affected subscription:**
- **Stored and UTC periods:** the stored period and the UTC period, side by side, for:
  - the current period;
  - every history row;
  - every invoice.
- **Payments:** whether any payment evidence or refund window references the drifted dates.

**What happens after 0201 without any correction:**
- **The stored drifted rows stay exactly as recorded.** History and invoices are immutable evidence.
- **The next renewal or `ADVANCE_PERIOD` computes from the original anchor in UTC.** The proof shows this.
- **The boundary between those periods can therefore have a gap or an overlap of up to about a day.** That is the drift being removed.
- **Renewal matching is unaffected.** It accepts a provider period within a day of the anchored period.

**Decisions only the owner can make** (no default is assumed):
- **Customer impact:** whether a gap or overlap needs a customer-facing correction, for example a credit note or an annotated invoice.
- **Correcting record:** whether a correcting record is required, rather than editing the original.

## Step 4: after deploying

1. **Confirm the pins:** all six functions must have `TimeZone=UTC`. `saas-billing-security.mjs` verifies the exact list. By hand:
   ```sql
   SELECT p.oid::regprocedure, p.proconfig FROM pg_proc p
   WHERE p.pronamespace = 'hon'::regnamespace AND p.proname IN ('command_saas_subscription','create_saas_invoice_draft','saas_provider_invoice',
     'saas_apply_renewal','saas_activate_checkout_core','saas_activate_hon_os_checkout_core');
   ```
2. **Run Step 2 again:** the result should be identical to the pre-deploy result. 0201 changes no rows.
