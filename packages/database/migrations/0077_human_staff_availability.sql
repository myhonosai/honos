BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Staff foundation requires trusted migration owner'; END IF;
END $$;
INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
 ('staff.availability.self_manage','Human own staff availability read and revision; planning metadata only',true,true),
 ('staff.availability.manage','Human exact known school staff availability read and revision',true,true),
 ('staff.qualification.manage','Human exact known school staff unverified qualification metadata read and revision',true,true);
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
 SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN hon.permissions p WHERE r.is_system_role AND r.code='OWNER'
 AND p.code IN('staff.availability.self_manage','staff.availability.manage','staff.qualification.manage') ON CONFLICT DO NOTHING;

CREATE TABLE hon.staff_profiles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
 UNIQUE(organization_id,school_id,principal_id), UNIQUE(id,organization_id,school_id)
);
CREATE TABLE hon.staff_planning_revisions (
 profile_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('AVAILABILITY','QUALIFICATIONS')), version integer NOT NULL CHECK(version BETWEEN 1 AND 999999999),
 actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 source text NOT NULL CHECK(source='HUMAN_UI'), request_id uuid NOT NULL,
 timezone text NOT NULL, payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(profile_id,kind,version),
 FOREIGN KEY(profile_id,organization_id,school_id) REFERENCES hon.staff_profiles(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE TABLE hon.staff_planning_requests (
 organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200), fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 response jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,school_id,principal_id,idempotency_key),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
ALTER TABLE hon.staff_profiles ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.staff_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.staff_planning_revisions ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.staff_planning_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.staff_planning_requests ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.staff_planning_requests FORCE ROW LEVEL SECURITY;
-- No policies. These private tables are reachable only through fixed trusted functions.
CREATE FUNCTION hon.guard_staff_planning_history() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_STAFF_PLANNING_HISTORY' USING ERRCODE='42501'; END $$;
CREATE TRIGGER staff_profiles_immutable BEFORE UPDATE OR DELETE ON hon.staff_profiles FOR EACH ROW EXECUTE FUNCTION hon.guard_staff_planning_history();
CREATE TRIGGER staff_profiles_no_truncate BEFORE TRUNCATE ON hon.staff_profiles FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_staff_planning_history();
CREATE TRIGGER staff_revisions_immutable BEFORE UPDATE OR DELETE ON hon.staff_planning_revisions FOR EACH ROW EXECUTE FUNCTION hon.guard_staff_planning_history();
CREATE TRIGGER staff_revisions_no_truncate BEFORE TRUNCATE ON hon.staff_planning_revisions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_staff_planning_history();
CREATE TRIGGER staff_requests_immutable BEFORE UPDATE OR DELETE ON hon.staff_planning_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_staff_planning_history();
CREATE TRIGGER staff_requests_no_truncate BEFORE TRUNCATE ON hon.staff_planning_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_staff_planning_history();

CREATE FUNCTION hon.validate_staff_planning_input(p_kind text,p jsonb) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE x jsonb; k text; v text; windows jsonb; qualifications jsonb; start_minutes integer; end_minutes integer;
BEGIN
 IF p_kind IS NULL OR p_kind NOT IN('AVAILABILITY','QUALIFICATIONS') OR jsonb_typeof(p) IS DISTINCT FROM 'object'
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) keys(key) WHERE keys.key NOT IN('expectedVersion','status','effectiveFrom','endsOn',CASE p_kind WHEN 'AVAILABILITY' THEN 'windows' ELSE 'qualifications' END))
 OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->>'expectedVersion') !~ '^(0|[1-9][0-9]{0,8})$' OR (p->>'expectedVersion')::numeric>999999998
 OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR (p->>'status') NOT IN('ACTIVE','ENDED')
 OR NOT p ? 'endsOn' OR (p->'endsOn'<>'null'::jsonb AND jsonb_typeof(p->'endsOn') IS DISTINCT FROM 'string') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 FOR k IN SELECT unnest(ARRAY['effectiveFrom','endsOn']) LOOP
  IF k='endsOn' AND p->k='null'::jsonb THEN CONTINUE; END IF;
  v:=p->>k;
  IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR v !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' OR to_char(v::date,'YYYY-MM-DD')<>v THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF p->'endsOn'<>'null'::jsonb AND ((p->>'endsOn')::date-(p->>'effectiveFrom')::date NOT BETWEEN 1 AND 3660) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF p_kind='AVAILABILITY' THEN
  windows:=p->'windows';
  IF jsonb_typeof(windows) IS DISTINCT FROM 'array' OR jsonb_array_length(windows)>28 OR (p->>'status'='ENDED' AND jsonb_array_length(windows)<>0) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(windows) LOOP
   IF jsonb_typeof(x) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(x) keys(key) WHERE keys.key NOT IN('weekday','start','end'))
   OR jsonb_typeof(x->'weekday') IS DISTINCT FROM 'number' OR (x->>'weekday') !~ '^[1-7]$'
   OR jsonb_typeof(x->'start') IS DISTINCT FROM 'string' OR (x->>'start') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
   OR jsonb_typeof(x->'end') IS DISTINCT FROM 'string' OR (x->>'end') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
   start_minutes:=split_part(x->>'start',':',1)::integer*60+split_part(x->>'start',':',2)::integer;
   end_minutes:=split_part(x->>'end',':',1)::integer*60+split_part(x->>'end',':',2)::integer;
   IF end_minutes-start_minutes<15 THEN RAISE EXCEPTION 'INVALID_WEEKLY_WINDOW' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(windows) WITH ORDINALITY a(x,i) CROSS JOIN jsonb_array_elements(windows) WITH ORDINALITY b(x,i)
   WHERE a.i<b.i AND a.x->>'weekday'=b.x->>'weekday' AND a.x->>'start'<b.x->>'end' AND b.x->>'start'<a.x->>'end') THEN RAISE EXCEPTION 'OVERLAPPING_WEEKLY_WINDOWS' USING ERRCODE='22023'; END IF;
 ELSE
  qualifications:=p->'qualifications';
  IF jsonb_typeof(qualifications) IS DISTINCT FROM 'array' OR jsonb_array_length(qualifications)>30 OR (p->>'status'='ENDED' AND jsonb_array_length(qualifications)<>0) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(qualifications) LOOP
   IF jsonb_typeof(x) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(x) keys(key) WHERE keys.key NOT IN('title','issuer','expiresOn')) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
   FOR k IN SELECT unnest(ARRAY['title','issuer']) LOOP
    v:=x->>k;
    IF jsonb_typeof(x->k) IS DISTINCT FROM 'string' OR length(v) NOT BETWEEN 1 AND 120 OR btrim(v)<>v OR v ~ '[[:cntrl:]\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
   END LOOP;
   IF NOT x ? 'expiresOn' OR (x->'expiresOn'<>'null'::jsonb AND (jsonb_typeof(x->'expiresOn') IS DISTINCT FROM 'string' OR (x->>'expiresOn') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' OR to_char((x->>'expiresOn')::date,'YYYY-MM-DD')<>x->>'expiresOn')) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(qualifications) e(item) GROUP BY lower(e.item->>'title'),lower(e.item->>'issuer') HAVING count(*)>1) THEN RAISE EXCEPTION 'DUPLICATE_QUALIFICATION_METADATA' USING ERRCODE='22023'; END IF;
 END IF;
 IF p->>'status'='ENDED' AND (p->>'expectedVersion')::integer=0 THEN RAISE EXCEPTION 'NO_STREAM_TO_END' USING ERRCODE='22023'; END IF;
END $$;

-- Existing IAM uses permission-bearing school roles, not employment records.
-- Eligibility is exact, internal and never returns identity/contact metadata.
CREATE FUNCTION hon.staff_member_eligible(p_id uuid,p_org uuid,p_school uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT EXISTS(SELECT 1 FROM hon.principals p JOIN hon.users u ON u.id=p.user_id
 JOIN hon.principal_role_grants g ON g.principal_id=p.id JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
 JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions permission ON permission.code=rp.permission_code
 JOIN hon.schools s ON s.id=g.school_id AND s.organization_id=g.organization_id JOIN hon.organizations o ON o.id=s.organization_id
 WHERE p.id=p_id AND p.principal_type='HUMAN_USER' AND p.is_active
 AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=p.user_id AND x.principal_type='HUMAN_USER' AND x.is_active)=1
 AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)
 AND g.organization_id=p_org AND g.school_id=p_school AND o.status='ACTIVE' AND s.status='ACTIVE'
 AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
 AND (r.management_school_id IS NULL OR r.management_school_id=p_school) AND permission.is_staff_assignable
 AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)' )
$$;
CREATE FUNCTION hon.staff_has_planning_permission(p_id uuid,p_org uuid,p_school uuid,p_permission text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT p_permission IN('staff.availability.self_manage','staff.availability.manage','staff.qualification.manage') AND EXISTS(
 SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
 JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
 WHERE g.principal_id=p_id AND g.organization_id=p_org AND g.school_id=p_school AND rp.permission_code=p_permission
 AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
 AND (r.management_school_id IS NULL OR r.management_school_id=p_school)
 AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
$$;
CREATE FUNCTION hon.resolve_staff_availability_scope(p_subject text,p_permission text) RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 WITH candidates AS (
 SELECT DISTINCT p.id principal_id,g.organization_id,g.school_id FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
 JOIN hon.principal_role_grants g ON g.principal_id=p.id
 WHERE u.external_subject=p_subject AND hon.staff_member_eligible(p.id,g.organization_id,g.school_id)
 AND p_permission IN('staff.availability.self_manage','staff.availability.manage','staff.qualification.manage')
 AND hon.staff_has_planning_permission(p.id,g.organization_id,g.school_id,p_permission)
 ) SELECT * FROM candidates WHERE (SELECT count(*) FROM candidates)=1
$$;
CREATE FUNCTION hon.require_staff_planning_actor(p_subject text,p_target uuid,p_operation text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); allowed boolean;
BEGIN
 IF p_operation IS NULL OR p_operation NOT IN('READ','AVAILABILITY','QUALIFICATIONS') OR p_target IS NULL
 OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
 OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'HUMAN_UI_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT p.id INTO actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=p_subject AND p.id::text=current_setting('app.hon_principal_id',true);
 IF actor IS NULL OR NOT hon.staff_member_eligible(actor,org,school) OR NOT hon.staff_member_eligible(p_target,org,school) THEN RAISE EXCEPTION 'STAFF_MEMBER_UNAVAILABLE' USING ERRCODE='42501'; END IF;
 allowed:=CASE p_operation
 WHEN 'QUALIFICATIONS' THEN hon.staff_has_planning_permission(actor,org,school,'staff.qualification.manage')
 WHEN 'AVAILABILITY' THEN hon.staff_has_planning_permission(actor,org,school,'staff.availability.manage') OR (actor=p_target AND hon.staff_has_planning_permission(actor,org,school,'staff.availability.self_manage'))
 ELSE hon.staff_has_planning_permission(actor,org,school,'staff.availability.manage') OR hon.staff_has_planning_permission(actor,org,school,'staff.qualification.manage') OR (actor=p_target AND hon.staff_has_planning_permission(actor,org,school,'staff.availability.self_manage')) END;
 IF NOT allowed OR NOT EXISTS(SELECT 1 FROM hon.schools s JOIN pg_timezone_names tz ON tz.name=s.timezone WHERE s.id=school AND s.organization_id=org) OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements WHERE organization_id=org AND tier IN('ESSENTIAL','CORE','COMPLETE') AND status='ACTIVE' AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp())) THEN RAISE EXCEPTION 'STAFF_PLANNING_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;
CREATE FUNCTION hon.lock_staff_planning_actor(p_subject text,p_target uuid,p_operation text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
 PERFORM 1 FROM hon.organizations WHERE id=org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'STAFF_PLANNING_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'STAFF_PLANNING_FORBIDDEN' USING ERRCODE='42501'; END IF;
 actor:=hon.require_staff_planning_actor(p_subject,p_target,p_operation);
 -- Match established human boundary ordering; lock BOTH actor and recipient.
 PERFORM 1 FROM hon.users WHERE id IN(SELECT user_id FROM hon.principals WHERE id IN(actor,p_target)) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.principals WHERE id IN(actor,p_target) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.principal_role_grants WHERE principal_id IN(actor,p_target) AND organization_id=org AND school_id=school ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id IN(actor,p_target) AND organization_id=org AND school_id=school) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.role_permissions WHERE role_id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id IN(actor,p_target) AND organization_id=org AND school_id=school) ORDER BY role_id,permission_code FOR SHARE;
 PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=org FOR SHARE;
 RETURN hon.require_staff_planning_actor(p_subject,p_target,p_operation);
END $$;
CREATE FUNCTION hon.staff_revision_summary(p_profile uuid,p_kind text,p_version integer) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT r.payload || jsonb_build_object('profileId',r.profile_id,'principalId',p.principal_id,'schoolId',r.school_id,'timezone',r.timezone,'kind',r.kind,'version',r.version,'recordedAt',r.recorded_at,'planningOnly',true)
 FROM hon.staff_planning_revisions r JOIN hon.staff_profiles p ON p.id=r.profile_id AND p.organization_id=r.organization_id AND p.school_id=r.school_id
 WHERE r.profile_id=p_profile AND r.organization_id=hon.current_organization_id() AND r.school_id=hon.current_school_id() AND r.kind=p_kind AND (p_version IS NULL OR r.version=p_version) ORDER BY r.version DESC LIMIT 1
$$;
CREATE FUNCTION hon.guard_staff_profile_insert() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE subject text;
BEGIN
 IF NEW.organization_id IS DISTINCT FROM hon.current_organization_id() OR NEW.school_id IS DISTINCT FROM hon.current_school_id() OR NEW.created_by_principal_id::text IS DISTINCT FROM current_setting('app.hon_principal_id',true) THEN RAISE EXCEPTION 'INVALID_STAFF_PROFILE' USING ERRCODE='23514'; END IF;
 SELECT u.external_subject INTO subject FROM hon.users u JOIN hon.principals p ON p.user_id=u.id WHERE p.id=NEW.created_by_principal_id;
 PERFORM hon.require_staff_planning_actor(subject,NEW.principal_id,'READ');
 RETURN NEW;
END $$;
CREATE TRIGGER staff_profile_insert_guard BEFORE INSERT ON hon.staff_profiles FOR EACH ROW EXECUTE FUNCTION hon.guard_staff_profile_insert();

CREATE FUNCTION hon.guard_staff_revision_insert() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE current_version integer; target uuid; subject text;
BEGIN
 PERFORM hon.validate_staff_planning_input(NEW.kind,NEW.payload);
 SELECT principal_id INTO target FROM hon.staff_profiles WHERE id=NEW.profile_id AND organization_id=NEW.organization_id AND school_id=NEW.school_id FOR UPDATE;
 IF target IS NULL OR NEW.organization_id IS DISTINCT FROM hon.current_organization_id() OR NEW.school_id IS DISTINCT FROM hon.current_school_id()
 OR NEW.actor_principal_id::text IS DISTINCT FROM current_setting('app.hon_principal_id',true) OR NEW.request_id::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
 OR NEW.timezone IS DISTINCT FROM (SELECT timezone FROM hon.schools WHERE id=NEW.school_id) THEN RAISE EXCEPTION 'INVALID_STAFF_REVISION' USING ERRCODE='23514'; END IF;
 SELECT u.external_subject INTO subject FROM hon.users u JOIN hon.principals p ON p.user_id=u.id WHERE p.id=NEW.actor_principal_id;
 PERFORM hon.require_staff_planning_actor(subject,target,NEW.kind);
 SELECT coalesce(max(version),0) INTO current_version FROM hon.staff_planning_revisions WHERE profile_id=NEW.profile_id AND kind=NEW.kind;
 IF NEW.version<>current_version+1 OR (NEW.payload->>'expectedVersion')::integer<>current_version THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER staff_revision_insert_guard BEFORE INSERT ON hon.staff_planning_revisions FOR EACH ROW EXECUTE FUNCTION hon.guard_staff_revision_insert();

CREATE FUNCTION hon.save_staff_planning_revision(p_subject text,p_target uuid,p_kind text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; target uuid; profile uuid;
 previous hon.staff_planning_requests%ROWTYPE; fp text; result jsonb; prior jsonb; current_version integer; action text; evidence jsonb;
BEGIN
 target:=coalesce(p_target,nullif(current_setting('app.hon_principal_id',true),'')::uuid);
 IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
 OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 PERFORM hon.validate_staff_planning_input(p_kind,p_input);
 actor:=hon.lock_staff_planning_actor(p_subject,target,p_kind);
 fp:=encode(sha256(convert_to(jsonb_build_object('target',target,'kind',p_kind,'input',p_input)::text,'UTF8')),'hex');
 SELECT * INTO previous FROM hon.staff_planning_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key;
 IF FOUND THEN
  IF previous.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  PERFORM hon.require_staff_planning_actor(p_subject,target,p_kind);
  RETURN jsonb_build_object('revision',previous.response,'replayed',true);
 END IF;
 SELECT id INTO profile FROM hon.staff_profiles WHERE organization_id=org AND school_id=school AND principal_id=target FOR UPDATE;
 SELECT coalesce(max(version),0) INTO current_version FROM hon.staff_planning_revisions WHERE profile_id=profile AND kind=p_kind;
 IF current_version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
 IF profile IS NULL THEN
  INSERT INTO hon.staff_profiles(organization_id,school_id,principal_id,created_by_principal_id) VALUES(org,school,target,actor) RETURNING id INTO profile;
 END IF;
 prior:=CASE WHEN current_version>0 THEN jsonb_build_object('version',current_version) ELSE NULL END;
 INSERT INTO hon.staff_planning_revisions(profile_id,organization_id,school_id,kind,version,actor_principal_id,source,request_id,timezone,payload)
 SELECT profile,org,school,p_kind,current_version+1,actor,'HUMAN_UI',p_request,s.timezone,p_input FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
 result:=hon.staff_revision_summary(profile,p_kind,current_version+1);
 actor:=hon.require_staff_planning_actor(p_subject,target,p_kind);
 action:=CASE WHEN p_kind='QUALIFICATIONS' THEN 'staff.qualification.manage' WHEN actor=target AND hon.staff_has_planning_permission(actor,org,school,'staff.availability.self_manage') THEN 'staff.availability.self_manage' ELSE 'staff.availability.manage' END;
 evidence:=jsonb_build_object('profileId',profile,'kind',p_kind,'version',current_version+1,'status',p_input->>'status','planningOnly',true,'internalOnly',true);
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
 VALUES(org,school,actor,'HUMAN_UI',action,'STAFF_PLANNING',profile,prior,evidence,'SUCCEEDED',p_request,p_correlation);
 INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
 VALUES(org,school,'staff.planning.human_revised',1,CASE p_kind WHEN 'AVAILABILITY' THEN 'STAFF_AVAILABILITY' ELSE 'STAFF_QUALIFICATIONS' END,profile,current_version+1,p_correlation,p_request,evidence);
 INSERT INTO hon.staff_planning_requests(organization_id,school_id,principal_id,idempotency_key,fingerprint,response) VALUES(org,school,actor,p_key,fp,result);
 RETURN jsonb_build_object('revision',result,'replayed',false);
END $$;
CREATE FUNCTION hon.read_staff_availability(p_subject text,p_target uuid,p_kind text,p_version integer) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; target uuid; profile uuid; result jsonb; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); availability_access boolean; qualification_access boolean;
BEGIN
 IF (p_kind IS NULL)<>(p_version IS NULL) OR (p_kind IS NOT NULL AND (p_kind NOT IN('AVAILABILITY','QUALIFICATIONS') OR p_version NOT BETWEEN 1 AND 999999999)) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 target:=coalesce(p_target,nullif(current_setting('app.hon_principal_id',true),'')::uuid);
 actor:=hon.lock_staff_planning_actor(p_subject,target,'READ');
 availability_access:=actor=target OR hon.staff_has_planning_permission(actor,org,school,'staff.availability.manage');
 qualification_access:=actor=target OR hon.staff_has_planning_permission(actor,org,school,'staff.qualification.manage');
 SELECT id INTO profile FROM hon.staff_profiles WHERE organization_id=org AND school_id=school AND principal_id=target;
 IF p_kind IS NOT NULL THEN
  IF (p_kind='AVAILABILITY' AND NOT availability_access) OR (p_kind='QUALIFICATIONS' AND NOT qualification_access) THEN RAISE EXCEPTION 'STAFF_PLANNING_FORBIDDEN' USING ERRCODE='42501'; END IF;
  result:=hon.staff_revision_summary(profile,p_kind,p_version);
  IF result IS NULL THEN RAISE EXCEPTION 'STAFF_REVISION_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 ELSE
  SELECT jsonb_build_object('profileId',profile,'principalId',target,'schoolId',school,'timezone',s.timezone,'own',actor=target,'planningOnly',true,
   'canManageAvailability',hon.staff_has_planning_permission(actor,org,school,'staff.availability.manage') OR (actor=target AND hon.staff_has_planning_permission(actor,org,school,'staff.availability.self_manage')),
   'canManageQualifications',hon.staff_has_planning_permission(actor,org,school,'staff.qualification.manage'),
   'availability',CASE WHEN availability_access THEN hon.staff_revision_summary(profile,'AVAILABILITY',NULL) ELSE NULL END,
   'qualifications',CASE WHEN qualification_access THEN hon.staff_revision_summary(profile,'QUALIFICATIONS',NULL) ELSE NULL END) INTO result FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
 END IF;
 PERFORM hon.require_staff_planning_actor(p_subject,target,'READ');
 RETURN result;
END $$;

REVOKE ALL ON TABLE hon.staff_profiles,hon.staff_planning_revisions,hon.staff_planning_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_staff_planning_history(),hon.validate_staff_planning_input(text,jsonb),hon.staff_member_eligible(uuid,uuid,uuid),hon.staff_has_planning_permission(uuid,uuid,uuid,text),hon.require_staff_planning_actor(text,uuid,text),hon.lock_staff_planning_actor(text,uuid,text),hon.staff_revision_summary(uuid,text,integer),hon.guard_staff_profile_insert(),hon.guard_staff_revision_insert(),hon.resolve_staff_availability_scope(text,text),hon.save_staff_planning_revision(text,uuid,text,jsonb,text,uuid,uuid),hon.read_staff_availability(text,uuid,text,integer) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.staff_profiles,hon.staff_planning_revisions,hon.staff_planning_requests FROM %I',r);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_staff_planning_history(),hon.validate_staff_planning_input(text,jsonb),hon.staff_member_eligible(uuid,uuid,uuid),hon.staff_has_planning_permission(uuid,uuid,uuid,text),hon.require_staff_planning_actor(text,uuid,text),hon.lock_staff_planning_actor(text,uuid,text),hon.staff_revision_summary(uuid,text,integer),hon.guard_staff_profile_insert(),hon.guard_staff_revision_insert(),hon.resolve_staff_availability_scope(text,text),hon.save_staff_planning_revision(text,uuid,text,jsonb,text,uuid,uuid),hon.read_staff_availability(text,uuid,text,integer) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.resolve_staff_availability_scope(text,text),hon.save_staff_planning_revision(text,uuid,text,jsonb,text,uuid,uuid),hon.read_staff_availability(text,uuid,text,integer) TO hon_runtime;
 END IF;
END $$;
COMMIT;
