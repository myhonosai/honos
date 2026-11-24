BEGIN;

-- B-TUI-1b (0280): the current school's invoice list, so a DRAFT that was not issued at once can be found again and
-- issued, and staff can see every invoice of the school in one place. Read-only: no DML, no provider, communication,
-- AI or automation effect. Same readers as the 0240 receivables read (billing.invoice.payment.record, .issue or
-- .create, live at the current school, re-proved after the read).
-- status ALL, DRAFT, ISSUED, PAID, VOID or UNCOLLECTIBLE; newest first (created_at, then id), 50 per page after an
-- optional invoice id cursor from this school. canIssue / canRecord say which commands the reader may also run.
CREATE FUNCTION hon.read_school_invoices(subject text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); used text; actor uuid; wanted text;
  after uuid; after_at timestamptz; page jsonb; more boolean; can_issue boolean:=false; result jsonb;
BEGIN
  used:=hon.require_tuition_reader(subject); actor:=hon.require_tuition_actor(subject,used);
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ? 'status' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x NOT IN ('status','after'))
    OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR p->>'status' NOT IN ('ALL','DRAFT','ISSUED','PAID','VOID','UNCOLLECTIBLE')
    OR (p ? 'after' AND (jsonb_typeof(p->'after') IS DISTINCT FROM 'string' OR p->>'after' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  wanted:=p->>'status'; after:=nullif(p->>'after','')::uuid;
  IF after IS NOT NULL THEN
    -- The cursor must be an invoice of this school; another school's id is refused, never disclosed.
    SELECT i.created_at INTO after_at FROM hon.invoices i WHERE i.id=after AND i.organization_id=org AND i.school_id=school;
    IF NOT FOUND THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  END IF;
  BEGIN PERFORM hon.require_tuition_actor(subject,'billing.invoice.issue'); can_issue:=true;
  EXCEPTION WHEN insufficient_privilege THEN can_issue:=false; END;
  SELECT coalesce(jsonb_agg(hon.invoice_balance_json(i)||jsonb_build_object('createdAt',to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      ORDER BY i.created_at DESC,i.id DESC),'[]'::jsonb),count(*)>50 INTO page,more FROM (
    SELECT i.* FROM hon.invoices i WHERE i.organization_id=org AND i.school_id=school AND (wanted='ALL' OR i.status::text=wanted)
      AND (after IS NULL OR (i.created_at,i.id)<(after_at,after))
    ORDER BY i.created_at DESC,i.id DESC LIMIT 51) i;
  IF more THEN page:=page-50; END IF;
  result:=jsonb_build_object('localToday',to_char(hon.membership_school_today(),'YYYY-MM-DD'),'timezone',
    (SELECT s.timezone FROM hon.schools s WHERE s.id=school AND s.organization_id=org),'status',wanted,
    'canIssue',can_issue,'canRecord',used='billing.invoice.payment.record','items',page,
    'nextAfter',CASE WHEN more THEN page->49->>'invoiceId' ELSE NULL END);
  IF hon.require_tuition_actor(subject,used) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'TUITION_RECEIVABLES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

COMMENT ON FUNCTION hon.read_school_invoices(text,jsonb) IS
'Direct HUMAN_UI read-only invoice list of the current school (B-TUI-1b 0280): every status or one, newest first, 50 per page. No DML.';

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.read_school_invoices(text,jsonb) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_school_invoices(text,jsonb) FROM %I',r);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_invoices(text,jsonb) TO hon_runtime;
  END IF;
END $$;

COMMIT;
