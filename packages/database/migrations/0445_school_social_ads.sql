BEGIN;

-- S4 (0445; allocated as 0350 on 2026-11-14, then 0428 and 0437, renumbered 2026-11-17): a school boosts a Facebook post HON already published, inside the
-- school's own monthly ad spend cap, through Zernio (docs/architecture/SOCIAL_POSTING_INBOX_ADS.md §4C). Builds on
-- 0347/0348. Nothing is created or spent unless the API server has HON_ZERNIO_ADS_APPROVED=true and a Zernio key; tests
-- use the deterministic fake.
-- - Meta charges the school's own ad account. HON never pays, marks up or holds ad spend.
-- - A person with marketing.social.ads.budget sets the cap (no cap, or 0, means no ad can be approved). Every ad has a
--   lifetime budget and a 1 to 31 day date range. Its whole budget counts against every calendar month its range
--   touches, for as long as it may still spend, so Meta can never be allowed to spend more than the cap in any month.
-- - Approving creates the ad PAUSED. Turning it on is a separate human command and the only step that spends.
-- - Each Zernio call is made at most once: the database records it (CREATING, ACTIVATING, PAUSING) under a 60-second
--   lease before the API calls Zernio; a lost answer or a lease that ran out is UNKNOWN, never resent; a person settles
--   it. Pausing is always allowed for an ad that may be spending.
-- - Identifier-only audit and inert outbox. No provider text is stored.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regclass('hon.school_social_post_targets') IS NULL OR to_regprocedure('hon.school_social_command_begin(uuid,uuid,uuid,text,text,text)') IS NULL
    OR to_regclass('hon.school_social_conversations') IS NULL THEN RAISE EXCEPTION '0445 requires the 0347, 0348 and 0435 school social records'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('marketing.social.ads','Create, turn on and pause the school''s Facebook ads inside its monthly ad spend cap',true,true),
  ('marketing.social.ads.budget','Set the school''s monthly ad spend cap',true,true)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
  SELECT r.id,r.organization_id,x.code FROM hon.roles r CROSS JOIN (VALUES ('marketing.social.ads'),('marketing.social.ads.budget')) x(code)
  WHERE r.code='OWNER' AND r.is_system_role
  ON CONFLICT (role_id,permission_code) DO NOTHING;

ALTER TABLE hon.school_social_commands DROP CONSTRAINT school_social_commands_operation_check;
ALTER TABLE hon.school_social_commands ADD CONSTRAINT school_social_commands_operation_check
  CHECK (operation IN ('CHANGE','POST_CREATE','POST_EDIT','POST_APPROVE','POST_CANCEL','POST_RESOLVE',
    'INBOX_REPLY','INBOX_CHANGE','INBOX_RESOLVE','INBOX_COMMENT','AD_BUDGET','AD_CREATE','AD_CANCEL','AD_START','AD_RESOLVE'));

CREATE TABLE hon.school_social_ad_budgets (
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  monthly_cap_cents integer NOT NULL CHECK (monthly_cap_cents BETWEEN 0 AND 1000000),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  set_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (school_id),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id)
);

CREATE TABLE hon.school_social_ads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES hon.school_social_accounts(id),
  target_id uuid NOT NULL REFERENCES hon.school_social_post_targets(id),
  budget_cents integer NOT NULL CHECK (budget_cents BETWEEN 100 AND 1000000),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  starts_on date NOT NULL, ends_on date NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT','CREATING','PAUSED','ACTIVATING','ACTIVE','PAUSING','FAILED','UNKNOWN','CANCELLED')),
  -- The operation in flight (or last in flight, for UNKNOWN) and the state to return to when Zernio refuses it.
  operation text CHECK (operation IN ('CREATE','ACTIVATE','PAUSE')),
  prior_status text CHECK (prior_status IN ('PAUSED','ACTIVE','UNKNOWN')),
  lease_token uuid, lease_expires_at timestamptz,
  provider_ad_id text UNIQUE CHECK (provider_ad_id IS NULL OR provider_ad_id ~ '^[0-9A-Za-z_:.-]{1,128}$'),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  approved_by_principal_id uuid REFERENCES hon.principals(id),
  activated_by_principal_id uuid REFERENCES hon.principals(id),
  resolved_by_principal_id uuid REFERENCES hon.principals(id),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK (ends_on>=starts_on AND ends_on-starts_on<=30),
  CHECK ((status IN ('CREATING','ACTIVATING','PAUSING'))<=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND operation IS NOT NULL)),
  CHECK ((status='DRAFT')=(approved_by_principal_id IS NULL) OR status='CANCELLED'),
  CHECK (status NOT IN ('PAUSED','ACTIVATING','ACTIVE','PAUSING') OR provider_ad_id IS NOT NULL)
);
CREATE INDEX school_social_ads_school_idx ON hon.school_social_ads (organization_id,school_id,created_at DESC,id DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['school_social_ad_budgets','school_social_ads'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  END LOOP;
END $$;

-- An ad keeps its school, account, post, budget and dates. Status moves only along the reviewed paths; the provider
-- ad id, once set, never changes; budgets change only by version. Nothing is deleted or truncated.
CREATE FUNCTION hon.guard_school_social_ads() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='school_social_ad_budgets' THEN
    IF (NEW.organization_id,NEW.school_id) IS NOT DISTINCT FROM (OLD.organization_id,OLD.school_id) AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
  ELSIF TG_OP='UPDATE' AND TG_TABLE_NAME='school_social_ads' THEN
    IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.account_id,NEW.target_id,NEW.budget_cents,NEW.currency,NEW.starts_on,NEW.ends_on,NEW.created_by_principal_id,NEW.created_at)
      IS NOT DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.account_id,OLD.target_id,OLD.budget_cents,OLD.currency,OLD.starts_on,OLD.ends_on,OLD.created_by_principal_id,OLD.created_at)
      AND NEW.version=OLD.version+1 AND (OLD.provider_ad_id IS NULL OR NEW.provider_ad_id IS NOT DISTINCT FROM OLD.provider_ad_id)
      AND (OLD.approved_by_principal_id IS NULL OR NEW.approved_by_principal_id IS NOT DISTINCT FROM OLD.approved_by_principal_id)
      AND (OLD.status,NEW.status) IN (('DRAFT','CREATING'),('DRAFT','CANCELLED'),
        ('CREATING','PAUSED'),('CREATING','FAILED'),('CREATING','UNKNOWN'),
        ('PAUSED','ACTIVATING'),('ACTIVATING','ACTIVE'),('ACTIVATING','PAUSED'),('ACTIVATING','UNKNOWN'),
        ('ACTIVE','PAUSING'),('UNKNOWN','PAUSING'),('PAUSING','PAUSED'),('PAUSING','ACTIVE'),('PAUSING','UNKNOWN'),
        -- a late answer under its own lease, or a person's resolution
        ('UNKNOWN','PAUSED'),('UNKNOWN','ACTIVE'),('UNKNOWN','FAILED')) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'SOCIAL_RECORD_IMMUTABLE' USING ERRCODE='42501';
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['school_social_ad_budgets','school_social_ads'] LOOP
    EXECUTE format('CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_school_social_ads()',t);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_social_ads()',t);
  END LOOP;
END $$;

-- 0445 adds the two ads permissions to the permissions the 0347 actor check accepts (otherwise unchanged).
CREATE OR REPLACE FUNCTION hon.require_school_social_actor(p_subject text,p_permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF p_permission NOT IN ('marketing.social.manage','marketing.social.read','marketing.social.post','marketing.social.inbox','marketing.social.ads','marketing.social.ads.budget')
    OR p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 2048 OR btrim(p_subject)<>p_subject
    OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=p_subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
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
        AND x.code=p_permission AND x.is_staff_assignable)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- The school's local date today.
CREATE FUNCTION hon.school_social_today(p_school uuid) RETURNS date
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT (clock_timestamp() AT TIME ZONE s.timezone)::date FROM hon.schools s WHERE s.id=p_school;
$$;

-- An ad whose lease ran out without an answer reads as UNKNOWN: it is never resent.
CREATE FUNCTION hon.school_social_ad_json(d hon.school_social_ads) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('adId',d.id,'accountId',d.account_id,'targetId',d.target_id,'postId',t.post_id,'accountName',a.display_name,
    'budgetCents',d.budget_cents,'currency',d.currency,'startsOn',to_char(d.starts_on,'YYYY-MM-DD'),'endsOn',to_char(d.ends_on,'YYYY-MM-DD'),
    'status',CASE WHEN d.status IN ('CREATING','ACTIVATING','PAUSING') AND d.lease_expires_at<=clock_timestamp() THEN 'UNKNOWN' ELSE d.status END,
    'operation',d.operation,'resolvedByPerson',d.resolved_by_principal_id IS NOT NULL,'createdAt',hon.saas_ts(d.created_at),'version',d.version)
  FROM hon.school_social_accounts a, hon.school_social_post_targets t WHERE a.id=d.account_id AND t.id=d.target_id;
$$;

-- The whole budget of every ad that may still spend (or might exist at Meta) counts in each month its range touches.
CREATE FUNCTION hon.school_social_ad_committed(p_org uuid,p_school uuid,p_month date) RETURNS bigint
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(sum(d.budget_cents),0)::bigint FROM hon.school_social_ads d
  WHERE d.organization_id=p_org AND d.school_id=p_school AND d.status IN ('CREATING','PAUSED','ACTIVATING','ACTIVE','PAUSING','UNKNOWN')
    AND d.starts_on<(date_trunc('month',p_month)+interval '1 month')::date AND d.ends_on>=date_trunc('month',p_month)::date;
$$;

CREATE FUNCTION hon.school_social_ads_view(p_org uuid,p_school uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object(
    'budget',(SELECT jsonb_build_object('monthlyCapCents',b.monthly_cap_cents,'currency',b.currency,'version',b.version)
      FROM hon.school_social_ad_budgets b WHERE b.organization_id=p_org AND b.school_id=p_school),
    'committedThisMonthCents',hon.school_social_ad_committed(p_org,p_school,hon.school_social_today(p_school)),
    'ads',coalesce((SELECT jsonb_agg(hon.school_social_ad_json(x) ORDER BY x.created_at DESC,x.id DESC) FROM
      (SELECT * FROM hon.school_social_ads d WHERE d.organization_id=p_org AND d.school_id=p_school ORDER BY d.created_at DESC,d.id DESC LIMIT 100) x),'[]'::jsonb),
    'today',to_char(hon.school_social_today(p_school),'YYYY-MM-DD'),'checkedAt',hon.saas_ts(clock_timestamp()));
$$;

-- READ the school's cap, what is committed this month and the newest 100 ads.
CREATE FUNCTION hon.read_school_social_ads(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  PERFORM hon.require_school_social_actor(p_subject,'marketing.social.ads');
  RETURN hon.school_social_ads_view(hon.current_organization_id(),hon.current_school_id());
END $$;

-- BUDGET {monthlyCapCents, currency, expectedVersion?}: expectedVersion is required once a cap exists. Lowering the cap
-- below what is already committed is allowed (it stops new approvals and activations; nothing already on is changed).
CREATE FUNCTION hon.set_school_social_ad_budget(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; b hon.school_social_ad_budgets%ROWTYPE;
  keys text[]; result jsonb;
BEGIN
  keys:=(SELECT coalesce(array_agg(x ORDER BY x),'{}') FROM jsonb_object_keys(CASE WHEN jsonb_typeof(p_input)='object' THEN p_input ELSE '{}'::jsonb END) x);
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR NOT keys<@ARRAY['currency','expectedVersion','monthlyCapCents'] OR NOT ARRAY['currency','monthlyCapCents']<@keys
    OR jsonb_typeof(p_input->'monthlyCapCents') IS DISTINCT FROM 'number' OR (p_input->>'monthlyCapCents') !~ '^(0|[1-9][0-9]{0,6})$'
    OR (p_input->>'monthlyCapCents')::integer>1000000
    OR jsonb_typeof(p_input->'currency') IS DISTINCT FROM 'string' OR (p_input->>'currency') !~ '^[A-Z]{3}$'
    OR (p_input ? 'expectedVersion' AND (jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$')) THEN
    RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.ads.budget');
  prior:=hon.school_social_command_begin(org,school,actor,p_key,'AD_BUDGET',
    encode(sha256(convert_to('marketing.social.ads.budget:'||p_input::text,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('record',prior,'replayed',true); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('social-ad-budget:'||school::text,0));
  SELECT * INTO b FROM hon.school_social_ad_budgets WHERE organization_id=org AND school_id=school FOR UPDATE;
  IF b.school_id IS NULL THEN
    IF p_input ? 'expectedVersion' THEN RAISE EXCEPTION 'SOCIAL_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    INSERT INTO hon.school_social_ad_budgets(organization_id,school_id,monthly_cap_cents,currency,set_by_principal_id)
      VALUES(org,school,(p_input->>'monthlyCapCents')::integer,p_input->>'currency',actor) RETURNING * INTO b;
  ELSE
    IF NOT p_input ? 'expectedVersion' OR b.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SOCIAL_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    -- The currency is fixed once any ad exists: budgets already committed are in it.
    IF b.currency<>(p_input->>'currency') AND EXISTS(SELECT 1 FROM hon.school_social_ads d WHERE d.organization_id=org AND d.school_id=school AND d.status<>'CANCELLED') THEN
      RAISE EXCEPTION 'SOCIAL_AD_CURRENCY_FIXED' USING ERRCODE='55000'; END IF;
    UPDATE hon.school_social_ad_budgets SET monthly_cap_cents=(p_input->>'monthlyCapCents')::integer,currency=p_input->>'currency',set_by_principal_id=actor,
      version=version+1,updated_at=clock_timestamp() WHERE school_id=school RETURNING * INTO b;
  END IF;
  PERFORM hon.school_social_evidence(org,school,actor,'marketing.social.ads.budget_set','SCHOOL_SOCIAL_AD_BUDGET',school,b.version,
    jsonb_build_object('monthlyCapCents',b.monthly_cap_cents,'currency',b.currency),p_request,p_correlation);
  result:=hon.school_social_ads_view(org,school);
  PERFORM hon.school_social_command_finish(org,school,actor,p_key,result);
  IF hon.require_school_social_actor(p_subject,'marketing.social.ads.budget') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

-- DRAFT {targetId, budgetCents, startsOn, endsOn}: the target must be a PUBLISHED Facebook post of this school whose
-- account is CONNECTED with ads on; dates 1 to 31 days, from today (school time) up to 90 days ahead.
CREATE FUNCTION hon.create_school_social_ad(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; t hon.school_social_post_targets%ROWTYPE;
  a hon.school_social_accounts%ROWTYPE; b hon.school_social_ad_budgets%ROWTYPE; d hon.school_social_ads%ROWTYPE; v_start date; v_end date; today date; result jsonb;
BEGIN
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['budgetCents','endsOn','startsOn','targetId']
    OR jsonb_typeof(p_input->'targetId') IS DISTINCT FROM 'string' OR (p_input->>'targetId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_input->'budgetCents') IS DISTINCT FROM 'number' OR (p_input->>'budgetCents') !~ '^[1-9][0-9]{2,6}$' OR (p_input->>'budgetCents')::integer>1000000
    OR jsonb_typeof(p_input->'startsOn') IS DISTINCT FROM 'string' OR (p_input->>'startsOn') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR jsonb_typeof(p_input->'endsOn') IS DISTINCT FROM 'string' OR (p_input->>'endsOn') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  BEGIN v_start:=(p_input->>'startsOn')::date; v_end:=(p_input->>'endsOn')::date; EXCEPTION WHEN others THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END;
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.ads');
  prior:=hon.school_social_command_begin(org,school,actor,p_key,'AD_CREATE',
    encode(sha256(convert_to('marketing.social.ads.create:'||p_input::text,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('record',prior,'replayed',true); END IF;
  today:=hon.school_social_today(school);
  IF v_end<v_start OR v_end-v_start>30 OR v_start<today OR v_start>today+90 THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO t FROM hon.school_social_post_targets WHERE id=(p_input->>'targetId')::uuid AND organization_id=org AND school_id=school;
  IF t.id IS NULL THEN RAISE EXCEPTION 'SOCIAL_POST_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF t.status<>'PUBLISHED' OR t.provider_post_id IS NULL THEN RAISE EXCEPTION 'SOCIAL_AD_POST_NOT_PUBLISHED' USING ERRCODE='55000'; END IF;
  SELECT * INTO a FROM hon.school_social_accounts WHERE id=t.account_id AND organization_id=org AND school_id=school FOR SHARE;
  IF a.id IS NULL OR a.status<>'CONNECTED' OR NOT a.ads_enabled OR a.platform<>'FACEBOOK' THEN RAISE EXCEPTION 'SOCIAL_ADS_OFF' USING ERRCODE='23514'; END IF;
  SELECT * INTO b FROM hon.school_social_ad_budgets WHERE organization_id=org AND school_id=school;
  IF b.school_id IS NULL OR b.monthly_cap_cents=0 THEN RAISE EXCEPTION 'SOCIAL_AD_NO_BUDGET' USING ERRCODE='23514'; END IF;
  IF (p_input->>'budgetCents')::integer>b.monthly_cap_cents THEN RAISE EXCEPTION 'SOCIAL_AD_OVER_CAP' USING ERRCODE='23514'; END IF;
  INSERT INTO hon.school_social_ads(organization_id,school_id,account_id,target_id,budget_cents,currency,starts_on,ends_on,status,created_by_principal_id)
    VALUES(org,school,a.id,t.id,(p_input->>'budgetCents')::integer,b.currency,v_start,v_end,'DRAFT',actor) RETURNING * INTO d;
  PERFORM hon.school_social_evidence(org,school,actor,'marketing.social.ads.drafted','SCHOOL_SOCIAL_AD',d.id,d.version,
    jsonb_build_object('budgetCents',d.budget_cents,'currency',d.currency,'days',d.ends_on-d.starts_on+1),p_request,p_correlation);
  result:=hon.school_social_ad_json(d);
  PERFORM hon.school_social_command_finish(org,school,actor,p_key,result);
  IF hon.require_school_social_actor(p_subject,'marketing.social.ads') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

-- CANCEL a DRAFT {expectedVersion}. An ad that may exist at Meta is paused, never cancelled here.
CREATE FUNCTION hon.cancel_school_social_ad(p_subject text,p_ad uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; d hon.school_social_ads%ROWTYPE; result jsonb;
BEGIN
  IF p_ad IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR (SELECT array_agg(k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['expectedVersion']
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.ads');
  prior:=hon.school_social_command_begin(org,school,actor,p_key,'AD_CANCEL',
    encode(sha256(convert_to('marketing.social.ads.cancel:'||p_ad::text||':'||p_input::text,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('record',prior,'replayed',true); END IF;
  SELECT * INTO d FROM hon.school_social_ads WHERE id=p_ad AND organization_id=org AND school_id=school FOR UPDATE;
  IF d.id IS NULL THEN RAISE EXCEPTION 'SOCIAL_AD_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF d.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SOCIAL_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF d.status<>'DRAFT' THEN RAISE EXCEPTION 'SOCIAL_AD_STATE' USING ERRCODE='55000'; END IF;
  UPDATE hon.school_social_ads SET status='CANCELLED',version=version+1,updated_at=clock_timestamp() WHERE id=d.id RETURNING * INTO d;
  PERFORM hon.school_social_evidence(org,school,actor,'marketing.social.ads.cancelled','SCHOOL_SOCIAL_AD',d.id,d.version,'{}'::jsonb,p_request,p_correlation);
  result:=hon.school_social_ad_json(d);
  PERFORM hon.school_social_command_finish(org,school,actor,p_key,result);
  IF hon.require_school_social_actor(p_subject,'marketing.social.ads') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

-- START one Zernio operation {operation: CREATE | ACTIVATE | PAUSE, expectedVersion}, recorded under a 60-second lease,
-- and hand the API what Zernio needs to do it once. CREATE is the approval (DRAFT, cap checked under a per-school
-- lock); ACTIVATE needs a PAUSED ad not past its end date and the cap re-checked; PAUSE works on any ad that may be
-- spending (ACTIVE, or UNKNOWN with a provider ad id). A replay returns the recorded ad with no send.
CREATE FUNCTION hon.start_school_social_ad_operation(p_subject text,p_ad uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; d hon.school_social_ads%ROWTYPE;
  a hon.school_social_accounts%ROWTYPE; t hon.school_social_post_targets%ROWTYPE; b hon.school_social_ad_budgets%ROWTYPE; op text; next_status text;
  at timestamptz:=clock_timestamp(); today date; m date; extra integer; result jsonb; shown text;
BEGIN
  IF p_ad IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['expectedVersion','operation']
    OR jsonb_typeof(p_input->'operation') IS DISTINCT FROM 'string' OR (p_input->>'operation') NOT IN ('CREATE','ACTIVATE','PAUSE')
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  op:=p_input->>'operation';
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.ads');
  prior:=hon.school_social_command_begin(org,school,actor,p_key,'AD_START',
    encode(sha256(convert_to('marketing.social.ads.start:'||p_ad::text||':'||p_input::text,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('record',prior,'replayed',true); END IF;
  -- The budget lock first (every cap decision for this school is taken under it), then the ad.
  PERFORM pg_advisory_xact_lock(hashtextextended('social-ad-budget:'||school::text,0));
  SELECT * INTO d FROM hon.school_social_ads WHERE id=p_ad AND organization_id=org AND school_id=school FOR UPDATE;
  IF d.id IS NULL THEN RAISE EXCEPTION 'SOCIAL_AD_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF d.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SOCIAL_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  shown:=CASE WHEN d.status IN ('CREATING','ACTIVATING','PAUSING') AND d.lease_expires_at<=at THEN 'UNKNOWN' ELSE d.status END;
  -- An operation whose lease ran out becomes UNKNOWN before anything else happens to the ad.
  IF shown='UNKNOWN' AND d.status<>'UNKNOWN' THEN
    UPDATE hon.school_social_ads SET status='UNKNOWN',version=version+1,updated_at=at WHERE id=d.id RETURNING * INTO d;
  END IF;
  SELECT * INTO a FROM hon.school_social_accounts WHERE id=d.account_id FOR SHARE;
  today:=hon.school_social_today(school);
  IF op IN ('CREATE','ACTIVATE') THEN
    IF NOT ((op='CREATE' AND d.status='DRAFT') OR (op='ACTIVATE' AND d.status='PAUSED')) OR d.ends_on<today
      OR (op='CREATE' AND d.starts_on<today) THEN RAISE EXCEPTION 'SOCIAL_AD_STATE' USING ERRCODE='55000'; END IF;
    IF a.status<>'CONNECTED' OR NOT a.ads_enabled OR a.organization_id<>org OR a.school_id<>school THEN RAISE EXCEPTION 'SOCIAL_ADS_OFF' USING ERRCODE='23514'; END IF;
    SELECT * INTO t FROM hon.school_social_post_targets WHERE id=d.target_id;
    IF op='CREATE' AND (t.status<>'PUBLISHED' OR t.provider_post_id IS NULL) THEN RAISE EXCEPTION 'SOCIAL_AD_POST_NOT_PUBLISHED' USING ERRCODE='55000'; END IF;
    SELECT * INTO b FROM hon.school_social_ad_budgets WHERE organization_id=org AND school_id=school;
    IF b.school_id IS NULL OR b.monthly_cap_cents=0 THEN RAISE EXCEPTION 'SOCIAL_AD_NO_BUDGET' USING ERRCODE='23514'; END IF;
    IF b.currency<>d.currency THEN RAISE EXCEPTION 'SOCIAL_AD_STATE' USING ERRCODE='55000'; END IF;
    -- Every calendar month the ad touches must still fit, counting this ad once (a PAUSED ad already counts).
    m:=date_trunc('month',d.starts_on)::date; extra:=CASE WHEN d.status='DRAFT' THEN d.budget_cents ELSE 0 END;
    WHILE m<=d.ends_on LOOP
      IF hon.school_social_ad_committed(org,school,m)+extra>b.monthly_cap_cents THEN
        RAISE EXCEPTION 'SOCIAL_AD_OVER_CAP' USING ERRCODE='23514'; END IF;
      m:=(m+interval '1 month')::date;
    END LOOP;
    next_status:=CASE op WHEN 'CREATE' THEN 'CREATING' ELSE 'ACTIVATING' END;
  ELSE
    IF NOT (d.status='ACTIVE' OR (d.status='UNKNOWN' AND d.provider_ad_id IS NOT NULL)) THEN RAISE EXCEPTION 'SOCIAL_AD_STATE' USING ERRCODE='55000'; END IF;
    next_status:='PAUSING';
  END IF;
  UPDATE hon.school_social_ads SET status=next_status,operation=op,prior_status=CASE WHEN op='PAUSE' THEN d.status WHEN op='ACTIVATE' THEN 'PAUSED' END,
    lease_token=gen_random_uuid(),lease_expires_at=at+interval '60 seconds',
    approved_by_principal_id=CASE WHEN op='CREATE' THEN actor ELSE approved_by_principal_id END,
    activated_by_principal_id=CASE WHEN op='ACTIVATE' THEN actor ELSE activated_by_principal_id END,
    -- A person's resolution settles one operation; the next operation starts unresolved.
    resolved_by_principal_id=NULL,
    version=version+1,updated_at=at WHERE id=d.id RETURNING * INTO d;
  PERFORM hon.school_social_evidence(org,school,actor,'marketing.social.ads.'||lower(op)||'_started','SCHOOL_SOCIAL_AD',d.id,d.version,
    jsonb_build_object('operation',op,'budgetCents',d.budget_cents),p_request,p_correlation);
  result:=hon.school_social_ad_json(d);
  PERFORM hon.school_social_command_finish(org,school,actor,p_key,result);
  IF hon.require_school_social_actor(p_subject,'marketing.social.ads') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO t FROM hon.school_social_post_targets WHERE id=d.target_id;
  RETURN jsonb_build_object('record',result,'replayed',false,'send',jsonb_build_object('adId',d.id,'leaseToken',d.lease_token,'operation',op,
    'providerAccountId',a.provider_account_id,'providerPostId',t.provider_post_id,'providerAdId',d.provider_ad_id,'budgetCents',d.budget_cents,
    'currency',d.currency,'startsOn',to_char(d.starts_on,'YYYY-MM-DD'),'endsOn',to_char(d.ends_on,'YYYY-MM-DD'),
    'timezone',(SELECT s.timezone FROM hon.schools s WHERE s.id=school)));
END $$;

-- RESULT of one operation: DONE (CREATE with the provider ad id), FAILED (a definite refusal: nothing changed at Meta)
-- or UNKNOWN, only under that operation's own lease token, while it is in flight or UNKNOWN (a late answer), and never
-- over a person's resolution. A provider ad id another ad holds stays UNKNOWN.
CREATE FUNCTION hon.record_school_social_ad_result(p_subject text,p_ad uuid,p_lease_token uuid,p_outcome text,p_provider_ad_id text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; d hon.school_social_ads%ROWTYPE; next_status text; accepted boolean:=false;
BEGIN
  IF p_ad IS NULL OR p_lease_token IS NULL OR p_outcome NOT IN ('DONE','FAILED','UNKNOWN')
    OR (p_provider_ad_id IS NOT NULL AND p_provider_ad_id !~ '^[0-9A-Za-z_:.-]{1,128}$') THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.ads');
  SELECT * INTO d FROM hon.school_social_ads WHERE id=p_ad AND organization_id=org AND school_id=school FOR UPDATE;
  IF d.id IS NULL THEN RAISE EXCEPTION 'SOCIAL_AD_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF (p_outcome='DONE' AND d.operation='CREATE') IS DISTINCT FROM (p_provider_ad_id IS NOT NULL) THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  IF d.lease_token=p_lease_token AND d.resolved_by_principal_id IS NULL
    AND (d.status IN ('CREATING','ACTIVATING','PAUSING') OR (d.status='UNKNOWN' AND p_outcome<>'UNKNOWN')) THEN
    next_status:=CASE
      WHEN p_outcome='UNKNOWN' THEN 'UNKNOWN'
      WHEN d.operation='CREATE' AND p_outcome='DONE' THEN CASE WHEN EXISTS(SELECT 1 FROM hon.school_social_ads x WHERE x.provider_ad_id=p_provider_ad_id) THEN 'UNKNOWN' ELSE 'PAUSED' END
      WHEN d.operation='CREATE' THEN 'FAILED'
      WHEN d.operation='ACTIVATE' THEN CASE WHEN p_outcome='DONE' THEN 'ACTIVE' ELSE 'PAUSED' END
      ELSE CASE WHEN p_outcome='DONE' THEN 'PAUSED' WHEN d.prior_status='ACTIVE' THEN 'ACTIVE' ELSE 'UNKNOWN' END END;
    IF next_status<>d.status THEN
      UPDATE hon.school_social_ads SET status=next_status,
        provider_ad_id=CASE WHEN d.operation='CREATE' AND next_status='PAUSED' THEN p_provider_ad_id ELSE provider_ad_id END,
        version=version+1,updated_at=clock_timestamp() WHERE id=d.id RETURNING * INTO d;
      PERFORM hon.school_social_evidence(org,school,actor,'marketing.social.ads.'||lower(d.operation)||'_'||lower(p_outcome),'SCHOOL_SOCIAL_AD',d.id,d.version,
        jsonb_build_object('status',d.status),p_request,p_correlation);
      accepted:=true;
    END IF;
  END IF;
  RETURN jsonb_build_object('ad',hon.school_social_ad_json(d),'accepted',accepted);
END $$;

-- RESOLVE an UNKNOWN ad {state, expectedVersion}: a person who checked Meta Ads Manager says what is true there. An
-- unknown CREATE becomes NOT_CREATED (FAILED) only; if Meta did create it, it is paused there and spends nothing, and
-- the person removes it in Ads Manager. An unknown ACTIVATE or PAUSE becomes ACTIVE or PAUSED.
CREATE FUNCTION hon.resolve_school_social_ad(p_subject text,p_ad uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; d hon.school_social_ads%ROWTYPE; result jsonb; v_state text;
BEGIN
  IF p_ad IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['expectedVersion','state']
    OR jsonb_typeof(p_input->'state') IS DISTINCT FROM 'string' OR (p_input->>'state') NOT IN ('NOT_CREATED','ACTIVE','PAUSED')
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  v_state:=p_input->>'state';
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.ads');
  prior:=hon.school_social_command_begin(org,school,actor,p_key,'AD_RESOLVE',
    encode(sha256(convert_to('marketing.social.ads.resolve:'||p_ad::text||':'||p_input::text,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('record',prior,'replayed',true); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('social-ad-budget:'||school::text,0));
  SELECT * INTO d FROM hon.school_social_ads WHERE id=p_ad AND organization_id=org AND school_id=school FOR UPDATE;
  IF d.id IS NULL THEN RAISE EXCEPTION 'SOCIAL_AD_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF d.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SOCIAL_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF NOT (d.status='UNKNOWN' OR (d.status IN ('CREATING','ACTIVATING','PAUSING') AND d.lease_expires_at<=clock_timestamp()))
    OR (d.operation='CREATE') IS DISTINCT FROM (v_state='NOT_CREATED') THEN RAISE EXCEPTION 'SOCIAL_AD_STATE' USING ERRCODE='55000'; END IF;
  IF d.status<>'UNKNOWN' THEN UPDATE hon.school_social_ads SET status='UNKNOWN',version=version+1,updated_at=clock_timestamp() WHERE id=d.id RETURNING * INTO d; END IF;
  UPDATE hon.school_social_ads SET status=CASE v_state WHEN 'NOT_CREATED' THEN 'FAILED' ELSE v_state END,resolved_by_principal_id=actor,
    version=version+1,updated_at=clock_timestamp() WHERE id=d.id RETURNING * INTO d;
  PERFORM hon.school_social_evidence(org,school,actor,'marketing.social.ads.resolved','SCHOOL_SOCIAL_AD',d.id,d.version,jsonb_build_object('status',d.status),p_request,p_correlation);
  result:=hon.school_social_ad_json(d);
  PERFORM hon.school_social_command_finish(org,school,actor,p_key,result);
  IF hon.require_school_social_actor(p_subject,'marketing.social.ads') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

DO $$ DECLARE r text; t text; f regprocedure; BEGIN
  FOREACH t IN ARRAY ARRAY['school_social_ad_budgets','school_social_ads'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','hon_communication_worker','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.require_school_social_actor(text,text)','hon.guard_school_social_ads()','hon.school_social_today(uuid)',
    'hon.school_social_ad_json(hon.school_social_ads)','hon.school_social_ad_committed(uuid,uuid,date)','hon.school_social_ads_view(uuid,uuid)',
    'hon.read_school_social_ads(text)','hon.set_school_social_ad_budget(text,jsonb,text,uuid,uuid)','hon.create_school_social_ad(text,jsonb,text,uuid,uuid)',
    'hon.cancel_school_social_ad(text,uuid,jsonb,text,uuid,uuid)','hon.start_school_social_ad_operation(text,uuid,jsonb,text,uuid,uuid)',
    'hon.record_school_social_ad_result(text,uuid,uuid,text,text,uuid,uuid)','hon.resolve_school_social_ad(text,uuid,jsonb,text,uuid,uuid)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','hon_communication_worker','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_social_ads(text),hon.set_school_social_ad_budget(text,jsonb,text,uuid,uuid),
      hon.create_school_social_ad(text,jsonb,text,uuid,uuid),hon.cancel_school_social_ad(text,uuid,jsonb,text,uuid,uuid),
      hon.start_school_social_ad_operation(text,uuid,jsonb,text,uuid,uuid),hon.record_school_social_ad_result(text,uuid,uuid,text,text,uuid,uuid),
      hon.resolve_school_social_ad(text,uuid,jsonb,text,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
