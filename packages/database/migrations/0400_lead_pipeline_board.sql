BEGIN;

-- Lead pipeline board (0400, coordinator-allocated 2026-11-16).
-- Owner request (David, 2026-11-16): Leads, Enroll a lead and Enrollment journey become one pipeline (kanban) page.
-- Verified 2026-11-16 on main dc8408a: pipelines and stages exist since 0002, but nothing could move a lead between stages
-- or rename, recolour, reorder, add or hide a stage. Spec: docs/architecture/LEAD_PIPELINE_BOARD_SPEC.md.
--   P1  Stages get a colour from a fixed palette and can be hidden. Terminal (WON/LOST/ARCHIVED) stages are never hidden.
--   P2  read_crm_pipeline_board: one pipeline's stages with open counts, totals, and up to 500 leads of one status, with
--       program, source and trial dates. crm.lead.read.
--   P3  move_crm_lead_stage: an OPEN lead at its expected version to another visible non-terminal stage of its pipeline.
--       New crm.lead.stage.move (OWNER plus every role that can already create leads). Closing stays hon.close_crm_lead.
--   P4  save_crm_pipeline_stages: the full ordered list of non-terminal stages (rename, recolour, reorder, add, hide) at the
--       pipeline's expected version; a newly hidden stage with open leads must name a visible stage they move to, in the same
--       transaction. crm.pipeline.manage.
--   P5  Guards: a lead's stage changes after insert, and any stage update, only inside these definer functions.
-- Human UI only, exact school, live permission and CRM entitlement re-proved after the authority locks. No message, AI,
-- enrollment, membership or payment effect.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.close_crm_lead(text,uuid,jsonb,uuid,uuid,uuid)') IS NULL OR to_regprocedure('hon.membership_command_args_ok(text,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '0400 requires 0145, 0224 and the staff eligibility helper'; END IF;
  IF NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code='crm.pipeline.manage') OR NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code='crm.lead.read') THEN
    RAISE EXCEPTION '0400 requires crm.pipeline.manage and crm.lead.read'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('crm.lead.stage.move','Move an open lead to another stage of its pipeline on the lead board (no close, enrollment or payment)',false,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code='crm.lead.stage.move' AND NOT is_sensitive AND is_staff_assignable) THEN
    RAISE EXCEPTION 'crm.lead.stage.move already exists with an unexpected definition'; END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,'crm.lead.stage.move' FROM hon.roles r
WHERE (r.is_system_role AND r.code='OWNER')
   OR EXISTS (SELECT 1 FROM hon.role_permissions rp WHERE rp.role_id=r.id AND rp.organization_id=r.organization_id AND rp.permission_code='crm.lead.create')
ON CONFLICT DO NOTHING;

-- ---------- P1: colour and hidden ----------
ALTER TABLE hon.crm_pipeline_stages
  ADD COLUMN color text NOT NULL DEFAULT 'BLUE' CHECK (color IN ('BLUE','SKY','CYAN','VIOLET','GREEN','RED','AMBER','SLATE')),
  ADD COLUMN hidden_at timestamptz,
  ADD CONSTRAINT crm_pipeline_stages_terminal_visible CHECK (terminal_status IS NULL OR hidden_at IS NULL);
UPDATE hon.crm_pipeline_stages SET color = CASE terminal_status WHEN 'WON' THEN 'GREEN' WHEN 'LOST' THEN 'RED' ELSE 'SLATE' END
WHERE terminal_status IS NOT NULL;

-- ---------- shared helpers (migration-owner only) ----------
CREATE FUNCTION hon.crm_board_ts(value timestamptz) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN value IS NULL THEN NULL ELSE to_char(value AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
$$;

-- The direct human actor at the exact school with one live permission and the CRM entitlement in effect.
CREATE FUNCTION hon.require_crm_board_actor(subject text, permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF permission IS NULL OR permission NOT IN ('crm.lead.read','crm.lead.stage.move','crm.pipeline.manage')
    OR subject IS NULL OR length(subject) NOT BETWEEN 1 AND 2048 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'CRM_BOARD_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
    AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=org AND o.status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=p.id AND f.effective_from<=clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
    AND NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      WHERE g.principal_id=p.id AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND hon.staff_member_eligible(p.id,org,school)
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions x ON x.code=rp.permission_code
      WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND x.code=permission AND x.is_staff_assignable);
  IF actor IS NULL THEN RAISE EXCEPTION 'CRM_BOARD_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.lock_crm_board_actor(subject text, permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid;
BEGIN
  actor:=hon.require_crm_board_actor(subject,permission);
  -- Revocation, role, identity and entitlement changes cannot slip in between the check and the commit.
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,
    hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  IF hon.require_crm_board_actor(subject,permission) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CRM_BOARD_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.crm_board_stages_json(selected_pipeline uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'position',s.position,'color',s.color,'hidden',s.hidden_at IS NOT NULL,
      'terminalStatus',s.terminal_status,
      'openCount',(SELECT count(*) FROM hon.crm_leads l WHERE l.pipeline_stage_id=s.id AND l.organization_id=s.organization_id AND l.school_id=s.school_id AND l.status='OPEN'))
    ORDER BY s.position),'[]'::jsonb)
  FROM hon.crm_pipeline_stages s
  WHERE s.pipeline_id=selected_pipeline AND s.organization_id=hon.current_organization_id() AND s.school_id=hon.current_school_id()
$$;

-- ---------- P5: guards ----------
CREATE FUNCTION hon.guard_crm_lead_stage_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF (NEW.pipeline_id,NEW.pipeline_stage_id) IS DISTINCT FROM (OLD.pipeline_id,OLD.pipeline_stage_id) THEN
    IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='hon.move_crm_lead_stage(text,uuid,jsonb,text,uuid,uuid)'::regprocedure)
      OR NEW.pipeline_id IS DISTINCT FROM OLD.pipeline_id OR OLD.status<>'OPEN' OR NEW.status<>'OPEN' OR NEW.version<>OLD.version+1
      OR NOT (current_setting('app.hon_crm_stage_lead_id',true) IS NOT DISTINCT FROM OLD.id::text
        OR current_setting('app.hon_crm_stage_batch',true) IS NOT DISTINCT FROM OLD.pipeline_stage_id::text) THEN
      RAISE EXCEPTION 'FIXED_CRM_STAGE_MOVE_REQUIRED' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_lead_stage_update_guard BEFORE UPDATE ON hon.crm_leads FOR EACH ROW EXECUTE FUNCTION hon.guard_crm_lead_stage_update();

CREATE FUNCTION hon.guard_crm_pipeline_stage_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='hon.save_crm_pipeline_stages(text,uuid,jsonb,text,uuid,uuid)'::regprocedure)
    OR current_setting('app.hon_crm_stage_pipeline',true) IS DISTINCT FROM OLD.pipeline_id::text
    OR (NEW.id,NEW.organization_id,NEW.school_id,NEW.pipeline_id,NEW.terminal_status) IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.pipeline_id,OLD.terminal_status) THEN
    RAISE EXCEPTION 'FIXED_CRM_STAGE_SAVE_REQUIRED' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_pipeline_stage_update_guard BEFORE UPDATE ON hon.crm_pipeline_stages FOR EACH ROW EXECUTE FUNCTION hon.guard_crm_pipeline_stage_update();

-- ---------- P2: board read ----------
CREATE FUNCTION hon.read_crm_pipeline_board(subject text, selected_pipeline uuid, selected_status text) RETURNS jsonb
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
        AND a.status<>'CANCELLED' AND a.starts_at<clock_timestamp()))) card
    FROM hon.crm_leads l JOIN hon.people p ON p.id=l.primary_person_id AND p.organization_id=l.organization_id AND p.school_id=l.school_id
    WHERE l.organization_id=org AND l.school_id=school AND l.pipeline_id=chosen.id AND l.status=ANY(statuses)
    ORDER BY l.created_at DESC,l.id LIMIT 501) q WHERE ord<=500;
  RETURN jsonb_build_object('pipelines',pipelines,'pipeline',jsonb_build_object('id',chosen.id,'name',chosen.name,'version',chosen.version),
    'stages',hon.crm_board_stages_json(chosen.id),'totals',totals,'status',selected_status,'leads',leads,
    'truncated',(SELECT count(*) FROM hon.crm_leads l WHERE l.organization_id=org AND l.school_id=school AND l.pipeline_id=chosen.id AND l.status=ANY(statuses))>500,
    'limit',500);
END $$;

-- ---------- P3: move a lead ----------
CREATE FUNCTION hon.move_crm_lead_stage(subject text, selected_lead uuid, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; reserved boolean;
  prior hon.idempotency_records%ROWTYPE; l hon.crm_leads%ROWTYPE; target hon.crm_pipeline_stages%ROWTYPE; moved timestamptz; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR selected_lead IS NULL OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['expectedVersion','stageId']
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'stageId') IS DISTINCT FROM 'string' OR p->>'stageId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','crm.lead.stage.move','leadId',selected_lead,'input',p)::text,'UTF8')),'hex');
  actor:=hon.require_crm_board_actor(subject,'crm.lead.stage.move');
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  actor:=hon.lock_crm_board_actor(subject,'crm.lead.stage.move');
  IF NOT coalesce(reserved,false) THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    RETURN jsonb_build_object('receipt',prior.response_body,'replayed',true);
  END IF;
  SELECT * INTO l FROM hon.crm_leads x WHERE x.id=selected_lead AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CRM_LEAD_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  IF l.status<>'OPEN' OR l.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  SELECT * INTO target FROM hon.crm_pipeline_stages s WHERE s.id=(p->>'stageId')::uuid AND s.organization_id=org AND s.school_id=school
    AND s.pipeline_id=l.pipeline_id FOR SHARE;
  IF NOT FOUND OR target.terminal_status IS NOT NULL OR target.hidden_at IS NOT NULL OR target.id=l.pipeline_stage_id THEN
    RAISE EXCEPTION 'CRM_STAGE_NOT_ALLOWED' USING ERRCODE='22023'; END IF;
  moved:=clock_timestamp();
  PERFORM set_config('app.hon_crm_stage_lead_id',l.id::text,true);
  UPDATE hon.crm_leads SET pipeline_stage_id=target.id,version=version+1,updated_at=moved
    WHERE id=l.id AND organization_id=org AND school_id=school AND status='OPEN' AND version=l.version;
  IF NOT FOUND THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  PERFORM set_config('app.hon_crm_stage_lead_id','',true);
  result:=jsonb_build_object('organizationId',org,'schoolId',school,'leadId',l.id,'pipelineId',l.pipeline_id,'fromStageId',l.pipeline_stage_id,
    'stageId',target.id,'priorVersion',l.version,'version',l.version+1,'movedAt',hon.crm_board_ts(moved));
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
  VALUES(org,school,actor,'HUMAN_UI','crm.lead.stage.move','CRM_LEAD',l.id,jsonb_build_object('stageId',l.pipeline_stage_id,'version',l.version),result,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
  VALUES(org,school,'crm.lead.stage_moved',1,'CRM_LEAD',l.id,l.version+1,correlation,request,result);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  IF hon.require_crm_board_actor(subject,'crm.lead.stage.move') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CRM_BOARD_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- ---------- P4: save stages ----------
CREATE FUNCTION hon.crm_stage_name_ok(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_typeof(value)='string' AND length(value#>>'{}') BETWEEN 1 AND 60 AND btrim(value#>>'{}')=value#>>'{}'
    AND (value#>>'{}') !~ '[[:cntrl:]\u007F-\u009F​-‏‪-‮⁠-⁯﻿]'
$$;

CREATE FUNCTION hon.save_crm_pipeline_stages(subject text, selected_pipeline uuid, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; reserved boolean;
  prior hon.idempotency_records%ROWTYPE; pl hon.crm_pipelines%ROWTYPE; item jsonb; mv jsonb; i integer; n integer; sid uuid; tid uuid;
  existing uuid[]; given uuid[]; visible uuid[]:='{}'; hidden_now uuid[]:='{}'; needing uuid[]; move_from uuid[]:='{}';
  moved_count integer; moves_out jsonb:='[]'::jsonb; saved timestamptz; result jsonb; before jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR selected_pipeline IS NULL OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['expectedVersion','moves','stages']
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'stages') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'stages') NOT BETWEEN 1 AND 20
    OR jsonb_typeof(p->'moves') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'moves')>20 THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(p->'stages') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(item) k) IS DISTINCT FROM ARRAY['color','hidden','id','name']
      OR NOT (jsonb_typeof(item->'id')='null' OR (jsonb_typeof(item->'id')='string' AND item->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
      OR NOT hon.crm_stage_name_ok(item->'name') OR jsonb_typeof(item->'color') IS DISTINCT FROM 'string'
      OR item->>'color' NOT IN ('BLUE','SKY','CYAN','VIOLET','GREEN','RED','AMBER','SLATE') OR jsonb_typeof(item->'hidden') IS DISTINCT FROM 'boolean'
      OR ((item->>'hidden')::boolean AND jsonb_typeof(item->'id')='null') THEN
      RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  END LOOP;
  FOR mv IN SELECT * FROM jsonb_array_elements(p->'moves') LOOP
    IF jsonb_typeof(mv) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(mv) k) IS DISTINCT FROM ARRAY['fromStageId','toStageId']
      OR jsonb_typeof(mv->'fromStageId') IS DISTINCT FROM 'string' OR mv->>'fromStageId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR jsonb_typeof(mv->'toStageId') IS DISTINCT FROM 'string' OR mv->>'toStageId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  END LOOP;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','crm.pipeline.stages.save','pipelineId',selected_pipeline,'input',p)::text,'UTF8')),'hex');
  actor:=hon.require_crm_board_actor(subject,'crm.pipeline.manage');
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  actor:=hon.lock_crm_board_actor(subject,'crm.pipeline.manage');
  IF NOT coalesce(reserved,false) THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    RETURN jsonb_build_object('receipt',prior.response_body,'replayed',true);
  END IF;
  SELECT * INTO pl FROM hon.crm_pipelines x WHERE x.id=selected_pipeline AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CRM_PIPELINE_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  IF pl.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  -- The stage list is exact: every existing non-terminal stage once, new stages without an id, unique names (with Won/Lost).
  PERFORM 1 FROM hon.crm_pipeline_stages s WHERE s.pipeline_id=pl.id AND s.organization_id=org AND s.school_id=school FOR UPDATE;
  SELECT coalesce(array_agg(s.id ORDER BY s.id),'{}') INTO existing FROM hon.crm_pipeline_stages s
    WHERE s.pipeline_id=pl.id AND s.organization_id=org AND s.school_id=school AND s.terminal_status IS NULL;
  SELECT coalesce(array_agg((x->>'id')::uuid ORDER BY (x->>'id')::uuid),'{}') INTO given FROM jsonb_array_elements(p->'stages') x WHERE jsonb_typeof(x->'id')='string';
  IF given IS DISTINCT FROM existing THEN RAISE EXCEPTION 'CRM_STAGES_MISMATCH' USING ERRCODE='22023'; END IF;
  IF (SELECT count(DISTINCT lower(nm)) FROM (SELECT x->>'name' nm FROM jsonb_array_elements(p->'stages') x
        UNION ALL SELECT s.name FROM hon.crm_pipeline_stages s WHERE s.pipeline_id=pl.id AND s.organization_id=org AND s.school_id=school AND s.terminal_status IS NOT NULL) names)
     <> jsonb_array_length(p->'stages')+(SELECT count(*) FROM hon.crm_pipeline_stages s WHERE s.pipeline_id=pl.id AND s.organization_id=org AND s.school_id=school AND s.terminal_status IS NOT NULL) THEN
    RAISE EXCEPTION 'CRM_STAGE_NAME_TAKEN' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p->'stages') x WHERE NOT (x->>'hidden')::boolean) THEN
    RAISE EXCEPTION 'CRM_STAGE_VISIBLE_REQUIRED' USING ERRCODE='22023'; END IF;
  SELECT coalesce(array_agg((x->>'id')::uuid),'{}') INTO visible FROM jsonb_array_elements(p->'stages') x WHERE jsonb_typeof(x->'id')='string' AND NOT (x->>'hidden')::boolean;
  SELECT coalesce(array_agg((x->>'id')::uuid),'{}') INTO hidden_now FROM jsonb_array_elements(p->'stages') x WHERE (x->>'hidden')::boolean;
  -- Every hidden stage that still holds open leads needs exactly one move to a visible existing stage; no other moves.
  SELECT coalesce(array_agg(s ORDER BY s),'{}') INTO needing FROM unnest(hidden_now) s
    WHERE EXISTS (SELECT 1 FROM hon.crm_leads l WHERE l.pipeline_stage_id=s AND l.organization_id=org AND l.school_id=school AND l.status='OPEN');
  SELECT coalesce(array_agg((m->>'fromStageId')::uuid ORDER BY (m->>'fromStageId')::uuid),'{}') INTO move_from FROM jsonb_array_elements(p->'moves') m;
  IF move_from IS DISTINCT FROM needing OR EXISTS (SELECT 1 FROM jsonb_array_elements(p->'moves') m WHERE NOT ((m->>'toStageId')::uuid = ANY(visible))) THEN
    RAISE EXCEPTION 'CRM_STAGE_MOVE_REQUIRED' USING ERRCODE='22023'; END IF;
  before:=hon.crm_board_stages_json(pl.id);
  saved:=clock_timestamp();
  PERFORM set_config('app.hon_crm_stage_pipeline',pl.id::text,true);
  -- Two-step renumbering keeps (pipeline_id, position) unique throughout.
  UPDATE hon.crm_pipeline_stages SET position=-position-1000 WHERE pipeline_id=pl.id AND organization_id=org AND school_id=school;
  n:=0;
  FOR item IN SELECT * FROM jsonb_array_elements(p->'stages') LOOP
    n:=n+1;
    IF jsonb_typeof(item->'id')='string' THEN
      UPDATE hon.crm_pipeline_stages SET name=item->>'name',color=item->>'color',position=n,
        hidden_at=CASE WHEN (item->>'hidden')::boolean THEN coalesce(hidden_at,saved) END
        WHERE id=(item->>'id')::uuid AND pipeline_id=pl.id AND organization_id=org AND school_id=school;
    ELSE
      INSERT INTO hon.crm_pipeline_stages(organization_id,school_id,pipeline_id,name,position,color) VALUES(org,school,pl.id,item->>'name',n,item->>'color');
    END IF;
  END LOOP;
  FOR sid IN SELECT s.id FROM hon.crm_pipeline_stages s WHERE s.pipeline_id=pl.id AND s.organization_id=org AND s.school_id=school AND s.terminal_status IS NOT NULL ORDER BY s.position DESC LOOP
    n:=n+1;
    UPDATE hon.crm_pipeline_stages SET position=n WHERE id=sid;
  END LOOP;
  PERFORM set_config('app.hon_crm_stage_pipeline','',true);
  FOR mv IN SELECT * FROM jsonb_array_elements(p->'moves') LOOP
    sid:=(mv->>'fromStageId')::uuid; tid:=(mv->>'toStageId')::uuid;
    PERFORM set_config('app.hon_crm_stage_batch',sid::text,true);
    UPDATE hon.crm_leads SET pipeline_stage_id=tid,version=version+1,updated_at=saved
      WHERE pipeline_stage_id=sid AND pipeline_id=pl.id AND organization_id=org AND school_id=school AND status='OPEN';
    GET DIAGNOSTICS moved_count=ROW_COUNT;
    PERFORM set_config('app.hon_crm_stage_batch','',true);
    moves_out:=moves_out||jsonb_build_object('fromStageId',sid,'toStageId',tid,'count',moved_count);
  END LOOP;
  UPDATE hon.crm_pipelines SET version=version+1 WHERE id=pl.id AND organization_id=org AND school_id=school;
  result:=jsonb_build_object('organizationId',org,'schoolId',school,'pipelineId',pl.id,'priorVersion',pl.version,'version',pl.version+1,
    'stages',hon.crm_board_stages_json(pl.id),'moves',moves_out,'savedAt',hon.crm_board_ts(saved));
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
  VALUES(org,school,actor,'HUMAN_UI','crm.pipeline.stages.save','CRM_PIPELINE',pl.id,jsonb_build_object('version',pl.version,'stages',before),result,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
  VALUES(org,school,'crm.pipeline.stages_saved',1,'CRM_PIPELINE',pl.id,pl.version+1,correlation,request,result);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  IF hon.require_crm_board_actor(subject,'crm.pipeline.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CRM_BOARD_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- ---------- ACL: three runtime entry points; helpers and guards are migration-owner only ----------
DO $$ DECLARE r text; f text;
  entry text[]:=ARRAY['hon.read_crm_pipeline_board(text,uuid,text)','hon.move_crm_lead_stage(text,uuid,jsonb,text,uuid,uuid)',
    'hon.save_crm_pipeline_stages(text,uuid,jsonb,text,uuid,uuid)'];
  helpers text[]:=ARRAY['hon.crm_board_ts(timestamptz)','hon.require_crm_board_actor(text,text)','hon.lock_crm_board_actor(text,text)',
    'hon.crm_board_stages_json(uuid)','hon.guard_crm_lead_stage_update()','hon.guard_crm_pipeline_stage_update()','hon.crm_stage_name_ok(jsonb)'];
BEGIN
  FOREACH f IN ARRAY helpers||entry LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
END $$;
COMMIT;
