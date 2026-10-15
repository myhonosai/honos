BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Trusted renewal migration owner required'; END IF;
END $$;
INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
 ('billing.membership.read','Human read of a known school membership safe summary',true,true),
 ('billing.renewal.manage','Human shared school finance renewal review records only',true,true);
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
 SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN hon.permissions p
 WHERE r.is_system_role AND r.code='OWNER' AND p.code IN('billing.membership.read','billing.renewal.manage') ON CONFLICT DO NOTHING;
CREATE TABLE hon.membership_renewal_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL, membership_id uuid NOT NULL,
 created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,organization_id,school_id), FOREIGN KEY(membership_id,organization_id,school_id) REFERENCES hon.memberships(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE INDEX membership_renewal_scope ON hon.membership_renewal_reviews(organization_id,school_id,id);
CREATE TABLE hon.membership_renewal_versions (
 renewal_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
 version integer NOT NULL CHECK(version BETWEEN 1 AND 999999999),
 review_from timestamptz NOT NULL, review_to timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN('OPEN','REVIEWED','DEFERRED','CLOSED')),
 note text NOT NULL CHECK(length(note) BETWEEN 1 AND 2000), reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500), reminder_needed boolean,
 membership_facts jsonb NOT NULL CHECK(jsonb_typeof(membership_facts)='object'),
 operation text NOT NULL CHECK(operation IN('CREATE','REVISE')), actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 source text NOT NULL CHECK(source='HUMAN_UI'), request_id uuid NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(renewal_id,version), FOREIGN KEY(renewal_id,organization_id,school_id) REFERENCES hon.membership_renewal_reviews(id,organization_id,school_id) ON DELETE RESTRICT,
 CHECK(review_from>=timestamptz '2000-01-01T00:00:00Z' AND review_to<timestamptz '2100-01-01T00:00:00Z'
 AND review_to-review_from BETWEEN interval '1 minute' AND interval '366 days')
);
CREATE TABLE hon.membership_renewal_requests (
 organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200), fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 response jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,school_id,principal_id,idempotency_key), FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
ALTER TABLE hon.membership_renewal_reviews ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.membership_renewal_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_renewal_versions ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.membership_renewal_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_renewal_requests ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.membership_renewal_requests FORCE ROW LEVEL SECURITY;
-- Deliberately no policies or runtime table/column grants. Only fixed trusted boundaries.
CREATE FUNCTION hon.guard_renewal_history() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_RENEWAL_HISTORY' USING ERRCODE='42501'; END $$;
CREATE TRIGGER renewal_reviews_immutable BEFORE UPDATE OR DELETE ON hon.membership_renewal_reviews FOR EACH ROW EXECUTE FUNCTION hon.guard_renewal_history();
CREATE TRIGGER renewal_reviews_no_truncate BEFORE TRUNCATE ON hon.membership_renewal_reviews FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_renewal_history();
CREATE TRIGGER renewal_versions_immutable BEFORE UPDATE OR DELETE ON hon.membership_renewal_versions FOR EACH ROW EXECUTE FUNCTION hon.guard_renewal_history();
CREATE TRIGGER renewal_versions_no_truncate BEFORE TRUNCATE ON hon.membership_renewal_versions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_renewal_history();
CREATE TRIGGER renewal_requests_immutable BEFORE UPDATE OR DELETE ON hon.membership_renewal_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_renewal_history();
CREATE TRIGGER renewal_requests_no_truncate BEFORE TRUNCATE ON hon.membership_renewal_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_renewal_history();
CREATE FUNCTION hon.validate_renewal_input(op text,p jsonb) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE keys text[]:=ARRAY['expectedVersion','membershipId','reviewFrom','reviewTo','status','note','reason','reminderNeeded']; k text; v text; duration interval;
BEGIN
 IF op IS NULL OR op NOT IN('CREATE','REVISE') OR jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p))<>cardinality(keys) OR NOT p ?& keys
 OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR p->>'expectedVersion' !~ '^(0|[1-9][0-9]{0,8})$'
 OR (p->>'expectedVersion')::numeric NOT BETWEEN (CASE WHEN op='CREATE' THEN 0 ELSE 1 END) AND 999999998
 OR (op='CREATE' AND p->>'expectedVersion'<>'0') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(p->'membershipId') IS DISTINCT FROM 'string' OR p->>'membershipId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 FOR k IN SELECT unnest(ARRAY['reviewFrom','reviewTo']) LOOP
  v:=p->>k;
  IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR v !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  OR to_char(v::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>v THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END LOOP;
 duration:=(p->>'reviewTo')::timestamptz-(p->>'reviewFrom')::timestamptz;
 IF duration NOT BETWEEN interval '1 minute' AND interval '366 days' OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string'
 OR p->>'status' NOT IN('OPEN','REVIEWED','DEFERRED','CLOSED') OR (op='CREATE' AND p->>'status'<>'OPEN') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 FOR k IN SELECT unnest(ARRAY['note','reason']) LOOP
  v:=p->>k;
  IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR length(v) NOT BETWEEN 1 AND (CASE WHEN k='note' THEN 2000 ELSE 500 END)
  OR btrim(v,E' \t\n\r'||chr(11)||chr(12)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288))<>v
  OR (CASE WHEN k='note' THEN replace(v,E'\n','') ELSE v END) ~ '[[:cntrl:]\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF jsonb_typeof(p->'reminderNeeded') NOT IN('boolean','null') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
END $$;
CREATE FUNCTION hon.renewal_has_permission(actor uuid,org uuid,school uuid,permission text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT permission IN('billing.membership.read','billing.renewal.manage') AND hon.staff_member_eligible(actor,org,school) AND EXISTS(
 SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
 JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
 WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school AND rp.permission_code=permission
 AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
 AND (r.management_school_id IS NULL OR r.management_school_id=school) AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
$$;
CREATE FUNCTION hon.resolve_renewal_scope(subject text) RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 WITH candidates AS(SELECT DISTINCT p.id principal_id,g.organization_id,g.school_id FROM hon.users u JOIN hon.principals p ON p.user_id=u.id JOIN hon.principal_role_grants g ON g.principal_id=p.id
 WHERE u.external_subject=subject AND hon.renewal_has_permission(p.id,g.organization_id,g.school_id,'billing.membership.read')
 AND hon.renewal_has_permission(p.id,g.organization_id,g.school_id,'billing.renewal.manage')
 AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=g.organization_id AND e.tier IN('ESSENTIAL','CORE','COMPLETE') AND e.status='ACTIVE' AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp())))
 SELECT * FROM candidates WHERE (SELECT count(*) FROM candidates)=1
$$;
CREATE FUNCTION hon.require_renewal_actor(subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
 IF current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
 OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'HUMAN_UI_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT p.id INTO actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=subject AND p.id::text=current_setting('app.hon_principal_id',true);
 IF actor IS NULL OR NOT hon.renewal_has_permission(actor,org,school,'billing.membership.read') OR NOT hon.renewal_has_permission(actor,org,school,'billing.renewal.manage')
 OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements WHERE organization_id=org AND tier IN('ESSENTIAL','CORE','COMPLETE') AND status='ACTIVE' AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp())) THEN RAISE EXCEPTION 'RENEWAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;
CREATE FUNCTION hon.lock_renewal_actor(subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
 -- Stable order also serializes review receipts and protects live grant insertion/revocation.
 PERFORM 1 FROM hon.organizations WHERE id=org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RENEWAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RENEWAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
 actor:=hon.require_renewal_actor(subject);
 PERFORM 1 FROM hon.users WHERE id IN(SELECT user_id FROM hon.principals WHERE id=actor) FOR UPDATE;
 PERFORM 1 FROM hon.principals WHERE id=actor FOR UPDATE;
 PERFORM 1 FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.role_permissions WHERE role_id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY role_id,permission_code FOR SHARE;
 PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=org FOR SHARE;
 RETURN hon.require_renewal_actor(subject);
END $$;
CREATE FUNCTION hon.renewal_membership_facts(p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE m hon.memberships%ROWTYPE; a hon.billing_accounts%ROWTYPE; schedules jsonb; n integer;
BEGIN
 SELECT * INTO m FROM hon.memberships WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 -- Payer and participant are scoped integrity only, never actor authority or projected identity.
 SELECT * INTO a FROM hon.billing_accounts WHERE id=m.billing_account_id AND organization_id=m.organization_id AND school_id=m.school_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 PERFORM 1 FROM hon.people WHERE id IN(a.responsible_person_id,m.participant_person_id) AND organization_id=m.organization_id AND school_id=m.school_id ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.membership_payment_schedules WHERE membership_id=p_id AND organization_id=m.organization_id AND school_id=m.school_id ORDER BY id FOR SHARE;
 IF (m.term_started_at IS NOT NULL AND (m.term_started_at<timestamptz '0001-01-01T00:00:00Z' OR m.term_started_at>=timestamptz '10000-01-01T00:00:00Z')) OR (m.term_ends_at IS NOT NULL AND (m.term_ends_at<timestamptz '0001-01-01T00:00:00Z' OR m.term_ends_at>=timestamptz '10000-01-01T00:00:00Z'))
 OR EXISTS(SELECT 1 FROM hon.membership_payment_schedules WHERE membership_id=p_id AND organization_id=m.organization_id AND school_id=m.school_id AND (currency !~ '^[A-Z]{3}$' OR (next_charge_at IS NOT NULL AND (next_charge_at<timestamptz '0001-01-01T00:00:00Z' OR next_charge_at>=timestamptz '10000-01-01T00:00:00Z')))) THEN RAISE EXCEPTION 'UNSUPPORTED_MEMBERSHIP_FACTS' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO n FROM hon.membership_payment_schedules WHERE membership_id=p_id AND organization_id=m.organization_id AND school_id=m.school_id;
 SELECT coalesce(jsonb_agg(x.fact ORDER BY x.id),'[]'::jsonb) INTO schedules FROM (
  SELECT id,jsonb_build_object('scheduleId',id,'frequency',frequency,'status',status,'amountMinor',amount_minor,'currency',currency,'nextChargeAt',CASE WHEN next_charge_at IS NULL THEN NULL ELSE to_char(next_charge_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,'autoRenew',auto_renew) fact
  FROM hon.membership_payment_schedules WHERE membership_id=p_id AND organization_id=m.organization_id AND school_id=m.school_id ORDER BY id LIMIT 20
 ) x;
 RETURN jsonb_build_object('membershipId',m.id,'membershipVersion',m.version,'state',m.state,
 'termStartedAt',CASE WHEN m.term_started_at IS NULL THEN NULL ELSE to_char(m.term_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
 'termEndsAt',CASE WHEN m.term_ends_at IS NULL THEN NULL ELSE to_char(m.term_ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
 'scheduleCount',n,'schedulesTruncated',n>20,'schedules',schedules);
END $$;
CREATE FUNCTION hon.renewal_summary(p_id uuid,v integer) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('renewalId',f.id,'schoolId',f.school_id,'membershipId',f.membership_id,'version',r.version,'status',r.status,
 'reviewFrom',to_char(r.review_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'reviewTo',to_char(r.review_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'note',r.note,'reason',r.reason,'reminderNeeded',r.reminder_needed,'recordedAt',to_char(r.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'membershipFacts',r.membership_facts,'humanOnly',true,'executionAllowed',false)
 FROM hon.membership_renewal_reviews f JOIN hon.membership_renewal_versions r ON r.renewal_id=f.id AND r.organization_id=f.organization_id AND r.school_id=f.school_id
 WHERE f.id=p_id AND f.organization_id=hon.current_organization_id() AND f.school_id=hon.current_school_id() AND (v IS NULL OR r.version=v) ORDER BY r.version DESC LIMIT 1
$$;
CREATE FUNCTION hon.guard_renewal_insert() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE subject_id text; actor uuid; prior hon.membership_renewal_versions%ROWTYPE; linked uuid; input jsonb;
BEGIN
 actor:=nullif(current_setting('app.hon_principal_id',true),'')::uuid;
 SELECT u.external_subject INTO subject_id FROM hon.users u JOIN hon.principals p ON p.user_id=u.id WHERE p.id=actor;
 PERFORM hon.require_renewal_actor(subject_id);
 IF NEW.organization_id IS DISTINCT FROM hon.current_organization_id() OR NEW.school_id IS DISTINCT FROM hon.current_school_id() THEN RAISE EXCEPTION 'INVALID_RENEWAL_SCOPE' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='membership_renewal_reviews' THEN
  IF NEW.created_by_principal_id IS DISTINCT FROM actor THEN RAISE EXCEPTION 'INVALID_RENEWAL_ACTOR' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT membership_id INTO linked FROM hon.membership_renewal_reviews WHERE id=NEW.renewal_id AND organization_id=NEW.organization_id AND school_id=NEW.school_id FOR UPDATE;
  IF linked IS NULL OR NEW.actor_principal_id IS DISTINCT FROM actor OR NEW.request_id::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN RAISE EXCEPTION 'INVALID_RENEWAL_VERSION' USING ERRCODE='23514'; END IF;
  SELECT * INTO prior FROM hon.membership_renewal_versions WHERE renewal_id=NEW.renewal_id ORDER BY version DESC LIMIT 1;
  IF NEW.version<>coalesce(prior.version,0)+1 OR (prior.version IS NULL AND NEW.operation<>'CREATE') OR (prior.version IS NOT NULL AND NEW.operation<>'REVISE') THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF prior.status='CLOSED' AND NEW.status<>'OPEN' THEN RAISE EXCEPTION 'CLOSED_REVIEW_REQUIRES_REOPEN' USING ERRCODE='40001'; END IF;
  input:=jsonb_build_object('expectedVersion',coalesce(prior.version,0),'membershipId',linked,'reviewFrom',to_char(NEW.review_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'reviewTo',to_char(NEW.review_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'status',NEW.status,'note',NEW.note,'reason',NEW.reason,'reminderNeeded',NEW.reminder_needed);
  PERFORM hon.validate_renewal_input(NEW.operation,input);
  IF NEW.membership_facts IS DISTINCT FROM hon.renewal_membership_facts(linked) THEN RAISE EXCEPTION 'INVALID_RENEWAL_FACTS' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER renewal_review_insert_guard BEFORE INSERT ON hon.membership_renewal_reviews FOR EACH ROW EXECUTE FUNCTION hon.guard_renewal_insert();
CREATE TRIGGER renewal_version_insert_guard BEFORE INSERT ON hon.membership_renewal_versions FOR EACH ROW EXECUTE FUNCTION hon.guard_renewal_insert();
CREATE FUNCTION hon.mutate_renewal(subject text,op text,p_id uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); record_id uuid:=p_id; prior hon.membership_renewal_versions%ROWTYPE;
 receipt hon.membership_renewal_requests%ROWTYPE; fp text; result jsonb; evidence jsonb; linked uuid; facts jsonb; new_version integer;
BEGIN
 PERFORM hon.validate_renewal_input(op,p);
 IF (op='CREATE')<>(p_id IS NULL) OR key IS NULL OR length(key) NOT BETWEEN 1 AND 200 OR btrim(key)<>key OR key ~ '[[:cntrl:]]'
 OR request IS NULL OR correlation IS NULL OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 actor:=hon.lock_renewal_actor(subject);
 fp:=encode(sha256(convert_to(jsonb_build_object('operation',op,'id',p_id,'input',p)::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM hon.membership_renewal_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
 IF FOUND THEN
  IF receipt.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  record_id:=(receipt.response->>'renewalId')::uuid;
 END IF;
 IF record_id IS NOT NULL THEN
  SELECT membership_id INTO linked FROM hon.membership_renewal_reviews WHERE id=record_id AND organization_id=org AND school_id=school FOR UPDATE;
  IF linked IS NULL THEN RAISE EXCEPTION 'RENEWAL_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO prior FROM hon.membership_renewal_versions WHERE renewal_id=record_id ORDER BY version DESC LIMIT 1;
  IF linked IS DISTINCT FROM (p->>'membershipId')::uuid THEN RAISE EXCEPTION 'IMMUTABLE_MEMBERSHIP_LINK' USING ERRCODE='22023'; END IF;
 ELSE linked:=(p->>'membershipId')::uuid;
 END IF;
 facts:=hon.renewal_membership_facts(linked);
 IF receipt.fingerprint IS NOT NULL THEN
  PERFORM hon.require_renewal_actor(subject);
  RETURN jsonb_build_object('renewal',receipt.response,'replayed',true);
 END IF;
 IF coalesce(prior.version,0)<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
 IF op='CREATE' THEN
  INSERT INTO hon.membership_renewal_reviews(organization_id,school_id,membership_id,created_by_principal_id) VALUES(org,school,linked,actor) RETURNING id INTO record_id;
 END IF;
 new_version:=coalesce(prior.version,0)+1;
 INSERT INTO hon.membership_renewal_versions(renewal_id,organization_id,school_id,version,review_from,review_to,status,note,reason,reminder_needed,membership_facts,operation,actor_principal_id,source,request_id)
 VALUES(record_id,org,school,new_version,(p->>'reviewFrom')::timestamptz,(p->>'reviewTo')::timestamptz,p->>'status',p->>'note',p->>'reason',(p->>'reminderNeeded')::boolean,facts,op,actor,'HUMAN_UI',request);
 result:=hon.renewal_summary(record_id,new_version);
 evidence:=jsonb_build_object('renewalId',record_id,'version',new_version,'operation',op,'status',p->>'status','humanOnly',true,'internalOnly',true,'executionAllowed',false);
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
 VALUES(org,school,actor,'HUMAN_UI','billing.renewal.manage','MEMBERSHIP_RENEWAL_REVIEW',record_id,CASE WHEN new_version=1 THEN NULL ELSE jsonb_build_object('version',new_version-1) END,evidence,'SUCCEEDED',request,correlation);
 INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
 VALUES(org,school,'billing.renewal.human_revised',1,'MEMBERSHIP_RENEWAL_REVIEW',record_id,new_version,correlation,request,evidence);
 INSERT INTO hon.membership_renewal_requests(organization_id,school_id,principal_id,idempotency_key,fingerprint,response) VALUES(org,school,actor,key,fp,result);
 PERFORM hon.require_renewal_actor(subject);
 RETURN jsonb_build_object('renewal',result,'replayed',false);
END $$;
CREATE FUNCTION hon.read_renewals(subject text,p_id uuid,state text,after_id uuid,p_version integer) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; result jsonb; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); linked uuid; items jsonb;
BEGIN
 IF state IS NULL OR state NOT IN('OPEN','REVIEWED','DEFERRED','CLOSED','ALL') OR (p_id IS NOT NULL AND after_id IS NOT NULL) OR (p_version IS NOT NULL AND (p_id IS NULL OR p_version NOT BETWEEN 1 AND 999999999)) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 actor:=hon.lock_renewal_actor(subject);
 IF p_id IS NOT NULL THEN
  SELECT membership_id INTO linked FROM hon.membership_renewal_reviews WHERE id=p_id AND organization_id=org AND school_id=school;
  IF linked IS NULL THEN RAISE EXCEPTION 'RENEWAL_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  result:=hon.renewal_summary(p_id,p_version);
  IF result IS NULL THEN RAISE EXCEPTION 'RENEWAL_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  result:=jsonb_build_object('record',result,'currentMembershipFacts',hon.renewal_membership_facts(linked));
 ELSE
  SELECT coalesce(jsonb_agg(x.item ORDER BY x.id),'[]'::jsonb) INTO items FROM (
   SELECT f.id,jsonb_build_object('renewalId',f.id,'membershipId',f.membership_id,'version',r.version,'status',r.status,'reviewFrom',to_char(r.review_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'reviewTo',to_char(r.review_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'reminderNeeded',r.reminder_needed) item
   FROM hon.membership_renewal_reviews f JOIN LATERAL(SELECT * FROM hon.membership_renewal_versions WHERE renewal_id=f.id ORDER BY version DESC LIMIT 1) r ON true
   WHERE f.organization_id=org AND f.school_id=school AND (after_id IS NULL OR f.id>after_id) AND (state='ALL' OR r.status=state) ORDER BY f.id LIMIT 51
  ) x;
  result:=jsonb_build_object('schoolId',school,'principalId',actor,'humanOnly',true,'executionAllowed',false,'status',state,'items',CASE WHEN jsonb_array_length(items)>50 THEN items-50 ELSE items END,'nextAfter',CASE WHEN jsonb_array_length(items)>50 THEN items->49->>'renewalId' ELSE NULL END);
 END IF;
 PERFORM hon.require_renewal_actor(subject); RETURN result;
END $$;
CREATE FUNCTION hon.read_renewal_membership(subject text,p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE facts jsonb;
BEGIN
 IF p_id IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 PERFORM hon.lock_renewal_actor(subject); facts:=hon.renewal_membership_facts(p_id); PERFORM hon.require_renewal_actor(subject); RETURN facts;
END $$;
CREATE FUNCTION hon.read_renewal_history(subject text,p_id uuid,before_version integer) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE items jsonb; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
 IF p_id IS NULL OR (before_version IS NOT NULL AND before_version NOT BETWEEN 1 AND 999999999) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 PERFORM hon.lock_renewal_actor(subject);
 PERFORM 1 FROM hon.membership_renewal_reviews WHERE id=p_id AND organization_id=org AND school_id=school;
 IF NOT FOUND THEN RAISE EXCEPTION 'RENEWAL_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 SELECT coalesce(jsonb_agg(x.item ORDER BY x.version DESC),'[]'::jsonb) INTO items FROM (
  SELECT r.version,jsonb_build_object('renewalId',f.id,'membershipId',f.membership_id,'version',r.version,'status',r.status,'reviewFrom',to_char(r.review_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'reviewTo',to_char(r.review_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'reminderNeeded',r.reminder_needed,'recordedAt',to_char(r.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) item
  FROM hon.membership_renewal_reviews f JOIN hon.membership_renewal_versions r ON r.renewal_id=f.id AND r.organization_id=f.organization_id AND r.school_id=f.school_id
  WHERE f.id=p_id AND f.organization_id=org AND f.school_id=school AND (before_version IS NULL OR r.version<before_version) ORDER BY r.version DESC LIMIT 51
 ) x;
 PERFORM hon.require_renewal_actor(subject);
 RETURN jsonb_build_object('schoolId',school,'renewalId',p_id,'humanOnly',true,'executionAllowed',false,'items',CASE WHEN jsonb_array_length(items)>50 THEN items-50 ELSE items END,'nextBefore',CASE WHEN jsonb_array_length(items)>50 THEN (items->49->>'version')::integer ELSE NULL END);
END $$;
REVOKE ALL ON TABLE hon.membership_renewal_reviews,hon.membership_renewal_versions,hon.membership_renewal_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_renewal_history(),hon.validate_renewal_input(text,jsonb),hon.renewal_has_permission(uuid,uuid,uuid,text),hon.resolve_renewal_scope(text),hon.require_renewal_actor(text),hon.lock_renewal_actor(text),hon.renewal_membership_facts(uuid),hon.renewal_summary(uuid,integer),hon.guard_renewal_insert(),hon.mutate_renewal(text,text,uuid,jsonb,text,uuid,uuid),hon.read_renewals(text,uuid,text,uuid,integer),hon.read_renewal_membership(text,uuid),hon.read_renewal_history(text,uuid,integer) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.membership_renewal_reviews,hon.membership_renewal_versions,hon.membership_renewal_requests FROM %I',r);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_renewal_history(),hon.validate_renewal_input(text,jsonb),hon.renewal_has_permission(uuid,uuid,uuid,text),hon.resolve_renewal_scope(text),hon.require_renewal_actor(text),hon.lock_renewal_actor(text),hon.renewal_membership_facts(uuid),hon.renewal_summary(uuid,integer),hon.guard_renewal_insert(),hon.mutate_renewal(text,text,uuid,jsonb,text,uuid,uuid),hon.read_renewals(text,uuid,text,uuid,integer),hon.read_renewal_membership(text,uuid),hon.read_renewal_history(text,uuid,integer) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN GRANT EXECUTE ON FUNCTION hon.resolve_renewal_scope(text),hon.mutate_renewal(text,text,uuid,jsonb,text,uuid,uuid),hon.read_renewals(text,uuid,text,uuid,integer),hon.read_renewal_membership(text,uuid),hon.read_renewal_history(text,uuid,integer) TO hon_runtime; END IF;
END $$;
COMMIT;
