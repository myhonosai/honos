BEGIN;

DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'Revenue planning requires a trusted migration owner'; END IF;
END $$;
INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable)
 VALUES('planning.revenue.manage','Human-only school recurring revenue plans and safe aggregate funnel evidence',true,true);
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
 SELECT id,organization_id,'planning.revenue.manage' FROM hon.roles WHERE is_system_role AND code='OWNER' ON CONFLICT DO NOTHING;

CREATE TABLE hon.revenue_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 version integer NOT NULL CHECK(version BETWEEN 1 AND 999999999),
 algorithm_version text NOT NULL CHECK(algorithm_version='school-revenue-v1'), input jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id), UNIQUE(id,organization_id,school_id)
);
CREATE TABLE hon.revenue_plan_versions (
 plan_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL, version integer NOT NULL,
 actor_principal_id uuid NOT NULL REFERENCES hon.principals(id), source text NOT NULL CHECK(source='HUMAN_UI'),
 request_id uuid NOT NULL, snapshot jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(plan_id,version),
 FOREIGN KEY(plan_id,organization_id,school_id) REFERENCES hon.revenue_plans(id,organization_id,school_id)
);
CREATE TABLE hon.revenue_plan_requests (
 organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200), fingerprint text NOT NULL,
 response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,school_id,principal_id,idempotency_key),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id)
);
CREATE INDEX revenue_plans_scope_idx ON hon.revenue_plans(organization_id,school_id,created_at,id);
ALTER TABLE hon.revenue_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.revenue_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.revenue_plan_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.revenue_plan_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.revenue_plan_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.revenue_plan_requests FORCE ROW LEVEL SECURITY;
-- No policies: private records remain invisible even after an accidental grant.
CREATE FUNCTION hon.guard_revenue_plan_history() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_REVENUE_PLAN_HISTORY' USING ERRCODE='42501'; END $$;
CREATE TRIGGER revenue_versions_immutable BEFORE UPDATE OR DELETE ON hon.revenue_plan_versions FOR EACH ROW EXECUTE FUNCTION hon.guard_revenue_plan_history();
CREATE TRIGGER revenue_requests_immutable BEFORE UPDATE OR DELETE ON hon.revenue_plan_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_revenue_plan_history();
CREATE TRIGGER revenue_versions_no_truncate BEFORE TRUNCATE ON hon.revenue_plan_versions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_revenue_plan_history();
CREATE TRIGGER revenue_requests_no_truncate BEFORE TRUNCATE ON hon.revenue_plan_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_revenue_plan_history();

CREATE FUNCTION hon.validate_revenue_plan_input(p jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
DECLARE k text; v jsonb; tf timestamptz; tt timestamptz; hf timestamptz; ht timestamptz;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x NOT IN('expectedVersion','targetMonthlyMinor','currency','targetFrom','targetTo','historyFrom','historyTo','baselineMethod','assumptions'))
  OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->>'expectedVersion') !~ '^(0|[1-9][0-9]{0,8})$' OR (p->>'expectedVersion')::numeric>999999998
  OR jsonb_typeof(p->'targetMonthlyMinor') IS DISTINCT FROM 'number' OR (p->>'targetMonthlyMinor') !~ '^(0|[1-9][0-9]{0,12})$' OR (p->>'targetMonthlyMinor')::numeric>1000000000000
  OR jsonb_typeof(p->'currency') IS DISTINCT FROM 'string' OR (p->>'currency') !~ '^[A-Z]{3}$'
  OR jsonb_typeof(p->'baselineMethod') IS DISTINCT FROM 'string' OR (p->>'baselineMethod') NOT IN('CURRENT_MONTHLY_SCHEDULES','ZERO_BASELINE')
  OR jsonb_typeof(p->'assumptions') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 FOR k IN SELECT unnest(ARRAY['targetFrom','targetTo','historyFrom','historyTo']) LOOP
  IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR (p->>k) !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
   OR to_char((p->>k)::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>p->>k THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END LOOP;
 tf:=(p->>'targetFrom')::timestamptz; tt:=(p->>'targetTo')::timestamptz;
 hf:=(p->>'historyFrom')::timestamptz; ht:=(p->>'historyTo')::timestamptz;
 IF tt-tf<interval '1 day' OR tt-tf>interval '366 days' OR ht-hf<interval '1 day' OR ht-hf>interval '92 days' OR ht>clock_timestamp() THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 FOR k,v IN SELECT * FROM jsonb_each(p->'assumptions') LOOP
  IF jsonb_typeof(v) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF k='newMembershipMonthlyMinor' THEN
   IF v::text !~ '^(0|[1-9][0-9]{0,12})$' OR v::text::numeric>1000000000000 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  ELSIF k='activitiesPerLead' THEN
   IF v::text !~ '^(0|[1-9][0-9]{0,3})$' OR v::text::numeric>1000 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  ELSIF k IN('trialToMembership','appointmentToTrial','leadToAppointment') THEN
   IF v::text !~ '^(0|1)(\.[0-9]{1,6})?$' OR v::text::numeric>1 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  ELSE RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END LOOP;
END $$;
ALTER TABLE hon.revenue_plans ADD CONSTRAINT revenue_plan_input_object CHECK(jsonb_typeof(input)='object' AND NOT (input ? 'expectedVersion'));
CREATE FUNCTION hon.guard_revenue_plan() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
 IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'IMMUTABLE_REVENUE_PLAN_IDENTITY' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 OR NEW.algorithm_version<>OLD.algorithm_version OR NEW.input->>'currency'<>OLD.input->>'currency') THEN
  RAISE EXCEPTION 'IMMUTABLE_REVENUE_PLAN_IDENTITY' USING ERRCODE='22023'; END IF;
 PERFORM hon.validate_revenue_plan_input(NEW.input||jsonb_build_object('expectedVersion',NEW.version-1));
 RETURN NEW;
END $$;
CREATE TRIGGER revenue_plan_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.revenue_plans FOR EACH ROW EXECUTE FUNCTION hon.guard_revenue_plan();
CREATE TRIGGER revenue_plans_no_truncate BEFORE TRUNCATE ON hon.revenue_plans FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_revenue_plan();

CREATE FUNCTION hon.require_revenue_planning_actor(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid;
BEGIN
 IF current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
  OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'HUMAN_COMMAND_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT p.id INTO actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id
 WHERE u.external_subject=p_subject AND p.principal_type='HUMAN_USER' AND p.is_active AND p.id::text=current_setting('app.hon_principal_id',true)
  AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active AND x.principal_type='HUMAN_USER')=1;
 IF actor IS NULL OR NOT EXISTS(
  SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
  JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
  JOIN hon.schools s ON s.id=g.school_id AND s.organization_id=g.organization_id JOIN hon.organizations o ON o.id=s.organization_id
  WHERE g.principal_id=actor AND g.organization_id=hon.current_organization_id() AND g.school_id=hon.current_school_id()
   AND rp.permission_code='planning.revenue.manage' AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp()
   AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()) AND s.status='ACTIVE' AND o.status='ACTIVE'
   AND (r.management_school_id IS NULL OR r.management_school_id=s.id)
 ) OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements WHERE organization_id=hon.current_organization_id()
  AND tier IN('ESSENTIAL','CORE','COMPLETE') AND status='ACTIVE' AND effective_from<=clock_timestamp()
  AND (effective_until IS NULL OR effective_until>clock_timestamp())) THEN RAISE EXCEPTION 'REVENUE_PLANNING_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;
CREATE FUNCTION hon.lock_revenue_planning_actor(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
 -- Same IAM serialization order as human curriculum and staff-role administration.
 PERFORM 1 FROM hon.organizations WHERE id=org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'REVENUE_PLANNING_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'REVENUE_PLANNING_FORBIDDEN' USING ERRCODE='42501'; END IF;
 actor:=hon.require_revenue_planning_actor(p_subject);
 PERFORM 1 FROM hon.users WHERE id IN(SELECT user_id FROM hon.principals WHERE id=actor) FOR UPDATE;
 PERFORM 1 FROM hon.principals WHERE id=actor FOR UPDATE;
 PERFORM 1 FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.role_permissions WHERE role_id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY role_id,permission_code FOR SHARE;
 PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=org FOR SHARE;
 RETURN hon.require_revenue_planning_actor(p_subject);
END $$;

-- Summary only. No people, invoice, payment, attribution, notes, payer IDs or account references selected.
CREATE FUNCTION hon.revenue_plan_snapshot(p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); p hon.revenue_plans%ROWTYPE;
 asof timestamptz:=clock_timestamp(); hf timestamptz; ht timestamptz; monthly numeric; eligible bigint; active bigint;
 leads bigint; booked bigint; completed bigint; ambiguous bigint; evidence jsonb; result jsonb;
BEGIN
 SELECT * INTO p FROM hon.revenue_plans WHERE id=p_id AND organization_id=org AND school_id=school;
 IF NOT FOUND THEN RAISE EXCEPTION 'REVENUE_PLAN_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 hf:=(p.input->>'historyFrom')::timestamptz; ht:=(p.input->>'historyTo')::timestamptz;
 WITH memberships AS MATERIALIZED(
  SELECT m.id,m.term_started_at,m.term_ends_at,b.currency account_currency,
   (SELECT count(*) FROM hon.membership_payment_schedules s WHERE s.membership_id=m.id AND s.organization_id=org AND s.school_id=school AND s.status='ACTIVE') active_schedules
  FROM hon.memberships m LEFT JOIN hon.billing_accounts b ON b.id=m.billing_account_id AND b.organization_id=org AND b.school_id=school
  WHERE m.organization_id=org AND m.school_id=school AND m.state='ACTIVE'
 ), eligible AS MATERIALIZED(
  SELECT s.amount_minor FROM memberships m JOIN hon.membership_payment_schedules s ON s.membership_id=m.id AND s.organization_id=org AND s.school_id=school
  WHERE m.active_schedules=1 AND s.status='ACTIVE' AND s.frequency='MONTHLY' AND s.auto_renew
   AND s.currency=p.input->>'currency' AND m.account_currency=p.input->>'currency'
   AND m.term_started_at<=asof AND (m.term_ends_at IS NULL OR m.term_ends_at>asof)
 ), cohort AS MATERIALIZED(
  SELECT l.id, a.n,a.unresolved,a.completed FROM hon.crm_leads l
  CROSS JOIN LATERAL(SELECT count(*) n,count(*) FILTER(WHERE status='SCHEDULED') unresolved,count(*) FILTER(WHERE status='COMPLETED') completed
   FROM hon.crm_appointments a WHERE a.crm_lead_id=l.id AND a.organization_id=org AND a.school_id=school AND a.appointment_type='TRIAL'
    AND a.starts_at>=l.created_at AND a.starts_at>=hf AND a.starts_at<ht) a
  WHERE l.organization_id=org AND l.school_id=school AND l.created_at>=hf AND l.created_at<ht
 ) SELECT (SELECT count(*) FROM memberships),(SELECT count(*) FROM eligible),(SELECT coalesce(sum(amount_minor::numeric),0) FROM eligible),
  count(*),count(*) FILTER(WHERE c.n=1 AND c.unresolved=0),count(*) FILTER(WHERE c.n=1 AND c.unresolved=0 AND c.completed=1),count(*) FILTER(WHERE c.n>1 OR c.unresolved>0)
 INTO active,eligible,monthly,leads,booked,completed,ambiguous FROM cohort c;
 IF greatest(monthly,active,eligible,leads,booked,completed,ambiguous)>9007199254740991 THEN RAISE EXCEPTION 'REVENUE_EVIDENCE_LIMIT' USING ERRCODE='22003'; END IF;
 evidence:=jsonb_build_object('currency',p.input->>'currency','asOf',to_char(asof AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'from',p.input->>'historyFrom','to',p.input->>'historyTo',
  'eligibleMonthlyMinor',monthly,'eligibleMemberships',eligible,'activeMemberships',active,'excludedMemberships',active-eligible,
  'leads',leads,'bookedTrialLeads',booked,'completedTrialLeads',completed,'ambiguousTrialLeads',ambiguous);
 result:=jsonb_build_object('plan',jsonb_build_object('id',p.id,'version',p.version,'algorithmVersion',p.algorithm_version,'input',p.input),'evidence',evidence);
 RETURN result||jsonb_build_object('snapshotHash',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
END $$;

CREATE FUNCTION hon.save_revenue_plan(p_subject text,p_id uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; p hon.revenue_plans%ROWTYPE;
 previous hon.revenue_plan_requests%ROWTYPE; fp text; result jsonb; expected integer; action text;
BEGIN
 IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]' OR p_request IS NULL OR p_correlation IS NULL
  OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 PERFORM hon.validate_revenue_plan_input(p_input);
 actor:=hon.lock_revenue_planning_actor(p_subject);
 fp:=encode(sha256(convert_to(jsonb_build_object('id',p_id,'input',p_input)::text,'UTF8')),'hex');
 SELECT * INTO previous FROM hon.revenue_plan_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key;
 IF FOUND THEN
  IF previous.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('snapshot',previous.response,'replayed',true);
 END IF;
 expected:=(p_input->>'expectedVersion')::integer;
 IF p_id IS NULL THEN
  IF expected<>0 OR (SELECT count(*) FROM hon.revenue_plans WHERE organization_id=org AND school_id=school)>=50 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  INSERT INTO hon.revenue_plans(organization_id,school_id,version,algorithm_version,input) VALUES(org,school,1,'school-revenue-v1',p_input-'expectedVersion') RETURNING * INTO p;
  action:='planning.revenue.create';
 ELSE
  SELECT * INTO p FROM hon.revenue_plans WHERE id=p_id AND organization_id=org AND school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REVENUE_PLAN_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF p.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF p.input->>'currency'<>p_input->>'currency' THEN RAISE EXCEPTION 'SINGLE_CURRENCY_REQUIRED' USING ERRCODE='22023'; END IF;
  UPDATE hon.revenue_plans SET input=p_input-'expectedVersion',version=version+1,updated_at=clock_timestamp() WHERE id=p.id RETURNING * INTO p;
  action:='planning.revenue.update';
 END IF;
 result:=hon.revenue_plan_snapshot(p.id);
 actor:=hon.require_revenue_planning_actor(p_subject);
 INSERT INTO hon.revenue_plan_versions(plan_id,organization_id,school_id,version,actor_principal_id,source,request_id,snapshot) VALUES(p.id,org,school,p.version,actor,'HUMAN_UI',p_request,result);
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
 VALUES(org,school,actor,'HUMAN_UI',action,'REVENUE_PLAN',p.id,CASE WHEN expected=0 THEN NULL ELSE jsonb_build_object('version',expected) END,jsonb_build_object('version',p.version,'algorithmVersion',p.algorithm_version,'snapshotHash',result->>'snapshotHash'),'SUCCEEDED',p_request,p_correlation);
 -- Inert namespace, internal-only receipt. No consumer/action/task/provider execution.
 INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
 VALUES(org,school,'planning.revenue.human_saved',1,'REVENUE_PLAN',p.id,p.version,p_correlation,p_request,jsonb_build_object('id',p.id,'version',p.version,'internalOnly',true));
 INSERT INTO hon.revenue_plan_requests(organization_id,school_id,principal_id,idempotency_key,fingerprint,response) VALUES(org,school,actor,p_key,fp,result);
 RETURN jsonb_build_object('snapshot',result,'replayed',false);
END $$;
CREATE FUNCTION hon.read_revenue_plan(p_subject text,p_kind text,p_id uuid,p_version integer) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; result jsonb;
BEGIN
 IF p_kind IS NULL OR p_kind NOT IN('LIST','CURRENT','SAVED') OR (p_kind='LIST' AND (p_id IS NOT NULL OR p_version IS NOT NULL))
  OR (p_kind='CURRENT' AND (p_id IS NULL OR p_version IS NOT NULL)) OR (p_kind='SAVED' AND (p_id IS NULL OR p_version IS NULL OR p_version<1 OR p_version>999999999)) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 actor:=hon.lock_revenue_planning_actor(p_subject);
 IF p_kind='LIST' THEN
  SELECT coalesce(jsonb_agg(item ORDER BY created_at,id),'[]') INTO result FROM(
   SELECT id,created_at,jsonb_build_object('id',id,'version',version,'currency',input->>'currency','targetMonthlyMinor',input->'targetMonthlyMinor') item
   FROM hon.revenue_plans WHERE organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() ORDER BY created_at,id LIMIT 50
  ) safe;
 ELSIF p_kind='CURRENT' THEN result:=hon.revenue_plan_snapshot(p_id);
 ELSE
  SELECT snapshot INTO result FROM hon.revenue_plan_versions WHERE plan_id=p_id AND version=p_version AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'REVENUE_PLAN_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 END IF;
 actor:=hon.require_revenue_planning_actor(p_subject);
 RETURN result;
END $$;
REVOKE ALL ON TABLE hon.revenue_plans,hon.revenue_plan_versions,hon.revenue_plan_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.validate_revenue_plan_input(jsonb),hon.guard_revenue_plan(),hon.guard_revenue_plan_history(),hon.require_revenue_planning_actor(text),hon.lock_revenue_planning_actor(text),hon.revenue_plan_snapshot(uuid),hon.save_revenue_plan(text,uuid,jsonb,text,uuid,uuid),hon.read_revenue_plan(text,text,uuid,integer) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.revenue_plans,hon.revenue_plan_versions,hon.revenue_plan_requests FROM %I',r);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.validate_revenue_plan_input(jsonb),hon.guard_revenue_plan(),hon.guard_revenue_plan_history(),hon.require_revenue_planning_actor(text),hon.lock_revenue_planning_actor(text),hon.revenue_plan_snapshot(uuid),hon.save_revenue_plan(text,uuid,jsonb,text,uuid,uuid),hon.read_revenue_plan(text,text,uuid,integer) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.save_revenue_plan(text,uuid,jsonb,text,uuid,uuid),hon.read_revenue_plan(text,text,uuid,integer) TO hon_runtime;
 END IF;
END $$;
COMMIT;
