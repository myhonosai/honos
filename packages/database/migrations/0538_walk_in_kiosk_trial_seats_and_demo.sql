BEGIN;

-- Walk-in kiosk pre-pilot fixes (0538, assigned by the coordinator 2026-11-19), from the #495 (0537) review P3s:
--   P1  Seats: every booking path counts kiosk trial visitors as taken seats (0537 T3, hon.walkin_session_taken), so a
--       class is never overbooked between the kiosk and staff, ClassPass, owner-launch or parent bookings. Each path
--       already holds its class session FOR UPDATE (the kiosk submit takes the same lock), so the count is decided once.
--       The staff booking API reads it through one new runtime entry point, hon.read_class_session_seats_taken, that
--       answers only for a session of the current school (null otherwise) and writes nothing.
--   P2  Demo data: a trial offer can never name a demo program, the settings read and tablet never list demo programs or
--       demo class sessions, and a demo session is never open for a trial, so no kiosk visit can block demo removal.
-- No new table, column, permission, message, money or AI. Nothing here deploys or turns anything on.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Walk-in kiosk pre-pilot fixes require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Walk-in kiosk pre-pilot fixes require a restricted runtime';
  END IF;
  IF to_regprocedure('hon.walkin_session_taken(uuid)') IS NULL OR to_regprocedure('hon.demo_data_is_demo(text,uuid)') IS NULL
    OR to_regprocedure('hon.parent_class_booking_seats(uuid)') IS NULL
    OR to_regprocedure('hon.command_classpass(text,text,uuid,jsonb,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.book_owner_launch_first_class(text,jsonb,text,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Walk-in kiosk pre-pilot fixes require 0117, 0137, 0329, 0459 and 0537';
  END IF;
  IF EXISTS(SELECT 1 FROM hon.walkin_kiosk_settings s, jsonb_array_elements(s.offers) o, jsonb_array_elements_text(o->'programIds') x
      WHERE o ? 'programIds' AND hon.demo_data_is_demo('programs',x::uuid)) THEN
    RAISE EXCEPTION 'A walk-in trial offer names a demo program; remove it from the kiosk settings first';
  END IF;
END $$;

-- P1: the staff booking API's seat count for one class session of the current school (bookings plus kiosk trial
-- visitors). Null for any other session. Called after hon.lock_class_booking_session, in the same transaction.
CREATE FUNCTION hon.read_class_session_seats_taken(p_session uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT hon.walkin_session_taken(s.id) FROM hon.class_sessions s
  WHERE s.id=p_session AND s.organization_id=hon.current_organization_id() AND s.school_id=hon.current_school_id()
$$;

-- P2: settings input (0537) refuses demo programs on a trial offer.
CREATE OR REPLACE FUNCTION hon.walkin_settings_input(p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE o jsonb; keys text[]:=ARRAY['expectedVersion','enabled','waiver','emergencyRequired','pipelineId','pipelineStageId','offers','thankYou'];
  okeys text[]:=ARRAY['key','kind','name','description','priceMinor'];
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>40000 OR NOT p ?& keys OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k<>ALL(keys))
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->>'expectedVersion') !~ '^(0|[1-9][0-9]{0,8})$'
    OR jsonb_typeof(p->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p->'emergencyRequired') IS DISTINCT FROM 'boolean'
    OR NOT hon.walkin_text_ok(p->'waiver',1,8000,true) OR NOT hon.walkin_text_ok(p->'thankYou',0,300,false)
    OR jsonb_typeof(p->'pipelineId') IS DISTINCT FROM 'string' OR (p->>'pipelineId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'pipelineStageId') IS DISTINCT FROM 'string' OR (p->>'pipelineStageId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'offers') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'offers') NOT BETWEEN 1 AND 6 THEN RETURN NULL; END IF;
  FOR o IN SELECT e FROM jsonb_array_elements(p->'offers') e LOOP
    IF jsonb_typeof(o) IS DISTINCT FROM 'object' OR NOT o ?& okeys OR EXISTS(SELECT 1 FROM jsonb_object_keys(o) k WHERE k<>ALL(okeys||'programIds'::text))
      -- T1: a trial offer may name 1-10 of this school's programs; the visitor then picks one of their next classes.
      OR (o ? 'programIds' AND (o->>'kind' IS DISTINCT FROM 'TRIAL' OR jsonb_typeof(o->'programIds') IS DISTINCT FROM 'array'
        OR jsonb_array_length(o->'programIds') NOT BETWEEN 1 AND 10
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(o->'programIds') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string'
          OR (x#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
        OR (SELECT count(DISTINCT x#>>'{}') FROM jsonb_array_elements(o->'programIds') x)<>jsonb_array_length(o->'programIds')
        OR (SELECT count(*) FROM hon.programs g WHERE g.id IN (SELECT (x#>>'{}')::uuid FROM jsonb_array_elements(o->'programIds') x)
          AND g.organization_id=hon.current_organization_id() AND g.school_id=hon.current_school_id() AND g.status<>'CANCELLED'
          AND NOT hon.demo_data_is_demo('programs',g.id))<>jsonb_array_length(o->'programIds')))
      OR jsonb_typeof(o->'key') IS DISTINCT FROM 'string' OR (o->>'key') !~ '^[a-z0-9][a-z0-9-]{0,23}$'
      OR jsonb_typeof(o->'kind') IS DISTINCT FROM 'string' OR (o->>'kind') NOT IN ('DAY_PASS','TRIAL')
      OR NOT hon.walkin_text_ok(o->'name',1,60,false) OR NOT hon.walkin_text_ok(o->'description',0,200,false)
      OR jsonb_typeof(o->'priceMinor') IS DISTINCT FROM 'number' OR (o->>'priceMinor') !~ '^(0|[1-9][0-9]{0,6})$' OR (o->>'priceMinor')::integer>1000000 THEN
      RETURN NULL; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT e->>'key') FROM jsonb_array_elements(p->'offers') e)<>jsonb_array_length(p->'offers') THEN RETURN NULL; END IF;
  RETURN p;
END $$;

-- P2: the staff settings read (0537) leaves demo programs out.
CREATE OR REPLACE FUNCTION hon.read_walkin_kiosk_settings(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; x hon.walkin_kiosk_settings%ROWTYPE; result jsonb;
BEGIN
  actor:=hon.require_walkin_actor(subject,'walkin_kiosk.manage');
  SELECT * INTO x FROM hon.walkin_kiosk_settings s WHERE s.organization_id=org AND s.school_id=school;
  result:=jsonb_build_object('settings',CASE WHEN FOUND THEN hon.walkin_settings_json(x) ELSE NULL END,
    'pipelines',coalesce((SELECT jsonb_agg(jsonb_build_object('pipelineId',pl.id,'name',pl.name,
      'stages',coalesce((SELECT jsonb_agg(jsonb_build_object('stageId',st.id,'name',st.name) ORDER BY st.position,st.id) FROM hon.crm_pipeline_stages st
        WHERE st.pipeline_id=pl.id AND st.organization_id=org AND st.school_id=school),'[]'::jsonb)) ORDER BY pl.created_at,pl.id)
      FROM (SELECT * FROM hon.crm_pipelines y WHERE y.organization_id=org AND y.school_id=school ORDER BY y.created_at,y.id LIMIT 20) pl),'[]'::jsonb),
    -- T1: the programs a trial offer can name.
    'programs',coalesce((SELECT jsonb_agg(jsonb_build_object('programId',g.id,'name',g.name) ORDER BY g.name,g.id)
      FROM (SELECT * FROM hon.programs y WHERE y.organization_id=org AND y.school_id=school AND y.status<>'CANCELLED'
        AND NOT hon.demo_data_is_demo('programs',y.id) ORDER BY y.name,y.id LIMIT 50) g),'[]'::jsonb));
  IF hon.require_walkin_actor(subject,'walkin_kiosk.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'WALKIN_KIOSK_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- P2: a demo program or demo class session is never open for a kiosk trial.
CREATE OR REPLACE FUNCTION hon.walkin_trial_session_open(s hon.class_sessions,program_ids jsonb,seats integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT s.id IS NOT NULL AND s.status='SCHEDULED' AND s.starts_at>clock_timestamp() AND s.starts_at<=clock_timestamp()+interval '14 days'
    AND seats>=1 AND jsonb_typeof(program_ids)='array' AND program_ids ? s.program_id::text
    AND EXISTS(SELECT 1 FROM hon.programs g WHERE g.id=s.program_id AND g.organization_id=s.organization_id AND g.school_id=s.school_id AND g.status<>'CANCELLED'
      AND NOT hon.demo_data_is_demo('programs',g.id))
    AND NOT hon.demo_data_is_demo('class_sessions',s.id)
    AND s.capacity-hon.walkin_session_taken(s.id)>=seats
$$;

-- P2: the tablet's classes (0537) leave out demo programs and demo class sessions.
CREATE OR REPLACE FUNCTION hon.walkin_trial_classes(org uuid,school uuid,program_ids jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('sessionId',c.id,'name',c.name,'startsAt',hon.walkin_utc(c.starts_at),'endsAt',hon.walkin_utc(c.ends_at),
      'spotsOpen',greatest(c.capacity-hon.walkin_session_taken(c.id),0)) ORDER BY c.starts_at,c.id),'[]'::jsonb)
  FROM (SELECT s.* FROM hon.class_sessions s JOIN hon.programs g ON g.id=s.program_id AND g.organization_id=s.organization_id AND g.school_id=s.school_id
    WHERE s.organization_id=org AND s.school_id=school AND s.status='SCHEDULED' AND g.status<>'CANCELLED'
      AND NOT hon.demo_data_is_demo('programs',g.id) AND NOT hon.demo_data_is_demo('class_sessions',s.id)
      AND s.starts_at>clock_timestamp() AND s.starts_at<=clock_timestamp()+interval '14 days'
      AND jsonb_typeof(program_ids)='array' AND program_ids ? s.program_id::text
    ORDER BY s.starts_at,s.id LIMIT 20) c
$$;

-- P1: parent booking (0329) seats include kiosk trial visitors.
CREATE OR REPLACE FUNCTION hon.parent_class_booking_seats(session uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  -- 0538: bookings that hold a seat plus kiosk trial visitors (0537 T3).
  SELECT hon.walkin_session_taken(session);
$$;

-- P1: ClassPass admission (0117, unchanged otherwise) counts kiosk trial visitors as taken seats.
CREATE OR REPLACE FUNCTION hon.command_classpass(p_subject text,p_action text,p_target uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; permission text; keys text[]; expected integer; reason text;
 product hon.classpass_products%ROWTYPE; pass hon.classpass_passes%ROWTYPE; session hon.class_sessions%ROWTYPE; program hon.programs%ROWTYPE; student hon.student_profiles%ROWTYPE;
 booking hon.class_bookings%ROWTYPE; debit hon.classpass_ledger%ROWTYPE; previous hon.idempotency_records%ROWTYPE;
 reservation uuid; fp text; result jsonb; prior jsonb; entity uuid; entity_type text; decision text; seats integer; months integer; instant timestamptz;
BEGIN
 permission:=CASE WHEN p_action IN('CONFIGURE_PRODUCT','RETIRE_PRODUCT','ISSUE') THEN 'classpass.manage' WHEN p_action='ADMIT' THEN 'classpass.admit' WHEN p_action IN('REVERSE_ISSUANCE','REVERSE_REDEMPTION') THEN 'classpass.reverse' END;
 keys:=CASE p_action WHEN 'CONFIGURE_PRODUCT' THEN ARRAY['expectedVersion','programId','name','allowedUses','validityDays','reason'] WHEN 'RETIRE_PRODUCT' THEN ARRAY['expectedVersion','reason']
  WHEN 'ISSUE' THEN ARRAY['expectedVersion','studentProfileId','issuanceKind','reason'] WHEN 'ADMIT' THEN ARRAY['expectedVersion','passId'] WHEN 'REVERSE_ISSUANCE' THEN ARRAY['expectedVersion','reason'] WHEN 'REVERSE_REDEMPTION' THEN ARRAY['expectedVersion','passId','reason'] END;
 IF permission IS NULL OR p_target IS NULL OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_input))<>cardinality(keys) OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE NOT k=ANY(keys))
  OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[0-9]{1,10}$' OR (p_input->>'expectedVersion')::numeric>2147483646
  OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]' OR p_key ~ U&'[\0080-\009f]'
  OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) OR p_correlation::text IS DISTINCT FROM current_setting('app.hon_correlation_id',true) THEN
  RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 expected:=(p_input->>'expectedVersion')::integer;
 IF p_action<>'CONFIGURE_PRODUCT' AND expected<1 THEN RAISE EXCEPTION 'VERSION_REQUIRED' USING ERRCODE='40001'; END IF;
 IF p_action<>'ADMIT' THEN
  reason:=p_input->>'reason';
  IF jsonb_typeof(p_input->'reason') IS DISTINCT FROM 'string' OR length(reason) NOT BETWEEN 1 AND 500 OR btrim(reason)<>reason OR reason ~ '[[:cntrl:]]' OR reason ~ U&'[\0080-\009f]' THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE='22023'; END IF;
 END IF;
 IF p_action IN('ADMIT','REVERSE_REDEMPTION','ISSUE','CONFIGURE_PRODUCT') THEN
  IF jsonb_typeof(p_input->CASE WHEN p_action='ISSUE' THEN 'studentProfileId' WHEN p_action='CONFIGURE_PRODUCT' THEN 'programId' ELSE 'passId' END) IS DISTINCT FROM 'string'
   OR (p_input->>CASE WHEN p_action='ISSUE' THEN 'studentProfileId' WHEN p_action='CONFIGURE_PRODUCT' THEN 'programId' ELSE 'passId' END) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END IF;
 IF p_action='ISSUE' AND (p_input->>'issuanceKind') IS DISTINCT FROM 'MANUAL_NONFINANCIAL' THEN RAISE EXCEPTION 'NONFINANCIAL_ONLY' USING ERRCODE='22023'; END IF;
 IF p_action='CONFIGURE_PRODUCT' AND (jsonb_typeof(p_input->'name') IS DISTINCT FROM 'string' OR length(p_input->>'name') NOT BETWEEN 1 AND 100 OR btrim(p_input->>'name')<>p_input->>'name' OR (p_input->>'name') ~ '[[:cntrl:]]'
  OR jsonb_typeof(p_input->'allowedUses') IS DISTINCT FROM 'number' OR (p_input->>'allowedUses') !~ '^[0-9]{1,4}$' OR (p_input->>'allowedUses')::integer NOT BETWEEN 1 AND 1000
  OR jsonb_typeof(p_input->'validityDays') IS DISTINCT FROM 'number' OR (p_input->>'validityDays') !~ '^[0-9]{1,3}$' OR (p_input->>'validityDays')::integer NOT BETWEEN 1 AND 365) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 actor:=hon.lock_classpass_actor(p_subject,permission);
 fp:=encode(sha256(convert_to(jsonb_build_object('command','classpass.v1','action',p_action,'target',p_target,'input',p_input)::text,'UTF8')),'hex');
 -- Global canonical idempotency namespace, followed by session -> pass -> booking.
 INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at) VALUES(org,school,actor,p_key,fp,'IN_PROGRESS',now()+interval '24 hours')
 ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING id INTO reservation;
 IF reservation IS NULL THEN
  SELECT * INTO previous FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key FOR UPDATE;
  actor:=hon.lock_classpass_actor(p_subject,permission);
  IF previous.request_fingerprint IS DISTINCT FROM fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='40001'; END IF;
  IF previous.status='COMPLETED' AND previous.response_body IS NOT NULL THEN RETURN previous.response_body || jsonb_build_object('replayed',true); END IF;
  RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001';
 END IF;
 PERFORM set_config('app.hon_classpass_write','on',true);
 IF p_action IN('CONFIGURE_PRODUCT','RETIRE_PRODUCT','ISSUE') THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('classpass.product:'||p_target::text,0));
  SELECT * INTO product FROM hon.classpass_products WHERE id=p_target AND organization_id=org AND school_id=school FOR UPDATE;
  actor:=hon.lock_classpass_actor(p_subject,permission);
  IF p_action='CONFIGURE_PRODUCT' THEN
   IF (product.id IS NULL AND expected<>0) OR (product.id IS NOT NULL AND product.version<>expected) THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
   IF product.status='RETIRED' THEN RAISE EXCEPTION 'PRODUCT_RETIRED' USING ERRCODE='22023'; END IF;
   SELECT * INTO program FROM hon.programs WHERE id=(p_input->>'programId')::uuid AND organization_id=org AND school_id=school FOR SHARE;
   IF program.id IS NULL OR program.status<>'SCHEDULED' THEN RAISE EXCEPTION 'PROGRAM_NOT_ELIGIBLE' USING ERRCODE='22023'; END IF;
   prior:=CASE WHEN product.id IS NOT NULL THEN to_jsonb(product) END;
   IF product.id IS NULL THEN
    INSERT INTO hon.classpass_products(id,organization_id,school_id,program_id,name,allowed_uses,validity_days,status) VALUES(p_target,org,school,program.id,p_input->>'name',(p_input->>'allowedUses')::integer,(p_input->>'validityDays')::integer,'ACTIVE') RETURNING * INTO product;
   ELSE
    UPDATE hon.classpass_products SET program_id=program.id,name=p_input->>'name',allowed_uses=(p_input->>'allowedUses')::integer,validity_days=(p_input->>'validityDays')::integer,version=version+1,updated_at=now() WHERE id=product.id RETURNING * INTO product;
   END IF;
   entity:=product.id; entity_type:='CLASSPASS_PRODUCT'; result:=jsonb_build_object('id',product.id,'programId',product.program_id,'name',product.name,'allowedUses',product.allowed_uses,'validityDays',product.validity_days,'allowedBookingPolicy',product.allowed_booking_policy,'status',product.status,'version',product.version);
  ELSE
   IF product.id IS NULL THEN RAISE EXCEPTION 'CLASSPASS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
   IF product.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
   IF product.status<>'ACTIVE' THEN RAISE EXCEPTION 'PRODUCT_RETIRED' USING ERRCODE='22023'; END IF;
   IF p_action='RETIRE_PRODUCT' THEN
    prior:=to_jsonb(product); UPDATE hon.classpass_products SET status='RETIRED',version=version+1,updated_at=now() WHERE id=product.id RETURNING * INTO product;
    entity:=product.id; entity_type:='CLASSPASS_PRODUCT'; result:=jsonb_build_object('id',product.id,'programId',product.program_id,'name',product.name,'allowedUses',product.allowed_uses,'validityDays',product.validity_days,'allowedBookingPolicy',product.allowed_booking_policy,'status',product.status,'version',product.version);
   ELSE
    SELECT * INTO program FROM hon.programs WHERE id=product.program_id AND organization_id=org AND school_id=school FOR SHARE;
    SELECT * INTO student FROM hon.student_profiles WHERE id=(p_input->>'studentProfileId')::uuid AND organization_id=org AND school_id=school FOR SHARE;
    IF program.id IS NULL OR program.status<>'SCHEDULED' OR student.id IS NULL OR student.status<>'ACTIVE' THEN RAISE EXCEPTION 'ISSUANCE_NOT_ELIGIBLE' USING ERRCODE='22023'; END IF;
    actor:=hon.lock_classpass_actor(p_subject,permission); instant:=clock_timestamp();
    INSERT INTO hon.classpass_passes(organization_id,school_id,product_id,student_profile_id,program_id,issuance_kind,product_version,product_name,allowed_uses,validity_days,allowed_booking_policy,program_version,program_name,program_status,minimum_age_months,maximum_age_months,issued_at,expires_at,issued_by_principal_id,remaining_uses,status)
    VALUES(org,school,product.id,student.id,program.id,'MANUAL_NONFINANCIAL',product.version,product.name,product.allowed_uses,product.validity_days,product.allowed_booking_policy,program.version,program.name,program.status::text,program.minimum_age_months,program.maximum_age_months,instant,instant+product.validity_days*interval '24 hours',actor,product.allowed_uses,'ACTIVE') RETURNING * INTO pass;
    INSERT INTO hon.classpass_ledger(organization_id,school_id,pass_id,kind,use_delta,pass_version,reason,actor_principal_id,request_id) VALUES(org,school,pass.id,'ISSUANCE',pass.allowed_uses,1,reason,actor,p_request);
    entity:=pass.id; entity_type:='CLASSPASS_PASS'; result:=jsonb_build_object('id',pass.id,'productId',pass.product_id,'studentProfileId',pass.student_profile_id,'programId',pass.program_id,'issuanceKind',pass.issuance_kind,'allowedUses',pass.allowed_uses,'remainingUses',pass.remaining_uses,'expiresAt',pass.expires_at,'status',pass.status,'version',pass.version);
   END IF;
  END IF;
 ELSE
  IF p_action='ADMIT' THEN
   SELECT * INTO session FROM hon.class_sessions WHERE id=p_target AND organization_id=org AND school_id=school FOR UPDATE;
  ELSIF p_action='REVERSE_REDEMPTION' THEN
   -- Only a nonlocking exact lookup is needed to derive the session lock first.
   SELECT s.* INTO session FROM hon.class_sessions s JOIN hon.class_bookings b ON b.class_session_id=s.id AND b.organization_id=s.organization_id AND b.school_id=s.school_id
   WHERE b.id=p_target AND b.organization_id=org AND b.school_id=school AND b.booking_kind='CLASS_PASS';
   IF session.id IS NOT NULL THEN SELECT * INTO session FROM hon.class_sessions WHERE id=session.id AND organization_id=org AND school_id=school FOR UPDATE; END IF;
  END IF;
  IF p_action<>'REVERSE_ISSUANCE' AND session.id IS NULL THEN RAISE EXCEPTION 'CLASSPASS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO pass FROM hon.classpass_passes WHERE id=CASE WHEN p_action='REVERSE_ISSUANCE' THEN p_target ELSE (p_input->>'passId')::uuid END AND organization_id=org AND school_id=school FOR UPDATE;
  actor:=hon.lock_classpass_actor(p_subject,permission);
  IF pass.id IS NULL THEN RAISE EXCEPTION 'CLASSPASS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF pass.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF pass.issuance_kind<>'MANUAL_NONFINANCIAL' OR pass.status='REVERSED' OR pass.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PASS_NOT_REDEEMABLE' USING ERRCODE='22023'; END IF;
  prior:=jsonb_build_object('passId',pass.id,'remainingUses',pass.remaining_uses,'status',pass.status,'version',pass.version);
  entity:=pass.id; entity_type:='CLASSPASS_PASS';
  IF p_action='REVERSE_ISSUANCE' THEN
   IF pass.status<>'ACTIVE' OR pass.remaining_uses<>pass.allowed_uses OR EXISTS(SELECT 1 FROM hon.classpass_ledger WHERE pass_id=pass.id AND kind<>'ISSUANCE')
    OR EXISTS(SELECT 1 FROM hon.class_bookings WHERE classpass_id=pass.id AND status<>'CANCELLED') THEN RAISE EXCEPTION 'ISSUANCE_REVERSAL_NOT_ALLOWED' USING ERRCODE='22023'; END IF;
   SELECT * INTO debit FROM hon.classpass_ledger WHERE pass_id=pass.id AND kind='ISSUANCE';
   IF debit.id IS NULL OR debit.use_delta<>pass.allowed_uses THEN RAISE EXCEPTION 'PASS_LEDGER_AMBIGUOUS' USING ERRCODE='22023'; END IF;
   UPDATE hon.classpass_passes SET status='REVERSED',remaining_uses=0,version=version+1,updated_at=now() WHERE id=pass.id RETURNING * INTO pass;
   INSERT INTO hon.classpass_ledger(organization_id,school_id,pass_id,kind,use_delta,reverses_ledger_id,pass_version,reason,actor_principal_id,request_id) VALUES(org,school,pass.id,'ISSUANCE_REVERSAL',-pass.allowed_uses,debit.id,pass.version,reason,actor,p_request);
   decision:='ISSUANCE_REVERSED';
  ELSE
   SELECT * INTO booking FROM hon.class_bookings WHERE organization_id=org AND school_id=school AND class_session_id=session.id AND student_profile_id=pass.student_profile_id FOR UPDATE;
   SELECT * INTO program FROM hon.programs WHERE id=session.program_id AND organization_id=org AND school_id=school FOR SHARE;
   SELECT * INTO student FROM hon.student_profiles WHERE id=pass.student_profile_id AND organization_id=org AND school_id=school FOR SHARE;
   actor:=hon.lock_classpass_actor(p_subject,permission); instant:=clock_timestamp();
   IF pass.expires_at<=instant OR session.status<>'SCHEDULED' OR session.booking_policy<>'WALK_IN' OR session.program_id<>pass.program_id OR program.id IS NULL OR program.status<>'SCHEDULED' OR student.id IS NULL OR student.status<>'ACTIVE' THEN RAISE EXCEPTION 'ADMISSION_NOT_ELIGIBLE' USING ERRCODE='22023'; END IF;
   IF booking.id IS NOT NULL AND (booking.booking_kind<>'CLASS_PASS' OR booking.classpass_id<>pass.id) THEN RAISE EXCEPTION 'BOOKING_ALREADY_EXISTS' USING ERRCODE='40001'; END IF;
   SELECT * INTO debit FROM hon.classpass_ledger WHERE pass_id=pass.id AND class_booking_id=booking.id AND kind='REDEMPTION';
   IF p_action='REVERSE_REDEMPTION' THEN
    IF booking.id IS DISTINCT FROM p_target OR booking.status<>'BOOKED' OR instant>=session.starts_at
     OR EXISTS(SELECT 1 FROM hon.attendance_records WHERE organization_id=org AND school_id=school AND class_session_id=session.id AND student_profile_id=pass.student_profile_id)
     OR debit.id IS NULL OR EXISTS(SELECT 1 FROM hon.classpass_ledger WHERE reverses_ledger_id=debit.id) OR pass.remaining_uses>=pass.allowed_uses THEN RAISE EXCEPTION 'REDEMPTION_REVERSAL_NOT_ALLOWED' USING ERRCODE='22023'; END IF;
    UPDATE hon.class_bookings SET status='CANCELLED',cancelled_at=instant,version=version+1,updated_at=now() WHERE id=booking.id RETURNING * INTO booking;
    UPDATE hon.classpass_passes SET status='ACTIVE',remaining_uses=remaining_uses+1,version=version+1,updated_at=now() WHERE id=pass.id RETURNING * INTO pass;
    INSERT INTO hon.classpass_ledger(organization_id,school_id,pass_id,kind,use_delta,class_booking_id,reverses_ledger_id,pass_version,reason,actor_principal_id,request_id) VALUES(org,school,pass.id,'REDEMPTION_REVERSAL',1,booking.id,debit.id,pass.version,reason,actor,p_request);
    decision:='REDEMPTION_REVERSED';
   ELSE
    IF instant<session.starts_at-interval '2 hours' OR instant>=session.ends_at OR pass.expires_at<=session.starts_at THEN RAISE EXCEPTION 'ADMISSION_WINDOW_CLOSED' USING ERRCODE='22023'; END IF;
    IF program.minimum_age_months IS NOT NULL OR program.maximum_age_months IS NOT NULL OR pass.minimum_age_months IS NOT NULL OR pass.maximum_age_months IS NOT NULL THEN
     IF student.birth_date IS NULL OR student.birth_date>session.starts_at::date THEN RAISE EXCEPTION 'AGE_EVIDENCE_REQUIRED' USING ERRCODE='22023'; END IF;
     months:=extract(year FROM age(session.starts_at::date,student.birth_date))::integer*12+extract(month FROM age(session.starts_at::date,student.birth_date))::integer;
     IF months<greatest(coalesce(program.minimum_age_months,0),coalesce(pass.minimum_age_months,0)) OR months>least(coalesce(program.maximum_age_months,2147483647),coalesce(pass.maximum_age_months,2147483647)) THEN RAISE EXCEPTION 'PROGRAM_NOT_ELIGIBLE' USING ERRCODE='22023'; END IF;
    END IF;
    IF booking.id IS NOT NULL AND booking.status='BOOKED' THEN
     IF debit.id IS NULL OR EXISTS(SELECT 1 FROM hon.classpass_ledger WHERE reverses_ledger_id=debit.id) THEN RAISE EXCEPTION 'PASS_LEDGER_AMBIGUOUS' USING ERRCODE='22023'; END IF;
     decision:='ADMITTED_REDEEMED';
    ELSE
     IF pass.status<>'ACTIVE' OR pass.remaining_uses<1 OR (booking.id IS NOT NULL AND booking.status<>'WAITLISTED') OR debit.id IS NOT NULL THEN RAISE EXCEPTION 'PASS_NOT_REDEEMABLE' USING ERRCODE='22023'; END IF;
     seats:=hon.walkin_session_taken(session.id); -- 0538: bookings plus kiosk trial visitors
     IF booking.id IS NULL THEN
      INSERT INTO hon.class_bookings(organization_id,school_id,class_session_id,student_profile_id,booking_kind,classpass_id,status,source) VALUES(org,school,session.id,pass.student_profile_id,'CLASS_PASS',pass.id,CASE WHEN seats<session.capacity THEN 'BOOKED'::hon.class_booking_status ELSE 'WAITLISTED'::hon.class_booking_status END,'STAFF') RETURNING * INTO booking;
     ELSIF seats<session.capacity THEN
      UPDATE hon.class_bookings SET status='BOOKED',version=version+1,updated_at=now() WHERE id=booking.id RETURNING * INTO booking;
     END IF;
     IF booking.status='BOOKED' THEN
      UPDATE hon.classpass_passes SET remaining_uses=remaining_uses-1,status=CASE WHEN remaining_uses=1 THEN 'EXHAUSTED' ELSE 'ACTIVE' END,version=version+1,updated_at=now() WHERE id=pass.id RETURNING * INTO pass;
      INSERT INTO hon.classpass_ledger(organization_id,school_id,pass_id,kind,use_delta,class_booking_id,pass_version,actor_principal_id,request_id) VALUES(org,school,pass.id,'REDEMPTION',-1,booking.id,pass.version,actor,p_request);
      decision:='ADMITTED_REDEEMED';
     ELSE decision:='WAITLISTED_NOT_REDEEMED'; END IF;
    END IF;
   END IF;
  END IF;
  result:=jsonb_build_object('id',pass.id,'passId',pass.id,'studentProfileId',pass.student_profile_id,'remainingUses',pass.remaining_uses,'status',pass.status,'version',pass.version,'decision',decision,
   'booking',CASE WHEN booking.id IS NOT NULL THEN jsonb_build_object('id',booking.id,'classSessionId',booking.class_session_id,'passId',booking.classpass_id,'bookingKind',booking.booking_kind,'status',booking.status,'version',booking.version) ELSE NULL END);
 END IF;
 actor:=hon.lock_classpass_actor(p_subject,permission);
 result:=result || jsonb_build_object('paymentProviderOutcome','UNAVAILABLE','attendanceOutcome','NOT_RECORDED_BY_CLASSPASS','externalEffects','NONE');
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id) VALUES(org,school,actor,'HUMAN_UI','classpass.'||lower(p_action),entity_type,entity,prior,result,'SUCCEEDED',p_request,p_correlation);
 INSERT INTO hon.outbox_events(id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload) VALUES(gen_random_uuid(),org,school,'classpass.operational',1,entity_type,entity,(result->>'version')::integer,p_correlation,p_request,result);
 UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result WHERE id=reservation;
 PERFORM set_config('app.hon_classpass_write','',true);
 RETURN result || jsonb_build_object('replayed',false);
END $$;

-- P1: owner-launch first class booking (0137, unchanged otherwise) counts kiosk trial visitors as taken seats.
CREATE OR REPLACE FUNCTION hon.book_owner_launch_first_class(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE
 actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
 registration uuid; class_version integer; class_program uuid; class_status text; expected_class_version integer; expected_receipt_version integer;
 receipt record; locked record; prior record; existing hon.class_bookings%ROWTYPE; booking hon.class_bookings%ROWTYPE;
 seats integer; decision hon.class_booking_status; fp bytea; key_digest bytea; result jsonb; payload jsonb;
BEGIN
 actor:=hon.lock_owner_launch_actor(p_subject);
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
 OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN('registrationId','expectedReceiptVersion','expectedClassSessionVersion'))
 OR jsonb_typeof(p_input->'registrationId') IS DISTINCT FROM 'string'
 OR (p_input->>'registrationId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 OR jsonb_typeof(p_input->'expectedReceiptVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedReceiptVersion' !~ '^[1-9][0-9]{0,8}$'
 OR jsonb_typeof(p_input->'expectedClassSessionVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedClassSessionVersion' !~ '^[1-9][0-9]{0,8}$' THEN
  RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
 END IF;
 registration:=(p_input->>'registrationId')::uuid;
 expected_receipt_version:=(p_input->>'expectedReceiptVersion')::integer;
 expected_class_version:=(p_input->>'expectedClassSessionVersion')::integer;
 -- Existing registration receipts are immutable; version 1 is the only valid
 -- receipt version. Keep this explicit expected version so an eventual receipt
 -- evolution cannot be silently accepted by this command.
 IF expected_receipt_version<>1 THEN RAISE EXCEPTION 'OWNER_LAUNCH_RECEIPT_STALE' USING ERRCODE='40001'; END IF;

 -- The receipt is the sole selector and must be owned by this current live actor.
 -- Both receipt variants are checked independently, then linked back to current
 -- same-school profile, program-only enrollment and exact class/program context.
 SELECT r.id AS registration_id,r.student_profile_id,r.program_id,r.class_session_id
 INTO receipt
 FROM hon.student_registration_receipts r
 JOIN hon.student_profiles sp ON sp.id=r.student_profile_id AND sp.organization_id=r.organization_id AND sp.school_id=r.school_id
 JOIN hon.student_curriculum_enrollments e ON e.id=r.enrollment_id AND e.student_profile_id=r.student_profile_id AND e.program_id=r.program_id AND e.organization_id=r.organization_id AND e.school_id=r.school_id
 WHERE r.id=registration AND r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor
  AND r.receipt->>'status'='REGISTERED_NO_BOOKING'
 FOR SHARE OF r,sp,e;
 IF NOT FOUND THEN
 SELECT r.id AS registration_id,r.student_profile_id,r.program_id,r.class_session_id
 INTO receipt
 FROM hon.guardian_child_registration_receipts r
 JOIN hon.student_profiles sp ON sp.id=r.student_profile_id AND sp.organization_id=r.organization_id AND sp.school_id=r.school_id
 JOIN hon.student_curriculum_enrollments e ON e.id=r.enrollment_id AND e.student_profile_id=r.student_profile_id AND e.program_id=r.program_id AND e.organization_id=r.organization_id AND e.school_id=r.school_id
  WHERE r.id=registration AND r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor
   AND r.receipt->>'status'='REGISTERED_NO_BOOKING'
  FOR SHARE OF r,sp,e;
 END IF;
 IF receipt.registration_id IS NULL THEN RAISE EXCEPTION 'OWNER_LAUNCH_RECEIPT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;

 -- Reuse the canonical human booking lock. It independently rechecks exact
 -- schedule.booking.manage/tier/direct-human authority and serializes every
 -- capacity decision on this same class session; UI or receipt IDs are never
 -- substitutes for that authority.
 SELECT * INTO locked FROM hon.lock_class_booking_session(p_subject,receipt.class_session_id);
 IF locked.id IS NULL THEN RAISE EXCEPTION 'OWNER_LAUNCH_RECEIPT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 SELECT s.version,s.program_id,s.status INTO class_version,class_program,class_status
 FROM hon.class_sessions s WHERE s.id=receipt.class_session_id AND s.organization_id=org AND s.school_id=school;
 IF class_version IS NULL OR class_program<>receipt.program_id THEN RAISE EXCEPTION 'OWNER_LAUNCH_RECEIPT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 IF class_version<>expected_class_version THEN RAISE EXCEPTION 'OWNER_LAUNCH_CLASS_STALE' USING ERRCODE='40001'; END IF;
 IF class_status='CANCELLED' THEN RAISE EXCEPTION 'OWNER_LAUNCH_BOOKING_UNAVAILABLE' USING ERRCODE='22023'; END IF;

 fp:=sha256(convert_to(p_input::text,'UTF8')); key_digest:=sha256(convert_to(p_key,'UTF8'));
 INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
 VALUES(org,school,actor,p_key,encode(fp,'hex'),'IN_PROGRESS',now()+interval '24 hours')
 ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING;
 SELECT request_fingerprint,status,response_body INTO prior FROM hon.idempotency_records
 WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key FOR UPDATE;
 IF prior.request_fingerprint IS DISTINCT FROM encode(fp,'hex') THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
 IF prior.status='COMPLETED' AND prior.response_body IS NOT NULL THEN
  PERFORM hon.require_owner_launch_actor(p_subject);
  RETURN prior.response_body || jsonb_build_object('replayed',true);
 END IF;
 IF prior.status<>'IN_PROGRESS' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='23505'; END IF;

 SELECT * INTO existing FROM hon.class_bookings
 WHERE organization_id=org AND school_id=school AND class_session_id=receipt.class_session_id AND student_profile_id=receipt.student_profile_id FOR SHARE;
 IF existing.id IS NOT NULL THEN
  IF existing.booking_kind<>'REGULAR' OR existing.status NOT IN('BOOKED','WAITLISTED') THEN RAISE EXCEPTION 'OWNER_LAUNCH_BOOKING_UNAVAILABLE' USING ERRCODE='22023'; END IF;
  booking:=existing;
 ELSE
  seats:=hon.walkin_session_taken(receipt.class_session_id); -- 0538: bookings plus kiosk trial visitors
  decision:=CASE WHEN locked.booking_policy='WALK_IN' OR seats<locked.capacity THEN 'BOOKED'::hon.class_booking_status ELSE 'WAITLISTED'::hon.class_booking_status END;
  INSERT INTO hon.class_bookings(organization_id,school_id,class_session_id,student_profile_id,booking_kind,status,source)
  VALUES(org,school,receipt.class_session_id,receipt.student_profile_id,'REGULAR',decision,'STAFF') RETURNING * INTO booking;
 END IF;

 result:=jsonb_build_object('registrationId',receipt.registration_id,'bookingId',booking.id,'classSessionId',booking.class_session_id,
  'status',booking.status::text,'bookingVersion',booking.version,
  'recordedAt',to_char(booking.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 payload:=jsonb_build_object('classBookingId',booking.id,'classSessionId',booking.class_session_id,'studentProfileId',booking.student_profile_id,
  'bookingKind',booking.booking_kind,'status',booking.status::text,'source',booking.source,'sessionCapacity',locked.capacity,
  'bookingPolicy',locked.booking_policy,'activeSeatCount',seats+CASE WHEN booking.status='BOOKED' AND existing.id IS NULL THEN 1 ELSE 0 END,
  'bookedAt',booking.booked_at,'version',booking.version,'operation','CREATED');
 IF existing.id IS NULL THEN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id,action_request_id,occurred_at)
  VALUES(org,school,actor,'HUMAN_UI','schedule.booking.create','CLASS_BOOKING',booking.id,NULL,payload,'SUCCEEDED',p_request,p_correlation,NULL,now());
  INSERT INTO hon.outbox_events(id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
  VALUES(gen_random_uuid(),org,school,'class.booking.created',1,'CLASS_BOOKING',booking.id,booking.version,p_correlation,p_request,payload);
 END IF;
 UPDATE hon.idempotency_records SET status='COMPLETED',response_status=CASE WHEN existing.id IS NULL THEN 201 ELSE 200 END,response_body=result
 WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key;
 PERFORM hon.require_owner_launch_actor(p_subject);
 RETURN result || jsonb_build_object('replayed',existing.id IS NOT NULL);
END $$;

COMMENT ON FUNCTION hon.read_class_session_seats_taken(uuid) IS
'0538 P1: seats taken in one class session of the current school (BOOKED/CHECKED_IN bookings plus kiosk trial visitors); null otherwise. No DML.';

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.read_class_session_seats_taken(uuid) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_class_session_seats_taken(uuid) FROM %I',r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_class_session_seats_taken(uuid) TO hon_runtime;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime')
    AND (has_function_privilege('hon_runtime','hon.walkin_session_taken(uuid)','EXECUTE')
      OR has_function_privilege('hon_runtime','hon.parent_class_booking_seats(uuid)','EXECUTE')
      OR has_function_privilege('hon_runtime','hon.walkin_trial_session_open(hon.class_sessions,jsonb,integer)','EXECUTE')
      OR has_function_privilege('hon_runtime','hon.walkin_trial_classes(uuid,uuid,jsonb)','EXECUTE')
      OR has_function_privilege('hon_runtime','hon.walkin_settings_input(jsonb)','EXECUTE')
      OR has_table_privilege('hon_runtime','hon.walkin_visits','SELECT,INSERT,UPDATE,DELETE')
      OR has_table_privilege('hon_runtime','hon.school_demo_data_rows','SELECT,INSERT,UPDATE,DELETE')) THEN
    RAISE EXCEPTION 'Walk-in kiosk pre-pilot fixes must not widen runtime privileges';
  END IF;
END $$;
COMMIT;
