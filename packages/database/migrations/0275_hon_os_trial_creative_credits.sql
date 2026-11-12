BEGIN;

-- HON OS free trial creative credits (migration 0275, allocated 2026-11-12). Source only: the trial program stays CLOSED
-- and the creative program stays INACTIVE, so nothing here can spend until the owner opens both.
-- Owner decision 2026-11-12 (supersedes the 0246 rule "CREATIVE_MEDIA is never trial-funded"): the free trial includes
-- Creative Studio, worth about $15 of real provider cost per school (images, short videos and an avatar try).
-- 1. Each trial gets its own creative lot, kind TRIAL, in the trial school's own wallet, granted in the same transaction
--    that starts the trial: 1,500 credits (the assumed $0.01 provider cost per credit), expiring when the trial ends.
--    It never carries over, is never sold and is not part of any paid allowance. The amount and the cost stop are
--    snapshotted per trial in hon.hon_os_trial_creative_grants.
-- 2. Real-cost stop: the shared spend decision funds CREATIVE_MEDIA for a trial only while it is live and the creative
--    provider cost recorded for the organization during the trial is below the snapshotted cap ($15). Credits stop
--    spending at the published rates; the cost stop holds even if a rate is set too low. Requests already reserved when
--    the cap is reached can each still finish (at most one request per concurrent reservation over the cap).
-- 3. Wallet eligibility: a school whose organization's entitlement a funded trial owns is eligible for the trial window
--    (index 0, trial start to trial end); it never receives an included monthly window (no subscription).
-- 4. Consumption order: TRIAL lots are spent first (rank 1, they expire soonest). The balance lists TRIAL by kind only
--    when the school has a trial lot, so every other wallet reads exactly as before.
-- A trial started before this migration gets no creative lot (no trial exists outside disposable test databases).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regclass('hon.hon_os_admission_limit_versions') IS NULL THEN RAISE EXCEPTION 'Apply admission limits migration 0274 first'; END IF;
  IF to_regclass('hon.saas_creative_lots') IS NULL OR to_regclass('hon.hon_os_trial_enrollments') IS NULL THEN
    RAISE EXCEPTION 'Apply the creative wallet (0202) and trial runtime (0246) first';
  END IF;
END $$;

-- ---------- policy and per-trial snapshot ----------
-- The trial creative allowance in force (migration owner only; a later HQ slice can version it).
CREATE TABLE hon.hon_os_trial_creative_policy (
  policy_id smallint PRIMARY KEY CHECK (policy_id=1),
  credits integer NOT NULL CHECK (credits BETWEEN 1 AND 100000),
  cost_cap_minor integer NOT NULL CHECK (cost_cap_minor BETWEEN 1 AND 100000),
  currency text NOT NULL CHECK (currency='USD'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  recorded_at timestamptz NOT NULL
);
INSERT INTO hon.hon_os_trial_creative_policy VALUES (1,1500,1500,'USD','Owner decision 2026-11-12: about $15 of Creative Studio per free trial',clock_timestamp());

CREATE TABLE hon.hon_os_trial_creative_grants (
  enrollment_id uuid PRIMARY KEY REFERENCES hon.hon_os_trial_enrollments(id),
  organization_id uuid NOT NULL UNIQUE REFERENCES hon.organizations(id),
  school_id uuid NOT NULL,
  lot_id uuid NOT NULL UNIQUE,
  credits integer NOT NULL CHECK (credits BETWEEN 1 AND 100000),
  cost_cap_minor integer NOT NULL CHECK (cost_cap_minor BETWEEN 1 AND 100000),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at>starts_at),
  FOREIGN KEY (lot_id,school_id) REFERENCES hon.saas_creative_lots(id,school_id)
);

-- ---------- the TRIAL lot kind ----------
ALTER TABLE hon.saas_creative_lots ADD COLUMN trial_enrollment_id uuid UNIQUE REFERENCES hon.hon_os_trial_enrollments(id);
ALTER TABLE hon.saas_creative_lots DROP CONSTRAINT saas_creative_lots_lot_kind_check;
ALTER TABLE hon.saas_creative_lots ADD CONSTRAINT saas_creative_lots_lot_kind_check
  CHECK (lot_kind IN ('INCLUDED_MONTHLY','PROMOTIONAL','ADJUSTMENT','PURCHASED_TOPUP','TRIAL'));
ALTER TABLE hon.saas_creative_lots DROP CONSTRAINT saas_creative_lots_check;
ALTER TABLE hon.saas_creative_lots ADD CONSTRAINT saas_creative_lots_check CHECK (CASE lot_kind
    WHEN 'INCLUDED_MONTHLY' THEN subscription_id IS NOT NULL AND window_index IS NOT NULL AND window_end > window_start
      AND expires_at = window_end AND purchase_id IS NULL AND adjustment_id IS NULL AND base_credits IS NULL AND bonus_credits IS NULL
      AND trial_enrollment_id IS NULL
    WHEN 'PURCHASED_TOPUP' THEN purchase_id IS NOT NULL AND base_credits > 0 AND bonus_credits >= 0 AND credits = base_credits + bonus_credits
      AND expires_at IS NULL AND subscription_id IS NULL AND window_index IS NULL AND adjustment_id IS NULL AND trial_enrollment_id IS NULL
    WHEN 'TRIAL' THEN trial_enrollment_id IS NOT NULL AND expires_at IS NOT NULL AND subscription_id IS NULL AND window_index IS NULL
      AND window_start IS NULL AND window_end IS NULL AND purchase_id IS NULL AND adjustment_id IS NULL AND base_credits IS NULL AND bonus_credits IS NULL
    ELSE adjustment_id IS NOT NULL AND expires_at IS NULL AND subscription_id IS NULL AND window_index IS NULL AND purchase_id IS NULL
      AND base_credits IS NULL AND bonus_credits IS NULL AND trial_enrollment_id IS NULL END);

-- Consumption rank: TRIAL is spent first with included credits (CW-D2 otherwise unchanged).
CREATE OR REPLACE FUNCTION hon.saas_creative_lot_rank(p_kind text) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT CASE p_kind WHEN 'INCLUDED_MONTHLY' THEN 1 WHEN 'TRIAL' THEN 1 WHEN 'PROMOTIONAL' THEN 2 WHEN 'ADJUSTMENT' THEN 2 ELSE 3 END
$$;

-- Balance by kind: unchanged four kinds, plus TRIAL only for a school that has a trial lot.
CREATE OR REPLACE FUNCTION hon.saas_creative_balance_json(p_school uuid, p_at timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  WITH lots AS (SELECT l.lot_kind, hon.saas_creative_lot_json(l, p_at) j FROM hon.saas_creative_lots l WHERE l.school_id = p_school),
  k AS (SELECT kind FROM unnest(ARRAY['INCLUDED_MONTHLY','PROMOTIONAL','ADJUSTMENT','PURCHASED_TOPUP']) kind
        UNION ALL SELECT 'TRIAL' WHERE EXISTS (SELECT 1 FROM lots WHERE lots.lot_kind = 'TRIAL'))
  SELECT jsonb_build_object(
    'availableCredits', coalesce((SELECT sum((j->>'availableCredits')::bigint) FROM lots), 0),
    'heldCredits', coalesce((SELECT sum((j->>'heldCredits')::bigint) FROM lots), 0),
    'byKind', (SELECT jsonb_agg(jsonb_build_object('kind', k.kind,
        'grantedCredits', coalesce((SELECT sum((j->>'credits')::bigint) FROM lots WHERE lots.lot_kind = k.kind), 0),
        'availableCredits', coalesce((SELECT sum((j->>'availableCredits')::bigint) FROM lots WHERE lots.lot_kind = k.kind), 0),
        'heldCredits', coalesce((SELECT sum((j->>'heldCredits')::bigint) FROM lots WHERE lots.lot_kind = k.kind), 0),
        'consumedCredits', coalesce((SELECT sum((j->>'consumedCredits')::bigint) FROM lots WHERE lots.lot_kind = k.kind), 0),
        'expiredCredits', coalesce((SELECT sum((j->>'expiredCredits')::bigint) FROM lots WHERE lots.lot_kind = k.kind), 0),
        'debitedCredits', coalesce((SELECT sum((j->>'debitedCredits')::bigint) FROM lots WHERE lots.lot_kind = k.kind), 0))
      ORDER BY hon.saas_creative_lot_rank(k.kind), k.kind) FROM k))
$$;

-- ---------- grant at trial start ----------
-- Runs inside start_hon_os_trial, in the enrollment's transaction: the trial and its creative lot commit together or not
-- at all. Takes only the new school's wallet lock (no reservation can exist for a school before its trial).
CREATE FUNCTION hon.grant_hon_os_trial_creative() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE p hon.hon_os_trial_creative_policy%ROWTYPE; v_lot uuid;
BEGIN
  SELECT * INTO p FROM hon.hon_os_trial_creative_policy WHERE policy_id=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIAL_CREATIVE_POLICY_MISSING' USING ERRCODE='P0002'; END IF;
  PERFORM hon.saas_creative_lock_wallet(NEW.school_id, NEW.starts_at);
  INSERT INTO hon.saas_creative_lots(school_id, organization_id, lot_kind, credits, expires_at, trial_enrollment_id, granted_by_principal_id, granted_at)
    VALUES (NEW.school_id, NEW.organization_id, 'TRIAL', p.credits, NEW.ends_at, NEW.id, NEW.enrolled_by_principal_id, NEW.starts_at)
    RETURNING id INTO v_lot;
  INSERT INTO hon.saas_creative_ledger(school_id, organization_id, lot_id, entry_kind, credits, actor_principal_id, occurred_at)
    VALUES (NEW.school_id, NEW.organization_id, v_lot, 'GRANT', p.credits, NEW.enrolled_by_principal_id, NEW.starts_at);
  INSERT INTO hon.hon_os_trial_creative_grants VALUES (NEW.id, NEW.organization_id, NEW.school_id, v_lot, p.credits, p.cost_cap_minor, NEW.starts_at, NEW.ends_at);
  PERFORM hon.saas_creative_touch_wallet(NEW.school_id, NEW.starts_at);
  RETURN NULL;
END $$;
CREATE TRIGGER grant_trial_creative AFTER INSERT ON hon.hon_os_trial_enrollments FOR EACH ROW EXECUTE FUNCTION hon.grant_hon_os_trial_creative();

-- The live trial's creative grant, while its recorded creative provider cost is below the cap.
CREATE FUNCTION hon.hon_os_trial_creative_funded(p_org uuid, p_at timestamptz) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.hon_os_trial_live(p_org,p_at) AND EXISTS (SELECT 1 FROM hon.hon_os_trial_creative_grants g
    WHERE g.organization_id=p_org AND p_at>=g.starts_at AND p_at<g.ends_at
      AND (SELECT coalesce(sum(u.provider_cost_microunits),0) FROM hon.ai_usage_ledger u WHERE u.organization_id=p_org
           AND u.spend_class='CREATIVE_MEDIA' AND u.occurred_at>=g.starts_at AND u.occurred_at<g.ends_at) < g.cost_cap_minor::bigint*10000)
$$;

-- Funding hook (S4-c): agent inference exactly as 0246; creative media now funded by the trial's creative grant.
CREATE OR REPLACE FUNCTION hon.ai_trial_funding_available(p_org uuid, p_at timestamptz, p_class text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE p_class
    WHEN 'AGENT_INFERENCE' THEN hon.hon_os_trial_live(p_org,p_at) AND EXISTS (SELECT 1 FROM hon.hon_os_trial_enrollments t
      WHERE t.organization_id=p_org AND jsonb_typeof(t.ai_budget)='object'
        AND p_at<t.starts_at+make_interval(days=>(t.ai_budget->>'creditExpiryDays')::integer))
    WHEN 'CREATIVE_MEDIA' THEN hon.hon_os_trial_creative_funded(p_org,p_at)
    ELSE false END;
$$;

-- ---------- wallet eligibility and windows ----------
-- 0209 body unchanged for every other school; a school whose organization a creatively funded trial currently owns is
-- eligible for the trial window (program and school must still be ACTIVE).
CREATE OR REPLACE FUNCTION hon.saas_creative_eligibility(p_school uuid, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE v_org uuid; school_active boolean; s hon.saas_subscriptions%ROWTYPE; st text; acc jsonb; pay jsonb; per record; reason text; paid_through timestamptz;
  g hon.hon_os_trial_creative_grants%ROWTYPE;
BEGIN
  SELECT NULL::integer AS period_index, NULL::timestamptz AS period_start, NULL::timestamptz AS period_end INTO per;
  SELECT sc.organization_id, sc.status = 'ACTIVE' AND o.status = 'ACTIVE' INTO v_org, school_active
    FROM hon.schools sc JOIN hon.organizations o ON o.id = sc.organization_id WHERE sc.id = p_school;
  -- 0275: the free trial's creative window.
  IF v_org IS NOT NULL AND school_active AND hon.saas_creative_program_active() AND hon.hon_os_trial_live(v_org, p_at) THEN
    SELECT * INTO g FROM hon.hon_os_trial_creative_grants WHERE organization_id = v_org AND school_id = p_school;
    IF g.enrollment_id IS NOT NULL AND p_at >= g.starts_at AND p_at < g.ends_at THEN
      RETURN jsonb_build_object('eligible', true, 'reason', NULL, 'subscriptionId', NULL,
        'window', jsonb_build_object('index', 0, 'startsAt', hon.saas_ts(g.starts_at), 'endsAt', hon.saas_ts(g.ends_at)));
    END IF;
  END IF;
  IF v_org IS NOT NULL THEN
    SELECT state INTO st FROM hon.saas_access_states WHERE organization_id = v_org;
    acc := hon.saas_organization_access(v_org);
    SELECT * INTO s FROM hon.saas_subscriptions WHERE organization_id = v_org AND status <> 'VOIDED';
    IF s.id IS NOT NULL THEN
      pay := hon.saas_subscription_payment(s);
      SELECT * INTO per FROM hon.saas_allowance_period(s, p_at);
      paid_through := (pay->>'paidThroughAt')::timestamptz;
    END IF;
  END IF;
  reason := CASE
    WHEN NOT hon.saas_creative_program_active() THEN 'PROGRAM_INACTIVE'
    WHEN v_org IS NULL OR NOT school_active THEN 'SCHOOL_NOT_ACTIVE'
    WHEN st IS DISTINCT FROM 'PAYMENT_ACTIVE' THEN 'PAID_ACCESS_REQUIRED'
    WHEN NOT coalesce((acc#>>'{entitlement,inEffect}')::boolean, false) THEN 'ENTITLEMENT_NOT_IN_EFFECT'
    WHEN s.id IS NULL OR s.source <> 'HON_OS_OFFER' THEN 'HON_OS_SUBSCRIPTION_REQUIRED'
    WHEN s.status <> 'IN_SERVICE' THEN 'SUBSCRIPTION_NOT_IN_SERVICE'
    WHEN pay->>'paymentStatus' <> 'PAID' OR pay->>'paymentVerification' <> 'PROVIDER_VERIFIED' THEN 'VERIFIED_PAYMENT_REQUIRED'
    WHEN per.period_index IS NULL OR p_at < per.period_start OR p_at >= per.period_end THEN 'WINDOW_UNAVAILABLE'
    WHEN s.billing_interval IN ('MONTHLY','ANNUAL') AND (paid_through IS NULL OR per.period_start >= paid_through) THEN 'WINDOW_NOT_PAID'
    WHEN s.billing_interval = 'ANNUAL' AND per.period_start >= s.current_period_end THEN 'WINDOW_NOT_PAID' END;
  RETURN jsonb_build_object('eligible', reason IS NULL, 'reason', reason, 'subscriptionId', s.id,
    'window', CASE WHEN reason IS NULL THEN jsonb_build_object('index', per.period_index, 'startsAt', hon.saas_ts(per.period_start), 'endsAt', hon.saas_ts(per.period_end)) END);
END $$;

-- A trial window has no subscription: it opens no included monthly lot (the TRIAL lot was granted at trial start).
CREATE OR REPLACE FUNCTION hon.saas_creative_open_window(p_school uuid, p_actor uuid, p_at timestamptz) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE e jsonb; v_lot uuid; v_credits integer; v_org uuid;
BEGIN
  PERFORM hon.saas_creative_expire_lots(p_school, p_actor, p_at);
  e := hon.saas_creative_eligibility(p_school, p_at);
  IF NOT (e->>'eligible')::boolean OR e->>'subscriptionId' IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO v_lot FROM hon.saas_creative_lots WHERE lot_kind = 'INCLUDED_MONTHLY' AND school_id = p_school
    AND subscription_id = (e->>'subscriptionId')::uuid AND window_index = (e#>>'{window,index}')::integer;
  IF v_lot IS NOT NULL THEN RETURN v_lot; END IF;
  SELECT organization_id INTO v_org FROM hon.saas_creative_wallets WHERE school_id = p_school;
  SELECT monthly_included_credits INTO v_credits FROM hon.saas_creative_program WHERE program_id = 1;
  INSERT INTO hon.saas_creative_lots(school_id, organization_id, lot_kind, credits, subscription_id, window_index, window_start, window_end, expires_at,
      granted_by_principal_id, granted_at)
    VALUES (p_school, v_org, 'INCLUDED_MONTHLY', v_credits, (e->>'subscriptionId')::uuid, (e#>>'{window,index}')::integer,
      (e#>>'{window,startsAt}')::timestamptz, (e#>>'{window,endsAt}')::timestamptz, (e#>>'{window,endsAt}')::timestamptz, p_actor, p_at)
    RETURNING id INTO v_lot;
  INSERT INTO hon.saas_creative_ledger(school_id, organization_id, lot_id, entry_kind, credits, actor_principal_id, occurred_at)
    VALUES (p_school, v_org, v_lot, 'GRANT', v_credits, p_actor, p_at);
  PERFORM hon.saas_creative_touch_wallet(p_school, p_at);
  RETURN v_lot;
END $$;

-- ---------- the trial receipt shows its creative credits ----------
-- 0246 body unchanged except the creative fields: creativeCreditsIncluded is true for a trial with a creative grant, and
-- creativeCredits carries the granted credits, what is left now (the wallet lot) and when they expire (the trial end).
CREATE OR REPLACE FUNCTION hon.hon_os_trial_json(t hon.hon_os_trial_enrollments) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
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
    'creativeCreditsIncluded',g.enrollment_id IS NOT NULL,
    'creativeCredits',CASE WHEN g.enrollment_id IS NOT NULL THEN jsonb_build_object('credits',g.credits,
      'available',(SELECT hon.saas_creative_lot_available(l,clock_timestamp()) FROM hon.saas_creative_lots l WHERE l.id=g.lot_id),
      'expiresAt',hon.saas_ts(g.ends_at)) END)
  FROM hon.organization_entitlements e LEFT JOIN hon.hon_os_trial_creative_grants g ON g.enrollment_id=t.id
  WHERE e.organization_id=t.organization_id
$$;

-- ---------- evidence protection, RLS and grants ----------
DO $$ DECLARE t text; r text; c text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['hon_os_trial_creative_policy','hon_os_trial_creative_grants'] LOOP
    EXECUTE format('CREATE TRIGGER saas_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence()',t);
    EXECUTE format('CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence()',t);
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r); END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',c,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',c,t,r); END LOOP;
    END LOOP;
  END LOOP;
  EXECUTE 'REVOKE ALL (trial_enrollment_id) ON hon.saas_creative_lots FROM PUBLIC';
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL (trial_enrollment_id) ON hon.saas_creative_lots FROM %I',r);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['grant_hon_os_trial_creative()','hon_os_trial_creative_funded(uuid,timestamptz)','ai_trial_funding_available(uuid,timestamptz,text)',
    'saas_creative_lot_rank(text)','saas_creative_balance_json(uuid,timestamptz)','saas_creative_eligibility(uuid,timestamptz)',
    'saas_creative_open_window(uuid,uuid,timestamptz)','hon_os_trial_json(hon.hon_os_trial_enrollments)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
END $$;
COMMIT;
