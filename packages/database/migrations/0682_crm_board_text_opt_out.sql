BEGIN;

-- Lead board text opt-out (0682, was 0571; renumbered after main reached ceiling 0581; ledger 2026-11-19). Leads board quick actions (PR #517) offer a
-- Text link that opens the staff member's own phone. A lead whose person has opted out of texts (an SMS consent row
-- OPTED_OUT: STOP to a school number, 0248, or a staff-recorded opt-out, 0046) must not be offered Text. This replaces
-- hon.read_crm_pipeline_board (0417, unchanged since) with one added card field, textOptedOut, read from
-- hon.communication_consents of the same organization, school and person. Everything else in the read is the 0417 body.
-- No table, permission, command, provider or message is added; the board's ACL is restated unchanged.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Lead board text opt-out requires a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.read_crm_pipeline_board(text,uuid,text)') IS NULL THEN RAISE EXCEPTION 'Apply migration 0417 first'; END IF;
END $$;

CREATE OR REPLACE FUNCTION hon.read_crm_pipeline_board(subject text, selected_pipeline uuid, selected_status text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); chosen hon.crm_pipelines%ROWTYPE;
  pipelines jsonb; leads jsonb; totals jsonb; shown integer; statuses hon.lead_status[];
BEGIN
  IF selected_status IS NULL OR selected_status NOT IN ('OPEN','WON','LOST','CLOSED') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  PERFORM hon.require_crm_board_actor(subject,'crm.lead.read');
  statuses:=CASE selected_status WHEN 'CLOSED' THEN ARRAY['WON','LOST']::hon.lead_status[] ELSE ARRAY[selected_status]::hon.lead_status[] END;
  IF selected_pipeline IS NULL THEN
    SELECT * INTO chosen FROM hon.crm_pipelines p WHERE p.organization_id=org AND p.school_id=school ORDER BY p.created_at,p.id LIMIT 1;
  ELSE
    SELECT * INTO chosen FROM hon.crm_pipelines p WHERE p.id=selected_pipeline AND p.organization_id=org AND p.school_id=school;
    IF NOT FOUND THEN RAISE EXCEPTION 'CRM_PIPELINE_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',x.id,'name',x.name,'version',x.version) ORDER BY x.created_at,x.id),'[]'::jsonb) INTO pipelines
  FROM (SELECT * FROM hon.crm_pipelines p WHERE p.organization_id=org AND p.school_id=school ORDER BY p.created_at,p.id LIMIT 50) x;
  IF chosen.id IS NULL THEN
    RETURN jsonb_build_object('pipelines',pipelines,'pipeline',NULL,'stages','[]'::jsonb,
      'totals',jsonb_build_object('open',0,'won',0,'lost',0),'status',selected_status,'leads','[]'::jsonb,'truncated',false,'limit',500);
  END IF;
  SELECT jsonb_build_object('open',count(*) FILTER (WHERE l.status='OPEN'),'won',count(*) FILTER (WHERE l.status='WON'),'lost',count(*) FILTER (WHERE l.status='LOST'))
    INTO totals FROM hon.crm_leads l WHERE l.organization_id=org AND l.school_id=school AND l.pipeline_id=chosen.id;
  SELECT coalesce(jsonb_agg(card ORDER BY ord),'[]'::jsonb), count(*) INTO leads, shown FROM (
    SELECT row_number() OVER (ORDER BY l.created_at DESC,l.id) ord, jsonb_build_object(
      'id',l.id,'version',l.version,'status',l.status,'stageId',l.pipeline_stage_id,'personId',l.primary_person_id,
      'givenName',p.given_name,'familyName',p.family_name,'email',p.email::text,'phoneE164',p.phone_e164,
      'programInterestCode',l.program_interest_code,'sourceCode',l.source_code,
      'createdAt',hon.crm_board_ts(l.created_at),'closedAt',hon.crm_board_ts(coalesce(l.won_at,l.lost_at)),
      'nextTrialAt',hon.crm_board_ts((SELECT min(a.starts_at) FROM hon.crm_appointments a WHERE a.crm_lead_id=l.id AND a.organization_id=org AND a.school_id=school
        AND a.status='SCHEDULED' AND a.starts_at>=clock_timestamp())),
      'lastTrialAt',hon.crm_board_ts((SELECT max(a.starts_at) FROM hon.crm_appointments a WHERE a.crm_lead_id=l.id AND a.organization_id=org AND a.school_id=school
        AND a.status<>'CANCELLED' AND a.starts_at<clock_timestamp())),
      'textOptedOut',EXISTS(SELECT 1 FROM hon.communication_consents k WHERE k.person_id=p.id AND k.organization_id=org AND k.school_id=school
        AND k.channel='SMS' AND k.status='OPTED_OUT')) card
    FROM hon.crm_leads l JOIN hon.people p ON p.id=l.primary_person_id AND p.organization_id=l.organization_id AND p.school_id=l.school_id
    WHERE l.organization_id=org AND l.school_id=school AND l.pipeline_id=chosen.id AND l.status=ANY(statuses)
    ORDER BY l.created_at DESC,l.id LIMIT 501) q WHERE ord<=500;
  RETURN jsonb_build_object('pipelines',pipelines,'pipeline',jsonb_build_object('id',chosen.id,'name',chosen.name,'version',chosen.version),
    'stages',hon.crm_board_stages_json(chosen.id),'totals',totals,'status',selected_status,'leads',leads,
    'truncated',(SELECT count(*) FROM hon.crm_leads l WHERE l.organization_id=org AND l.school_id=school AND l.pipeline_id=chosen.id AND l.status=ANY(statuses))>500,
    'limit',500);
END $$;

DO $$ DECLARE r text; f text:='hon.read_crm_pipeline_board(text,uuid,text)';
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END IF;
END $$;
COMMIT;
