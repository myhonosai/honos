BEGIN;

-- Onboarding PR 2 (0323, coordinator-allocated 2026-11-13): HON's welcome answers and the school's setup progress.
-- - Answers (situation, disciplines, goals, new-school or switching path, previous software, what to bring over, skipped
--   optional steps) are one versioned row per school, written only by a direct human with onboarding.manage at that
--   school, with an idempotency key, audit and inert outbox.
-- - Progress is never stored as "done". Every read recomputes each step from the school's real records (programs,
--   classes, plans, leads, trial bookings, students, staff invitations, imports, interface choice), so a step goes back to
--   not done when its records are gone (for example, every class cancelled).
-- - Owner decision D3 (David, 2026-11-12 17:07Z): before the trial or paid access starts, the owner may answer the welcome
--   questions, choose interface and language and contact support only. So answers and this read need no active
--   entitlement, and while none is active every school-data step reads UNAVAILABLE without looking at school data.
-- - No membership, billing, message, AI, credit, entitlement or access effect. The runtime role gets EXECUTE on two
--   entry points and nothing on any table.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL OR to_regclass('hon.student_import_batches') IS NULL
    OR to_regclass('hon.class_series') IS NULL OR to_regclass('hon.school_staff_invitations') IS NULL
    OR to_regclass('hon.hon_os_trial_enrollments') IS NULL THEN RAISE EXCEPTION '0323 requires 0204, 0226, 0239 and 0246'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable)
  VALUES('onboarding.manage','Answer HON''s welcome questions and see the school''s setup progress',false,true)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
  SELECT r.id,r.organization_id,'onboarding.manage' FROM hon.roles r WHERE r.code='OWNER' AND r.is_system_role
  ON CONFLICT (role_id,permission_code) DO NOTHING;

CREATE TABLE hon.school_onboarding_profiles (
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 999999999),
  situation text CHECK (situation IN ('NEW_SCHOOL','EXISTING_SCHOOL','MULTI_LOCATION','EXPLORING')),
  disciplines text[] NOT NULL DEFAULT '{}' CHECK (cardinality(disciplines)<=10
    AND disciplines <@ ARRAY['TAEKWONDO','KARATE','BJJ','KICKBOXING','MMA','JUDO','KUNG_FU','HAPKIDO','MUAY_THAI','OTHER']),
  custom_discipline text CHECK (custom_discipline IS NULL OR (length(custom_discipline) BETWEEN 1 AND 60
    AND btrim(custom_discipline)=custom_discipline AND custom_discipline !~ '[[:cntrl:]<>]')),
  goals text[] NOT NULL DEFAULT '{}' CHECK (goals <@ ARRAY['MORE_STUDENTS','LEAD_FOLLOW_UP','SIMPLER_OPERATIONS','SAVE_TIME',
    'RETENTION','MEMBERSHIPS_PAYMENTS','REPORTING','MULTI_LOCATION']),
  path text CHECK (path IN ('NEW','SWITCHING')),
  previous_software text CHECK (previous_software IN ('SPARK','ZEN_PLANNER','KICKSITE','MINDBODY','GYMDESK','PIKE13','EMBER',
    'SPREADSHEET','PAPER','OTHER','NONE')),
  previous_software_other text CHECK (previous_software_other IS NULL OR (length(previous_software_other) BETWEEN 1 AND 60
    AND btrim(previous_software_other)=previous_software_other AND previous_software_other !~ '[[:cntrl:]<>]')),
  import_wishes text[] NOT NULL DEFAULT '{}' CHECK (import_wishes <@ ARRAY['STUDENTS','LEADS','MEMBERSHIPS','CLASSES','BALANCES','ATTENDANCE','STAFF']),
  skipped_steps text[] NOT NULL DEFAULT '{}' CHECK (skipped_steps <@ ARRAY['INTERFACE','PROGRAM','CLASS_SCHEDULE','MEMBERSHIP_PLAN',
    'FIRST_LEAD','TRIAL_BOOKED','FIRST_STUDENT','STAFF','IMPORT']),
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,school_id),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((custom_discipline IS NULL) OR ('OTHER'=ANY(disciplines))),
  CHECK ((previous_software_other IS NULL) OR previous_software='OTHER')
);
CREATE TABLE hon.school_onboarding_requests (
  organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  response jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  PRIMARY KEY (organization_id,school_id,principal_id,idempotency_key),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((response IS NULL)=(completed_at IS NULL))
);
ALTER TABLE hon.school_onboarding_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_onboarding_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.school_onboarding_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_onboarding_requests FORCE ROW LEVEL SECURITY;

-- A profile only moves forward one version at a time and never changes school or creation; nothing is ever deleted.
-- A request records its response once.
CREATE FUNCTION hon.guard_school_onboarding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'ONBOARDING_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='school_onboarding_requests' THEN
    IF OLD.response IS NOT NULL OR NEW.response IS NULL OR (NEW.organization_id,NEW.school_id,NEW.principal_id,NEW.idempotency_key,NEW.fingerprint,NEW.created_at)
      IS DISTINCT FROM (OLD.organization_id,OLD.school_id,OLD.principal_id,OLD.idempotency_key,OLD.fingerprint,OLD.created_at) THEN
      RAISE EXCEPTION 'ONBOARDING_IMMUTABLE' USING ERRCODE='42501'; END IF;
  ELSIF NEW.version<>OLD.version+1 OR (NEW.organization_id,NEW.school_id,NEW.created_at) IS DISTINCT FROM (OLD.organization_id,OLD.school_id,OLD.created_at) THEN
    RAISE EXCEPTION 'ONBOARDING_IMMUTABLE' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.school_onboarding_profiles FOR EACH ROW EXECUTE FUNCTION hon.guard_school_onboarding();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_onboarding_profiles FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_onboarding();
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.school_onboarding_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_school_onboarding();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_onboarding_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_onboarding();

-- The direct human with live onboarding.manage at the session school. Like every staff command, but on purpose without
-- an active entitlement (D3): a signed-up school can answer the welcome before its trial starts.
CREATE FUNCTION hon.require_onboarding_actor(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 2048 OR btrim(p_subject)<>p_subject
    OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'ONBOARDING_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=p_subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
    AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=org AND o.status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=p.id AND f.effective_from<=clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
    AND hon.staff_member_eligible(p.id,org,school)
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions x ON x.code=rp.permission_code
      WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND x.code='onboarding.manage' AND x.is_staff_assignable);
  IF actor IS NULL THEN RAISE EXCEPTION 'ONBOARDING_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.school_onboarding_profile_json(p hon.school_onboarding_profiles) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('version',p.version,'situation',p.situation,'disciplines',to_jsonb(p.disciplines),
    'customDiscipline',p.custom_discipline,'goals',to_jsonb(p.goals),'path',p.path,'previousSoftware',p.previous_software,
    'previousSoftwareOther',p.previous_software_other,'importWishes',to_jsonb(p.import_wishes),'skippedSteps',to_jsonb(p.skipped_steps),
    'updatedAt',hon.saas_ts(p.updated_at));
$$;

-- Closed list check: a JSON array of distinct allowed strings, at most p_max long.
CREATE FUNCTION hon.onboarding_codes(p_value jsonb,p_allowed text[],p_max integer) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE out text[]:='{}'; v jsonb;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value)<>'array' OR jsonb_array_length(p_value)>p_max THEN RAISE EXCEPTION 'ONBOARDING_INVALID' USING ERRCODE='22023'; END IF;
  FOR v IN SELECT * FROM jsonb_array_elements(p_value) LOOP
    IF jsonb_typeof(v)<>'string' OR NOT (v#>>'{}')=ANY(p_allowed) OR (v#>>'{}')=ANY(out) THEN RAISE EXCEPTION 'ONBOARDING_INVALID' USING ERRCODE='22023'; END IF;
    out:=out||(v#>>'{}');
  END LOOP;
  RETURN (SELECT coalesce(array_agg(x ORDER BY x),'{}') FROM unnest(out) x);
END $$;
CREATE FUNCTION hon.onboarding_choice(p_value jsonb,p_allowed text[]) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value)='null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_value)<>'string' OR NOT (p_value#>>'{}')=ANY(p_allowed) THEN RAISE EXCEPTION 'ONBOARDING_INVALID' USING ERRCODE='22023'; END IF;
  RETURN p_value#>>'{}';
END $$;
CREATE FUNCTION hon.onboarding_text(p_value jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value)='null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_value)<>'string' OR length(p_value#>>'{}') NOT BETWEEN 1 AND 60 OR btrim(p_value#>>'{}')<>(p_value#>>'{}')
    OR (p_value#>>'{}') ~ '[[:cntrl:]<>]' THEN RAISE EXCEPTION 'ONBOARDING_INVALID' USING ERRCODE='22023'; END IF;
  RETURN p_value#>>'{}';
END $$;

-- Save the whole answer set (autosave sends every field). expectedVersion is 0 for the first save, then the version read.
CREATE FUNCTION hon.save_school_onboarding(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text;
  prior hon.school_onboarding_requests%ROWTYPE; cur hon.school_onboarding_profiles%ROWTYPE; p hon.school_onboarding_profiles%ROWTYPE;
  expected integer; v_disc text[]; v_custom text; v_soft text; v_other text; result jsonb;
BEGIN
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k)
      IS DISTINCT FROM ARRAY['customDiscipline','disciplines','expectedVersion','goals','importWishes','path','previousSoftware','previousSoftwareOther','situation','skippedSteps']
    OR jsonb_typeof(p_input->'expectedVersion')<>'number' OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
    OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN
    RAISE EXCEPTION 'ONBOARDING_INVALID' USING ERRCODE='22023'; END IF;
  actor:=hon.require_onboarding_actor(p_subject);
  fp:=encode(sha256(convert_to(p_input::text,'UTF8')),'hex');
  INSERT INTO hon.school_onboarding_requests(organization_id,school_id,principal_id,idempotency_key,fingerprint)
    VALUES(org,school,actor,p_key,fp) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO prior FROM hon.school_onboarding_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key FOR UPDATE;
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.response IS NULL THEN RAISE EXCEPTION 'ONBOARDING_BUSY' USING ERRCODE='55P03'; END IF;
    RETURN jsonb_build_object('record',prior.response,'replayed',true);
  END IF;
  expected:=(p_input->>'expectedVersion')::numeric::integer;
  IF (p_input->>'expectedVersion')::numeric<>expected OR expected<0 THEN RAISE EXCEPTION 'ONBOARDING_INVALID' USING ERRCODE='22023'; END IF;
  v_disc:=hon.onboarding_codes(p_input->'disciplines',ARRAY['TAEKWONDO','KARATE','BJJ','KICKBOXING','MMA','JUDO','KUNG_FU','HAPKIDO','MUAY_THAI','OTHER'],10);
  v_custom:=hon.onboarding_text(p_input->'customDiscipline');
  v_soft:=hon.onboarding_choice(p_input->'previousSoftware',ARRAY['SPARK','ZEN_PLANNER','KICKSITE','MINDBODY','GYMDESK','PIKE13','EMBER','SPREADSHEET','PAPER','OTHER','NONE']);
  v_other:=hon.onboarding_text(p_input->'previousSoftwareOther');
  IF (v_custom IS NOT NULL AND NOT 'OTHER'=ANY(v_disc)) OR (v_other IS NOT NULL AND v_soft IS DISTINCT FROM 'OTHER') THEN
    RAISE EXCEPTION 'ONBOARDING_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO cur FROM hon.school_onboarding_profiles WHERE organization_id=org AND school_id=school FOR UPDATE;
  IF coalesce(cur.version,0)<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  INSERT INTO hon.school_onboarding_profiles AS t(organization_id,school_id,version,situation,disciplines,custom_discipline,goals,path,
      previous_software,previous_software_other,import_wishes,skipped_steps,updated_by_principal_id)
    VALUES(org,school,1,hon.onboarding_choice(p_input->'situation',ARRAY['NEW_SCHOOL','EXISTING_SCHOOL','MULTI_LOCATION','EXPLORING']),v_disc,v_custom,
      hon.onboarding_codes(p_input->'goals',ARRAY['MORE_STUDENTS','LEAD_FOLLOW_UP','SIMPLER_OPERATIONS','SAVE_TIME','RETENTION','MEMBERSHIPS_PAYMENTS','REPORTING','MULTI_LOCATION'],8),
      hon.onboarding_choice(p_input->'path',ARRAY['NEW','SWITCHING']),v_soft,v_other,
      hon.onboarding_codes(p_input->'importWishes',ARRAY['STUDENTS','LEADS','MEMBERSHIPS','CLASSES','BALANCES','ATTENDANCE','STAFF'],7),
      hon.onboarding_codes(p_input->'skippedSteps',ARRAY['INTERFACE','PROGRAM','CLASS_SCHEDULE','MEMBERSHIP_PLAN','FIRST_LEAD','TRIAL_BOOKED','FIRST_STUDENT','STAFF','IMPORT'],9),actor)
    ON CONFLICT (organization_id,school_id) DO UPDATE SET version=t.version+1,situation=EXCLUDED.situation,disciplines=EXCLUDED.disciplines,
      custom_discipline=EXCLUDED.custom_discipline,goals=EXCLUDED.goals,path=EXCLUDED.path,previous_software=EXCLUDED.previous_software,
      previous_software_other=EXCLUDED.previous_software_other,import_wishes=EXCLUDED.import_wishes,skipped_steps=EXCLUDED.skipped_steps,
      updated_by_principal_id=EXCLUDED.updated_by_principal_id,updated_at=clock_timestamp()
    RETURNING * INTO p;
  result:=hon.school_onboarding_profile_json(p);
  -- Identifier-only evidence: the answers stay in the profile row, not in audit or outbox payloads.
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','onboarding.profile.saved','SCHOOL_ONBOARDING',school,jsonb_build_object('version',p.version,'internalOnly',true),'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'onboarding.profile.saved',1,'SCHOOL_ONBOARDING',school,p.version,p_correlation,p_request,jsonb_build_object('version',p.version,'internalOnly',true));
  UPDATE hon.school_onboarding_requests SET response=result,completed_at=clock_timestamp()
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key;
  IF hon.require_onboarding_actor(p_subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'ONBOARDING_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

-- One setup step from live records: COMPLETE when a current record proves it, IN_PROGRESS / NEEDS_REVIEW when a record
-- exists but does not yet prove it, otherwise NOT_STARTED. firstAt is the earliest proving record still current.
CREATE FUNCTION hon.onboarding_step(p_key text,p_status text,p_count bigint,p_first timestamptz,p_optional boolean,p_skipped text[]) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('key',p_key,'status',p_status,'count',p_count,'firstAt',hon.saas_ts(p_first),'optional',p_optional,
    'skipped',p_key=ANY(p_skipped) AND p_status<>'COMPLETE');
$$;

-- The school's onboarding: the answers, access standing and every setup step, recomputed now.
CREATE FUNCTION hon.read_school_onboarding(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; at timestamptz:=clock_timestamp();
  p hon.school_onboarding_profiles%ROWTYPE; s hon.schools%ROWTYPE; t hon.hon_os_trial_enrollments%ROWTYPE;
  active boolean; access text; skipped text[]; steps jsonb:='[]'; n bigint; n2 bigint; f timestamptz; st text;
BEGIN
  actor:=hon.require_onboarding_actor(p_subject);
  SELECT * INTO s FROM hon.schools WHERE id=school AND organization_id=org;
  SELECT * INTO p FROM hon.school_onboarding_profiles WHERE organization_id=org AND school_id=school;
  SELECT * INTO t FROM hon.hon_os_trial_enrollments WHERE organization_id=org;
  skipped:=coalesce(p.skipped_steps,'{}');
  active:=EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
    AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=at AND (e.effective_until IS NULL OR e.effective_until>at));
  access:=CASE WHEN active THEN 'ACTIVE' WHEN t.id IS NOT NULL OR EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org
    AND e.status='ACTIVE' AND e.effective_until IS NOT NULL AND e.effective_until<=at) THEN 'ENDED' ELSE 'NOT_STARTED' END;

  steps:=steps||hon.onboarding_step('SCHOOL_DETAILS','COMPLETE',1,s.created_at,false,skipped);
  steps:=steps||hon.onboarding_step('WELCOME',CASE WHEN p.situation IS NOT NULL AND cardinality(p.goals)>0 AND p.path IS NOT NULL THEN 'COMPLETE'
    WHEN p.version IS NOT NULL THEN 'IN_PROGRESS' ELSE 'NOT_STARTED' END,CASE WHEN p.version IS NULL THEN 0 ELSE 1 END,p.created_at,false,skipped);
  SELECT count(*),min(created_at) INTO n,f FROM hon.principal_interface_preferences WHERE organization_id=org AND school_id=school AND principal_id=actor;
  steps:=steps||hon.onboarding_step('INTERFACE',CASE WHEN n>0 THEN 'COMPLETE' ELSE 'NOT_STARTED' END,n,f,true,skipped);

  IF NOT active THEN
    -- D3: without trial or paid access no school data is read; these steps open when access starts.
    FOREACH st IN ARRAY ARRAY['PROGRAM','CLASS_SCHEDULE','MEMBERSHIP_PLAN','FIRST_LEAD','TRIAL_BOOKED','FIRST_STUDENT','STAFF','IMPORT'] LOOP
      IF st<>'IMPORT' OR p.path IS DISTINCT FROM 'NEW' THEN
        steps:=steps||hon.onboarding_step(st,'UNAVAILABLE',0,NULL,st IN ('STAFF','TRIAL_BOOKED','IMPORT'),skipped); END IF;
    END LOOP;
  ELSE
    SELECT count(*) FILTER (WHERE status='SCHEDULED'),count(*) FILTER (WHERE status='DRAFT'),min(created_at) FILTER (WHERE status='SCHEDULED')
      INTO n,n2,f FROM hon.programs WHERE organization_id=org AND school_id=school;
    steps:=steps||hon.onboarding_step('PROGRAM',CASE WHEN n>0 THEN 'COMPLETE' WHEN n2>0 THEN 'IN_PROGRESS' ELSE 'NOT_STARTED' END,n,f,false,skipped);
    SELECT count(*),min(c) INTO n,f FROM (
      SELECT created_at c FROM hon.class_series WHERE organization_id=org AND school_id=school AND status='ACTIVE'
      UNION ALL SELECT created_at FROM hon.class_sessions WHERE organization_id=org AND school_id=school AND status='SCHEDULED' AND ends_at>at) x;
    SELECT count(*) INTO n2 FROM hon.class_sessions WHERE organization_id=org AND school_id=school AND status IN ('SCHEDULED','COMPLETED');
    steps:=steps||hon.onboarding_step('CLASS_SCHEDULE',CASE WHEN n>0 THEN 'COMPLETE' WHEN n2>0 THEN 'NEEDS_REVIEW' ELSE 'NOT_STARTED' END,n,f,false,skipped);
    SELECT count(*) FILTER (WHERE v.availability='AVAILABLE'),count(*),min(m.created_at) FILTER (WHERE v.availability='AVAILABLE') INTO n,n2,f
      FROM hon.membership_plans m JOIN hon.membership_plan_versions v ON v.plan_id=m.id AND v.version=m.current_version
      WHERE m.organization_id=org AND m.school_id=school;
    steps:=steps||hon.onboarding_step('MEMBERSHIP_PLAN',CASE WHEN n>0 THEN 'COMPLETE' WHEN n2>0 THEN 'IN_PROGRESS' ELSE 'NOT_STARTED' END,n,f,false,skipped);
    SELECT count(*),min(created_at) INTO n,f FROM hon.crm_leads WHERE organization_id=org AND school_id=school AND status<>'ARCHIVED';
    steps:=steps||hon.onboarding_step('FIRST_LEAD',CASE WHEN n>0 THEN 'COMPLETE' ELSE 'NOT_STARTED' END,n,f,false,skipped);
    SELECT count(*),min(created_at) INTO n,f FROM hon.crm_appointments WHERE organization_id=org AND school_id=school AND status IN ('SCHEDULED','COMPLETED');
    steps:=steps||hon.onboarding_step('TRIAL_BOOKED',CASE WHEN n>0 THEN 'COMPLETE' ELSE 'NOT_STARTED' END,n,f,true,skipped);
    SELECT count(*),min(created_at) INTO n,f FROM hon.student_profiles WHERE organization_id=org AND school_id=school AND status='ACTIVE';
    steps:=steps||hon.onboarding_step('FIRST_STUDENT',CASE WHEN n>0 THEN 'COMPLETE' ELSE 'NOT_STARTED' END,n,f,false,skipped);
    SELECT count(*) FILTER (WHERE status='ACCEPTED'),count(*) FILTER (WHERE status='PENDING' AND expires_at>at),min(accepted_at) FILTER (WHERE status='ACCEPTED')
      INTO n,n2,f FROM hon.school_staff_invitations WHERE organization_id=org AND school_id=school;
    steps:=steps||hon.onboarding_step('STAFF',CASE WHEN n>0 THEN 'COMPLETE' WHEN n2>0 THEN 'IN_PROGRESS' ELSE 'NOT_STARTED' END,n,f,true,skipped);
    IF p.path IS DISTINCT FROM 'NEW' THEN
      SELECT count(*) FILTER (WHERE status='FINALIZED'),count(*) FILTER (WHERE status<>'FINALIZED'),min(created_at) FILTER (WHERE status='FINALIZED') INTO n,n2,f FROM (
        SELECT status,created_at FROM hon.student_import_batches WHERE organization_id=org AND school_id=school
        UNION ALL SELECT status,created_at FROM hon.lead_import_batches WHERE organization_id=org AND school_id=school) x;
      steps:=steps||hon.onboarding_step('IMPORT',CASE WHEN n>0 THEN 'COMPLETE' WHEN n2>0 THEN 'NEEDS_REVIEW' ELSE 'NOT_STARTED' END,n,f,true,skipped);
    END IF;
  END IF;

  RETURN jsonb_build_object('schoolName',s.name,'timezone',s.timezone,'profile',CASE WHEN p.version IS NULL THEN NULL ELSE hon.school_onboarding_profile_json(p) END,
    'access',jsonb_build_object('state',access,'trialStatus',CASE WHEN t.id IS NULL THEN NULL ELSE hon.hon_os_trial_json(t)->>'status' END,
      'trialEndsAt',CASE WHEN t.id IS NULL THEN NULL ELSE hon.hon_os_trial_json(t)->'endsAt' END),
    'steps',steps,'checkedAt',hon.saas_ts(at));
END $$;

-- Deny first, then exactly the two entry points for the runtime role. No table privilege for any client role.
DO $$ DECLARE r text; t text; f regprocedure; BEGIN
  FOREACH t IN ARRAY ARRAY['school_onboarding_profiles','school_onboarding_requests'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_school_onboarding()','hon.require_onboarding_actor(text)','hon.school_onboarding_profile_json(hon.school_onboarding_profiles)',
    'hon.onboarding_codes(jsonb,text[],integer)','hon.onboarding_choice(jsonb,text[])','hon.onboarding_text(jsonb)',
    'hon.save_school_onboarding(text,jsonb,text,uuid,uuid)','hon.onboarding_step(text,text,bigint,timestamptz,boolean,text[])',
    'hon.read_school_onboarding(text)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.save_school_onboarding(text,jsonb,text,uuid,uuid),hon.read_school_onboarding(text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
