BEGIN;
-- 0553 school A2P 10DLC registrations (docs/architecture/SCHOOL_OWN_SENDERS.md §4.3 step 6-7, §5, piece T3a).
-- The school owner confirms the A2P draft from the 0190 engine plus the business facts Twilio needs for a Standard
-- brand; HON freezes them with the engine digest. A human HON HQ owner approves each submission. The communication
-- worker, only behind HON_TWILIO_A2P_SUBMIT_APPROVED, creates the school's secondary customer profile, A2P profile,
-- brand and campaign on the school's own Twilio subaccount and polls their review. Only an APPROVED campaign on the
-- school's own Messaging Service switches its 0248 sender ACTIVE. Nothing here sends, buys or charges anything; the
-- one-time brand and vetting fees (school) and the monthly campaign fee (HON) are recorded as cost lines in T4.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regclass('hon.school_number_orders') IS NULL OR to_regprocedure('hon.require_school_sender_manager(text)') IS NULL
    OR to_regprocedure('hon.settle_school_number_order_from_hq(text,uuid,text,text,integer)') IS NULL THEN RAISE EXCEPTION '0553 requires 0352 and 0358'; END IF;
END $$;

CREATE TABLE hon.school_a2p_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','SUBMIT_APPROVED','SUBMITTING','BRAND_PENDING','CAMPAIGN_PENDING',
    'APPROVED','FAILED','REJECTED','CANCELLED')),
  brand_type text NOT NULL CHECK (brand_type IN ('STANDARD','LOW_VOLUME_STANDARD')),
  use_case text NOT NULL CHECK (use_case IN ('ACCOUNT_NOTIFICATION','MARKETING','MIXED')),
  -- The owner-confirmed 0190 engine input and its generated draft, frozen with the engine's digest.
  draft_input jsonb NOT NULL CHECK (jsonb_typeof(draft_input) = 'object'),
  draft jsonb NOT NULL CHECK (jsonb_typeof(draft) = 'object'),
  draft_digest text NOT NULL CHECK (draft_digest ~ '^[0-9a-f]{64}$'),
  -- The business Twilio registers: legal name, EIN, address and an authorized contact, all owner statements.
  business jsonb NOT NULL CHECK (jsonb_typeof(business) = 'object'),
  requested_by uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  decided_by uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  decided_at timestamptz,
  decision_note text CHECK (length(decision_note) BETWEEN 1 AND 500),
  lease_token uuid,
  lease_expires_at timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  -- A worker step whose result was lost: the next attempt finds what exists on the subaccount before creating anything.
  outcome_unknown boolean NOT NULL DEFAULT false,
  twilio_account_sid text CHECK (twilio_account_sid ~ '^AC[0-9a-f]{32}$'),
  customer_profile_sid text CHECK (customer_profile_sid ~ '^BU[0-9a-f]{32}$'),
  a2p_profile_sid text CHECK (a2p_profile_sid ~ '^BU[0-9a-f]{32}$'),
  brand_sid text CHECK (brand_sid ~ '^BN[0-9a-f]{32}$'),
  campaign_sid text CHECK (campaign_sid ~ '^QE[0-9a-f]{32}$'),
  messaging_service_sid text CHECK (messaging_service_sid ~ '^MG[0-9a-f]{32}$'),
  failure_code text CHECK (failure_code ~ '^[A-Z][A-Z0-9_]{2,59}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (school_id, idempotency_key),
  CONSTRAINT school_a2p_registrations_decision CHECK (status IN ('REQUESTED','CANCELLED') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT school_a2p_registrations_lease CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)
    AND (status <> 'SUBMITTING' OR lease_token IS NOT NULL)
    AND (status IN ('SUBMITTING','BRAND_PENDING','CAMPAIGN_PENDING') OR lease_token IS NULL)),
  CONSTRAINT school_a2p_registrations_approved CHECK (status <> 'APPROVED' OR (twilio_account_sid IS NOT NULL AND customer_profile_sid IS NOT NULL
    AND a2p_profile_sid IS NOT NULL AND brand_sid IS NOT NULL AND campaign_sid IS NOT NULL AND messaging_service_sid IS NOT NULL)),
  CONSTRAINT school_a2p_registrations_campaign_pending CHECK (status <> 'CAMPAIGN_PENDING' OR (brand_sid IS NOT NULL AND campaign_sid IS NOT NULL
    AND messaging_service_sid IS NOT NULL))
);
-- One registration in progress or approved per school.
CREATE UNIQUE INDEX school_a2p_registrations_one_open ON hon.school_a2p_registrations(school_id)
  WHERE status IN ('REQUESTED','SUBMIT_APPROVED','SUBMITTING','BRAND_PENDING','CAMPAIGN_PENDING','APPROVED');

-- The school, facts, draft, digest, requester and key never change; a Twilio SID once recorded never changes; status
-- moves only forward, and a finished registration (APPROVED, FAILED, REJECTED, CANCELLED) never changes again.
CREATE FUNCTION hon.guard_school_a2p_registration() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE'
    AND (NEW.id,NEW.organization_id,NEW.school_id,NEW.brand_type,NEW.use_case,NEW.draft_input,NEW.draft,NEW.draft_digest,NEW.business,
      NEW.requested_by,NEW.idempotency_key,NEW.created_at)
      IS NOT DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.brand_type,OLD.use_case,OLD.draft_input,OLD.draft,OLD.draft_digest,OLD.business,
      OLD.requested_by,OLD.idempotency_key,OLD.created_at)
    AND (OLD.twilio_account_sid IS NULL OR NEW.twilio_account_sid IS NOT DISTINCT FROM OLD.twilio_account_sid)
    AND (OLD.customer_profile_sid IS NULL OR NEW.customer_profile_sid IS NOT DISTINCT FROM OLD.customer_profile_sid)
    AND (OLD.a2p_profile_sid IS NULL OR NEW.a2p_profile_sid IS NOT DISTINCT FROM OLD.a2p_profile_sid)
    AND (OLD.brand_sid IS NULL OR NEW.brand_sid IS NOT DISTINCT FROM OLD.brand_sid)
    AND (OLD.campaign_sid IS NULL OR NEW.campaign_sid IS NOT DISTINCT FROM OLD.campaign_sid)
    AND (OLD.messaging_service_sid IS NULL OR NEW.messaging_service_sid IS NOT DISTINCT FROM OLD.messaging_service_sid)
    AND (OLD.decided_by IS NULL OR (NEW.decided_by,NEW.decided_at,NEW.decision_note) IS NOT DISTINCT FROM (OLD.decided_by,OLD.decided_at,OLD.decision_note))
    AND OLD.status NOT IN ('APPROVED','FAILED','REJECTED','CANCELLED') AND NEW.version > OLD.version
    AND (NEW.status = OLD.status OR ROW(OLD.status, NEW.status) IN (
      ROW('REQUESTED','SUBMIT_APPROVED'), ROW('REQUESTED','REJECTED'), ROW('REQUESTED','CANCELLED'),
      ROW('SUBMIT_APPROVED','SUBMITTING'), ROW('SUBMIT_APPROVED','CANCELLED'), ROW('SUBMIT_APPROVED','FAILED'),
      ROW('SUBMITTING','SUBMIT_APPROVED'), ROW('SUBMITTING','BRAND_PENDING'), ROW('SUBMITTING','CAMPAIGN_PENDING'), ROW('SUBMITTING','APPROVED'), ROW('SUBMITTING','FAILED'),
      ROW('BRAND_PENDING','CAMPAIGN_PENDING'), ROW('BRAND_PENDING','APPROVED'), ROW('BRAND_PENDING','FAILED'),
      ROW('CAMPAIGN_PENDING','APPROVED'), ROW('CAMPAIGN_PENDING','FAILED'))) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SCHOOL_A2P_REGISTRATION_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.school_a2p_registrations FOR EACH ROW EXECUTE FUNCTION hon.guard_school_a2p_registration();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_a2p_registrations FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_a2p_registration();

ALTER TABLE hon.school_a2p_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_a2p_registrations FORCE ROW LEVEL SECURITY;
CREATE POLICY school_a2p_registrations_tenant_isolation ON hon.school_a2p_registrations
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

-- The business facts, exactly: no other keys, every value a trimmed string of the right shape. The EIN is stored as nine
-- digits; reads show only its last four.
CREATE FUNCTION hon.school_a2p_business(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE k text; v text; ein text;
BEGIN
  IF p IS NULL OR jsonb_typeof(p)<>'object'
    OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p) x) IS DISTINCT FROM ARRAY['businessType','city','contactEmail','contactFirstName',
      'contactLastName','contactPhone','contactTitle','ein','legalName','postalCode','region','street'] THEN
    RAISE EXCEPTION 'INVALID_A2P_REGISTRATION' USING ERRCODE='22023';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF jsonb_typeof(p->k)<>'string' THEN RAISE EXCEPTION 'INVALID_A2P_REGISTRATION' USING ERRCODE='22023'; END IF;
    v := p->>k;
    IF length(v) NOT BETWEEN 1 AND 120 OR btrim(v)<>v THEN RAISE EXCEPTION 'INVALID_A2P_REGISTRATION' USING ERRCODE='22023'; END IF;
  END LOOP;
  ein := replace(p->>'ein','-','');
  IF p->>'businessType' NOT IN ('CORPORATION','LLC','PARTNERSHIP','NON_PROFIT','CO_OPERATIVE')
    OR (p->>'ein') !~ '^[0-9]{2}-?[0-9]{7}$' OR ein ~ '^(.)\1{8}$'
    OR (p->>'region') !~ '^[A-Z]{2}$' OR (p->>'postalCode') !~ '^[0-9]{5}(-[0-9]{4})?$'
    OR (p->>'contactPhone') !~ '^\+1[2-9][0-9]{9}$' OR (p->>'contactEmail') !~ '^[^@\s]{1,64}@[^@\s]+\.[A-Za-z]{2,}$' THEN
    RAISE EXCEPTION 'INVALID_A2P_REGISTRATION' USING ERRCODE='22023';
  END IF;
  RETURN p || jsonb_build_object('ein', ein);
END $$;

CREATE FUNCTION hon.school_a2p_registration_json(r hon.school_a2p_registrations) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('registrationId',r.id,'schoolId',r.school_id,'status',r.status,'brandType',r.brand_type,'useCase',r.use_case,
    'draftDigest',r.draft_digest,'answers',r.draft->'answers','sampleMessages',r.draft->'sampleMessages',
    'helpResponse',r.draft->'helpResponseSample','stopResponse',r.draft->'stopResponseSample',
    'business',(r.business - 'ein') || jsonb_build_object('einLast4', right(r.business->>'ein', 4)),
    'decisionNote',r.decision_note,'decidedAt',r.decided_at,'failureCode',r.failure_code,'outcomeUnknown',r.outcome_unknown,
    'brandRegistered',r.brand_sid IS NOT NULL,'campaignRegistered',r.campaign_sid IS NOT NULL,
    'version',r.version,'createdAt',r.created_at,'updatedAt',r.updated_at);
$$;

-- The owner check: communication.sender.manage (0352) and a live OWNER role at the session school, because only a
-- current owner may confirm the school's facts (0190).
CREATE FUNCTION hon.require_school_a2p_owner(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid;
BEGIN
  actor := hon.require_school_sender_manager(p_subject);
  IF NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
    WHERE g.principal_id=actor AND g.organization_id=hon.current_organization_id() AND g.school_id=hon.current_school_id() AND g.revoked_at IS NULL
      AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
      AND r.code='OWNER' AND (r.management_school_id IS NULL OR r.management_school_id=hon.current_school_id())) THEN
    RAISE EXCEPTION 'A2P_OWNER_REQUIRED' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $$;

-- Owner: submit the confirmed draft for HQ review. The API regenerated the draft and digest with the 0190 engine from
-- this exact input; the database checks the shapes, the owner confirmation and that the draft was complete.
CREATE FUNCTION hon.request_school_a2p_registration(p_subject text, p_input jsonb, p_key text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid; school uuid; prior hon.school_a2p_registrations; next hon.school_a2p_registrations; req uuid:=gen_random_uuid();
  business jsonb; use_case text;
BEGIN
  actor := hon.require_school_a2p_owner(p_subject);
  org := hon.current_organization_id(); school := hon.current_school_id();
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_input) x) IS DISTINCT FROM ARRAY['brandType','business','draft','draftDigest','draftInput']
    OR p_input->>'brandType' NOT IN ('STANDARD','LOW_VOLUME_STANDARD')
    OR jsonb_typeof(p_input->'draftInput')<>'object' OR jsonb_typeof(p_input->'draft')<>'object'
    OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_input->'draft') x) IS DISTINCT FROM ARRAY['answers','copyPreparationAvailable',
      'engineVersion','helpResponseSample','sampleMessages','stopResponseSample','warnings']
    OR coalesce(p_input->>'draftDigest','') !~ '^[0-9a-f]{64}$'
    OR p_input->'draftInput'->>'ownerConfirmation' IS DISTINCT FROM 'OWNER_CONFIRMED_FACTS_FOR_DRAFT_ONLY'
    OR p_input->'draft'->>'engineVersion' IS DISTINCT FROM 'A2P_PREPARATION_V1'
    OR p_input->'draft'->'copyPreparationAvailable' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(p_input->'draft'->'answers')<>'object'
    OR jsonb_typeof(p_input->'draft'->'sampleMessages')<>'array' OR jsonb_array_length(p_input->'draft'->'sampleMessages') NOT BETWEEN 1 AND 10
    OR jsonb_typeof(p_input->'draft'->'helpResponseSample')<>'string' OR jsonb_typeof(p_input->'draft'->'stopResponseSample')<>'string'
    OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9._:-]{8,128}$' OR octet_length(p_input::text) > 32768 THEN
    RAISE EXCEPTION 'INVALID_A2P_REGISTRATION' USING ERRCODE='22023';
  END IF;
  use_case := CASE p_input->'draftInput'->>'purpose' WHEN 'SERVICE_NOTIFICATIONS' THEN 'ACCOUNT_NOTIFICATION' WHEN 'MARKETING' THEN 'MARKETING'
    WHEN 'MIXED' THEN 'MIXED' END;
  IF use_case IS NULL THEN RAISE EXCEPTION 'INVALID_A2P_REGISTRATION' USING ERRCODE='22023'; END IF;
  business := hon.school_a2p_business(p_input->'business');
  SELECT * INTO prior FROM hon.school_a2p_registrations r WHERE r.school_id=school AND r.idempotency_key=p_key;
  IF prior.id IS NOT NULL THEN
    IF prior.draft_digest<>p_input->>'draftDigest' OR prior.business<>business OR prior.brand_type<>p_input->>'brandType' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='22023'; END IF;
    RETURN hon.school_a2p_registration_json(prior);
  END IF;
  PERFORM 1 FROM hon.schools s WHERE s.id=school FOR UPDATE;
  IF EXISTS(SELECT 1 FROM hon.school_a2p_registrations r WHERE r.school_id=school AND r.status='APPROVED') THEN
    RAISE EXCEPTION 'A2P_ALREADY_APPROVED' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM hon.school_a2p_registrations r WHERE r.school_id=school AND r.status IN ('REQUESTED','SUBMIT_APPROVED','SUBMITTING','BRAND_PENDING','CAMPAIGN_PENDING')) THEN
    RAISE EXCEPTION 'A2P_REGISTRATION_OPEN' USING ERRCODE='55000'; END IF;
  INSERT INTO hon.school_a2p_registrations (organization_id, school_id, brand_type, use_case, draft_input, draft, draft_digest, business, requested_by, idempotency_key)
  VALUES (org, school, p_input->>'brandType', use_case, p_input->'draftInput', p_input->'draft', p_input->>'draftDigest', business, actor, p_key)
  RETURNING * INTO next;
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
    prior_state, next_state, result, request_id, correlation_id, occurred_at)
  VALUES (org, school, actor, 'HUMAN_UI', 'communication.a2p_registration.requested', 'SCHOOL_A2P_REGISTRATION', next.id, NULL,
    jsonb_build_object('status', next.status, 'brandType', next.brand_type, 'useCase', next.use_case, 'draftDigest', next.draft_digest), 'SUCCEEDED', req, req, now());
  PERFORM hon.require_school_a2p_owner(p_subject);
  RETURN hon.school_a2p_registration_json(next);
END $$;

-- Owner: withdraw a registration nothing has been created for yet.
CREATE FUNCTION hon.cancel_school_a2p_registration(p_subject text, p_registration uuid, p_expected_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; prior hon.school_a2p_registrations; next hon.school_a2p_registrations; req uuid:=gen_random_uuid();
BEGIN
  actor := hon.require_school_a2p_owner(p_subject);
  SELECT * INTO prior FROM hon.school_a2p_registrations r WHERE r.id=p_registration AND r.school_id=hon.current_school_id() FOR UPDATE;
  IF prior.id IS NULL THEN RAISE EXCEPTION 'A2P_REGISTRATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF p_expected_version IS DISTINCT FROM prior.version THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF prior.status NOT IN ('REQUESTED','SUBMIT_APPROVED') THEN RAISE EXCEPTION 'A2P_REGISTRATION_NOT_CANCELLABLE' USING ERRCODE='55000'; END IF;
  UPDATE hon.school_a2p_registrations SET status='CANCELLED', version=version+1, updated_at=now() WHERE id=prior.id RETURNING * INTO next;
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
    prior_state, next_state, result, request_id, correlation_id, occurred_at)
  VALUES (next.organization_id, next.school_id, actor, 'HUMAN_UI', 'communication.a2p_registration.cancelled', 'SCHOOL_A2P_REGISTRATION', next.id,
    jsonb_build_object('status', prior.status, 'version', prior.version), jsonb_build_object('status', next.status, 'version', next.version), 'SUCCEEDED', req, req, now());
  PERFORM hon.require_school_a2p_owner(p_subject);
  RETURN hon.school_a2p_registration_json(next);
END $$;

CREATE FUNCTION hon.read_school_a2p_registrations(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE result jsonb;
BEGIN
  PERFORM hon.require_school_a2p_owner(p_subject);
  SELECT coalesce(jsonb_agg(hon.school_a2p_registration_json(r) ORDER BY r.created_at DESC), '[]'::jsonb) INTO result
  FROM (SELECT * FROM hon.school_a2p_registrations r WHERE r.school_id=hon.current_school_id() ORDER BY r.created_at DESC LIMIT 10) r;
  PERFORM hon.require_school_a2p_owner(p_subject);
  RETURN jsonb_build_object('registrations', result);
END $$;

-- HQ owner: approve or reject the submission. Approval is the per-submission OK; submitting still needs the switch.
CREATE FUNCTION hon.decide_school_a2p_registration_from_hq(p_subject text, p_registration uuid, p_decision text, p_note text, p_expected_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; prior hon.school_a2p_registrations; next hon.school_a2p_registrations; req uuid:=gen_random_uuid();
BEGIN
  actor := hon.require_saas_hq_actor(p_subject, true);
  IF p_registration IS NULL OR p_decision NOT IN ('APPROVE','REJECT') OR (p_note IS NOT NULL AND (length(p_note) NOT BETWEEN 1 AND 500 OR btrim(p_note)<>p_note))
    OR (p_decision='REJECT' AND p_note IS NULL) OR p_expected_version IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  SELECT * INTO prior FROM hon.school_a2p_registrations r WHERE r.id=p_registration FOR UPDATE;
  IF prior.id IS NULL THEN RAISE EXCEPTION 'A2P_REGISTRATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF prior.version<>p_expected_version THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF prior.status<>'REQUESTED' THEN RAISE EXCEPTION 'A2P_REGISTRATION_NOT_PENDING' USING ERRCODE='55000'; END IF;
  UPDATE hon.school_a2p_registrations SET status=CASE WHEN p_decision='APPROVE' THEN 'SUBMIT_APPROVED' ELSE 'REJECTED' END,
    decided_by=actor, decided_at=now(), decision_note=p_note, next_check_at=now(), version=version+1, updated_at=now()
  WHERE id=prior.id RETURNING * INTO next;
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
    prior_state, next_state, result, request_id, correlation_id, occurred_at)
  VALUES (next.organization_id, next.school_id, actor, 'HON_HQ', 'communication.a2p_registration.decided', 'SCHOOL_A2P_REGISTRATION', next.id,
    jsonb_build_object('status', prior.status, 'version', prior.version), jsonb_build_object('status', next.status, 'version', next.version), 'SUCCEEDED', req, req, now());
  PERFORM hon.require_saas_hq_actor(p_subject, true);
  RETURN hon.school_a2p_registration_json(next) || jsonb_build_object('schoolName',(SELECT s.name FROM hon.schools s WHERE s.id=next.school_id));
END $$;

CREATE FUNCTION hon.read_hq_school_a2p_registrations(p_subject text, p_status text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE result jsonb;
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  IF p_status IS NOT NULL AND p_status NOT IN ('REQUESTED','SUBMIT_APPROVED','SUBMITTING','BRAND_PENDING','CAMPAIGN_PENDING','APPROVED','FAILED','REJECTED','CANCELLED') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  SELECT coalesce(jsonb_agg(hon.school_a2p_registration_json(r) || jsonb_build_object('schoolName', s.name) ORDER BY r.created_at), '[]'::jsonb) INTO result
  FROM (SELECT * FROM hon.school_a2p_registrations r WHERE p_status IS NULL OR r.status=p_status ORDER BY r.created_at LIMIT 200) r
  JOIN hon.schools s ON s.id=r.school_id;
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  RETURN jsonb_build_object('registrations', result);
END $$;

-- Worker: claim registrations to submit or to check, for a still-ACTIVE, entitled school whose own subaccount is ACTIVE.
-- Each claim carries the frozen facts, the SIDs already recorded and the school's sender service on that subaccount.
CREATE FUNCTION hon.claim_school_a2p_registrations(p_limit integer, p_lease_seconds integer)
RETURNS TABLE (registration_id uuid, lease_token uuid, school_id uuid, organization_id uuid, stage text, attempt integer, outcome_unknown boolean,
  account_sid text, brand_type text, use_case text, draft jsonb, business jsonb, customer_profile_sid text, a2p_profile_sid text, brand_sid text,
  campaign_sid text, messaging_service_sid text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
#variable_conflict use_column
DECLARE r hon.school_a2p_registrations; token uuid; acct text; lost boolean; svc text;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 60 AND 900 THEN
    RAISE EXCEPTION 'INVALID_CLAIM' USING ERRCODE='22023'; END IF;
  FOR r IN SELECT x.* FROM hon.school_a2p_registrations x
    JOIN hon.schools s ON s.id=x.school_id AND s.organization_id=x.organization_id AND s.status='ACTIVE'
    JOIN hon.organizations g ON g.id=x.organization_id AND g.status='ACTIVE'
    WHERE (x.status='SUBMIT_APPROVED' OR (x.status='SUBMITTING' AND x.lease_expires_at<=now())
        OR (x.status IN ('BRAND_PENDING','CAMPAIGN_PENDING') AND (x.lease_expires_at IS NULL OR x.lease_expires_at<=now())))
      AND x.next_check_at<=now()
      AND EXISTS(SELECT 1 FROM hon.school_twilio_accounts a WHERE a.school_id=x.school_id AND a.status='ACTIVE' AND a.account_sid IS NOT NULL)
      AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=x.organization_id AND e.status='ACTIVE'
        AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
    ORDER BY x.next_check_at, x.updated_at LIMIT p_limit FOR UPDATE OF x SKIP LOCKED LOOP
    SELECT a.account_sid INTO acct FROM hon.school_twilio_accounts a WHERE a.school_id=r.school_id AND a.status='ACTIVE';
    -- A registration whose subaccount changed is never moved to another account.
    IF r.twilio_account_sid IS NOT NULL AND r.twilio_account_sid<>acct THEN
      UPDATE hon.school_a2p_registrations SET status='FAILED', failure_code='TWILIO_ACCOUNT_MISMATCH', lease_token=NULL, lease_expires_at=NULL,
        version=version+1, updated_at=now() WHERE id=r.id;
      CONTINUE;
    END IF;
    lost := r.lease_token IS NOT NULL;
    IF r.attempts >= 6 THEN
      -- Six tries without progress: stop for an HQ operator. Twilio objects already made stay recorded on the row.
      UPDATE hon.school_a2p_registrations SET status='FAILED', failure_code='ATTEMPTS_EXHAUSTED', outcome_unknown=outcome_unknown OR lost,
        lease_token=NULL, lease_expires_at=NULL, version=version+1, updated_at=now() WHERE id=r.id;
      CONTINUE;
    END IF;
    token := gen_random_uuid();
    UPDATE hon.school_a2p_registrations SET status=CASE WHEN r.status='SUBMIT_APPROVED' THEN 'SUBMITTING' ELSE r.status END,
      lease_token=token, lease_expires_at=now()+make_interval(secs=>p_lease_seconds), attempts=attempts+1,
      outcome_unknown=outcome_unknown OR lost, twilio_account_sid=acct, version=version+1, updated_at=now() WHERE id=r.id;
    SELECT t.messaging_service_sid INTO svc FROM hon.school_text_senders t WHERE t.school_id=r.school_id AND t.twilio_account_sid=acct;
    registration_id:=r.id; lease_token:=token; school_id:=r.school_id; organization_id:=r.organization_id;
    stage:=CASE WHEN r.status='SUBMIT_APPROVED' THEN 'SUBMITTING' ELSE r.status END; attempt:=r.attempts+1; outcome_unknown:=r.outcome_unknown OR lost;
    account_sid:=acct; brand_type:=r.brand_type; use_case:=r.use_case; draft:=r.draft; business:=r.business;
    customer_profile_sid:=r.customer_profile_sid; a2p_profile_sid:=r.a2p_profile_sid; brand_sid:=r.brand_sid; campaign_sid:=r.campaign_sid;
    messaging_service_sid:=svc;
    RETURN NEXT;
  END LOOP;
END $$;

-- Worker: the result of one step. BRAND_PENDING / CAMPAIGN_PENDING: waiting on Twilio's review, checked again after
-- p_wait_seconds. APPROVED: the campaign is approved on the school's own Messaging Service, so its sender goes ACTIVE.
-- FAILED: Twilio refused something. UNKNOWN: a create may have happened; the lease ends now and the next claim finds it.
-- RETRY: this step certainly did nothing. Every result names the SIDs it saw; a SID once recorded never changes.
CREATE FUNCTION hon.record_school_a2p_progress(p_registration uuid, p_lease uuid, p_outcome text, p_sids jsonb, p_failure_code text, p_wait_seconds integer)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE r hon.school_a2p_registrations; next hon.school_a2p_registrations; sender hon.school_text_senders; req uuid:=gen_random_uuid();
  cp text; ap text; bn text; qe text; mg text; k text;
BEGIN
  IF p_registration IS NULL OR p_lease IS NULL OR p_outcome NOT IN ('BRAND_PENDING','CAMPAIGN_PENDING','APPROVED','FAILED','UNKNOWN','RETRY')
    OR (p_failure_code IS NOT NULL AND p_failure_code !~ '^[A-Z][A-Z0-9_]{2,59}$') OR (p_outcome='FAILED' AND p_failure_code IS NULL)
    OR p_sids IS NULL OR jsonb_typeof(p_sids)<>'object'
    OR (p_outcome IN ('BRAND_PENDING','CAMPAIGN_PENDING','RETRY') AND (p_wait_seconds IS NULL OR p_wait_seconds NOT BETWEEN 60 AND 86400)) THEN
    RAISE EXCEPTION 'INVALID_A2P_RESULT' USING ERRCODE='22023'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_sids) LOOP
    IF k NOT IN ('customerProfileSid','a2pProfileSid','brandSid','campaignSid','messagingServiceSid') OR jsonb_typeof(p_sids->k)<>'string' THEN
      RAISE EXCEPTION 'INVALID_A2P_RESULT' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF coalesce(p_sids->>'customerProfileSid','BU'||repeat('0',32)) !~ '^BU[0-9a-f]{32}$' OR coalesce(p_sids->>'a2pProfileSid','BU'||repeat('0',32)) !~ '^BU[0-9a-f]{32}$'
    OR coalesce(p_sids->>'brandSid','BN'||repeat('0',32)) !~ '^BN[0-9a-f]{32}$' OR coalesce(p_sids->>'campaignSid','QE'||repeat('0',32)) !~ '^QE[0-9a-f]{32}$'
    OR coalesce(p_sids->>'messagingServiceSid','MG'||repeat('0',32)) !~ '^MG[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'INVALID_A2P_RESULT' USING ERRCODE='22023'; END IF;
  SELECT * INTO r FROM hon.school_a2p_registrations x WHERE x.id=p_registration FOR UPDATE;
  IF r.id IS NULL OR r.lease_token IS DISTINCT FROM p_lease OR r.lease_expires_at<=now() THEN
    RAISE EXCEPTION 'A2P_LEASE_LOST' USING ERRCODE='40001'; END IF;
  cp := coalesce(r.customer_profile_sid, p_sids->>'customerProfileSid'); ap := coalesce(r.a2p_profile_sid, p_sids->>'a2pProfileSid');
  bn := coalesce(r.brand_sid, p_sids->>'brandSid'); qe := coalesce(r.campaign_sid, p_sids->>'campaignSid');
  mg := coalesce(r.messaging_service_sid, p_sids->>'messagingServiceSid');
  IF cp IS DISTINCT FROM coalesce(p_sids->>'customerProfileSid', cp) OR ap IS DISTINCT FROM coalesce(p_sids->>'a2pProfileSid', ap)
    OR bn IS DISTINCT FROM coalesce(p_sids->>'brandSid', bn) OR qe IS DISTINCT FROM coalesce(p_sids->>'campaignSid', qe)
    OR mg IS DISTINCT FROM coalesce(p_sids->>'messagingServiceSid', mg) THEN
    RAISE EXCEPTION 'A2P_SID_MISMATCH' USING ERRCODE='22023'; END IF;
  IF p_outcome IN ('CAMPAIGN_PENDING','APPROVED') THEN
    -- The campaign belongs to the school's own sender service on this registration's subaccount, nothing else.
    SELECT * INTO sender FROM hon.school_text_senders t WHERE t.school_id=r.school_id FOR UPDATE;
    IF sender.id IS NULL OR sender.twilio_account_sid IS DISTINCT FROM r.twilio_account_sid OR sender.messaging_service_sid IS DISTINCT FROM mg THEN
      RAISE EXCEPTION 'A2P_SENDER_MISMATCH' USING ERRCODE='42501'; END IF;
    IF bn IS NULL OR qe IS NULL OR (p_outcome='APPROVED' AND (cp IS NULL OR ap IS NULL)) THEN RAISE EXCEPTION 'INVALID_A2P_RESULT' USING ERRCODE='22023'; END IF;
  END IF;
  UPDATE hon.school_a2p_registrations SET customer_profile_sid=cp, a2p_profile_sid=ap, brand_sid=bn, campaign_sid=qe, messaging_service_sid=mg,
    status=CASE p_outcome WHEN 'BRAND_PENDING' THEN 'BRAND_PENDING' WHEN 'CAMPAIGN_PENDING' THEN 'CAMPAIGN_PENDING' WHEN 'APPROVED' THEN 'APPROVED'
      WHEN 'FAILED' THEN 'FAILED' WHEN 'RETRY' THEN CASE WHEN r.status='SUBMITTING' THEN 'SUBMIT_APPROVED' ELSE r.status END ELSE r.status END,
    -- A step that moved forward or found Twilio still reviewing starts the attempt count again.
    attempts=CASE WHEN p_outcome IN ('BRAND_PENDING','CAMPAIGN_PENDING','APPROVED') THEN 0 ELSE attempts END,
    outcome_unknown=CASE WHEN p_outcome IN ('BRAND_PENDING','CAMPAIGN_PENDING','APPROVED') THEN false WHEN p_outcome='UNKNOWN' THEN true ELSE outcome_unknown END,
    failure_code=CASE WHEN p_outcome='UNKNOWN' THEN coalesce(p_failure_code,'OUTCOME_UNKNOWN') WHEN p_outcome='APPROVED' THEN NULL ELSE p_failure_code END,
    lease_token=CASE WHEN p_outcome='UNKNOWN' THEN lease_token ELSE NULL END,
    lease_expires_at=CASE WHEN p_outcome='UNKNOWN' THEN now() ELSE NULL END,
    next_check_at=CASE WHEN p_outcome IN ('BRAND_PENDING','CAMPAIGN_PENDING','RETRY') THEN now()+make_interval(secs=>p_wait_seconds) ELSE now() END,
    version=version+1, updated_at=now()
  WHERE id=r.id RETURNING * INTO next;
  IF p_outcome='APPROVED' THEN
    UPDATE hon.school_text_senders SET status='ACTIVE', set_by_principal_id='00000000-0000-4000-8000-00000000c043', version=version+1, updated_at=now()
    WHERE id=sender.id;
  END IF;
  IF next.status IS DISTINCT FROM r.status AND next.status <> 'SUBMIT_APPROVED' THEN
    INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
      prior_state, next_state, result, request_id, correlation_id, occurred_at)
    VALUES (next.organization_id, next.school_id, '00000000-0000-4000-8000-00000000c043', 'INTEGRATION', 'communication.a2p_registration.' || lower(next.status),
      'SCHOOL_A2P_REGISTRATION', next.id, jsonb_build_object('status', r.status),
      jsonb_build_object('status', next.status, 'failureCode', next.failure_code, 'brandRegistered', next.brand_sid IS NOT NULL,
        'campaignRegistered', next.campaign_sid IS NOT NULL, 'senderActivated', p_outcome='APPROVED', 'version', next.version), 'SUCCEEDED', req, req, now());
  END IF;
  RETURN jsonb_build_object('status', next.status, 'version', next.version);
END $$;

-- 0352 HQ manual sender, now also refusing to switch a HON-bought (subaccount) sender ACTIVE unless the school's A2P
-- campaign is APPROVED on that sender's service. Switching it off, or keeping it on, stays allowed.
CREATE OR REPLACE FUNCTION hon.set_school_text_sender_from_hq(
  p_subject text, p_school uuid, p_phone_e164 text, p_messaging_service_sid text, p_status text, p_mms_converter_confirmed boolean,
  p_expected_version integer
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; s hon.schools%ROWTYPE; prior hon.school_text_senders; next hon.school_text_senders; req uuid := gen_random_uuid();
BEGIN
  actor := hon.require_saas_hq_actor(p_subject, true);
  IF p_school IS NULL OR p_status NOT IN ('ACTIVE', 'DISABLED') OR p_phone_e164 IS NULL OR p_messaging_service_sid IS NULL
    OR p_mms_converter_confirmed IS NULL THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'ACTIVE' AND NOT p_mms_converter_confirmed THEN
    RAISE EXCEPTION 'MMS_CONVERTER_NOT_CONFIRMED' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO s FROM hon.schools WHERE id = p_school;
  IF s.id IS NULL THEN RAISE EXCEPTION 'HQ_SCHOOL_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO prior FROM hon.school_text_senders WHERE school_id = p_school FOR UPDATE;
  IF prior.id IS NULL THEN
    IF p_expected_version IS NOT NULL THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
    INSERT INTO hon.school_text_senders (organization_id, school_id, phone_e164, messaging_service_sid, status, mms_converter_confirmed, set_by_principal_id)
    VALUES (s.organization_id, s.id, p_phone_e164, p_messaging_service_sid, p_status, p_mms_converter_confirmed, actor) RETURNING * INTO next;
  ELSE
    IF p_expected_version IS DISTINCT FROM prior.version THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
    IF prior.twilio_account_sid IS NOT NULL AND (p_phone_e164 <> prior.phone_e164 OR p_messaging_service_sid <> prior.messaging_service_sid) THEN
      RAISE EXCEPTION 'PROVISIONED_SENDER_LOCKED' USING ERRCODE = '55000';
    END IF;
    IF prior.twilio_account_sid IS NOT NULL AND p_status = 'ACTIVE' AND prior.status <> 'ACTIVE'
      AND NOT EXISTS(SELECT 1 FROM hon.school_a2p_registrations r WHERE r.school_id = p_school AND r.status = 'APPROVED'
        AND r.twilio_account_sid = prior.twilio_account_sid AND r.messaging_service_sid = prior.messaging_service_sid) THEN
      RAISE EXCEPTION 'A2P_NOT_APPROVED' USING ERRCODE = '55000';
    END IF;
    UPDATE hon.school_text_senders SET phone_e164 = p_phone_e164, messaging_service_sid = p_messaging_service_sid, status = p_status,
      mms_converter_confirmed = p_mms_converter_confirmed, set_by_principal_id = actor, version = version + 1, updated_at = now()
    WHERE id = prior.id RETURNING * INTO next;
  END IF;
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
    prior_state, next_state, result, request_id, correlation_id, occurred_at)
  VALUES (s.organization_id, s.id, actor, 'HON_HQ', 'communication.text_sender.set', 'SCHOOL_TEXT_SENDER', next.id,
    CASE WHEN prior.id IS NULL THEN NULL ELSE jsonb_build_object('phone', prior.phone_e164, 'status', prior.status, 'version', prior.version) END,
    jsonb_build_object('phone', next.phone_e164, 'status', next.status, 'mmsConverterConfirmed', next.mms_converter_confirmed, 'version', next.version), 'SUCCEEDED', req, req, now());
  -- Authority is checked again after the lock and the write, so a grant that ended meanwhile aborts the change.
  PERFORM hon.require_saas_hq_actor(p_subject, true);
  RETURN jsonb_build_object('schoolId', next.school_id, 'phoneE164', next.phone_e164, 'status', next.status, 'mmsConverterConfirmed', next.mms_converter_confirmed,
    'version', next.version, 'updatedAt', next.updated_at);
END $$;

DO $$
DECLARE r text; f text;
  runtime_fns text[] := ARRAY['hon.request_school_a2p_registration(text,jsonb,text)','hon.cancel_school_a2p_registration(text,uuid,integer)',
    'hon.read_school_a2p_registrations(text)','hon.decide_school_a2p_registration_from_hq(text,uuid,text,text,integer)',
    'hon.read_hq_school_a2p_registrations(text,text)'];
  worker_fns text[] := ARRAY['hon.claim_school_a2p_registrations(integer,integer)','hon.record_school_a2p_progress(uuid,uuid,text,jsonb,text,integer)'];
  private_fns text[] := ARRAY['hon.require_school_a2p_owner(text)','hon.school_a2p_registration_json(hon.school_a2p_registrations)',
    'hon.school_a2p_business(jsonb)','hon.guard_school_a2p_registration()'];
BEGIN
  REVOKE ALL ON TABLE hon.school_a2p_registrations FROM PUBLIC;
  FOREACH f IN ARRAY runtime_fns || worker_fns || private_fns LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||f||' FROM PUBLIC'; END LOOP;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.school_a2p_registrations FROM %I', r);
    FOREACH f IN ARRAY runtime_fns || worker_fns || private_fns LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY runtime_fns LOOP EXECUTE 'GRANT EXECUTE ON FUNCTION '||f||' TO hon_runtime'; END LOOP;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_communication_worker') THEN
    FOREACH f IN ARRAY worker_fns LOOP EXECUTE 'GRANT EXECUTE ON FUNCTION '||f||' TO hon_communication_worker'; END LOOP;
  END IF;
END $$;
COMMIT;
