BEGIN;

-- B-TUI-2 checkout pages CP1 (0402, coordinator-allocated 2026-11-16): many named checkout pages per school.
-- Owner request (David, 2026-11-16): "3 things I want you to take from my current crm. Checkout page, lead section,
-- scheduler." The current CRM has many named checkout pages per school (groups, live/draft, pricing options with down
-- payments and installments, multi-participant, per-participant questions). 0269 allowed one page per school and kind.
-- Plan: /mnt/project-files/tuition-b-tui-2/checkout-from-manus/CHECKOUT_PAGES_ADAPTATION.md; spec:
-- docs/architecture/TUITION_COLLECTION.md (section 21).
--   C1  hon.school_checkouts: one row per page (slug fixed once created and unique per school, group key, DRAFT /
--       PUBLISHED / ARCHIVED, closed content, version). Never deleted; an append-only snapshot of every save.
--   C2  hon.school_checkout_settings: one versioned row per school with the page groups and the staff grid order. A group
--       still used by a page cannot be removed. Without a row the default groups apply (version 0).
--   C3  Content: title, description, text blocks, multi-participant, per-participant questions and add-ons (the 0269
--       rules), the 0269 waiver, receipt and thank-you text, one currency, and 0-10 pricing options. An option is a page copy
--       of a payment choice: ONE_TIME (price, 0 allowed) or MONTHLY (recurring amount, installments with 0 = ongoing, an
--       optional down payment, and a collection method: AUTO_CHARGE = HON autopay, IN_HOUSE, REVIEW_REQUIRED). An option
--       may name this school's catalog plan, which must be AVAILABLE when saved (unless the page is archived); creating a
--       membership needs a plan. A published page needs at least one option. Amounts are minor units; HON adds no fee.
--   C4  The same school_checkout.manage permission and 0269 identity rules; every save is a direct-human definer command
--       with live permission re-checks, exact idempotency, optimistic version, audit and an inert outbox event.
--   C5  0269 pages are copied as DRAFT pages (slugs enrollment and tuition, without plans: staff add options again), then
--       the runtime loses EXECUTE on the two 0269 entry points. The 0269 tables stay as history.
-- Nothing here is public, takes a payment, stores a card, sends a message or runs an automation.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'School checkouts require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'School checkouts require a restricted runtime';
  END IF;
  IF to_regclass('hon.school_checkout_pages') IS NULL OR to_regprocedure('hon.require_school_checkout_actor(text)') IS NULL
    OR to_regprocedure('hon.checkout_i18n_ok(jsonb,integer,boolean)') IS NULL OR to_regprocedure('hon.membership_command_args_ok(text,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.guard_membership_activation_evidence()') IS NULL OR to_regclass('hon.membership_plan_versions') IS NULL THEN
    RAISE EXCEPTION 'School checkouts require 0175, 0177 and 0269';
  END IF;
END $$;

-- A whole number in a closed range.
CREATE FUNCTION hon.checkout_int_ok(v jsonb,minimum bigint,maximum bigint) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(v)='number' AND v::text ~ '^(0|[1-9][0-9]{0,11})$' AND v::text::bigint BETWEEN minimum AND maximum,false)
$$;

-- Per-participant questions (the 0269 rule): at most 10, distinct keys; a CHOICE has 2..10 options, other kinds none.
CREATE FUNCTION hon.checkout_fields_ok(f jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(jsonb_typeof(f)='array' AND jsonb_array_length(f)<=10
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(f) x WHERE NOT (jsonb_typeof(x)='object'
      AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(x) k)=ARRAY['key','kind','label','options','required']
      AND jsonb_typeof(x->'key')='string' AND x->>'key' ~ '^[a-z][a-z0-9_]{0,39}$'
      AND hon.checkout_i18n_ok(x->'label',120,false)
      AND jsonb_typeof(x->'kind')='string' AND x->>'kind' IN ('TEXT','CHOICE','CHECKBOX')
      AND jsonb_typeof(x->'required')='boolean' AND jsonb_typeof(x->'options')='array'
      AND CASE WHEN x->>'kind'='CHOICE' THEN jsonb_array_length(x->'options') BETWEEN 2 AND 10 ELSE jsonb_array_length(x->'options')=0 END
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(x->'options') o WHERE NOT hon.checkout_i18n_ok(o,80,false))))
    AND (SELECT count(DISTINCT x->>'key') FROM jsonb_array_elements(f) x)=jsonb_array_length(f),false)
$$;

-- One pricing option (C3).
CREATE FUNCTION hon.checkout_option_ok(o jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(jsonb_typeof(o)='object'
    AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(o) k)=ARRAY['additionalParticipantMinor','availableThrough','billing','capacity',
      'collectionMethod','createsMembership','description','downPayment','installments','key','label','mostPopular','planId','priceMinor','recurringMinor']
    AND jsonb_typeof(o->'key')='string' AND o->>'key' ~ '^[a-z][a-z0-9_]{0,39}$'
    AND hon.checkout_i18n_ok(o->'label',80,false)
    AND (jsonb_typeof(o->'description')='null' OR hon.checkout_i18n_ok(o->'description',1000,true))
    AND (jsonb_typeof(o->'planId')='null' OR (jsonb_typeof(o->'planId')='string'
      AND o->>'planId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    AND jsonb_typeof(o->'billing')='string' AND o->>'billing' IN ('ONE_TIME','MONTHLY')
    AND CASE WHEN o->>'billing'='ONE_TIME' THEN
        hon.checkout_int_ok(o->'priceMinor',0,99999999) AND jsonb_typeof(o->'recurringMinor')='null' AND jsonb_typeof(o->'installments')='null'
        AND jsonb_typeof(o->'downPayment')='null' AND jsonb_typeof(o->'collectionMethod')='null'
      ELSE
        -- Due today is the down payment when there is one, otherwise the first month; no separate price.
        jsonb_typeof(o->'priceMinor')='null' AND hon.checkout_int_ok(o->'recurringMinor',1,99999999) AND hon.checkout_int_ok(o->'installments',0,120)
        AND jsonb_typeof(o->'collectionMethod')='string' AND o->>'collectionMethod' IN ('AUTO_CHARGE','IN_HOUSE','REVIEW_REQUIRED')
        AND (jsonb_typeof(o->'downPayment')='null' OR (jsonb_typeof(o->'downPayment')='object'
          AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(o->'downPayment') k)=ARRAY['amountMinor','label']
          AND hon.checkout_int_ok(o->'downPayment'->'amountMinor',1,99999999) AND hon.checkout_i18n_ok(o->'downPayment'->'label',80,false)))
      END
    AND (jsonb_typeof(o->'additionalParticipantMinor')='null' OR hon.checkout_int_ok(o->'additionalParticipantMinor',0,99999999))
    AND hon.checkout_int_ok(o->'capacity',0,100000)
    AND (jsonb_typeof(o->'availableThrough')='null' OR (jsonb_typeof(o->'availableThrough')='string'
      AND o->>'availableThrough' ~ '^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
      AND to_char(to_date(o->>'availableThrough','YYYY-MM-DD'),'YYYY-MM-DD')=o->>'availableThrough'))
    AND jsonb_typeof(o->'mostPopular')='boolean' AND jsonb_typeof(o->'createsMembership')='boolean'
    AND (o->>'createsMembership'='false' OR jsonb_typeof(o->'planId')='string'),false)
$$;

-- C3: the closed page content shape.
CREATE FUNCTION hon.school_checkout_content_ok(c jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(jsonb_typeof(c)='object'
    AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(c) k)=ARRAY['addOns','blocks','currency','customFields','description',
      'multiParticipant','options','receiptNote','thankYou','title','waiver']
    AND jsonb_typeof(c->'currency')='string' AND c->>'currency' ~ '^[A-Z]{3}$'
    AND hon.checkout_i18n_ok(c->'title',120,false)
    AND (jsonb_typeof(c->'description')='null' OR hon.checkout_i18n_ok(c->'description',2000,true))
    -- Text blocks shown above or below the options.
    AND jsonb_typeof(c->'blocks')='array' AND jsonb_array_length(c->'blocks')<=10
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c->'blocks') b WHERE NOT (jsonb_typeof(b)='object'
      AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(b) k)=ARRAY['position','text']
      AND jsonb_typeof(b->'position')='string' AND b->>'position' IN ('ABOVE','BELOW') AND hon.checkout_i18n_ok(b->'text',2000,true)))
    -- Multi-participant: off means exactly one participant per order.
    AND jsonb_typeof(c->'multiParticipant')='object'
    AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(c->'multiParticipant') k)=ARRAY['enabled','maxPerOrder']
    AND jsonb_typeof(c->'multiParticipant'->'enabled')='boolean' AND hon.checkout_int_ok(c->'multiParticipant'->'maxPerOrder',1,10)
    AND (c->'multiParticipant'->>'enabled'='true' OR c->'multiParticipant'->>'maxPerOrder'='1')
    AND hon.checkout_fields_ok(c->'customFields')
    -- Add-ons (the 0269 rule) in the page currency.
    AND jsonb_typeof(c->'addOns')='array' AND jsonb_array_length(c->'addOns')<=10
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c->'addOns') a WHERE NOT (jsonb_typeof(a)='object'
      AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(a) k)=ARRAY['amountMinor','currency','key','label','required']
      AND jsonb_typeof(a->'key')='string' AND a->>'key' ~ '^[a-z][a-z0-9_]{0,39}$'
      AND hon.checkout_i18n_ok(a->'label',80,false) AND hon.checkout_int_ok(a->'amountMinor',1,99999999)
      AND jsonb_typeof(a->'currency')='string' AND a->>'currency'=c->>'currency' AND jsonb_typeof(a->'required')='boolean'))
    AND (SELECT count(DISTINCT a->>'key') FROM jsonb_array_elements(c->'addOns') a)=jsonb_array_length(c->'addOns')
    -- Pricing options: at most 10, distinct keys, at most one most-popular.
    AND jsonb_typeof(c->'options')='array' AND jsonb_array_length(c->'options')<=10
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c->'options') o WHERE NOT hon.checkout_option_ok(o))
    AND (SELECT count(DISTINCT o->>'key') FROM jsonb_array_elements(c->'options') o)=jsonb_array_length(c->'options')
    AND (SELECT count(*) FROM jsonb_array_elements(c->'options') o WHERE o->>'mostPopular'='true')<=1
    -- The 0269 waiver, receipt and thank-you text.
    AND (jsonb_typeof(c->'waiver')='null' OR (jsonb_typeof(c->'waiver')='object'
      AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(c->'waiver') k)=ARRAY['text']
      AND hon.checkout_i18n_ok(c->'waiver'->'text',5000,true)))
    AND (jsonb_typeof(c->'receiptNote')='null' OR hon.checkout_i18n_ok(c->'receiptNote',1000,true))
    AND (jsonb_typeof(c->'thankYou')='null' OR hon.checkout_i18n_ok(c->'thankYou',1000,true)),false)
$$;

-- C2: the groups list (1..20, distinct keys, short labels).
CREATE FUNCTION hon.school_checkout_groups_ok(g jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(jsonb_typeof(g)='array' AND jsonb_array_length(g) BETWEEN 1 AND 20
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(g) x WHERE NOT (jsonb_typeof(x)='object'
      AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(x) k)=ARRAY['key','label']
      AND jsonb_typeof(x->'key')='string' AND x->>'key' ~ '^[a-z][a-z0-9_]{0,39}$' AND hon.checkout_i18n_ok(x->'label',40,false)))
    AND (SELECT count(DISTINCT x->>'key') FROM jsonb_array_elements(g) x)=jsonb_array_length(g),false)
$$;
-- The groups a school starts with (the current CRM's list).
CREATE FUNCTION hon.school_checkout_default_groups() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT '[{"key":"trial","label":{"en":"Trial"}},{"key":"membership","label":{"en":"Membership"}},{"key":"event","label":{"en":"Event"}},
    {"key":"tournament","label":{"en":"Tournament"}},{"key":"test","label":{"en":"Test"}},{"key":"equipment","label":{"en":"Equipment"}},
    {"key":"camp","label":{"en":"Camp"}},{"key":"sales","label":{"en":"Sales"}}]'::jsonb
$$;

-- C1: one row per page.
CREATE TABLE hon.school_checkouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,59}$' AND slug !~ '--' AND slug !~ '-$'),
  group_key text NOT NULL CHECK (group_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  status text NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  content jsonb NOT NULL CHECK (hon.school_checkout_content_ok(content)),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (status<>'PUBLISHED' OR jsonb_array_length(content->'options')>=1),
  UNIQUE(school_id,slug),
  UNIQUE(id,school_id),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
ALTER TABLE hon.school_checkouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_checkouts FORCE ROW LEVEL SECURITY;
CREATE TABLE hon.school_checkout_versions (
  checkout_id uuid NOT NULL REFERENCES hon.school_checkouts(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version>=1),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  slug text NOT NULL,
  group_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  content jsonb NOT NULL CHECK (hon.school_checkout_content_ok(content)),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(checkout_id,version),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
ALTER TABLE hon.school_checkout_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_checkout_versions FORCE ROW LEVEL SECURITY;
-- C2: one row per school.
CREATE TABLE hon.school_checkout_settings (
  organization_id uuid NOT NULL,
  school_id uuid PRIMARY KEY,
  groups jsonb NOT NULL CHECK (hon.school_checkout_groups_ok(groups)),
  page_order uuid[] NOT NULL CHECK (cardinality(page_order)<=500 AND array_position(page_order,NULL) IS NULL),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
ALTER TABLE hon.school_checkout_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_checkout_settings FORCE ROW LEVEL SECURITY;

CREATE TRIGGER school_checkout_versions_immutable BEFORE UPDATE OR DELETE ON hon.school_checkout_versions
  FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_checkout_versions_no_truncate BEFORE TRUNCATE ON hon.school_checkout_versions
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_checkouts_no_truncate BEFORE TRUNCATE ON hon.school_checkouts
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_checkout_settings_no_truncate BEFORE TRUNCATE ON hon.school_checkout_settings
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- Page and settings guard, whoever writes: no delete; scope, slug and creation facts never change; every update bumps the
-- version by exactly one.
CREATE FUNCTION hon.guard_school_checkout() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'School checkouts are never deleted' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 THEN RAISE EXCEPTION 'A new school checkout row starts at version 1' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='school_checkouts' THEN
    IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id OR NEW.slug<>OLD.slug
      OR NEW.created_by_principal_id<>OLD.created_by_principal_id OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 THEN
      RAISE EXCEPTION 'Checkout scope, slug and history are fixed' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'Checkout settings scope and history are fixed' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_checkout_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_checkouts
  FOR EACH ROW EXECUTE FUNCTION hon.guard_school_checkout();
CREATE TRIGGER school_checkout_settings_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_checkout_settings
  FOR EACH ROW EXECUTE FUNCTION hon.guard_school_checkout();

CREATE FUNCTION hon.school_checkout_json(c hon.school_checkouts) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('pageId',c.id,'slug',c.slug,'groupKey',c.group_key,'status',c.status,'content',c.content,'version',c.version,
    'updatedAt',to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
$$;
-- The settings in effect (the defaults at version 0 when the school has none).
CREATE FUNCTION hon.school_checkout_settings_json(org uuid,school uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce((SELECT jsonb_build_object('version',s.version,'groups',s.groups,'pageOrder',to_jsonb(s.page_order))
      FROM hon.school_checkout_settings s WHERE s.organization_id=org AND s.school_id=school),
    jsonb_build_object('version',0,'groups',hon.school_checkout_default_groups(),'pageOrder','[]'::jsonb))
$$;

-- Shared command preamble: argument shape, live actor, idempotency reservation and replay.
CREATE FUNCTION hon.school_checkout_begin(subject text,operation text,p jsonb,key text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; reserved boolean;
  prior hon.idempotency_records%ROWTYPE;
BEGIN
  fp:=encode(sha256(convert_to(jsonb_build_object('operation',operation,'input',p)::text,'UTF8')),'hex');
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
    RETURN jsonb_build_object('actor',actor,'replay',prior.response_body);
  END IF;
  RETURN jsonb_build_object('actor',actor,'replay',NULL);
END $$;
-- Shared command ending: record the response, re-check the actor.
CREATE FUNCTION hon.school_checkout_finish(subject text,actor uuid,key text,result jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
BEGIN
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND principal_id=actor AND idempotency_key=key;
  IF NOT FOUND OR hon.require_school_checkout_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_CHECKOUT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- Read: settings, every page in the staff order, and this school's catalog plans with their current terms.
CREATE FUNCTION hon.read_school_checkouts(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; result jsonb; s jsonb;
BEGIN
  actor:=hon.require_school_checkout_actor(subject);
  s:=hon.school_checkout_settings_json(org,school);
  result:=jsonb_build_object('settings',s,
    'pages',coalesce((SELECT jsonb_agg(hon.school_checkout_json(c)
        ORDER BY coalesce(array_position(ARRAY(SELECT jsonb_array_elements_text(s->'pageOrder')::uuid),c.id),2147483647),c.created_at,c.id)
      FROM (SELECT * FROM hon.school_checkouts x WHERE x.organization_id=org AND x.school_id=school ORDER BY x.created_at,x.id LIMIT 200) c),'[]'::jsonb),
    'plans',coalesce((SELECT jsonb_agg(jsonb_build_object('planId',m.id,'displayName',v.display_name,'priceMinor',v.price_minor,'currency',v.currency,
        'billingFrequency',v.billing_frequency,'available',v.availability='AVAILABLE') ORDER BY v.display_name,m.id)
      FROM (SELECT * FROM hon.membership_plans x WHERE x.organization_id=org AND x.school_id=school ORDER BY x.id LIMIT 200) m
      JOIN hon.membership_plan_versions v ON v.plan_id=m.id AND v.version=m.current_version),'[]'::jsonb));
  IF hon.require_school_checkout_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_CHECKOUT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- Save one page: create (pageId null, expectedVersion 0) or replace (pageId, current version).
CREATE FUNCTION hon.save_school_checkout(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; begun jsonb;
  c hon.school_checkouts%ROWTYPE; before jsonb; next jsonb; result jsonb; expected integer;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['content','expectedVersion','groupKey','pageId','slug','status']
    OR NOT hon.checkout_int_ok(p->'expectedVersion',0,999999999)
    OR NOT (jsonb_typeof(p->'pageId')='null' OR (jsonb_typeof(p->'pageId')='string'
      AND p->>'pageId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    OR (jsonb_typeof(p->'pageId')='null') <> (p->>'expectedVersion'='0')
    OR jsonb_typeof(p->'slug') IS DISTINCT FROM 'string' OR p->>'slug' !~ '^[a-z0-9][a-z0-9-]{1,59}$' OR p->>'slug' ~ '--' OR p->>'slug' ~ '-$'
    OR jsonb_typeof(p->'groupKey') IS DISTINCT FROM 'string' OR p->>'groupKey' !~ '^[a-z][a-z0-9_]{0,39}$'
    OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR p->>'status' NOT IN ('DRAFT','PUBLISHED','ARCHIVED')
    OR NOT hon.school_checkout_content_ok(p->'content') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  expected:=(p->>'expectedVersion')::integer;
  begun:=hon.school_checkout_begin(subject,'school_checkout.save',p,key);
  actor:=(begun->>'actor')::uuid;
  IF jsonb_typeof(begun->'replay')='object' THEN RETURN jsonb_build_object('receipt',begun->'replay','replayed',true); END IF;
  IF p->>'status'='PUBLISHED' AND jsonb_array_length(p->'content'->'options')=0 THEN RAISE EXCEPTION 'CHECKOUT_OPTIONS_REQUIRED' USING ERRCODE='22023'; END IF;
  -- C3: every named plan is this school's catalog plan, AVAILABLE unless the page is being archived.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'content'->'options') o WHERE jsonb_typeof(o->'planId')='string' AND NOT EXISTS(
      SELECT 1 FROM hon.membership_plans m JOIN hon.membership_plan_versions v ON v.plan_id=m.id AND v.version=m.current_version
      WHERE m.id=(o->>'planId')::uuid AND m.organization_id=org AND m.school_id=school AND (p->>'status'='ARCHIVED' OR v.availability='AVAILABLE'))) THEN
    RAISE EXCEPTION 'CHECKOUT_PLAN_UNAVAILABLE' USING ERRCODE='22023'; END IF;
  -- One writer per school at a time (settings, slugs and the page cap).
  PERFORM 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org FOR NO KEY UPDATE;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(hon.school_checkout_settings_json(org,school)->'groups') g WHERE g->>'key'=p->>'groupKey') THEN
    RAISE EXCEPTION 'CHECKOUT_GROUP_UNKNOWN' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(p->'pageId')='string' THEN
    SELECT * INTO c FROM hon.school_checkouts x WHERE x.id=(p->>'pageId')::uuid AND x.organization_id=org AND x.school_id=school FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CHECKOUT_NOT_FOUND' USING ERRCODE='22023'; END IF;
    IF c.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    IF c.slug<>p->>'slug' THEN RAISE EXCEPTION 'CHECKOUT_SLUG_FIXED' USING ERRCODE='22023'; END IF;
    before:=hon.school_checkout_json(c);
    UPDATE hon.school_checkouts SET group_key=p->>'groupKey',status=p->>'status',content=p->'content',version=c.version+1,
      updated_by_principal_id=actor,updated_at=clock_timestamp() WHERE id=c.id RETURNING * INTO c;
  ELSE
    IF EXISTS(SELECT 1 FROM hon.school_checkouts x WHERE x.school_id=school AND x.slug=p->>'slug') THEN
      RAISE EXCEPTION 'CHECKOUT_SLUG_TAKEN' USING ERRCODE='22023'; END IF;
    IF (SELECT count(*) FROM hon.school_checkouts x WHERE x.organization_id=org AND x.school_id=school)>=200 THEN
      RAISE EXCEPTION 'CHECKOUT_LIMIT_REACHED' USING ERRCODE='22023'; END IF;
    INSERT INTO hon.school_checkouts(organization_id,school_id,slug,group_key,status,content,created_by_principal_id,updated_by_principal_id)
      VALUES(org,school,p->>'slug',p->>'groupKey',p->>'status',p->'content',actor,actor) RETURNING * INTO c;
  END IF;
  next:=hon.school_checkout_json(c);
  INSERT INTO hon.school_checkout_versions(checkout_id,version,organization_id,school_id,slug,group_key,status,content,actor_principal_id)
    VALUES(c.id,c.version,org,school,c.slug,c.group_key,c.status,c.content,actor);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','school_checkout.save','SCHOOL_CHECKOUT',c.id,before,next,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'school_checkout.saved',1,'SCHOOL_CHECKOUT',c.id,c.version,correlation,request,next);
  result:=jsonb_build_object('page',next);
  RETURN hon.school_checkout_finish(subject,actor,key,result);
END $$;

-- Save the groups and the staff grid order. A group a page still uses cannot be removed; the order lists only this
-- school's pages, each once.
CREATE FUNCTION hon.save_school_checkout_settings(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; begun jsonb;
  s hon.school_checkout_settings%ROWTYPE; before jsonb; next jsonb; result jsonb; expected integer; ids uuid[];
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['expectedVersion','groups','pageOrder']
    OR NOT hon.checkout_int_ok(p->'expectedVersion',0,999999999) OR NOT hon.school_checkout_groups_ok(p->'groups')
    OR jsonb_typeof(p->'pageOrder') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'pageOrder')>500
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'pageOrder') x WHERE jsonb_typeof(x)<>'string'
      OR x#>>'{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    OR (SELECT count(DISTINCT x#>>'{}') FROM jsonb_array_elements(p->'pageOrder') x)<>jsonb_array_length(p->'pageOrder') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  expected:=(p->>'expectedVersion')::integer;
  ids:=ARRAY(SELECT (x#>>'{}')::uuid FROM jsonb_array_elements(p->'pageOrder') WITH ORDINALITY t(x,n) ORDER BY n);
  begun:=hon.school_checkout_begin(subject,'school_checkout.settings.save',p,key);
  actor:=(begun->>'actor')::uuid;
  IF jsonb_typeof(begun->'replay')='object' THEN RETURN jsonb_build_object('receipt',begun->'replay','replayed',true); END IF;
  PERFORM 1 FROM hon.schools x WHERE x.id=school AND x.organization_id=org FOR NO KEY UPDATE;
  IF EXISTS(SELECT 1 FROM unnest(ids) i WHERE NOT EXISTS(SELECT 1 FROM hon.school_checkouts c WHERE c.id=i AND c.organization_id=org AND c.school_id=school)) THEN
    RAISE EXCEPTION 'CHECKOUT_NOT_FOUND' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM hon.school_checkouts c WHERE c.organization_id=org AND c.school_id=school
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'groups') g WHERE g->>'key'=c.group_key)) THEN
    RAISE EXCEPTION 'CHECKOUT_GROUP_IN_USE' USING ERRCODE='22023'; END IF;
  SELECT * INTO s FROM hon.school_checkout_settings x WHERE x.organization_id=org AND x.school_id=school FOR UPDATE;
  before:=hon.school_checkout_settings_json(org,school);
  IF FOUND THEN
    IF s.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    UPDATE hon.school_checkout_settings SET groups=p->'groups',page_order=ids,version=s.version+1,updated_by_principal_id=actor,updated_at=clock_timestamp()
      WHERE school_id=school RETURNING * INTO s;
  ELSE
    IF expected<>0 THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    INSERT INTO hon.school_checkout_settings(organization_id,school_id,groups,page_order,updated_by_principal_id)
      VALUES(org,school,p->'groups',ids,actor) RETURNING * INTO s;
  END IF;
  next:=hon.school_checkout_settings_json(org,school);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','school_checkout.settings.save','SCHOOL_CHECKOUT_SETTINGS',school,before,next,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'school_checkout.settings.saved',1,'SCHOOL_CHECKOUT_SETTINGS',school,s.version,correlation,request,next);
  result:=jsonb_build_object('settings',next);
  RETURN hon.school_checkout_finish(subject,actor,key,result);
END $$;

-- C5: copy any 0269 page as a DRAFT page without plans (nothing is deployed; this keeps disposable and test data).
INSERT INTO hon.school_checkouts(organization_id,school_id,slug,group_key,status,content,created_by_principal_id,updated_by_principal_id,created_at,updated_at)
SELECT o.organization_id,o.school_id,lower(o.kind),'membership','DRAFT',
  jsonb_build_object('currency',coalesce(CASE WHEN (SELECT count(DISTINCT a->>'currency') FROM jsonb_array_elements(o.content->'addOns') a)=1
      THEN o.content->'addOns'->0->>'currency' END,'USD'),
    'title',CASE o.kind WHEN 'ENROLLMENT' THEN '{"en":"Enrollment"}'::jsonb ELSE '{"en":"Tuition payment"}'::jsonb END,
    'description',NULL,'blocks','[]'::jsonb,'multiParticipant','{"enabled":false,"maxPerOrder":1}'::jsonb,
    'customFields',o.content->'customFields',
    'addOns',CASE WHEN (SELECT count(DISTINCT a->>'currency') FROM jsonb_array_elements(o.content->'addOns') a)<=1 THEN o.content->'addOns' ELSE '[]'::jsonb END,
    'options','[]'::jsonb,'waiver',o.content->'waiver','receiptNote',o.content->'receiptNote','thankYou',o.content->'thankYou'),
  o.created_by_principal_id,o.updated_by_principal_id,o.created_at,o.updated_at
FROM hon.school_checkout_pages o
WHERE NOT EXISTS(SELECT 1 FROM hon.school_checkouts x WHERE x.school_id=o.school_id AND x.slug=lower(o.kind))
ORDER BY o.created_at,o.id;
INSERT INTO hon.school_checkout_versions(checkout_id,version,organization_id,school_id,slug,group_key,status,content,actor_principal_id,created_at)
SELECT c.id,1,c.organization_id,c.school_id,c.slug,c.group_key,c.status,c.content,c.updated_by_principal_id,c.updated_at FROM hon.school_checkouts c
WHERE NOT EXISTS(SELECT 1 FROM hon.school_checkout_versions v WHERE v.checkout_id=c.id);
-- End C5 carry-over.

DO $$ DECLARE r record; t text; col text;
  private_fns text:='hon.checkout_int_ok(jsonb,bigint,bigint),hon.checkout_fields_ok(jsonb),hon.checkout_option_ok(jsonb),hon.school_checkout_content_ok(jsonb),'
    'hon.school_checkout_groups_ok(jsonb),hon.school_checkout_default_groups(),hon.guard_school_checkout(),hon.school_checkout_json(hon.school_checkouts),'
    'hon.school_checkout_settings_json(uuid,uuid),hon.school_checkout_begin(text,text,jsonb,text),hon.school_checkout_finish(text,uuid,text,jsonb)';
  entry_fns text:='hon.read_school_checkouts(text),hon.save_school_checkout(text,jsonb,text,uuid,uuid),hon.save_school_checkout_settings(text,jsonb,text,uuid,uuid)';
  retired_fns text:='hon.read_school_checkout_pages(text),hon.save_school_checkout_page(text,jsonb,text,uuid,uuid)';
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s,%s,%s FROM PUBLIC',private_fns,entry_fns,retired_fns);
  FOREACH t IN ARRAY ARRAY['school_checkouts','school_checkout_versions','school_checkout_settings'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',col,t);
    END LOOP;
  END LOOP;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s,%s,%s FROM %I',private_fns,entry_fns,retired_fns,r.rolname);
    FOREACH t IN ARRAY ARRAY['school_checkouts','school_checkout_versions','school_checkout_settings'] LOOP
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
    FOREACH t IN ARRAY ARRAY['hon.school_checkouts','hon.school_checkout_versions','hon.school_checkout_settings'] LOOP
      IF has_table_privilege('hon_runtime',t,'SELECT') OR has_any_column_privilege('hon_runtime',t,'SELECT') OR has_table_privilege('hon_runtime',t,'INSERT')
        OR has_table_privilege('hon_runtime',t,'UPDATE') OR has_table_privilege('hon_runtime',t,'DELETE') THEN
        RAISE EXCEPTION 'School checkouts must not widen runtime privileges';
      END IF;
    END LOOP;
    IF has_function_privilege('hon_runtime','hon.save_school_checkout_page(text,jsonb,text,uuid,uuid)','EXECUTE')
      OR has_function_privilege('hon_runtime','hon.read_school_checkout_pages(text)','EXECUTE') THEN
      RAISE EXCEPTION 'The 0269 checkout entry points must be retired';
    END IF;
  END IF;
END $$;
COMMIT;
