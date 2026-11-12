BEGIN;

-- HON OS 14-day free trial runtime (D11-B, first slice). A REGISTERED school (0241) starts one free trial under an
-- HQ-published, HQ-owner-approved public trial campaign (0187). Owner decision: 14-day trial, no automatic charge.
-- - Program: hon.hon_os_trial_program is CLOSED. Only the migration owner of a disposable or private test database can set
--   TEST_MODE; there is no LIVE value and no runtime write path. The 0187 program row stays INACTIVE and untouched.
-- - Effect: the entitlement becomes the campaign's capability profile, ACTIVE, with effective_until = start + duration.
--   Access ends at that instant by the clock (no job), like every other entitlement window. One trial per organization ever.
-- - No charge: no provider, customer, subscription, payment method, invoice, checkout or credit allowance is created, and
--   a school that has a trial cannot open a checkout until the reviewed conversion slice exists.
-- - AI (owner decision 2026-11-11: "yes with custom ai credit", "let hq able to set trial setting"): the AI credit of a
--   trial is the promotional credit budget HQ sets on the trial campaign (0187: credits per school, daily cap, per-request
--   cap, credit expiry, campaign cost cap), snapshotted on the enrollment. hon.ai_spend_allowed recognises a trial-owned
--   entitlement as TRIAL_ACTIVE and routes it through the S4-c hook hon.ai_trial_funding_available, which is now true only
--   for agent inference while the trial is live, has a budget and its credits have not expired. hon.ai_org_ceiling turns
--   the budget into the organization agent ceiling every prepare already enforces under the budget lock. A campaign with
--   no budget means no trial AI. Credits are promotional and internal: nothing is charged, sold or carried over, and
--   Creative Studio media stays wallet-only (CREATIVE_MEDIA is never trial-funded). A school registered without a trial
--   reads REGISTERED (AI_ACCESS_NOT_PAID).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.register_hon_os_school(text,text,jsonb,uuid)') IS NULL THEN RAISE EXCEPTION 'Apply public sign-up migration 0241 first'; END IF;
END $$;

CREATE TABLE hon.hon_os_trial_program (
  program_id smallint PRIMARY KEY CHECK (program_id=1),
  status text NOT NULL CHECK (status IN ('CLOSED','TEST_MODE')),
  recorded_at timestamptz NOT NULL
);
INSERT INTO hon.hon_os_trial_program VALUES (1,'CLOSED',clock_timestamp());
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.hon_os_trial_program FOR EACH ROW EXECUTE FUNCTION hon.guard_hon_os_signup_program();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hon_os_trial_program FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hon_os_signup_program();

-- One immutable row per organization: the trial and exactly what authorized it.
CREATE TABLE hon.hon_os_trial_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL UNIQUE REFERENCES hon.organizations(id),
  school_id uuid NOT NULL,
  registration_id uuid NOT NULL UNIQUE REFERENCES hon.hon_os_school_registrations(id),
  campaign_id uuid NOT NULL,
  campaign_version_id uuid NOT NULL,
  publication_id uuid NOT NULL REFERENCES hon.saas_trial_publications(id),
  policy_decision_id uuid NOT NULL REFERENCES hon.saas_trial_policy_decisions(id),
  capability_profile text NOT NULL CHECK (capability_profile IN ('CORE','COMPLETE')),
  duration_days integer NOT NULL CHECK (duration_days IN (7,14,30,60,90)),
  terms_reference text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  prior_entitlement jsonb NOT NULL,
  granted_entitlement_version integer NOT NULL CHECK (granted_entitlement_version>1),
  enrolled_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  subject text NOT NULL,
  idempotency_key uuid NOT NULL,
  program_status text NOT NULL CHECK (program_status='TEST_MODE'),
  -- The campaign's promotionalBudget at enrollment (JSON null = no trial AI). Later campaign versions never change it.
  ai_budget jsonb NOT NULL CHECK (jsonb_typeof(ai_budget) IN ('null','object')),
  CHECK (ends_at=starts_at+make_interval(days=>duration_days)),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  FOREIGN KEY (campaign_version_id,campaign_id) REFERENCES hon.saas_trial_campaign_versions(id,campaign_id),
  FOREIGN KEY (subject,idempotency_key) REFERENCES hon.school_account_requests(subject,idempotency_key),
  UNIQUE (subject,idempotency_key)
);
CREATE INDEX hon_os_trial_enrollments_campaign ON hon.hon_os_trial_enrollments(campaign_id);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.hon_os_trial_enrollments FOR EACH ROW EXECUTE FUNCTION hon.guard_school_account_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hon_os_trial_enrollments FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_account_evidence();

CREATE FUNCTION hon.hon_os_trial_open() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.hon_os_trial_program WHERE program_id=1 AND status='TEST_MODE')
$$;

-- The trial currently owns the entitlement: same version it granted, window still open.
CREATE FUNCTION hon.hon_os_trial_live(p_org uuid, p_at timestamptz) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.hon_os_trial_enrollments t JOIN hon.organization_entitlements e ON e.organization_id=t.organization_id
    WHERE t.organization_id=p_org AND e.version=t.granted_entitlement_version AND e.status='ACTIVE'
      AND e.effective_from<=p_at AND e.effective_until=t.ends_at AND t.ends_at>p_at)
$$;

-- Lifecycle as the owner sees it: TRIAL_ACTIVE while the trial owns the entitlement; TRIAL_ENDED once its window passed
-- (and nothing newer replaced it); SUPERSEDED when another source (HQ exception, later paid access) changed the entitlement.
CREATE FUNCTION hon.hon_os_trial_json(t hon.hon_os_trial_enrollments) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('enrollmentId',t.id,'organizationId',t.organization_id,'schoolId',t.school_id,'campaignId',t.campaign_id,
    'durationDays',t.duration_days,'startsAt',hon.saas_ts(t.starts_at),'endsAt',hon.saas_ts(t.ends_at),
    'status',CASE WHEN hon.hon_os_trial_live(t.organization_id,clock_timestamp()) THEN 'TRIAL_ACTIVE'
      WHEN e.version=t.granted_entitlement_version THEN 'TRIAL_ENDED' ELSE 'SUPERSEDED' END,
    'automaticCharge',false,'paymentMethodRequired',false,'aiIncluded',jsonb_typeof(t.ai_budget)='object',
    'aiCredits',CASE WHEN jsonb_typeof(t.ai_budget)='object' THEN jsonb_build_object(
      'credits',(t.ai_budget->>'creditsPerEnrollment')::integer,'dailyCap',(t.ai_budget->>'dailyCreditCap')::integer,
      'perRequestCap',(t.ai_budget->>'perRequestCreditCap')::integer,
      'expiresAt',hon.saas_ts(least(t.ends_at,t.starts_at+make_interval(days=>(t.ai_budget->>'creditExpiryDays')::integer))),
      'used',(SELECT coalesce(sum(u.customer_credits),0) FROM hon.ai_usage_ledger u WHERE u.organization_id=t.organization_id
        AND u.spend_class='AGENT_INFERENCE' AND u.occurred_at>=t.starts_at AND u.occurred_at<t.ends_at)) END,
    'creativeCreditsIncluded',false)
  FROM hon.organization_entitlements e WHERE e.organization_id=t.organization_id
$$;

-- The one public campaign a new school may start now: latest publication of the campaign is PUBLISHED, its policy decision
-- is the current APPROVED decision and valid now, PUBLIC link mode, new organizations only, inside the enrollment window.
-- Its promotional credit budget (or JSON null) is carried so the enrollment can snapshot it.
CREATE FUNCTION hon.hon_os_trial_campaign_offer(p_campaign uuid, p_at timestamptz) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('campaignId',p.campaign_id,'campaignVersionId',v.id,'publicationId',p.id,'policyDecisionId',d.id,
    'name',v.definition->>'name','durationDays',(v.definition->>'durationDays')::integer,'capabilityProfile',v.definition->>'capabilityProfile',
    'termsReference',v.definition->>'termsReference','maximumEnrollments',(v.definition->>'maximumEnrollments')::integer,
    'enrollmentClosesAt',v.definition->>'enrollmentClosesAt','promotionalBudget',v.definition->'promotionalBudget')
  FROM hon.saas_trial_publications p
  JOIN hon.saas_trial_campaign_versions v ON v.id=p.version_id AND v.campaign_id=p.campaign_id
  JOIN hon.saas_trial_policy_decisions d ON d.id=p.policy_decision_id
  WHERE p.campaign_id=p_campaign AND p.kind='PUBLISHED'
    AND p.revision=(SELECT max(x.revision) FROM hon.saas_trial_publications x WHERE x.campaign_id=p.campaign_id)
    AND d.decision='APPROVED' AND d.revision=(SELECT max(y.revision) FROM hon.saas_trial_policy_decisions y)
    AND d.valid_from<=p_at AND d.valid_until>p_at
    AND v.definition->>'linkMode'='PUBLIC' AND v.definition->>'eligibility'='NEW_ORGANIZATIONS_ONLY'
    AND (v.definition->>'enrollmentOpensAt')::timestamptz<=p_at AND (v.definition->>'enrollmentClosesAt')::timestamptz>p_at
$$;

-- ---------- start a trial (runtime entry point) ----------
CREATE FUNCTION hon.start_hon_os_trial(p_subject text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE prior hon.school_account_requests%ROWTYPE; fp text; at timestamptz; r hon.hon_os_school_registrations%ROWTYPE; offer jsonb;
  ent hon.organization_entitlements%ROWTYPE; t hon.hon_os_trial_enrollments%ROWTYPE; prior_ent jsonb; v_until timestamptz; result jsonb;
BEGIN
  IF p_key IS NULL OR p_subject IS NULL OR length(p_subject)>2048 OR p_subject NOT LIKE 'oidc:%'
    OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['campaignId','confirmation','schoolId']
    OR jsonb_typeof(p_input->'confirmation') IS DISTINCT FROM 'string' OR p_input->>'confirmation'<>'START_HON_OS_FREE_TRIAL'
    OR jsonb_typeof(p_input->'schoolId') IS DISTINCT FROM 'string' OR p_input->>'schoolId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_input->'campaignId') IS DISTINCT FROM 'string' OR p_input->>'campaignId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'TRIAL_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  IF NOT hon.hon_os_trial_open() THEN RAISE EXCEPTION 'TRIAL_CLOSED' USING ERRCODE='55000'; END IF;
  -- Owner authority cannot change while we decide (same envelope as every account writer).
  PERFORM hon.lock_school_account_authority();
  fp:=encode(sha256(convert_to('TRIAL:START:'||p_input::text,'UTF8')),'hex');
  SELECT * INTO prior FROM hon.school_account_requests WHERE subject=p_subject AND idempotency_key=p_key;
  IF FOUND THEN
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'TRIAL_KEY_REUSED' USING ERRCODE='23505'; END IF;
    SELECT * INTO t FROM hon.hon_os_trial_enrollments WHERE subject=p_subject AND idempotency_key=p_key;
    IF NOT FOUND THEN RAISE EXCEPTION 'TRIAL_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
    RETURN hon.hon_os_trial_json(t);
  END IF;
  -- Only the registering owner, through their own live owner grant, at their own school.
  SELECT * INTO r FROM hon.hon_os_school_registrations WHERE subject=p_subject AND school_id=(p_input->>'schoolId')::uuid;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM hon.principal_role_grants g JOIN hon.principals p ON p.id=g.principal_id
      JOIN hon.schools s ON s.id=r.school_id AND s.status='ACTIVE' JOIN hon.organizations o ON o.id=r.organization_id AND o.status='ACTIVE'
      WHERE g.id=r.owner_grant_id AND g.principal_id=r.owner_principal_id AND p.is_active AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())) THEN
    RAISE EXCEPTION 'TRIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  -- Capacity is counted under one lock per campaign, then the organization (inventory-before-organization order).
  PERFORM pg_advisory_xact_lock(hashtextextended('hon_os.trial_campaign:'||(p_input->>'campaignId'),0));
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:'||r.organization_id::text,0));
  SELECT * INTO ent FROM hon.organization_entitlements WHERE organization_id=r.organization_id FOR UPDATE;
  at:=clock_timestamp();
  IF NOT hon.hon_os_trial_open() THEN RAISE EXCEPTION 'TRIAL_CLOSED' USING ERRCODE='55000'; END IF;
  IF EXISTS (SELECT 1 FROM hon.hon_os_trial_enrollments WHERE organization_id=r.organization_id) THEN
    RAISE EXCEPTION 'TRIAL_ALREADY_USED' USING ERRCODE='23505'; END IF;
  offer:=hon.hon_os_trial_campaign_offer((p_input->>'campaignId')::uuid,at);
  IF offer IS NULL THEN RAISE EXCEPTION 'TRIAL_CAMPAIGN_UNAVAILABLE' USING ERRCODE='23514'; END IF;
  IF (SELECT count(*) FROM hon.hon_os_trial_enrollments WHERE campaign_id=(p_input->>'campaignId')::uuid)>=(offer->>'maximumEnrollments')::integer THEN
    RAISE EXCEPTION 'TRIAL_CAMPAIGN_FULL' USING ERRCODE='23514'; END IF;
  -- A trial only starts from no access at all: entitlement still held SUSPENDED, no access state, subscription, checkout or
  -- exception. Existing, paid, awaiting or HQ-exception schools are never touched.
  IF ent.organization_id IS NULL OR ent.status<>'SUSPENDED'
    OR EXISTS (SELECT 1 FROM hon.saas_access_states WHERE organization_id=r.organization_id)
    OR EXISTS (SELECT 1 FROM hon.saas_subscriptions WHERE organization_id=r.organization_id AND status<>'VOIDED')
    OR EXISTS (SELECT 1 FROM hon.saas_checkout_sessions WHERE organization_id=r.organization_id)
    OR EXISTS (SELECT 1 FROM hon.saas_access_exceptions WHERE organization_id=r.organization_id) THEN
    RAISE EXCEPTION 'TRIAL_NOT_ELIGIBLE' USING ERRCODE='23514'; END IF;
  prior_ent:=hon.saas_entitlement_json(r.organization_id);
  v_until:=at+make_interval(days=>(offer->>'durationDays')::integer);
  UPDATE hon.organization_entitlements SET tier=(offer->>'capabilityProfile')::hon.plan_tier,status='ACTIVE',effective_from=at,
      effective_until=v_until,version=version+1,updated_at=at
    WHERE organization_id=r.organization_id AND version=ent.version;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIAL_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  INSERT INTO hon.school_account_requests VALUES (p_subject,p_key,fp,'{}'::jsonb);
  INSERT INTO hon.hon_os_trial_enrollments(organization_id,school_id,registration_id,campaign_id,campaign_version_id,publication_id,
      policy_decision_id,capability_profile,duration_days,terms_reference,starts_at,ends_at,prior_entitlement,granted_entitlement_version,
      enrolled_by_principal_id,subject,idempotency_key,program_status,ai_budget)
    VALUES (r.organization_id,r.school_id,r.id,(offer->>'campaignId')::uuid,(offer->>'campaignVersionId')::uuid,(offer->>'publicationId')::uuid,
      (offer->>'policyDecisionId')::uuid,offer->>'capabilityProfile',(offer->>'durationDays')::integer,offer->>'termsReference',at,v_until,
      prior_ent,ent.version+1,r.owner_principal_id,p_subject,p_key,'TEST_MODE',offer->'promotionalBudget') RETURNING * INTO t;
  result:=hon.hon_os_trial_json(t);
  -- Decision point after every write: program, campaign approval and owner grant must all still hold.
  IF NOT hon.hon_os_trial_open() THEN RAISE EXCEPTION 'TRIAL_CLOSED' USING ERRCODE='55000'; END IF;
  IF hon.hon_os_trial_campaign_offer(t.campaign_id,clock_timestamp()) IS NULL THEN RAISE EXCEPTION 'TRIAL_CAMPAIGN_UNAVAILABLE' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM hon.principal_role_grants g WHERE g.id=r.owner_grant_id AND g.revoked_at IS NULL
      AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())) THEN RAISE EXCEPTION 'TRIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- ---------- read (runtime entry point) ----------
-- The caller's own registered school: trial program status, the public campaign it may start (if any) and its trial.
CREATE FUNCTION hon.read_hon_os_trial(p_subject text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE r hon.hon_os_school_registrations%ROWTYPE; t hon.hon_os_trial_enrollments%ROWTYPE; offer jsonb; at timestamptz:=clock_timestamp();
BEGIN
  IF p_subject IS NULL OR length(p_subject)>2048 THEN RAISE EXCEPTION 'TRIAL_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.saas_refuse_context();
  SELECT * INTO r FROM hon.hon_os_school_registrations WHERE subject=p_subject;
  IF r.id IS NOT NULL THEN SELECT * INTO t FROM hon.hon_os_trial_enrollments WHERE organization_id=r.organization_id; END IF;
  IF r.id IS NOT NULL AND t.id IS NULL THEN
    -- The newest eligible public campaign that still has room.
    SELECT o INTO offer FROM (SELECT hon.hon_os_trial_campaign_offer(c.campaign_id,at) o FROM (SELECT DISTINCT campaign_id FROM hon.saas_trial_publications) c) z
      WHERE o IS NOT NULL AND (SELECT count(*) FROM hon.hon_os_trial_enrollments e WHERE e.campaign_id=(o->>'campaignId')::uuid)<(o->>'maximumEnrollments')::integer
      ORDER BY o->>'enrollmentClosesAt', o->>'campaignId' LIMIT 1;
  END IF;
  RETURN jsonb_build_object('trialStatus',CASE WHEN hon.hon_os_trial_open() THEN 'TEST_MODE' ELSE 'CLOSED' END,
    'schoolId',r.school_id,
    'available',CASE WHEN offer IS NULL OR NOT hon.hon_os_trial_open() THEN NULL
      ELSE jsonb_build_object('campaignId',offer->'campaignId','name',offer->'name','durationDays',offer->'durationDays',
        'automaticCharge',false,'paymentMethodRequired',false,'aiIncluded',jsonb_typeof(offer->'promotionalBudget')='object',
        'aiCredits',CASE WHEN jsonb_typeof(offer->'promotionalBudget')='object' THEN jsonb_build_object(
          'credits',(offer->'promotionalBudget'->>'creditsPerEnrollment')::integer,'dailyCap',(offer->'promotionalBudget'->>'dailyCreditCap')::integer,
          'perRequestCap',(offer->'promotionalBudget'->>'perRequestCreditCap')::integer,
          'expiryDays',(offer->'promotionalBudget'->>'creditExpiryDays')::integer) END) END,
    'trial',CASE WHEN t.id IS NULL THEN NULL ELSE hon.hon_os_trial_json(t) END);
END $$;

-- ---------- no checkout for a trial school until the reviewed conversion slice ----------
-- A v1 checkout from a trial would activate a subscription while the trial window still ends access (0182 provisioned path).
CREATE FUNCTION hon.guard_hon_os_trial_checkout() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM hon.hon_os_trial_enrollments WHERE organization_id=NEW.organization_id) THEN
    RAISE EXCEPTION 'TRIAL_CONVERSION_UNAVAILABLE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hon_os_trial_checkout_guard BEFORE INSERT ON hon.saas_checkout_sessions FOR EACH ROW EXECUTE FUNCTION hon.guard_hon_os_trial_checkout();

-- ---------- trial AI credit: the HQ-set campaign budget ----------
-- Funding: agent inference only, while the trial owns the entitlement, has a budget, and its credits have not expired.
CREATE OR REPLACE FUNCTION hon.ai_trial_funding_available(p_org uuid, p_at timestamptz, p_class text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT p_class='AGENT_INFERENCE' AND hon.hon_os_trial_live(p_org,p_at) AND EXISTS (SELECT 1 FROM hon.hon_os_trial_enrollments t
    WHERE t.organization_id=p_org AND jsonb_typeof(t.ai_budget)='object'
      AND p_at<t.starts_at+make_interval(days=>(t.ai_budget->>'creditExpiryDays')::integer));
$$;

-- The organization agent ceiling every prepare compares committed + estimate against (under ai.budget:<org>).
-- A school whose entitlement a trial owns: 0 unless the trial is funded now; when funded, the smallest of the interim
-- 12000 ceiling, the trial's remaining credits, today's (UTC) daily cap, the per-request cap above what is already
-- committed, and 0 once the campaign's agent provider cost reached its cap (1 USD minor unit = 10000 microunits; schools
-- deciding at once can each still finish one request, at most perRequestCreditCap credits each). Every other organization
-- keeps the owner-decided interim ceiling (OD-23).
CREATE OR REPLACE FUNCTION hon.ai_org_ceiling(p_org uuid, p_at timestamptz) RETURNS integer LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN t.id IS NULL THEN 12000
    WHEN NOT hon.ai_trial_funding_available(p_org,p_at,'AGENT_INFERENCE') THEN 0
    WHEN (SELECT coalesce(sum(u.provider_cost_microunits),0) FROM hon.hon_os_trial_enrollments x JOIN hon.ai_usage_ledger u ON u.organization_id=x.organization_id
          WHERE x.campaign_id=t.campaign_id AND u.spend_class='AGENT_INFERENCE' AND u.occurred_at>=x.starts_at AND u.occurred_at<x.ends_at)
         >=(t.ai_budget->>'maximumCampaignCostMinor')::bigint*10000 THEN 0
    ELSE greatest(0,least(12000::bigint,
      (t.ai_budget->>'creditsPerEnrollment')::bigint-(SELECT coalesce(sum(u.customer_credits),0) FROM hon.ai_usage_ledger u
        WHERE u.organization_id=p_org AND u.spend_class='AGENT_INFERENCE' AND u.occurred_at>=t.starts_at AND u.occurred_at<lower(w.r)),
      (SELECT coalesce(sum(u.customer_credits),0) FROM hon.ai_usage_ledger u WHERE u.organization_id=p_org AND u.spend_class='AGENT_INFERENCE'
        AND u.occurred_at>=lower(w.r) AND u.occurred_at<(date_trunc('day',p_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))
        +(t.ai_budget->>'dailyCreditCap')::bigint,
      hon.ai_org_committed_credits(p_org,p_at)+(t.ai_budget->>'perRequestCreditCap')::bigint))::integer END
  FROM (SELECT hon.ai_spend_window(p_org,p_at) AS r) w
  LEFT JOIN hon.hon_os_trial_enrollments t ON t.organization_id=p_org
    AND EXISTS (SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=p_org AND e.version=t.granted_entitlement_version);
$$;

-- ---------- AI access decision: trial and registered schools ----------
CREATE OR REPLACE FUNCTION hon.ai_spend_allowed(p_org uuid, p_at timestamptz, p_class text) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s hon.saas_access_states%ROWTYPE; e hon.organization_entitlements%ROWTYPE; in_effect boolean; tr hon.hon_os_trial_enrollments%ROWTYPE;
BEGIN
  IF p_org IS NULL OR p_class NOT IN ('AGENT_INFERENCE','CREATIVE_MEDIA','HQ_INTERNAL') THEN RETURN 'AI_ACCESS_UNKNOWN_STATE'; END IF;
  -- 0. HQ emergency pause (organization or platform; this class or all) comes before everything.
  IF EXISTS (SELECT 1 FROM hon.ai_spend_pauses p WHERE p.ended_at IS NULL AND (p.organization_id = p_org OR p.organization_id IS NULL)
             AND p.spend_class IN (p_class, 'ALL')) THEN RETURN 'AI_PAUSED_BY_HQ'; END IF;
  -- 1a. Owner-approved promotional AI access (hook only; returns none until approved).
  IF hon.ai_promotional_access(p_org, p_at, p_class) THEN RETURN NULL; END IF;
  -- 1. A live HQ access exception that currently owns the entitlement grants no AI (AI-D1 = A).
  IF hon.saas_access_exception_live(p_org) THEN RETURN 'AI_EXCEPTION_NO_AI'; END IF;
  SELECT * INTO s FROM hon.saas_access_states WHERE organization_id = p_org;
  SELECT * INTO e FROM hon.organization_entitlements WHERE organization_id = p_org;
  in_effect := e.organization_id IS NOT NULL AND e.status = 'ACTIVE' AND e.effective_from <= p_at AND (e.effective_until IS NULL OR e.effective_until > p_at);
  IF s.organization_id IS NULL THEN
    -- 2. 0246: a free trial that owns the entitlement goes through the trial-funding hook (its HQ-set AI credit);
    --    a trial whose window passed, or a self-registered school with no trial, has no paid AI.
    SELECT * INTO tr FROM hon.hon_os_trial_enrollments WHERE organization_id = p_org;
    IF tr.id IS NOT NULL AND e.version = tr.granted_entitlement_version THEN
      RETURN hon.ai_access_state_decision(CASE WHEN hon.hon_os_trial_live(p_org, p_at) THEN 'TRIAL_ACTIVE' ELSE 'TRIAL_ENDED' END,
        in_effect, hon.ai_trial_funding_available(p_org, p_at, p_class));
    END IF;
    IF tr.id IS NULL AND EXISTS (SELECT 1 FROM hon.hon_os_school_registrations g WHERE g.organization_id = p_org) THEN
      RETURN hon.ai_access_state_decision('REGISTERED', in_effect, false);
    END IF;
    -- 7. Legacy: no access-state row, no exception, no trial: unchanged (the existing gate decides).
    RETURN NULL;
  END IF;
  RETURN hon.ai_access_state_decision(s.state, in_effect, hon.ai_trial_funding_available(p_org, p_at, p_class));
END $$;

DO $$ DECLARE t text; r text; f text; c text; BEGIN
  FOREACH t IN ARRAY ARRAY['hon_os_trial_program','hon_os_trial_enrollments'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r); END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',c,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',c,t,r); END LOOP;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon_os_trial_open()','hon_os_trial_live(uuid,timestamptz)','hon_os_trial_json(hon.hon_os_trial_enrollments)',
    'hon_os_trial_campaign_offer(uuid,timestamptz)','start_hon_os_trial(text,jsonb,uuid)','read_hon_os_trial(text)','guard_hon_os_trial_checkout()',
    'ai_spend_allowed(uuid,timestamptz,text)','ai_trial_funding_available(uuid,timestamptz,text)','ai_org_ceiling(uuid,timestamptz)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.start_hon_os_trial(text,jsonb,uuid),hon.read_hon_os_trial(text) TO hon_runtime;
  END IF;
END $$;
COMMIT;
