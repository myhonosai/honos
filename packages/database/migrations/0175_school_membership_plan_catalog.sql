BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'School membership plan catalog requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'School membership plan catalog requires a restricted runtime';
  END IF;
END $$;

-- School-to-family membership plans: what a school sells to its own students.
-- This is unrelated to HON's own Core/Complete SaaS catalog (0154 saas_*), and
-- nothing here creates a schedule, invoice, payment method, charge, provider
-- call, agreement, discount, communication, automation or activation. Prices
-- are published terms only. Each school starts with an empty catalog; no
-- school's policy is seeded.
INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable)
VALUES ('billing.membership_plan.manage','Publish and revise the current school''s student membership plan catalog (published terms only; no schedule, invoice, payment, charge, discount, agreement or provider effect)',true,true)
ON CONFLICT(code) DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT id,organization_id,'billing.membership_plan.manage' FROM hon.roles WHERE is_system_role AND code='OWNER'
ON CONFLICT DO NOTHING;

-- Stable plan identity. plan_code is immutable and is what hon.memberships.plan_code
-- records; only current_version moves forward, one published version at a time.
CREATE TABLE hon.membership_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  plan_code text NOT NULL CHECK (plan_code ~ '^[A-Z0-9][A-Z0-9_-]{0,39}$'),
  current_version integer NOT NULL CHECK (current_version>=1),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,organization_id,school_id),
  UNIQUE(organization_id,school_id,plan_code),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);

-- Immutable published terms. A price change is a new version; earlier versions
-- and every membership bound to them keep their exact terms.
CREATE TABLE hon.membership_plan_versions (
  plan_id uuid NOT NULL,
  version integer NOT NULL CHECK (version>=1),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120 AND btrim(display_name)=display_name AND display_name !~ '[[:cntrl:]<>]'),
  description text CHECK (description IS NULL OR (length(description) BETWEEN 1 AND 500 AND btrim(description)=description AND description !~ '[[:cntrl:]<>]')),
  program_id uuid,
  availability text NOT NULL CHECK (availability IN ('AVAILABLE','UNAVAILABLE')),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  price_minor integer NOT NULL CHECK (price_minor BETWEEN 0 AND 100000000),
  billing_frequency text NOT NULL CHECK (billing_frequency IN ('WEEKLY','MONTHLY','ANNUAL','PAID_IN_FULL')),
  term_kind text NOT NULL CHECK (term_kind IN ('OPEN_ENDED','FIXED_MONTHS')),
  term_months integer CHECK (term_months BETWEEN 1 AND 60),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(plan_id,version),
  CHECK ((term_kind='FIXED_MONTHS')=(term_months IS NOT NULL)),
  CHECK (billing_frequency<>'PAID_IN_FULL' OR term_kind='FIXED_MONTHS'),
  CHECK (billing_frequency<>'ANNUAL' OR term_kind='OPEN_ENDED' OR term_months%12=0),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY(plan_id,organization_id,school_id) REFERENCES hon.membership_plans(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(program_id,organization_id,school_id) REFERENCES hon.programs(id,organization_id,school_id) ON DELETE RESTRICT
);

-- Immutable binding from one membership to the exact plan version a human chose.
-- Memberships created by other paths (generic endpoint, Owner Launch, the
-- free-text adult DRAFT) have no row here and keep their existing semantics.
CREATE TABLE hon.membership_plan_selections (
  membership_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  plan_version integer NOT NULL,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY(membership_id,organization_id,school_id) REFERENCES hon.memberships(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(plan_id,organization_id,school_id) REFERENCES hon.membership_plans(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(plan_id,plan_version) REFERENCES hon.membership_plan_versions(plan_id,version) ON DELETE RESTRICT
);
CREATE INDEX membership_plan_selections_plan_idx ON hon.membership_plan_selections(plan_id,plan_version);

ALTER TABLE hon.membership_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_plan_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_plan_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_plan_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_plan_selections FORCE ROW LEVEL SECURITY;

-- Head: created at version 1; afterwards only current_version (+1, to an
-- existing version) and updated_at may change. Never deleted or truncated.
CREATE FUNCTION hon.guard_membership_plan() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.current_version<>1 THEN RAISE EXCEPTION 'IMMUTABLE_MEMBERSHIP_PLAN' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['current_version','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['current_version','updated_at'])
    AND NEW.current_version=OLD.current_version+1
    AND EXISTS(SELECT 1 FROM hon.membership_plan_versions v WHERE v.plan_id=NEW.id AND v.version=NEW.current_version) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_MEMBERSHIP_PLAN' USING ERRCODE='42501';
END $$;
CREATE TRIGGER membership_plan_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.membership_plans FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_plan();
CREATE TRIGGER membership_plan_no_truncate BEFORE TRUNCATE ON hon.membership_plans FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_plan();

-- Versions: append-only, gapless per plan.
CREATE FUNCTION hon.guard_membership_plan_version() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.version=coalesce((SELECT max(v.version) FROM hon.membership_plan_versions v WHERE v.plan_id=NEW.plan_id),0)+1 THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'IMMUTABLE_MEMBERSHIP_PLAN_VERSION' USING ERRCODE='42501';
END $$;
CREATE TRIGGER membership_plan_version_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.membership_plan_versions FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_plan_version();
CREATE TRIGGER membership_plan_version_no_truncate BEFORE TRUNCATE ON hon.membership_plan_versions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_plan_version();

CREATE FUNCTION hon.guard_membership_plan_selection() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_MEMBERSHIP_PLAN_SELECTION' USING ERRCODE='42501'; END $$;
CREATE TRIGGER membership_plan_selection_immutable BEFORE UPDATE OR DELETE ON hon.membership_plan_selections FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_plan_selection();
CREATE TRIGGER membership_plan_selection_no_truncate BEFORE TRUNCATE ON hon.membership_plan_selections FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_plan_selection();

-- Private identity proof for catalog management: the 0162 adult DRAFT actor
-- conditions with the billing.membership_plan.manage permission.
CREATE FUNCTION hon.require_membership_plan_manager(subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
    AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=org AND o.status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=p.id AND f.effective_from<=clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
    AND NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      WHERE g.principal_id=p.id AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND hon.staff_member_eligible(p.id,org,school)
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions permission ON permission.code=rp.permission_code
      WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND permission.code='billing.membership_plan.manage' AND permission.is_staff_assignable)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- Private closed validation of one complete set of published terms. Returns the
-- normalized terms with every key present. The program, when given, must be a
-- current-school program that is not cancelled or completed.
CREATE FUNCTION hon.membership_plan_validated_terms(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); program uuid; description text; months integer;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR NOT p ?& ARRAY['displayName','availability','currency','priceMinor','billingFrequency','termKind']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('displayName','description','programId','availability','currency','priceMinor','billingFrequency','termKind','termMonths'))
    OR jsonb_typeof(p->'displayName') IS DISTINCT FROM 'string' OR length(p->>'displayName') NOT BETWEEN 1 AND 120
    OR btrim(p->>'displayName')<>p->>'displayName' OR p->>'displayName' ~ '[[:cntrl:]<>]'
    OR (p ? 'description' AND jsonb_typeof(p->'description')<>'null' AND (jsonb_typeof(p->'description')<>'string'
      OR length(p->>'description') NOT BETWEEN 1 AND 500 OR btrim(p->>'description')<>p->>'description' OR p->>'description' ~ '[[:cntrl:]<>]'))
    OR (p ? 'programId' AND jsonb_typeof(p->'programId')<>'null' AND (jsonb_typeof(p->'programId')<>'string'
      OR p->>'programId' !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'))
    OR jsonb_typeof(p->'availability') IS DISTINCT FROM 'string' OR p->>'availability' NOT IN ('AVAILABLE','UNAVAILABLE')
    OR jsonb_typeof(p->'currency') IS DISTINCT FROM 'string' OR p->>'currency' !~ '^[A-Z]{3}$'
    OR jsonb_typeof(p->'priceMinor') IS DISTINCT FROM 'number' OR (p->'priceMinor')::text !~ '^(0|[1-9][0-9]{0,8})$' OR (p->>'priceMinor')::bigint>100000000
    OR jsonb_typeof(p->'billingFrequency') IS DISTINCT FROM 'string' OR p->>'billingFrequency' NOT IN ('WEEKLY','MONTHLY','ANNUAL','PAID_IN_FULL')
    OR jsonb_typeof(p->'termKind') IS DISTINCT FROM 'string' OR p->>'termKind' NOT IN ('OPEN_ENDED','FIXED_MONTHS') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF p->>'termKind'='FIXED_MONTHS' THEN
    IF jsonb_typeof(p->'termMonths') IS DISTINCT FROM 'number' OR (p->'termMonths')::text !~ '^[1-9][0-9]?$' OR (p->>'termMonths')::integer>60 THEN
      RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
    months:=(p->>'termMonths')::integer;
  ELSIF p ? 'termMonths' AND jsonb_typeof(p->'termMonths')<>'null' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  IF (p->>'billingFrequency'='PAID_IN_FULL' AND months IS NULL) OR (p->>'billingFrequency'='ANNUAL' AND months IS NOT NULL AND months%12<>0) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(p->'description')='string' THEN description:=p->>'description'; END IF;
  IF jsonb_typeof(p->'programId')='string' THEN
    program:=lower(p->>'programId')::uuid;
    IF NOT EXISTS(SELECT 1 FROM hon.programs x WHERE x.id=program AND x.organization_id=org AND x.school_id=school AND x.status NOT IN ('CANCELLED','COMPLETED')) THEN
      RAISE EXCEPTION 'MEMBERSHIP_PLAN_PROGRAM_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  END IF;
  RETURN jsonb_build_object('displayName',p->>'displayName','description',description,'programId',program,'availability',p->>'availability',
    'currency',p->>'currency','priceMinor',(p->>'priceMinor')::integer,'billingFrequency',p->>'billingFrequency','termKind',p->>'termKind','termMonths',months);
END $$;

-- Private exact summary of one published version (the shape every response uses).
CREATE FUNCTION hon.membership_plan_version_summary(selected_plan uuid,selected_version integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('planId',h.id,'planCode',h.plan_code,'version',v.version,'displayName',v.display_name,'description',v.description,
    'programId',v.program_id,'availability',v.availability,'currency',v.currency::text,'priceMinor',v.price_minor,'billingFrequency',v.billing_frequency,
    'termKind',v.term_kind,'termMonths',v.term_months,'publishedAt',to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM hon.membership_plans h JOIN hon.membership_plan_versions v ON v.plan_id=h.id AND v.organization_id=h.organization_id AND v.school_id=h.school_id
  WHERE h.id=selected_plan AND v.version=selected_version AND h.organization_id=hon.current_organization_id() AND h.school_id=hon.current_school_id()
$$;

-- Catalog management read: every plan at its current version, plus the
-- school's selectable programs. No locks: a stale read is harmless because
-- every command re-verifies the exact version it was given.
CREATE FUNCTION hon.read_school_membership_plan_catalog(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); result jsonb;
BEGIN
  PERFORM hon.require_membership_plan_manager(subject);
  SELECT jsonb_build_object(
    'plans',coalesce((SELECT jsonb_agg(hon.membership_plan_version_summary(h.id,h.current_version)
        || jsonb_build_object('programName',(SELECT left(g.name,200) FROM hon.programs g WHERE g.id=v.program_id AND g.organization_id=org AND g.school_id=school)) ORDER BY h.plan_code)
      FROM hon.membership_plans h JOIN hon.membership_plan_versions v ON v.plan_id=h.id AND v.version=h.current_version
      WHERE h.organization_id=org AND h.school_id=school),'[]'::jsonb),
    'programs',coalesce((SELECT jsonb_agg(jsonb_build_object('programId',g.id,'name',left(g.name,200)) ORDER BY g.name,g.id)
      FROM hon.programs g WHERE g.organization_id=org AND g.school_id=school AND g.status NOT IN ('CANCELLED','COMPLETED')),'[]'::jsonb))
  INTO result;
  PERFORM hon.require_membership_plan_manager(subject);
  RETURN result;
END $$;

CREATE FUNCTION hon.create_school_membership_plan(subject text,p jsonb,key uuid,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; terms jsonb; fp text; reserved boolean;
  prior hon.idempotency_records%ROWTYPE; plan hon.membership_plans%ROWTYPE; summary jsonb;
BEGIN
  actor:=hon.require_membership_plan_manager(subject);
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR key IS NULL OR request IS NULL OR correlation IS NULL
    OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
    OR NOT p ?& ARRAY['planCode','confirmation']
    OR jsonb_typeof(p->'planCode') IS DISTINCT FROM 'string' OR p->>'planCode' !~ '^[A-Z0-9][A-Z0-9_-]{0,39}$'
    OR p->>'confirmation' IS DISTINCT FROM 'I_CONFIRM_DIRECT_HUMAN_MEMBERSHIP_PLAN_CHANGE' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('command','billing.membership_plan.create','input',p)::text,'UTF8')),'hex');
  -- Canonical lock order (0169): key reservation, IAM SHARE, catalog tables, evidence last.
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key::text,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  reserved:=coalesce(reserved,false);
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  LOCK TABLE hon.membership_plans,hon.membership_plan_versions IN SHARE ROW EXCLUSIVE MODE;
  IF hon.require_membership_plan_manager(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF NOT reserved THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_CONFLICT' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body->'planId') IS DISTINCT FROM 'string'
      OR prior.response_body IS DISTINCT FROM hon.membership_plan_version_summary((prior.response_body->>'planId')::uuid,1) THEN
      RAISE EXCEPTION 'MEMBERSHIP_PLAN_CONFLICT' USING ERRCODE='40001'; END IF;
    PERFORM hon.require_membership_plan_manager(subject);
    RETURN jsonb_build_object('plan',prior.response_body,'replayed',true);
  END IF;
  terms:=hon.membership_plan_validated_terms(p-'planCode'-'confirmation');
  IF EXISTS(SELECT 1 FROM hon.membership_plans x WHERE x.organization_id=org AND x.school_id=school AND x.plan_code=p->>'planCode') THEN
    RAISE EXCEPTION 'MEMBERSHIP_PLAN_CODE_TAKEN' USING ERRCODE='23505'; END IF;
  IF (SELECT count(*) FROM hon.membership_plans x WHERE x.organization_id=org AND x.school_id=school)>=200 THEN
    RAISE EXCEPTION 'MEMBERSHIP_PLAN_LIMIT' USING ERRCODE='54000'; END IF;
  INSERT INTO hon.membership_plans(organization_id,school_id,plan_code,current_version,created_by_principal_id)
    VALUES(org,school,p->>'planCode',1,actor) RETURNING * INTO plan;
  INSERT INTO hon.membership_plan_versions(plan_id,version,organization_id,school_id,display_name,description,program_id,availability,currency,price_minor,billing_frequency,term_kind,term_months,actor_principal_id,created_at)
    VALUES(plan.id,1,org,school,terms->>'displayName',terms->>'description',(terms->>'programId')::uuid,terms->>'availability',terms->>'currency',(terms->>'priceMinor')::integer,
      terms->>'billingFrequency',terms->>'termKind',(terms->>'termMonths')::integer,actor,plan.created_at);
  summary:=hon.membership_plan_version_summary(plan.id,1);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','billing.membership_plan.create','MEMBERSHIP_PLAN',plan.id,NULL,summary,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'billing.membership_plan.published',1,'MEMBERSHIP_PLAN',plan.id,1,correlation,request,summary || jsonb_build_object('executionAllowed',false,'humanOnly',true));
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=summary
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text;
  IF summary IS NULL OR summary->>'planCode' IS DISTINCT FROM p->>'planCode' THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_CONFLICT' USING ERRCODE='40001'; END IF;
  PERFORM hon.require_membership_plan_manager(subject);
  RETURN jsonb_build_object('plan',summary,'replayed',false);
END $$;

-- A revision publishes a complete new set of terms as the next version. The
-- caller names the version it reviewed; a concurrent revision makes it stale.
CREATE FUNCTION hon.revise_school_membership_plan(subject text,selected_plan uuid,p jsonb,key uuid,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; terms jsonb; fp text; reserved boolean;
  prior hon.idempotency_records%ROWTYPE; plan hon.membership_plans%ROWTYPE; before_summary jsonb; summary jsonb; next_version integer;
BEGIN
  actor:=hon.require_membership_plan_manager(subject);
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR selected_plan IS NULL OR key IS NULL OR request IS NULL OR correlation IS NULL
    OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
    OR NOT p ?& ARRAY['expectedVersion','confirmation']
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^[1-9][0-9]{0,5}$'
    OR p->>'confirmation' IS DISTINCT FROM 'I_CONFIRM_DIRECT_HUMAN_MEMBERSHIP_PLAN_CHANGE' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('command','billing.membership_plan.revise','planId',selected_plan,'input',p)::text,'UTF8')),'hex');
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key::text,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  reserved:=coalesce(reserved,false);
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  LOCK TABLE hon.membership_plans,hon.membership_plan_versions IN SHARE ROW EXCLUSIVE MODE;
  IF hon.require_membership_plan_manager(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF NOT reserved THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_CONFLICT' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.status<>'COMPLETED' OR prior.response_body->>'planId' IS DISTINCT FROM selected_plan::text
      OR prior.response_body->>'version' IS DISTINCT FROM ((p->>'expectedVersion')::integer+1)::text
      OR prior.response_body IS DISTINCT FROM hon.membership_plan_version_summary(selected_plan,(p->>'expectedVersion')::integer+1) THEN
      RAISE EXCEPTION 'MEMBERSHIP_PLAN_CONFLICT' USING ERRCODE='40001'; END IF;
    PERFORM hon.require_membership_plan_manager(subject);
    RETURN jsonb_build_object('plan',prior.response_body,'replayed',true);
  END IF;
  SELECT * INTO plan FROM hon.membership_plans x WHERE x.id=selected_plan AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  IF plan.current_version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_VERSION_STALE' USING ERRCODE='40001'; END IF;
  IF plan.current_version>=1000 THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_LIMIT' USING ERRCODE='54000'; END IF;
  terms:=hon.membership_plan_validated_terms(p-'expectedVersion'-'confirmation');
  before_summary:=hon.membership_plan_version_summary(plan.id,plan.current_version);
  IF terms=(before_summary-'planId'-'planCode'-'version'-'publishedAt') THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_UNCHANGED' USING ERRCODE='22023'; END IF;
  next_version:=plan.current_version+1;
  INSERT INTO hon.membership_plan_versions(plan_id,version,organization_id,school_id,display_name,description,program_id,availability,currency,price_minor,billing_frequency,term_kind,term_months,actor_principal_id)
    VALUES(plan.id,next_version,org,school,terms->>'displayName',terms->>'description',(terms->>'programId')::uuid,terms->>'availability',terms->>'currency',(terms->>'priceMinor')::integer,
      terms->>'billingFrequency',terms->>'termKind',(terms->>'termMonths')::integer,actor);
  UPDATE hon.membership_plans SET current_version=next_version,updated_at=clock_timestamp() WHERE id=plan.id AND organization_id=org AND school_id=school;
  summary:=hon.membership_plan_version_summary(plan.id,next_version);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','billing.membership_plan.revise','MEMBERSHIP_PLAN',plan.id,before_summary,summary,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'billing.membership_plan.published',1,'MEMBERSHIP_PLAN',plan.id,next_version,correlation,request,summary || jsonb_build_object('executionAllowed',false,'humanOnly',true));
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=summary
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text;
  IF summary IS NULL OR (SELECT current_version FROM hon.membership_plans WHERE id=plan.id)<>next_version THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_CONFLICT' USING ERRCODE='40001'; END IF;
  PERFORM hon.require_membership_plan_manager(subject);
  RETURN jsonb_build_object('plan',summary,'replayed',false);
END $$;

-- Staff enrollment read: the plans an adult DRAFT may use right now, each at
-- its current published version. Same actor as the 0162 adult DRAFT.
CREATE FUNCTION hon.read_crm_adult_membership_plan_options(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); result jsonb;
BEGIN
  PERFORM hon.require_crm_adult_membership_actor(subject);
  SELECT jsonb_build_object('plans',coalesce(jsonb_agg(hon.membership_plan_version_summary(h.id,h.current_version)
      || jsonb_build_object('programName',left(g.name,200)) ORDER BY v.display_name,h.plan_code),'[]'::jsonb))
  INTO result
  FROM hon.membership_plans h JOIN hon.membership_plan_versions v ON v.plan_id=h.id AND v.version=h.current_version
  LEFT JOIN hon.programs g ON g.id=v.program_id AND g.organization_id=org AND g.school_id=school
  WHERE h.organization_id=org AND h.school_id=school AND v.availability='AVAILABLE'
    AND (v.program_id IS NULL OR g.status NOT IN ('CANCELLED','COMPLETED'));
  PERFORM hon.require_crm_adult_membership_actor(subject);
  RETURN result;
END $$;

-- The adult CRM DRAFT with a server-verified plan. Same actor, relation, source
-- link, receipt shape and lock order as draft_crm_adult_membership (0169), so the
-- unchanged 0163 confirmation and 0174 recovery read it as an ordinary DRAFT.
-- The plan code, term end and binding come from the exact current published
-- version the human reviewed; the browser supplies only selectors.
CREATE FUNCTION hon.draft_crm_adult_membership_from_plan(subject text,p jsonb,key uuid,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; relation record; final_relation record;
  selected uuid; selected_plan uuid; selected_version integer; start_at timestamptz; end_at timestamptz; value text; fp text; reserved boolean;
  prior hon.idempotency_records%ROWTYPE; source hon.crm_adult_membership_draft_sources%ROWTYPE; membership hon.memberships%ROWTYPE;
  plan hon.membership_plans%ROWTYPE; terms hon.membership_plan_versions%ROWTYPE; selection hon.membership_plan_selections%ROWTYPE;
  plan_summary jsonb; result_receipt jsonb; response jsonb; binding jsonb; instant timestamptz;
BEGIN
  actor:=hon.require_crm_adult_membership_actor(subject);
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR key IS NULL OR request IS NULL OR correlation IS NULL
    OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
    OR NOT p ?& ARRAY['studentProfileId','membershipPlanId','membershipPlanVersion','confirmation']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('studentProfileId','membershipPlanId','membershipPlanVersion','termStartedAt','confirmation'))
    OR jsonb_typeof(p->'studentProfileId') IS DISTINCT FROM 'string' OR p->>'studentProfileId' !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    OR jsonb_typeof(p->'membershipPlanId') IS DISTINCT FROM 'string' OR p->>'membershipPlanId' !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    OR jsonb_typeof(p->'membershipPlanVersion') IS DISTINCT FROM 'number' OR (p->'membershipPlanVersion')::text !~ '^[1-9][0-9]{0,5}$'
    OR p->>'confirmation' IS DISTINCT FROM 'I_CONFIRM_DIRECT_HUMAN_ADULT_CRM_MEMBERSHIP_DRAFT_FROM_PLAN' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  selected:=(p->>'studentProfileId')::uuid; selected_plan:=(p->>'membershipPlanId')::uuid; selected_version:=(p->>'membershipPlanVersion')::integer;
  IF p ? 'termStartedAt' THEN
    value:=p->>'termStartedAt';
    IF jsonb_typeof(p->'termStartedAt') IS DISTINCT FROM 'string' OR length(value)<>24 OR value !~ '^(19|[2-9][0-9])[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      OR to_char(value::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>value THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
    start_at:=value::timestamptz;
  END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('command','crm.adult.membership.draft.from_plan','input',
    p || jsonb_build_object('studentProfileId',selected,'membershipPlanId',selected_plan))::text,'UTF8')),'hex');
  -- Canonical lock order (0169) with the catalog after the DRAFT sources:
  -- key reservation; IAM SHARE; people ... DRAFT sources SHARE ROW EXCLUSIVE
  -- (exactly the 0169 DRAFT set); plan head and versions SHARE (blocks a
  -- concurrent revision, never another DRAFT); the selection row insert
  -- (already serialized by the DRAFT-source lock); evidence last.
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key::text,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  reserved:=coalesce(reserved,false);
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  LOCK TABLE hon.people,hon.student_profiles,hon.families,hon.family_members,hon.crm_lead_registration_conversions,hon.crm_leads,hon.billing_accounts,hon.memberships,hon.crm_adult_membership_draft_sources IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE hon.membership_plans,hon.membership_plan_versions IN SHARE MODE;
  IF hon.require_crm_adult_membership_actor(subject) IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO relation FROM hon.crm_adult_membership_relation(selected);
  IF NOT reserved THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_CONFLICT' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    SELECT * INTO source FROM hon.crm_adult_membership_draft_sources x WHERE x.conversion_id=relation.conversion_id AND x.organization_id=org AND x.school_id=school;
    IF NOT FOUND OR source.actor_principal_id<>actor OR source.idempotency_key<>key OR source.request_fingerprint<>fp
      OR prior.status<>'COMPLETED' OR prior.response_body->'receipt' IS DISTINCT FROM source.receipt THEN RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_CONFLICT' USING ERRCODE='40001'; END IF;
    SELECT * INTO selection FROM hon.membership_plan_selections x WHERE x.membership_id=source.membership_id AND x.organization_id=org AND x.school_id=school;
    IF NOT FOUND OR selection.plan_id<>selected_plan OR selection.plan_version<>selected_version OR selection.actor_principal_id<>actor
      OR prior.response_body->'plan' IS DISTINCT FROM hon.membership_plan_version_summary(selected_plan,selected_version) THEN
      RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_CONFLICT' USING ERRCODE='40001'; END IF;
    -- Historical DRAFT creation and the immutable plan terms it used; not current state.
    PERFORM 1 FROM hon.memberships m WHERE m.id=source.membership_id AND m.organization_id=org AND m.school_id=school
      AND m.billing_account_id=relation.account_id AND m.participant_person_id=relation.person_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
    PERFORM hon.require_crm_adult_membership_actor(subject);
    RETURN jsonb_build_object('receipt',source.receipt,'plan',prior.response_body->'plan','replayed',true);
  END IF;
  IF EXISTS(SELECT 1 FROM hon.crm_adult_membership_draft_sources x WHERE x.conversion_id=relation.conversion_id)
    OR EXISTS(SELECT 1 FROM hon.memberships m WHERE m.organization_id=org AND m.school_id=school AND m.participant_person_id=relation.person_id) THEN
    RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  -- Server-verified plan: current school, exactly the current version, available, open program, account currency.
  SELECT * INTO plan FROM hon.membership_plans x WHERE x.id=selected_plan AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  IF plan.current_version<>selected_version THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_VERSION_STALE' USING ERRCODE='40001'; END IF;
  SELECT * INTO terms FROM hon.membership_plan_versions v WHERE v.plan_id=plan.id AND v.version=plan.current_version AND v.organization_id=org AND v.school_id=school;
  IF NOT FOUND OR terms.availability<>'AVAILABLE'
    OR (terms.program_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hon.programs g WHERE g.id=terms.program_id AND g.organization_id=org AND g.school_id=school AND g.status NOT IN ('CANCELLED','COMPLETED'))) THEN
    RAISE EXCEPTION 'MEMBERSHIP_PLAN_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  IF terms.currency::text IS DISTINCT FROM relation.currency THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_CURRENCY_MISMATCH' USING ERRCODE='22023'; END IF;
  -- Term rule: a fixed term ends exactly termMonths after its start (UTC calendar
  -- months, end-of-month clamped); without a start both ends stay unset.
  IF start_at IS NOT NULL AND terms.term_kind='FIXED_MONTHS' THEN
    end_at:=((start_at AT TIME ZONE 'UTC')+make_interval(months=>terms.term_months)) AT TIME ZONE 'UTC';
  END IF;
  INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at)
    VALUES(org,school,relation.account_id,relation.person_id,plan.plan_code,'DRAFT',start_at,end_at) RETURNING * INTO membership;
  instant:=clock_timestamp();
  result_receipt:=jsonb_build_object('membershipId',membership.id,'state','DRAFT','planCode',membership.plan_code,
    'termStartedAt',CASE WHEN start_at IS NULL THEN NULL ELSE to_char(start_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'termEndsAt',CASE WHEN end_at IS NULL THEN NULL ELSE to_char(end_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'recordedAt',to_char(instant AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  INSERT INTO hon.crm_adult_membership_draft_sources(conversion_id,organization_id,school_id,membership_id,actor_principal_id,idempotency_key,request_fingerprint,receipt,created_at)
    VALUES(relation.conversion_id,org,school,membership.id,actor,key,fp,result_receipt,instant);
  INSERT INTO hon.membership_plan_selections(membership_id,organization_id,school_id,plan_id,plan_version,actor_principal_id,created_at)
    VALUES(membership.id,org,school,plan.id,plan.current_version,actor,instant);
  plan_summary:=hon.membership_plan_version_summary(plan.id,plan.current_version);
  binding:=jsonb_build_object('membershipPlanId',plan.id,'membershipPlanVersion',plan.current_version);
  response:=jsonb_build_object('receipt',result_receipt,'plan',plan_summary);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','billing.membership.create','MEMBERSHIP',membership.id,NULL,result_receipt || binding,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'billing.membership.drafted',1,'MEMBERSHIP',membership.id,membership.version,correlation,request,result_receipt || binding || jsonb_build_object('executionAllowed',false,'humanOnly',true));
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=response
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key::text;
  -- Final relation, plan and authority rechecks include all post-insert evidence.
  SELECT * INTO final_relation FROM hon.crm_adult_membership_relation(selected);
  IF final_relation IS DISTINCT FROM relation OR plan_summary IS NULL
    OR NOT EXISTS(SELECT 1 FROM hon.memberships m WHERE m.id=membership.id AND m.organization_id=org AND m.school_id=school AND m.state='DRAFT'
      AND m.billing_account_id=relation.account_id AND m.participant_person_id=relation.person_id AND m.plan_code=plan.plan_code
      AND m.term_started_at IS NOT DISTINCT FROM start_at AND m.term_ends_at IS NOT DISTINCT FROM end_at)
    OR EXISTS(SELECT 1 FROM hon.membership_payment_schedules s WHERE s.membership_id=membership.id)
    OR NOT EXISTS(SELECT 1 FROM hon.membership_plans x WHERE x.id=plan.id AND x.current_version=selected_version)
    OR NOT EXISTS(SELECT 1 FROM hon.membership_plan_selections x WHERE x.membership_id=membership.id AND x.plan_id=plan.id AND x.plan_version=selected_version)
    OR NOT EXISTS(SELECT 1 FROM hon.crm_adult_membership_draft_sources x WHERE x.conversion_id=relation.conversion_id
      AND x.organization_id=org AND x.school_id=school AND x.membership_id=membership.id AND x.actor_principal_id=actor
      AND x.idempotency_key=key AND x.request_fingerprint=fp AND x.receipt=result_receipt)
    OR (SELECT count(*) FROM hon.memberships m WHERE m.organization_id=org AND m.school_id=school AND m.participant_person_id=relation.person_id)<>1 THEN
    RAISE EXCEPTION 'CRM_ADULT_MEMBERSHIP_CONFLICT' USING ERRCODE='40001'; END IF;
  PERFORM hon.require_crm_adult_membership_actor(subject);
  RETURN jsonb_build_object('receipt',result_receipt,'plan',plan_summary,'replayed',false);
END $$;

COMMENT ON FUNCTION hon.draft_crm_adult_membership_from_plan(text,jsonb,uuid,uuid,uuid) IS
'Only direct HUMAN_UI adult CRM REGISTERED conversion to one historical DRAFT bound to the exact current published school membership plan version. No account creation, family inference, schedule, invoice, payment, discount, agreement, provider, communication, activation, automation, Action Engine or AI effect.';

REVOKE ALL ON TABLE hon.membership_plans,hon.membership_plan_versions,hon.membership_plan_selections FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_membership_plan(),hon.guard_membership_plan_version(),hon.guard_membership_plan_selection(),
  hon.require_membership_plan_manager(text),hon.membership_plan_validated_terms(jsonb),hon.membership_plan_version_summary(uuid,integer),
  hon.read_school_membership_plan_catalog(text),hon.create_school_membership_plan(text,jsonb,uuid,uuid,uuid),hon.revise_school_membership_plan(text,uuid,jsonb,uuid,uuid,uuid),
  hon.read_crm_adult_membership_plan_options(text),hon.draft_crm_adult_membership_from_plan(text,jsonb,uuid,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.membership_plans,hon.membership_plan_versions,hon.membership_plan_selections FROM %I',r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_membership_plan(),hon.guard_membership_plan_version(),hon.guard_membership_plan_selection(),
      hon.require_membership_plan_manager(text),hon.membership_plan_validated_terms(jsonb),hon.membership_plan_version_summary(uuid,integer),
      hon.read_school_membership_plan_catalog(text),hon.create_school_membership_plan(text,jsonb,uuid,uuid,uuid),hon.revise_school_membership_plan(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_crm_adult_membership_plan_options(text),hon.draft_crm_adult_membership_from_plan(text,jsonb,uuid,uuid,uuid) FROM %I',r);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_membership_plan_catalog(text),hon.create_school_membership_plan(text,jsonb,uuid,uuid,uuid),
      hon.revise_school_membership_plan(text,uuid,jsonb,uuid,uuid,uuid),hon.read_crm_adult_membership_plan_options(text),
      hon.draft_crm_adult_membership_from_plan(text,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;
COMMIT;
