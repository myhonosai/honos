BEGIN;

-- Blast recipients read (0716, allocated by the coordinator 2026-11-28). Owner ask (David, 2026-11-28): "Emails also needs to be
-- saved on history so we can go back and see what was sent." Every blast message is already kept (0621 queues one 0243
-- message per reachable person, with its own rendered subject and body). This adds the one missing read: who a sent blast
-- went to. Builds on 0621 (blasts) and 0424 (contact message history). Spec: docs/architecture/SCHOOL_BLASTS.md
-- (Recipients). Contract: @hon/contracts school-blasts.ts verifySchoolBlastRecipients.
-- Rules:
--   R1  hon.read_school_blast_recipients(subject, blast) needs the same live marketing.blast.read authority as the other
--       blast reads (direct human, current school, re-checked before it answers). Another school's blast is not found.
--   R2  It lists the 0621 recipient rows of that blast, at most 2,000 (the 0621 send cap): the person's current name, the
--       outcome, and for a queued person the message id, its delivery state (as the blast counts show it: WAITING, then
--       the 0243 delivery status, or CANCELLED) and the provider failure code. A draft has no rows.
--   R3  No address, body or consent detail is returned. The full email stays behind 0424 hon.read_contact_message_email,
--       which keeps its own contact history permission.
--   R4  The runtime gains exactly this one entry point; tables and helpers keep their (empty) grants.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'Blast recipients read requires a restricted runtime'; END IF;
  IF to_regprocedure('hon.require_school_blast_actor(text,text)') IS NULL OR to_regclass('hon.school_blast_recipients') IS NULL
    OR to_regprocedure('hon.read_contact_message_email(text,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '0716 requires 0424 and 0621'; END IF;
END $$;

-- R1-R3
CREATE FUNCTION hon.read_school_blast_recipients(subject text,blast uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; b hon.school_blasts%ROWTYPE; items jsonb;
BEGIN
  IF blast IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_school_blast_actor(subject,'marketing.blast.read');
  SELECT * INTO b FROM hon.school_blasts x WHERE x.id=blast AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'BLAST_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('personId',y.person_id,'name',y.name,'outcome',y.outcome,'messageId',y.message_id,
      'delivery',y.delivery,'failureCode',y.failure_code) ORDER BY y.queued_first,y.sort_name,y.person_id),'[]'::jsonb)
    INTO items
  FROM (SELECT r.person_id,r.outcome,r.message_id,
      CASE WHEN r.outcome='QUEUED' THEN 0 ELSE 1 END AS queued_first,
      left(coalesce(nullif(btrim(concat_ws(' ',p.given_name,p.family_name)),''),''),200) AS name,
      lower(concat_ws(' ',p.given_name,p.family_name)) AS sort_name,
      CASE WHEN r.outcome<>'QUEUED' THEN NULL WHEN m.lifecycle='CANCELLED' AND d.id IS NULL THEN 'CANCELLED'
        WHEN d.id IS NULL THEN 'WAITING' ELSE d.status::text END AS delivery,
      CASE WHEN r.outcome='QUEUED' THEN left(d.failure_code,80) END AS failure_code
    FROM hon.school_blast_recipients r
    JOIN hon.people p ON p.id=r.person_id AND p.organization_id=r.organization_id AND p.school_id=r.school_id
    LEFT JOIN hon.communication_messages m ON m.id=r.message_id AND m.organization_id=r.organization_id AND m.school_id=r.school_id
    LEFT JOIN hon.communication_deliveries d ON d.message_id=m.id
    WHERE r.blast_id=b.id AND r.organization_id=org AND r.school_id=school
    ORDER BY CASE WHEN r.outcome='QUEUED' THEN 0 ELSE 1 END,lower(concat_ws(' ',p.given_name,p.family_name)),r.person_id
    LIMIT 2000) y;
  IF hon.require_school_blast_actor(subject,'marketing.blast.read') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_BLAST_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('blastId',b.id,'channel',b.channel,'status',b.status,'items',items);
END $$;

-- R4
DO $$ DECLARE r text; f text:='hon.read_school_blast_recipients(text,uuid)';
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END IF;
END $$;
COMMIT;
