BEGIN;

-- B-TUI-2 piece 9a (0269, reserved by the coordinator 2026-11-11): per-school customizable checkout page settings.
-- Owner request (David, 2026-11-11): "I need schedular and checkout pages customizable". Spec:
-- docs/architecture/TUITION_COLLECTION.md (P9).
--   K1  One settings row per school and page kind (ENROLLMENT, TUITION), DRAFT or PUBLISHED, with a closed content shape:
--       plans shown and their order, add-ons, custom fields, an optional waiver, receipt note and thank-you text, each
--       text in English with optional Korean and Spanish. Branding (logo, color, cover, footer) is NOT stored here: it is
--       the shared school branding owned by the booking feature (0268); the checkout only reads it.
--   K2  Plans shown must be this school's catalog plans (0175) whose current version is AVAILABLE when saved. A published
--       ENROLLMENT page needs at least one plan. Amounts are minor units; HON adds no fee.
--   K3  New staff-assignable permission school_checkout.manage, initially granted to system OWNER roles only. HQ, family
--       and parent-type principals are refused (the 0258 identity rules).
--   K4  Every save is a direct-human SECURITY DEFINER command with live permission re-checks, exact-request idempotency,
--       optimistic version, an append-only version snapshot, audit and an inert outbox event.
-- Nothing here is public yet, takes a payment, stores a card, sends a message or runs an automation. Promo codes and the
-- sibling-discount display come in later pieces.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'School checkout pages require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'School checkout pages require a restricted runtime';
  END IF;
  IF to_regprocedure('hon.membership_command_args_ok(text,text,uuid,uuid)') IS NULL OR to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.guard_membership_activation_evidence()') IS NULL OR to_regclass('hon.membership_plan_versions') IS NULL
    OR to_regprocedure('hon.require_school_pay_actor(text,text)') IS NULL THEN
    RAISE EXCEPTION 'School checkout pages require 0175, 0177, 0224 and 0258';
  END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('school_checkout.manage','See and change the school''s checkout page settings (plans shown, add-ons, questions, waiver, receipt text)',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code='school_checkout.manage' AND is_sensitive AND is_staff_assignable) THEN
    RAISE EXCEPTION 'school_checkout.manage already exists with an unexpected definition';
  END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,'school_checkout.manage' FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER'
ON CONFLICT DO NOTHING;

-- One display text: trimmed, 1..maximum characters, no angle brackets, no control characters (a line break only when
-- multiline).
CREATE FUNCTION hon.checkout_text_ok(v jsonb,maximum integer,multiline boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(v)='string' AND length(v#>>'{}') BETWEEN 1 AND maximum AND btrim(v#>>'{}')=v#>>'{}'
    AND (v#>>'{}') !~ '[<>]'
    AND CASE WHEN multiline THEN (v#>>'{}') !~ '[\x01-\x09\x0b-\x1f\x7f]' ELSE (v#>>'{}') !~ '[[:cntrl:]]' END,false)
$$;

-- One translated text: {en, ko?, es?}; English is required.
CREATE FUNCTION hon.checkout_i18n_ok(v jsonb,maximum integer,multiline boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(jsonb_typeof(v)='object' AND v ? 'en'
    AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(v) k WHERE k NOT IN ('en','ko','es'))
    AND NOT EXISTS(SELECT 1 FROM jsonb_each(v) e WHERE NOT hon.checkout_text_ok(e.value,maximum,multiline)),false)
$$;

-- K1: the closed checkout content shape.
CREATE FUNCTION hon.checkout_content_ok(c jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(jsonb_typeof(c)='object'
    AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(c) k)=ARRAY['addOns','customFields','planIds','receiptNote','thankYou','waiver']
    -- Plans shown, in order: at most 20 distinct plan ids.
    AND jsonb_typeof(c->'planIds')='array' AND jsonb_array_length(c->'planIds')<=20
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c->'planIds') x WHERE jsonb_typeof(x)<>'string'
      OR x#>>'{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    AND (SELECT count(DISTINCT x#>>'{}') FROM jsonb_array_elements(c->'planIds') x)=jsonb_array_length(c->'planIds')
    -- Add-ons (uniform, registration fee): at most 10, distinct keys, a positive amount in minor units.
    AND jsonb_typeof(c->'addOns')='array' AND jsonb_array_length(c->'addOns')<=10
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c->'addOns') a WHERE NOT (jsonb_typeof(a)='object'
      AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(a) k)=ARRAY['amountMinor','currency','key','label','required']
      AND jsonb_typeof(a->'key')='string' AND a->>'key' ~ '^[a-z][a-z0-9_]{0,39}$'
      AND hon.checkout_i18n_ok(a->'label',80,false)
      AND jsonb_typeof(a->'amountMinor')='number' AND (a->'amountMinor')::text ~ '^[1-9][0-9]{0,7}$'
      AND jsonb_typeof(a->'currency')='string' AND a->>'currency' ~ '^[A-Z]{3}$'
      AND jsonb_typeof(a->'required')='boolean'))
    AND (SELECT count(DISTINCT a->>'key') FROM jsonb_array_elements(c->'addOns') a)=jsonb_array_length(c->'addOns')
    -- Custom questions: at most 10, distinct keys; a CHOICE has 2..10 options, other kinds none.
    AND jsonb_typeof(c->'customFields')='array' AND jsonb_array_length(c->'customFields')<=10
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c->'customFields') f WHERE NOT (jsonb_typeof(f)='object'
      AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(f) k)=ARRAY['key','kind','label','options','required']
      AND jsonb_typeof(f->'key')='string' AND f->>'key' ~ '^[a-z][a-z0-9_]{0,39}$'
      AND hon.checkout_i18n_ok(f->'label',120,false)
      AND jsonb_typeof(f->'kind')='string' AND f->>'kind' IN ('TEXT','CHOICE','CHECKBOX')
      AND jsonb_typeof(f->'required')='boolean' AND jsonb_typeof(f->'options')='array'
      AND CASE WHEN f->>'kind'='CHOICE' THEN jsonb_array_length(f->'options') BETWEEN 2 AND 10 ELSE jsonb_array_length(f->'options')=0 END
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(f->'options') o WHERE NOT hon.checkout_i18n_ok(o,80,false))))
    AND (SELECT count(DISTINCT f->>'key') FROM jsonb_array_elements(c->'customFields') f)=jsonb_array_length(c->'customFields')
    -- An optional waiver the family must accept, and optional receipt and thank-you text.
    AND (jsonb_typeof(c->'waiver')='null' OR (jsonb_typeof(c->'waiver')='object'
      AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(c->'waiver') k)=ARRAY['text']
      AND hon.checkout_i18n_ok(c->'waiver'->'text',5000,true)))
    AND (jsonb_typeof(c->'receiptNote')='null' OR hon.checkout_i18n_ok(c->'receiptNote',1000,true))
    AND (jsonb_typeof(c->'thankYou')='null' OR hon.checkout_i18n_ok(c->'thankYou',1000,true)),false)
$$;

-- K1: one row per school and page kind.
CREATE TABLE hon.school_checkout_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ENROLLMENT','TUITION')),
  status text NOT NULL CHECK (status IN ('DRAFT','PUBLISHED')),
  content jsonb NOT NULL CHECK (hon.checkout_content_ok(content)),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (kind<>'ENROLLMENT' OR status<>'PUBLISHED' OR jsonb_array_length(content->'planIds')>=1),
  UNIQUE(school_id,kind),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
ALTER TABLE hon.school_checkout_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_checkout_pages FORCE ROW LEVEL SECURITY;

-- Append-only snapshot of every saved version.
CREATE TABLE hon.school_checkout_page_versions (
  page_id uuid NOT NULL REFERENCES hon.school_checkout_pages(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version>=1),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT','PUBLISHED')),
  content jsonb NOT NULL CHECK (hon.checkout_content_ok(content)),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(page_id,version),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
ALTER TABLE hon.school_checkout_page_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_checkout_page_versions FORCE ROW LEVEL SECURITY;
CREATE TRIGGER school_checkout_page_versions_immutable BEFORE UPDATE OR DELETE ON hon.school_checkout_page_versions
  FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_checkout_page_versions_no_truncate BEFORE TRUNCATE ON hon.school_checkout_page_versions
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_checkout_pages_no_truncate BEFORE TRUNCATE ON hon.school_checkout_pages
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- Settings-free page guard, whoever writes: no delete; scope, kind and creation facts never change; every update bumps the
-- version by exactly one.
CREATE FUNCTION hon.guard_school_checkout_page() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'School checkout pages are never deleted' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 THEN RAISE EXCEPTION 'A new checkout page starts at version 1' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id OR NEW.kind<>OLD.kind
    OR NEW.created_by_principal_id<>OLD.created_by_principal_id OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'Checkout page scope, kind and history are fixed' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_checkout_page_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_checkout_pages
  FOR EACH ROW EXECUTE FUNCTION hon.guard_school_checkout_page();

-- Live direct-human authority at the current school, or a refusal. The identity rules are the 0258 ones.
CREATE FUNCTION hon.require_school_checkout_actor(subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'SCHOOL_CHECKOUT_FORBIDDEN' USING ERRCODE='42501'; END IF;
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
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions x ON x.code=rp.permission_code
      WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND x.code='school_checkout.manage' AND x.is_staff_assignable)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'SCHOOL_CHECKOUT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.school_checkout_page_json(c hon.school_checkout_pages) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('pageId',c.id,'kind',c.kind,'status',c.status,'content',c.content,'version',c.version,
    'updatedAt',to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
$$;

-- Read: both page kinds (absent ones as null) and this school's catalog plans with their current terms, for choosing.
CREATE FUNCTION hon.read_school_checkout_pages(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; result jsonb;
BEGIN
  actor:=hon.require_school_checkout_actor(subject);
  result:=jsonb_build_object(
    'enrollment',(SELECT hon.school_checkout_page_json(c) FROM hon.school_checkout_pages c WHERE c.organization_id=org AND c.school_id=school AND c.kind='ENROLLMENT'),
    'tuition',(SELECT hon.school_checkout_page_json(c) FROM hon.school_checkout_pages c WHERE c.organization_id=org AND c.school_id=school AND c.kind='TUITION'),
    'plans',coalesce((SELECT jsonb_agg(jsonb_build_object('planId',m.id,'displayName',v.display_name,'priceMinor',v.price_minor,'currency',v.currency,
        'billingFrequency',v.billing_frequency,'available',v.availability='AVAILABLE') ORDER BY v.display_name,m.id)
      FROM (SELECT * FROM hon.membership_plans x WHERE x.organization_id=org AND x.school_id=school ORDER BY x.id LIMIT 200) m
      JOIN hon.membership_plan_versions v ON v.plan_id=m.id AND v.version=m.current_version),'[]'::jsonb));
  IF hon.require_school_checkout_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_CHECKOUT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- Save: create (expectedVersion 0) or replace one page kind's settings, as a draft or published.
CREATE FUNCTION hon.save_school_checkout_page(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; reserved boolean;
  prior hon.idempotency_records%ROWTYPE; c hon.school_checkout_pages%ROWTYPE; before jsonb; next jsonb; result jsonb; expected integer;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['content','expectedVersion','kind','status']
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^(0|[1-9][0-9]{0,8})$'
    OR jsonb_typeof(p->'kind') IS DISTINCT FROM 'string' OR p->>'kind' NOT IN ('ENROLLMENT','TUITION')
    OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR p->>'status' NOT IN ('DRAFT','PUBLISHED')
    OR NOT hon.checkout_content_ok(p->'content') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  expected:=(p->>'expectedVersion')::integer;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','school_checkout.page.save','input',p)::text,'UTF8')),'hex');
  actor:=hon.require_school_checkout_actor(subject);
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  IF hon.require_school_checkout_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_CHECKOUT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF NOT coalesce(reserved,false) THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    IF hon.require_school_checkout_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_CHECKOUT_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('receipt',prior.response_body,'replayed',true);
  END IF;
  -- K2: every plan shown is this school's catalog plan, currently available.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(p->'content'->'planIds') x(id) WHERE NOT EXISTS(
      SELECT 1 FROM hon.membership_plans m JOIN hon.membership_plan_versions v ON v.plan_id=m.id AND v.version=m.current_version
      WHERE m.id=x.id::uuid AND m.organization_id=org AND m.school_id=school AND v.availability='AVAILABLE')) THEN
    RAISE EXCEPTION 'CHECKOUT_PLAN_UNAVAILABLE' USING ERRCODE='22023'; END IF;
  IF p->>'kind'='ENROLLMENT' AND p->>'status'='PUBLISHED' AND jsonb_array_length(p->'content'->'planIds')=0 THEN
    RAISE EXCEPTION 'CHECKOUT_PLANS_REQUIRED' USING ERRCODE='22023'; END IF;
  LOCK TABLE hon.school_checkout_pages IN ROW EXCLUSIVE MODE;
  PERFORM 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org FOR NO KEY UPDATE;
  SELECT * INTO c FROM hon.school_checkout_pages x WHERE x.organization_id=org AND x.school_id=school AND x.kind=p->>'kind' FOR UPDATE;
  IF FOUND THEN
    IF c.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    before:=hon.school_checkout_page_json(c);
    UPDATE hon.school_checkout_pages SET status=p->>'status',content=p->'content',version=c.version+1,updated_by_principal_id=actor,updated_at=clock_timestamp()
      WHERE id=c.id RETURNING * INTO c;
  ELSE
    IF expected<>0 THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    INSERT INTO hon.school_checkout_pages(organization_id,school_id,kind,status,content,created_by_principal_id,updated_by_principal_id)
      VALUES(org,school,p->>'kind',p->>'status',p->'content',actor,actor) RETURNING * INTO c;
  END IF;
  next:=hon.school_checkout_page_json(c);
  INSERT INTO hon.school_checkout_page_versions(page_id,version,organization_id,school_id,status,content,actor_principal_id)
    VALUES(c.id,c.version,org,school,c.status,c.content,actor);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','school_checkout.page.save','SCHOOL_CHECKOUT_PAGE',c.id,before,next,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'school_checkout.page.saved',1,'SCHOOL_CHECKOUT_PAGE',c.id,c.version,correlation,request,next);
  result:=jsonb_build_object('page',next);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  IF hon.require_school_checkout_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_CHECKOUT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

DO $$ DECLARE r record; t text; col text;
  private_fns text:='hon.checkout_text_ok(jsonb,integer,boolean),hon.checkout_i18n_ok(jsonb,integer,boolean),hon.checkout_content_ok(jsonb),'
    'hon.guard_school_checkout_page(),hon.require_school_checkout_actor(text),hon.school_checkout_page_json(hon.school_checkout_pages)';
  entry_fns text:='hon.read_school_checkout_pages(text),hon.save_school_checkout_page(text,jsonb,text,uuid,uuid)';
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s,%s FROM PUBLIC',private_fns,entry_fns);
  FOREACH t IN ARRAY ARRAY['school_checkout_pages','school_checkout_page_versions'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',col,t);
    END LOOP;
  END LOOP;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s,%s FROM %I',private_fns,entry_fns,r.rolname);
    FOREACH t IN ARRAY ARRAY['school_checkout_pages','school_checkout_page_versions'] LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r.rolname);
      FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',col,t,r.rolname);
      END LOOP;
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',entry_fns);
  END IF;
END $$;
DO $$ DECLARE t text; BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH t IN ARRAY ARRAY['hon.school_checkout_pages','hon.school_checkout_page_versions'] LOOP
      IF has_table_privilege('hon_runtime',t,'SELECT') OR has_any_column_privilege('hon_runtime',t,'SELECT') OR has_table_privilege('hon_runtime',t,'INSERT')
        OR has_table_privilege('hon_runtime',t,'UPDATE') OR has_table_privilege('hon_runtime',t,'DELETE') THEN
        RAISE EXCEPTION 'School checkout pages must not widen runtime privileges';
      END IF;
    END LOOP;
  END IF;
END $$;
COMMIT;
