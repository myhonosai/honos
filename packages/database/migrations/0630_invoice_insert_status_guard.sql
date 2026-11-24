BEGIN;

-- 0630 Invoice INSERT status guard (coordinator-allocated 2026-11-22; launch-readiness review P2 "invoice provenance").
-- Owner request (David, 2026-11-22): fix the review's findings before more features.
-- The 0240 guard (hon.guard_invoice_payment_status) checks PAID against unvoided payment records only on UPDATE, so the
-- restricted runtime, which holds INSERT on hon.invoices for human drafting, could INSERT an in-scope invoice already PAID
-- (or ISSUED, VOID, UNCOLLECTIBLE) with no payment record; the balance projection then reported zero owed.
--   IG1  A writer without superuser or BYPASSRLS (the runtime and every other ordinary role) may INSERT an invoice only
--        as DRAFT. Every later state is reached through the guarded UPDATE paths (issue, payment records, void).
--   IG2  Trusted writers (the migration owner and SECURITY DEFINER functions it owns) are unchanged: 0322 autopay, 0334
--        balance import and 0459 demo data create ISSUED invoices, 0558 simple invoices and the API drafting service create
--        DRAFT ones, and reviewed owner-run imports or restores may still carry historical states.
-- Nothing here changes existing rows, grants, sends, charges or calls an outside service.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.guard_invoice_payment_status()') IS NULL OR to_regclass('hon.invoices') IS NULL THEN
    RAISE EXCEPTION '0630 requires 0240'; END IF;
END $$;

CREATE FUNCTION hon.guard_invoice_insert_status() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  -- Not SECURITY DEFINER: current_user is the role actually writing the row (a definer function's owner when one inserts).
  IF NEW.status<>'DRAFT' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'INVOICE_INSERT_STATUS_GUARD' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_insert_status_guard BEFORE INSERT ON hon.invoices
  FOR EACH ROW EXECUTE FUNCTION hon.guard_invoice_insert_status();

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.guard_invoice_insert_status() FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_invoice_insert_status() FROM %I',r); END LOOP;
END $$;
COMMIT;
