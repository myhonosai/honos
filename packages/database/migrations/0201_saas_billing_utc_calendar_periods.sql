BEGIN;
-- Issue #100: HON SaaS billing periods must not depend on the PostgreSQL session TimeZone.
--
-- These six functions add calendar months to timestamptz values (`ts + interval '1 month'`,
-- `ts + make_interval(months => n)`). PostgreSQL performs that arithmetic in the SESSION TimeZone,
-- so the same anchor produced different period boundaries per connection: for example an anchor of
-- 2026-10-31T23:59:59.999Z gives a period end of 2026-11-30T23:59:59.999Z in a UTC session but
-- 2026-12-01T00:59:59.999Z in an America/New_York session, and a daylight-saving change inside the
-- month moved the period end by an hour. The API pool never pins TimeZone, so a role/database
-- default, a pooler or any session-level SET left on a reused pooled connection changed billing.
--
-- Forward-only correction (no historical migration is edited, no function body changes): each
-- function now runs with TimeZone=UTC through the function SET clause. PostgreSQL applies it on entry
-- and restores the caller's setting on exit, so the caller's session (and a reused pooled connection)
-- is unchanged and UTC applies to every nested call. Approved semantics: a billing period is the
-- ORIGINAL anchor plus whole UTC calendar months, clamped to the last day of a shorter month, with the
-- anchor's UTC time of day kept (the behaviour UTC sessions, CI and the 0156 allowance periods already
-- had). No stored subscription, price, term, invoice, payment or credit row is read or changed here.
-- A later CREATE OR REPLACE of any of these functions resets the setting; saas-billing-security.mjs
-- refuses that, and refuses any other unpinned SaaS function that adds calendar months.
ALTER FUNCTION hon.command_saas_subscription(text,uuid,jsonb,uuid,uuid,uuid) SET TimeZone = 'UTC';
ALTER FUNCTION hon.create_saas_invoice_draft(text,jsonb,uuid,uuid,uuid) SET TimeZone = 'UTC';
ALTER FUNCTION hon.saas_provider_invoice(hon.saas_subscriptions,integer,integer,timestamptz,text,jsonb,timestamptz) SET TimeZone = 'UTC';
ALTER FUNCTION hon.saas_apply_renewal(jsonb,timestamptz) SET TimeZone = 'UTC';
ALTER FUNCTION hon.saas_activate_checkout_core(uuid,jsonb,timestamptz,boolean) SET TimeZone = 'UTC';
ALTER FUNCTION hon.saas_activate_hon_os_checkout_core(uuid,jsonb,timestamptz,boolean) SET TimeZone = 'UTC';
COMMIT;
